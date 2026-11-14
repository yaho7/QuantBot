package control

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/yaho7/QuantBot/internal/httpapi"
)

type Capability struct {
	ID           string       `json:"id"`
	Kind         string       `json:"kind"`
	Title        string       `json:"title"`
	Description  string       `json:"description,omitempty"`
	Group        string       `json:"group,omitempty"`
	ValueType    string       `json:"value_type"`
	Unit         string       `json:"unit,omitempty"`
	Precision    *int         `json:"precision,omitempty"`
	Constraints  Constraints  `json:"constraints,omitempty"`
	History      bool         `json:"history"`
	Presentation Presentation `json:"presentation,omitempty"`
	Writable     bool         `json:"writable,omitempty"`
	Command      string       `json:"command,omitempty"`
	InputSchema  *ValueSchema `json:"input_schema,omitempty"`
	ValueSchema  *ValueSchema `json:"value_schema,omitempty"`
	Risk         string       `json:"risk,omitempty"`
	Confirm      bool         `json:"confirm,omitempty"`
	Timeout      int          `json:"timeout_seconds,omitempty"`
	StaleAfter   int          `json:"stale_after_seconds,omitempty"`
	Alert        *AlertHint   `json:"alert_suggestion,omitempty"`
	AtomicBatch  []string     `json:"atomic_parameters,omitempty"`
}

type Constraints struct {
	Min       string   `json:"min,omitempty"`
	Max       string   `json:"max,omitempty"`
	Step      string   `json:"step,omitempty"`
	MaxLength int      `json:"max_length,omitempty"`
	Options   []Option `json:"options,omitempty"`
}

type Presentation struct {
	Suggested bool     `json:"suggested"`
	Surface   []string `json:"surface,omitempty"`
	Renderer  string   `json:"preferred_renderer,omitempty"`
	Size      string   `json:"default_size,omitempty"`
	Order     int      `json:"order,omitempty"`
}

type AlertHint struct {
	Type      string `json:"type"`
	Threshold string `json:"threshold,omitempty"`
}

type ValueSchema struct {
	Type        string                 `json:"type"`
	Constraints Constraints            `json:"constraints,omitempty"`
	Properties  map[string]ValueSchema `json:"properties,omitempty"`
	Required    []string               `json:"required,omitempty"`
	Items       *ValueSchema           `json:"items,omitempty"`
}

func (c Capability) IsControl() bool { return c.Kind == "action" || c.Kind == "parameter" }
func (c Capability) Expired(at int64, now time.Time) bool {
	return c.StaleAfter > 0 && at <= now.Add(-time.Duration(c.StaleAfter)*time.Second).UnixMilli()
}

func (c Capability) Validate() error {
	if !slices.Contains([]string{"metric", "state", "parameter", "action", "resource", "event"}, c.Kind) ||
		!controlID.MatchString(c.ID) || strings.TrimSpace(c.Title) == "" || len(c.Title) > 160 ||
		len(c.Description) > 1000 || len(c.Group) > 80 || len(c.Unit) > 40 ||
		c.Precision != nil && (*c.Precision < 0 || *c.Precision > 18) || c.StaleAfter < 0 || c.StaleAfter > 86400*30 ||
		c.Timeout < 0 || c.Timeout > 3600 || !slices.Contains([]string{"", "low", "medium", "high", "critical"}, c.Risk) {
		return errors.New("invalid capability metadata")
	}
	for i, surface := range c.Presentation.Surface {
		if surface != "overview" && surface != "strategy" || slices.Contains(c.Presentation.Surface[:i], surface) {
			return errors.New("invalid or duplicate presentation surface")
		}
	}
	if !slices.Contains([]string{"", "small", "medium", "large", "full"}, c.Presentation.Size) ||
		c.Presentation.Order < -10000 || c.Presentation.Order > 10000 {
		return errors.New("invalid presentation size or order")
	}
	if !c.IsControl() && (c.Writable || c.Command != "" || c.InputSchema != nil || c.Risk != "" || c.Confirm || c.Timeout != 0) ||
		c.Command != "" && !controlID.MatchString(c.Command) || len(c.AtomicBatch) != 0 && (c.Kind != "action" || !c.Writable || c.InputSchema != nil) {
		return errors.New("invalid command declaration")
	}
	if c.Kind == "action" && (!c.Writable || c.History || c.ValueType != "null" || c.ValueSchema != nil) ||
		c.Kind == "metric" && c.ValueType != "decimal" ||
		(c.Kind == "resource" || c.Kind == "event") && c.ValueType != "object" && c.ValueType != "array" ||
		c.Kind != "action" && c.ValueType == "null" {
		return errors.New("value_type does not match capability kind")
	}
	if c.ValueSchema != nil && (c.ValueSchema.Type != c.ValueType || !c.Constraints.empty()) {
		return errors.New("value_schema must match value_type and own its constraints")
	}
	if err := c.schema().validate(0); err != nil {
		return err
	}
	if c.InputSchema != nil {
		if !c.Writable {
			return errors.New("input_schema requires a writable capability")
		}
		if c.Kind == "parameter" && c.InputSchema.Type != c.ValueType {
			return errors.New("parameter input_schema.type must match value_type")
		}
		if err := c.InputSchema.validate(0); err != nil {
			return err
		}
	}
	if c.Alert != nil {
		if c.Kind != "state" && c.Kind != "metric" {
			return errors.New("alert suggestions require a state or metric capability")
		}
		switch c.Alert.Type {
		case "stale":
			if c.StaleAfter == 0 || c.Alert.Threshold != "" {
				return errors.New("stale alerts require stale_after_seconds")
			}
		case "above", "below":
			if _, err := parseDecimal(c.Alert.Threshold); err != nil || c.ValueType != "decimal" {
				return errors.New("threshold alerts require a decimal threshold and value")
			}
		default:
			return errors.New("invalid alert suggestion")
		}
	}
	if c.Presentation.Renderer != "" && !slices.Contains(c.renderers(), c.Presentation.Renderer) {
		return errors.New("renderer does not match capability kind or value type")
	}
	if c.IsControl() {
		return c.Definition().Validate()
	}
	return nil
}

func (c Capability) schema() ValueSchema {
	if c.ValueSchema != nil {
		return *c.ValueSchema
	}
	return ValueSchema{Type: c.ValueType, Constraints: c.Constraints}
}

func (c Capability) renderers() []string {
	switch c.Kind {
	case "metric":
		if c.History {
			return []string{"number", "line"}
		}
		return []string{"number"}
	case "state":
		if c.ValueType == "decimal" && c.History {
			return []string{"status", "number", "line"}
		}
		return []string{"status"}
	case "resource":
		if c.History && c.candleSchema() {
			return []string{"table", "candlestick"}
		}
		return []string{"table"}
	case "event":
		return []string{"table"}
	case "action":
		if c.InputSchema != nil || len(c.AtomicBatch) > 0 {
			return []string{"form"}
		}
		return []string{"button"}
	case "parameter":
		if !c.Writable {
			return []string{"status"}
		}
		switch c.ValueType {
		case "boolean":
			return []string{"switch"}
		case "decimal":
			if c.Constraints.Min != "" && c.Constraints.Max != "" && c.Constraints.Step != "" {
				return []string{"slider", "number_input"}
			}
			return []string{"number_input"}
		case "string":
			if len(c.Constraints.Options) > 0 {
				return []string{"select"}
			}
			return []string{"text"}
		case "string_list":
			return []string{"multiselect"}
		case "object":
			return []string{"form"}
		}
	}
	return nil
}

func (c Capability) Renderer() string {
	if c.Presentation.Renderer != "" {
		return c.Presentation.Renderer
	}
	renders := c.renderers()
	if c.Kind == "metric" && c.History {
		return "line"
	}
	if len(renders) == 0 {
		return ""
	}
	return renders[0]
}

func (c Capability) Definition() Definition {
	d := Definition{
		ID: c.ID, Title: c.Title, Description: c.Description, Category: c.Group, Size: c.Presentation.Size,
		ReadOnly: !c.Writable, Risk: c.Risk, Confirm: c.Confirm || len(c.AtomicBatch) > 0, TimeoutSeconds: c.Timeout,
		Capability: &c,
	}
	switch c.Renderer() {
	case "button":
		d.Kind = Button
	case "switch":
		d.Kind = Toggle
	case "slider":
		d.Kind = Slider
	case "number_input":
		d.Kind = NumberInput
	case "select":
		d.Kind = Select
	case "multiselect":
		d.Kind = MultiSelect
	case "form":
		d.Kind = Form
	case "text":
		d.Kind = TextInput
	default:
		d.Kind = Status
	}
	switch d.Kind {
	case Slider, NumberInput:
		d.Min, d.Max, d.Step = c.Constraints.Min, c.Constraints.Max, c.Constraints.Step
	case Select, MultiSelect:
		d.Options = c.Constraints.Options
	case TextInput:
		d.MaxLength = c.Constraints.MaxLength
	case Form:
		if c.InputSchema != nil {
			d.Fields = c.InputSchema.formFields()
		} else if c.ValueSchema != nil {
			d.Fields = c.ValueSchema.formFields()
		}
	}
	return d
}

func (c Capability) ValidateValue(raw json.RawMessage, actual bool) error {
	if c.Kind == "action" && actual {
		if bytes.Equal(raw, []byte("null")) {
			return nil
		}
		var state string
		if err := json.Unmarshal(raw, &state); err == nil && len(state) <= 1024 {
			return nil
		}
		return errors.New("action status must be text or null")
	}
	if err := c.schema().check(raw); err != nil && (actual || c.Kind != "action") {
		return err
	}
	if !actual && c.InputSchema != nil {
		return c.InputSchema.check(raw)
	}
	if !actual && c.Kind == "action" && len(c.AtomicBatch) == 0 && !bytes.Equal(raw, []byte("null")) {
		return errors.New("action without inputs requires null")
	}
	return nil
}

func (v ValueSchema) validate(depth int) error {
	if depth >= 6 {
		return errors.New("value schema nesting exceeds six levels")
	}
	if v.Type != "object" && (len(v.Properties) != 0 || len(v.Required) != 0) || v.Type != "array" && v.Items != nil {
		return errors.New("schema shape does not apply to its type")
	}
	switch v.Type {
	case "object":
		if len(v.Properties) == 0 || len(v.Properties) > 32 {
			return errors.New("object schema requires 1–32 properties")
		}
		for key, item := range v.Properties {
			if !controlID.MatchString(key) {
				return errors.New("invalid property ID")
			}
			if err := item.validate(depth + 1); err != nil {
				return err
			}
		}
		for i, key := range v.Required {
			if _, ok := v.Properties[key]; !ok || slices.Contains(v.Required[:i], key) {
				return errors.New("invalid required property")
			}
		}
	case "array":
		if v.Items == nil {
			return errors.New("array schema requires items")
		}
		return v.Items.validate(depth + 1)
	case "null", "boolean", "decimal", "string", "string_list":
		d := v.scalar()
		if d.Kind != Status {
			return d.Validate()
		}
	default:
		return errors.New("unsupported value_type")
	}
	if !v.Constraints.empty() {
		return errors.New("constraints do not apply to type")
	}
	return nil
}

func (c Constraints) empty() bool {
	return c.Min == "" && c.Max == "" && c.Step == "" && c.MaxLength == 0 && len(c.Options) == 0
}

func (v ValueSchema) scalar() Definition {
	d := Definition{ID: "field", Title: "Field", Kind: Status}
	switch v.Type {
	case "boolean":
		d.Kind = Toggle
	case "decimal":
		d.Kind = NumberInput
	case "string":
		d.Kind = TextInput
		if len(v.Constraints.Options) > 0 {
			d.Kind = Select
		}
	case "string_list":
		d.Kind = MultiSelect
	}
	d.Min, d.Max, d.Step = v.Constraints.Min, v.Constraints.Max, v.Constraints.Step
	d.Options, d.MaxLength = v.Constraints.Options, v.Constraints.MaxLength
	return d
}

func (v ValueSchema) check(raw json.RawMessage) error {
	if v.Type == "null" {
		if bytes.Equal(raw, []byte("null")) {
			return nil
		}
		return errors.New("expected null")
	}
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return errors.New("expected declared value type")
	}
	switch v.Type {
	case "object":
		var fields map[string]json.RawMessage
		if err := httpapi.Decode(raw, &fields); err != nil {
			return errors.New("expected object")
		}
		for key, field := range fields {
			declared, exists := v.Properties[key]
			if !exists {
				return fmt.Errorf("unknown field %q", key)
			}
			if err := declared.check(field); err != nil {
				return fmt.Errorf("field %q: %w", key, err)
			}
		}
		for _, key := range v.Required {
			if _, exists := fields[key]; !exists {
				return fmt.Errorf("missing field %q", key)
			}
		}
		return nil
	case "array":
		var rows []json.RawMessage
		if err := json.Unmarshal(raw, &rows); err != nil || len(rows) > 1000 {
			return errors.New("expected at most 1000 array items")
		}
		for _, row := range rows {
			if err := v.Items.check(row); err != nil {
				return err
			}
		}
		return nil
	default:
		return v.scalar().ValidateValue(raw, false)
	}
}

func (v ValueSchema) formFields() []Definition {
	var ids []string
	for id := range v.Properties {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	fields := make([]Definition, 0, len(ids))
	for _, id := range ids {
		field := v.Properties[id].scalar()
		if field.Kind != Status {
			field.ID, field.Title = id, id
			fields = append(fields, field)
		}
	}
	return fields
}

func (c Capability) candleSchema() bool {
	if c.ValueSchema == nil || c.ValueSchema.Type != "object" {
		return false
	}
	for _, key := range []string{"open", "high", "low", "close", "volume"} {
		if c.ValueSchema.Properties[key].Type != "decimal" || !slices.Contains(c.ValueSchema.Required, key) {
			return false
		}
	}
	return true
}

func resolveCapabilities(items []Capability) (map[string]Capability, error) {
	capabilities := make(map[string]Capability, len(items))
	for _, item := range items {
		if _, ok := capabilities[item.ID]; ok {
			return nil, errors.New("duplicate capability ID")
		}
		if err := item.Validate(); err != nil {
			return nil, fmt.Errorf("capability %q: %w", item.ID, err)
		}
		capabilities[item.ID] = item
	}
	for _, item := range items {
		if len(item.AtomicBatch) > 16 {
			return nil, errors.New("atomic parameter action supports up to 16 parameters")
		}
		for i, id := range item.AtomicBatch {
			target, exists := capabilities[id]
			if !exists || target.Kind != "parameter" || !target.Writable || slices.Contains(item.AtomicBatch[:i], id) {
				return nil, fmt.Errorf("invalid atomic parameter %q", id)
			}
		}
		if item.Kind == "parameter" && item.Command != "" && item.Command != item.ID {
			action, ok := capabilities[item.Command]
			if !item.Writable || !ok || action.Kind != "action" || len(action.AtomicBatch) != 0 {
				return nil, fmt.Errorf("parameter %q must link to a declared action", item.ID)
			}
		}
	}
	return capabilities, nil
}

func (c Capability) Dispatch() string {
	if c.Command != "" {
		return c.Command
	}
	return c.ID
}
