package theme

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

func TestClassicalOnlyAndIsolatedLegacyAssets(t *testing.T) {
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
	r.Use(httpapi.Proxies(nil).IdentifyPeer)
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
	if got := read(call("GET", "/theme", "", "", 200)); got.ID != BuiltinClassical || !got.Builtin || !got.Available {
		t.Fatalf("wrong initial theme: %+v", got)
	}

	// Seed an installed package through the internal installer, as an upgraded
	// database could contain one. Its assets must remain isolated and the
	// package cannot be enabled through the public API.
	manifest := exampleManifest(t, "frontend", "index.html")
	first, err := s.install(t.Context(), "fixture", makeZIP(t,
		manifest,
		zipEntry{name: "index.html", body: `<!doctype html><script src="widget.js"></script>`},
		zipEntry{name: "widget.js", body: "document.body.dataset.ready = 'yes';"},
	))
	if err != nil {
		t.Fatal(err)
	}
	if err := setActive(t.Context(), controldb.New(stores.Control.Write), first.ID); err != nil {
		t.Fatal(err)
	}
	if got := read(call("GET", "/theme", "", "", 200)); got.ID != BuiltinClassical || got.EntryURL != "" {
		t.Fatalf("legacy package was activated: %+v", got)
	}
	var catalogue struct {
		Active string     `json:"active"`
		Themes []instance `json:"themes"`
	}
	if err := json.Unmarshal(call("GET", "/admin/themes", "", "", 200).Body.Bytes(), &catalogue); err != nil {
		t.Fatal(err)
	}
	if catalogue.Active != BuiltinClassical || len(catalogue.Themes) != 1 || catalogue.Themes[0].ID != BuiltinClassical {
		t.Fatalf("unexpected theme catalogue: %+v", catalogue)
	}
	call("POST", "/admin/themes", "not an archive", "application/zip", 405)
	call("PUT", "/admin/themes/active", `{"id":"graphite"}`, kind, 400)
	call("PUT", "/admin/themes/active", `{"id":"classical"}`, kind, 200)

	entry := call("GET", first.EntryURL, "", "", 200)
	policy := entry.Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "sandbox allow-scripts") || !strings.Contains(policy, "connect-src 'none'") ||
		!strings.Contains(policy, "script-src http://localhost:23456"+first.AssetBase) || strings.Contains(policy, "allow-same-origin") {
		t.Fatalf("invalid isolation policy: %q", policy)
	}
	call("GET", first.AssetBase+"widget.js", "", "", 200)
	call("GET", first.AssetBase+"%2e%2e/control.db", "", "", 404)
}
