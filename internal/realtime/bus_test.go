package realtime

import (
	"strconv"
	"testing"
)

func TestCoalescingAndSlowConsumerRefresh(t *testing.T) {
	b := New()
	queue, stop, ok := b.subscribe()
	if !ok {
		t.Fatal("initial subscription was rejected")
	}
	defer stop()
	for range 50 {
		b.Publish("paper", Status)
		b.Publish("paper", Telemetry)
	}
	b.flush()
	batch := <-queue
	if batch.Reset || len(batch.Changes) != 2 {
		t.Fatalf("expected two coalesced changes, got %+v", batch)
	}
	b.Publish("paper", Status)
	b.flush()
	b.Publish("paper", Commands)
	b.flush()
	if batch := <-queue; !batch.Reset {
		t.Fatalf("slow subscriber must refresh, got %+v", batch)
	}
}

func TestOverflowRefresh(t *testing.T) {
	b := New()
	queue, stop, _ := b.subscribe()
	defer stop()
	for i := range maxPending + 1 {
		b.Publish(strconv.Itoa(i), Alerts)
	}
	b.flush()
	if batch := <-queue; !batch.Reset || len(batch.Changes) != 0 {
		t.Fatalf("overflow must emit a bounded refresh, got %+v", batch)
	}
}
