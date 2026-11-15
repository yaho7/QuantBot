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
	ID   string `json:"id"`
	Name string `json:"name"`
}

type reportBatch struct {
	Name     string     `json:"host_name"`
	Capacity *resources `json:"capacity,omitempty"`
	Budget   *resources `json:"process_budget,omitempty"`
	Records  []record   `json:"records"`
}

const discovered = "source_digest LIKE 'name:%'"

func reportedSource(name string) string {
	hash := sha256.Sum256([]byte(strings.ToLower(name)))
	return "name:" + hex.EncodeToString(hash[:])
}

func (s *Service) bindReported(ctx context.Context, auth string, agent strategy.Agent, input reportBatch) (string, error) {
	key := reportedSource(input.Name)
	budget, _ := json.Marshal(input.Budget)
	var id, oldKey, oldBudget string
	err := s.stores.Control.Read.QueryRowContext(ctx, `SELECT h.id,h.source_digest,b.budget
		FROM performance_bindings b JOIN performance_hosts h ON h.id=b.host_id
		WHERE b.strategy_id=? AND b.instance_id=? AND b.boot_id=?`,
		agent.StrategyID, agent.InstanceID, agent.BootID).Scan(&id, &oldKey, &oldBudget)
	if err == nil && oldKey == key && oldBudget == string(budget) {
		return id, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	err = storage.WithTx(ctx, s.stores.Control.Write, func(tx *sql.Tx) error {
		if _, err := strategy.Authorize(ctx, controldb.New(tx), auth, strategy.ReportScope); err != nil {
			return err
		}
		err := tx.QueryRowContext(ctx, "SELECT id FROM performance_hosts WHERE scope='machine' AND source_digest=?", key).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			var random [16]byte
			rand.Read(random[:])
			id = hex.EncodeToString(random[:])
			_, err = tx.ExecContext(ctx, `INSERT INTO performance_hosts(id,name,scope,source_digest,reporter_strategy,reporter_instance)
				VALUES (?,?,'machine',?,?,?)`, id, input.Name, key, agent.StrategyID, agent.InstanceID)
		}
		if err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO performance_bindings(strategy_id,instance_id,boot_id,host_id,budget)
			VALUES(?,?,?,?,?) ON CONFLICT(strategy_id,instance_id,boot_id) DO UPDATE SET host_id=excluded.host_id,budget=excluded.budget
			WHERE performance_bindings.host_id=excluded.host_id OR NOT EXISTS (
				SELECT 1 FROM performance_hosts WHERE id=performance_bindings.host_id AND `+discovered+`
			)`, agent.StrategyID, agent.InstanceID, agent.BootID, id, string(budget))
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err == nil && n == 0 {
			return errConflict
		}
		return err
	})
	return id, err
}

func writeError(w http.ResponseWriter, err error) {
	if strategy.WriteAuthError(w, err) {
		return
	}
	switch {
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
