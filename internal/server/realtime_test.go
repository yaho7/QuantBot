package server

import (
	"bufio"
	"context"
	"encoding/json"

	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yaho7/QuantBot/internal/command"
	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/notification"
	"github.com/yaho7/QuantBot/internal/realtime"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/telemetry"
)

func TestStreamPushesOnlyCommittedStrategyChanges(t *testing.T) {
	ctx, stop := context.WithTimeout(t.Context(), 8*time.Second)
	defer stop()
	stores, err := storage.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer stores.Close()
	bus := realtime.New()
	done := make(chan struct{})
	go func() {
		bus.Run(ctx)
		close(done)
	}()
	defer func() { stop(); <-done }()
	reports, err := telemetry.New(stores, telemetry.QueueConfig{Capacity: 8, Batch: 4, Flush: time.Millisecond}, bus.Publish)
	if err != nil {
		t.Fatal(err)
	}
	defer reports.Close()
	cfg := config.Config{}
	server := httptest.NewServer(routes(stores, cfg, command.New(stores.Control, ctx, 0, bus.Publish), reports, bus, notification.New(stores.Control, [32]byte{})))
	defer server.Close()

	send := func(method, path, body, token, cookie, csrf string, expected int) *http.Response {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, server.URL+"/api/v1"+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", server.URL)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
			req.Header.Set("X-CSRF-Token", csrf)
		}
		response, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != expected {
			response.Body.Close()
			t.Fatalf("%s %s: got %d want %d", method, path, response.StatusCode, expected)
		}
		return response
	}
	read := func(response *http.Response, target any) {
		t.Helper()
		defer response.Body.Close()
		if err := json.NewDecoder(response.Body).Decode(target); err != nil {
			t.Fatal(err)
		}
	}
	send("GET", "/events", "", "", "", "", 401).Body.Close()
	init := send("POST", "/auth/setup", `{"username":"admin","password":"paper-test-password"}`, "", "", "", 200)
	cookie := strings.Split(init.Header.Get("Set-Cookie"), ";")[0]
	var account struct{ CSRF string }
	read(init, &account)
	stream := send("GET", "/events", "", "", cookie, "", 200)
	defer stream.Body.Close()
	if stream.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatal("missing SSE response type")
	}
	scanner := bufio.NewScanner(stream.Body)
	next := func() realtime.Batch {
		t.Helper()
		for scanner.Scan() {
			if data, ok := strings.CutPrefix(scanner.Text(), "data: "); ok {
				var b realtime.Batch
				if err := json.Unmarshal([]byte(data), &b); err != nil {
					t.Fatal(err)
				}
				return b
			}
		}
		t.Fatalf("stream ended: %v", scanner.Err())
		return realtime.Batch{}
	}
	if !next().Reset {
		t.Fatal("missing initial cache refresh")
	}
	var strategy struct {
		Strategy   struct{ ID string }
		Credential struct{ Token string }
	}
	read(send("POST", "/admin/strategies", `{"name":"Live feed test","mode":"paper"}`, "", cookie, account.CSRF, 201), &strategy)
	var agent struct{ Session string }
	read(send("POST", "/agent/session", `{"instanceId":"worker","bootId":"boot"}`, strategy.Credential.Token, "", "", 201), &agent)
	at := time.Now().UnixMilli()
	report := fmt.Sprintf(`{"version":1,"records":[{"id":"value","kind":"metric","observedAt":%d,"data":{"name":"test","value":"7"}}]}`, at)
	send("POST", "/agent/reports", report, agent.Session, "", "", 200).Body.Close()
	var sawStatus, sawMetric bool
	for !sawStatus || !sawMetric {
		for _, change := range next().Changes {
			if change.StrategyID != strategy.Strategy.ID {
				t.Fatalf("unexpected strategy change: %+v", change)
			}
			sawStatus = sawStatus || change.Topic == realtime.Status
			sawMetric = sawMetric || change.Topic == realtime.Telemetry
		}
	}
	response := send("GET", "/strategies/"+strategy.Strategy.ID+"/telemetry", "", "", cookie, "", 200)
	var items []struct{ ID string }
	read(response, &items)
	if len(items) != 1 || items[0].ID != "value" {
		t.Fatalf("event preceded persisted record: %+v", items)
	}
}
