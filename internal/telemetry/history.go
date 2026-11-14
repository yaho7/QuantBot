package telemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/storage/metricsdb"
)

type historyPoint struct {
	At     int64  `json:"at"`
	Count  int64  `json:"count"`
	Open   string `json:"open"`
	High   string `json:"high"`
	Low    string `json:"low"`
	Close  string `json:"close"`
	Sum    string `json:"sum,omitempty"`
	Volume string `json:"volume,omitempty"`
}

type historyView struct {
	ResolutionMs int64          `json:"resolutionMs"`
	Points       []historyPoint `json:"points"`
}

type historyRequest struct {
	strategy  string
	instance  string
	kind      string
	series    string
	start     int64
	end       int64
	maxPoints int64
}

func (s *Service) history(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	start, startErr := strconv.ParseInt(query.Get("from"), 10, 64)
	end, endErr := strconv.ParseInt(query.Get("to"), 10, 64)
	points := int64(600)
	var pointsErr error
	if raw := query.Get("points"); raw != "" {
		points, pointsErr = strconv.ParseInt(raw, 10, 64)
	}
	input := historyRequest{
		strategy: chi.URLParam(r, "id"), instance: query.Get("instanceId"), kind: query.Get("kind"),
		series: query.Get("series"), start: start, end: end, maxPoints: points,
	}
	now := time.Now()
	if startErr != nil || endErr != nil || pointsErr != nil || start < 0 || end <= start ||
		end > now.Add(2*time.Minute).UnixMilli()+1 || end-start > int64(tiers[len(tiers)-1].retain/time.Millisecond) ||
		points < 1 || points > 2000 || !aggregatable(input.kind) ||
		len(input.instance) < 1 || len(input.instance) > 96 || len(input.series) < 1 || len(input.series) > 256 {
		httpapi.Error(w, http.StatusBadRequest, "invalid_history", "Provide instanceId, kind, series, an exclusive Unix millisecond range and 1–2000 points")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if _, err := controldb.New(s.stores.Control.Read).GetStrategy(ctx, input.strategy); err != nil {
		writeError(w, err)
		return
	}
	result, err := queryHistory(ctx, metricsdb.New(s.stores.Metrics.Read), input, now)
	if err != nil {
		writeError(w, err)
		return
	}
	httpapi.JSON(w, http.StatusOK, result)
}

const rawRetention = 14 * 24 * time.Hour

func queryHistory(ctx context.Context, q *metricsdb.Queries, r historyRequest, now time.Time) (historyView, error) {
	result := historyView{Points: make([]historyPoint, 0)}
	if r.start >= now.Add(-rawRetention).UnixMilli() {
		rows, err := q.ListRawSeries(ctx, metricsdb.ListRawSeriesParams{
			StrategyID: r.strategy, InstanceID: r.instance, Kind: r.kind, Series: r.series,
			StartAt: r.start, EndAt: r.end, Maximum: r.maxPoints + 1,
		})
		if err != nil {
			return result, err
		}
		if int64(len(rows)) <= r.maxPoints {
			for _, row := range rows {
				a, err := point(r.kind, row.ReportID, row.ObservedAt, row.Data)
				if err != nil {
					return result, err
				}
				result.Points = append(result.Points, historyPointAt(row.ObservedAt, a))
			}
			return result, nil
		}
	}

	base := tiers[len(tiers)-1].resolution
	for _, tier := range tiers {
		first := bucketAt(r.start, tier.resolution)
		if first >= bucketAt(now.Add(-tier.retain).UnixMilli(), tier.resolution) &&
			(bucketAt(r.end-1, tier.resolution)-first)/tier.resolution+1 <= r.maxPoints {
			base = tier.resolution
			break
		}
	}
	start := bucketAt(r.start, base)
	count := (bucketAt(r.end-1, base)-start)/base + 1
	group := (count + r.maxPoints - 1) / r.maxPoints
	result.ResolutionMs = base * group
	rows, err := q.ListRollups(ctx, metricsdb.ListRollupsParams{
		StrategyID: r.strategy, InstanceID: r.instance, Kind: r.kind, Series: r.series,
		Resolution: base, StartAt: start, EndAt: r.end, Maximum: count,
	})
	if err != nil {
		return result, err
	}
	var current aggregate
	var bucket int64
	for _, row := range rows {
		var a aggregate
		if err := json.Unmarshal([]byte(row.Summary), &a); err != nil {
			return result, err
		}
		groupAt := start + bucketAt(row.Bucket-start, result.ResolutionMs)
		if current.Count != 0 && groupAt != bucket {
			result.Points = append(result.Points, historyPointAt(bucket, current))
			current = aggregate{}
		}
		bucket = groupAt
		current.merge(a)
	}
	if current.Count != 0 {
		result.Points = append(result.Points, historyPointAt(bucket, current))
	}
	return result, nil
}

func historyPointAt(at int64, a aggregate) historyPoint {
	return historyPoint{At: at, Count: a.Count, Open: a.Open, High: a.High, Low: a.Low, Close: a.Close, Sum: a.Sum, Volume: a.Volume}
}
