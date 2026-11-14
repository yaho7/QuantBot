package storage

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"

	_ "github.com/mattn/go-sqlite3"
)

//go:embed migrations/*/*.sql
var migrations embed.FS

type Database struct {
	Write *sql.DB
	Read  *sql.DB
}

type Stores struct {
	Control Database
	Metrics Database
	lock    *os.File
}

func Open(ctx context.Context, dir string) (*Stores, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	dirInfo, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !dirInfo.IsDir() || dirInfo.Mode().Perm()&0022 != 0 {
		return nil, errors.New("data directory must be a directory writable only by its owner")
	}
	lock, err := openPrivateFile(filepath.Join(dir, "quantbot.lock"))
	if err != nil {
		return nil, fmt.Errorf("open data directory lock: %w", err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("lock data directory: %w", err)
	}
	stores := &Stores{lock: lock}
	stores.Control, err = openDatabase(ctx, dir, "control", 4)
	if err == nil {
		stores.Metrics, err = openDatabase(ctx, dir, "metrics", 4)
	}
	if err != nil {
		return nil, errors.Join(err, stores.Close())
	}
	return stores, nil
}

func (stores *Stores) Close() error {
	var errs []error
	for _, pool := range []*sql.DB{stores.Metrics.Read, stores.Metrics.Write, stores.Control.Read, stores.Control.Write} {
		if pool != nil {
			errs = append(errs, pool.Close())
		}
	}
	return errors.Join(append(errs, stores.lock.Close())...)
}

func openPrivateFile(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0) {
		err = fmt.Errorf("%s must be a private regular file", filepath.Base(path))
	}
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}

func openDatabase(ctx context.Context, dir, name string, readers int) (db Database, err error) {
	path := filepath.Join(dir, name+".db")
	file, err := openPrivateFile(path)
	if err != nil {
		return Database{}, fmt.Errorf("open %s database file: %w", name, err)
	}
	if err := file.Close(); err != nil {
		return Database{}, err
	}

	params := url.Values{
		"mode": {"rw"}, "_busy_timeout": {"1500"}, "_foreign_keys": {"on"},
		"_journal_mode": {"WAL"}, "_synchronous": {"FULL"}, "_txlock": {"immediate"},
	}
	dsn := url.URL{Scheme: "file", Path: path, RawQuery: params.Encode()}
	writer, err := sql.Open("sqlite3", dsn.String())
	if err != nil {
		return Database{}, err
	}
	defer func() {
		if err != nil {
			_ = writer.Close()
			err = fmt.Errorf("initialize %s database: %w", name, err)
		}
	}()
	writer.SetMaxOpenConns(1)
	writer.SetMaxIdleConns(1)
	var mode string
	if err = writer.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
		return Database{}, err
	}
	if mode != "wal" {
		return Database{}, fmt.Errorf("expected WAL, got %s", mode)
	}
	if err = migrate(ctx, writer, name); err != nil {
		return Database{}, err
	}

	params.Set("mode", "ro")
	params.Del("_journal_mode")
	params.Del("_synchronous")
	params.Del("_txlock")
	dsn.RawQuery = params.Encode()
	reader, err := sql.Open("sqlite3", dsn.String())
	if err != nil {
		return Database{}, err
	}
	reader.SetMaxOpenConns(readers)
	reader.SetMaxIdleConns(readers)
	if err = reader.PingContext(ctx); err != nil {
		_ = reader.Close()
		return Database{}, err
	}
	return Database{Write: writer, Read: reader}, nil
}

func migrate(ctx context.Context, db *sql.DB, name string) error {
	var version int
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	dir := "migrations/" + name
	entries, err := migrations.ReadDir(dir)
	if err != nil {
		return err
	}
	if version < 0 || version > len(entries) {
		return fmt.Errorf("unsupported database version %d", version)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for index, entry := range entries {
		next := index + 1
		number, err := strconv.Atoi(strings.TrimSuffix(entry.Name(), ".sql"))
		if err != nil || number != next {
			return fmt.Errorf("migration sequence error at %s", entry.Name())
		}
		if next <= version {
			continue
		}
		body, err := migrations.ReadFile(dir + "/" + entry.Name())
		if err != nil {
			return err
		}
		if err := WithTx(ctx, db, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, string(body)); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", next))
			return err
		}); err != nil {
			return fmt.Errorf("migration %s: %w", entry.Name(), err)
		}
	}
	return nil
}

func WithTx(ctx context.Context, db *sql.DB, work func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := work(tx); err != nil {
		return err
	}
	return tx.Commit()
}
