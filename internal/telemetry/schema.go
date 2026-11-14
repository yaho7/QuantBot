package telemetry

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"sync"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/yaho7/QuantBot/internal/httpapi"
)

//go:embed schemas/report-v1.json
var reportSchema []byte

const reportSchemaURL = "https://quantbot.local/schemas/report-v1.json"

var loadSchema = sync.OnceValues(func() (*jsonschema.Schema, error) {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(reportSchema))
	if err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	if err := compiler.AddResource(reportSchemaURL, doc); err != nil {
		return nil, err
	}
	return compiler.Compile(reportSchemaURL)
})

type Record struct {
	ID           string          `json:"id"`
	Kind         string          `json:"kind"`
	ObservedAt   int64           `json:"observedAt"`
	Data         json.RawMessage `json:"data"`
	Series       string          `json:"-"`
	Associations *Associations   `json:"associations,omitempty"`
}

const backfillWindow = 7 * 24 * time.Hour

func (s *Service) decodeRecord(raw json.RawMessage, now time.Time) (Record, error) {
	var value map[string]any
	if err := httpapi.Decode(raw, &value); err != nil {
		return Record{}, err
	}
	if err := s.schema.Validate(value); err != nil {
		var validation *jsonschema.ValidationError
		if errors.As(err, &validation) {
			return Record{}, fmt.Errorf("record does not conform to schema: %s", validation.Error())
		}
		return Record{}, err
	}
	at, err := value["observedAt"].(json.Number).Int64()
	if err != nil || at > now.Add(2*time.Minute).UnixMilli() {
		return Record{}, errors.New("observedAt must be an integer UTC Unix millisecond timestamp no more than 2 minutes ahead")
	}
	kind := value["kind"].(string)
	if !critical(kind) && at < now.Add(-backfillWindow).UnixMilli() {
		return Record{}, errors.New("observedAt exceeds the 7-day metrics backfill window")
	}
	data := value["data"].(map[string]any)
	series, err := recordSeries(kind, data, at)
	if err != nil {
		return Record{}, err
	}
	var associations *Associations
	if links, exists := value["associations"]; exists {
		raw, err := json.Marshal(links)
		if err != nil {
			return Record{}, err
		}
		if err := json.Unmarshal(raw, &associations); err != nil {
			return Record{}, err
		}
	}
	body, err := json.Marshal(data)
	return Record{ID: value["id"].(string), Kind: kind, ObservedAt: at, Data: body, Series: series, Associations: associations}, err
}

func critical(kind string) bool {
	switch kind {
	case "order", "fill", "risk", "alert":
		return true
	}
	return false
}

func recordSeries(kind string, data map[string]any, observedAt int64) (string, error) {
	field := func(name string) string {
		result, _ := data[name].(string)
		return result
	}
	switch kind {
	case "equity", "performance":
		return seriesKey(field("accountId"), field("currency")), nil
	case "metric":
		return seriesKey(field("name"), field("accountId")), nil
	case "order":
		return seriesKey(field("accountId"), field("orderId")), nil
	case "fill":
		return seriesKey(field("accountId"), field("fillId")), nil
	case "position":
		if err := uniqueRows(data["positions"].([]any), "accountId", "positionId"); err != nil {
			return "", err
		}
		source := field("source")
		if source == "" {
			source = "strategy"
		}
		return source, nil
	case "portfolio":
		return "", uniqueRows(data["accounts"].([]any), "accountId", "currency")
	case "signal":
		return seriesKey(field("symbol"), field("name")), nil
	case "risk", "alert":
		return field("code"), nil
	case "ohlcv":
		interval, err := data["intervalSeconds"].(json.Number).Int64()
		if err != nil || observedAt%(1000*interval) != 0 {
			return "", errors.New("candle timestamp must align to the UTC interval start")
		}
		if !validCandle(field("open"), field("high"), field("low"), field("close"), field("volume")) {
			return "", errors.New("invalid candle price range or volume")
		}
		data["intervalSeconds"] = interval
		return seriesKey(field("symbol"), strconv.FormatInt(interval, 10)), nil
	default:
		return "", nil
	}
}

func exact(value string) *big.Rat {
	result, _ := new(big.Rat).SetString(value)
	return result
}

func seriesKey(first, second string) string {
	body, _ := json.Marshal([2]string{first, second})
	return string(body)
}

func uniqueRows(values []any, first, second string) error {
	seen := make(map[[2]string]bool, len(values))
	for _, item := range values {
		row := item.(map[string]any)
		key := [2]string{row[first].(string), row[second].(string)}
		if seen[key] {
			return fmt.Errorf("duplicate %s and %s", first, second)
		}
		seen[key] = true
	}
	return nil
}

func statusKind(kind string) bool {
	switch kind {
	case "status", "connection", "portfolio", "position", "performance":
		return true
	}
	return false
}

func validCandle(open, high, low, close, volume string) bool {
	o, h, l, c, v := exact(open), exact(high), exact(low), exact(close), exact(volume)
	return o != nil && h != nil && l != nil && c != nil && v != nil &&
		l.Cmp(o) <= 0 && l.Cmp(c) <= 0 && h.Cmp(o) >= 0 && h.Cmp(c) >= 0 && v.Sign() >= 0
}
