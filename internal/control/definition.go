package control

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"slices"
	"unicode/utf8"
)

const (
	Button      = "button"
	Toggle      = "toggle"
	Slider      = "slider"
	NumberInput = "numberInput"
	TextInput   = "textInput"
	Select      = "select"
	MultiSelect = "multiSelect"
	Status      = "status"
	Metric      = "metricDisplay"
	Form        = "form"
)

var (
	controlID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
	decimal   = regexp.MustCompile(`^-?(0|[1-9][0-9]{0,23})(\.[0-9]{1,18})?$`)
)

type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type Definition struct {
	ID             string            `json:"id"`
	Kind           string            `json:"kind"`
	Title          string            `json:"title"`
	Description    string            `json:"description,omitempty"`
	Icon           string            `json:"icon,omitempty"`
	Category       string            `json:"category,omitempty"`
	Size           string            `json:"size,omitempty"`
	ReadOnly       bool              `json:"readOnly"`
	Disabled       bool              `json:"disabled"`
	Min            string            `json:"min,omitempty"`
	Max            string            `json:"max,omitempty"`
	Step           string            `json:"step,omitempty"`
	MaxLength      int               `json:"maxLength,omitempty"`
	Options        []Option          `json:"options,omitempty"`
	Fields         []Definition      `json:"fields,omitempty"`
	Risk           string            `json:"risk,omitempty"`
	Confirm        bool              `json:"confirm"`
	TimeoutSeconds int               `json:"timeoutSeconds,omitempty"`
	ResultLabels   map[string]string `json:"resultLabels,omitempty"`
}

func (d Definition) IsReadOnly() bool {
	return d.ReadOnly || d.Kind == Status || d.Kind == Metric
}

func (d Definition) RequiresConfirmation() bool {
	return d.Confirm || d.Risk == "high" || d.Risk == "critical"
}

func (d Definition) Validate() error {
	return d.validate(false)
}

func (d Definition) validate(field bool) error {
	if !controlID.MatchString(d.ID) || d.Title == "" || len(d.Title) > 160 ||
		len(d.Description) > 1000 || len(d.Icon) > 64 || len(d.Category) > 80 {
		return errors.New("invalid control ID, title or display metadata")
	}
	if !slices.Contains([]string{"", "small", "medium", "large", "full"}, d.Size) ||
		!slices.Contains([]string{"", "low", "medium", "high", "critical"}, d.Risk) ||
		d.TimeoutSeconds < 0 || d.TimeoutSeconds > 3600 || len(d.ResultLabels) > 12 {
		return errors.New("invalid size, risk, timeout or result labels")
	}
	for key, label := range d.ResultLabels {
		if !controlID.MatchString(key) || label == "" || len(label) > 160 {
			return errors.New("invalid result label")
		}
	}
	if d.Kind != NumberInput && d.Kind != Slider && (d.Min != "" || d.Max != "" || d.Step != "") ||
		d.Kind != TextInput && d.MaxLength != 0 ||
		d.Kind != Select && d.Kind != MultiSelect && len(d.Options) != 0 ||
		d.Kind != Form && len(d.Fields) != 0 {
		return errors.New("constraints do not apply to control kind")
	}
	if field && (d.Disabled || d.IsReadOnly() || d.Kind == Form || d.Kind == Button || d.Confirm || d.Risk != "") {
		return errors.New("invalid form field")
	}
	switch d.Kind {
	case Button, Toggle, Status, Metric:
	case NumberInput, Slider:
		minimum, err := parseOptional(d.Min)
		if err != nil {
			return err
		}
		maximum, err := parseOptional(d.Max)
		if err != nil {
			return err
		}
		step, err := parseOptional(d.Step)
		if err != nil {
			return err
		}
		if d.Kind == Slider && (minimum == nil || maximum == nil || step == nil) ||
			minimum != nil && maximum != nil && minimum.Cmp(maximum) >= 0 ||
			step != nil && step.Sign() <= 0 {
			return errors.New("invalid numeric range or step")
		}
	case TextInput:
		if d.MaxLength < 0 || d.MaxLength > 4096 {
			return errors.New("invalid text length")
		}
	case Select, MultiSelect:
		if len(d.Options) == 0 || len(d.Options) > 64 {
			return errors.New("select requires 1–64 options")
		}
		seen := map[string]bool{}
		for _, option := range d.Options {
			if option.Value == "" || len(option.Value) > 96 || option.Label == "" || len(option.Label) > 160 || seen[option.Value] {
				return errors.New("invalid or duplicate select option")
			}
			seen[option.Value] = true
		}
	case Form:
		if len(d.Fields) == 0 || len(d.Fields) > 16 {
			return errors.New("form requires 1–16 fields")
		}
		seen := map[string]bool{}
		for _, input := range d.Fields {
			if seen[input.ID] {
				return errors.New("duplicate form field")
			}
			seen[input.ID] = true
			if err := input.validate(true); err != nil {
				return fmt.Errorf("field %q: %w", input.ID, err)
			}
		}
	default:
		return errors.New("unknown control kind")
	}
	return nil
}

func parseOptional(input string) (*big.Rat, error) {
	if input == "" {
		return nil, nil
	}
	return parseDecimal(input)
}

func parseDecimal(input string) (*big.Rat, error) {
	if !decimal.MatchString(input) {
		return nil, errors.New("expected an exact decimal string")
	}
	value, _ := new(big.Rat).SetString(input)
	return value, nil
}

func (d Definition) ValidateValue(raw json.RawMessage, actual bool) error {
	if len(raw) == 0 {
		return errors.New("value is required")
	}
	if bytes.Equal(raw, []byte("null")) {
		if actual || d.Kind == Button {
			return nil
		}
		return errors.New("null is not a command input")
	}
	switch d.Kind {
	case Toggle:
		var value bool
		return json.Unmarshal(raw, &value)
	case Slider, NumberInput, Metric:
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return errors.New("expected an exact decimal string")
		}
		value, err := parseDecimal(text)
		if err != nil {
			return err
		}
		minimum, _ := parseOptional(d.Min)
		maximum, _ := parseOptional(d.Max)
		if minimum != nil && value.Cmp(minimum) < 0 || maximum != nil && value.Cmp(maximum) > 0 {
			return errors.New("value exceeds the declared range")
		}
		if step, _ := parseOptional(d.Step); step != nil {
			if minimum != nil {
				value.Sub(value, minimum)
			}
			if !value.Quo(value, step).IsInt() {
				return errors.New("value is not aligned to the declared step")
			}
		}
	case Status, TextInput:
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return errors.New("expected text")
		}
		limit := d.MaxLength
		if limit == 0 {
			limit = 1024
		}
		if utf8.RuneCountInString(value) > limit {
			return errors.New("text exceeds the declared length")
		}
	case Select:
		var value string
		if err := json.Unmarshal(raw, &value); err != nil || !d.hasOption(value) {
			return errors.New("expected a declared option")
		}
	case MultiSelect:
		var values []string
		if err := json.Unmarshal(raw, &values); err != nil || len(values) > len(d.Options) {
			return errors.New("expected an array of declared options")
		}
		seen := map[string]bool{}
		for _, value := range values {
			if seen[value] || !d.hasOption(value) {
				return errors.New("unknown or duplicate option")
			}
			seen[value] = true
		}
	case Form:
		var values map[string]json.RawMessage
		if err := json.Unmarshal(raw, &values); err != nil || len(values) != len(d.Fields) {
			return errors.New("expected all and only declared form fields")
		}
		for _, field := range d.Fields {
			if err := field.ValidateValue(values[field.ID], actual); err != nil {
				return fmt.Errorf("field %q: %w", field.ID, err)
			}
		}
	case Button:
		if actual {
			var state string
			if err := json.Unmarshal(raw, &state); err == nil && len(state) <= 1024 {
				return nil
			}
		}
		return errors.New("expected null for button invocation")
	default:
		return errors.New("unknown control kind")
	}
	return nil
}

func (d Definition) hasOption(value string) bool {
	return slices.ContainsFunc(d.Options, func(option Option) bool { return option.Value == value })
}
