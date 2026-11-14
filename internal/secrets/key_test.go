package secrets_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/yaho7/QuantBot/internal/secrets"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

func TestKeyIsPersistentAndMustMatchDatabase(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	stores, err := storage.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer stores.Close()
	settings := controldb.New(stores.Control.Write)
	first, err := secrets.Open(ctx, dir, settings)
	if err != nil {
		t.Fatal(err)
	}
	second, err := secrets.Open(ctx, dir, settings)
	if err != nil || first != second {
		t.Fatalf("failed to reload key: %v", err)
	}
	path := filepath.Join(dir, "secrets", "encryption.key")
	if err := os.WriteFile(path, make([]byte, 32), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := secrets.Open(ctx, dir, settings); err == nil {
		t.Fatal("accepted key that did not match database")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := secrets.Open(ctx, dir, settings); err == nil {
		t.Fatal("recreated missing key for an initialized database")
	}
}
