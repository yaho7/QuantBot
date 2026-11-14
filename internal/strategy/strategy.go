package strategy

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/realtime"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

const (
	HeartbeatScope int64 = 1 << iota
	ReportScope
	ControlScope
	CommandScope
	AllScopes = HeartbeatScope | ReportScope | ControlScope | CommandScope
)

const (
	PresenceTTL = 45 * time.Second
)

var (
	ErrUnauthorized  = errors.New("agent authorization is invalid or expired")
	errConflict      = errors.New("resource is unavailable in its current state")
	errBootRetired   = errors.New("boot ID was superseded by another process")
	errInstanceLimit = errors.New("strategy instance limit reached")
	idPattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$`)
)

type Service struct {
	store      storage.Database
	notify     realtime.Notify
	sessionTTL time.Duration
	sandbox    bool
}

func New(store storage.Database, notify realtime.Notify, ttl time.Duration) *Service {
	if ttl <= 0 {
		ttl = config.DefaultAgentSessionTTL
	}
	return &Service{store: store, notify: notify, sessionTTL: ttl}
}

func NewSandbox(store storage.Database) *Service {
	return &Service{store: store, sessionTTL: config.DefaultAgentSessionTTL, sandbox: true}
}

func (s *Service) RegisterBrowser(r chi.Router) {
	r.Get("/strategies", s.list(false))
	r.Get("/strategies/{id}", s.detail)
	r.Get("/admin/strategies", s.list(true))
	r.Post("/admin/strategies", s.create)
	r.Get("/admin/strategies/{id}", s.detail)
	r.Put("/admin/strategies/{id}", s.update)
	r.Delete("/admin/strategies/{id}", s.archive)
	r.Put("/admin/strategies/{id}/executor", s.executor)
	r.Get("/admin/strategies/{id}/tokens", s.tokens)
	r.Post("/admin/strategies/{id}/tokens", s.issueToken)
	r.Put("/admin/strategies/{id}/tokens/{token}", s.updateTokenScopes)
	r.Delete("/admin/strategies/{id}/tokens/{token}", s.revokeToken)
}

func (s *Service) RegisterAgent(r chi.Router) {
	r.Post("/session", s.connect)
	r.Put("/heartbeat", s.heartbeat)
}

func (s *Service) list(includeArchived bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var include int64
		if includeArchived {
			include = 1
		}
		rows, err := controldb.New(s.store.Read).ListStrategies(r.Context(), include)
		if err != nil {
			httpError(w, err)
			return
		}
		items := make([]strategyView, 0, len(rows))
		for _, row := range rows {
			items = append(items, strategyView{
				ID: row.ID, Name: row.Name, Group: row.GroupName, Mode: row.Mode,
				CreatedAt: row.CreatedAt, ArchivedAt: nullableInt(row.ArchivedAt),
				ExecutorInstance: row.ExecutorInstance.String, Online: !row.ArchivedAt.Valid && online(row.LastSeen),
				LastSeen: row.LastSeen,
			})
		}
		httpapi.JSON(w, http.StatusOK, items)
	}
}

type strategyView struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Group            string `json:"group"`
	Mode             string `json:"mode"`
	CreatedAt        int64  `json:"createdAt"`
	ArchivedAt       *int64 `json:"archivedAt"`
	ExecutorInstance string `json:"executorInstance,omitempty"`
	Online           bool   `json:"online"`
	LastSeen         int64  `json:"lastSeen"`
}

type instanceView struct {
	InstanceID string `json:"instanceId"`
	BootID     string `json:"bootId"`
	StartedAt  int64  `json:"startedAt"`
	LastSeen   int64  `json:"lastSeen"`
	Online     bool   `json:"online"`
}

func (s *Service) detail(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), chi.URLParam(r, "id")
	q := controldb.New(s.store.Read)
	row, err := q.GetStrategy(ctx, id)
	if err != nil {
		httpError(w, err)
		return
	}
	rows, err := q.ListAgentInstances(ctx, id)
	if err != nil {
		httpError(w, err)
		return
	}
	view := strategyView{
		ID: row.ID, Name: row.Name, Group: row.GroupName, Mode: row.Mode,
		CreatedAt: row.CreatedAt, ArchivedAt: nullableInt(row.ArchivedAt), ExecutorInstance: row.ExecutorInstance.String,
	}
	instances := make([]instanceView, 0, len(rows))
	for _, instance := range rows {
		instances = append(instances, instanceView{instance.InstanceID, instance.BootID, instance.StartedAt, instance.LastSeen, !row.ArchivedAt.Valid && online(instance.LastSeen)})
		view.LastSeen = max(instance.LastSeen, view.LastSeen)
	}
	view.Online = !row.ArchivedAt.Valid && online(view.LastSeen)
	httpapi.JSON(w, http.StatusOK, struct {
		strategyView
		Instances []instanceView `json:"instances"`
	}{view, instances})
}

type strategyInput struct {
	Name  string `json:"name"`
	Group string `json:"group"`
}

func (input *strategyInput) validate() bool {
	input.Name, input.Group = strings.TrimSpace(input.Name), strings.TrimSpace(input.Group)
	return len(input.Name) > 0 && len(input.Name) <= 120 && len(input.Group) <= 100
}

func (s *Service) create(w http.ResponseWriter, r *http.Request) {
	var input struct {
		strategyInput
		Mode string `json:"mode"`
	}
	if !httpapi.ReadJSON(w, r, &input, 4096) {
		return
	}
	if !input.validate() || (input.Mode != "paper" && input.Mode != "live") {
		httpapi.Error(w, http.StatusBadRequest, "invalid_strategy", "Provide a name and paper or live mode")
		return
	}
	ctx := r.Context()
	id, raw, tokenID, now := random(16), "qbt_"+random(32), random(16), time.Now().Unix()
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		if err := q.CreateStrategy(ctx, controldb.CreateStrategyParams{ID: id, Name: input.Name, GroupName: input.Group, Mode: input.Mode, CreatedAt: now}); err != nil {
			return err
		}
		if err := q.CreateAgentToken(ctx, controldb.CreateAgentTokenParams{
			ID: tokenID, StrategyID: id, Digest: digest(raw), Label: "Initial Agent", Scopes: AllScopes, CreatedAt: now,
		}); err != nil {
			return err
		}
		return appendAudit(ctx, q, auth.Current(r).Username, "strategy.created", id)
	})
	if err != nil {
		httpError(w, err)
		return
	}
	s.notify.Emit(id, realtime.Status)
	httpapi.JSON(w, http.StatusCreated, map[string]any{
		"strategy":   strategyView{ID: id, Name: input.Name, Group: input.Group, Mode: input.Mode, CreatedAt: now},
		"credential": tokenView{ID: tokenID, Label: "Initial Agent", Scopes: scopeNames(AllScopes), CreatedAt: now, Token: raw},
	})
}

func (s *Service) update(w http.ResponseWriter, r *http.Request) {
	var input strategyInput
	if !httpapi.ReadJSON(w, r, &input, 4096) {
		return
	}
	if !input.validate() {
		httpapi.Error(w, http.StatusBadRequest, "invalid_strategy", "Provide a valid name and group")
		return
	}
	s.change(w, r, "strategy.updated", func(ctx context.Context, q *controldb.Queries, id string) error {
		return changed(q.UpdateStrategy(ctx, controldb.UpdateStrategyParams{ID: id, Name: input.Name, GroupName: input.Group}))
	})
}

func (s *Service) archive(w http.ResponseWriter, r *http.Request) {
	s.change(w, r, "strategy.archived", func(ctx context.Context, q *controldb.Queries, id string) error {
		now := sql.NullInt64{Int64: time.Now().Unix(), Valid: true}
		if err := changed(q.ArchiveStrategy(ctx, controldb.ArchiveStrategyParams{ID: id, ArchivedAt: now})); err != nil {
			return err
		}
		return q.RevokeStrategyTokens(ctx, controldb.RevokeStrategyTokensParams{StrategyID: id, RevokedAt: now})
	})
}

func (s *Service) executor(w http.ResponseWriter, r *http.Request) {
	var input struct {
		InstanceID *string `json:"instanceId"`
	}
	if !httpapi.ReadJSON(w, r, &input, 4096) {
		return
	}
	var instance sql.NullString
	if input.InstanceID != nil {
		if !idPattern.MatchString(*input.InstanceID) {
			httpapi.Error(w, http.StatusBadRequest, "invalid_instance", "Invalid instance ID")
			return
		}
		instance = sql.NullString{String: *input.InstanceID, Valid: true}
	}
	s.change(w, r, "strategy.executor_changed", func(ctx context.Context, q *controldb.Queries, id string) error {
		return changed(q.SelectExecutor(ctx, controldb.SelectExecutorParams{StrategyID: id, InstanceID: instance}))
	})
}

func (s *Service) change(w http.ResponseWriter, r *http.Request, action string, apply func(context.Context, *controldb.Queries, string) error) {
	ctx, id := r.Context(), chi.URLParam(r, "id")
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		if err := apply(ctx, q, id); err != nil {
			return err
		}
		return appendAudit(ctx, q, auth.Current(r).Username, action, id)
	})
	if err != nil {
		httpError(w, err)
		return
	}
	s.notify.Emit(id, realtime.Status)
	w.WriteHeader(http.StatusNoContent)
}

func changed(count int64, err error) error {
	if err == nil && count == 0 {
		return errConflict
	}
	return err
}

func online(lastSeen int64) bool {
	return lastSeen > time.Now().Add(-PresenceTTL).Unix()
}

func nullableInt(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func random(size int) string {
	value := make([]byte, size)
	rand.Read(value)
	return base64.RawURLEncoding.EncodeToString(value)
}

func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func appendAudit(ctx context.Context, q *controldb.Queries, actor, action, id string) error {
	return q.AppendAudit(ctx, controldb.AppendAuditParams{
		At: time.Now().UnixMilli(), Actor: actor, Action: action,
		StrategyID: sql.NullString{String: id, Valid: true}, Details: "{}",
	})
}

func httpError(w http.ResponseWriter, err error) {
	if WriteAuthError(w, err) {
		return
	}
	switch {
	case errors.Is(err, sql.ErrNoRows):
		httpapi.Error(w, http.StatusNotFound, "not_found", "Resource was not found")
	case errors.Is(err, errConflict), errors.Is(err, errBootRetired), errors.Is(err, errInstanceLimit):
		httpapi.Error(w, http.StatusConflict, "state_conflict", err.Error())
	default:
		slog.Error("strategy storage", "error", err)
		httpapi.Error(w, http.StatusServiceUnavailable, "storage_unavailable", "Strategy storage unavailable")
	}
}
