package command

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/control"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/realtime"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

func (s *Service) pollCommands(w http.ResponseWriter, r *http.Request) {
	wait := s.poll
	if raw := r.URL.Query().Get("wait"); raw != "" {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds < 0 || seconds > 25 {
			commandError(w, invalid("wait must be an integer between 0 and 25 seconds"))
			return
		}
		wait = min(wait, time.Duration(seconds)*time.Second)
	}
	select {
	case s.polls <- struct{}{}:
		defer func() { <-s.polls }()
	default:
		w.Header().Set("Retry-After", "1")
		httpapi.Error(w, http.StatusTooManyRequests, "poll_limit", "Too many concurrent command polls")
		return
	}

	ctx := r.Context()
	q := controldb.New(s.store.Read)
	ticker := time.NewTicker(400 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for {
		agent, err := strategy.Authorize(ctx, q, r.Header.Get("Authorization"), strategy.CommandScope)
		if err != nil {
			commandError(w, err)
			return
		}
		if !agent.Executor || agent.LastSeen <= time.Now().Add(-strategy.PresenceTTL).Unix() {
			commandError(w, errExecutor)
			return
		}
		registry, err := q.GetControlRegistry(ctx, agent.StrategyID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			commandError(w, err)
			return
		}
		commands := []view{}
		if registry.BootID == agent.BootID && registry.InstanceID == agent.InstanceID {
			rows, err := q.ListPendingCommands(ctx, controldb.ListPendingCommandsParams{
				StrategyID: agent.StrategyID, InstanceID: agent.InstanceID, BootID: agent.BootID,
				Revision: registry.Revision, Now: time.Now().UnixMilli(),
			})
			if err != nil {
				commandError(w, err)
				return
			}
			for _, row := range rows {
				commands = append(commands, present(row))
			}
		}
		if len(commands) > 0 || wait == 0 {
			httpapi.JSON(w, http.StatusOK, commands)
			return
		}
		select {
		case <-deadline.C:
			wait = 0
		case <-ticker.C:
		case <-ctx.Done():
			return
		case <-s.stop.Done():
			httpapi.Error(w, http.StatusServiceUnavailable, "shutting_down", "Service is shutting down")
			return
		}
	}
}

type agentWork func(context.Context, *controldb.Queries, strategy.Agent, *controldb.Command, int64) error

func (s *Service) withAgentCommand(r *http.Request, work agentWork) (controldb.Command, error) {
	ctx, authorization := r.Context(), r.Header.Get("Authorization")
	var cmd controldb.Command
	if _, err := strategy.Authorize(ctx, controldb.New(s.store.Read), authorization, strategy.CommandScope); err != nil {
		return cmd, err
	}
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		agent, err := strategy.Authorize(ctx, q, authorization, strategy.CommandScope)
		if err != nil {
			return err
		}
		cmd, err = q.GetCommand(ctx, chi.URLParam(r, "id"))
		if err != nil {
			return err
		}
		if cmd.StrategyID != agent.StrategyID {
			return sql.ErrNoRows
		}
		if cmd.InstanceID != agent.InstanceID || cmd.BootID != agent.BootID {
			return errExecutor
		}
		return work(ctx, q, agent, &cmd, time.Now().UnixMilli())
	})
	if err == nil {
		s.notify.Emit(cmd.StrategyID, realtime.Commands)
	}
	return cmd, err
}

func checkAgentTarget(ctx context.Context, q *controldb.Queries, agent strategy.Agent, cmd controldb.Command, now int64) (control.Definition, error) {
	if !agent.Executor || cmd.Deadline <= now {
		return control.Definition{}, errState
	}
	executor, definition, err := checkTarget(ctx, q, cmd)
	if err == nil && executor.Digest != agent.Digest {
		return definition, errExecutor
	}
	if err == nil {
		if validation := control.ValidateIntent(ctx, q, cmd.StrategyID, definition, json.RawMessage(cmd.Input), time.UnixMilli(now), cmd.ID); validation != nil {
			err = errUnavailable
		}
	}
	return definition, err
}

func (s *Service) claim(w http.ResponseWriter, r *http.Request) {
	permit := randomID()
	var dispatch string
	cmd, err := s.withAgentCommand(r, func(ctx context.Context, q *controldb.Queries, agent strategy.Agent, cmd *controldb.Command, now int64) error {
		if cmd.Status != pending && (cmd.Status != accepted || cmd.AcceptedBy.String != agent.Digest) {
			return errState
		}
		definition, err := checkAgentTarget(ctx, q, agent, *cmd, now)
		if err != nil {
			return err
		}
		dispatch = definition.ID
		if definition.Capability != nil {
			dispatch = definition.Capability.Dispatch()
		}
		if cmd.Status == pending {
			cmd.AcceptedBy = sql.NullString{String: agent.Digest, Valid: true}
			if err := transition(ctx, q, cmd, accepted, "agent:"+agent.InstanceID, "executor accepted", now); err != nil {
				return err
			}
		}
		if err := q.InsertExecutionPermit(ctx, controldb.InsertExecutionPermitParams{
			CommandID: cmd.ID, Digest: auth.Digest(permit), IssuedAt: now,
		}); err != nil {
			return err
		}
		cmd.Deadline = now + cmd.TimeoutMs
		return transition(ctx, q, cmd, executing, "agent:"+agent.InstanceID, "one-time execution permit issued", now)
	})
	if err != nil {
		commandError(w, err)
		return
	}
	httpapi.JSON(w, http.StatusOK, struct {
		view
		Permit  string `json:"permit"`
		Command string `json:"command"`
	}{present(cmd), permit, dispatch})
}

func (s *Service) result(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Permit  string          `json:"permit"`
		Status  string          `json:"status"`
		Message string          `json:"message,omitempty"`
		Data    json.RawMessage `json:"data,omitempty"`
	}
	if !httpapi.ReadJSON(w, r, &input, 64<<10) {
		return
	}
	if len(input.Permit) != 32 || len(input.Message) > 1024 ||
		(input.Status != succeeded && input.Status != failed && input.Status != unknown) {
		commandError(w, invalid("Provide a permit and a valid execution outcome"))
		return
	}
	receipt, err := json.Marshal(struct {
		Status  string          `json:"status"`
		Message string          `json:"message,omitempty"`
		Data    json.RawMessage `json:"data,omitempty"`
		Source  string          `json:"source"`
	}{input.Status, input.Message, input.Data, "agent"})
	if err != nil {
		commandError(w, err)
		return
	}
	cmd, err := s.withAgentCommand(r, func(ctx context.Context, q *controldb.Queries, agent strategy.Agent, cmd *controldb.Command, now int64) error {
		expected, err := q.GetExecutionPermit(ctx, cmd.ID)
		if errors.Is(err, sql.ErrNoRows) || err == nil && subtle.ConstantTimeCompare([]byte(auth.Digest(input.Permit)), []byte(expected)) != 1 {
			return errState
		}
		if err != nil {
			return err
		}
		if cmd.Receipt.Valid && cmd.Receipt.String == string(receipt) {
			return nil
		}
		if !allowed(cmd.Status, input.Status) {
			return errState
		}
		if cmd.Status == executing && cmd.Deadline <= now && input.Status != unknown {
			if err := transition(ctx, q, cmd, unknown, "system", "execution deadline elapsed before receipt", now); err != nil {
				return err
			}
		}
		cmd.Receipt = sql.NullString{String: string(receipt), Valid: true}
		return transition(ctx, q, cmd, input.Status, "agent:"+agent.InstanceID, "execution receipt recorded", now)
	})
	if err != nil {
		commandError(w, err)
		return
	}
	httpapi.JSON(w, http.StatusOK, present(cmd))
}
