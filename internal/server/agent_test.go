package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yaho7/QuantBot/internal/config"
)

func TestStrategyAndAgentIdentity(t *testing.T) {
	handler := newAuthTestServer(t, config.Config{})
	const origin = "http://127.0.0.1:23456"
	const bootA = `{"instanceId":"executor","bootId":"boot-a"}`
	const bootB = `{"instanceId":"executor","bootId":"boot-b"}`
	setup, cookie := parseSession(t, requestAuth(t, handler, "POST", "/setup",
		`{"username":"admin","password":"paper-test-password"}`, origin, nil, "", 200))
	send := func(method, path, body, bearer string, expected int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, origin+apiPath(path), strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:10000"
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if strings.HasPrefix(path, "/agent") {
			req.Header.Set("Authorization", "Bearer "+bearer)
		} else {
			req.Header.Set("Origin", origin)
			req.Header.Set("X-CSRF-Token", setup.CSRF)
			req.AddCookie(cookie)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != expected {
			t.Fatalf("%s %s: got %d, want %d (%s)", method, path, rec.Code, expected, rec.Body)
		}
		return rec
	}
	created := send("POST", "/admin/strategies", `{"name":"Paper strategy","group":"Research","mode":"paper"}`, "", 201)
	var response struct {
		Strategy   struct{ ID string }
		Credential struct{ ID, Token string }
	}
	if err := json.Unmarshal(created.Body.Bytes(), &response); err != nil || response.Strategy.ID == "" || response.Credential.Token == "" {
		t.Fatalf("missing strategy or credential: %v", err)
	}
	admin := "/admin/strategies/" + response.Strategy.ID
	tokens := send("GET", admin+"/tokens", "", "", 200)
	if strings.Contains(tokens.Body.String(), response.Credential.Token) {
		t.Fatal("token list disclosed plaintext")
	}
	connect := func(body, token string) (string, bool) {
		t.Helper()
		rec := send("POST", "/agent/session", body, token, 201)
		var result struct {
			Session            string
			Executor           bool
			ExpiresAt, RenewAt int64
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil || result.Session == "" {
			t.Fatalf("invalid Agent session: %v", err)
		}
		if result.ExpiresAt < time.Now().Add(time.Hour-5*time.Second).Unix() || result.ExpiresAt-result.RenewAt != 600 {
			t.Fatalf("unexpected session schedule: expiry=%d renewal=%d", result.ExpiresAt, result.RenewAt)
		}
		return result.Session, result.Executor
	}
	sessionA, executor := connect(bootA, response.Credential.Token)
	if executor {
		t.Fatal("unassigned agent was made executor")
	}
	send("PUT", admin+"/executor", `{"instanceId":"executor"}`, "", 204)
	send("PUT", "/agent/heartbeat", "", sessionA, 200)
	sessionB, executor := connect(bootB, response.Credential.Token)
	if !executor {
		t.Fatal("designated instance did not become executor")
	}
	send("PUT", "/agent/heartbeat", "", sessionA, 401)
	send("POST", "/agent/session", bootA, response.Credential.Token, 409)
	send("PUT", "/agent/heartbeat", "", sessionB, 200)
	send("PUT", admin+"/tokens/"+response.Credential.ID, `{"scopes":["command","control","report"]}`, "", 204)
	if missing := send("PUT", "/agent/heartbeat", "", sessionB, 403); !strings.Contains(missing.Body.String(), "insufficient_scope") {
		t.Fatal(missing.Body)
	}
	send("PUT", admin+"/tokens/"+response.Credential.ID, `{"scopes":["command","control","report","heartbeat"]}`, "", 204)
	send("PUT", "/agent/heartbeat", "", sessionB, 200)
	const registry = `{"revision":0,"capabilities":[{"id":"entry","kind":"parameter","value_type":"boolean","writable":true,"title":"Allow entry","risk":"high"},{"id":"size","kind":"parameter","value_type":"decimal","writable":true,"title":"Size","constraints":{"min":"0.1","max":"1.0","step":"0.1"}}]}`
	send("PUT", "/agent/capabilities", registry, sessionA, 401)
	send("PUT", "/agent/capabilities", registry, sessionB, 200)
	duplicate := send("PUT", "/agent/capabilities", registry, sessionB, 200)
	if !strings.Contains(duplicate.Body.String(), `"revision":1`) {
		t.Fatal("identical retry changed registry revision")
	}
	send("PUT", "/agent/capabilities", `{"revision":0,"capabilities":[]}`, sessionB, 409)
	now := time.Now().UnixMilli()
	send("PUT", "/agent/state", fmt.Sprintf(`{"revision":1,"states":[{"id":"size","available":true,"observedAt":%d,"value":"0.25"}]}`, now), sessionB, 400)
	actual := fmt.Sprintf(`{"revision":1,"states":[{"id":"entry","available":false,"reason":"risk lock","observedAt":%d,"value":false},{"id":"size","available":true,"observedAt":%d,"value":"0.2"}]}`, now, now)
	send("PUT", "/agent/state", actual, sessionB, 200)
	duplicate = send("PUT", "/agent/state", actual, sessionB, 200)
	if !strings.Contains(duplicate.Body.String(), `"duplicate":2`) {
		t.Fatal("identical state retry was not deduplicated")
	}
	view := send("GET", "/strategies/"+response.Strategy.ID+"/controls", "", "", 200)
	if !strings.Contains(view.Body.String(), `"current":true`) || !strings.Contains(view.Body.String(), `"reason":"risk lock"`) {
		t.Fatalf("control view lost actual state: %s", view.Body)
	}
	send("PUT", "/agent/heartbeat", "", response.Credential.Token, 401)
	send("DELETE", admin+"/tokens/"+response.Credential.ID, "", "", 204)
	if revoked := send("PUT", "/agent/heartbeat", "", sessionB, 401); !strings.Contains(revoked.Body.String(), "agent_token_revoked") {
		t.Fatal(revoked.Body)
	}
	view = send("GET", "/strategies/"+response.Strategy.ID+"/controls", "", "", 200)
	if !strings.Contains(view.Body.String(), `"current":false`) {
		t.Fatal("revoked executor remains current")
	}

	newToken := send("POST", admin+"/tokens", `{"label":"report only","scopes":["report"]}`, "", 201)
	var scoped struct{ Token string }
	if err := json.Unmarshal(newToken.Body.Bytes(), &scoped); err != nil || scoped.Token == "" {
		t.Fatalf("invalid scoped credential: %v", err)
	}
	reportSession, executor := connect(bootB, scoped.Token)
	if executor {
		t.Fatal("report-only credential acquired executor authority")
	}
	send("PUT", "/agent/heartbeat", "", reportSession, 403)
	send("DELETE", admin, "", "", 204)
	send("POST", "/agent/session", bootB, scoped.Token, 401)
	list := send(http.MethodGet, "/strategies", "", "", 200)
	if strings.TrimSpace(list.Body.String()) != "[]" {
		t.Fatal("workbench lists archived strategy")
	}
	list = send(http.MethodGet, "/admin/strategies", "", "", 200)
	if !strings.Contains(list.Body.String(), response.Strategy.ID) {
		t.Fatal("archiving removed strategy history")
	}
}

func TestConfiguredAgentSessionTTL(t *testing.T) {
	handler := newAuthTestServer(t, config.Config{AgentSessionTTL: 6 * time.Minute})
	const origin = "http://127.0.0.1:23456"
	setup, cookie := parseSession(t, requestAuth(t, handler, "POST", "/setup",
		`{"username":"admin","password":"paper-test-password"}`, origin, nil, "", 200))
	req := httptest.NewRequest(http.MethodPost, origin+"/api/admin/strategies", strings.NewReader(`{"name":"TTL","mode":"paper"}`))
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", origin)
	req.Header.Set("X-CSRF-Token", setup.CSRF)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != 201 {
		t.Fatal(rec.Body)
	}
	var created struct{ Credential struct{ Token string } }
	decodeTest(t, rec, &created)
	req = httptest.NewRequest(http.MethodPost, origin+"/api/agent/session", strings.NewReader(`{"instanceId":"worker","bootId":"boot"}`))
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+created.Credential.Token)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != 201 {
		t.Fatal(rec.Body)
	}
	var session struct{ ExpiresAt, RenewAt, LastSeen int64 }
	decodeTest(t, rec, &session)
	if session.ExpiresAt-session.LastSeen != 360 || session.ExpiresAt-session.RenewAt != 180 {
		t.Fatalf("unexpected short session: %+v", session)
	}
}

func apiPath(path string) string {
	if strings.HasPrefix(path, "/agent/") {
		return "/api" + path
	}
	return "/api" + path
}
