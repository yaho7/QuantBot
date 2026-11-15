package hostperf

import (
	"database/sql"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/httpapi"
)

type estimate struct {
	Additional     *int       `json:"additional"`
	Reason         string     `json:"reason,omitempty"`
	Bottleneck     string     `json:"bottleneck,omitempty"`
	Budget         *resources `json:"budget,omitempty"`
	Source         string     `json:"source,omitempty"`
	ReservePercent int        `json:"reservePercent"`
}

func (s *Service) capacity(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query := r.URL.Query()
	strategyID, instanceID := query.Get("strategyId"), query.Get("instanceId")
	reserve := 20
	var err error
	if query.Has("reservePercent") {
		reserve, err = strconv.Atoi(query.Get("reservePercent"))
	}
	if err != nil || reserve < 0 || reserve > 90 || !identity.MatchString(strategyID) || !identity.MatchString(instanceID) {
		httpapi.Error(w, 400, "invalid_estimate", "Select an instance and a reserve between 0 and 90 percent")
		return
	}
	h, err := s.findHost(ctx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	targets, err := s.members(ctx, "b.host_id=? AND b.strategy_id=? AND b.instance_id=?", h.ID, strategyID, instanceID)
	if err != nil {
		writeError(w, err)
		return
	}
	if len(targets) == 0 {
		writeError(w, sql.ErrNoRows)
		return
	}
	m := targets[0]
	now := time.Now()
	out := estimate{ReservePercent: reserve}
	view, err := s.viewHost(ctx, h, now)
	if err != nil {
		writeError(w, err)
		return
	}
	out.Reason = "host_stale"
	if view.Latest == nil || view.Stale {
		httpapi.JSON(w, 200, out)
		return
	}
	data := view.Latest.Data
	out.Reason = "host_metrics_missing"
	if view.Capacity == nil || !view.Capacity.valid() || data.CPU == nil || data.Available == nil {
		httpapi.JSON(w, 200, out)
		return
	}
	if data.Pressure != nil && *data.Pressure {
		out.Reason = "swap_pressure"
		httpapi.JSON(w, 200, out)
		return
	}
	if m.Budget != nil {
		out.Budget, out.Source = m.Budget, "declared"
	} else {
		out.Reason = "process_stale"
		if m.Stale || m.Latest == nil {
			httpapi.JSON(w, 200, out)
			return
		}
		data := m.Latest.Data
		out.Reason = "process_metrics_missing"
		if data.CPU == nil || data.RSS == nil {
			httpapi.JSON(w, 200, out)
			return
		}
		budget := resources{CPUCores: *data.CPU, Memory: *data.RSS}
		if !budget.valid() {
			httpapi.JSON(w, 200, out)
			return
		}
		out.Budget, out.Source = &budget, "latest"
	}
	n, limiting := additional(*view.Capacity, *out.Budget, view.Capacity.CPUCores*(1-*data.CPU/100), float64(*data.Available), reserve)
	out.Additional, out.Bottleneck, out.Reason = &n, limiting, ""
	httpapi.JSON(w, 200, out)
}

func additional(cap, budget resources, cpu, mem float64, reserve int) (int, string) {
	fraction := float64(reserve) / 100
	cpuRatio := max(0, cpu-cap.CPUCores*fraction) / budget.CPUCores
	memRatio := max(0, mem-float64(cap.Memory)*fraction) / float64(budget.Memory)
	limiting := "cpu"
	if memRatio < cpuRatio {
		limiting = "memory"
	} else if memRatio == cpuRatio {
		limiting = "both"
	}
	return int(min(math.Floor(min(cpuRatio, memRatio)), float64(1<<31-1))), limiting
}
