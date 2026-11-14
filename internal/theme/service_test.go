package theme

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage"
)

func TestThemeLifecycleAndIsolatedAssets(t *testing.T) {
	dir := t.TempDir()
	stores, err := storage.Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer stores.Close()
	s, err := New(stores.Control, dir, "3.0.0")
	if err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	r.Use((httpapi.Origins{}).Guard)
	s.Register(r)
	r.Get("/theme-assets/{id}/{revision}/*", s.Assets)
	call := func(method, path, body, media string, expected int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, "http://localhost:23456"+path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Content-Type", media)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != expected {
			t.Fatalf("%s %s: got %d, want %d (%s)", method, path, w.Code, expected, w.Body)
		}
		return w
	}
	read := func(w *httptest.ResponseRecorder) instance {
		t.Helper()
		var result instance
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	const kind = "application/json"
	if got := read(call("GET", "/theme", "", "", 200)); got.ID != "lumina" {
		t.Fatalf("wrong initial theme: %+v", got)
	}
	manifest := exampleManifest(t, "frontend", "index.html")
	var meta Manifest
	if err := json.Unmarshal([]byte(manifest.body), &meta); err != nil {
		t.Fatal(err)
	}
	meta.Settings = "settings.json"
	makeBundle := func(version string) string {
		t.Helper()
		meta.Version = version
		body, err := json.Marshal(meta)
		if err != nil {
			t.Fatal(err)
		}
		return string(makeZIP(t,
			zipEntry{name: manifestName, body: string(body)},
			zipEntry{name: "settings.json", body: `{"fields":[{"key":"dense","label":"Dense","type":"switch","default":true}]}`},
			zipEntry{name: "index.html", body: `<!DOCTYPE html><html><body><script src="widget.js"></script></body></html>`},
			zipEntry{name: "widget.js", body: "document.body.dataset.ready = 'yes';"},
		))
	}
	first := read(call("POST", "/admin/themes", makeBundle("1.0.0"), "application/zip", 201))
	call("PUT", "/admin/themes/active", `{"id":"graphite"}`, kind, 200)
	call("PUT", "/admin/themes/graphite/settings", `{"dense":false}`, kind, 200)
	call("PUT", "/admin/themes/graphite/settings", `{"dense":"no"}`, kind, 400)
	entry := call("GET", first.EntryURL, "", "", 200)
	policy := entry.Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "sandbox allow-scripts") || !strings.Contains(policy, "connect-src 'none'") ||
		!strings.Contains(policy, "script-src http://localhost:23456"+first.AssetBase) || strings.Contains(policy, "allow-same-origin") {
		t.Fatalf("invalid isolation policy: %q", policy)
	}
	call("GET", first.AssetBase+"widget.js", "", "", 200)
	call("GET", first.AssetBase+"%2e%2e/control.db", "", "", 404)
	call("POST", "/admin/themes", "invalid ZIP", "application/zip", 400)
	if latest := read(call("GET", "/theme", "", "", 200)); latest.Revision != first.Revision || string(latest.Settings["dense"]) != "false" {
		t.Fatalf("failed update changed active package: %+v", latest)
	}
	next := read(call("POST", "/admin/themes", makeBundle("1.1.0"), "application/zip", 201))
	if next.Previous != first.Revision || next.Revision == first.Revision {
		t.Fatal("update did not preserve the old revision")
	}
	previous := read(call("POST", "/admin/themes/graphite/rollback", "", "", 200))
	if previous.Revision != first.Revision || string(previous.Settings["dense"]) != "false" {
		t.Fatal("rollback did not restore the previous bundle and settings")
	}
	if err := os.Remove(filepath.Join(dir, "themes", first.ID, first.Revision, "index.html")); err != nil {
		t.Fatal(err)
	}
	if restored := read(call("GET", "/theme", "", "", 200)); restored.ID != "classic" {
		t.Fatal("missing installed entry did not fall back to Classic")
	}
	call("DELETE", "/admin/themes/graphite", "", "", 204)
	call("GET", next.EntryURL, "", "", 404)
	if restored := read(call("GET", "/theme", "", "", 200)); restored.ID != "classic" {
		t.Fatal("deleting active theme did not preserve Classic")
	}
	call("DELETE", "/admin/themes/classic", "", "", 400)
}
