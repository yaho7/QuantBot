package control

import (
	"encoding/json"
	"testing"
)

func TestSixCapabilityKindsAndComponentResolution(t *testing.T) {
	valid := []struct {
		raw      string
		renderer string
		value    string
	}{
		{`{"id":"spread","title":"Spread","kind":"metric","value_type":"decimal","history":true}`, "line", `"0.000000000000000001"`},
		{`{"id":"broker","title":"Broker","kind":"state","group":"health","value_type":"boolean","stale_after_seconds":30,"alert_suggestion":{"type":"stale"}}`, "status", "false"},
		{`{"id":"target","title":"Target","kind":"parameter","writable":true,"value_type":"decimal","constraints":{"min":"0","max":"10","step":"0.1"}}`, "slider", `"2.9"`},
		{`{"id":"pause","title":"Pause","kind":"action","writable":true,"value_type":"null"}`, "button", "null"},
		{`{"id":"positions","title":"Positions","kind":"resource","value_type":"array","value_schema":{"type":"array","items":{"type":"object","properties":{"symbol":{"type":"string"}},"required":["symbol"]}}}`, "table", `[{"symbol":"BTC"}]`},
		{`{"id":"signal","title":"Signal","kind":"event","value_type":"object","history":true,"value_schema":{"type":"object","properties":{"score":{"type":"decimal"}},"required":["score"]}}`, "table", `{"score":"0.5"}`},
	}
	for _, tc := range valid {
		var item Capability
		if err := json.Unmarshal([]byte(tc.raw), &item); err != nil {
			t.Fatal(err)
		}
		if err := item.Validate(); err != nil {
			t.Fatalf("%s: %v", item.Kind, err)
		}
		if item.Renderer() != tc.renderer {
			t.Fatalf("%s selected %q", item.Kind, item.Renderer())
		}
		if err := item.ValidateValue(json.RawMessage(tc.value), true); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRejectsInvalidCapabilitySchemaAndRelationships(t *testing.T) {
	for _, raw := range []string{
		`{"id":"a","title":"X","kind":"metric","value_type":"string"}`,
		`{"id":"a","title":"X","kind":"state","value_type":"boolean","writable":true}`,
		`{"id":"a","title":"X","kind":"metric","value_type":"decimal","presentation":{"preferred_renderer":"slider"}}`,
		`{"id":"a","title":"X","kind":"parameter","value_type":"decimal","writable":true,"constraints":{"min":"10","max":"5"}}`,
		`{"id":"a","title":"X","kind":"action","value_type":"null","writable":true,"atomic_parameters":["missing"]}`,
		`{"id":"a","title":"X","kind":"parameter","value_type":"boolean","writable":true,"command":"missing"}`,
	} {
		var item Capability
		if err := json.Unmarshal([]byte(raw), &item); err != nil {
			t.Fatal(err)
		}
		if _, err := resolveCapabilities([]Capability{item}); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
