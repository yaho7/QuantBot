package command

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/control"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/realtime"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

type Service struct {
	store  storage.Database
	stop   context.Context
	poll   time.Duration
	polls  chan struct{}
	notify realtime.Notify
}

func New(store storage.Database, stop context.Context, poll time.Duration, notify realtime.Notify) *Service {
	return &Service{store: store, stop: stop, poll: poll, polls: make(chan struct{}, 2048), notify: notify}
}

func (s *Service) RegisterBrowser(r chi.Router) {
	r.Post("/strategies/{id}/commands", s.create)
	r.Get("/commands", s.list)
	r.Get("/commands/{id}", s.detail)
	r.Post("/commands/{id}/{action}", s.browserAction)
	r.Get("/admin/audit", s.audit)
}

func (s *Service) RegisterAgent(r chi.Router) {
	r.Get("/commands", s.pollCommands)
	r.Post("/commands/{id}/claim", s.claim)
	r.Post("/commands/{id}/result", s.result)
}

var (
	requestID      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$`)
	errExecutor    = errors.New("current online executor required")
	errUnavailable = errors.New("control is disabled, read-only or unavailable")
	errIdempotency = errors.New("idempotency key already used for different intent")
	errActive      = errors.New("control already has an active or unknown command")
)

type invalid string

func (err invalid) Error() string { return string(err) }

type view struct {
	ID         string          `json:"id"`
	StrategyID string          `json:"strategyId"`
	ControlID  string          `json:"controlId"`
	Revision   int64           `json:"revision"`
	Input      json.RawMessage `json:"input"`
	InstanceID string          `json:"instanceId"`
	BootID     string          `json:"bootId"`
	Status     string          `json:"status"`
	CreatedAt  int64           `json:"createdAt"`
	UpdatedAt  int64           `json:"updatedAt"`
	Deadline   int64           `json:"deadline"`
	Receipt    json.RawMessage `json:"receipt,omitempty"`
}

func present(cmd controldb.Command) view {
	return view{
		ID: cmd.ID, StrategyID: cmd.StrategyID, ControlID: cmd.ControlID,
		Revision: cmd.Revision, Input: json.RawMessage(cmd.Input), InstanceID: cmd.InstanceID,
		BootID: cmd.BootID, Status: cmd.Status, CreatedAt: cmd.CreatedAt, UpdatedAt: cmd.UpdatedAt,
		Deadline: cmd.Deadline, Receipt: json.RawMessage(cmd.Receipt.String),
	}
}

func randomID() string {
	var id [24]byte
	rand.Read(id[:])
	return base64.RawURLEncoding.EncodeToString(id[:])
}

func commandError(w http.ResponseWriter, err error) {
	if strategy.WriteAuthError(w, err) {
		return
	}
	var bad invalid
	switch {
	case errors.As(err, &bad):
		httpapi.Error(w, http.StatusBadRequest, "invalid_command", err.Error())
	case errors.Is(err, sql.ErrNoRows):
		httpapi.Error(w, http.StatusNotFound, "not_found", "Command or control was not found")
	case errors.Is(err, errState), errors.Is(err, errIdempotency), errors.Is(err, errActive),
		errors.Is(err, control.ErrRegistryChanged), errors.Is(err, errExecutor), errors.Is(err, errUnavailable):
		httpapi.Error(w, http.StatusConflict, "state_conflict", err.Error())
	default:
		slog.Error("command storage", "error", err)
		httpapi.Error(w, http.StatusServiceUnavailable, "storage_unavailable", "Command storage unavailable")
	}
}

func checkTarget(ctx context.Context, q *controldb.Queries, cmd controldb.Command) (controldb.GetActiveExecutorRow, control.Definition, error) {
	executor, err := strategy.ActiveExecutor(ctx, q, cmd.StrategyID, strategy.CommandScope)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (cmd.InstanceID != "" &&
		(cmd.InstanceID != executor.InstanceID || cmd.BootID != executor.BootID)) {
		return executor, control.Definition{}, errExecutor
	}
	if err != nil {
		return executor, control.Definition{}, err
	}
	registry, err := q.GetControlRegistry(ctx, cmd.StrategyID)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (registry.Revision != cmd.Revision ||
		registry.InstanceID != executor.InstanceID || registry.BootID != executor.BootID) {
		return executor, control.Definition{}, control.ErrRegistryChanged
	}
	if err != nil {
		return executor, control.Definition{}, err
	}
	definition, err := control.LoadDefinition(ctx, q, cmd.StrategyID, cmd.ControlID)
	if err != nil {
		return executor, definition, err
	}
	actual, err := q.GetControlState(ctx, controldb.GetControlStateParams{StrategyID: cmd.StrategyID, ControlID: cmd.ControlID})
	if definition.Disabled || definition.IsReadOnly() || errors.Is(err, sql.ErrNoRows) || err == nil && (actual.Available != 1 || definition.Capability != nil && definition.Capability.Expired(actual.ObservedAt, time.Now())) {
		return executor, definition, errUnavailable
	}
	return executor, definition, err
}
