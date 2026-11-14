package server

import (
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yaho7/QuantBot/internal/command"
	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/telemetry"
)

func TestDeclaredDataReplayAndRevisionFencing(t *testing.T) {
	stores, err := storage.Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stores.Close() })
	handler := testRoutes(t, stores, config.Config{}, command.New(stores.Control, t.Context(), 0, nil))
	const origin = "http://127.0.0.1:23456"
	account, cookie := parseSession(t, requestAuth(t, handler, "POST", "/setup", `{"username":"admin","password":"paper-test-password"}`, origin, nil, "", 200))
	call := func(method, path, body, token string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, origin+apiPath(path), strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Content-Type", "application/json")
		if strings.HasPrefix(path, "/agent/") {
			req.Header.Set("Authorization", "Bearer "+token)
		} else {
			req.Header.Set("Origin", origin)
			req.Header.Set("X-CSRF-Token", account.CSRF)
			req.Header.Set("Idempotency-Key", "key-"+fmt.Sprint(time.Now().UnixNano()))
			req.AddCookie(cookie)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, rec.Code, status, rec.Body)
		}
		return rec
	}
	var created struct {
		Strategy   struct{ ID string }
		Credential struct{ Token string }
	}
	decodeTest(t, call("POST", "/admin/strategies", `{"name":"Declared data","mode":"paper"}`, "", 201), &created)
	var worker struct {
		Session  string
		Revision int64
	}
	decodeTest(t, call("POST", "/agent/session", `{"instanceId":"reporter","bootId":"run"}`, created.Credential.Token, 201), &worker)
	path := "/strategies/" + created.Strategy.ID
	call("PUT", "/admin"+path+"/executor", `{"instanceId":"reporter"}`, "", 204)
	registry := `{"revision":0,"capabilities":[
	  {"id":"latency","kind":"metric","title":"Latency","value_type":"decimal","history":true,"unit":"ms","presentation":{"suggested":true,"surface":["strategy"]}},
	  {"id":"broker","kind":"state","title":"Broker","value_type":"boolean","history":true,"group":"health","stale_after_seconds":2,"alert_suggestion":{"type":"stale"}},
	  {"id":"position","kind":"resource","title":"Positions","value_type":"object","history":true,"value_schema":{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}},
	  {"id":"signal","kind":"event","title":"Signal","value_type":"object","history":false,"value_schema":{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}},
	  {"id":"limit","kind":"parameter","title":"Limit","value_type":"decimal","writable":true,"stale_after_seconds":2},
	  {"id":"apply","kind":"action","title":"Apply","value_type":"null","writable":true,"atomic_parameters":["limit"]}
	]}`
	call("PUT", "/agent/capabilities", registry, worker.Session, 200)
	call("PUT", "/agent/capabilities", registry, worker.Session, 200)
	now := time.Now().UnixMilli()
	state := fmt.Sprintf(`{"revision":1,"states":[{"id":"broker","value":false,"observedAt":%d},{"id":"limit","value":"2","observedAt":%d},{"id":"apply","value":null,"observedAt":%d}]}`, now-3500, now-3500, now)
	call("PUT", "/agent/state", state, worker.Session, 200)
	if replay := call("PUT", "/agent/state", state, worker.Session, 200); !strings.Contains(replay.Body.String(), `"duplicate":3`) {
		t.Fatal(replay.Body)
	}
	if got := call("GET", path+"/capabilities", "", "", 200); !strings.Contains(got.Body.String(), `"status":"degraded"`) || !strings.Contains(got.Body.String(), `"renderer":"line"`) {
		t.Fatal(got.Body)
	}
	call("POST", path+"/commands", `{"controlId":"limit","revision":1,"input":"3"}`, "", 409)
	call("POST", path+"/commands", `{"controlId":"apply","revision":1,"input":{"limit":"3"}}`, "", 400)
	call("PUT", "/agent/state", strings.Replace(state, `"value":"2"`, `"value":2`, 1), worker.Session, 400)
	stateHistory := call("GET", path+"/capabilities/broker/history?source=state", "", "", 200)
	if !strings.Contains(stateHistory.Body.String(), `"value":false`) || !strings.Contains(stateHistory.Body.String(), `"receivedAt":`) {
		t.Fatal(stateHistory.Body)
	}

	report := fmt.Sprintf(`{"revision":1,"records":[{"id":"metric1","capabilityId":"latency","value":"1.001","observedAt":%d}]}`, now)
	resource := fmt.Sprintf(`{"revision":1,"records":[{"id":"position1","value":{"symbol":"BTC"},"observedAt":%d,"associations":{"account_id":"paper","signal_id":"signal1","correlation_id":"trace1"}}]}`, now)
	event := fmt.Sprintf(`{"revision":1,"records":[{"id":"signal1","capabilityId":"signal","value":{"symbol":"BTC"},"observedAt":%d}]}`, now)
	for _, p := range []struct{ method, path, body string }{
		{"POST", "/agent/reports", report}, {"PUT", "/agent/resources/position", resource}, {"POST", "/agent/events", event},
	} {
		var ack telemetry.Ack
		decodeTest(t, call(p.method, p.path, p.body, worker.Session, 200), &ack)
		if ack.Inserted != 1 {
			t.Fatal(ack)
		}
		decodeTest(t, call(p.method, p.path, p.body, worker.Session, 200), &ack)
		if ack.Duplicate != 1 {
			t.Fatal(ack)
		}
	}
	call("POST", "/agent/reports", strings.Replace(report, `"1.001"`, `1.001`, 1), worker.Session, 422)
	call("POST", "/agent/events", strings.Replace(event, `"BTC"`, `"ETH"`, 1), worker.Session, 422)
	if history := call("GET", path+"/capabilities/signal/history", "", "", 200); strings.TrimSpace(history.Body.String()) != "[]" {
		t.Fatal(history.Body)
	}
	if history := call("GET", path+"/capabilities/position/history", "", "", 200); !strings.Contains(history.Body.String(), `"signal_id":"signal1"`) ||
		!strings.Contains(history.Body.String(), `"revision":1`) {
		t.Fatal(history.Body)
	}
	fresh := time.Now().UnixMilli()
	call("PUT", "/agent/state", fmt.Sprintf(`{"revision":1,"states":[{"id":"limit","value":"2","observedAt":%d}]}`, fresh), worker.Session, 200)
	call("POST", path+"/commands", `{"controlId":"apply","revision":1,"input":{"limit":"3","extra":true}}`, "", 400)
	var plan struct{ ID, Status string }
	decodeTest(t, call("POST", path+"/commands", `{"controlId":"apply","revision":1,"input":{"limit":"3"}}`, "", 201), &plan)
	if plan.Status != "confirmation_required" {
		t.Fatal(plan)
	}
	commandPath := "/commands/" + plan.ID
	call("POST", "/agent"+commandPath+"/claim", "", worker.Session, 409)
	call("POST", commandPath+"/confirm", "", "", 200)
	call("POST", path+"/commands", `{"controlId":"limit","revision":1,"input":"3"}`, "", 400)
	var grant struct{ Permit, Command string }
	decodeTest(t, call("POST", "/agent"+commandPath+"/claim", "", worker.Session, 200), &grant)
	if grant.Command != "apply" || grant.Permit == "" {
		t.Fatal("atomic action must receive one permit")
	}
	call("POST", "/agent"+commandPath+"/claim", "", worker.Session, 409)
	receipt := fmt.Sprintf(`{"permit":%q,"status":"succeeded"}`, grant.Permit)
	call("POST", "/agent"+commandPath+"/result", receipt, worker.Session, 200)
	call("POST", "/agent"+commandPath+"/result", receipt, worker.Session, 200)
	if saved := call("GET", path+"/capabilities", "", "", 200); !strings.Contains(saved.Body.String(), `"value":"2"`) {
		t.Fatal("a command receipt must not replace actual state")
	}
	call("PUT", "/agent/capabilities", `{"revision":1,"capabilities":[]}`, worker.Session, 200)
	call("PUT", "/agent/state", state, worker.Session, 409)
	call("POST", "/agent/reports", report, worker.Session, 409)
	if latest := call("GET", path+"/capability-data", "", "", 200); strings.TrimSpace(latest.Body.String()) != "[]" {
		t.Fatal(latest.Body)
	}
	if history := call("GET", path+"/capabilities/latency/history", "", "", 200); !strings.Contains(history.Body.String(), `"value":"1.001"`) {
		t.Fatal(history.Body)
	}
	if _, err := stores.Control.Write.ExecContext(t.Context(), "UPDATE agent_instances SET last_seen=0"); err != nil {
		t.Fatal(err)
	}
	if got := call("GET", path+"/capabilities", "", "", 200); !strings.Contains(got.Body.String(), `"status":"offline"`) {
		t.Fatal(got.Body)
	}
}
