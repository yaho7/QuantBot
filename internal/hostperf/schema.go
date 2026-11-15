package hostperf

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/yaho7/QuantBot/internal/httpapi"
)

//go:embed performance.json
var schemaJSON []byte

var schemas = sync.OnceValues(func() (map[string]*jsonschema.Schema, error) {
	const schemaURL = "https://quantbot.local/api/agent/schemas/performance.json"
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(schemaJSON))
	if err != nil {
		return nil, err
	}
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	if err := c.AddResource(schemaURL, doc); err != nil {
		return nil, err
	}
	out := make(map[string]*jsonschema.Schema)
	for _, key := range []string{"binding", "batch"} {
		out[key], err = c.Compile(schemaURL + "#/$defs/" + key)
		if err != nil {
			return nil, err
		}
	}
	return out, nil
})

func serveSchema(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/schema+json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(schemaJSON)
}

func readInput(w http.ResponseWriter, r *http.Request, target any, key string, limit int64) bool {
	var input map[string]any
	if !httpapi.ReadJSON(w, r, &input, limit) {
		return false
	}
	compiled, err := schemas()
	if err != nil {
		writeError(w, err)
		return false
	}
	if err := compiled[key].Validate(input); err != nil {
		httpapi.Error(w, 400, "invalid_performance", err.Error())
		return false
	}
	raw, err := json.Marshal(input)
	if err != nil {
		writeError(w, err)
		return false
	}
	if err := json.Unmarshal(raw, target); err != nil {
		httpapi.Error(w, 400, "invalid_performance", fmt.Sprintf("Invalid request: %v", err))
		return false
	}
	return true
}
