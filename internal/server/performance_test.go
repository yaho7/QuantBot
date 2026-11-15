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
	macSession, vpsSession, peer := connect("mac", "boot1"), connect("vps", "boot2"), connect("peer", "boot3")
	now := time.Now()
	report := func(id string, at time.Time, cpu float64) map[string]any {
		return map[string]any{"record_id": id, "observed_at": at.Format(time.RFC3339Nano), "sample_duration_ms": 15000,
			"host": map[string]any{"cpu_usage_percent": cpu, "memory_available_bytes": 700}, "process": map[string]any{"cpu_cores_used": 0.5, "rss_bytes": 100}}
	}
	ingest := func(name, session string, status int, items ...map[string]any) map[string]any {
		return send("POST", "/agent/performance", map[string]any{"host_name": name,
			"capacity": map[string]any{"cpu_cores": 2, "memory_bytes": 1000}, "records": items}, session, status)
	}
	ingest("Mac", "", 401, report("unauthorized", now, 20))
	mac := ingest("Mac", macSession, 200, report("mac", now.Add(-10*time.Minute), 20))["hostId"].(string)
	initial := report("old", now.Add(-2*time.Minute), 25)
	vps := ingest("VPS", vpsSession, 200, initial)["hostId"].(string)
	newSample := report("sample", now.Add(-10*time.Second), 25)
	ingest("VPS", vpsSession, 200, newSample)
	joined := ingest(" vps ", peer, 200, report("peer", now.Add(-time.Second), 25))
	if joined["hostId"] != vps || mac == vps {
		t.Fatalf("wrong grouping: %v", joined)
	}
	if d := ingest("VPS", vpsSession, 200, newSample); d["duplicate"] != float64(1) {
		t.Fatalf("expected deduplication: %v", d)
	}
	// A delayed sample from before the active run cannot reconnect it.
	ingest("VPS", vpsSession, 200, report("late", now.Add(-55*time.Second), 99))
	host := send("GET", "/hosts/"+vps, nil, "", 200)
	if host["name"] != "VPS" || len(host["history"].([]any)) != 2 {
		t.Fatalf("expected two samples from the uninterrupted run: %v", host)
	}
	send("GET", "/strategies/"+strategy+"/performance", nil, "", 200)
	capacity := func(id, instance, bearer string, status int) map[string]any {
		return send(http.MethodGet, "/hosts/"+id+"/capacity?strategyId="+strategy+"&instanceId="+instance, nil, bearer, status)
	}
	capacity(vps, "vps", "-", 401)
	if outcome := capacity(vps, "vps", "", 200); outcome["additional"] != float64(2) || outcome["source"] != "latest" || outcome["bottleneck"] != "cpu" {
		t.Fatalf("bad latest-sample estimate: %v", outcome)
	}
	if outcome := capacity(mac, "mac", "", 200); outcome["reason"] != "host_stale" {
		t.Fatalf("old host data utilized: %v", outcome)
	}
	probe := report("probe", now.Add(-12*time.Second), 25)
	ingest("VPS", vpsSession, 409, probe, report("sample", now.Add(-10*time.Second), 22))
	if ack := ingest("VPS", vpsSession, 200, probe); ack["inserted"] != float64(1) {
		t.Fatalf("expected batch rollback: %v", ack)
	}
	ingest("VPS", vpsSession, 400, report("bad", now, 101))
	ingest("another machine", vpsSession, 409, report("rename", now, 25))
	newMac := connect("mac", "boot4")
	ingest("VPS", newMac, 200, report("moved", now, 25))
	ingest("Mac", macSession, 401, report("old-boot", now, 25))
	const admin = "/admin/strategies/"
	send("DELETE", admin+strategy, nil, "", 204)
	ingest("VPS", vpsSession, 401, report("deleted", now, 20))
	send("POST", "/agent/session", map[string]string{"instanceId": "vps", "bootId": "new-after-delete"}, token, 401)
}
