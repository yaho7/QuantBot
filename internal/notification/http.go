package notification

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
	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

func (s *Service) Register(r chi.Router) {
	r.Get("/admin/notifications", s.list)
	r.Post("/admin/notifications", s.save)
	r.Put("/admin/notifications/{id}", s.save)
	r.Delete("/admin/notifications/{id}", s.remove)
	r.Post("/admin/notifications/{id}/test", s.test)
	r.Get("/admin/notifications/{id}/deliveries", s.history)
}

type channel struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Provider  Provider `json:"provider"`
	Enabled   bool     `json:"enabled"`
	Events    []string `json:"events"`
	UpdatedAt int64    `json:"updatedAt"`
}

func (s *Service) list(w http.ResponseWriter, r *http.Request) {
	items, err := controldb.New(s.store.Read).ListNotificationChannels(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	result := make([]channel, 0, len(items))
	for _, item := range items {
		c := channel{ID: item.ID, Name: item.Name, Provider: Provider(item.Provider), Enabled: item.Enabled == 1, UpdatedAt: item.UpdatedAt}
		if err := json.Unmarshal([]byte(item.Events), &c.Events); err != nil {
			writeError(w, err)
			return
		}
		result = append(result, c)
	}
	httpapi.JSON(w, http.StatusOK, result)
}

type invalid string

func (e invalid) Error() string { return string(e) }

func (s *Service) save(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name        string       `json:"name"`
		Provider    Provider     `json:"provider"`
		Enabled     *bool        `json:"enabled"`
		Events      []string     `json:"events"`
		Credentials *Credentials `json:"credentials"`
	}
	if !httpapi.ReadJSON(w, r, &input, 8<<10) {
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len(input.Name) > 120 || input.Enabled == nil || input.Events == nil {
		writeError(w, invalid("Provide a channel name, enabled state and event list"))
		return
	}
	kinds := map[string]bool{}
	for _, event := range input.Events {
		if kinds[event] || !slices.Contains([]string{"alert", "risk", "fill", "command"}, event) {
			writeError(w, invalid("Invalid or duplicate notification event"))
			return
		}
		kinds[event] = true
	}
	if input.Credentials != nil {
		if err := Validate(input.Provider, *input.Credentials); err != nil {
			writeError(w, invalid(err.Error()))
			return
		}
	}
	ctx, id := r.Context(), chi.URLParam(r, "id")
	newChannel := id == ""
	if newChannel {
		id = channelID()
	}
	now := time.Now().UnixMilli()
	events, _ := json.Marshal(input.Events)
	var enabled int64
	if *input.Enabled {
		enabled = 1
	}
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		var encrypted []byte
		if newChannel {
			count, err := q.NotificationChannelCount(ctx)
			if err != nil {
				return err
			}
			if count >= 32 || input.Credentials == nil {
				return invalid("A new channel requires credentials and an available channel slot")
			}
		} else {
			row, err := q.GetNotificationChannel(ctx, id)
			if err != nil {
				return err
			}
			if row.Provider != string(input.Provider) && input.Credentials == nil {
				return invalid("Changing provider requires new credentials")
			}
			encrypted = row.Encrypted
			// A destination change must not forward old queued messages to a
			// newly configured group.
			if enabled == 0 || input.Credentials != nil {
				if err := q.PauseNotificationDeliveries(ctx, controldb.PauseNotificationDeliveriesParams{ChannelID: id, Now: sql.NullInt64{Int64: now, Valid: true}}); err != nil {
					return err
				}
			}
		}
		if input.Credentials != nil {
			var err error
			encrypted, err = s.seal(id, string(input.Provider), *input.Credentials)
			if err != nil {
				return err
			}
		}
		if err := q.PutNotificationChannel(ctx, controldb.PutNotificationChannelParams{
			ID: id, Name: input.Name, Provider: string(input.Provider), Encrypted: encrypted,
			Enabled: enabled, Events: string(events), UpdatedAt: now,
		}); err != nil {
			return err
		}
		return audit(ctx, q, auth.Current(r).Username, "notification.saved", id)
	})
	if err != nil {
		writeError(w, err)
		return
	}
	status := http.StatusOK
	if newChannel {
		status = http.StatusCreated
	}
	httpapi.JSON(w, status, channel{id, input.Name, input.Provider, *input.Enabled, input.Events, now})
}

func (s *Service) remove(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), chi.URLParam(r, "id")
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		count, err := q.DeleteNotificationChannel(ctx, id)
		if err != nil {
			return err
		}
		if count == 0 {
			return sql.ErrNoRows
		}
		return audit(ctx, q, auth.Current(r).Username, "notification.deleted", id)
	})
	if err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) test(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), chi.URLParam(r, "id")
	now := time.Now().UnixMilli()
	var delivery int64
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		channel, err := q.GetNotificationChannel(ctx, id)
		if err != nil {
			return err
		}
		latest, err := q.ListNotificationDeliveries(ctx, id)
		if err != nil {
			return err
		}
		for _, row := range latest {
			if row.Kind == "test" && (row.Status == "queued" || row.NextAt > now-10000) {
				delivery = row.ID
				return nil
			}
		}
		event, err := q.AddNotificationTestEvent(ctx, controldb.AddNotificationTestEventParams{
			Title: "QuantBot test notification", Body: "Channel: " + channel.Name, CreatedAt: now,
		})
		if err != nil {
			return err
		}
		delivery, err = q.AddNotificationTestDelivery(ctx, controldb.AddNotificationTestDeliveryParams{ChannelID: id, EventID: event, NextAt: now})
		if err != nil {
			return err
		}
		return audit(ctx, q, auth.Current(r).Username, "notification.test_queued", id)
	})
	if err != nil {
		writeError(w, err)
		return
	}
	select {
	case s.wake <- struct{}{}:
	default:
	}
	httpapi.JSON(w, http.StatusAccepted, map[string]int64{"deliveryId": delivery})
}

func (s *Service) history(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	items, err := controldb.New(s.store.Read).ListNotificationDeliveries(ctx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	type record struct {
		ID         int64  `json:"id"`
		Kind       string `json:"kind"`
		Status     string `json:"status"`
		Attempts   int64  `json:"attempts"`
		NextAt     int64  `json:"nextAt"`
		LastError  string `json:"lastError,omitempty"`
		ProviderID string `json:"providerId,omitempty"`
	}
	view := make([]record, 0, len(items))
	for _, item := range items {
		view = append(view, record{item.ID, item.Kind, item.Status, item.Attempts, item.NextAt, item.LastError, item.ProviderID})
	}
	httpapi.JSON(w, http.StatusOK, view)
}

func audit(ctx context.Context, q *controldb.Queries, actor, action, id string) error {
	body, _ := json.Marshal(map[string]string{"channelId": id})
	return q.AppendAudit(ctx, controldb.AppendAuditParams{At: time.Now().UnixMilli(), Actor: actor, Action: action, Details: string(body)})
}

func writeError(w http.ResponseWriter, err error) {
	var validation invalid
	switch {
	case errors.Is(err, sql.ErrNoRows):
		httpapi.Error(w, http.StatusNotFound, "not_found", "Notification channel was not found")
	case errors.As(err, &validation):
		httpapi.Error(w, http.StatusBadRequest, "invalid_notification", validation.Error())
	default:
		slog.Error("notification storage", "error", err)
		httpapi.Error(w, http.StatusServiceUnavailable, "storage_unavailable", "Notification storage unavailable")
	}
}
