package telemetry

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/mattn/go-sqlite3"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/realtime"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

type Service struct {
	stores   *storage.Stores
	schema   *jsonschema.Schema
	queue    *metricQueue
	inflight chan struct{}
	notify   realtime.Notify
}

func New(stores *storage.Stores, cfg QueueConfig, notify realtime.Notify) (*Service, error) {
	schema, err := loadSchema()
	if err != nil {
		return nil, err
	}
	return &Service{
		stores: stores, schema: schema, queue: newQueue(stores.Metrics.Write, cfg, notify),
		inflight: make(chan struct{}, cfg.Capacity+cfg.Batch), notify: notify,
	}, nil
}

func (s *Service) Close() { s.queue.close() }

func (s *Service) QueueDepth() int { return len(s.queue.jobs) }

func (s *Service) WriteFailures() uint64 { return s.queue.failures.Load() }

func (s *Service) RegisterAgent(r chi.Router) {
	r.Post("/reports", s.authorized(s.ingest("report")))
	r.Post("/events", s.authorized(s.ingest("event")))
	r.Put("/resources/{type}", s.authorized(s.ingest("resource")))
}

func (s *Service) RegisterSchema(r chi.Router) {
	r.Get("/schemas/report.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/schema+json")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		_, _ = w.Write(reportSchema)
	})
}

func (s *Service) authorized(handle func(http.ResponseWriter, *http.Request, strategy.Agent)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		agent, err := strategy.Authorize(r.Context(), controldb.New(s.stores.Control.Read), r.Header.Get("Authorization"), strategy.ReportScope)
		if err != nil {
			writeError(w, err)
			return
		}
		select {
		case s.inflight <- struct{}{}:
			defer func() { <-s.inflight }()
			handle(w, r, agent)
		default:
			writeError(w, errQueueFull)
		}
	}
}

const maxBody = 512 << 10
const maxRecords = 250

func (s *Service) ingest(kind string) func(http.ResponseWriter, *http.Request, strategy.Agent) {
	return func(w http.ResponseWriter, r *http.Request, agent strategy.Agent) {
		var batch struct {
			Revision *int64            `json:"revision,omitempty"`
			Records  []json.RawMessage `json:"records"`
		}
		if !httpapi.ReadJSON(w, r, &batch, maxBody) {
			return
		}
		if len(batch.Records) == 0 || len(batch.Records) > maxRecords || batch.Revision != nil && *batch.Revision < 1 {
			httpapi.Error(w, 400, "invalid_batch", "Provide 1–250 records and a positive revision for capability data")
			return
		}
		if batch.Revision != nil {
			s.declared(w, r, agent, *batch.Revision, batch.Records, kind, chi.URLParam(r, "type"))
			return
		}
		if kind == "resource" {
			httpapi.Error(w, 400, "invalid_batch", "Resource updates require a capability revision")
			return
		}
		s.standard(w, r, agent, batch.Records, kind)
	}
}

func (s *Service) standard(w http.ResponseWriter, r *http.Request, agent strategy.Agent, records []json.RawMessage, kind string) {
	now := time.Now()
	var trades, metrics []indexedRecord
	var ack Ack
	for i, raw := range records {
		record, err := s.decodeRecord(raw, now)
		if err != nil {
			ack.add(i, firstLine(err.Error()))
		} else if kind == "event" && !standardEvent(record.Kind) {
			ack.add(i, "record is not a standard event")
		} else if critical(record.Kind) {
			trades = append(trades, indexedRecord{record, i})
		} else {
			metrics = append(metrics, indexedRecord{record, i})
		}
	}
	ctx := r.Context()
	if len(trades) > 0 {
		var saved Ack
		err := storage.WithTx(ctx, s.stores.Control.Write, func(tx *sql.Tx) error {
			q := controldb.New(tx)
			if _, err := strategy.Authorize(ctx, q, r.Header.Get("Authorization"), strategy.ReportScope); err != nil {
				return err
			}
			for _, item := range trades {
				result, err := writeTrade(ctx, q, agent, item.Record)
				if err != nil {
					return err
				}
				saved.add(item.index, result)
			}
			return nil
		})
		if err != nil {
			writeError(w, err)
			return
		}
		ack.merge(saved)
		if saved.Inserted > 0 {
			s.notify.Emit(agent.StrategyID, realtime.Telemetry)
			for _, item := range trades {
				if item.Kind == "alert" {
					s.notify.Emit(agent.StrategyID, realtime.Alerts)
					break
				}
			}
		}
	}
	if len(metrics) > 0 {
		if _, err := strategy.Authorize(ctx, controldb.New(s.stores.Control.Read), r.Header.Get("Authorization"), strategy.ReportScope); err != nil {
			writeError(w, err)
			return
		}
		saved, err := s.queue.submit(ctx, metricJob{agent: agent, records: metrics})
		if err != nil {
			writeError(w, err)
			return
		}
		ack.merge(saved)
	}
	writeAck(w, ack)
}

func firstLine(message string) string {
	if _, detail, ok := strings.Cut(message, "\n"); ok {
		message, _, _ = strings.Cut(detail, "\n")
	}
	return strings.TrimSpace(message)
}

func writeAck(w http.ResponseWriter, ack Ack) {
	slices.SortFunc(ack.Errors, func(a, b Rejection) int { return a.Index - b.Index })
	status := http.StatusOK
	if ack.Rejected > 0 && ack.Inserted+ack.Duplicate == 0 {
		status = http.StatusUnprocessableEntity
	}
	httpapi.JSON(w, status, ack)
}

func writeError(w http.ResponseWriter, err error) {
	if strategy.WriteAuthError(w, err) {
		return
	}
	var sqliteErr sqlite3.Error
	switch {
	case errors.Is(err, errQueueFull):
		w.Header().Set("Retry-After", "1")
		httpapi.Error(w, http.StatusTooManyRequests, "queue_full", "Telemetry capacity is full. Retry with the same record IDs.")
	case errors.Is(err, errClosing):
		httpapi.Error(w, http.StatusServiceUnavailable, "shutting_down", "Telemetry writer is shutting down")
	case errors.As(err, &sqliteErr) && sqliteErr.Code == sqlite3.ErrFull:
		httpapi.Error(w, http.StatusInsufficientStorage, "storage_full", "Telemetry storage is full")
	case errors.As(err, &sqliteErr) && (sqliteErr.Code == sqlite3.ErrBusy || sqliteErr.Code == sqlite3.ErrLocked),
		errors.Is(err, context.DeadlineExceeded):
		w.Header().Set("Retry-After", "1")
		httpapi.Error(w, http.StatusServiceUnavailable, "storage_busy", "Telemetry storage is busy")
	case errors.Is(err, sql.ErrNoRows):
		httpapi.Error(w, http.StatusNotFound, "not_found", "Resource was not found")
	case errors.Is(err, context.Canceled):
	default:
		slog.Error("telemetry storage", "error", err)
		httpapi.Error(w, http.StatusServiceUnavailable, "storage_unavailable", "Telemetry storage unavailable")
	}
}

func standardEvent(kind string) bool {
	return critical(kind) || kind == "signal" || kind == "log"
}
