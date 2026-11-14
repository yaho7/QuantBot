package command

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

func (s *Service) create(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ControlID string          `json:"controlId"`
		Revision  int64           `json:"revision"`
		Input     json.RawMessage `json:"input"`
	}
	if !httpapi.ReadJSON(w, r, &input, 64<<10) {
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if !requestID.MatchString(key) || !requestID.MatchString(input.ControlID) || input.Revision < 1 || len(input.Input) == 0 {
		commandError(w, invalid("Idempotency-Key, controlId, revision and input are required"))
		return
	}
	body, err := json.Marshal(input.Input)
	if err != nil {
		commandError(w, err)
		return
	}
	ctx := r.Context()
	actor, strategyID := auth.Current(r).Username, chi.URLParam(r, "id")
	var cmd controldb.Command
	response := http.StatusOK
	err = storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		cmd, err = q.GetCommandByKey(ctx, controldb.GetCommandByKeyParams{
			Actor: actor, StrategyID: strategyID, RequestKey: key,
		})
		if err == nil {
			if cmd.ControlID != input.ControlID || cmd.Revision != input.Revision || cmd.Input != string(body) {
				return errIdempotency
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		cmd = controldb.Command{
			ID: randomID(), Actor: actor, StrategyID: strategyID, ControlID: input.ControlID, Revision: input.Revision,
			Input: string(body), RequestKey: key,
		}
		executor, definition, err := checkTarget(ctx, q, cmd)
		if err != nil {
			return err
		}
		if err := definition.ValidateValue(input.Input, false); err != nil {
			return invalid(err.Error())
		}
		if _, err := q.GetActiveControlCommand(ctx, controldb.GetActiveControlCommandParams{StrategyID: strategyID, ControlID: input.ControlID}); err == nil {
			return errActive
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		account, err := q.GetStrategy(ctx, strategyID)
		if err != nil {
			return err
		}
		now := time.Now()
		cmd.InstanceID, cmd.BootID = executor.InstanceID, executor.BootID
		cmd.CreatedAt, cmd.UpdatedAt, cmd.Deadline = now.UnixMilli(), now.UnixMilli(), now.Add(queueTTL).UnixMilli()
		cmd.TimeoutMs = int64(definition.TimeoutSeconds) * 1000
		if cmd.TimeoutMs == 0 {
			cmd.TimeoutMs = 30000
		}
		if err := q.InsertCommand(ctx, controldb.InsertCommandParams{
			ID: cmd.ID, StrategyID: strategyID, ControlID: cmd.ControlID, Revision: cmd.Revision, Input: cmd.Input,
			Actor: actor, RequestKey: key, InstanceID: cmd.InstanceID, BootID: cmd.BootID,
			CreatedAt: cmd.CreatedAt, UpdatedAt: cmd.UpdatedAt, Deadline: cmd.Deadline, TimeoutMs: cmd.TimeoutMs,
		}); err != nil {
			return err
		}
		if err := record(ctx, q, cmd, created, actor, "control requested", cmd.CreatedAt); err != nil {
			return err
		}
		cmd.Status = created
		response = http.StatusCreated
		if definition.RequiresConfirmation() || account.Mode == "live" {
			return transition(ctx, q, &cmd, confirmation, actor, "confirmation required by policy", cmd.CreatedAt)
		}
		return enqueue(ctx, q, &cmd, actor, cmd.CreatedAt)
	})
	if err != nil {
		commandError(w, err)
		return
	}
	httpapi.JSON(w, response, present(cmd))
}

func enqueue(ctx context.Context, q *controldb.Queries, cmd *controldb.Command, actor string, now int64) error {
	if err := transition(ctx, q, cmd, pending, actor, "authorized and queued", now); err != nil {
		return err
	}
	return q.PutDesiredState(ctx, controldb.PutDesiredStateParams{
		StrategyID: cmd.StrategyID, ControlID: cmd.ControlID, CommandID: cmd.ID, Revision: cmd.Revision, Value: cmd.Input,
	})
}

func (s *Service) browserAction(w http.ResponseWriter, r *http.Request) {
	action := chi.URLParam(r, "action")
	var input struct {
		Status string `json:"status"`
		Note   string `json:"note"`
	}
	if action == "reconcile" {
		if !httpapi.ReadJSON(w, r, &input, 4096) {
			return
		}
		if (input.Status != succeeded && input.Status != failed) || len(input.Note) == 0 || len(input.Note) > 1024 {
			commandError(w, invalid("Reconciliation needs a verified outcome and explanation"))
			return
		}
	}
	ctx, actor := r.Context(), auth.Current(r).Username
	var cmd controldb.Command
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		var err error
		cmd, err = q.GetCommand(ctx, chi.URLParam(r, "id"))
		if err != nil {
			return err
		}
		now := time.Now().UnixMilli()
		switch action {
		case "confirm":
			if cmd.Actor != actor {
				return errState
			}
			if cmd.Status != confirmation {
				steps, err := q.ListCommandTransitions(ctx, cmd.ID)
				if err != nil {
					return err
				}
				for _, step := range steps {
					if step.Previous.String == confirmation && step.Next == pending {
						return nil
					}
				}
				return errState
			}
			if cmd.Deadline <= now {
				return errState
			}
			if _, _, err := checkTarget(ctx, q, cmd); err != nil {
				return err
			}
			cmd.Deadline = time.Now().Add(queueTTL).UnixMilli()
			return enqueue(ctx, q, &cmd, actor, now)
		case "cancel":
			if cmd.Status == cancelled {
				return nil
			}
			return transition(ctx, q, &cmd, cancelled, actor, "operator cancelled", now)
		case "reconcile":
			receipt, err := json.Marshal(map[string]string{"status": input.Status, "message": input.Note, "source": "operator"})
			if err != nil {
				return err
			}
			if cmd.Receipt.Valid && cmd.Receipt.String == string(receipt) {
				return nil
			}
			if cmd.Status != unknown {
				return errState
			}
			cmd.Receipt = sql.NullString{String: string(receipt), Valid: true}
			return transition(ctx, q, &cmd, input.Status, actor, input.Note, now)
		default:
			return sql.ErrNoRows
		}
	})
	if err != nil {
		commandError(w, err)
		return
	}
	httpapi.JSON(w, http.StatusOK, present(cmd))
}

func (s *Service) detail(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), chi.URLParam(r, "id")
	q := controldb.New(s.store.Read)
	cmd, err := q.GetCommand(ctx, id)
	if err != nil {
		commandError(w, err)
		return
	}
	history, err := q.ListCommandTransitions(ctx, id)
	if err != nil {
		commandError(w, err)
		return
	}
	type step struct {
		Status string `json:"status"`
		Actor  string `json:"actor"`
		Reason string `json:"reason"`
		At     int64  `json:"at"`
	}
	steps := make([]step, 0, len(history))
	for _, item := range history {
		steps = append(steps, step{item.Next, item.Actor, item.Reason, item.At})
	}
	httpapi.JSON(w, http.StatusOK, struct {
		view
		Transitions []step `json:"transitions"`
	}{present(cmd), steps})
}

func (s *Service) list(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	beforeAt := int64(math.MaxInt64)
	if value := query.Get("beforeAt"); value != "" {
		var err error
		beforeAt, err = strconv.ParseInt(value, 10, 64)
		if err != nil || beforeAt < 1 || !requestID.MatchString(query.Get("beforeId")) {
			commandError(w, invalid("Invalid command history cursor"))
			return
		}
	}
	rows, err := controldb.New(s.store.Read).ListCommands(r.Context(), controldb.ListCommandsParams{
		StrategyID: query.Get("strategyId"), Status: query.Get("status"), BeforeAt: beforeAt, BeforeID: query.Get("beforeId"), PageSize: 100,
	})
	if err != nil {
		commandError(w, err)
		return
	}
	items := make([]view, 0, len(rows))
	for _, row := range rows {
		items = append(items, present(row))
	}
	httpapi.JSON(w, http.StatusOK, items)
}

func (s *Service) audit(w http.ResponseWriter, r *http.Request) {
	before := int64(math.MaxInt64)
	if value := r.URL.Query().Get("before"); value != "" {
		var err error
		before, err = strconv.ParseInt(value, 10, 64)
		if err != nil || before < 1 {
			commandError(w, invalid("Invalid audit cursor"))
			return
		}
	}
	rows, err := controldb.New(s.store.Read).ListAudit(r.Context(), before)
	if err != nil {
		commandError(w, err)
		return
	}
	type entry struct {
		ID         int64           `json:"id"`
		At         int64           `json:"at"`
		Actor      string          `json:"actor"`
		Action     string          `json:"action"`
		StrategyID string          `json:"strategyId,omitempty"`
		CommandID  string          `json:"commandId,omitempty"`
		Details    json.RawMessage `json:"details"`
	}
	items := make([]entry, 0, len(rows))
	for _, row := range rows {
		items = append(items, entry{row.ID, row.At, row.Actor, row.Action, row.StrategyID.String, row.CommandID.String, json.RawMessage(row.Details)})
	}
	httpapi.JSON(w, http.StatusOK, items)
}
