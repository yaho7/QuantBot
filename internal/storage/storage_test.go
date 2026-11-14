package storage_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/storage/metricsdb"
)

func TestSeparateWALDatabasesAndReopen(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	stores, err := storage.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if stores != nil {
			_ = stores.Close()
		}
	}()
	if other, err := storage.Open(ctx, dir); err == nil {
		_ = other.Close()
		t.Fatal("two services opened the same directory")
	}
	for _, db := range []storage.Database{stores.Control, stores.Metrics} {
		var mode string
		if err := db.Read.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
			t.Fatalf("journal mode %q: %v", mode, err)
		}
		var durability int
		if err := db.Write.QueryRowContext(ctx, "PRAGMA synchronous").Scan(&durability); err != nil || durability != 2 {
			t.Fatalf("synchronous %d: %v", durability, err)
		}
	}
	if err := controldb.New(stores.Control.Write).SetSetting(ctx, controldb.SetSettingParams{Key: "fixture", Value: "true"}); err != nil {
		t.Fatal(err)
	}
	if err := metricsdb.New(stores.Metrics.Write).SetMetricDefinition(ctx, metricsdb.SetMetricDefinitionParams{
		StrategyID: "paper", Name: "equity", Definition: "{}",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := stores.Control.Read.ExecContext(ctx, "DELETE FROM settings"); err == nil {
		t.Fatal("read pool allowed writes")
	}
	if _, err := stores.Metrics.Write.ExecContext(ctx, "DELETE FROM settings"); err == nil {
		t.Fatal("metrics database contained the control schema")
	}
	if err := stores.Close(); err != nil {
		t.Fatal(err)
	}
	stores, err = storage.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if setting, err := controldb.New(stores.Control.Read).GetSetting(ctx, "fixture"); err != nil || setting != "true" {
		t.Fatalf("setting after reopen: %q, %v", setting, err)
	}
}

func TestRejectsNewerSchema(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	stores, err := storage.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	_, err = stores.Control.Write.ExecContext(ctx, "PRAGMA user_version = 1000")
	closeErr := stores.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("prepare newer schema: %v, %v", err, closeErr)
	}
	if reopened, err := storage.Open(ctx, dir); err == nil {
		_ = reopened.Close()
		t.Fatal("opened unsupported schema")
	}
	raw, err := sql.Open("sqlite3", filepath.Join(dir, "control.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	var version int
	if err := raw.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil || version != 1000 {
		t.Fatalf("unsupported version was changed: %d, %v", version, err)
	}
}
