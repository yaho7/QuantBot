package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yaho7/QuantBot/internal/config"
)

func TestHostPerformanceAcrossMachines(t *testing.T) {
	h := newAuthTestServer(t, config.Config{})
	const origin = "http://127.0.0.1:23456"
	setup, cookie := parseSession(t, requestAuth(t, h, "POST", "/setup",
		`{"username":"admin","password":"paper-test-password"}`, origin, nil, "", 200))
	send := func(method, path string, body any, bearer string, status int) map[string]any {
		t.Helper()
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, origin+apiPath(path), strings.NewReader(string(raw)))
		req.RemoteAddr = "127.0.0.1:10000"
		req.Header.Set("Content-Type", "application/json")
		if strings.HasPrefix(path, "/agent/") {
			if bearer != "" {
				req.Header.Set("Authorization", "Bearer "+bearer)
			}
		} else if bearer != "-" {
			req.Header.Set("Origin", origin)
			req.Header.Set("X-CSRF-Token", setup.CSRF)
			req.AddCookie(cookie)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, rec.Code, status, rec.Body)
		}
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}
	create := send("POST", "/admin/strategies", map[string]any{"name": "Paper", "group": "", "mode": "paper"}, "", 201)
	strategy := create["strategy"].(map[string]any)["id"].(string)
	token := create["credential"].(map[string]any)["token"].(string)
	connect := func(instance, boot string) string {
		return send("POST", "/agent/session", map[string]string{"instanceId": instance, "bootId": boot}, token, 201)["session"].(string)
	}
	host := func(name, scope, reporter string) map[string]any {
		return send("POST", "/admin/hosts", map[string]string{"name": name, "scope": scope, "reporterStrategyId": strategy, "reporterInstanceId": reporter}, "", 201)
	}
	bind := func(machine map[string]any, session string, writer bool, status int) {
		in := map[string]any{"host_id": machine["id"], "binding_key": machine["bindingKey"], "process_budget": map[string]any{"cpu_cores": .5, "memory_bytes": 100}}
		if writer {
			in["capacity"] = map[string]any{"cpu_cores": 2, "memory_bytes": 1000}
		}
		send("PUT", "/agent/host", in, session, status)
	}
	mac, vps := host("Mac", "machine", "mac"), host("VPS", "container", "vps")
	macSession, vpsSession, reader := connect("mac", "boot1"), connect("vps", "boot2"), connect("vps-reader", "boot3")
	bind(mac, macSession, true, 200)
	bind(vps, vpsSession, true, 200)
	bind(mac, macSession, true, 200)
	bind(vps, macSession, false, 409)
	bind(vps, reader, true, 403)
	bind(vps, reader, false, 200)
	report := func(id string, at time.Time, cpu float64) map[string]any {
		return map[string]any{"record_id": id, "observed_at": at.Format(time.RFC3339Nano), "sample_duration_ms": 15000,
			"host": map[string]any{"cpu_usage_percent": cpu, "memory_available_bytes": 700}, "process": map[string]any{"cpu_cores_used": 0.5, "rss_bytes": 100}}
	}
	ingest := func(session string, status int, items ...map[string]any) map[string]any {
		return send("POST", "/agent/performance", map[string]any{"records": items}, session, status)
	}
	now := time.Now()
	m := report("sample", now.Add(-5*time.Minute), 20)
	v := report("sample", now.Add(-time.Second), 25)
	ingest(macSession, 200, m)
	ingest(vpsSession, 200, v)
	// Host and process clocks are independent; reordered samples never replace latest.
	ingest(vpsSession, 200, report("late", now.Add(-10*time.Minute), 90))
	if dup := ingest(vpsSession, 200, v); dup["duplicate"] != float64(1) {
		t.Fatalf("expected idempotent retry, got %v", dup)
	}
	conflict := report("sample", now.Add(-time.Second), 22)
	probe := report("probe", now.Add(-time.Second), 25)
	ingest(vpsSession, 409, probe, conflict)
	if ack := ingest(vpsSession, 200, probe); ack["inserted"] != float64(1) {
		t.Fatalf("expected atomic rollback, got %v", ack)
	}
	ingest(reader, 403, v)
	processOnly := report("reader", now.Add(-time.Second), 25)
	delete(processOnly, "host")
	ingest(reader, 200, processOnly)
	bad := report("bad", now, 25)
	bad["host"].(map[string]any)["cpu_usage_percent"] = 101
	ingest(vpsSession, 400, bad)
	bad["host"] = nil
	ingest(vpsSession, 400, bad)
	ingest("", 401, v)
	capacity := func(machine map[string]any, instance, bearer string, status int) map[string]any {
		return send(http.MethodGet, "/hosts/"+machine["id"].(string)+"/capacity?strategyId="+strategy+"&instanceId="+instance, nil, bearer, status)
	}
	capacity(vps, "vps", "-", 401)
	if outcome := capacity(vps, "vps", "", 200); outcome["additional"] != float64(2) || outcome["bottleneck"] != "cpu" {
		t.Fatalf("bad effective quota estimate: %v", outcome)
	}
	if outcome := capacity(mac, "mac", "", 200); outcome["reason"] != "host_stale" {
		t.Fatalf("old host data utilized: %v", outcome)
	}
	// A new boot may move the same logical instance without altering the other host.
	newMac := connect("mac", "boot4")
	bind(vps, newMac, false, 200)
	ingest(macSession, 401, m)
	if outcome := capacity(vps, "mac", "", 200); outcome["additional"] != float64(2) {
		t.Fatalf("moved instance did not see VPS pool: %v", outcome)
	}
	const admin = "/admin/strategies/"
	send("DELETE", admin+strategy+"/tokens/"+create["credential"].(map[string]any)["id"].(string), nil, "", 204)
	ingest(vpsSession, 401, report("revoked", now, 20))
}
