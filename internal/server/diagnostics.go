package server

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/realtime"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/telemetry"
)

func diagnostics(stores *storage.Stores, reports *telemetry.Service, events *realtime.Bus, dir string) http.HandlerFunc {
	start := time.Now()
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		var online int64
		err := stores.Control.Read.QueryRowContext(ctx, `
			SELECT count(*) FROM agent_instances i
			JOIN strategies s ON s.id = i.strategy_id
			WHERE i.last_seen > ? AND s.archived_at IS NULL`, time.Now().Add(-45*time.Second).Unix()).Scan(&online)
		var samples int64
		err = errors.Join(err, stores.Metrics.Read.QueryRowContext(ctx, "SELECT count(*) FROM samples").Scan(&samples))
		if err != nil {
			httpapi.Error(w, http.StatusServiceUnavailable, "diagnostics_unavailable", "Database diagnostics unavailable")
			return
		}
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		var usage syscall.Rusage
		if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
			httpapi.Error(w, http.StatusServiceUnavailable, "diagnostics_unavailable", "Process diagnostics unavailable")
			return
		}
		rss := usage.Maxrss
		if runtime.GOOS != "darwin" {
			rss *= 1024
		}
		wal := map[string]int64{}
		for _, name := range []string{"control", "metrics"} {
			if info, err := os.Stat(filepath.Join(dir, name+".db-wal")); err == nil {
				wal[name] = info.Size()
			}
		}
		cpu := float64(usage.Utime.Sec+usage.Stime.Sec) + float64(usage.Utime.Usec+usage.Stime.Usec)/1e6
		httpapi.JSON(w, http.StatusOK, map[string]any{
			"version": "3.0.0", "uptimeSeconds": time.Since(start).Seconds(),
			"onlineAgents": online, "samples": samples, "queueDepth": reports.QueueDepth(),
			"writeFailures": reports.WriteFailures(), "sseSubscribers": events.Subscribers(),
			"peakRssBytes": rss, "heapBytes": memory.HeapAlloc, "cpuSeconds": cpu,
			"goroutines": runtime.NumGoroutine(), "walBytes": wal,
		})
	}
}
