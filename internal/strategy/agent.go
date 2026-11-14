package strategy

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/realtime"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

type Agent struct {
	StrategyID string `json:"strategyId"`
	InstanceID string `json:"instanceId"`
	BootID     string `json:"bootId"`
	TokenID    string `json:"-"`
	Digest     string `json:"-"`
	ExpiresAt  int64  `json:"expiresAt"`
	Executor   bool   `json:"executor"`
	LastSeen   int64  `json:"lastSeen"`
}

func Authorize(ctx context.Context, q *controldb.Queries, authorization string, scope int64) (Agent, error) {
	value := bearer(authorization, "qbs_")
	if value == "" {
		return Agent{}, ErrUnauthorized
	}
	return authorizeDigest(ctx, q, digest(value), scope)
}

func authorizeDigest(ctx context.Context, q *controldb.Queries, key string, scope int64) (Agent, error) {
	row, err := q.GetLiveAgentSession(ctx, controldb.GetLiveAgentSessionParams{Digest: key, Now: time.Now().Unix()})
	if errors.Is(err, sql.ErrNoRows) || (err == nil && row.Scopes&scope != scope) {
		return Agent{}, ErrUnauthorized
	}
	if err != nil {
		return Agent{}, err
	}
	return Agent{
		StrategyID: row.StrategyID, InstanceID: row.InstanceID, BootID: row.BootID, TokenID: row.TokenID,
		ExpiresAt: row.ExpiresAt, Executor: row.ExecutorInstance.String == row.InstanceID && row.Scopes&CommandScope != 0,
		LastSeen: row.LastSeen, Digest: key,
	}, nil
}

func bearer(header, prefix string) string {
	scheme, value, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || !strings.HasPrefix(value, prefix) || len(value) != 47 {
		return ""
	}
	return value
}

func (s *Service) connect(w http.ResponseWriter, r *http.Request) {
	var input struct {
		InstanceID string `json:"instanceId"`
		BootID     string `json:"bootId"`
	}
	raw := bearer(r.Header.Get("Authorization"), "qbt_")
	if raw == "" {
		httpError(w, ErrUnauthorized)
		return
	}
	if !httpapi.ReadJSON(w, r, &input, 4096) {
		return
	}
	if !idPattern.MatchString(input.InstanceID) || !idPattern.MatchString(input.BootID) {
		httpapi.Error(w, http.StatusBadRequest, "invalid_identity", "Provide a stable instance ID and a unique process boot ID")
		return
	}
	ctx := r.Context()
	now := time.Now()
	expiry := now.Add(SessionTTL).Unix()
	session := "qbs_" + random(32)
	tokenDigest := digest(raw)
	// Reject unauthenticated traffic before it reaches the single writer.
	if _, err := liveToken(ctx, controldb.New(s.store.Read), tokenDigest, now.Unix()); err != nil {
		httpError(w, err)
		return
	}
	var identity Agent
	var revision int64
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		token, err := liveToken(ctx, q, tokenDigest, now.Unix())
		if err != nil {
			return err
		}
		if err := registerBoot(ctx, q, token.StrategyID, input.InstanceID, input.BootID, now.Unix()); err != nil {
			return err
		}
		if token.ExpiresAt.Valid {
			expiry = min(expiry, token.ExpiresAt.Int64)
		}
		sessionDigest := digest(session)
		if err := q.UpsertAgentSession(ctx, controldb.UpsertAgentSessionParams{
			Digest: sessionDigest, StrategyID: token.StrategyID, InstanceID: input.InstanceID,
			BootID: input.BootID, TokenID: token.ID, ExpiresAt: expiry,
		}); err != nil {
			return err
		}
		identity, err = authorizeDigest(ctx, q, sessionDigest, 0)
		if err != nil {
			return err
		}
		registry, err := q.GetControlRegistry(ctx, token.StrategyID)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		revision = registry.Revision
		return err
	})
	if err != nil {
		httpError(w, err)
		return
	}
	s.notify.Emit(identity.StrategyID, realtime.Status)
	httpapi.JSON(w, http.StatusCreated, struct {
		Agent
		Session  string `json:"session"`
		Revision int64  `json:"revision"`
	}{identity, session, revision})
}

func liveToken(ctx context.Context, q *controldb.Queries, digest string, now int64) (controldb.AgentToken, error) {
	token, err := q.GetLiveAgentToken(ctx, controldb.GetLiveAgentTokenParams{
		Digest: digest, Now: sql.NullInt64{Int64: now, Valid: true},
	})
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrUnauthorized
	}
	return token, err
}

func registerBoot(ctx context.Context, q *controldb.Queries, strategyID, instanceID, bootID string, now int64) error {
	key := controldb.GetAgentInstanceParams{StrategyID: strategyID, InstanceID: instanceID}
	previous, err := q.GetAgentInstance(ctx, key)
	first := errors.Is(err, sql.ErrNoRows)
	if err != nil && !first {
		return err
	}
	if first {
		count, err := q.CountAgentInstances(ctx, strategyID)
		if err != nil {
			return err
		}
		if count >= 256 {
			return errInstanceLimit
		}
	}
	if err := q.UpsertAgentInstance(ctx, controldb.UpsertAgentInstanceParams{
		StrategyID: strategyID, InstanceID: instanceID, BootID: bootID, StartedAt: now, LastSeen: now,
	}); err != nil {
		return err
	}
	if !first && previous.BootID == bootID {
		return nil
	}
	created, err := q.RememberAgentBoot(ctx, controldb.RememberAgentBootParams{
		StrategyID: strategyID, InstanceID: instanceID, BootID: bootID,
	})
	if err == nil && created == 0 {
		return errBootRetired
	}
	return err
}

func (s *Service) heartbeat(w http.ResponseWriter, r *http.Request) {
	ctx, authorization := r.Context(), r.Header.Get("Authorization")
	if _, err := Authorize(ctx, controldb.New(s.store.Read), authorization, HeartbeatScope); err != nil {
		httpError(w, err)
		return
	}
	var agent Agent
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		var err error
		agent, err = Authorize(ctx, q, authorization, HeartbeatScope)
		if err != nil {
			return err
		}
		agent.LastSeen = time.Now().Unix()
		return changed(q.UpdateAgentHeartbeat(ctx, controldb.UpdateAgentHeartbeatParams{
			StrategyID: agent.StrategyID, InstanceID: agent.InstanceID, BootID: agent.BootID, Now: agent.LastSeen,
		}))
	})
	if err != nil {
		httpError(w, err)
		return
	}
	s.notify.Emit(agent.StrategyID, realtime.Status)
	httpapi.JSON(w, http.StatusOK, agent)
}

func ActiveExecutor(ctx context.Context, q *controldb.Queries, strategyID string, scope int64) (controldb.GetActiveExecutorRow, error) {
	now := time.Now()
	return q.GetActiveExecutor(ctx, controldb.GetActiveExecutorParams{
		StrategyID: strategyID, Now: now.Unix(), SeenAfter: now.Add(-PresenceTTL).Unix(), Scope: scope,
	})
}
