package sandbox

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestSandboxExpiryAndRateLimits(t *testing.T) {
	service := New(t.Context())
	t.Cleanup(service.Close)
	now := time.Now()
	runner, err := newRun(t.Context(), t.Context(), "trial", "paper", "Paper", "qbt_"+strings.Repeat("X", 43), now)
	if err != nil {
		t.Fatal(err)
	}
	service.active = runner
	router := chi.NewRouter()
	service.RegisterAgent(router)
	request := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest("PUT", "/sandbox/trial/heartbeat", nil))
		return rec
	}
	service.inflight = globalInflight
	if got := request(); got.Code != 429 || got.Header().Get("Retry-After") == "" {
		t.Fatal(got.Code, got.Body)
	}
	service.inflight = 0
	runner.requests = window{minute: now.Unix() / 60, count: 120}
	if time.Now().Unix()/60 == runner.requests.minute {
		if got := request(); got.Code != http.StatusTooManyRequests {
			t.Fatal(got.Code, got.Body)
		}
	}
	service.expire(now.Add(keyTTL + time.Second))
	if service.active != nil || service.previous.Status != "expired" {
		t.Fatal("expiration did not release the trial")
	}
	if got := request(); got.Code != http.StatusUnauthorized {
		t.Fatal(got.Code, got.Body)
	}
}
