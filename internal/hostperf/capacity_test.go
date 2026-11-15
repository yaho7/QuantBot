package hostperf

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/yaho7/QuantBot/internal/storage"
)

func TestHistoricalBudgetUsesDistinctMinutes(t *testing.T) {
	stores, err := storage.Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer stores.Close()
	s := New(stores)
	now := time.Now().Truncate(time.Minute)
	m := member{Strategy: "s", Instance: "i", Boot: "b"}
	insert := func(id string, at time.Time, data string) {
		t.Helper()
		if _, err := stores.Metrics.Write.ExecContext(t.Context(),
			`INSERT INTO performance_samples(host_id,strategy_id,instance_id,boot_id,revision,record_id,observed_at,received_at,duration_ms,process_data)
			VALUES('h','s','i','b',1,?,?,?,15000,?)`, id, at.UnixMilli(), at.UnixMilli(), data); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest("GET", "/", nil).WithContext(t.Context())
	for i := range 60 {
		insert(time.Unix(int64(i), 0).String(), now.Add(-time.Minute), `{"cpu_cores_used":1,"rss_bytes":42}`)
	}
	budget, n, err := s.historicalBudget(req, m, now)
	if err != nil || budget != nil || n != 1 {
		t.Fatalf("repeated short burst counted as coverage: %v %d %v", budget, n, err)
	}
	for i := 2; i <= 30; i++ {
		insert(time.Unix(int64(60+i), 0).String(), now.Add(-time.Duration(i)*time.Minute), `{"cpu_cores_used":0.5,"rss_bytes":40}`)
	}
	budget, n, err = s.historicalBudget(req, m, now)
	if err != nil || n != 30 || budget == nil || budget.CPUCores != 0.5 || budget.Memory != 40 {
		t.Fatalf("unexpected P95: %v %d %v", budget, n, err)
	}
}

func TestHeadroomRejectsSwapPressure(t *testing.T) {
	cpu := 25.0
	memory, oldSwap, newSwap := int64(700), int64(0), int64(20)
	rows := []reading[hostSample]{{Data: hostSample{CPU: &cpu, Available: &memory, Swap: &newSwap}}, {Data: hostSample{Swap: &oldSwap}}}
	_, _, reason := headroom(resources{CPUCores: 2, Memory: 1000}, rows)
	if reason != "swap_pressure" {
		t.Fatalf("expected swap pressure, got %q", reason)
	}
}
