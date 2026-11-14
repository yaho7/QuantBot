package telemetry

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
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

const maxResourceItems = 2000
const maxResourceBytes = 4 << 20

type resourceItem struct {
	ObservedAt   *int64          `json:"observedAt,omitempty"`
	ID           string          `json:"id"`
	Value        json.RawMessage `json:"value"`
	Associations Associations    `json:"associations,omitempty"`
}

type resourceUpdate struct {
	Revision         int64           `json:"revision"`
	ResourceRevision *int64          `json:"resourceRevision"`
	Mode             string          `json:"mode"`
	ObservedAt       int64           `json:"observedAt"`
	Items            *[]resourceItem `json:"items,omitempty"`
	Upsert           *[]resourceItem `json:"upsert,omitempty"`
	Delete           *[]string       `json:"delete,omitempty"`
}

func (u resourceUpdate) entries() []resourceItem {
	if u.Items != nil {
		return *u.Items
	}
	if u.Upsert != nil {
		return *u.Upsert
	}
	return nil
}

func (u resourceUpdate) deletions() []string {
	if u.Delete != nil {
		return *u.Delete
	}
	return nil
}

func (u resourceUpdate) validate() bool {
	if u.Revision < 1 || u.ResourceRevision == nil || *u.ResourceRevision < 0 || u.ObservedAt <= 0 {
		return false
	}
	switch u.Mode {
	case "snapshot":
		return u.Items != nil && u.Upsert == nil && u.Delete == nil && len(*u.Items) <= maxRecords
	case "patch":
		total := len(u.entries()) + len(u.deletions())
		return u.Items == nil && total > 0 && total <= maxRecords
	default:
		return false
	}
}

type resourceError struct {
	status        int
	code, message string
}

func (e resourceError) Error() string { return e.message }

type resourceAck struct {
	ResourceRevision int64 `json:"resourceRevision"`
	Duplicate        bool  `json:"duplicate"`
}

func (s *Service) updateResource(w http.ResponseWriter, r *http.Request, agent strategy.Agent) {
	var input resourceUpdate
	if !httpapi.ReadJSON(w, r, &input, maxBody) {
		return
	}
	now := time.Now()
	key := r.Header.Get("Idempotency-Key")
	if !metricName.MatchString(key) || !input.validate() {
		httpapi.Error(w, 400, "invalid_resource_update", "Provide Idempotency-Key, both revisions, observation time and a valid snapshot or patch")
		return
	}
	for _, item := range input.entries() {
		if !metricName.MatchString(item.ID) || !item.Associations.Valid() || len(item.Value) == 0 {
			httpapi.Error(w, 400, "invalid_resource_item", "Resource items require a stable ID, value and valid associations")
			return
		}
	}
	raw, err := json.Marshal(input)
	if err != nil {
		writeError(w, err)
		return
	}
	changes, err := httpapi.CanonicalValue(raw)
	if err != nil {
		writeError(w, err)
		return
	}
	fingerprint := auth.Digest(string(changes))
	capabilityID := chi.URLParam(r, "type")
	ack := resourceAck{}
	ctx := r.Context()
	err = storage.WithTx(ctx, s.stores.Control.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		current, err := strategy.Authorize(ctx, q, r.Header.Get("Authorization"), strategy.ReportScope)
		if err != nil {
			return err
		}
		if !current.Executor || current.StrategyID != agent.StrategyID {
			return resourceError{403, "executor_required", "Designated executor required for resources"}
		}
		registry, err := q.GetControlRegistry(ctx, current.StrategyID)
		if errors.Is(err, sql.ErrNoRows) || err == nil && (registry.InstanceID != current.InstanceID || registry.BootID != current.BootID) {
			return resourceError{409, "registry_changed", "Use the current capability revision and executor boot"}
		}
		if err != nil {
			return err
		}
		row, err := q.GetControlDefinition(ctx, controldb.GetControlDefinitionParams{StrategyID: current.StrategyID, ControlID: capabilityID})
		var definition control.Definition
		if err == nil {
			err = json.Unmarshal([]byte(row.Definition), &definition)
		}
		if errors.Is(err, sql.ErrNoRows) || err == nil && (definition.Capability == nil || definition.Capability.Kind != "resource") {
			return resourceError{404, "resource_not_declared", "Declare the resource capability before writing"}
		}
		if err != nil {
			return err
		}
		ack, err = applyResource(ctx, tx, current, *definition.Capability, row.SinceRevision, registry.Revision, input, key, fingerprint, string(changes), now)
		return err
	})
	var invalid resourceError
	switch {
	case errors.As(err, &invalid):
		httpapi.Error(w, invalid.status, invalid.code, invalid.message)
	case err != nil:
		writeError(w, err)
	default:
		if !ack.Duplicate {
			s.notify.Emit(agent.StrategyID, realtime.Telemetry)
		}
		httpapi.JSON(w, 200, ack)
	}
}

func applyResource(ctx context.Context, tx *sql.Tx, agent strategy.Agent, capability control.Capability, since, registryRevision int64, input resourceUpdate, key, fingerprint, changes string, now time.Time) (resourceAck, error) {
	where := []any{agent.StrategyID, capability.ID, since}
	var current, lastObserved int64
	var savedDigest string
	var first resourceAck
	err := tx.QueryRowContext(ctx, `SELECT resource_revision, digest FROM resource_updates
		WHERE strategy_id=? AND capability_id=? AND since_revision=? AND request_id=?`, append(where, key)...).
		Scan(&first.ResourceRevision, &savedDigest)
	if err == nil {
		if savedDigest != fingerprint {
			return first, resourceError{409, "idempotency_conflict", "This resource request key was used for different content"}
		}
		first.Duplicate = true
		return first, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return first, err
	}
	if input.Revision != registryRevision {
		return first, resourceError{409, "registry_changed", "Use the current capability revision"}
	}
	oldest, newest := now.Add(-backfillWindow).UnixMilli(), now.Add(2*time.Minute).UnixMilli()
	if input.ObservedAt < oldest || input.ObservedAt > newest {
		return first, resourceError{422, "invalid_observation_time", "Resource observation timestamp is outside the ingestion window"}
	}
	receivedAt := now.UnixMilli()
	err = tx.QueryRowContext(ctx, `SELECT resource_revision, observed_at FROM resource_collections
		WHERE strategy_id=? AND capability_id=? AND since_revision=?`, where...).Scan(&current, &lastObserved)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return first, err
	}
	if *input.ResourceRevision != current {
		return first, resourceError{409, "resource_revision_conflict", fmt.Sprintf("Current resource revision is %d", current)}
	}
	if input.Mode == "patch" && current == 0 {
		return first, resourceError{409, "resource_snapshot_required", "Publish an initial snapshot before incremental updates"}
	}
	if input.ObservedAt < lastObserved {
		return first, resourceError{409, "stale_resource_update", "The update predates the current resource observation"}
	}
	seen := make(map[string]struct{})
	for _, id := range input.deletions() {
		if _, exists := seen[id]; exists || !metricName.MatchString(id) {
			return first, resourceError{400, "invalid_resource_item", "Invalid or repeated resource ID"}
		}
		seen[id] = struct{}{}
	}
	for _, item := range input.entries() {
		if _, exists := seen[item.ID]; exists {
			return first, resourceError{400, "invalid_resource_item", "Repeated or overlapping resource ID"}
		}
		if item.ObservedAt != nil && (*item.ObservedAt < oldest || *item.ObservedAt > newest) {
			return first, resourceError{422, "invalid_observation_time", "Resource item timestamp is outside the ingestion window"}
		}
		if err := capability.ValidateValue(item.Value, true); err != nil {
			return first, resourceError{422, "resource_value_invalid", err.Error()}
		}
		if capability.Renderer() == "candlestick" {
			var point seriesPoint
			if err := json.Unmarshal(item.Value, &point); err != nil || !validCandle(point.Open, point.High, point.Low, point.Close, point.Volume) {
				return first, resourceError{422, "resource_value_invalid", "Invalid candle range or volume"}
			}
		}
		seen[item.ID] = struct{}{}
	}
	next := current + 1
	_, err = tx.ExecContext(ctx, `INSERT INTO resource_collections VALUES(?,?,?,?,?,?)
		ON CONFLICT(strategy_id,capability_id,since_revision) DO UPDATE SET
		resource_revision=excluded.resource_revision,observed_at=excluded.observed_at,received_at=excluded.received_at`,
		append(where, next, input.ObservedAt, receivedAt)...)
	if err != nil {
		return first, err
	}
	if input.Mode == "snapshot" {
		if _, err := tx.ExecContext(ctx, `DELETE FROM resource_items WHERE strategy_id=? AND capability_id=? AND since_revision=?`, where...); err != nil {
			return first, err
		}
	}
	for _, id := range input.deletions() {
		if _, err := tx.ExecContext(ctx, `DELETE FROM resource_items WHERE strategy_id=? AND capability_id=? AND since_revision=? AND resource_id=?`, append(where, id)...); err != nil {
			return first, err
		}
	}
	for _, item := range input.entries() {
		links, err := json.Marshal(item.Associations)
		if err != nil {
			return first, err
		}
		at := input.ObservedAt
		if item.ObservedAt != nil {
			at = *item.ObservedAt
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO resource_items VALUES(?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(strategy_id,capability_id,since_revision,resource_id) DO UPDATE SET
			revision=excluded.revision,observed_at=excluded.observed_at,received_at=excluded.received_at,
			instance_id=excluded.instance_id,boot_id=excluded.boot_id,value=excluded.value,links=excluded.links`,
			append(where, item.ID, input.Revision, at, receivedAt, agent.InstanceID, agent.BootID, string(item.Value), string(links))...)
		if err != nil {
			return first, err
		}
	}
	var count, size int
	if err := tx.QueryRowContext(ctx, `SELECT count(*), coalesce(sum(length(CAST(value AS BLOB))+length(links)),0) FROM resource_items
		WHERE strategy_id=? AND capability_id=? AND since_revision=?`, where...).Scan(&count, &size); err != nil {
		return first, err
	}
	if count > maxResourceItems || size > maxResourceBytes {
		return first, resourceError{413, "resource_capacity", "Resource collection exceeds its item or byte limit"}
	}
	var history any
	if capability.History {
		history = changes
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO resource_updates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		append(where, next, input.Revision, key, fingerprint, input.ObservedAt, receivedAt, agent.InstanceID, agent.BootID, input.Mode, history)...); err != nil {
		return first, err
	}
	return resourceAck{ResourceRevision: next}, nil
}

type resourceView struct {
	CapabilityID     string         `json:"capabilityId"`
	Revision         int64          `json:"revision"`
	ResourceRevision int64          `json:"resourceRevision"`
	ObservedAt       int64          `json:"observedAt"`
	Items            []declaredView `json:"items"`
}

func (s *Service) resourceCurrent(w http.ResponseWriter, r *http.Request) {
	strategyID, capabilityID := chi.URLParam(r, "id"), chi.URLParam(r, "capability")
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	view := resourceView{CapabilityID: capabilityID, Items: []declaredView{}}
	err := storage.WithTx(ctx, s.stores.Control.Read, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		registry, err := q.GetControlRegistry(ctx, strategyID)
		if err != nil {
			return err
		}
		view.Revision = registry.Revision
		row, err := q.GetControlDefinition(ctx, controldb.GetControlDefinitionParams{StrategyID: strategyID, ControlID: capabilityID})
		if err != nil {
			return err
		}
		var definition control.Definition
		if err := json.Unmarshal([]byte(row.Definition), &definition); err != nil {
			return err
		}
		if definition.Capability == nil || definition.Capability.Kind != "resource" {
			return sql.ErrNoRows
		}
		args := []any{strategyID, capabilityID, row.SinceRevision}
		err = tx.QueryRowContext(ctx, `SELECT resource_revision, observed_at FROM resource_collections
			WHERE strategy_id=? AND capability_id=? AND since_revision=?`, args...).Scan(&view.ResourceRevision, &view.ObservedAt)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT resource_id,revision,observed_at,received_at,instance_id,boot_id,value,links
			FROM resource_items WHERE strategy_id=? AND capability_id=? AND since_revision=? ORDER BY resource_id`, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			item := declaredView{declaredRecord: declaredRecord{CapabilityID: capabilityID}}
			var value, links string
			if err := rows.Scan(&item.ID, &item.Revision, &item.ObservedAt, &item.ReceivedAt, &item.InstanceID, &item.BootID, &value, &links); err != nil {
				return err
			}
			item.Value = json.RawMessage(value)
			if err := json.Unmarshal([]byte(links), &item.Associations); err != nil {
				return err
			}
			view.Items = append(view.Items, item)
		}
		return rows.Err()
	})
	if err != nil {
		writeError(w, err)
		return
	}
	httpapi.JSON(w, 200, view)
}

type resourceReplay struct {
	ResourceRevision int64           `json:"resourceRevision"`
	SinceRevision    int64           `json:"sinceRevision"`
	Revision         int64           `json:"revision"`
	RequestID        string          `json:"requestId"`
	Mode             string          `json:"mode"`
	ObservedAt       int64           `json:"observedAt"`
	ReceivedAt       int64           `json:"receivedAt"`
	InstanceID       string          `json:"instanceId"`
	BootID           string          `json:"bootId"`
	Changes          json.RawMessage `json:"changes"`
}

func (s *Service) resourceHistory(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	limit := 100
	if raw := query.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 250 {
			httpapi.Error(w, 400, "invalid_history", "Limit must be 1–250")
			return
		}
		limit = n
	}
	beforeRevision, beforeResource := int64(1<<63-1), int64(1<<63-1)
	if query.Has("beforeRevision") || query.Has("beforeResourceRevision") {
		var err1, err2 error
		beforeRevision, err1 = strconv.ParseInt(query.Get("beforeRevision"), 10, 64)
		beforeResource, err2 = strconv.ParseInt(query.Get("beforeResourceRevision"), 10, 64)
		if err1 != nil || err2 != nil || beforeRevision < 1 || beforeResource < 1 {
			httpapi.Error(w, 400, "invalid_history", "Provide both replay cursors")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	strategyID, capabilityID := chi.URLParam(r, "id"), chi.URLParam(r, "capability")
	if _, err := controldb.New(s.stores.Control.Read).GetStrategy(ctx, strategyID); err != nil {
		writeError(w, err)
		return
	}
	rows, err := s.stores.Control.Read.QueryContext(ctx, `SELECT resource_revision,since_revision,revision,request_id,mode,
		observed_at,received_at,instance_id,boot_id,changes FROM resource_updates
		WHERE strategy_id=? AND capability_id=? AND (revision,resource_revision)<(?,?) AND changes IS NOT NULL
		ORDER BY revision DESC,resource_revision DESC LIMIT ?`,
		strategyID, capabilityID, beforeRevision, beforeResource, limit)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()
	items := []resourceReplay{}
	for rows.Next() {
		var item resourceReplay
		var changes string
		if err := rows.Scan(&item.ResourceRevision, &item.SinceRevision, &item.Revision, &item.RequestID, &item.Mode,
			&item.ObservedAt, &item.ReceivedAt, &item.InstanceID, &item.BootID, &changes); err != nil {
			writeError(w, err)
			return
		}
		item.Changes = json.RawMessage(changes)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	httpapi.JSON(w, 200, items)
}
