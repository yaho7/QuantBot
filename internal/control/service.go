package control

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

type Service struct {
	store storage.Database
}

func New(store storage.Database) *Service {
	return &Service{store: store}
}

func (s *Service) RegisterAgent(r chi.Router) {
	r.Get("/controls", s.agentRegistry)
	r.Put("/controls", s.register)
	r.Put("/controls/state", s.state)
}

func (s *Service) RegisterBrowser(r chi.Router) {
	r.Get("/strategies/{id}/controls", s.list)
}

type invalidInput string

func (message invalidInput) Error() string { return string(message) }

var (
	ErrRegistryChanged  = errors.New("control registry changed")
	ErrExecutorRequired = errors.New("designated executor required")
)

func (s *Service) register(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Version      int           `json:"version"`
		BaseRevision int64         `json:"baseRevision"`
		Controls     *[]Definition `json:"controls"`
	}
	if !httpapi.ReadJSON(w, r, &input, 256<<10) {
		return
	}
	if input.Version != 1 || input.BaseRevision < 0 || input.Controls == nil || len(*input.Controls) > 128 {
		fail(w, invalidInput("Provide version 1, a nonnegative base revision, and at most 128 controls"))
		return
	}
	definitions := make(map[string]string, len(*input.Controls))
	for _, definition := range *input.Controls {
		if _, exists := definitions[definition.ID]; exists {
			fail(w, invalidInput("Duplicate control ID"))
			return
		}
		if err := definition.Validate(); err != nil {
			fail(w, invalidInput(fmt.Sprintf("Control %q: %v", definition.ID, err)))
			return
		}
		body, err := json.Marshal(definition)
		if err != nil {
			fail(w, err)
			return
		}
		definitions[definition.ID] = string(body)
	}
	var revision int64
	err := s.agentTransaction(r, func(ctx context.Context, q *controldb.Queries, agent strategy.Agent) error {
		registry, err := q.GetControlRegistry(ctx, agent.StrategyID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		revision = registry.Revision
		if registry.Revision > 0 && registry.InstanceID == agent.InstanceID && registry.BootID == agent.BootID {
			equal, err := identicalRegistry(ctx, q, agent.StrategyID, definitions)
			if err != nil || equal && (input.BaseRevision == revision || input.BaseRevision == revision-1) {
				return err
			}
		}
		if revision != input.BaseRevision {
			return ErrRegistryChanged
		}
		revision++
		if err := q.PutControlRegistry(ctx, controldb.PutControlRegistryParams{
			StrategyID: agent.StrategyID, Revision: revision,
			InstanceID: agent.InstanceID, BootID: agent.BootID, UpdatedAt: time.Now().UnixMilli(),
		}); err != nil {
			return err
		}
		if err := q.DeleteControlDefinitions(ctx, agent.StrategyID); err != nil {
			return err
		}
		for id, definition := range definitions {
			if err := q.InsertControlDefinition(ctx, controldb.InsertControlDefinitionParams{
				StrategyID: agent.StrategyID, ControlID: id, Definition: definition,
			}); err != nil {
				return err
			}
		}
		details := fmt.Sprintf(`{"revision":%d,"count":%d}`, revision, len(definitions))
		return q.AppendAudit(ctx, controldb.AppendAuditParams{
			At: time.Now().UnixMilli(), Actor: "agent:" + agent.InstanceID, Action: "control.registry_changed",
			StrategyID: sql.NullString{String: agent.StrategyID, Valid: true}, Details: details,
		})
	})
	if err != nil {
		fail(w, err)
		return
	}
	httpapi.JSON(w, http.StatusOK, map[string]int64{"revision": revision})
}

func identicalRegistry(ctx context.Context, q *controldb.Queries, strategyID string, definitions map[string]string) (bool, error) {
	saved, err := q.ListControlDefinitions(ctx, strategyID)
	if err != nil || len(saved) != len(definitions) {
		return false, err
	}
	for _, item := range saved {
		if definitions[item.ControlID] != item.Definition {
			return false, nil
		}
	}
	return true, nil
}

type actualState struct {
	ID         string          `json:"id"`
	Value      json.RawMessage `json:"value"`
	Available  *bool           `json:"available"`
	Reason     string          `json:"reason,omitempty"`
	ObservedAt int64           `json:"observedAt"`
}

func (s *Service) state(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Version  int           `json:"version"`
		Revision int64         `json:"revision"`
		States   []actualState `json:"states"`
	}
	if !httpapi.ReadJSON(w, r, &input, 256<<10) {
		return
	}
	if input.Version != 1 || input.Revision <= 0 || len(input.States) == 0 || len(input.States) > 128 {
		fail(w, invalidInput("Provide version 1, a registry revision and 1–128 states"))
		return
	}
	now := time.Now()
	seen := make(map[string]bool, len(input.States))
	for _, state := range input.States {
		if !controlID.MatchString(state.ID) || seen[state.ID] || state.Available == nil || len(state.Reason) > 512 ||
			state.ObservedAt <= 0 || state.ObservedAt > now.Add(2*time.Minute).UnixMilli() {
			fail(w, invalidInput("Invalid or duplicate control state"))
			return
		}
		seen[state.ID] = true
	}
	var updated, duplicate, stale int
	err := s.agentTransaction(r, func(ctx context.Context, q *controldb.Queries, agent strategy.Agent) error {
		registry, err := q.GetControlRegistry(ctx, agent.StrategyID)
		if errors.Is(err, sql.ErrNoRows) || err == nil && (registry.Revision != input.Revision ||
			registry.InstanceID != agent.InstanceID || registry.BootID != agent.BootID) {
			return ErrRegistryChanged
		}
		if err != nil {
			return err
		}
		for _, state := range input.States {
			definition, err := LoadDefinition(ctx, q, agent.StrategyID, state.ID)
			if err != nil {
				return err
			}
			if err := definition.ValidateValue(state.Value, true); err != nil {
				return invalidInput(fmt.Sprintf("Control %q: %v", state.ID, err))
			}
			previous, err := q.GetControlState(ctx, controldb.GetControlStateParams{StrategyID: agent.StrategyID, ControlID: state.ID})
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			value, err := json.Marshal(state.Value)
			if err != nil {
				return err
			}
			var available int64
			if *state.Available {
				available = 1
			}
			switch {
			case previous.ObservedAt > state.ObservedAt:
				stale++
			case previous.ObservedAt == state.ObservedAt:
				if previous.Value != string(value) || previous.Available != available || previous.Reason != state.Reason {
					return invalidInput("State timestamp was reused with different data")
				}
				duplicate++
			default:
				if err := q.PutControlState(ctx, controldb.PutControlStateParams{
					StrategyID: agent.StrategyID, ControlID: state.ID, Value: string(value),
					Available: available, Reason: state.Reason, ObservedAt: state.ObservedAt,
				}); err != nil {
					return err
				}
				updated++
			}
		}
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	httpapi.JSON(w, http.StatusOK, map[string]int{"updated": updated, "duplicate": duplicate, "stale": stale})
}

func LoadDefinition(ctx context.Context, q *controldb.Queries, strategyID, id string) (Definition, error) {
	record, err := q.GetControlDefinition(ctx, controldb.GetControlDefinitionParams{StrategyID: strategyID, ControlID: id})
	var definition Definition
	if err == nil {
		err = json.Unmarshal([]byte(record.Definition), &definition)
	}
	return definition, err
}

func (s *Service) agentTransaction(r *http.Request, work func(context.Context, *controldb.Queries, strategy.Agent) error) error {
	ctx, authorization := r.Context(), r.Header.Get("Authorization")
	if _, err := strategy.Authorize(ctx, controldb.New(s.store.Read), authorization, strategy.ControlScope); err != nil {
		return err
	}
	return storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		agent, err := strategy.Authorize(ctx, q, authorization, strategy.ControlScope)
		if err != nil {
			return err
		}
		if !agent.Executor {
			return ErrExecutorRequired
		}
		return work(ctx, q, agent)
	})
}

type registryView struct {
	Revision int64         `json:"revision"`
	Current  bool          `json:"current"`
	Controls []controlView `json:"controls"`
}

type desiredState struct {
	CommandID string          `json:"commandId"`
	Status    string          `json:"status"`
	Value     json.RawMessage `json:"value"`
	UpdatedAt int64           `json:"updatedAt"`
}

type controlView struct {
	Definition
	Actual  *actualState  `json:"actual"`
	Desired *desiredState `json:"desired"`
}

func (s *Service) list(w http.ResponseWriter, r *http.Request) {
	s.writeRegistry(w, r.Context(), chi.URLParam(r, "id"))
}

func (s *Service) agentRegistry(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	agent, err := strategy.Authorize(ctx, controldb.New(s.store.Read), r.Header.Get("Authorization"), strategy.ControlScope)
	if err != nil {
		fail(w, err)
		return
	}
	s.writeRegistry(w, ctx, agent.StrategyID)
}

func (s *Service) writeRegistry(w http.ResponseWriter, ctx context.Context, id string) {
	view := registryView{Controls: []controlView{}}
	err := storage.WithTx(ctx, s.store.Read, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		_, err := q.GetStrategy(ctx, id)
		if err != nil {
			return err
		}
		registry, err := q.GetControlRegistry(ctx, id)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		view.Revision = registry.Revision
		executor, err := strategy.ActiveExecutor(ctx, q, id, strategy.CommandScope)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		view.Current = err == nil && executor.InstanceID == registry.InstanceID && executor.BootID == registry.BootID
		definitions, err := q.ListControlDefinitions(ctx, id)
		if err != nil {
			return err
		}
		states, err := q.ListControlStates(ctx, id)
		if err != nil {
			return err
		}
		actual := make(map[string]*actualState, len(states))
		for _, row := range states {
			available := row.Available == 1
			actual[row.ControlID] = &actualState{
				ID: row.ControlID, Value: json.RawMessage(row.Value), Available: &available, Reason: row.Reason, ObservedAt: row.ObservedAt,
			}
		}
		desiredRows, err := q.ListDesiredStates(ctx, controldb.ListDesiredStatesParams{StrategyID: id, Revision: registry.Revision})
		if err != nil {
			return err
		}
		desired := make(map[string]*desiredState, len(desiredRows))
		for _, row := range desiredRows {
			desired[row.ControlID] = &desiredState{row.CommandID, row.Status, json.RawMessage(row.Value), row.UpdatedAt}
		}
		for _, row := range definitions {
			var definition Definition
			if err := json.Unmarshal([]byte(row.Definition), &definition); err != nil {
				return err
			}
			view.Controls = append(view.Controls, controlView{definition, actual[row.ControlID], desired[row.ControlID]})
		}
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	httpapi.JSON(w, http.StatusOK, view)
}

func fail(w http.ResponseWriter, err error) {
	var invalid invalidInput
	switch {
	case errors.As(err, &invalid):
		httpapi.Error(w, http.StatusBadRequest, "invalid_control", err.Error())
	case errors.Is(err, ErrRegistryChanged):
		httpapi.Error(w, http.StatusConflict, "registry_changed", err.Error())
	case errors.Is(err, ErrExecutorRequired):
		httpapi.Error(w, http.StatusForbidden, "executor_required", err.Error())
	case errors.Is(err, strategy.ErrUnauthorized):
		httpapi.Error(w, http.StatusUnauthorized, "invalid_agent", err.Error())
	case errors.Is(err, sql.ErrNoRows):
		httpapi.Error(w, http.StatusNotFound, "not_found", "Control or strategy not found")
	default:
		slog.Error("control storage", "error", err)
		httpapi.Error(w, http.StatusServiceUnavailable, "storage_unavailable", "Control storage unavailable")
	}
}
