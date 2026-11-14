package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/storage"
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
		request := httptest.NewRequest("POST", "http://"+host+"/api/v1/auth/setup",
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
	return routes(stores, cfg)
}

func requestAuth(t *testing.T, handler http.Handler, method, path, body, origin string, cookie *http.Cookie, csrf string, expected int) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "http://127.0.0.1:23456/api/v1/auth"+path, strings.NewReader(body))
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
