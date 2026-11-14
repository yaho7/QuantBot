package telemetry

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/storage/metricsdb"
)

func (s *Service) Maintain(ctx context.Context, dir string) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			run, cancel := context.WithTimeout(ctx, 20*time.Second)
			err := s.prune(run, now)
			cancel()
			if err != nil && ctx.Err() == nil {
				slog.Error("telemetry retention", "error", err)
			}
			for _, name := range []string{"metrics.db-wal", "control.db-wal"} {
				if info, err := os.Stat(filepath.Join(dir, name)); err == nil && info.Size() >= 64<<20 {
					slog.Warn("SQLite WAL above 64 MiB", "file", name, "bytes", info.Size())
				}
			}
		}
	}
}

func (s *Service) prune(ctx context.Context, now time.Time) error {
	if err := pruneBatches(func() (int64, error) {
		return controldb.New(s.stores.Control.Write).PruneCapabilityStates(ctx, now.Add(-30*24*time.Hour).UnixMilli())
	}); err != nil {
		return err
	}
	q := metricsdb.New(s.stores.Metrics.Write)
	if err := pruneBatches(func() (int64, error) { return q.PruneSamples(ctx, now.Add(-rawRetention).UnixMilli()) }); err != nil {
		return err
	}
	if err := pruneBatches(func() (int64, error) { return q.PruneLogs(ctx, now.Add(-backfillWindow).UnixMilli()) }); err != nil {
		return err
	}
	if err := pruneBatches(func() (int64, error) { return q.PruneCapabilitySamples(ctx, now.Add(-30*24*time.Hour).UnixMilli()) }); err != nil {
		return err
	}
	if err := pruneBatches(func() (int64, error) { return q.PruneCapabilityReceipts(ctx, now.Add(-30*24*time.Hour).UnixMilli()) }); err != nil {
		return err
	}
	for _, item := range tiers {
		cutoff := bucketAt(now.Add(-item.retain).UnixMilli(), item.resolution)
		if err := pruneBatches(func() (int64, error) {
			return q.PruneRollups(ctx, metricsdb.PruneRollupsParams{Resolution: item.resolution, Cutoff: cutoff})
		}); err != nil {
			return err
		}
	}
	return nil
}

func pruneBatches(remove func() (int64, error)) error {
	for range 8 {
		count, err := remove()
		if err != nil || count < 2000 {
			return err
		}
	}
	return nil
}
