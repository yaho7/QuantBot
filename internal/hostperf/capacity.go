package hostperf

import (
	"database/sql"
	"math"
	"net/http"
	"slices"
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
	Samples        int        `json:"sampleMinutes,omitempty"`
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
	boot, err := s.reportBoot(ctx, h)
	if err != nil {
		writeError(w, err)
		return
	}
	recent, err := s.hostReadings(ctx, h, boot, now.Add(-freshness).UnixMilli(), 240)
	if err != nil {
		writeError(w, err)
		return
	}
	out.Reason = "host_stale"
	if len(recent) == 0 || !fresh(now, recent[0].ObservedAt) {
		httpapi.JSON(w, 200, out)
		return
	}
	out.Reason = "host_metrics_missing"
	cpu, mem, reason := headroom(h.Capacity, recent)
	if reason != "" {
		out.Reason = reason
		httpapi.JSON(w, 200, out)
		return
	}
	if m.Budget != nil {
		out.Budget, out.Source = m.Budget, "declared"
	} else {
		out.Reason = "process_stale"
		if m.Stale {
			httpapi.JSON(w, 200, out)
			return
		}
		out.Reason = "insufficient_history"
		out.Budget, out.Samples, err = s.historicalBudget(r, m, now)
		if err != nil {
			writeError(w, err)
			return
		}
		if out.Budget == nil {
			httpapi.JSON(w, 200, out)
			return
		}
		out.Source = "p95"
	}
	n, limiting := additional(h.Capacity, *out.Budget, cpu, mem, reserve)
	out.Additional, out.Bottleneck, out.Reason = &n, limiting, ""
	httpapi.JSON(w, 200, out)
}

func headroom(cap resources, rows []reading[hostSample]) (float64, float64, string) {
	cpu, mem := cap.CPUCores, float64(cap.Memory)
	if len(rows) == 0 || !cap.valid() || rows[0].Data.CPU == nil || rows[0].Data.Available == nil {
		return 0, 0, "host_metrics_missing"
	}
	var firstSwap *int64
	for _, r := range rows {
		if p := r.Data.Pressure; p != nil && *p {
			return 0, 0, "swap_pressure"
		}
		if swap := r.Data.Swap; swap != nil {
			if firstSwap == nil {
				firstSwap = swap
			} else if *firstSwap > *swap {
				return 0, 0, "swap_pressure"
			}
		}
		if r.Data.CPU != nil {
			cpu = min(cpu, cap.CPUCores*(1-*r.Data.CPU/100))
		}
		if r.Data.Available != nil {
			mem = min(mem, float64(*r.Data.Available))
		}
	}
	return cpu, mem, ""
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

func (s *Service) historicalBudget(r *http.Request, m member, now time.Time) (*resources, int, error) {
	rows, err := s.stores.Metrics.Read.QueryContext(r.Context(), `SELECT observed_at/60000 AS minute,
		MAX(json_extract(process_data,'$.cpu_cores_used')),MAX(json_extract(process_data,'$.rss_bytes'))
		FROM performance_samples WHERE strategy_id=? AND instance_id=? AND boot_id=? AND process_data IS NOT NULL
		AND observed_at BETWEEN ? AND ? AND json_type(process_data,'$.cpu_cores_used') IS NOT NULL
		AND json_type(process_data,'$.rss_bytes') IS NOT NULL
		GROUP BY minute ORDER BY minute`, m.Strategy, m.Instance, m.Boot, now.Add(-24*time.Hour).UnixMilli(), now.UnixMilli())
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var cpus []float64
	var memories []int64
	for rows.Next() {
		var minute, mem int64
		var cpu float64
		if err := rows.Scan(&minute, &cpu, &mem); err != nil {
			return nil, 0, err
		}
		cpus, memories = append(cpus, cpu), append(memories, mem)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	n := len(cpus)
	if n < 30 {
		return nil, n, nil
	}
	slices.Sort(cpus)
	slices.Sort(memories)
	idx := int(math.Ceil(float64(n)*.95)) - 1
	budget := resources{CPUCores: cpus[idx], Memory: memories[idx]}
	if !budget.valid() {
		return nil, n, nil
	}
	return &budget, n, nil
}
