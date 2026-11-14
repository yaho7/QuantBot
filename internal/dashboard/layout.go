package dashboard

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

type Widget struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	StrategyID  string `json:"strategyId"`
	ControlID   string `json:"controlId,omitempty"`
	Hidden      bool   `json:"hidden,omitempty"`
	Label       string `json:"label,omitempty"`
	Icon        string `json:"icon,omitempty"`
	Color       string `json:"color,omitempty"`
	Size        string `json:"size"`
	Description bool   `json:"description"`
	Detailed    bool   `json:"detailed"`
}

type Layout struct {
	Version  int      `json:"version"`
	Revision int64    `json:"revision"`
	Widgets  []Widget `json:"widgets"`
}

type Service struct{ database storage.Database }

func New(database storage.Database) *Service { return &Service{database: database} }

var keyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
var widgetIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,175}$`)
var colorPattern = regexp.MustCompile(`^#[a-fA-F0-9]{6}$`)
var errConflict = errors.New("layout changed in another browser")

type invalid string

func (e invalid) Error() string { return string(e) }

func (s *Service) Register(r chi.Router) {
	r.Get("/layouts/{key}", s.get)
	r.Put("/layouts/{key}", s.put)
}

func (s *Service) get(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	if !keyPattern.MatchString(key) {
		fail(w, invalid("Invalid layout key"))
		return
	}
	value, err := s.read(r.Context(), controldb.New(s.database.Read), auth.Current(r).UserID, key)
	if err != nil {
		fail(w, err)
		return
	}
	httpapi.JSON(w, http.StatusOK, value)
}

func (s *Service) read(ctx context.Context, q *controldb.Queries, userID int64, key string) (Layout, error) {
	value := Layout{Version: 1, Widgets: []Widget{}}
	row, err := q.GetLayout(ctx, controldb.GetLayoutParams{UserID: userID, Key: key})
	if errors.Is(err, sql.ErrNoRows) {
		return value, nil
	}
	if err == nil {
		value.Revision = row.Revision
		err = json.Unmarshal([]byte(row.Widgets), &value.Widgets)
	}
	return value, err
}

func validate(input Layout) error {
	if input.Version != 1 || input.Revision < 0 || input.Widgets == nil || len(input.Widgets) > 256 {
		return invalid("Provide a version 1 layout, revision, and at most 256 widgets")
	}
	seen := map[string]bool{}
	for _, widget := range input.Widgets {
		hasSource := widget.Type == "control" || widget.Type == "capability"
		if !widgetIDPattern.MatchString(widget.ID) || seen[widget.ID] || len(widget.StrategyID) > 96 || widget.StrategyID == "" ||
			!slices.Contains([]string{"control", "capability", "equity", "chart", "positions", "activity"}, widget.Type) ||
			!slices.Contains([]string{"small", "medium", "large", "full"}, widget.Size) ||
			len(widget.Label) > 160 || len(widget.Icon) > 64 || widget.Icon != "" && !keyPattern.MatchString(widget.Icon) ||
			widget.Color != "" && !colorPattern.MatchString(widget.Color) ||
			hasSource && !keyPattern.MatchString(widget.ControlID) ||
			!hasSource && widget.ControlID != "" || widget.Hidden && !hasSource {
			return invalid("Invalid widget source, appearance, size, or duplicate widget ID")
		}
		seen[widget.ID] = true
	}
	return nil
}

func (s *Service) put(w http.ResponseWriter, r *http.Request) {
	var input Layout
	if !httpapi.ReadJSON(w, r, &input, 256<<10) {
		return
	}
	if err := validate(input); err != nil {
		fail(w, err)
		return
	}
	key := chi.URLParam(r, "key")
	if !keyPattern.MatchString(key) {
		fail(w, invalid("Invalid layout key"))
		return
	}
	ctx, user := r.Context(), auth.Current(r)
	body, err := json.Marshal(input.Widgets)
	if err != nil {
		fail(w, err)
		return
	}
	output := input
	err = storage.WithTx(ctx, s.database.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		old, err := s.read(ctx, q, user.UserID, key)
		if err != nil {
			return err
		}
		existing, err := json.Marshal(old.Widgets)
		if err != nil {
			return err
		}
		if string(existing) == string(body) {
			output = old
			return nil
		}
		if input.Revision != old.Revision {
			return errConflict
		}
		previous := make(map[string]Widget, len(old.Widgets))
		for _, widget := range old.Widgets {
			previous[widget.ID] = widget
		}
		for _, widget := range input.Widgets {
			saved, exists := previous[widget.ID]
			if exists && saved.Type == widget.Type && saved.StrategyID == widget.StrategyID && saved.ControlID == widget.ControlID {
				continue
			}
			strategy, err := q.GetStrategy(ctx, widget.StrategyID)
			if errors.Is(err, sql.ErrNoRows) {
				return invalid("Widget strategy does not exist")
			}
			if err != nil {
				return err
			}
			if strategy.ArchivedAt.Valid {
				return invalid("Widget strategy is archived")
			}
			if widget.Type == "control" || widget.Type == "capability" {
				_, err := q.GetControlDefinition(ctx, controldb.GetControlDefinitionParams{
					StrategyID: widget.StrategyID, ControlID: widget.ControlID,
				})
				if errors.Is(err, sql.ErrNoRows) {
					return invalid("Widget control does not exist")
				}
				if err != nil {
					return err
				}
			}
		}
		output.Revision = old.Revision + 1
		if err := q.PutLayout(ctx, controldb.PutLayoutParams{
			UserID: user.UserID, Key: key, Revision: output.Revision, Widgets: string(body),
		}); err != nil {
			return err
		}
		details, _ := json.Marshal(map[string]any{"key": key, "revision": output.Revision, "widgets": len(input.Widgets)})
		return q.AppendAudit(ctx, controldb.AppendAuditParams{
			At: time.Now().UnixMilli(), Actor: user.Username, Action: "layout.saved", Details: string(details),
		})
	})
	if err != nil {
		fail(w, err)
		return
	}
	httpapi.JSON(w, http.StatusOK, output)
}

func fail(w http.ResponseWriter, err error) {
	var input invalid
	switch {
	case errors.As(err, &input):
		httpapi.Error(w, http.StatusBadRequest, "invalid_layout", err.Error())
	case errors.Is(err, errConflict):
		httpapi.Error(w, http.StatusConflict, "layout_changed", err.Error())
	default:
		httpapi.Error(w, http.StatusServiceUnavailable, "storage_unavailable", "Layout storage unavailable")
	}
}
