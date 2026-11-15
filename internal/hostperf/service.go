// Package hostperf records the measured resources of Agent execution environments.
package hostperf

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

const freshness = 60 * time.Second

var identity = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$`)
var errBinding = errors.New("host_binding_required")
var errReporter = errors.New("not_host_reporter")
var errConflict = errors.New("performance_conflict")
var errSample = errors.New("invalid_sample")

type Service struct {
	stores *storage.Stores
	writes chan struct{}
}

func New(stores *storage.Stores) *Service {
	return &Service{stores: stores, writes: make(chan struct{}, 32)}
}

func (s *Service) RegisterAgent(r chi.Router) {
	r.Put("/host", s.bind)
	r.Post("/performance", s.ingest)
	r.Get("/schemas/performance.json", serveSchema)
}

func (s *Service) RegisterBrowser(r chi.Router) {
	r.Get("/hosts", s.list)
	r.Get("/hosts/{id}", s.detail)
	r.Get("/hosts/{id}/capacity", s.capacity)
	r.Get("/strategies/{id}/performance", s.strategyPerformance)
	r.Get("/strategies/{id}/performance/{instanceId}/history", s.processHistory)
}

type resources struct {
	CPUCores float64 `json:"cpu_cores"`
	Memory   int64   `json:"memory_bytes"`
}

func (r resources) valid() bool {
	return r.CPUCores > 0 && r.CPUCores <= 65536 && r.Memory > 0 && r.Memory <= 1<<53-1
}

type host struct {
	ID               string    `json:"id"`
	Name             string    `json:"name"`
	Scope            string    `json:"scope"`
	ReporterStrategy string    `json:"reporterStrategyId"`
	ReporterInstance string    `json:"reporterInstanceId"`
	Capacity         resources `json:"capacity"`
	Revision         int64     `json:"revision"`
}

type bindingInput struct {
	MachineID string     `json:"machine_id"`
	Name      string     `json:"name"`
	Scope     string     `json:"scope"`
	Capacity  *resources `json:"capacity,omitempty"`
	Budget    *resources `json:"process_budget,omitempty"`
}

// Names are display metadata. Only a high-entropy identifier, shared locally by
// Agents in one resource pool, joins processes to the same host.
func sourceDigest(id string) string {
	hash := sha256.Sum256([]byte("quantbot-host:" + id))
	return hex.EncodeToString(hash[:])
}

const hostFields = "id,name,scope,reporter_strategy,reporter_instance,capacity,revision"

type scanner interface{ Scan(...any) error }

func scanHost(row scanner, h *host, extra ...any) error {
	var raw string
	if err := row.Scan(append([]any{&h.ID, &h.Name, &h.Scope, &h.ReporterStrategy, &h.ReporterInstance, &raw, &h.Revision}, extra...)...); err != nil {
		return err
	}
	return json.Unmarshal([]byte(raw), &h.Capacity)
}

func (s *Service) bind(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	auth := r.Header.Get("Authorization")
	if _, err := strategy.Authorize(ctx, controldb.New(s.stores.Control.Read), auth, strategy.ReportScope); err != nil {
		writeError(w, err)
		return
	}
	var in bindingInput
	if !readInput(w, r, &in, "binding", 4096) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		httpapi.Error(w, 400, "invalid_host", "Provide a non-empty host name")
		return
	}
	if (in.Capacity != nil && !in.Capacity.valid()) || (in.Budget != nil && !in.Budget.valid()) {
		httpapi.Error(w, 400, "invalid_host", "CPU cores and memory bytes must be positive and within range")
		return
	}
	var h host
	var reporter bool
	err := storage.WithTx(ctx, s.stores.Control.Write, func(tx *sql.Tx) error {
		agent, err := strategy.Authorize(ctx, controldb.New(tx), auth, strategy.ReportScope)
		if err != nil {
			return err
		}
		source := sourceDigest(in.MachineID)
		err = scanHost(tx.QueryRowContext(ctx, "SELECT "+hostFields+" FROM performance_hosts WHERE scope=? AND source_digest=?", in.Scope, source), &h)
		if errors.Is(err, sql.ErrNoRows) {
			var key [16]byte
			rand.Read(key[:])
			h = host{ID: hex.EncodeToString(key[:]), Name: in.Name, Scope: in.Scope,
				ReporterStrategy: agent.StrategyID, ReporterInstance: agent.InstanceID}
			_, err = tx.ExecContext(ctx, `INSERT INTO performance_hosts
				(id,name,scope,source_digest,reporter_strategy,reporter_instance) VALUES (?,?,?,?,?,?)`,
				h.ID, h.Name, h.Scope, source, agent.StrategyID, agent.InstanceID)
		}
		if err != nil {
			return err
		}
		reporter = agent.StrategyID == h.ReporterStrategy && agent.InstanceID == h.ReporterInstance
		if !reporter && in.Capacity != nil {
			active, err := reporterActive(ctx, tx, h)
			if err != nil {
				return err
			}
			// A process-only reporter must not prevent capable peers from supplying machine metrics.
			reporter = !active || !h.Capacity.valid()
		}
		if reporter {
			if in.Capacity != nil && h.Capacity != *in.Capacity {
				h.Capacity, h.Revision = *in.Capacity, h.Revision+1
			}
			raw, _ := json.Marshal(h.Capacity)
			if _, err := tx.ExecContext(ctx, `UPDATE performance_hosts
				SET name=?,capacity=?,revision=?,reporter_strategy=?,reporter_instance=?
				WHERE id=? AND (name<>? OR revision<>? OR reporter_strategy<>? OR reporter_instance<>?)`,
				in.Name, string(raw), h.Revision, agent.StrategyID, agent.InstanceID,
				h.ID, in.Name, h.Revision, agent.StrategyID, agent.InstanceID); err != nil {
				return err
			}
		}
		budget, _ := json.Marshal(in.Budget)
		res, err := tx.ExecContext(ctx, `INSERT INTO performance_bindings(strategy_id,instance_id,boot_id,host_id,budget)
			VALUES(?,?,?,?,?) ON CONFLICT(strategy_id,instance_id,boot_id) DO UPDATE SET budget=excluded.budget
			WHERE performance_bindings.host_id=excluded.host_id`, agent.StrategyID, agent.InstanceID, agent.BootID, h.ID, string(budget))
		if err == nil {
			if count, _ := res.RowsAffected(); count == 0 {
				return errConflict
			}
		}
		return err
	})
	if err != nil {
		writeError(w, err)
		return
	}
	httpapi.JSON(w, 200, map[string]any{"hostId": h.ID, "hostReporter": reporter, "revision": h.Revision})
}

func reporterActive(ctx context.Context, tx *sql.Tx, h host) (bool, error) {
	var active bool
	now := time.Now()
	err := tx.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM agent_instances a
		JOIN performance_bindings b ON (a.strategy_id,a.instance_id,a.boot_id)=(b.strategy_id,b.instance_id,b.boot_id)
		JOIN strategies s ON s.id=a.strategy_id AND s.archived_at IS NULL
		JOIN agent_sessions x ON (a.strategy_id,a.instance_id,a.boot_id)=(x.strategy_id,x.instance_id,x.boot_id)
		JOIN agent_tokens t ON t.id=x.token_id
		WHERE a.strategy_id=? AND a.instance_id=? AND b.host_id=? AND a.last_seen>=?
			AND x.expires_at>? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)
			AND (t.scopes & ?) != 0
	)`, h.ReporterStrategy, h.ReporterInstance, h.ID, now.Add(-freshness).Unix(), now.Unix(), now.Unix(),
		strategy.ReportScope).Scan(&active)
	return active, err
}

func writeError(w http.ResponseWriter, err error) {
	if strategy.WriteAuthError(w, err) {
		return
	}
	switch {
	case errors.Is(err, errBinding):
		httpapi.Error(w, 403, "host_binding_required", "Register this process using PUT /api/agent/host before submitting samples")
	case errors.Is(err, errReporter):
		httpapi.Error(w, 403, "not_host_reporter", "Only the elected instance may submit host samples; refresh host registration and report process data meanwhile")
	case errors.Is(err, errConflict):
		httpapi.Error(w, 409, "performance_conflict", "The process is already bound to a different host or the record ID has different data")
	case errors.Is(err, errSample):
		httpapi.Error(w, 400, "invalid_sample", err.Error())
	case errors.Is(err, sql.ErrNoRows):
		httpapi.Error(w, 404, "not_found", "Resource was not found")
	case errors.Is(err, context.Canceled):
	default:
		slog.Error("performance storage", "error", err)
		w.Header().Set("Retry-After", "1")
		httpapi.Error(w, 503, "performance_unavailable", "Performance storage is temporarily unavailable")
	}
}
