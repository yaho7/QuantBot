package telemetry

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/metricsdb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

func TestRollupsPreserveCandleOrderExactVolumeAndRetention(t *testing.T) {
	ctx := t.Context()
	stores, err := storage.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer stores.Close()
	s, err := New(stores, QueueConfig{Capacity: 8, Batch: 8, Flush: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	agent := strategy.Agent{StrategyID: "paper", InstanceID: "worker"}
	now := time.Now().Truncate(time.Hour)
	at := now.UnixMilli()
	series := seriesKey("BTC", "60")
	record := func(id string, offset int64, body string) indexedRecord {
		return indexedRecord{Record: Record{
			ID: id, Kind: "ohlcv", ObservedAt: at + offset, Series: series, Data: json.RawMessage(body),
		}}
	}
	last := record("late", minute, `{"open":"2","high":"8","low":"0.2","close":"5","volume":"123456789012345678901234.000000000000000001"}`)
	first := record("first", 0, `{"open":"1","high":"3","low":"0.1","close":"2","volume":"0.000000000000000002"}`)
	ack, err := s.queue.submit(ctx, metricJob{agent: agent, records: []indexedRecord{last, first, last}})
	if err != nil || ack.Inserted != 2 || ack.Duplicate != 1 {
		t.Fatalf("write candles: %+v, %v", ack, err)
	}

	q := metricsdb.New(stores.Metrics.Read)
	for _, item := range tiers[1:] {
		resolution := item.resolution
		body, err := q.GetRollup(ctx, metricsdb.GetRollupParams{
			StrategyID: agent.StrategyID, InstanceID: agent.InstanceID, Kind: "ohlcv", Series: series,
			Resolution: resolution, Bucket: bucketAt(at, resolution),
		})
		if err != nil {
			t.Fatal(err)
		}
		var a aggregate
		if err := json.Unmarshal([]byte(body), &a); err != nil {
			t.Fatal(err)
		}
		if a.Count != 2 || a.Open != "1" || a.Close != "5" || a.High != "8" || a.Low != "0.1" ||
			a.Volume != "123456789012345678901234.000000000000000003" {
			t.Fatalf("resolution %d did not aggregate correctly: %+v", resolution, a)
		}
	}
	req := historyRequest{strategy: agent.StrategyID, instance: agent.InstanceID, kind: "ohlcv", series: series,
		start: at, end: at + 2*minute, maxPoints: 8}
	raw, err := queryHistory(ctx, q, req, now)
	if err != nil || len(raw.Points) != 2 || raw.ResolutionMs != 0 || raw.Points[0].Open != "1" {
		t.Fatalf("unexpected raw query: %+v, %v", raw, err)
	}
	req.maxPoints = 1
	grouped, err := queryHistory(ctx, q, req, now)
	if err != nil || len(grouped.Points) != 1 || grouped.Points[0].Count != 2 {
		t.Fatalf("unexpected point budget result: %+v, %v", grouped, err)
	}
	if err := s.prune(ctx, now.Add(31*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	coarse, err := queryHistory(ctx, q, req, now.Add(31*24*time.Hour))
	if err != nil || len(coarse.Points) != 1 || coarse.Points[0].Count != 2 {
		t.Fatalf("rollup did not survive retention: %+v, %v", coarse, err)
	}
	if raw, err := q.ListRawSeries(ctx, metricsdb.ListRawSeriesParams{
		StrategyID: agent.StrategyID, InstanceID: agent.InstanceID, Kind: "ohlcv", Series: series,
		StartAt: at, EndAt: at + 2*minute, Maximum: 10,
	}); err != nil || len(raw) != 0 {
		t.Fatalf("raw retention failed: %+v, %v", raw, err)
	}
}
