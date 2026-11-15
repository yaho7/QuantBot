package hostperf

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
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
	var batch struct {
		Records []record `json:"records"`
	}
	if !readInput(w, r, &batch, "batch", 256<<10) {
		return
	}
	now := time.Now()
	for _, item := range batch.Records {
		if item.Observed.UnixMilli() <= 0 || item.Observed.After(now.Add(2*time.Minute)) {
			writeError(w, fmt.Errorf("%w: observed_at must be after the Unix epoch and no more than two minutes in the future", errSample))
			return
		}
	}
	ack, err := s.persist(ctx, auth, agent, batch.Records, now)
	if err != nil {
		writeError(w, err)
		return
	}
	httpapi.JSON(w, 200, ack)
}

type acknowledgment struct {
	Inserted  int `json:"inserted"`
	Duplicate int `json:"duplicate"`
}

func (s *Service) persist(ctx context.Context, auth string, agent strategy.Agent, records []record, now time.Time) (acknowledgment, error) {
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
		var h host
		err = scanHost(s.stores.Control.Read.QueryRowContext(ctx, "SELECT "+hostFields+` FROM performance_hosts WHERE id=(
			SELECT host_id FROM performance_bindings WHERE strategy_id=? AND instance_id=? AND boot_id=?)`,
			agent.StrategyID, agent.InstanceID, agent.BootID), &h)
		if errors.Is(err, sql.ErrNoRows) {
			return errBinding
		}
		if err != nil {
			return err
		}
		for _, report := range records {
			if report.Host != nil && (h.ReporterStrategy != agent.StrategyID || h.ReporterInstance != agent.InstanceID) {
				return errReporter
			}
			hostJSON, processJSON := optionalJSON(report.Host, report.Host != nil), optionalJSON(report.Process, report.Process != nil)
			observed := report.Observed.UnixMilli()
			var oldHost, oldProcess sql.NullString
			var oldObserved, oldDuration int64
			err := tx.QueryRowContext(ctx, `SELECT observed_at,duration_ms,host_data,process_data FROM performance_samples
				WHERE strategy_id=? AND instance_id=? AND boot_id=? AND record_id=?`, agent.StrategyID, agent.InstanceID, agent.BootID, report.ID).
				Scan(&oldObserved, &oldDuration, &oldHost, &oldProcess)
			if err == nil {
				if oldObserved != observed || oldDuration != report.Duration || oldHost != hostJSON || oldProcess != processJSON {
					return errConflict
				}
				ack.Duplicate++
				continue
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if report.Host != nil && (!h.Capacity.valid() || report.Host.Available != nil && *report.Host.Available > h.Capacity.Memory) {
				return fmt.Errorf("%w: register effective capacity before reporting host data; available memory cannot exceed capacity", errSample)
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO performance_samples
				(host_id,strategy_id,instance_id,boot_id,revision,record_id,observed_at,received_at,duration_ms,host_data,process_data)
				VALUES(?,?,?,?,?,?,?,?,?,?,?)`, h.ID, agent.StrategyID, agent.InstanceID, agent.BootID, h.Revision, report.ID, observed, now.UnixMilli(), report.Duration, hostJSON, processJSON)
			if err != nil {
				return err
			}
			ack.Inserted++
		}
		return nil
	})
	return ack, err
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
					WHERE observed_at<? ORDER BY observed_at LIMIT 2000)`, now.Add(-7*24*time.Hour).UnixMilli())
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
