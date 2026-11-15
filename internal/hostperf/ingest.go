package hostperf

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

type hostSample struct {
	CPU       *float64 `json:"cpu_usage_percent,omitempty"`
	Available *int64   `json:"memory_available_bytes,omitempty"`
	Swap      *int64   `json:"swap_used_bytes,omitempty"`
	Disk      *int64   `json:"disk_available_bytes,omitempty"`
	Pressure  *bool    `json:"swap_pressure,omitempty"`
}

type processSample struct {
	CPU     *float64 `json:"cpu_cores_used,omitempty"`
	RSS     *int64   `json:"rss_bytes,omitempty"`
	Threads *int64   `json:"thread_count,omitempty"`
	Uptime  *int64   `json:"uptime_seconds,omitempty"`
}

type record struct {
	ID       string         `json:"record_id"`
	Observed time.Time      `json:"observed_at"`
	Duration int64          `json:"sample_duration_ms"`
	Host     *hostSample    `json:"host,omitempty"`
	Process  *processSample `json:"process,omitempty"`
}

func (s *Service) ingest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	auth := r.Header.Get("Authorization")
	agent, err := strategy.Authorize(ctx, controldb.New(s.stores.Control.Read), auth, strategy.ReportScope)
	if err != nil {
		writeError(w, err)
		return
	}
	select {
	case s.writes <- struct{}{}:
		defer func() { <-s.writes }()
	default:
		w.Header().Set("Retry-After", "1")
		httpapi.Error(w, 429, "performance_busy", "Too many concurrent requests; retry with the same record IDs")
		return
	}
	var batch reportBatch
	if !readInput(w, r, &batch, "batch", 256<<10) {
		return
	}
	batch.Name = strings.TrimSpace(batch.Name)
	if batch.Name == "" {
		httpapi.Error(w, 400, "invalid_host", "Report a non-empty host_name")
		return
	}
	now := time.Now()
	for _, item := range batch.Records {
		if item.Observed.UnixMilli() <= 0 || item.Observed.After(now.Add(2*time.Minute)) {
			writeError(w, fmt.Errorf("%w: observed_at must be after the Unix epoch and no more than two minutes in the future", errSample))
			return
		}
		if item.Host != nil && batch.Capacity != nil && item.Host.Available != nil && *item.Host.Available > batch.Capacity.Memory {
			writeError(w, fmt.Errorf("%w: available memory cannot exceed reported capacity", errSample))
			return
		}
	}
	// The next reporter is simply whichever authorized Agent reported a new
	// observation. A host name is for display and grouping only.
	hostID, err := s.bindReported(ctx, auth, agent, batch)
	if err != nil {
		writeError(w, err)
		return
	}
	sort.SliceStable(batch.Records, func(i, j int) bool { return batch.Records[i].Observed.Before(batch.Records[j].Observed) })
	ack, err := s.persist(ctx, auth, agent, hostID, batch, now)
	if err != nil {
		writeError(w, err)
		return
	}
	ack.HostID = hostID
	httpapi.JSON(w, 200, ack)
}

type acknowledgment struct {
	HostID    string `json:"hostId"`
	Inserted  int    `json:"inserted"`
	Duplicate int    `json:"duplicate"`
}

func (s *Service) persist(ctx context.Context, auth string, agent strategy.Agent, hostID string, batch reportBatch, now time.Time) (acknowledgment, error) {
	var ack acknowledgment
	err := storage.WithTx(ctx, s.stores.Metrics.Write, func(tx *sql.Tx) error {
		// Read the current session again after waiting for the metrics writer.
		current, err := strategy.Authorize(ctx, controldb.New(s.stores.Control.Read), auth, strategy.ReportScope)
		if err != nil {
			return err
		}
		if current.StrategyID != agent.StrategyID || current.InstanceID != agent.InstanceID || current.BootID != agent.BootID {
			return strategy.ErrUnauthorized
		}
		for _, report := range batch.Records {
			hostJSON, processJSON := optionalJSON(report.Host, report.Host != nil), optionalJSON(report.Process, report.Process != nil)
			observed := report.Observed.UnixMilli()
			capacity := optionalJSON(batch.Capacity, report.Host != nil && batch.Capacity != nil)
			var oldHost, oldProcess, oldCapacity sql.NullString
			var oldObserved, oldDuration int64
			err := tx.QueryRowContext(ctx, `SELECT observed_at,duration_ms,host_data,process_data,host_capacity FROM performance_samples
				WHERE strategy_id=? AND instance_id=? AND boot_id=? AND record_id=?`, agent.StrategyID, agent.InstanceID, agent.BootID, report.ID).
				Scan(&oldObserved, &oldDuration, &oldHost, &oldProcess, &oldCapacity)
			if err == nil {
				if oldObserved != observed || oldDuration != report.Duration || oldHost != hostJSON || oldProcess != processJSON || oldCapacity != capacity {
					return errConflict
				}
				ack.Duplicate++
				continue
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			var hostRun, processRun int64
			if report.Host != nil {
				hostRun, err = currentRun(ctx, tx, hostID, agent, observed, true)
				if err != nil {
					return err
				}
			}
			if report.Process != nil {
				processRun, err = currentRun(ctx, tx, hostID, agent, observed, false)
				if err != nil {
					return err
				}
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO performance_samples
				(host_id,strategy_id,instance_id,boot_id,revision,record_id,observed_at,received_at,duration_ms,host_data,process_data,host_capacity,host_run,process_run)
				VALUES(?,?,?,?,0,?,?,?,?,?,?,?,?,?)`, hostID, agent.StrategyID, agent.InstanceID, agent.BootID, report.ID, observed, now.UnixMilli(), report.Duration, hostJSON, processJSON, capacity, hostRun, processRun)
			if err != nil {
				return err
			}
			ack.Inserted++
		}
		return nil
	})
	return ack, err
}

// Late reports can fill the current run but cannot reopen a previous one.
func currentRun(ctx context.Context, tx *sql.Tx, hostID string, agent strategy.Agent, observed int64, host bool) (int64, error) {
	var last, run int64
	var source, instance, boot string
	var row *sql.Row
	if host {
		row = tx.QueryRowContext(ctx, `SELECT observed_at,host_run,strategy_id,instance_id,boot_id FROM performance_samples
			WHERE host_id=? AND host_data IS NOT NULL AND host_run>0 ORDER BY observed_at DESC,received_at DESC,record_id DESC LIMIT 1`, hostID)
	} else {
		row = tx.QueryRowContext(ctx, `SELECT observed_at,process_run,strategy_id,instance_id,boot_id FROM performance_samples
			WHERE strategy_id=? AND instance_id=? AND boot_id=? AND process_data IS NOT NULL AND process_run>0
			ORDER BY observed_at DESC,received_at DESC,record_id DESC LIMIT 1`, agent.StrategyID, agent.InstanceID, agent.BootID)
	}
	err := row.Scan(&last, &run, &source, &instance, &boot)
	if errors.Is(err, sql.ErrNoRows) {
		return observed, nil
	}
	if err != nil {
		return 0, err
	}
	if observed < run {
		return 0, nil
	}
	if observed > last && (observed-last > freshness.Milliseconds() || source == agent.StrategyID && instance == agent.InstanceID && boot != agent.BootID) {
		return observed, nil
	}
	return run, nil
}

func optionalJSON(value any, present bool) sql.NullString {
	if !present {
		return sql.NullString{}
	}
	raw, _ := json.Marshal(value)
	return sql.NullString{String: string(raw), Valid: true}
}

// Maintain prunes old samples in bounded transactions, without blocking Agent control storage.
func (s *Service) Maintain(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			for range 24 {
				result, err := s.stores.Metrics.Write.ExecContext(ctx, `DELETE FROM performance_samples WHERE
					(strategy_id,instance_id,boot_id,record_id) IN
					(SELECT strategy_id,instance_id,boot_id,record_id FROM performance_samples
					WHERE observed_at<? ORDER BY observed_at LIMIT 2000)`, now.Add(-3*24*time.Hour).UnixMilli())
				if err != nil {
					if ctx.Err() == nil {
						slog.Error("performance retention", "error", err)
					}
					break
				}
				if n, _ := result.RowsAffected(); n < 2000 {
					break
				}
			}
		}
	}
}
