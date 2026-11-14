package maintenance

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/secrets"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/theme"
)

func checkDatabase(ctx context.Context, db *sql.DB) error {
	var result string
	if err := db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&result); err != nil {
		return err
	}
	if result != "ok" {
		return fmt.Errorf("SQLite quick_check: %s", result)
	}
	return nil
}

func checkDatabases(ctx context.Context, dir string) error {
	for _, name := range []string{"control.db", "metrics.db"} {
		db, err := storage.OpenExisting(ctx, filepath.Join(dir, name))
		if err != nil {
			return err
		}
		err = checkDatabase(ctx, db)
		if err == nil && name == "control.db" {
			err = secrets.Verify(ctx, dir, controldb.New(db))
		}
		if err := errors.Join(err, db.Close()); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	return nil
}

func Doctor(ctx context.Context, cfg config.Config, version string, output io.Writer) error {
	var problems []error
	report := func(label, detail string, err error) {
		if err != nil {
			fmt.Fprintf(output, "%s: %v\n", label, err)
			problems = append(problems, fmt.Errorf("%s: %w", label, err))
			return
		}
		fmt.Fprintf(output, "%s: %s\n", label, detail)
	}
	fmt.Fprintf(output, "QuantBot %s\n", version)
	report("Configuration", "valid", nil)
	info, err := os.Lstat(cfg.DataDir)
	if err == nil && (!info.IsDir() || info.Mode().Perm()&0022 != 0) {
		err = errors.New("data directory must be writable only by its owner")
	}
	if err == nil {
		err = syscall.Access(cfg.DataDir, 3) // write and search
	}
	report("Data directory", cfg.DataDir, err)
	for _, name := range []string{"control.db", "metrics.db"} {
		db, err := storage.OpenExisting(ctx, filepath.Join(cfg.DataDir, name))
		if err != nil {
			report(name, "", err)
			continue
		}
		var mode string
		err = checkDatabase(ctx, db)
		if err == nil {
			err = db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode)
		}
		if err == nil && mode != "wal" {
			err = fmt.Errorf("expected WAL, found %s", mode)
		}
		report(name, "integrity ok, WAL", err)
		if name == "control.db" {
			report("Encryption key", "verified", secrets.Verify(ctx, cfg.DataDir, controldb.New(db)))
			active, err := theme.CheckActive(ctx, db, cfg.DataDir, version)
			report("Theme", active, err)
		}
		db.Close()
	}
	fmt.Fprintf(output, "Listen address: %s\n", cfg.Listen)
	_, port, _ := net.SplitHostPort(cfg.Listen)
	if port == "0" {
		fmt.Fprintln(output, "Background services: dynamic port configured")
		return errors.Join(problems...)
	}
	err = ProbeHealth(ctx, cfg)
	if errors.Is(err, syscall.ECONNREFUSED) {
		fmt.Fprintln(output, "Background services: stopped")
	} else {
		report("Background services", "running", err)
	}
	return errors.Join(problems...)
}

// ProbeHealth checks the local listener without opening the data directory.
func ProbeHealth(ctx context.Context, cfg config.Config) error {
	host, port, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		return err
	}
	address, _ := netip.ParseAddr(host)
	switch {
	case host == "" || address.Is4() && address.IsUnspecified():
		host = "127.0.0.1"
	case address.Is6() && address.IsUnspecified():
		host = "::1"
	}
	transport := &http.Transport{}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort(host, port)+"/healthz", nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("X-QuantBot-Health") != "ready" {
		return fmt.Errorf("health check returned HTTP %d without QuantBot readiness", response.StatusCode)
	}
	return nil
}
