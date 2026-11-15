package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yaho7/QuantBot/internal/config"
)

func TestSandboxExercisesAgentContractInIsolation(t *testing.T) {
	handler := newAuthTestServer(t, config.Config{})
	const origin = "http://127.0.0.1:23456"
	admin, cookie := parseSession(t, requestAuth(t, handler, "POST", "/setup",
		`{"username":"admin","password":"paper-test-password"}`, origin, nil, "", 200))
	call := func(method, path, body, token, key string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, origin+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:12345"
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		} else {
			req.AddCookie(cookie)
			req.Header.Set("Origin", origin)
			req.Header.Set("X-CSRF-Token", admin.CSRF)
		}
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("%s %s returned %d, want %d: %s", method, path, rec.Code, status, rec.Body)
		}
		return rec
	}
	var created struct {
		Strategy   struct{ ID string }
		Credential struct{ ID, Token string }
		Endpoint   string
	}
	decodeTest(t, call("POST", "/api/admin/strategies", `{"name":"Sandbox parent","mode":"live"}`, "", "", 201), &created)
	if created.Endpoint != origin+"/api/agent" || created.Credential.ID == "" {
		t.Fatal("strategy creation must return the endpoint and key ID")
	}
	tokens := "/api/admin/strategies/" + created.Strategy.ID + "/tokens"
	tokenPath := tokens + "/" + created.Credential.ID
	if response := call("GET", tokens, "", "", "", 200); strings.Contains(response.Body.String(), created.Credential.Token) {
		t.Fatal("token list exposed the secret")
	}
	call("POST", tokenPath+"/reveal", "", "not-an-admin", "", 401)
	var revealed struct{ Token string }
	response := call("POST", tokenPath+"/reveal", "", "", "", 200)
	decodeTest(t, response, &revealed)
	if revealed.Token != created.Credential.Token || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("explicit token reveal failed")
	}
	base := "/api/admin/sandbox"
	var sandbox struct {
		ID, Token, Endpoint string
		ExpiresAt           int64
	}
	if opened := call("GET", base, "", "", "", 200); !strings.Contains(opened.Body.String(), `"status":"active"`) || strings.Contains(opened.Body.String(), "qbt_") {
		t.Fatal("creating a strategy did not start the sandbox or revealed its key")
	}
	decodeTest(t, call("POST", base+"/reveal", "", "", "", 200), &sandbox)
	if remain := sandbox.ExpiresAt - time.Now().Unix(); remain < 3595 || remain > 3600 {
		t.Fatal(remain)
	}
	agent := strings.TrimPrefix(sandbox.Endpoint, origin)
	const identity = `{"instanceId":"test-agent","bootId":"test-boot"}`
	call("POST", "/api/agent/session", identity, sandbox.Token, "", 401)
	call("POST", agent+"/session", identity, created.Credential.Token, "", 401)
	var productionSession struct{ Session string }
	decodeTest(t, call("POST", "/api/agent/session", identity, created.Credential.Token, "", 201), &productionSession)
	call("PUT", "/api/agent/heartbeat", "", productionSession.Session, "", 200)
	var replacement struct{ ID, Token string }
	decodeTest(t, call("POST", tokenPath+"/regenerate", "", "", "", 201), &replacement)
	if replacement.ID == created.Credential.ID || replacement.Token == created.Credential.Token {
		t.Fatal("regeneration reused the old credential")
	}
	call("POST", tokenPath+"/reveal", "", "", "", 409)
	call("POST", tokenPath+"/regenerate", "", "", "", 409)
	call("PUT", "/api/agent/heartbeat", "", productionSession.Session, "", 401)
	call("POST", "/api/agent/session", identity, created.Credential.Token, "", 401)
	call("POST", "/api/agent/session", identity, replacement.Token, "", 201)
	var session struct {
		Session  string
		Executor bool
	}
	decodeTest(t, call("POST", agent+"/session", identity, sandbox.Token, "", 201), &session)
	if !session.Executor {
		t.Fatal("Sandbox did not designate its first process")
	}
	tok := session.Session
	call("PUT", agent+"/heartbeat", "", tok, "", 200)
	call("PUT", agent+"/capabilities", `{"revision":0,"capabilities":[
		{"id":"pause","kind":"action","title":"Pause simulate","value_type":"null","writable":true},
		{"id":"signal","kind":"event","title":"Signal","value_type":"object","value_schema":{"type":"object","properties":{"symbol":{"type":"string"}}}},
		{"id":"positions","kind":"resource","title":"Positions","value_type":"object","value_schema":{"type":"object","properties":{"symbol":{"type":"string"}}}}
	]}`, tok, "", 200)
	now := time.Now().UnixMilli()
	call("PUT", agent+"/state", fmt.Sprintf(`{"revision":1,"states":[{"id":"pause","observedAt":%d,"value":null}]}`, now), tok, "", 200)
	call("POST", agent+"/reports", fmt.Sprintf(`{"records":[{"id":"status","kind":"status","observedAt":%d,"data":{"state":"running"}}]}`, now), tok, "", 200)
	call("POST", agent+"/events", fmt.Sprintf(`{"revision":1,"records":[{"id":"signal","capabilityId":"signal","observedAt":%d,"value":{"symbol":"BTC"}}]}`, now), tok, "", 200)
	call("PUT", agent+"/resources/positions", fmt.Sprintf(`{"revision":1,"resourceRevision":0,"mode":"snapshot","observedAt":%d,"items":[]}`, now), tok, "snapshot", 200)
	call("GET", base+"/controls", "", "", "", 200)
	var cmd struct{ ID string }
	decodeTest(t, call("POST", base+"/commands", `{"controlId":"pause","revision":1,"input":null}`, "", "sandbox-command", 201), &cmd)
	if got := call("GET", agent+"/commands?wait=0", "", tok, "", 200); !strings.Contains(got.Body.String(), cmd.ID) {
		t.Fatal(got.Body)
	}
	var grant struct{ Permit string }
	decodeTest(t, call("POST", agent+"/commands/"+cmd.ID+"/claim", "", tok, "sandbox-claim", 200), &grant)
	call("POST", agent+"/commands/"+cmd.ID+"/result", fmt.Sprintf(`{"status":"succeeded","permit":%q}`, grant.Permit), tok, "", 200)
	status := call("GET", base, "", "", "", 200)
	if !strings.Contains(status.Body.String(), `"passed":true`) || strings.Contains(status.Body.String(), tok) || strings.Contains(status.Body.String(), grant.Permit) {
		t.Fatal(status.Body)
	}
	production := call("GET", "/api/strategies/"+created.Strategy.ID+"/controls", "", "", "", 200)
	if !strings.Contains(production.Body.String(), `"revision":0`) {
		t.Fatal(production.Body)
	}
	call("GET", "/api/commands/"+cmd.ID, "", "", "", 404)
	call(http.MethodPut, base, "", "", "", 200)
	// More strategies and opening the test again must reuse the active
	// environment and leave the existing test connection intact.
	call("POST", "/api/admin/strategies", `{"name":"Another strategy","mode":"paper"}`, "", "", 201)
	call("POST", base, "", "", "", 200)
	var reused struct{ ID, Token string }
	decodeTest(t, call("POST", base+"/reveal", "", "", "", 200), &reused)
	if reused.ID != sandbox.ID || reused.Token != sandbox.Token {
		t.Fatal("starting again replaced the shared sandbox")
	}
	call("PUT", agent+"/heartbeat", "", tok, "", 200)
	call("DELETE", base, "", "", "", 204)
	call("POST", agent+"/session", identity, sandbox.Token, "", 401)
	if revoked := call("GET", base, "", "", "", 200); !strings.Contains(revoked.Body.String(), `"status":"revoked"`) {
		t.Fatal(revoked.Body)
	}
	call("POST", base, "", "", "", 200)
	var reopened struct{ ID, Token string }
	decodeTest(t, call("POST", base+"/reveal", "", "", "", 200), &reopened)
	if reopened.ID == sandbox.ID || reopened.Token == sandbox.Token {
		t.Fatal("a new sandbox must use a fresh credential")
	}
}
