package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConcurrentRequestsRefreshOnce(t *testing.T) {
	var renewals atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/session":
			var identity map[string]string
			if err := json.NewDecoder(r.Body).Decode(&identity); err != nil || r.Header.Get("Authorization") != "Bearer original" || identity["instanceId"] != "worker" || identity["bootId"] != "same-process" {
				t.Error("session request changed its identity")
			}
			bearer := "new"
			if renewals.Add(1) == 1 {
				bearer = "old"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"session": bearer, "expiresAt": time.Now().Add(time.Hour).Unix()})
		default:
			if r.Header.Get("Authorization") != "Bearer new" {
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(map[string]string{"code": "session_expired"})
				return
			}
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()
	client := NewClient(server.URL, "original", "worker", "same-process", nil)
	if _, err := client.Connect(t.Context()); err != nil {
		t.Fatal(err)
	}
	var calls sync.WaitGroup
	for range 30 {
		calls.Go(func() {
			if err := client.Do(t.Context(), http.MethodPut, "/heartbeat", nil, nil); err != nil {
				t.Error(err)
			}
		})
	}
	calls.Wait()
	if got := renewals.Load(); got != 2 {
		t.Fatalf("initial session plus one shared renewal expected, got %d", got)
	}
}

func TestRunRetriesTransientRenewalAndStopsOnRevocation(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch calls.Add(1) {
		case 1:
			w.WriteHeader(http.StatusServiceUnavailable)
		case 2:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"session": "valid", "expiresAt": time.Now().Add(time.Hour).Unix(), "renewAt": time.Now().Unix(),
			})
		default:
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"code": "agent_token_revoked"})
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	client := NewClient(server.URL, "original", "worker", "same-process", nil)
	err := client.Run(ctx)
	result, ok := err.(*Error)
	if !ok || result.Code != "agent_token_revoked" || calls.Load() != 3 {
		t.Fatalf("code, attempts: %v, %d", err, calls.Load())
	}
}
