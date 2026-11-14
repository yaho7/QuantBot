package theme

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const Engine = "quantbot-theme-v1"
const BuiltinClassical = "classical"

type Manifest struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Author      string `json:"author"`
	Description string `json:"description"`
	Engine      string `json:"engine"`
	Type        string `json:"type"`
	Entry       string `json:"entry"`
	Preview     string `json:"preview,omitempty"`
	MinVersion  string `json:"minQuantBotVersion"`
	MaxVersion  string `json:"maxQuantBotVersion,omitempty"`
	Settings    string `json:"settingsSchema,omitempty"`
}

var identifier = regexp.MustCompile(`^[a-z][a-z0-9-]{0,47}$`)
var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$`)

func (m Manifest) validate(current string) error {
	if !identifier.MatchString(m.ID) || m.ID == BuiltinClassical {
		return errors.New("theme ID is invalid or reserved")
	}
	if strings.TrimSpace(m.Name) == "" || len(m.Name) > 100 || strings.TrimSpace(m.Author) == "" ||
		len(m.Author) > 120 || len(m.Description) > 1024 {
		return errors.New("invalid theme metadata")
	}
	if !versionPattern.MatchString(m.Version) || m.Engine != Engine ||
		(m.Type != "declarative" && m.Type != "frontend") {
		return errors.New("invalid theme version, engine or type")
	}
	if !versionPattern.MatchString(m.MinVersion) || !versionPattern.MatchString(current) ||
		(m.MaxVersion != "" && !versionPattern.MatchString(m.MaxVersion)) {
		return errors.New("expected release versions in major.minor.patch format")
	}
	if compareVersion(current, m.MinVersion) < 0 || m.MaxVersion != "" && compareVersion(current, m.MaxVersion) >= 0 {
		return fmt.Errorf("theme is incompatible with QuantBot %s", current)
	}
	return nil
}

func compareVersion(a, b string) int {
	parse := func(s string) []int {
		fields := strings.Split(s, ".")
		parts := make([]int, len(fields))
		for i, field := range fields {
			parts[i], _ = strconv.Atoi(field)
		}
		return parts
	}
	return slices.Compare(parse(a), parse(b))
}
