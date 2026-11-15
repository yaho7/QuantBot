package sandbox

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

const keyTTL = time.Hour
const sandboxStrategy = "sandbox"
const globalInflight = 12
const runInflight = 3
const eventLimit = 80
const bodyLimit = 64 << 10

type requestLog struct {
	Step   string `json:"step"`
	Status int    `json:"status"`
	At     int64  `json:"at"`
}

type info struct {
	ID        string       `json:"id"`
	ExpiresAt int64        `json:"expiresAt"`
	Status    string       `json:"status"`
	Requests  []requestLog `json:"requests"`
	Passed    bool         `json:"passed"`
}

type window struct {
	minute int64
	count  int
}

func (w *window) allow(now time.Time, max int) bool {
	minute := now.Unix() / 60
	if w.minute != minute {
		w.minute, w.count = minute, 0
	}
	if w.count >= max {
		return false
	}
	w.count++
	return true
}

type Service struct {
	ctx      context.Context
	mu       sync.Mutex
	active   *run
	previous info
	inflight int
	overall  window
	closing  bool
}

func New(ctx context.Context) *Service {
	return &Service{ctx: ctx}
}

func (s *Service) Maintain(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.expire(now)
		}
	}
}

func (s *Service) expire(now time.Time) {
	s.mu.Lock()
	active := s.active
	expired := active != nil && active.ExpiresAt <= now.Unix()
	if expired {
		s.detach("expired")
	}
	s.mu.Unlock()
	if expired {
		active.close()
	}
}

// detach runs under the service lock. New requests cannot acquire a detached run.
func (s *Service) detach(status string) {
	active := s.active
	s.active = nil
	active.cancel()
	s.previous = active.info
	s.previous.Status = status
}

func (s *Service) Close() {
	s.mu.Lock()
	s.closing = true
	active := s.active
	if active != nil {
		s.detach("closed")
	}
	s.mu.Unlock()
	if active != nil {
		active.close()
	}
}

func (s *Service) RegisterBrowser(r chi.Router) {
	const path = "/admin/sandbox"
	r.Get(path, s.status)
	r.Post(path, s.create)
	r.Post(path+"/reveal", s.reveal)
	r.Put(path, s.extend)
	r.Delete(path, s.revoke)
	r.Get(path+"/controls", s.browser)
	r.Get(path+"/commands", s.browser)
	r.Post(path+"/commands", s.browser)
	r.Post(path+"/commands/{command}/confirm", s.browser)
}

func (s *Service) status(w http.ResponseWriter, r *http.Request) {
	s.expire(time.Now())
	s.mu.Lock()
	view := s.previous
	endpoint := ""
	if active := s.active; active != nil {
		view = active.info
		endpoint = sandboxEndpoint(r, active.ID)
	}
	view.Requests = append([]requestLog{}, view.Requests...)
	s.mu.Unlock()
	if view.ID == "" {
		view.Status = "inactive"
	}
	httpapi.JSON(w, 200, struct {
		info
		Endpoint string `json:"endpoint,omitempty"`
	}{view, endpoint})
}

func sandboxEndpoint(r *http.Request, id string) string {
	return httpapi.RequestPeer(r).Origin + "/api/agent/sandbox/" + id
}

// Ensure opens the shared test environment on demand. Opening it again does
// not rotate an active key, erase a running test, or extend its lifetime.
func (s *Service) Ensure(ctx context.Context) error {
	now := time.Now()
	s.expire(now)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return context.Canceled
	}
	if s.active != nil {
		return nil
	}
	var entropy [32]byte
	rand.Read(entropy[:])
	var route [16]byte
	rand.Read(route[:])
	id := base64.RawURLEncoding.EncodeToString(route[:])
	token := "qbt_" + base64.RawURLEncoding.EncodeToString(entropy[:])
	active, err := newRun(ctx, s.ctx, id, sandboxStrategy, "Sandbox", token, now)
	if err != nil {
		return err
	}
	s.active = active
	s.previous = info{}
	return nil
}

func (s *Service) create(w http.ResponseWriter, r *http.Request) {
	if err := s.Ensure(r.Context()); err != nil {
		unavailable(w, err)
		return
	}
	s.status(w, r)
}

func (s *Service) reveal(w http.ResponseWriter, r *http.Request) {
	s.expire(time.Now())
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == nil {
		httpapi.Error(w, 404, "sandbox_inactive", "No active Sandbox")
		return
	}
	httpapi.JSON(w, 200, struct {
		ID        string `json:"id"`
		Endpoint  string `json:"endpoint"`
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expiresAt"`
	}{s.active.ID, sandboxEndpoint(r, s.active.ID), s.active.key, s.active.ExpiresAt})
}

func (s *Service) extend(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	s.expire(now)
	s.mu.Lock()
	defer s.mu.Unlock()
	active := s.active
	if active == nil {
		httpapi.Error(w, 404, "sandbox_inactive", "No active Sandbox")
		return
	}
	end := now.Add(keyTTL).Unix()
	if err := active.extend(r.Context(), end); err != nil {
		unavailable(w, err)
		return
	}
	active.ExpiresAt = end
	httpapi.JSON(w, 200, active.info)
}

func (s *Service) revoke(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	active := s.active
	if active != nil {
		s.detach("revoked")
	}
	s.mu.Unlock()
	if active != nil {
		active.close()
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Service) RegisterAgent(r chi.Router) {
	r.Handle("/sandbox/{sandboxID}/*", http.HandlerFunc(s.agent))
}

func (s *Service) agent(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	id := chi.URLParam(r, "sandboxID")
	var active *run
	s.mu.Lock()
	current := s.active
	if current == nil || current.ID != id || current.ExpiresAt <= now.Unix() || s.closing {
		s.mu.Unlock()
		httpapi.Error(w, 401, "sandbox_inactive", "Sandbox key is expired or the environment was closed")
		return
	}
	if s.inflight >= globalInflight || current.inflight >= runInflight ||
		!s.overall.allow(now, 600) || !current.requests.allow(now, 120) {
		s.mu.Unlock()
		rateLimited(w, "Sandbox request limit reached", 1)
		return
	}
	active = current
	s.inflight++
	active.inflight++
	active.users.Add(1)
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.inflight--
		active.inflight--
		s.mu.Unlock()
		active.users.Done()
	}()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stop := context.AfterFunc(active.ctx, cancel)
	defer stop()
	path := "/" + chi.URLParam(r, "*")
	cloned := forwarded(r.WithContext(ctx), path)
	cloned.Body = http.MaxBytesReader(w, r.Body, bodyLimit)
	if r.ContentLength > bodyLimit {
		httpapi.Error(w, 413, "body_too_large", "Sandbox request exceeds 64 KiB")
		return
	}
	capture := &statusWriter{ResponseWriter: w, status: 200}
	active.agent.ServeHTTP(capture, cloned)
	step := stepFor(r.Method, path)
	if step == "" || capture.status == 401 {
		return
	}
	passed := capture.status >= 200 && capture.status < 300
	if step == "result" && passed {
		commandID := strings.TrimSuffix(strings.TrimPrefix(path, "/commands/"), "/result")
		cmd, err := controldb.New(active.stores.Control.Read).GetCommand(ctx, commandID)
		passed = err == nil && cmd.Status == "succeeded"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active != active {
		return
	}
	active.Requests = append(active.Requests, requestLog{Step: step, Status: capture.status, At: time.Now().UnixMilli()})
	if len(active.Requests) > eventLimit {
		active.Requests = active.Requests[len(active.Requests)-eventLimit:]
	}
	if passed {
		active.checked[step] = true
		active.Passed = true
		for _, required := range []string{"session", "heartbeat", "capabilities", "state", "reports", "events", "resources", "poll", "claim", "result"} {
			if !active.checked[required] {
				active.Passed = false
				break
			}
		}
	}
}

func stepFor(method, path string) string {
	switch path {
	case "/session", "/reports", "/events":
		if method == http.MethodPost {
			return strings.TrimPrefix(path, "/")
		}
	case "/heartbeat", "/capabilities", "/state":
		if method == http.MethodPut {
			return strings.TrimPrefix(path, "/")
		}
	case "/commands":
		if method == "GET" {
			return "poll"
		}
	}
	if strings.HasPrefix(path, "/resources/") && method == "PUT" {
		return "resources"
	}
	if strings.HasPrefix(path, "/commands/") && method == "POST" {
		if strings.HasSuffix(path, "/claim") {
			return "claim"
		}
		if strings.HasSuffix(path, "/result") {
			return "result"
		}
	}
	return ""
}

func (s *Service) browser(w http.ResponseWriter, r *http.Request) {
	id := sandboxStrategy
	s.mu.Lock()
	active := s.active
	if active == nil || active.ExpiresAt <= time.Now().Unix() || s.closing {
		s.mu.Unlock()
		httpapi.Error(w, 404, "sandbox_inactive", "No active Sandbox")
		return
	}
	active.users.Add(1)
	s.mu.Unlock()
	defer active.users.Done()
	path := "/browser/strategies/" + url.PathEscape(id) + "/controls"
	switch {
	case strings.HasSuffix(r.URL.Path, "/confirm"):
		path = "/browser/commands/" + url.PathEscape(chi.URLParam(r, "command")) + "/confirm"
	case strings.HasSuffix(r.URL.Path, "/commands"):
		if r.Method == http.MethodGet {
			path = "/browser/commands"
		} else {
			path = "/browser/strategies/" + url.PathEscape(id) + "/commands"
		}
	}
	active.console.ServeHTTP(w, forwarded(r, path))
}

func forwarded(r *http.Request, path string) *http.Request {
	ctx := context.WithValue(r.Context(), chi.RouteCtxKey, (*chi.Context)(nil))
	clone := r.Clone(ctx)
	clone.URL.Path, clone.URL.RawPath = path, ""
	return clone
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func rateLimited(w http.ResponseWriter, reason string, seconds int) {
	if seconds > 1 {
		w.Header().Set("Retry-After", "5")
	} else {
		w.Header().Set("Retry-After", "1")
	}
	httpapi.Error(w, 429, "sandbox_limit", reason)
}
func unavailable(w http.ResponseWriter, err error) {
	slog.Error("Sandbox operation", "error", err)
	httpapi.Error(w, 503, "sandbox_unavailable", "Sandbox is unavailable")
}
