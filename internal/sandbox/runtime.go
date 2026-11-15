package sandbox

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/agentapi"
	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/command"
	"github.com/yaho7/QuantBot/internal/control"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/strategy"
	"github.com/yaho7/QuantBot/internal/telemetry"
)

type run struct {
	info
	ctx      context.Context
	cancel   context.CancelFunc
	stores   *storage.Stores
	reports  *telemetry.Service
	tokenID  string
	key      string
	checked  map[string]bool
	agent    http.Handler
	console  http.Handler
	users    sync.WaitGroup
	worker   sync.WaitGroup
	requests window
	inflight int
}

func newRun(ctx, lifetime context.Context, id, strategyID, name, token string, now time.Time) (*run, error) {
	stores, err := storage.OpenSandbox(ctx)
	if err != nil {
		return nil, err
	}
	reports, err := telemetry.New(stores, telemetry.QueueConfig{Capacity: 4, Batch: 4, Flush: 2 * time.Millisecond}, nil)
	if err != nil {
		return nil, errors.Join(err, stores.Close())
	}
	stop, cancel := context.WithCancel(lifetime)
	r := &run{
		info: info{ID: id, ExpiresAt: now.Add(keyTTL).Unix(), Status: "active", Requests: []requestLog{}},
		ctx:  stop, cancel: cancel, stores: stores, reports: reports, tokenID: id, key: token, checked: make(map[string]bool),
	}
	err = storage.WithTx(ctx, stores.Control.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		if err := q.CreateStrategy(ctx, controldb.CreateStrategyParams{
			ID: strategyID, Name: name, Mode: "paper", CreatedAt: now.Unix(),
		}); err != nil {
			return err
		}
		return q.CreateAgentToken(ctx, controldb.CreateAgentTokenParams{
			ID: r.tokenID, StrategyID: strategyID, Digest: auth.Digest(token), Label: "Sandbox",
			Scopes: strategy.AllScopes, CreatedAt: now.Unix(),
			ExpiresAt: sql.NullInt64{Int64: r.ExpiresAt, Valid: true},
		})
	})
	if err != nil {
		cancel()
		reports.Close()
		return nil, errors.Join(err, stores.Close())
	}
	commands := command.New(stores.Control, stop, 3*time.Second, nil)
	agent := chi.NewRouter()
	agentapi.Register(agent, strategy.NewSandbox(stores.Control), control.New(stores.Control, nil), commands, reports)
	r.agent = agent
	console := chi.NewRouter()
	console.Route("/browser", func(router chi.Router) {
		control.New(stores.Control, nil).RegisterBrowser(router)
		commands.RegisterBrowser(router)
	})
	r.console = console
	r.worker.Go(func() { commands.Maintain(stop) })
	return r, nil
}

func (r *run) close() {
	r.cancel()
	r.users.Wait()
	r.worker.Wait()
	r.reports.Close()
	if err := r.stores.Close(); err != nil {
		slog.Warn("close Sandbox stores", "error", err)
	}
}

func (r *run) extend(ctx context.Context, expires int64) error {
	_, err := r.stores.Control.Write.ExecContext(ctx, "UPDATE agent_tokens SET expires_at=? WHERE id=?", expires, r.tokenID)
	return err
}
