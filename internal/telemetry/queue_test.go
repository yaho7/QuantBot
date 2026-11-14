package telemetry

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/metricsdb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

func TestQueueAdmissionAndDrainAfterClientCancellation(t *testing.T) {
	stores, err := storage.Open(t.Context(), filepath.Join(t.TempDir(), "queue"))
	if err != nil {
		t.Fatal(err)
	}
	defer stores.Close()
	q := newQueue(stores.Metrics.Write, QueueConfig{Capacity: 1, Batch: 1, Flush: time.Millisecond}, nil)
	defer q.close()
	block, err := stores.Metrics.Write.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer block.Rollback()
	agent := strategy.Agent{StrategyID: "paper", InstanceID: "worker"}
	record := func(id string) metricJob {
		return metricJob{agent: agent, records: []indexedRecord{{Record: Record{
			ID: id, Kind: "metric", Series: "value", ObservedAt: time.Now().UnixMilli(), Data: []byte(`{"name":"test","value":"1"}`),
		}}}}
	}

	finished := make(chan error, 2)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go func() {
		_, err := q.submit(ctx, record("first"))
		finished <- err
	}()
	waitFor(t, func() bool { return stores.Metrics.Write.Stats().WaitCount > 0 })
	go func() {
		_, err := q.submit(t.Context(), record("second"))
		finished <- err
	}()
	waitFor(t, func() bool { return len(q.jobs) == 1 })
	if _, err := q.submit(t.Context(), record("third")); !errors.Is(err, errQueueFull) {
		t.Fatalf("expected queue full, got %v", err)
	}
	cancel()
	if err := <-finished; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled caller got %v", err)
	}
	if err := block.Rollback(); err != nil {
		t.Fatal(err)
	}
	q.close()
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if _, err := q.submit(t.Context(), record("late")); !errors.Is(err, errClosing) {
		t.Fatalf("closed queue returned %v", err)
	}
	for _, id := range []string{"first", "second"} {
		if _, err := metricsdb.New(stores.Metrics.Read).SampleFingerprint(t.Context(), metricsdb.SampleFingerprintParams{
			StrategyID: agent.StrategyID, Kind: "metric", ReportID: id,
		}); err != nil {
			t.Fatalf("admitted report %s did not commit: %v", id, err)
		}
	}
}

func waitFor(t *testing.T, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatal("condition did not become true")
		}
		time.Sleep(time.Millisecond)
	}
}
