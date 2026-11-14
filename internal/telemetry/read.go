package telemetry

import (
	"cmp"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/storage/metricsdb"
)

func (s *Service) RegisterBrowser(r chi.Router) {
	r.Get("/strategies/{id}/series", s.series)
	r.Get("/strategies/{id}/capability-data", s.latestDeclared)
	r.Get("/strategies/{id}/resources/{capability}", s.resourceCurrent)
	r.Get("/strategies/{id}/resources/{capability}/history", s.resourceHistory)
	r.Get("/strategies/{id}/capabilities/{capability}/history", s.replayDeclared)
	r.Get("/strategies/{id}/history", s.history)
	r.Get("/strategies/{id}/telemetry", s.latest)
	r.Get("/strategies/{id}/records", s.records)
	r.Get("/strategies/{id}/related", s.related)
	r.Get("/alerts", s.alerts)
}

type seriesView struct {
	Kind       string `json:"kind"`
	Series     string `json:"series"`
	InstanceID string `json:"instanceId"`
	ObservedAt int64  `json:"observedAt"`
}

func (s *Service) series(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	id := chi.URLParam(r, "id")
	if _, err := controldb.New(s.stores.Control.Read).GetStrategy(ctx, id); err != nil {
		writeError(w, err)
		return
	}
	q := metricsdb.New(s.stores.Metrics.Read)
	rows, err := q.ListSeries(ctx, id)
	if err != nil {
		writeError(w, err)
		return
	}
	definitions, err := q.ListMetricDefinitions(ctx, id)
	if err != nil {
		writeError(w, err)
		return
	}
	items := make([]seriesView, 0, len(rows))
	for _, row := range rows {
		items = append(items, seriesView{row.Kind, row.Series, row.InstanceID, row.ObservedAt})
	}
	metadata := make([]json.RawMessage, 0, len(definitions))
	for _, definition := range definitions {
		metadata = append(metadata, json.RawMessage(definition.Definition))
	}
	httpapi.JSON(w, http.StatusOK, map[string]any{"series": items, "definitions": metadata})
}

type readRecord struct {
	Record
	InstanceID string `json:"instanceId"`
	StrategyID string `json:"strategyId"`
	SeriesKey  string `json:"series"`
	ReceivedAt int64  `json:"receivedAt,omitempty"`
}

func (s *Service) latest(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	control := controldb.New(s.stores.Control.Read)
	if _, err := control.GetStrategy(ctx, id); err != nil {
		writeError(w, err)
		return
	}
	orders, err := control.LatestOrders(ctx, id)
	if err != nil {
		writeError(w, err)
		return
	}

	metrics := metricsdb.New(s.stores.Metrics.Read)
	latest := make(map[[3]string]readRecord)
	put := func(instance string, record Record) {
		key := [3]string{instance, record.Kind, record.Series}
		old, exists := latest[key]
		if !exists || record.ObservedAt > old.ObservedAt || record.ObservedAt == old.ObservedAt && record.ID > old.ID {
			latest[key] = readRecord{Record: record, InstanceID: instance, StrategyID: id, SeriesKey: record.Series}
		}
	}
	for _, kind := range []string{"status", "connection", "portfolio", "position", "performance", "equity", "metric"} {
		rows, err := metrics.ListLatestSamples(ctx, metricsdb.ListLatestSamplesParams{StrategyID: id, Kind: kind})
		if err != nil {
			writeError(w, err)
			return
		}
		for _, row := range rows {
			put(row.InstanceID, Record{ID: row.ReportID, Kind: row.Kind, Series: row.Series, ObservedAt: row.ObservedAt, Data: json.RawMessage(row.Data)})
		}
	}
	for _, row := range orders {
		put(row.InstanceID, tradeRecord(row).Record)
	}
	rows := make([]readRecord, 0, len(latest))
	for _, record := range latest {
		rows = append(rows, record)
	}
	slices.SortFunc(rows, func(a, b readRecord) int {
		if order := cmp.Compare(b.ObservedAt, a.ObservedAt); order != 0 {
			return order
		}
		if order := cmp.Compare(a.Kind, b.Kind); order != 0 {
			return order
		}
		return cmp.Compare(a.ID, b.ID)
	})
	httpapi.JSON(w, http.StatusOK, rows)
}

func (s *Service) records(w http.ResponseWriter, r *http.Request) {
	s.feed(w, r, chi.URLParam(r, "id"), r.URL.Query().Get("kind"))
}

func (s *Service) alerts(w http.ResponseWriter, r *http.Request) {
	s.feed(w, r, "", "alert")
}

func (s *Service) feed(w http.ResponseWriter, r *http.Request, strategyID, kind string) {
	query := r.URL.Query()
	at := int64(math.MaxInt64)
	var err error
	if raw := query.Get("beforeAt"); raw != "" {
		at, err = strconv.ParseInt(raw, 10, 64)
	}
	reportID, source := query.Get("beforeId"), query.Get("beforeStrategyId")
	if err != nil || at <= 0 || len(reportID) > 96 || len(source) > 96 ||
		at != math.MaxInt64 && (reportID == "" || strategyID == "" && source == "") ||
		!critical(kind) && kind != "log" && kind != "signal" && !statusKind(kind) {
		httpapi.Error(w, http.StatusBadRequest, "invalid_records", "Provide an event or state kind and a complete cursor")
		return
	}
	if strategyID != "" {
		source = strategyID
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	control := controldb.New(s.stores.Control.Read)
	if strategyID != "" {
		if _, err := control.GetStrategy(ctx, strategyID); err != nil {
			writeError(w, err)
			return
		}
	}
	items := make([]readRecord, 0, 100)
	if critical(kind) {
		rows, err := control.ListTradeEvents(ctx, controldb.ListTradeEventsParams{
			StrategyID: strategyID, Kind: kind, BeforeAt: at, BeforeID: reportID, BeforeStrategy: source, PageSize: 100,
		})
		if err != nil {
			writeError(w, err)
			return
		}
		for _, row := range rows {
			items = append(items, tradeRecord(row))
		}
	} else {
		rows, err := metricsdb.New(s.stores.Metrics.Read).ListSampleEvents(ctx, metricsdb.ListSampleEventsParams{
			StrategyID: strategyID, Kind: kind, BeforeAt: at, BeforeID: reportID, PageSize: 100,
		})
		if err != nil {
			writeError(w, err)
			return
		}
		for _, row := range rows {
			var links *Associations
			_ = json.Unmarshal([]byte(row.Associations), &links)
			items = append(items, readRecord{
				ReceivedAt: row.ReceivedAt,
				Record:     Record{ID: row.ReportID, Kind: row.Kind, Series: row.Series, ObservedAt: row.ObservedAt, Data: json.RawMessage(row.Data), Associations: links},
				InstanceID: row.InstanceID, StrategyID: row.StrategyID, SeriesKey: row.Series,
			})
		}
	}
	httpapi.JSON(w, http.StatusOK, items)
}

func tradeRecord(row controldb.TradeEvent) readRecord {
	var links *Associations
	_ = json.Unmarshal([]byte(row.Associations), &links)
	return readRecord{
		ReceivedAt: row.ReceivedAt,
		Record:     Record{ID: row.ReportID, Kind: row.Kind, Series: row.Series, ObservedAt: row.ObservedAt, Data: json.RawMessage(row.Data), Associations: links},
		InstanceID: row.InstanceID, StrategyID: row.StrategyID, SeriesKey: row.Series,
	}
}
