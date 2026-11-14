package control

import (
	"encoding/json"
	"testing"
)

func TestControlValueConstraints(t *testing.T) {
	option := []Option{{Value: "a", Label: "Alpha"}, {Value: "b", Label: "Beta"}}
	for _, tc := range []struct {
		name       string
		definition Definition
		good       string
		bad        string
		actual     bool
	}{
		{"button", Definition{Kind: Button}, "null", "true", false},
		{"toggle", Definition{Kind: Toggle}, "true", `"true"`, false},
		{"slider", Definition{Kind: Slider, Min: "0.000000000000000001", Max: "2", Step: "0.1"}, `"0.300000000000000001"`, `"0.300000000000000002"`, false},
		{"number", Definition{Kind: NumberInput}, `"123456789012345678901234.012345678901234567"`, "1", false},
		{"text", Definition{Kind: TextInput, MaxLength: 2}, `"你好"`, `"你好啊"`, false},
		{"select", Definition{Kind: Select, Options: option}, `"b"`, `"c"`, false},
		{"multiple", Definition{Kind: MultiSelect, Options: option}, `["a","b"]`, `["a","a"]`, false},
		{"status", Definition{Kind: Status}, `"waiting"`, "false", true},
		{"metric", Definition{Kind: Metric}, `"0.0021"`, "0.0021", true},
		{"form", Definition{Kind: Form, Fields: []Definition{{ID: "allowed", Title: "Allowed", Kind: Toggle}}}, `{"allowed":true}`, `{"extra":false}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := tc.definition
			d.ID, d.Title = tc.name, tc.name
			if err := d.Validate(); err != nil {
				t.Fatal(err)
			}
			if err := d.ValidateValue(json.RawMessage(tc.good), tc.actual); err != nil {
				t.Fatalf("rejected valid value: %v", err)
			}
			if err := d.ValidateValue(json.RawMessage(tc.bad), tc.actual); err == nil {
				t.Fatalf("accepted invalid value %s", tc.bad)
			}
		})
	}
}
