package telemetry

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/control"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/storage/metricsdb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

type Associations struct {
	AccountID     string `json:"account_id,omitempty"`
	Symbol        string `json:"symbol,omitempty"`
	SignalID      string `json:"signal_id,omitempty"`
	DecisionID    string `json:"decision_id,omitempty"`
	OrderID       string `json:"order_id,omitempty"`
	CommandID     string `json:"command_id,omitempty"`
	CorrelationID string `json:"correlation_id,omitempty"`
}

func (a Associations) Valid() bool {
	for _, id := range [...]string{a.AccountID, a.Symbol, a.SignalID, a.DecisionID, a.OrderID, a.CommandID, a.CorrelationID} {
		if id != "" && !metricName.MatchString(id) {
			return false
		}
	}
	return true
}

type declaredRecord struct {
	ID           string          `json:"id"`
	CapabilityID string          `json:"capabilityId,omitempty"`
	ObservedAt   int64           `json:"observedAt"`
	Value        json.RawMessage `json:"value"`
	Associations Associations    `json:"associations,omitempty"`
}

type declaredWrite struct {
	record     declaredRecord
	revision   int64
	receivedAt int64
	history    bool
	kind       string
	index      int
}

func (s *Service) declared(w http.ResponseWriter, r *http.Request, agent strategy.Agent, revision int64, records []json.RawMessage, kind, resource string) {
	ctx := r.Context()
	now := time.Now()
	q := controldb.New(s.stores.Control.Read)
	registry, err := q.GetControlRegistry(ctx, agent.StrategyID)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (registry.Revision != revision ||
		registry.InstanceID != agent.InstanceID || registry.BootID != agent.BootID) {
		httpapi.Error(w, http.StatusConflict, "registry_changed", "Republish capabilities for the current process and revision")
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	// Use a single consistent registry read. Ingestion is fenced by revision;
	// a concurrent registry update cannot expose an old revision as current.
	definitions, err := q.ListControlDefinitions(ctx, agent.StrategyID)
	if err != nil {
		writeError(w, err)
		return
	}
	latest, err := q.GetControlRegistry(ctx, agent.StrategyID)
	if err != nil {
		writeError(w, err)
		return
	}
	if latest != registry {
		httpapi.Error(w, http.StatusConflict, "registry_changed", "Capability registry changed during validation")
		return
	}
	capabilities := make(map[string]control.Capability, len(definitions))
	for _, row := range definitions {
		var d control.Definition
		if err := json.Unmarshal([]byte(row.Definition), &d); err != nil {
			writeError(w, err)
			return
		}
		if d.Capability != nil {
			capabilities[row.ControlID] = *d.Capability
		}
	}
	writes := make([]declaredWrite, 0, len(records))
	var ack Ack
	for i, raw := range records {
		var record declaredRecord
		if err := httpapi.Decode(raw, &record); err != nil {
			ack.add(i, err.Error())
			continue
		}
		if resource != "" {
			if record.CapabilityID != "" && record.CapabilityID != resource {
				ack.add(i, "resource capability ID must match the URL")
				continue
			}
			record.CapabilityID = resource
		}
		capability, exists := capabilities[record.CapabilityID]
		if !exists || !matchesRecordKind(capability, kind) {
			ack.add(i, "record does not match a declared capability for this endpoint")
			continue
		}
		if !metricName.MatchString(record.ID) || !record.Associations.Valid() ||
			record.ObservedAt < now.Add(-backfillWindow).UnixMilli() || record.ObservedAt > now.Add(2*time.Minute).UnixMilli() {
			ack.add(i, "invalid record ID, association or observation timestamp")
			continue
		}
		if err := capability.ValidateValue(record.Value, true); err != nil {
			ack.add(i, err.Error())
			continue
		}
		if capability.Renderer() == "candlestick" {
			var candle seriesPoint
			if err := json.Unmarshal(record.Value, &candle); err != nil || !validCandle(candle.Open, candle.High, candle.Low, candle.Close, candle.Volume) {
				ack.add(i, "invalid candle range or volume")
				continue
			}
		}
		value, err := httpapi.CanonicalValue(record.Value)
		if err != nil {
			writeError(w, err)
			return
		}
		record.Value = value
		writes = append(writes, declaredWrite{record, revision, now.UnixMilli(), capability.History, capability.Kind, i})
	}
	if len(writes) > 0 {
		if _, err := strategy.Authorize(ctx, q, r.Header.Get("Authorization"), strategy.ReportScope); err != nil {
			writeError(w, err)
			return
		}
		saved, err := s.queue.submit(ctx, metricJob{agent: agent, declared: writes})
		if err != nil {
			writeError(w, err)
			return
		}
		ack.merge(saved)
	}
	writeAck(w, ack)
}

func matchesRecordKind(c control.Capability, target string) bool {
	switch target {
	case "report":
		return c.History && (c.Kind == "metric" || c.Kind == "state" || c.Kind == "parameter")
	default:
		return c.Kind == target
	}
}

func writeDeclared(ctx context.Context, q *metricsdb.Queries, agent strategy.Agent, item declaredWrite) (string, error) {
	record := item.record
	links, err := json.Marshal(record.Associations)
	if err != nil {
		return "", err
	}
	hash := auth.Digest(fmt.Sprintf("%s\x00%d\x00%s\x00%s", agent.InstanceID, record.ObservedAt, record.Value, links))
	receipt := metricsdb.InsertCapabilityReceiptParams{
		StrategyID: agent.StrategyID, Revision: item.revision, CapabilityID: record.CapabilityID,
		RecordID: record.ID, ReceivedAt: item.receivedAt, Fingerprint: hash,
	}
	count, err := q.InsertCapabilityReceipt(ctx, receipt)
	if err != nil {
		return "", err
	}
	if count == 0 {
		old, err := q.CapabilityReceiptDigest(ctx, metricsdb.CapabilityReceiptDigestParams{
			StrategyID: receipt.StrategyID, Revision: receipt.Revision, CapabilityID: receipt.CapabilityID, RecordID: receipt.RecordID,
		})
		return compareFingerprint(old, hash, err)
	}
	params := metricsdb.InsertCapabilitySampleParams{
		StrategyID: agent.StrategyID, RecordID: record.ID, CapabilityID: record.CapabilityID, Revision: item.revision,
		InstanceID: agent.InstanceID, BootID: agent.BootID, ObservedAt: record.ObservedAt, ReceivedAt: item.receivedAt,
		Value: string(record.Value), Links: string(links), Fingerprint: hash,
	}
	if item.history {
		if _, err := q.InsertCapabilitySample(ctx, params); err != nil {
			return "", err
		}
	}
	if item.kind != "state" && item.kind != "parameter" {
		if _, err := q.PutCapabilityLatest(ctx, metricsdb.PutCapabilityLatestParams(params)); err != nil {
			return "", err
		}
	}
	return inserted, nil
}

type declaredView struct {
	declaredRecord
	Revision   int64  `json:"revision"`
	ReceivedAt int64  `json:"receivedAt"`
	InstanceID string `json:"instanceId"`
	BootID     string `json:"bootId"`
	Available  *bool  `json:"available,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

func declaredSample(row metricsdb.CapabilitySample) (declaredView, error) {
	var associations Associations
	err := json.Unmarshal([]byte(row.Links), &associations)
	return declaredView{
		declaredRecord: declaredRecord{ID: row.RecordID, CapabilityID: row.CapabilityID, ObservedAt: row.ObservedAt,
			Value: json.RawMessage(row.Value), Associations: associations},
		Revision: row.Revision, ReceivedAt: row.ReceivedAt, InstanceID: row.InstanceID, BootID: row.BootID,
	}, err
}

func (s *Service) latestDeclared(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	id := chi.URLParam(r, "id")
	registry, err := controldb.New(s.stores.Control.Read).GetControlRegistry(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.JSON(w, http.StatusOK, []declaredView{})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	rows, err := metricsdb.New(s.stores.Metrics.Read).ListCapabilityLatest(ctx, metricsdb.ListCapabilityLatestParams{StrategyID: id, Revision: registry.Revision})
	if err != nil {
		writeError(w, err)
		return
	}
	items := make([]declaredView, 0, len(rows))
	for _, row := range rows {
		item, err := declaredSample(metricsdb.CapabilitySample(row))
		if err != nil {
			writeError(w, err)
			return
		}
		items = append(items, item)
	}
	httpapi.JSON(w, http.StatusOK, items)
}

func (s *Service) replayDeclared(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	start, end, limit := int64(0), int64(math.MaxInt64), int64(200)
	for name, target := range map[string]*int64{"from": &start, "to": &end, "limit": &limit} {
		if value := query.Get(name); value != "" {
			n, err := strconv.ParseInt(value, 10, 64)
			if err != nil {
				httpapi.Error(w, 400, "invalid_history", "Invalid replay range or limit")
				return
			}
			*target = n
		}
	}
	cursorAt, cursorRevision := int64(math.MaxInt64), int64(math.MaxInt64)
	cursorID := query.Get("beforeId")
	var cursorErr error
	if value := query.Get("beforeAt"); value != "" {
		cursorAt, cursorErr = strconv.ParseInt(value, 10, 64)
		if revision, err := strconv.ParseInt(query.Get("beforeRevision"), 10, 64); err == nil {
			cursorRevision = revision
		} else {
			cursorErr = err
		}
	}
	if start < 0 || end <= start || limit < 1 || limit > 1000 || cursorAt < 0 || cursorRevision < 1 || cursorErr != nil ||
		cursorAt != math.MaxInt64 && !metricName.MatchString(cursorID) {
		httpapi.Error(w, 400, "invalid_history", "Invalid replay range, limit or cursor")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	id, capability := chi.URLParam(r, "id"), chi.URLParam(r, "capability")
	if _, err := controldb.New(s.stores.Control.Read).GetStrategy(ctx, id); err != nil {
		writeError(w, err)
		return
	}
	if query.Get("source") == "state" {
		rows, err := controldb.New(s.stores.Control.Read).ReplayCapabilityState(ctx, controldb.ReplayCapabilityStateParams{
			StrategyID: id, CapabilityID: capability, FromAt: start, ToAt: end, CursorAt: cursorAt, CursorRevision: cursorRevision, PageSize: limit,
		})
		if err != nil {
			writeError(w, err)
			return
		}
		items := make([]declaredView, 0, len(rows))
		for _, row := range rows {
			available := row.Available == 1
			items = append(items, declaredView{
				declaredRecord: declaredRecord{ID: strconv.FormatInt(row.ObservedAt, 10), CapabilityID: row.CapabilityID,
					ObservedAt: row.ObservedAt, Value: json.RawMessage(row.Value)},
				Revision: row.Revision, ReceivedAt: row.ReceivedAt, InstanceID: row.InstanceID, BootID: row.BootID, Available: &available, Reason: row.Reason,
			})
		}
		httpapi.JSON(w, http.StatusOK, items)
		return
	}
	rows, err := metricsdb.New(s.stores.Metrics.Read).ReplayCapabilityData(ctx, metricsdb.ReplayCapabilityDataParams{
		StrategyID: id, CapabilityID: capability, FromAt: start, ToAt: end, CursorAt: cursorAt, CursorID: cursorID, CursorRevision: cursorRevision, PageSize: limit,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	items := make([]declaredView, 0, len(rows))
	for _, row := range rows {
		item, err := declaredSample(row)
		if err != nil {
			writeError(w, err)
			return
		}
		items = append(items, item)
	}
	httpapi.JSON(w, http.StatusOK, items)
}

var metricName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,95}$`)
