package control

import (
	"context"

	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

type catalogEntry struct {
	Capability
	Renderer string       `json:"renderer"`
	Actual   *actualState `json:"actual,omitempty"`
	Stale    bool         `json:"stale"`
}

func (s *Service) browserCapabilities(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), chi.URLParam(r, "id")
	var revision int64
	var health []string
	var healthy bool
	items := make([]catalogEntry, 0)
	err := storage.WithTx(ctx, s.store.Read, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		if _, err := q.GetStrategy(ctx, id); err != nil {
			return err
		}
		registry, err := q.GetControlRegistry(ctx, id)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		revision = registry.Revision
		owner, err := q.GetAgentInstance(ctx, controldb.GetAgentInstanceParams{StrategyID: id, InstanceID: registry.InstanceID})
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		now := time.Now()
		healthy = owner.BootID == registry.BootID && owner.LastSeen > now.Add(-strategy.PresenceTTL).Unix()
		rows, err := q.ListControlDefinitions(ctx, id)
		if err != nil {
			return err
		}
		states, err := q.ListControlStates(ctx, id)
		if err != nil {
			return err
		}
		latest := make(map[string]actualState, len(states))
		for _, state := range states {
			ok := state.Available == 1
			latest[state.ControlID] = actualState{ID: state.ControlID, Value: json.RawMessage(state.Value), Available: &ok, Reason: state.Reason, ObservedAt: state.ObservedAt}
		}
		for _, row := range rows {
			var definition Definition
			if err := json.Unmarshal([]byte(row.Definition), &definition); err != nil {
				return err
			}
			c := definition.Capability
			if c == nil {
				continue
			}
			entry := catalogEntry{Capability: *c, Renderer: c.Renderer()}
			if state, ok := latest[c.ID]; ok {
				entry.Actual = &state
				entry.Stale = c.Expired(state.ObservedAt, now) || owner.BootID != registry.BootID
			}
			if c.Kind == "state" && c.Group == "health" {
				if entry.Actual == nil || entry.Stale || !*entry.Actual.Available ||
					(c.ValueType == "boolean" && string(entry.Actual.Value) == "false") {
					health = append(health, c.ID)
				}
			}
			items = append(items, entry)
		}
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	slices.SortStableFunc(items, func(a, b catalogEntry) int { return a.Presentation.Order - b.Presentation.Order })
	status := "healthy"
	if !healthy {
		status = "offline"
	} else if len(health) > 0 {
		status = "degraded"
	}
	if health == nil {
		health = []string{}
	}
	httpapi.JSON(w, http.StatusOK, map[string]any{"revision": revision, "capabilities": items, "health": map[string]any{"status": status, "issues": health}})
}

// ValidateIntent checks the declared input and all members of an atomic batch.
func ValidateIntent(ctx context.Context, q *controldb.Queries, strategyID string, definition Definition, input json.RawMessage, now time.Time, commandID string) error {
	if err := definition.ValidateValue(input, false); err != nil {
		return err
	}
	c := definition.Capability
	if c == nil {
		return nil
	}
	if c.Kind == "parameter" && c.Command != "" && c.Command != c.ID {
		action, err := LoadDefinition(ctx, q, strategyID, c.Command)
		if err != nil {
			return err
		}
		if err := checkAvailability(ctx, q, strategyID, action, now); err != nil {
			return err
		}
		if action.Capability != nil && action.Capability.InputSchema != nil {
			return action.ValidateValue(input, false)
		}
	}
	active, err := q.CountConflictingPlanCommands(ctx, controldb.CountConflictingPlanCommandsParams{
		StrategyID: strategyID, CommandID: commandID, IsPlan: len(c.AtomicBatch) != 0,
	})
	if err != nil {
		return err
	}
	if active > 0 {
		return errors.New("an unresolved command conflicts with the atomic parameter plan")
	}
	if len(c.AtomicBatch) == 0 {
		return nil
	}
	var values map[string]json.RawMessage
	if err := httpapi.Decode(input, &values); err != nil || len(values) != len(c.AtomicBatch) {
		return errors.New("atomic plan requires exactly the declared parameter values")
	}
	for _, id := range c.AtomicBatch {
		member, err := LoadDefinition(ctx, q, strategyID, id)
		if err != nil {
			return err
		}
		if err := checkAvailability(ctx, q, strategyID, member, now); err != nil {
			return err
		}
		if err := member.ValidateValue(values[id], false); err != nil {
			return err
		}

	}
	return nil
}

func checkAvailability(ctx context.Context, q *controldb.Queries, strategyID string, c Definition, now time.Time) error {
	state, err := q.GetControlState(ctx, controldb.GetControlStateParams{StrategyID: strategyID, ControlID: c.ID})
	if err != nil {
		return err
	}
	if c.IsReadOnly() || c.Disabled || state.Available != 1 || c.Capability != nil && c.Capability.Expired(state.ObservedAt, now) {
		return errors.New("command target is unavailable or expired")
	}
	return nil
}
