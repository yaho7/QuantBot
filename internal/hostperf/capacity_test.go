package hostperf

import "testing"

func TestAdditionalInstancesUsesLimitingResource(t *testing.T) {
	capacity := resources{CPUCores: 4, Memory: 1000}
	budget := resources{CPUCores: 0.4, Memory: 250}
	if n, limit := additional(capacity, budget, 3, 700, 20); n != 2 || limit != "memory" {
		t.Fatalf("got %d (%s), want 2 (memory)", n, limit)
	}
	if n, limit := additional(capacity, budget, .5, 700, 20); n != 0 || limit != "cpu" {
		t.Fatalf("got %d (%s), want 0 (cpu)", n, limit)
	}
}
