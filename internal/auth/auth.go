package auth

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

const (
	cookieName = "qb_session"
	sessionTTL = 24 * time.Hour
)

var (
	errInitialized = errors.New("administrator already initialized")
	errCredentials = errors.New("invalid credentials")
)

type Service struct {
	store     storage.Database
	attempts  map[netip.Addr]int
	overall   window
	mu        sync.Mutex
	hashSlots chan struct{}
}

type window struct {
	count int
	until time.Time
}

type Session struct {
	UserID    int64  `json:"userId"`
	Username  string `json:"username"`
	CSRF      string `json:"csrf"`
	ExpiresAt int64  `json:"expiresAt"`
	Digest    string `json:"-"`
}

type sessionKey struct{}

func Current(r *http.Request) Session {
	session, _ := r.Context().Value(sessionKey{}).(Session)
	return session
}

func New(store storage.Database) *Service {
	return &Service{store: store, attempts: make(map[netip.Addr]int), hashSlots: make(chan struct{}, 2)}
}

func (s *Service) Register(r chi.Router) {
	r.Route("/auth", func(r chi.Router) {
		r.Get("/setup", s.setupStatus)
		r.Post("/setup", s.setup)
		r.Post("/login", s.login)
		r.Group(func(r chi.Router) {
			r.Use(s.Require)
			r.Get("/session", func(w http.ResponseWriter, r *http.Request) {
				httpapi.JSON(w, http.StatusOK, Current(r))
			})
			r.Post("/logout", s.logout)
			r.Get("/sessions", s.sessions)
			r.Put("/password", s.changePassword)
		})
	})
}

func (s *Service) Require(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
			httpapi.Error(w, http.StatusForbidden, "origin_required", "Expected a same-origin browser request")
			return
		}
		cookie, err := r.Cookie(cookieName)
		if err != nil || len(cookie.Value) != 43 {
			unauthorized(w)
			return
		}
		digest := Digest(cookie.Value)
		session, err := s.session(r.Context(), digest)
		if errors.Is(err, sql.ErrNoRows) {
			unauthorized(w)
			return
		}
		if err != nil {
			fail(w, err)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if !httpapi.BrowserOrigin(w, r) {
				return
			}
			if !same(session.Csrf, r.Header.Get("X-CSRF-Token")) {
				httpapi.Error(w, http.StatusForbidden, "csrf_required", "Invalid CSRF token")
				return
			}
		}
		current := Session{UserID: session.UserID, Username: session.Username, CSRF: session.Csrf, ExpiresAt: session.ExpiresAt, Digest: digest}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), sessionKey{}, current)))
	})
}

func (s *Service) session(ctx context.Context, digest string) (controldb.GetBrowserSessionRow, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return controldb.New(s.store.Read).GetBrowserSession(ctx, controldb.GetBrowserSessionParams{
		Digest: digest, ExpiresAt: time.Now().Unix(),
	})
}

func (s *Service) SessionActive(r *http.Request) bool {
	_, err := s.session(r.Context(), Current(r).Digest)
	return err == nil
}

func (s *Service) setupStatus(w http.ResponseWriter, r *http.Request) {
	exists, err := controldb.New(s.store.Read).AdminExists(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	httpapi.JSON(w, http.StatusOK, map[string]bool{"required": !exists})
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Service) setup(w http.ResponseWriter, r *http.Request) {
	var input credentials
	if !httpapi.BrowserOrigin(w, r) || !httpapi.ReadJSON(w, r, &input, 4096) {
		return
	}
	if !usernamePattern.MatchString(input.Username) || !validPassword(input.Password) {
		httpapi.Error(w, http.StatusBadRequest, "invalid_credentials", "Use a 3–48 character username and a password of at least 12 bytes")
		return
	}
	exists, err := controldb.New(s.store.Read).AdminExists(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	if exists {
		httpapi.Error(w, http.StatusConflict, "setup_closed", "Administrator is already initialized")
		return
	}
	if !s.admitHash(w, r) {
		return
	}
	defer s.releaseHash()
	hash := passwordHash(input.Password)
	s.issue(w, r, input.Username, func(ctx context.Context, q *controldb.Queries, now int64) error {
		count, err := q.CreateAdmin(ctx, controldb.CreateAdminParams{Username: input.Username, PasswordHash: hash, CreatedAt: now})
		if err == nil && count == 0 {
			return errInitialized
		}
		return err
	}, "auth.setup")
}

func (s *Service) login(w http.ResponseWriter, r *http.Request) {
	var input credentials
	if !httpapi.BrowserOrigin(w, r) || !httpapi.ReadJSON(w, r, &input, 4096) {
		return
	}
	if len(input.Password) > 256 || len(input.Username) > 48 {
		unauthorized(w)
		return
	}
	if !s.admitHash(w, r) {
		return
	}
	defer s.releaseHash()
	user, err := controldb.New(s.store.Read).GetAdmin(r.Context())
	if errors.Is(err, sql.ErrNoRows) {
		unauthorized(w)
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	if !verifyPassword(user.PasswordHash, input.Password) || !same(user.Username, input.Username) {
		unauthorized(w)
		return
	}
	s.issue(w, r, user.Username, func(ctx context.Context, q *controldb.Queries, _ int64) error {
		current, err := q.GetAdmin(ctx)
		if err == nil && !same(current.PasswordHash, user.PasswordHash) {
			return errCredentials
		}
		return err
	}, "auth.login")
}

func (s *Service) issue(w http.ResponseWriter, r *http.Request, username string,
	validate func(context.Context, *controldb.Queries, int64) error, action string,
) {
	ctx := r.Context()
	value, csrf := secret(), secret()
	digest := Digest(value)
	now := time.Now()
	expiry := now.Add(sessionTTL)
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		if err := validate(ctx, q, now.Unix()); err != nil {
			return err
		}
		if err := q.DeleteExpiredBrowserSessions(ctx, now.Unix()); err != nil {
			return err
		}
		if err := q.CreateBrowserSession(ctx, controldb.CreateBrowserSessionParams{
			Digest: digest, UserID: 1, Csrf: csrf, CreatedAt: now.Unix(), ExpiresAt: expiry.Unix(),
		}); err != nil {
			return err
		}
		if err := q.LimitBrowserSessions(ctx, 1); err != nil {
			return err
		}
		return audit(ctx, q, username, action)
	})
	switch {
	case errors.Is(err, errInitialized):
		httpapi.Error(w, http.StatusConflict, "setup_closed", "Administrator is already initialized")
	case errors.Is(err, errCredentials):
		unauthorized(w)
	case err != nil:
		fail(w, err)
	default:
		writeCookie(w, r, value, int(sessionTTL.Seconds()))
		httpapi.JSON(w, http.StatusOK, Session{UserID: 1, Username: username, CSRF: csrf, ExpiresAt: expiry.Unix()})
	}
}

func (s *Service) logout(w http.ResponseWriter, r *http.Request) {
	session, ctx := Current(r), r.Context()
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		count, err := q.DeleteBrowserSession(ctx, session.Digest)
		if err != nil || count == 0 {
			return err
		}
		return audit(ctx, q, session.Username, "auth.logout")
	})
	if err != nil {
		fail(w, err)
		return
	}
	writeCookie(w, r, "", -1)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) sessions(w http.ResponseWriter, r *http.Request) {
	session := Current(r)
	items, err := controldb.New(s.store.Read).ListBrowserSessions(r.Context(), controldb.ListBrowserSessionsParams{
		CurrentDigest: session.Digest, UserID: session.UserID, Now: time.Now().Unix(),
	})
	if err != nil {
		fail(w, err)
		return
	}
	type entry struct {
		CreatedAt int64 `json:"createdAt"`
		ExpiresAt int64 `json:"expiresAt"`
		Current   bool  `json:"current"`
	}
	entries := make([]entry, 0, len(items))
	for _, item := range items {
		entries = append(entries, entry{item.CreatedAt, item.ExpiresAt, item.IsCurrent})
	}
	httpapi.JSON(w, http.StatusOK, entries)
}

func (s *Service) changePassword(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Current string `json:"currentPassword"`
		New     string `json:"newPassword"`
	}
	if !httpapi.ReadJSON(w, r, &input, 4096) {
		return
	}
	if !validPassword(input.New) || len(input.Current) > 256 {
		httpapi.Error(w, http.StatusBadRequest, "invalid_password", "Password must be 12–256 bytes")
		return
	}
	if !s.admitHash(w, r) {
		return
	}
	defer s.releaseHash()
	ctx, session := r.Context(), Current(r)
	admin, err := controldb.New(s.store.Read).GetAdmin(ctx)
	if err != nil {
		fail(w, err)
		return
	}
	if !verifyPassword(admin.PasswordHash, input.Current) {
		unauthorized(w)
		return
	}
	hash := passwordHash(input.New)
	s.issue(w, r, session.Username, func(ctx context.Context, q *controldb.Queries, now int64) error {
		if _, err := q.GetBrowserSession(ctx, controldb.GetBrowserSessionParams{Digest: session.Digest, ExpiresAt: now}); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return errCredentials
			}
			return err
		}
		count, err := q.ChangeAdminPassword(ctx, controldb.ChangeAdminPasswordParams{NewHash: hash, OldHash: admin.PasswordHash})
		if err != nil {
			return err
		}
		if count == 0 {
			return errCredentials
		}
		return q.DeleteBrowserSessions(ctx, session.UserID)
	}, "auth.password_changed")
}

func (s *Service) admitHash(w http.ResponseWriter, r *http.Request) bool {
	now, addr := time.Now(), httpapi.RequestPeer(r).Address
	s.mu.Lock()
	if !now.Before(s.overall.until) {
		clear(s.attempts)
		s.overall = window{until: now.Add(time.Minute)}
	}
	peer := s.attempts[addr]
	if peer >= 12 || s.overall.count >= 120 {
		retry := max(1, int(time.Until(s.overall.until).Seconds()+1))
		s.mu.Unlock()
		w.Header().Set("Retry-After", strconv.Itoa(retry))
		httpapi.Error(w, http.StatusTooManyRequests, "login_rate_limit", "Too many authentication attempts")
		return false
	}
	s.overall.count++
	s.attempts[addr] = peer + 1
	s.mu.Unlock()
	select {
	case s.hashSlots <- struct{}{}:
		return true
	default:
		w.Header().Set("Retry-After", "1")
		httpapi.Error(w, http.StatusTooManyRequests, "auth_busy", "Authentication is busy")
		return false
	}
}

func (s *Service) releaseHash() { <-s.hashSlots }

func audit(ctx context.Context, q *controldb.Queries, actor, action string) error {
	return q.AppendAudit(ctx, controldb.AppendAuditParams{At: time.Now().UnixMilli(), Actor: actor, Action: action, Details: "{}"})
}

func unauthorized(w http.ResponseWriter) {
	httpapi.Error(w, http.StatusUnauthorized, "unauthorized", "Valid credentials are required")
}

func fail(w http.ResponseWriter, err error) {
	slog.Error("authentication storage", "error", err)
	httpapi.Error(w, http.StatusServiceUnavailable, "storage_unavailable", "Authentication storage unavailable")
}

func writeCookie(w http.ResponseWriter, r *http.Request, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: value, Path: "/", MaxAge: age, HttpOnly: true,
		Secure: httpapi.RequestPeer(r).Secure, SameSite: http.SameSiteStrictMode})
}
