package theme

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

type invalid string

func (e invalid) Error() string { return string(e) }

func (s *Service) Register(r chi.Router) {
	r.Get("/theme", s.active)
	r.Get("/admin/themes", s.list)
	r.Put("/admin/themes/active", s.activate)
}

func (s *Service) active(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	view, err := s.getActive(r.Context(), controldb.New(s.store.Read))
	if err != nil {
		slog.Warn("theme selection unavailable", "error", err)
		view = builtin(BuiltinClassical)
	}
	httpapi.JSON(w, http.StatusOK, view)
}

func (s *Service) list(w http.ResponseWriter, r *http.Request) {
	httpapi.JSON(w, http.StatusOK, map[string]any{"active": BuiltinClassical, "themes": []instance{builtin(BuiltinClassical)}})
}

func (s *Service) upload(w http.ResponseWriter, r *http.Request) {
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/zip" && contentType != "application/octet-stream" {
		httpapi.Error(w, http.StatusUnsupportedMediaType, "content_type", "Upload a ZIP file")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxArchiveBytes))
	var limit *http.MaxBytesError
	if errors.As(err, &limit) {
		httpapi.Error(w, http.StatusRequestEntityTooLarge, "theme_too_large", "Theme ZIP exceeds 12 MiB")
		return
	}
	if err != nil {
		fail(w, invalid("Cannot read theme ZIP"))
		return
	}
	theme, err := s.install(r.Context(), auth.Current(r).Username, body)
	if err != nil {
		fail(w, err)
		return
	}
	httpapi.JSON(w, http.StatusCreated, theme)
}

func (s *Service) activate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ID string `json:"id"`
	}
	if !httpapi.ReadJSON(w, r, &input, 4096) {
		return
	}
	if input.ID != BuiltinClassical {
		fail(w, invalid("Invalid theme ID"))
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ctx := r.Context()
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)

		if err := setActive(ctx, q, input.ID); err != nil {
			return err
		}
		return audit(ctx, q, auth.Current(r).Username, "theme.activated", input.ID)
	})
	if err != nil {
		fail(w, err)
		return
	}
	httpapi.JSON(w, http.StatusOK, map[string]string{"active": input.ID})
}

func (s *Service) configuration(w http.ResponseWriter, r *http.Request) {
	var input map[string]json.RawMessage
	if !httpapi.ReadJSON(w, r, &input, 64<<10) {
		return
	}
	themeID := chi.URLParam(r, "id")
	s.mu.Lock()
	defer s.mu.Unlock()
	ctx := r.Context()
	var settings string
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		item, err := q.GetTheme(ctx, themeID)
		if err != nil {
			return err
		}
		bundle, err := parseBundle(item.Bundle)
		if err != nil {
			return err
		}
		settings, err = validConfiguration(bundle, input, true)
		if err != nil {
			return err
		}
		if err := q.StoreThemeConfiguration(ctx, controldb.StoreThemeConfigurationParams{
			ThemeID: themeID, Revision: item.Revision, Configuration: settings,
		}); err != nil {
			return err
		}
		return audit(ctx, q, auth.Current(r).Username, "theme.configured", themeID)
	})
	if err != nil {
		fail(w, err)
		return
	}
	httpapi.JSON(w, http.StatusOK, json.RawMessage(settings))
}

func (s *Service) rollback(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ctx, id := r.Context(), chi.URLParam(r, "id")
	var view instance
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		row, err := q.GetTheme(ctx, id)
		if err != nil {
			return err
		}
		if row.PreviousRevision == "" {
			return errConflict
		}
		old, err := q.GetThemeRevision(ctx, controldb.GetThemeRevisionParams{ThemeID: id, Revision: row.PreviousRevision})
		if err != nil {
			return err
		}
		now := time.Now().UnixMilli()
		view, err = s.readInstance(controldb.GetThemeRow{
			ID: id, Revision: old.Revision, PreviousRevision: row.Revision,
			UpdatedAt: now, Bundle: old.Bundle, Configuration: old.Configuration,
		})
		if err != nil {
			return err
		}
		if !view.Available {
			return invalid("Previous theme is unavailable")
		}
		if err := q.StoreTheme(ctx, controldb.StoreThemeParams{ID: id, Revision: old.Revision, PreviousRevision: row.Revision, UpdatedAt: now}); err != nil {
			return err
		}
		return audit(ctx, q, auth.Current(r).Username, "theme.rolled_back", id)
	})
	if err != nil {
		fail(w, err)
		return
	}
	httpapi.JSON(w, http.StatusOK, view)
}

func (s *Service) remove(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ctx, id := r.Context(), chi.URLParam(r, "id")
	if !identifier.MatchString(id) || id == BuiltinClassical {
		fail(w, invalid("Only installed theme packages can be deleted"))
		return
	}
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		deleted, err := q.DeleteTheme(ctx, id)
		if err != nil {
			return err
		}
		if deleted != 1 {
			return sql.ErrNoRows
		}
		active, err := activeTheme(ctx, q)
		if err != nil {
			return err
		}
		if active == id {
			if err := setActive(ctx, q, BuiltinClassical); err != nil {
				return err
			}
		}
		return audit(ctx, q, auth.Current(r).Username, "theme.deleted", id)
	})
	if err != nil {
		fail(w, err)
		return
	}
	s.removeDirectory(filepath.Join(s.dir, id))
	w.WriteHeader(http.StatusNoContent)
}

func fail(w http.ResponseWriter, err error) {
	var validation invalid
	switch {
	case errors.As(err, &validation):
		httpapi.Error(w, http.StatusBadRequest, "invalid_theme", err.Error())
	case errors.Is(err, sql.ErrNoRows):
		httpapi.Error(w, http.StatusNotFound, "not_found", "Theme was not found")
	case errors.Is(err, errConflict):
		httpapi.Error(w, http.StatusConflict, "theme_conflict", err.Error())
	default:
		slog.Error("theme management", "error", err)
		httpapi.Error(w, http.StatusServiceUnavailable, "storage_unavailable", "Theme storage unavailable")
	}
}
