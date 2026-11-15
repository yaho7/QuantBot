package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/command"
	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/hostperf"
	"github.com/yaho7/QuantBot/internal/notification"
	"github.com/yaho7/QuantBot/internal/realtime"
	"github.com/yaho7/QuantBot/internal/sandbox"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/telemetry"
	"github.com/yaho7/QuantBot/internal/theme"
)

func TestAdministratorLifecycle(t *testing.T) {
	handler := newAuthTestServer(t, config.Config{})
	const origin = "http://127.0.0.1:23456"
	const credentials = `{"username":"admin","password":"paper-test-password"}`
	const newPassword = `{"currentPassword":"paper-test-password","newPassword":"new-paper-test-password"}`

	result := requestAuth(t, handler, "GET", "/setup", "", "", nil, "", 200)
	if !strings.Contains(result.Body.String(), `"required":true`) {
		t.Fatal("setup did not start in required state")
	}
	requestAuth(t, handler, "POST", "/setup", credentials, "http://wrong.invalid", nil, "", 403)
	requestAuth(t, handler, "POST", "/setup", `{"username":"admin","Username":"other","password":"paper-test-password"}`, origin, nil, "", 400)
	result = requestAuth(t, handler, "POST", "/setup", credentials, origin, nil, "", 200)
	first, cookie := parseSession(t, result)
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.Secure || cookie.Path != "/" {
		t.Fatalf("invalid localhost cookie settings: %#v", cookie)
	}
	requestAuth(t, handler, "POST", "/setup", credentials, origin, nil, "", 409)
	requestAuth(t, handler, "GET", "/session", "", "", nil, "", 401)
	requestAuth(t, handler, "GET", "/session", "", "", cookie, "", 200)
	requestAuth(t, handler, "POST", "/logout", "", origin, cookie, "incorrect-csrf", 403)
	requestAuth(t, handler, "POST", "/logout", "", "http://wrong.invalid", cookie, first.CSRF, 403)
	_, other := parseSession(t, requestAuth(t, handler, "POST", "/login", credentials, origin, nil, "", 200))
	list := requestAuth(t, handler, "GET", "/sessions", "", "", cookie, "", 200)
	if !strings.Contains(list.Body.String(), `"current":true`) || !strings.Contains(list.Body.String(), `"current":false`) {
		t.Fatalf("expected both sessions and one current flag: %s", list.Body.String())
	}
	latest, current := parseSession(t, requestAuth(t, handler, "PUT", "/password", newPassword, origin, cookie, first.CSRF, 200))
	requestAuth(t, handler, "GET", "/session", "", "", cookie, "", 401)
	requestAuth(t, handler, "GET", "/session", "", "", other, "", 401)
	requestAuth(t, handler, "POST", "/login", credentials, origin, nil, "", 401)
	requestAuth(t, handler, "POST", "/logout", "", origin, current, latest.CSRF, 204)
	requestAuth(t, handler, "GET", "/session", "", "", current, "", 401)
}

func TestPublicTransportRequiresTrustedProxyAndHost(t *testing.T) {
	handler := newAuthTestServer(t, config.Config{
		PublicOrigin:   "https://quantbot.example",
		TrustedProxies: []netip.Prefix{netip.MustParsePrefix("192.0.2.10/32")},
	})
	send := func(peer, host, proto string, expected int) {
		t.Helper()
		request := httptest.NewRequest("POST", "http://"+host+"/api/auth/setup",
			strings.NewReader(`{"username":"admin","password":"paper-test-password"}`))
		request.RemoteAddr = peer + ":12345"
		request.Header.Set("Origin", "https://"+host)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Forwarded-Proto", proto)
		request.Header.Set("X-Forwarded-For", "127.0.0.1, 203.0.113.10")
		result := httptest.NewRecorder()
		handler.ServeHTTP(result, request)
		if result.Code != expected {
			t.Fatalf("peer=%s host=%s proto=%s: got %d want %d (%s)", peer, host, proto, result.Code, expected, result.Body)
		}
		if expected == 200 {
			_, cookie := parseSession(t, result)
			if !cookie.Secure {
				t.Fatal("proxy-issued cookie must be Secure")
			}
		}
	}
	send("192.0.2.11", "quantbot.example", "https", 403)
	send("192.0.2.10", "other.example", "https", 403)
	send("192.0.2.10", "quantbot.example", "http", 403)
	send("192.0.2.10", "quantbot.example", "https", 200)
}

func TestProfilingRequiresOptInAndAdministratorSession(t *testing.T) {
	const origin = "http://127.0.0.1:23456"
	const path = "/api/admin/pprof/heap"
	for _, enabled := range []bool{false, true} {
		handler := newAuthTestServer(t, config.Config{Profiling: enabled})
		_, cookie := parseSession(t, requestAuth(t, handler, "POST", "/setup",
			`{"username":"admin","password":"paper-test-password"}`, origin, nil, "", 200))
		for _, test := range []struct {
			cookie *http.Cookie
			status int
		}{{nil, 404}, {cookie, 404}} {
			if enabled {
				test.status = 401
				if test.cookie != nil {
					test.status = 200
				}
			}
			req := httptest.NewRequest("GET", origin+path, nil)
			req.RemoteAddr = "127.0.0.1:12345"
			if test.cookie != nil {
				req.AddCookie(test.cookie)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != test.status {
				t.Errorf("enabled=%t authenticated=%t: got %d want %d", enabled, test.cookie != nil, rec.Code, test.status)
			}
		}
	}
}

func TestDockerLoopbackRequiresBridgePeerAndLocalHost(t *testing.T) {
	handler := newAuthTestServer(t, config.Config{LoopbackGateway: netip.MustParseAddr("172.18.0.1")})
	for _, test := range []struct {
		peer, host, forwarded string
		status                int
	}{
		{"172.18.0.1", "localhost:8888", "", 200},
		{"172.18.0.1", "127.0.0.1:8888", "", 200},
		{"172.18.0.2", "localhost:8888", "", 403},
		{"172.18.0.1", "quantbot.example", "", 403},
		{"172.18.0.1", "localhost:8888", "203.0.113.10", 403},
	} {
		req := httptest.NewRequest("GET", "http://"+test.host+"/api/auth/setup", nil)
		req.RemoteAddr = test.peer + ":12345"
		if test.forwarded != "" {
			req.Header.Set("X-Forwarded-For", test.forwarded)
		}
		result := httptest.NewRecorder()
		handler.ServeHTTP(result, req)
		if result.Code != test.status {
			t.Errorf("peer=%s host=%s: got %d want %d", test.peer, test.host, result.Code, test.status)
		}
	}
}

func TestLoginRateLimit(t *testing.T) {
	handler := newAuthTestServer(t, config.Config{})
	for range 12 {
		requestAuth(t, handler, "POST", "/login", `{"username":"admin","password":"bad"}`,
			"http://127.0.0.1:23456", nil, "", 401)
	}
	result := requestAuth(t, handler, "POST", "/login", `{"username":"admin","password":"bad"}`,
		"http://127.0.0.1:23456", nil, "", 429)
	if result.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After")
	}
}

func newAuthTestServer(t *testing.T, cfg config.Config) http.Handler {
	t.Helper()
	stores, err := storage.Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stores.Close() })
	return testRoutes(t, stores, cfg, command.New(stores.Control, t.Context(), cfg.CommandPoll, nil))
}

func testRoutes(t *testing.T, stores *storage.Stores, cfg config.Config, commands *command.Service) http.Handler {
	t.Helper()
	reports, err := telemetry.New(stores, telemetry.QueueConfig{Capacity: 4, Batch: 4, Flush: time.Millisecond}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reports.Close)
	themes, err := theme.New(stores.Control, t.TempDir(), "3.0.0")
	if err != nil {
		t.Fatal(err)
	}
	sandboxes := sandbox.New(t.Context())
	t.Cleanup(sandboxes.Close)
	return routes(stores, cfg, commands, reports, realtime.New(), notification.New(stores.Control, [32]byte{}), themes, sandboxes, hostperf.New(stores), [32]byte{})
}

func requestAuth(t *testing.T, handler http.Handler, method, path, body, origin string, cookie *http.Cookie, csrf string, expected int) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "http://127.0.0.1:23456/api/auth"+path, strings.NewReader(body))
	request.RemoteAddr = "127.0.0.1:12345"
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	if cookie != nil {
		request.AddCookie(cookie)
	}
	if csrf != "" {
		request.Header.Set("X-CSRF-Token", csrf)
	}
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, request)
	if result.Code != expected {
		t.Fatalf("%s %s: got %d, want %d (%s)", method, path, result.Code, expected, result.Body)
	}
	return result
}

func parseSession(t *testing.T, result *httptest.ResponseRecorder) (auth.Session, *http.Cookie) {
	t.Helper()
	var response auth.Session
	if err := json.Unmarshal(result.Body.Bytes(), &response); err != nil || response.CSRF == "" {
		t.Fatalf("invalid session JSON: %v", err)
	}
	cookies := result.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected one session cookie, got %d", len(cookies))
	}
	return response, cookies[0]
}
