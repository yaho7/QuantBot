package telemetry

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/yaho7/QuantBot/internal/storage/metricsdb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

const (
	minute = int64(time.Minute / time.Millisecond)
	day    = 24 * 60 * minute
)

type tier struct {
	resolution int64
	retain     time.Duration
}

var tiers = [...]tier{
	{minute, 30 * 24 * time.Hour},
	{5 * minute, 90 * 24 * time.Hour},
	{60 * minute, 365 * 24 * time.Hour},
	{day, 3 * 365 * 24 * time.Hour},
}

type aggregate struct {
	Count   int64  `json:"count"`
	FirstAt int64  `json:"firstAt"`
	FirstID string `json:"firstId"`
	LastAt  int64  `json:"lastAt"`
	LastID  string `json:"lastId"`
	Open    string `json:"open,omitempty"`
	High    string `json:"high,omitempty"`
	Low     string `json:"low,omitempty"`
	Close   string `json:"close,omitempty"`
	Volume  string `json:"volume,omitempty"`
	Sum     string `json:"sum,omitempty"`
}

type seriesPoint struct {
	Value  string `json:"value"`
	Open   string `json:"open"`
	High   string `json:"high"`
	Low    string `json:"low"`
	Close  string `json:"close"`
	Volume string `json:"volume"`
}

func aggregatable(kind string) bool {
	return kind == "equity" || kind == "metric" || kind == "ohlcv"
}

func point(kind, id string, observedAt int64, body string) (aggregate, error) {
	var value seriesPoint
	if err := json.Unmarshal([]byte(body), &value); err != nil {
		return aggregate{}, err
	}
	a := aggregate{Count: 1, FirstAt: observedAt, FirstID: id, LastAt: observedAt, LastID: id}
	if kind == "ohlcv" {
		a.Open, a.High, a.Low, a.Close, a.Volume = value.Open, value.High, value.Low, value.Close, value.Volume
	} else {
		a.Open, a.High, a.Low, a.Close, a.Sum = value.Value, value.Value, value.Value, value.Value, value.Value
	}
	return a, nil
}

func (a *aggregate) merge(b aggregate) {
	if a.Count == 0 {
		*a = b
		return
	}
	a.Count += b.Count
	if b.FirstAt < a.FirstAt || b.FirstAt == a.FirstAt && b.FirstID < a.FirstID {
		a.FirstAt, a.FirstID, a.Open = b.FirstAt, b.FirstID, b.Open
	}
	if b.LastAt > a.LastAt || b.LastAt == a.LastAt && b.LastID > a.LastID {
		a.LastAt, a.LastID, a.Close = b.LastAt, b.LastID, b.Close
	}
	if exact(b.High).Cmp(exact(a.High)) > 0 {
		a.High = b.High
	}
	if exact(b.Low).Cmp(exact(a.Low)) < 0 {
		a.Low = b.Low
	}
	if a.Volume != "" {
		a.Volume = sum(a.Volume, b.Volume)
	}
	if a.Sum != "" {
		a.Sum = sum(a.Sum, b.Sum)
	}
}

func sum(first, second string) string {
	x := exact(first)
	x.Add(x, exact(second))
	result := strings.TrimRight(strings.TrimRight(x.FloatString(18), "0"), ".")
	if result == "-0" {
		return "0"
	}
	return result
}

func bucketAt(at, resolution int64) int64 { return at / resolution * resolution }

type rollupBatch map[metricsdb.GetRollupParams]aggregate

func (b rollupBatch) add(ctx context.Context, q *metricsdb.Queries, agent strategy.Agent, record Record) error {
	value, err := point(record.Kind, record.ID, record.ObservedAt, string(record.Data))
	if err != nil {
		return err
	}
	for _, tier := range tiers {
		key := metricsdb.GetRollupParams{
			StrategyID: agent.StrategyID, InstanceID: agent.InstanceID, Kind: record.Kind, Series: record.Series,
			Resolution: tier.resolution, Bucket: bucketAt(record.ObservedAt, tier.resolution),
		}
		a, exists := b[key]
		if !exists {
			saved, err := q.GetRollup(ctx, key)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if err == nil {
				if err := json.Unmarshal([]byte(saved), &a); err != nil {
					return err
				}
			}
		}
		a.merge(value)
		b[key] = a
	}
	return q.TouchSeries(ctx, metricsdb.TouchSeriesParams{
		StrategyID: agent.StrategyID, InstanceID: agent.InstanceID, Kind: record.Kind,
		Series: record.Series, ObservedAt: record.ObservedAt,
	})
}

func (b rollupBatch) persist(ctx context.Context, q *metricsdb.Queries) error {
	for key, value := range b {
		body, err := json.Marshal(value)
		if err != nil {
			return err
		}
		if err := q.PutRollup(ctx, metricsdb.PutRollupParams{
			StrategyID: key.StrategyID, InstanceID: key.InstanceID, Kind: key.Kind, Series: key.Series,
			Resolution: key.Resolution, Bucket: key.Bucket, Summary: string(body),
		}); err != nil {
			return err
		}
	}
	return nil
}
