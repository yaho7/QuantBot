package server

import (
	"database/sql"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/yaho7/QuantBot/internal/command"
	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/storage/metricsdb"
	"github.com/yaho7/QuantBot/internal/telemetry"
)

func TestTelemetryPartialCommitAndSafeReplay(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()
	stores, err := storage.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stores.Close() })
	cfg := config.Config{}
	handler := testRoutes(t, stores, cfg, command.New(stores.Control, ctx, 0, nil))
	const origin = "http://127.0.0.1:23456"
	setup, cookie := parseSession(t, requestAuth(t, handler, "POST", "/setup",
		`{"username":"admin","password":"paper-test-password"}`, origin, nil, "", 200))

	call := func(method, path, body, token string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, origin+apiPath(path), strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Content-Type", "application/json")
		if strings.HasPrefix(path, "/agent/") {
			req.Header.Set("Authorization", "Bearer "+token)
		} else {
			req.Header.Set("Origin", origin)
			req.Header.Set("X-CSRF-Token", setup.CSRF)
			req.AddCookie(cookie)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("%s %s returned %d, want %d (%s)", method, path, rec.Code, status, rec.Body)
		}
		return rec
	}
	var created struct {
		Strategy   struct{ ID string }
		Credential struct{ Token string }
	}
	decodeTest(t, call("POST", "/admin/strategies", `{"name":"Telemetry","mode":"paper"}`, "", 201), &created)
	var agent struct{ Session string }
	decodeTest(t, call("POST", "/agent/session", `{"instanceId":"worker","bootId":"boot-a"}`, created.Credential.Token, 201), &agent)

	now := time.Now().UnixMilli()
	fill := fmt.Sprintf(`{"id":"fill-a","kind":"fill","observedAt":%d,"data":{"accountId":"paper","orderId":"order-1","fillId":"broker-1","symbol":"BTC","side":"buy","quantity":"0.01","price":"20"}}`, now)
	metric := fmt.Sprintf(`{"id":"metric-a","kind":"metric","observedAt":%d,"data":{"name":"spread","value":"0.001"}}`, now)
	mixed := `{"records":[` + fill + "," + metric + "]}"
	// Cap SQLite pages, then submit a sample large enough to force SQLITE_FULL.
	var pages int
	if err := stores.Metrics.Write.QueryRowContext(ctx, "PRAGMA page_count").Scan(&pages); err != nil {
		t.Fatal(err)
	}
	if _, err := stores.Metrics.Write.ExecContext(ctx, fmt.Sprintf("PRAGMA max_page_count = %d", pages)); err != nil {
		t.Fatal(err)
	}
	logs := make([]string, 20)
	for i := range logs {
		logs[i] = fmt.Sprintf(`{"id":"log-%d","kind":"log","observedAt":%d,"data":{"severity":"info","message":%q}}`, i, now, strings.Repeat("X", 3800))
	}
	large := strings.TrimSuffix(mixed, "]}") + "," + strings.Join(logs, ",") + "]}"
	call("POST", "/agent/reports", large, agent.Session, 507)
	q := controldb.New(stores.Control.Read)
	if _, err := q.TradeEventFingerprint(ctx, controldb.TradeEventFingerprintParams{
		StrategyID: created.Strategy.ID, Kind: "fill", ReportID: "fill-a",
	}); err != nil {
		t.Fatalf("critical fill did not persist: %v", err)
	}
	mq := metricsdb.New(stores.Metrics.Read)
	if _, err := mq.SampleFingerprint(ctx, metricsdb.SampleFingerprintParams{
		StrategyID: created.Strategy.ID, Kind: "metric", ReportID: "metric-a",
	}); err != sql.ErrNoRows {
		t.Fatalf("partially committed metrics transaction: %v", err)
	}
	if _, err := stores.Metrics.Write.ExecContext(ctx, "PRAGMA max_page_count = 1073741823"); err != nil {
		t.Fatal(err)
	}
	// A separate SQLite connection holds the metrics write lock. Critical control
	// writes remain available and a retry after contention keeps the original IDs.
	locked, err := sql.Open("sqlite3", (&url.URL{Scheme: "file", Path: dir + "/metrics.db", RawQuery: "mode=rw&_txlock=immediate"}).String())
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Close()
	tx, err := locked.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	call("PUT", "/agent/heartbeat", "", agent.Session, 200)
	if busy := call("POST", "/agent/reports", mixed, agent.Session, 503); !strings.Contains(busy.Body.String(), "storage_busy") {
		t.Fatal(busy.Body)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	var ack telemetry.Ack
	decodeTest(t, call("POST", "/agent/reports", mixed, agent.Session, 200), &ack)
	if ack.Inserted != 1 || ack.Duplicate != 1 || ack.Rejected != 0 {
		t.Fatalf("unexpected retry ack: %+v", ack)
	}
	replay := `{"records":[` + strings.Replace(fill, "fill-a", "new-envelope-id", 1) +
		"," + strings.Replace(metric, "0.001", "0.002", 1) + ",{}]}"
	decodeTest(t, call("POST", "/agent/reports", replay, agent.Session, 200), &ack)
	if ack.Inserted != 0 || ack.Duplicate != 1 || ack.Rejected != 2 {
		t.Fatalf("unexpected conflict ack: %+v", ack)
	}
	call("POST", "/agent/reports", mixed, created.Credential.Token, 401)
	status := fmt.Sprintf(`{"id":"status-a","kind":"status","observedAt":%d,"data":{"state":"running"}}`, now)
	call("POST", "/agent/reports", `{"records":[`+status+`]}`, agent.Session, 200)
	path := "/strategies/" + created.Strategy.ID
	var series struct {
		Series []struct{ Kind, Series, InstanceID string }
	}
	decodeTest(t, call("GET", path+"/series", "", "", 200), &series)
	if len(series.Series) != 1 || series.Series[0].Kind != "metric" || series.Series[0].InstanceID != "worker" {
		t.Fatalf("missing persisted metric series: %+v", series.Series)
	}
	historyPath := fmt.Sprintf("%s/history?instanceId=worker&kind=metric&from=%d&to=%d&points=200&series=%s", path, now-1, now+1, url.QueryEscape(series.Series[0].Series))
	history := call("GET", historyPath, "", "", 200)
	if !strings.Contains(history.Body.String(), `"close":"0.001"`) {
		t.Fatalf("history lost exact metric value: %s", history.Body)
	}
	latest := call("GET", path+"/telemetry", "", "", 200)
	if !strings.Contains(latest.Body.String(), `"state":"running"`) {
		t.Fatalf("latest telemetry lost state: %s", latest.Body)
	}
	feed := call("GET", path+"/records?kind=fill", "", "", 200)
	if strings.Count(feed.Body.String(), "broker-1") < 1 || strings.Contains(feed.Body.String(), "new-envelope-id") {
		t.Fatalf("invalid fill feed: %s", feed.Body)
	}
}
