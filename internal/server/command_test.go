package server

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yaho7/QuantBot/internal/command"
	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/storage"
)

func TestCommandPermitRaceAndRestart(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()
	stores, err := storage.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stores.Close() }()
	cfg := config.Config{CommandPoll: 2 * time.Second}
	service := command.New(stores.Control, ctx, cfg.CommandPoll, nil)
	handler := testRoutes(t, stores, cfg, service)
	const origin = "http://127.0.0.1:23456"
	setup, cookie := parseSession(t, requestAuth(t, handler, "POST", "/setup",
		`{"username":"admin","password":"paper-test-password"}`, origin, nil, "", 200))

	request := func(method, path, body, token, key string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, origin+apiPath(path), strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:40000"
		if strings.HasPrefix(path, "/agent/") {
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Idempotency-Key", key)
		} else {
			req.Header.Set("Origin", origin)
			req.Header.Set("X-CSRF-Token", setup.CSRF)
			req.Header.Set("Idempotency-Key", key)
			req.AddCookie(cookie)
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	send := func(method, path, body, token, key string, status int) *httptest.ResponseRecorder {
		t.Helper()
		rec := request(method, path, body, token, key)
		if rec.Code != status {
			t.Fatalf("%s %s: got %d, want %d (%s)", method, path, rec.Code, status, rec.Body)
		}
		return rec
	}

	var created struct {
		Strategy   struct{ ID string }
		Credential struct{ ID, Token string }
	}
	decodeTest(t, send("POST", "/admin/strategies", `{"name":"Receipt test","mode":"live"}`, "", "", 201), &created)
	strategyPath := "/strategies/" + created.Strategy.ID
	var agent struct{ Session string }
	decodeTest(t, send("POST", "/agent/session", `{"instanceId":"worker","bootId":"boot-1"}`, created.Credential.Token, "", 201), &agent)
	send("PUT", "/admin"+strategyPath+"/executor", `{"instanceId":"worker"}`, "", "", 204)
	send("PUT", "/agent/capabilities", `{"revision":0,"capabilities":[{"id":"entry","kind":"parameter","value_type":"boolean","writable":true,"title":"Allow entries"}]}`, agent.Session, "", 200)
	actual := fmt.Sprintf(`{"revision":1,"states":[{"id":"entry","value":false,"available":true,"observedAt":%d}]}`, time.Now().UnixMilli())
	send("PUT", "/agent/state", actual, agent.Session, "", 200)

	const intent = `{"controlId":"entry","revision":1,"input":true}`
	var first struct{ ID, Status string }
	decodeTest(t, send("POST", strategyPath+"/commands", intent, "", "request-1", 201), &first)
	if first.ID == "" || first.Status != "confirmation_required" {
		t.Fatalf("live action lacked confirmation: %+v", first)
	}
	base := "/commands/" + first.ID
	agentBase := "/agent" + base
	send("POST", strategyPath+"/commands", intent, "", "request-1", 200)
	send("POST", strategyPath+"/commands", strings.Replace(intent, "true", "false", 1), "", "request-1", 409)
	send("POST", agentBase+"/claim", "", agent.Session, "claim-key", 409)
	send("POST", base+"/confirm", "", "", "", 200)
	send("POST", base+"/confirm", "", "", "", 200)
	poll := send("GET", "/agent/commands?wait=0", "", agent.Session, "", 200)
	if !strings.Contains(poll.Body.String(), first.ID) {
		t.Fatal("confirmed command was not offered")
	}

	var racers sync.WaitGroup
	results := make(chan *httptest.ResponseRecorder, 16)
	for index := range cap(results) {
		racers.Go(func() {
			key := fmt.Sprintf("race-%d", index)
			response := request("POST", agentBase+"/claim", "", agent.Session, key)
			response.Header().Set("X-Test-Key", key)
			results <- response
		})
	}
	racers.Wait()
	close(results)
	var permit, winningKey string
	success := 0
	for result := range results {
		switch result.Code {
		case 200:
			var grant struct{ Permit string }
			decodeTest(t, result, &grant)
			permit = grant.Permit
			winningKey = result.Header().Get("X-Test-Key")
			success++
		case 409:
		default:
			t.Fatalf("unexpected claim response %d: %s", result.Code, result.Body)
		}
	}
	if success != 1 || permit == "" {
		t.Fatalf("got %d execution grants", success)
	}
	previous := agent.Session
	decodeTest(t, send("POST", "/agent/session", `{"instanceId":"worker","bootId":"boot-1"}`, created.Credential.Token, "", 201), &agent)
	if previous == agent.Session {
		t.Fatal("renewal did not rotate the credential")
	}
	send("PUT", "/agent/heartbeat", "", previous, "", 200)
	if _, err := stores.Control.Write.ExecContext(ctx, "UPDATE agent_sessions SET previous_expires_at=0"); err != nil {
		t.Fatal(err)
	}
	if expired := send("PUT", "/agent/heartbeat", "", previous, "", 401); !strings.Contains(expired.Body.String(), "session_expired") {
		t.Fatal(expired.Body)
	}
	var stale int
	if err := stores.Control.Read.QueryRowContext(ctx, "SELECT count(*) FROM commands c JOIN agent_sessions a ON a.strategy_id=c.strategy_id AND a.instance_id=c.instance_id WHERE c.id=? AND c.accepted_by IS NOT a.token_id", first.ID).Scan(&stale); err != nil || stale != 0 {
		t.Fatalf("renewed session lost command authority: count=%d err=%v", stale, err)
	}
	current := send("GET", base, "", "", "", 200)
	if !strings.Contains(current.Body.String(), `"status":"executing"`) {
		t.Fatalf("renewal interrupted the granted command: %s", current.Body)
	}
	if err := stores.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := storage.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	stores = reopened
	service = command.New(stores.Control, ctx, cfg.CommandPoll, nil)
	if err := service.Recover(ctx); err != nil {
		t.Fatal(err)
	}
	handler = testRoutes(t, stores, cfg, service)
	recovered := send("GET", base, "", "", "", 200)
	if !strings.Contains(recovered.Body.String(), `"status":"unknown"`) {
		t.Fatalf("lost receipt was not marked unknown: %s", recovered.Body)
	}
	replayedClaim := send("POST", agentBase+"/claim", "", agent.Session, winningKey, 409)
	if !strings.Contains(replayedClaim.Body.String(), "claim_reconciliation_required") ||
		!strings.Contains(replayedClaim.Body.String(), `"status":"unknown"`) ||
		strings.Contains(replayedClaim.Body.String(), permit) {
		t.Fatal(replayedClaim.Body)
	}
	send("POST", strategyPath+"/commands", intent, "", "request-2", 409)
	poll = send("GET", "/agent/commands?wait=0", "", agent.Session, "", 200)
	if strings.TrimSpace(poll.Body.String()) != "[]" {
		t.Fatal("unknown operation was offered again")
	}

	wrong := fmt.Sprintf(`{"status":"succeeded","permit":%q}`, strings.Repeat("x", 32))
	send("POST", agentBase+"/result", wrong, agent.Session, "", 409)
	receipt := fmt.Sprintf(`{"status":"succeeded","permit":%q,"message":"verified paper receipt"}`, permit)
	send("POST", agentBase+"/result", receipt, agent.Session, "", 200)
	send("POST", agentBase+"/result", receipt, agent.Session, "", 200)
	view := send("GET", strategyPath+"/controls", "", "", "", 200)
	if !strings.Contains(view.Body.String(), `"value":false`) || !strings.Contains(view.Body.String(), `"status":"succeeded","value":true`) {
		t.Fatalf("actual and desired state were conflated: %s", view.Body)
	}
	audit := send("GET", "/admin/audit", "", "", "", 200)
	if strings.Contains(audit.Body.String(), permit) || !strings.Contains(audit.Body.String(), "command.unknown") ||
		strings.Count(audit.Body.String(), "command.succeeded") != 1 {
		t.Fatalf("invalid audit: %s", audit.Body)
	}
}

func decodeTest(t *testing.T, rec *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), target); err != nil {
		t.Fatal(err)
	}
}

func TestPollingRevocationAndCancellation(t *testing.T) {
	cfg := config.Config{CommandPoll: 2 * time.Second}
	handler := newAuthTestServer(t, cfg)
	const origin = "http://127.0.0.1:23456"
	setup, cookie := parseSession(t, requestAuth(t, handler, "POST", "/setup",
		`{"username":"admin","password":"paper-test-password"}`, origin, nil, "", 200))
	call := func(method, path, body, token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, origin+apiPath(path), strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:50000"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", setup.CSRF)
		req.Header.Set("Authorization", "Bearer "+token)
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	var created struct {
		Strategy   struct{ ID string }
		Credential struct{ ID, Token string }
	}
	decodeTest(t, call("POST", "/admin/strategies", `{"name":"Poll test","mode":"paper"}`, ""), &created)
	var agent struct{ Session string }
	decodeTest(t, call("POST", "/agent/session", `{"instanceId":"worker","bootId":"test"}`, created.Credential.Token), &agent)
	strategyPath := "/admin/strategies/" + created.Strategy.ID
	if rec := call("PUT", strategyPath+"/executor", `{"instanceId":"worker"}`, ""); rec.Code != 204 {
		t.Fatalf("executor setup failed: %d %s", rec.Code, rec.Body)
	}
	results := make(chan *httptest.ResponseRecorder, 1)
	go func() { results <- call("GET", "/agent/commands", "", agent.Session) }()
	time.Sleep(60 * time.Millisecond)
	if rec := call("DELETE", strategyPath+"/tokens/"+created.Credential.ID, "", ""); rec.Code != 204 {
		t.Fatalf("revocation failed: %d %s", rec.Code, rec.Body)
	}
	select {
	case rec := <-results:
		if rec.Code != 401 {
			t.Fatalf("poll still had access: %d %s", rec.Code, rec.Body)
		}
	case <-time.After(time.Second):
		t.Fatal("poll did not recheck revocation before its deadline")
	}
}
