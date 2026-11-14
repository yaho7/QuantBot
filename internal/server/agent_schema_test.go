package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/yaho7/QuantBot/internal/command"
	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/storage"
)

func TestPublishedAgentSchemas(t *testing.T) {
	stores, err := storage.Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = stores.Close() })
	handler := testRoutes(t, stores, config.Config{}, command.New(stores.Control, t.Context(), 0, nil))
	compiler := jsonschema.NewCompiler()
	for _, name := range []string{"agent.json", "report.json"} {
		path := "/api/agent/schemas/" + name
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1"+path, nil)
		req.RemoteAddr = "127.0.0.1:12345"
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/schema+json" {
			t.Fatalf("%s: %d, %s", path, rec.Code, rec.Body)
		}
		document, err := jsonschema.UnmarshalJSON(rec.Body)
		if err != nil {
			t.Fatal(err)
		}
		if err := compiler.AddResource("https://quantbot.local"+path, document); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		definition, body string
		valid            bool
	}{
		{"session", `{"instanceId":"worker","bootId":"new-boot"}`, true},
		{"capabilities", `{"revision":0,"capabilities":[{"id":"feed","kind":"metric","title":"Feed","value_type":"decimal","history":true,"constraints":{"min":"0.10"},"presentation":{"preferred_renderer":"line"}}]}`, true},
		{"capabilities", `{"revision":0,"capabilities":[{"id":"feed","kind":"metric","title":"Feed","value_type":"number"}]}`, false},
		{"capabilities", `{"revision":0,"capabilities":[{"id":"feed","kind":"metric","title":"Feed","value_type":"decimal","presentation":{"size":"large"}}]}`, false},
		{"capabilities", `{"revision":0,"capabilities":[{"id":"orders","kind":"resource","title":"Orders","value_type":"array","value_schema":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}}]}`, true},
		{"state", `{"revision":1,"states":[{"id":"gate","observedAt":42,"value":false}]}`, true},
		{"state", `{"revision":1,"states":[{"id":"gate","observedAt":42}]}`, false},
		{"reports", `{"records":[{"id":"report","kind":"status","observedAt":42,"data":{"state":"running"}}]}`, true},
		{"reports", `{"revision":1,"records":[{"id":"record","observedAt":42,"capabilityId":"metric","value":"2.50"}]}`, true},
		{"reports", `{"version":1,"records":[{"id":"report","kind":"status","observedAt":42,"data":{"state":"running"}}]}`, false},
		{"events", `{"records":[{"id":"report","kind":"status","observedAt":42,"data":{"state":"running"}}]}`, false},
		{"events", `{"revision":1,"records":[{"id":"record","observedAt":42,"capabilityId":"signal","value":{},"associations":{"order_id":"order-1"}}]}`, true},
		{"events", `{"revision":1,"records":[{"id":"record","observedAt":42,"capabilityId":"signal","value":{},"associations":{"unknown":"id"}}]}`, false},
		{"resources", `{"revision":1,"records":[{"id":"record","observedAt":42,"value":[]}]}`, true},
		{"result", `{"permit":"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123_-","status":"succeeded"}`, true},
	} {
		t.Run(tc.definition+" "+tc.body, func(t *testing.T) {
			schema, err := compiler.Compile("https://quantbot.local/api/agent/schemas/agent.json#/$defs/" + tc.definition)
			if err != nil {
				t.Fatal(err)
			}
			instance, err := jsonschema.UnmarshalJSON(strings.NewReader(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if err := schema.Validate(instance); (err == nil) != tc.valid {
				t.Fatalf("valid=%t, error=%v", tc.valid, err)
			}
		})
	}
}
