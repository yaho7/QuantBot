package theme

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
)

type Presentation struct {
	Light      Palette  `json:"light,omitempty"`
	Dark       Palette  `json:"dark,omitempty"`
	Sections   []string `json:"sections,omitempty"`
	CardView   string   `json:"cardView,omitempty"`
	Surface    string   `json:"surface,omitempty"`
	Font       string   `json:"font,omitempty"`
	Background string   `json:"background,omitempty"`
	Radius     *int     `json:"radius,omitempty"`
	Gap        *int     `json:"gap,omitempty"`
}

type Palette struct {
	Background string `json:"background,omitempty"`
	Surface    string `json:"surface,omitempty"`
	Foreground string `json:"foreground,omitempty"`
	Muted      string `json:"muted,omitempty"`
	Border     string `json:"border,omitempty"`
	Accent     string `json:"accent,omitempty"`
	Positive   string `json:"positive,omitempty"`
	Negative   string `json:"negative,omitempty"`
	Chart      string `json:"chart,omitempty"`
}

var hexColor = regexp.MustCompile(`^#[a-fA-F0-9]{6}$`)

func (p Presentation) validate(files map[string]string) error {
	for _, palette := range []Palette{p.Light, p.Dark} {
		for _, color := range []string{palette.Background, palette.Surface, palette.Foreground, palette.Muted,
			palette.Border, palette.Accent, palette.Positive, palette.Negative, palette.Chart} {
			if color != "" && !hexColor.MatchString(color) {
				return errors.New("palette colors must be six-digit hex values")
			}
		}
	}
	if !slices.Contains([]string{"", "large", "compact", "mini", "list"}, p.CardView) ||
		!slices.Contains([]string{"", "solid", "glass"}, p.Surface) ||
		!slices.Contains([]string{"", "system", "inter", "geist", "ibm-plex-mono"}, p.Font) ||
		p.Radius != nil && (*p.Radius < 4 || *p.Radius > 24) || p.Gap != nil && (*p.Gap < 8 || *p.Gap > 24) {
		return errors.New("invalid presentation options")
	}
	if p.Background != "" && !imageAsset(files[p.Background]) {
		return errors.New("background must reference an image in the theme bundle")
	}
	seen := map[string]bool{}
	for _, section := range p.Sections {
		if seen[section] || !slices.Contains([]string{"overview", "strategies", "activity", "alerts"}, section) {
			return errors.New("invalid or duplicate workbench section")
		}
		seen[section] = true
	}
	if len(p.Sections) > 0 && !seen["strategies"] {
		return errors.New("layout must include the strategy section")
	}
	return nil
}

type Setting struct {
	Key     string          `json:"key"`
	Label   string          `json:"label"`
	Type    string          `json:"type"`
	Default json.RawMessage `json:"default"`
	Options []string        `json:"options,omitempty"`
	Min     *float64        `json:"min,omitempty"`
	Max     *float64        `json:"max,omitempty"`
}

func validateSettingsSchema(settings []Setting, files map[string]string) error {
	if len(settings) > 48 {
		return errors.New("theme settings limit exceeded")
	}
	keys := map[string]bool{}
	for _, field := range settings {
		if !identifier.MatchString(field.Key) || keys[field.Key] || field.Label == "" || len(field.Label) > 120 ||
			field.Min != nil && field.Max != nil && *field.Min > *field.Max ||
			field.Type != "select" && len(field.Options) != 0 ||
			field.Type != "number" && field.Type != "slider" && (field.Min != nil || field.Max != nil) {
			return errors.New("invalid or duplicate theme setting")
		}
		keys[field.Key] = true
		if field.Type == "select" {
			if len(field.Options) == 0 || len(field.Options) > 64 {
				return errors.New("select requires 1–64 options")
			}
			options := map[string]bool{}
			for _, item := range field.Options {
				if item == "" || len(item) > 120 || options[item] {
					return errors.New("invalid or duplicate select option")
				}
				options[item] = true
			}
		}
		if err := field.validateValue(field.Default, files); err != nil {
			return err
		}
	}
	return nil
}

func (s Setting) validateValue(value json.RawMessage, files map[string]string) error {
	var typed any
	if err := json.Unmarshal(value, &typed); err != nil || typed == nil {
		return fmt.Errorf("setting %q requires a value", s.Key)
	}
	switch s.Type {
	case "switch":
		if _, ok := typed.(bool); ok {
			return nil
		}
	case "number", "slider":
		if number, ok := typed.(float64); ok && (s.Min == nil || number >= *s.Min) && (s.Max == nil || number <= *s.Max) {
			return nil
		}
	case "text", "select", "color", "image", "background":
		if value, ok := typed.(string); ok {
			switch s.Type {
			case "text":
				if len(value) <= 1024 {
					return nil
				}
			case "select":
				if slices.Contains(s.Options, value) {
					return nil
				}
			case "color":
				if hexColor.MatchString(value) {
					return nil
				}
			case "image", "background":
				if value == "" || imageAsset(files[value]) {
					return nil
				}
			}
		}
	}
	return fmt.Errorf("invalid value or type for setting %q", s.Key)
}
