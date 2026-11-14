package telemetry

import (
	"cmp"
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/storage/metricsdb"
)

type associatedRecord struct {
	ID           string          `json:"id"`
	Kind         string          `json:"kind,omitempty"`
	CapabilityID string          `json:"capabilityId,omitempty"`
	ObservedAt   int64           `json:"observedAt"`
	ReceivedAt   int64           `json:"receivedAt"`
	Revision     int64           `json:"revision,omitempty"`
	Value        json.RawMessage `json:"value"`
	Associations json.RawMessage `json:"associations"`
}

func (s *Service) related(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	key, value := query.Get("field"), query.Get("value")
	if !slices.Contains([]string{"account_id", "symbol", "signal_id", "decision_id", "order_id", "command_id", "correlation_id"}, key) ||
		!metricName.MatchString(value) {
		httpapi.Error(w, http.StatusBadRequest, "invalid_association", "Provide a supported association field and an explicit ID")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	id := chi.URLParam(r, "id")
	q := controldb.New(s.stores.Control.Read)
	if _, err := q.GetStrategy(ctx, id); err != nil {
		writeError(w, err)
		return
	}
	path := "$." + key
	trades, err := q.FindAssociatedTrades(ctx, controldb.FindAssociatedTradesParams{StrategyID: id, JsonPath: path, Association: value})
	if err != nil {
		writeError(w, err)
		return
	}
	samples, err := metricsdb.New(s.stores.Metrics.Read).FindAssociatedSamples(ctx, metricsdb.FindAssociatedSamplesParams{
		StrategyID: id, JsonPath: path, Association: value,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	resources, err := q.FindAssociatedResources(ctx, controldb.FindAssociatedResourcesParams{
		StrategyID: id, JsonPath: path, Association: value,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	items := make([]associatedRecord, 0, len(trades)+len(samples)+len(resources))
	for _, resource := range resources {
		items = append(items, associatedRecord{ID: resource.ResourceID, CapabilityID: resource.CapabilityID,
			ObservedAt: resource.ObservedAt, ReceivedAt: resource.ReceivedAt, Revision: resource.Revision,
			Value: json.RawMessage(resource.Value), Associations: json.RawMessage(resource.Links)})
	}
	for _, event := range trades {
		items = append(items, associatedRecord{ID: event.ReportID, Kind: event.Kind, ObservedAt: event.ObservedAt,
			ReceivedAt: event.ReceivedAt, Value: json.RawMessage(event.Data), Associations: json.RawMessage(event.Associations)})
	}
	for _, sample := range samples {
		item := associatedRecord{ID: sample.ReportID, Kind: sample.Kind, ObservedAt: sample.ObservedAt,
			ReceivedAt: sample.ReceivedAt, Value: json.RawMessage(sample.Value), Associations: json.RawMessage(sample.Associations),
			Revision: sample.Revision}
		if item.Revision != 0 {
			item.CapabilityID = sample.Series
		}
		items = append(items, item)
	}
	slices.SortStableFunc(items, func(a, b associatedRecord) int {
		if order := cmp.Compare(b.ObservedAt, a.ObservedAt); order != 0 {
			return order
		}
		return cmp.Compare(b.ID, a.ID)
	})
	httpapi.JSON(w, http.StatusOK, items[:min(len(items), 50)])
}
