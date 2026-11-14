package telemetry

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yaho7/QuantBot/internal/realtime"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/metricsdb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

var (
	errQueueFull = errors.New("metric write queue is full")
	errClosing   = errors.New("telemetry writer is shutting down")
)

type QueueConfig struct {
	Capacity int
	Batch    int
	Flush    time.Duration
}

type metricQueue struct {
	mu       sync.RWMutex
	jobs     chan metricJob
	done     chan struct{}
	closed   bool
	batch    int
	flush    time.Duration
	write    *sql.DB
	failures atomic.Uint64
	notify   realtime.Notify
}

type metricJob struct {
	agent    strategy.Agent
	records  []indexedRecord
	declared []declaredWrite
	done     chan metricResult
}

type metricResult struct {
	Ack
	err error
}

func newQueue(write *sql.DB, cfg QueueConfig, notify realtime.Notify) *metricQueue {
	q := &metricQueue{
		jobs: make(chan metricJob, cfg.Capacity), done: make(chan struct{}),
		batch: cfg.Batch, flush: cfg.Flush, write: write, notify: notify,
	}
	go q.run()
	return q
}

func (q *metricQueue) submit(ctx context.Context, job metricJob) (Ack, error) {
	job.done = make(chan metricResult, 1)
	q.mu.RLock()
	if q.closed {
		q.mu.RUnlock()
		return Ack{}, errClosing
	}
	select {
	case <-ctx.Done():
		q.mu.RUnlock()
		return Ack{}, ctx.Err()
	case q.jobs <- job:
		q.mu.RUnlock()
	default:
		q.mu.RUnlock()
		return Ack{}, errQueueFull
	}
	select {
	case result := <-job.done:
		return result.Ack, result.err
	case <-ctx.Done():
		return Ack{}, ctx.Err()
	}
}

func (q *metricQueue) close() {
	q.mu.Lock()
	if !q.closed {
		q.closed = true
		close(q.jobs)
	}
	q.mu.Unlock()
	<-q.done
}

func (q *metricQueue) run() {
	defer close(q.done)
	jobs := make([]metricJob, 0, q.batch)
	for first := range q.jobs {
		jobs = append(jobs[:0], first)
		timer := time.NewTimer(q.flush)
	collect:
		for len(jobs) < q.batch {
			select {
			case next, ok := <-q.jobs:
				if !ok {
					break collect
				}
				jobs = append(jobs, next)
			case <-timer.C:
				break collect
			}
		}
		timer.Stop()
		q.persist(jobs)
		clear(jobs)
	}
}

func (q *metricQueue) persist(jobs []metricJob) {
	// Admitted jobs reach a durable result even if the requesting client disconnects.
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	results := make([]Ack, len(jobs))
	err := storage.WithTx(ctx, q.write, func(tx *sql.Tx) error {
		queries := metricsdb.New(tx)
		rollups := make(rollupBatch)
		for i, job := range jobs {

			for _, item := range job.declared {
				result, err := writeDeclared(ctx, queries, job.agent, item)
				if err != nil {
					return err
				}
				results[i].add(item.index, result)
			}
			for _, item := range job.records {
				result, err := writeMetric(ctx, queries, job.agent, item.Record)
				if err != nil {
					return err
				}
				if result == inserted && aggregatable(item.Kind) {
					if err := rollups.add(ctx, queries, job.agent, item.Record); err != nil {
						return err
					}
				}
				results[i].add(item.index, result)
			}
		}
		return rollups.persist(ctx, queries)
	})
	if err != nil {
		q.failures.Add(uint64(len(jobs)))
		clear(results)
	}
	for i, job := range jobs {
		if err == nil && results[i].Inserted > 0 {
			q.notify.Emit(job.agent.StrategyID, realtime.Telemetry)
		}
		job.done <- metricResult{Ack: results[i], err: err}
	}
}
