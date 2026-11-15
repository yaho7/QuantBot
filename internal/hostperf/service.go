// Package hostperf records the measured resources of Agent execution environments.
package hostperf

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
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
var errAgent = errors.New("unknown_reporter_strategy")

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
	r.Post("/admin/hosts", s.create)
	r.Put("/admin/hosts/{id}/key", s.rotate)
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

type hostInput struct {
	Name             string `json:"name"`
	Scope            string `json:"scope"`
	ReporterStrategy string `json:"reporterStrategyId"`
	ReporterInstance string `json:"reporterInstanceId"`
}

func digest(key string) string {
	hash := sha256.Sum256([]byte(key))
	return hex.EncodeToString(hash[:])
}

func newKey() string { return "qbh_" + base64.RawURLEncoding.EncodeToString(randBytes(32)) }

func randBytes(size int) []byte {
	b := make([]byte, size)
	rand.Read(b)
	return b
}

func (s *Service) create(w http.ResponseWriter, r *http.Request) {
	var in hostInput
	if !httpapi.ReadJSON(w, r, &in, 4096) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 128 || (in.Scope != "machine" && in.Scope != "container") ||
		!identity.MatchString(in.ReporterStrategy) || !identity.MatchString(in.ReporterInstance) {
		httpapi.Error(w, 400, "invalid_host", "Provide a name, scope, and reporter strategy and instance IDs")
		return
	}
	id, key := hex.EncodeToString(randBytes(16)), newKey()
	result, err := s.stores.Control.Write.ExecContext(r.Context(), `INSERT INTO performance_hosts
		(id,name,scope,key_digest,reporter_strategy,reporter_instance)
		SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM strategies WHERE id=? AND archived_at IS NULL)`,
		id, in.Name, in.Scope, digest(key), in.ReporterStrategy, in.ReporterInstance, in.ReporterStrategy)
	if err == nil {
		if count, _ := result.RowsAffected(); count == 0 {
			err = errAgent
		}
	}
	if err != nil {
		writeError(w, err)
		return
	}
	httpapi.JSON(w, 201, map[string]string{"id": id, "bindingKey": key})
}

func (s *Service) rotate(w http.ResponseWriter, r *http.Request) {
	id, key := chi.URLParam(r, "id"), newKey()
	result, err := s.stores.Control.Write.ExecContext(r.Context(), "UPDATE performance_hosts SET key_digest=? WHERE id=?", digest(key), id)
	if err == nil {
		if count, _ := result.RowsAffected(); count == 0 {
			err = sql.ErrNoRows
		}
	}
	if err != nil {
		writeError(w, err)
		return
	}
	httpapi.JSON(w, 200, map[string]string{"id": id, "bindingKey": key})
}

type bindingInput struct {
	HostID   string     `json:"host_id"`
	Key      string     `json:"binding_key"`
	Capacity *resources `json:"capacity,omitempty"`
	Budget   *resources `json:"process_budget,omitempty"`
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
		var key string
		err = scanHost(tx.QueryRowContext(ctx, "SELECT "+hostFields+",key_digest FROM performance_hosts WHERE id=?", in.HostID), &h, &key)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && subtle.ConstantTimeCompare([]byte(digest(in.Key)), []byte(key)) != 1) {
			return errBinding
		}
		if err != nil {
			return err
		}
		reporter = agent.StrategyID == h.ReporterStrategy && agent.InstanceID == h.ReporterInstance
		if in.Capacity != nil {
			if !reporter {
				return errReporter
			}
			if h.Capacity != *in.Capacity {
				raw, _ := json.Marshal(in.Capacity)
				if _, err = tx.ExecContext(ctx, "UPDATE performance_hosts SET capacity=?,revision=revision+1 WHERE id=?", string(raw), h.ID); err != nil {
					return err
				}
				h.Capacity, h.Revision = *in.Capacity, h.Revision+1
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

func writeError(w http.ResponseWriter, err error) {
	if strategy.WriteAuthError(w, err) {
		return
	}
	switch {
	case errors.Is(err, errBinding):
		httpapi.Error(w, 403, "host_binding_required", "Bind this process with a valid host ID and binding key")
	case errors.Is(err, errReporter):
		httpapi.Error(w, 403, "not_host_reporter", "Only the designated instance may submit host capacity or host samples")
	case errors.Is(err, errConflict):
		httpapi.Error(w, 409, "performance_conflict", "The process is already bound to a different host or the record ID has different data")
	case errors.Is(err, errSample):
		httpapi.Error(w, 400, "invalid_sample", err.Error())
	case errors.Is(err, errAgent):
		httpapi.Error(w, 400, "unknown_reporter_strategy", "Select a non-archived reporter strategy")
	case errors.Is(err, sql.ErrNoRows):
		httpapi.Error(w, 404, "not_found", "Resource was not found")
	case errors.Is(err, context.Canceled):
	default:
		slog.Error("performance storage", "error", err)
		w.Header().Set("Retry-After", "1")
		httpapi.Error(w, 503, "performance_unavailable", "Performance storage is temporarily unavailable")
	}
}
