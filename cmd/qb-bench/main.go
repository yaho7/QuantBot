// qb-bench starts an isolated QuantBot service and exercises the public HTTP
// entry points. All strategy operations are simulated locally.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

type options struct {
	binary   string
	agents   int
	cycles   int
	points   int
	streams  int
	control  int
	history  int
	parallel int
	idle     time.Duration
}

func main() {
	var o options
	flag.StringVar(&o.binary, "binary", "", "path to the QuantBot executable")
	flag.IntVar(&o.agents, "agents", 10, "number of simulated Agents")
	flag.IntVar(&o.cycles, "cycles", 5, "report cycles per Agent")
	flag.IntVar(&o.points, "points", 1, "records per report")
	flag.IntVar(&o.streams, "streams", 0, "simultaneous SSE subscribers")
	flag.IntVar(&o.control, "controls", 0, "command cycles alongside telemetry")
	flag.IntVar(&o.history, "history", 20, "history queries after the workload")
	flag.IntVar(&o.parallel, "parallel", 32, "maximum concurrent Agents")
	flag.DurationVar(&o.idle, "idle", time.Second, "idle measurement window")
	flag.Parse()
	if err := run(o); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

type diagnostics struct {
	OnlineAgents   int64
	Samples        int64
	QueueDepth     int64
	WriteFailures  uint64
	SseSubscribers int64
	PeakRssBytes   int64
	HeapBytes      uint64
	CpuSeconds     float64
	WalBytes       map[string]int64
}

func run(o options) error {
	if o.binary == "" || o.agents < 0 || o.agents > 10000 || o.parallel < 1 || o.points < 1 || o.points > 250 || o.cycles < 0 {
		return fmt.Errorf("provide a binary and valid workload bounds")
	}
	path, err := filepath.Abs(o.binary)
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "quantbot-benchmark-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	process := exec.CommandContext(ctx, path, "serve")
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "QB_") {
			process.Env = append(process.Env, value)
		}
	}
	process.Env = append(process.Env, "QB_DATA_DIR="+filepath.Join(dir, "data"), "QB_LISTEN=127.0.0.1:0", "GOMAXPROCS=2")
	logs, err := process.StderrPipe()
	if err != nil {
		return err
	}
	if err := process.Start(); err != nil {
		return err
	}
	defer func() {
		_ = process.Process.Signal(os.Interrupt)
		_ = process.Wait()
	}()
	scanner := bufio.NewScanner(logs)
	var origin string
	for scanner.Scan() {
		if _, addr, ok := strings.Cut(scanner.Text(), "address="); ok {
			origin = "http://" + strings.Trim(addr, "\"")
			break
		}
	}
	if origin == "" {
		return fmt.Errorf("service did not announce a listener")
	}
	go func() {
		for scanner.Scan() {
		}
	}()
	client := &api{origin: origin, client: &http.Client{Transport: &http.Transport{
		MaxIdleConns: 256, MaxIdleConnsPerHost: 128,
	}}}
	defer client.client.CloseIdleConnections()
	if err := client.setup(ctx); err != nil {
		return err
	}
	w := &workload{api: client, stats: requests{byName: make(map[string][]time.Duration)}}
	var agents []agent
	for i := 0; i < o.agents; i++ {
		id, token, err := client.createStrategy(ctx, fmt.Sprintf("Agent %04d", i))
		if err != nil {
			return err
		}
		worker, err := client.connect(ctx, strconv.Itoa(i), id, token)
		if err != nil {
			return err
		}
		agents = append(agents, worker)
	}
	var executor agent
	if o.control > 0 {
		executor, err = w.prepareControl(ctx)
		if err != nil {
			return err
		}
	}
	streamCtx, stopStreams := context.WithCancel(ctx)
	streams, err := w.openStreams(streamCtx, o.streams)
	defer func() { stopStreams(); streams.Wait() }()
	if err != nil {
		return err
	}

	var before diagnostics
	if _, err := client.call(ctx, "GET", "/admin/diagnostics", "", "", nil, &before); err != nil {
		return err
	}
	start := time.Now()
	var peakQueue int64
	var monitor sync.WaitGroup
	measureCtx, stopMeasure := context.WithCancel(ctx)
	monitor.Go(func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-measureCtx.Done():
				return
			case <-ticker.C:
				var sample diagnostics
				if _, err := client.call(measureCtx, "GET", "/admin/diagnostics", "", "", nil, &sample); err == nil {
					peakQueue = max(peakQueue, sample.QueueDepth)
				}
			}
		}
	})
	var failures []error
	var mu sync.Mutex
	run := func(work func() error) {
		if err := work(); err != nil {
			mu.Lock()
			failures = append(failures, err)
			mu.Unlock()
		}
	}
	var workers sync.WaitGroup
	limit := make(chan struct{}, o.parallel)
	for _, worker := range agents {
		limit <- struct{}{}
		workers.Go(func() {
			defer func() { <-limit }()
			run(func() error {
				for range o.cycles {
					if err := w.agentCycle(ctx, worker, o.points); err != nil {
						return err
					}
				}
				return nil
			})
		})
	}
	if o.control > 0 {
		workers.Go(func() {
			run(func() error {
				for i := range o.control {
					if err := w.controlCycle(ctx, executor, i); err != nil {
						return err
					}
				}
				return nil
			})
		})
	}
	if len(agents) == 0 && o.control == 0 {
		select {
		case <-time.After(o.idle):
		case <-ctx.Done():
		}
	}
	workers.Wait()
	if len(agents) > 0 {
		run(func() error { return w.historyCycle(ctx, agents[0], o.history) })
	}
	elapsed := time.Since(start)
	stopMeasure()
	monitor.Wait()
	var after diagnostics
	if _, err := client.call(ctx, "GET", "/admin/diagnostics", "", "", nil, &after); err != nil {
		return err
	}
	type latency struct {
		Count int
		P50Ms float64
		P95Ms float64
		P99Ms float64
	}
	latencies := make(map[string]latency)
	total := 0
	for name, values := range w.stats.byName {
		slices.Sort(values)
		percentile := func(p float64) float64 {
			return float64(values[int(float64(len(values)-1)*p)]) / float64(time.Millisecond)
		}
		latencies[name] = latency{len(values), percentile(.5), percentile(.95), percentile(.99)}
		total += len(values)
	}
	result := map[string]any{
		"platform": runtime.GOOS + "/" + runtime.GOARCH, "serverGomaxprocs": 2,
		"agents": o.agents, "cycles": o.cycles, "recordsPerReport": o.points, "controls": o.control,
		"streams": o.streams, "elapsedSeconds": elapsed.Seconds(), "requestsPerSecond": float64(total) / elapsed.Seconds(),
		"writesPerSecond":  float64(after.Samples-before.Samples) / elapsed.Seconds(),
		"cpuPercent":       100 * (after.CpuSeconds - before.CpuSeconds) / elapsed.Seconds(),
		"queuePeakSampled": peakQueue, "before": before, "after": after, "latency": latencies,
		"sentRecords": w.sent.Load(), "insertedAck": w.saved.Load(), "duplicateAck": w.replays.Load(),
		"rejected": w.rejected.Load(), "retries": w.retries.Load(), "requestErrors": w.stats.errors,
		"persistedDelta": after.Samples - before.Samples, "workloadErrors": len(failures),
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		return err
	}
	if len(failures) > 0 {
		return failures[0]
	}
	if after.Samples-before.Samples != w.sent.Load() || w.rejected.Load() != 0 {
		return fmt.Errorf("report counts did not match persisted samples")
	}
	return nil
}
