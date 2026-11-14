package secrets

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

const fingerprintSetting = "encryption_key_fingerprint"

func Open(ctx context.Context, dir string, settings *controldb.Queries) ([32]byte, error) {
	var key [32]byte
	fingerprint, err := settings.GetSetting(ctx, fingerprintSetting)
	uninitialized := errors.Is(err, sql.ErrNoRows)
	if err != nil && !uninitialized {
		return key, err
	}

	dir = filepath.Join(dir, "secrets")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return key, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return key, err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return key, errors.New("secrets directory must be private")
	}

	path := filepath.Join(dir, "encryption.key")
	if err := readKey(path, &key); err != nil {
		if !uninitialized || !errors.Is(err, os.ErrNotExist) {
			return [32]byte{}, fmt.Errorf("read encryption key: %w", err)
		}
		rand.Read(key[:])
		if err := createKey(dir, path, key); err != nil {
			return [32]byte{}, fmt.Errorf("create encryption key: %w", err)
		}
	}
	sum := sha256.Sum256(key[:])
	encoded, _ := json.Marshal(hex.EncodeToString(sum[:]))
	if uninitialized {
		if err := settings.SetSetting(ctx, controldb.SetSettingParams{Key: fingerprintSetting, Value: string(encoded)}); err != nil {
			return [32]byte{}, err
		}
	} else if fingerprint != string(encoded) {
		return [32]byte{}, errors.New("encryption key does not match the control database")
	}
	return key, nil
}

func readKey(path string, key *[32]byte) error {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() != int64(len(key)) {
		return errors.New("expected a private 32-byte regular file")
	}
	_, err = io.ReadFull(file, key[:])
	return err
}

func createKey(dir, path string, key [32]byte) error {
	file, err := os.CreateTemp(dir, ".key-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(key[:])
	if err := errors.Join(writeErr, file.Sync(), file.Close()); err != nil {
		return err
	}
	if err := os.Link(file.Name(), path); err != nil {
		return err
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
