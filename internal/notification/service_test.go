package notification

import (
	"context"
	"database/sql"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

type testSender struct {
	mu     sync.Mutex
	calls  int
	tokens []string
}

func (f *testSender) Send(_ context.Context, _ Provider, c Credentials, title, body string) (Delivery, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.tokens = append(f.tokens, c.Token)
	if f.calls == 1 {
		return Delivery{}, &SendError{Code: "rate_limited", Retryable: true, RetryAfter: 30 * time.Second}
	}
	return Delivery{ProviderID: "provider-receipt"}, nil
}

func TestPersistentNotificationOutboxAndCredentialRotation(t *testing.T) {
	ctx := t.Context()
	stores, err := storage.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer stores.Close()
	s := New(stores.Control, [32]byte{1})
	sender := &testSender{}
	s.sender = sender
	r := chi.NewRouter()
	s.Register(r)
	request := func(method, path, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("%s %s: got %d, expected %d, %s", method, path, rec.Code, status, rec.Body)
		}
		return rec
	}
	const token = "12345:local_test_token"
	const path = "/admin/notifications"
	request("POST", path, `{"name":"Ops","provider":"telegram","enabled":true,"events":["alert","command"],"credentials":{"token":"`+token+`","chatId":"-123"}}`, 201)
	query := controldb.New(stores.Control.Write)
	channels, err := query.ListNotificationChannels(ctx)
	if err != nil || len(channels) != 1 {
		t.Fatalf("missing channel: %v", err)
	}
	id := channels[0].ID
	rec := request("GET", path, "", 200)
	stored, err := query.GetNotificationChannel(ctx, id)
	if err != nil || strings.Contains(string(stored.Encrypted), token) || strings.Contains(rec.Body.String(), token) {
		t.Fatalf("credential was exposed: %v", err)
	}
	if _, err := s.open("different", stored.Provider, stored.Encrypted); err == nil {
		t.Fatal("ciphertext was not bound to the destination")
	}
	if err := query.CreateStrategy(ctx, controldb.CreateStrategyParams{ID: "paper", Name: "Paper", Mode: "paper"}); err != nil {
		t.Fatal(err)
	}
	record := controldb.InsertTradeEventParams{
		StrategyID: "paper", ReportID: "event-1", Kind: "alert", Data: `{"severity":"warning","message":"paper alert"}`,
		ObservedAt: time.Now().UnixMilli(), InstanceID: "operator", Fingerprint: "sample",
	}
	for range 2 {
		if _, err := query.InsertTradeEvent(ctx, record); err != nil {
			t.Fatal(err)
		}
	}
	outbox, err := query.ListNotificationDeliveries(ctx, id)
	if err != nil || len(outbox) != 1 || outbox[0].Status != "queued" {
		t.Fatalf("event replay created an extra delivery: %+v, %v", outbox, err)
	}
	s.deliver(ctx)
	outbox, err = query.ListNotificationDeliveries(ctx, id)
	if err != nil || outbox[0].Status != "queued" || outbox[0].Attempts != 1 || outbox[0].LastError != "rate_limited" || outbox[0].NextAt < time.Now().Add(28*time.Second).UnixMilli() {
		t.Fatalf("rate-limit response was not scheduled: %+v, %v", outbox, err)
	}
	if _, err := stores.Control.Write.ExecContext(ctx, "UPDATE notification_deliveries SET next_at=0"); err != nil {
		t.Fatal(err)
	}
	// A new service instance uses the same persisted outbox and key.
	resumed := New(stores.Control, [32]byte{1})
	resumed.sender = sender
	resumed.deliver(ctx)
	outbox, err = query.ListNotificationDeliveries(ctx, id)
	if err != nil || outbox[0].Status != "sent" || outbox[0].Attempts != 2 || outbox[0].ProviderID != "provider-receipt" {
		t.Fatalf("persisted receipt missing: %+v, %v", outbox, err)
	}
	testPath := path + "/" + id + "/test"
	first := request("POST", testPath, "", 202)
	second := request("POST", testPath, "", 202)
	if first.Body.String() != second.Body.String() {
		t.Fatal("repeated test created more than one job")
	}
	request("PUT", path+"/"+id, `{"name":"Ops","provider":"telegram","enabled":true,"events":["alert"],"credentials":{"token":"54321:replacement_token","chatId":"-123"}}`, 200)
	outbox, err = query.ListNotificationDeliveries(ctx, id)
	if err != nil || len(outbox) != 2 || outbox[0].Status != "failed" || outbox[0].LastError != "channel_disabled" {
		t.Fatalf("destination rotation did not cancel the queued delivery: %+v, %v", outbox, err)
	}
	request("DELETE", path+"/"+id, "", 204)
	if _, err := query.GetNotificationChannel(ctx, id); err != sql.ErrNoRows {
		t.Fatalf("channel was not deleted: %v", err)
	}
}
