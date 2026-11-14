package telemetry

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/metricsdb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

var metricName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,95}$`)

type metricDefinition struct {
	Name        string `json:"name"`
	Label       string `json:"label"`
	Unit        string `json:"unit,omitempty"`
	Kind        string `json:"kind"`
	Description string `json:"description,omitempty"`
}

func (s *Service) defineMetrics(w http.ResponseWriter, r *http.Request, agent strategy.Agent) {
	var input struct {
		Version int                `json:"version"`
		Metrics []metricDefinition `json:"metrics"`
	}
	if !httpapi.ReadJSON(w, r, &input, 64<<10) {
		return
	}
	if input.Version != 1 || len(input.Metrics) < 1 || len(input.Metrics) > 100 {
		httpapi.Error(w, http.StatusBadRequest, "invalid_definition", "Provide version 1 and 1–100 metric definitions")
		return
	}
	definitions := make(map[string]string, len(input.Metrics))
	for _, item := range input.Metrics {
		if _, exists := definitions[item.Name]; exists || !metricName.MatchString(item.Name) ||
			strings.TrimSpace(item.Label) == "" || len(item.Label) > 120 || len(item.Unit) > 40 ||
			len(item.Description) > 1024 || !slices.Contains([]string{"gauge", "counter", "ratio"}, item.Kind) {
			httpapi.Error(w, http.StatusBadRequest, "invalid_definition", "Invalid or duplicate metric definition")
			return
		}
		body, err := json.Marshal(item)
		if err != nil {
			writeError(w, err)
			return
		}
		definitions[item.Name] = string(body)
	}
	ctx := r.Context()
	err := storage.WithTx(ctx, s.stores.Metrics.Write, func(tx *sql.Tx) error {
		q := metricsdb.New(tx)
		for name, body := range definitions {
			if err := q.SetMetricDefinition(ctx, metricsdb.SetMetricDefinitionParams{StrategyID: agent.StrategyID, Name: name, Definition: body}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
