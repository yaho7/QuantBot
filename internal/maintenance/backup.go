package maintenance

import (
	"archive/zip"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/yaho7/QuantBot/internal/command"
	"github.com/yaho7/QuantBot/internal/secrets"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

const archiveFormat = "QuantBot backup 1\n"

func Backup(ctx context.Context, dir, archive string) error {
	lock, err := storage.LockExisting(dir)
	if err != nil {
		return err
	}
	defer lock.Close()
	control, err := storage.OpenExisting(ctx, filepath.Join(dir, "control.db"))
	if err != nil {
		return err
	}
	defer control.Close()
	if err := secrets.Verify(ctx, dir, controldb.New(control)); err != nil {
		return err
	}
	metrics, err := storage.OpenExisting(ctx, filepath.Join(dir, "metrics.db"))
	if err != nil {
		return err
	}
	defer metrics.Close()

	// Take self-contained SQLite copies so WAL files never enter the archive.
	scratch, err := os.MkdirTemp("", "quantbot-backup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(scratch)
	for name, db := range map[string]*sql.DB{"control.db": control, "metrics.db": metrics} {
		copy := filepath.Join(scratch, name)
		if _, err := db.ExecContext(ctx, "VACUUM INTO ?", copy); err != nil {
			return fmt.Errorf("copy %s: %w", name, err)
		}
	}

	output, err := os.CreateTemp(filepath.Dir(archive), ".quantbot-backup-*")
	if err != nil {
		return err
	}
	defer os.Remove(output.Name())
	defer output.Close()
	bundle := zip.NewWriter(output)
	format, err := bundle.Create("format")
	if err != nil {
		return err
	}
	if _, err := io.WriteString(format, archiveFormat); err != nil {
		return err
	}
	for _, name := range []string{"control.db", "metrics.db", "secrets/encryption.key"} {
		base := scratch
		if name == "secrets/encryption.key" {
			base = dir
		}
		if err := addBackupFile(ctx, bundle, base, name); err != nil {
			return err
		}
	}
	if err := filepath.WalkDir(filepath.Join(dir, "themes"), func(filename string, entry fs.DirEntry, err error) error {
		if errors.Is(err, os.ErrNotExist) && filename == filepath.Join(dir, "themes") {
			return nil
		}
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if strings.HasPrefix(entry.Name(), ".upload-") {
				return filepath.SkipDir
			}
			return nil
		}
		name, err := filepath.Rel(dir, filename)
		if err != nil {
			return err
		}
		return addBackupFile(ctx, bundle, dir, filepath.ToSlash(name))
	}); err != nil {
		return err
	}
	if err := errors.Join(bundle.Close(), output.Sync(), output.Close()); err != nil {
		return err
	}
	if err := os.Link(output.Name(), archive); err != nil {
		return fmt.Errorf("publish backup (destination must not exist): %w", err)
	}
	return syncDir(filepath.Dir(archive))
}

func addBackupFile(ctx context.Context, bundle *zip.Writer, base, name string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	filename := filepath.Join(base, filepath.FromSlash(name))
	info, err := os.Lstat(filename)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", name)
	}
	source, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer source.Close()
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.SetMode(0600)
	entry, err := bundle.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(entry, contextReader{ctx, source})
	return err
}

func Restore(ctx context.Context, archive, destination string) error {
	bundle, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer bundle.Close()
	stage, err := os.MkdirTemp(filepath.Dir(destination), ".quantbot-restore-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	seen := map[string]bool{}
	for _, entry := range bundle.File {
		name := entry.Name
		if seen[name] || !entry.Mode().IsRegular() || !validArchivePath(name) {
			return fmt.Errorf("invalid or duplicate backup entry %q", name)
		}
		seen[name] = true
		if err := restoreFile(ctx, entry, stage); err != nil {
			return err
		}
	}
	for _, name := range []string{"format", "control.db", "metrics.db", "secrets/encryption.key"} {
		if !seen[name] {
			return fmt.Errorf("backup is missing %s", name)
		}
	}
	if err := checkDatabases(ctx, stage); err != nil {
		return err
	}
	store, err := storage.Open(ctx, stage)
	if err != nil {
		return err
	}
	err = command.QuarantineRestore(ctx, store.Control)
	if err := errors.Join(err, store.Close()); err != nil {
		return err
	}
	if err := syncDirectories(stage); err != nil {
		return err
	}

	if err := publishRestore(stage, destination); err != nil {
		return fmt.Errorf("restore destination must be a new directory: %w", err)
	}
	return syncDir(filepath.Dir(destination))
}

func validArchivePath(name string) bool {
	switch name {
	case "format", "control.db", "metrics.db", "secrets/encryption.key":
		return true
	default:
		return strings.HasPrefix(name, "themes/") && path.Clean(name) == name &&
			!strings.ContainsAny(name, "\\\x00") && len(strings.Split(name, "/")) >= 4
	}
}

func restoreFile(ctx context.Context, entry *zip.File, destination string) error {
	input, err := entry.Open()
	if err != nil {
		return err
	}
	defer input.Close()
	if entry.Name == "format" {
		format, err := io.ReadAll(io.LimitReader(input, int64(len(archiveFormat)+1)))
		if err != nil || string(format) != archiveFormat {
			return errors.Join(errors.New("unsupported QuantBot backup format"), err)
		}
		return nil
	}
	filename := filepath.Join(destination, filepath.FromSlash(entry.Name))
	if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
		return err
	}
	output, err := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(output, contextReader{ctx, input})
	return errors.Join(err, output.Sync(), output.Close())
}

func syncDirectories(root string) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return syncDir(path)
		}
		return nil
	})
}

func syncDir(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(file.Sync(), file.Close())
}

type contextReader struct {
	ctx context.Context
	io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}
