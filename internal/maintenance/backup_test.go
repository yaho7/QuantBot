package maintenance

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/secrets"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

func TestBackupRestore(t *testing.T) {
	ctx := t.Context()
	root := t.TempDir()
	source := filepath.Join(root, "source")
	archive := filepath.Join(root, "backup.zip")
	destination := filepath.Join(root, "restored")
	s, err := storage.Open(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if _, err := secrets.Open(ctx, source, controldb.New(s.Control.Write)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Control.Write.ExecContext(ctx, `
		INSERT INTO strategies (id,name,group_name,mode,created_at,executor_instance) VALUES ('strategy','Test','','paper',1,'instance');
		INSERT INTO agent_tokens(id,strategy_id,digest,label,scopes,created_at) VALUES ('agent-token','strategy','digest','Test',15,1);
		INSERT INTO commands (id,strategy_id,control_id,revision,input,actor,request_key,instance_id,boot_id,status,created_at,updated_at,deadline,timeout_ms)
		VALUES ('inflight','strategy','entry',1,'false','admin','a','instance','boot','executing',1,1,2,1),
		       ('waiting','strategy','pause',1,'false','admin','b','instance','boot','pending',1,1,2,1);
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Metrics.Write.ExecContext(ctx, "CREATE TABLE backup_marker(value TEXT); INSERT INTO backup_marker VALUES ('persisted')"); err != nil {
		t.Fatal(err)
	}
	theme := "themes/example/revision/entry.json"
	if err := os.MkdirAll(filepath.Dir(filepath.Join(source, theme)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, theme), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := Backup(ctx, source, archive); err == nil || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("backup must require a stopped service, got %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := Backup(ctx, source, archive); err != nil {
		t.Fatal(err)
	}
	if err := Backup(ctx, source, archive); err == nil {
		t.Fatal("backup unexpectedly overwrote an archive")
	}
	if err := Restore(ctx, archive, source); err == nil {
		t.Fatal("restore unexpectedly overwrote the original data")
	}
	if err := Restore(ctx, archive, destination); err != nil {
		t.Fatal(err)
	}
	verifyRestored(t, ctx, destination, theme)
	var report bytes.Buffer
	if err := Doctor(ctx, config.Config{DataDir: destination, Listen: "127.0.0.1:0"}, "3.0.0", &report); err != nil {
		t.Fatalf("%v\n%s", err, report.String())
	}
	if !strings.Contains(report.String(), "Background services: dynamic port configured") {
		t.Fatal(report.String())
	}
}

func verifyRestored(t *testing.T, ctx context.Context, destination, theme string) {
	t.Helper()
	s, err := storage.Open(ctx, destination)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	q := controldb.New(s.Control.Read)
	for id, want := range map[string]string{"inflight": "unknown", "waiting": "expired"} {
		cmd, err := q.GetCommand(ctx, id)
		if err != nil || cmd.Status != want {
			t.Fatalf("restored command %s: want %s, got %s, %v", id, want, cmd.Status, err)
		}
	}
	var revoked int64
	if err := s.Control.Read.QueryRowContext(ctx, "SELECT revoked_at FROM agent_tokens WHERE id='agent-token'").Scan(&revoked); err != nil || revoked < 1 {
		t.Fatalf("restored Agent credentials must be reissued: %d, %v", revoked, err)
	}
	var val string
	if err := s.Metrics.Read.QueryRowContext(ctx, "SELECT value FROM backup_marker").Scan(&val); err != nil || val != "persisted" {
		t.Fatalf("restored metric %q, %v", val, err)
	}
	if data, err := os.ReadFile(filepath.Join(destination, theme)); err != nil || string(data) != "{}" {
		t.Fatalf("restored theme %q, %v", data, err)
	}
}
