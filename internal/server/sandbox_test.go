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
		Credential struct{ Token string }
	}
	decodeTest(t, call("POST", "/api/admin/strategies", `{"name":"Sandbox parent","mode":"live"}`, "", "", 201), &created)
	base := "/api/admin/strategies/" + created.Strategy.ID + "/sandbox"
	var sandbox struct {
		ID, Token, Endpoint string
		ExpiresAt           int64
	}
	decodeTest(t, call("POST", base, "", "", "", 201), &sandbox)
	if remain := sandbox.ExpiresAt - time.Now().Unix(); remain < 3595 || remain > 3600 {
		t.Fatal(remain)
	}
	agent := strings.TrimPrefix(sandbox.Endpoint, origin)
	const identity = `{"instanceId":"test-agent","bootId":"test-boot"}`
	call("POST", "/api/agent/session", identity, sandbox.Token, "", 401)
	call("POST", agent+"/session", identity, created.Credential.Token, "", 401)
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
	var replacement struct{ Token string }
	decodeTest(t, call("POST", base, "", "", "", 201), &replacement)
	call("PUT", agent+"/heartbeat", "", tok, "", 401)
	call("POST", agent+"/session", identity, sandbox.Token, "", 401)
	call("POST", agent+"/session", identity, replacement.Token, "", 201)
	call("DELETE", base, "", "", "", 204)
	call("POST", agent+"/session", identity, replacement.Token, "", 401)
	if revoked := call("GET", base, "", "", "", 200); !strings.Contains(revoked.Body.String(), `"status":"revoked"`) {
		t.Fatal(revoked.Body)
	}
}
