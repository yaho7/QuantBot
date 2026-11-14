package theme

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

func (s *Service) Assets(w http.ResponseWriter, r *http.Request) {
	id, revision, name := chi.URLParam(r, "id"), chi.URLParam(r, "revision"), chi.URLParam(r, "*")
	if !identifier.MatchString(id) || !revisionPattern.MatchString(revision) || !cleanPath(name) {
		http.NotFound(w, r)
		return
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	row, err := controldb.New(s.store.Read).GetThemeRevision(r.Context(), controldb.GetThemeRevisionParams{
		ThemeID: id, Revision: revision,
	})
	if err != nil {
		http.NotFound(w, r)
		return
	}
	var bundle Bundle
	if json.Unmarshal([]byte(row.Bundle), &bundle) != nil || bundle.Manifest.validate(s.version) != nil || bundle.Manifest.ID != id {
		http.NotFound(w, r)
		return
	}
	contentType, ok := bundle.Files[name]
	if !ok || bundle.Manifest.Type == "declarative" && !imageAsset(contentType) && contentType != "font/woff2" {
		http.NotFound(w, r)
		return
	}
	root, err := os.OpenRoot(filepath.Join(s.dir, id, revision))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	file, err := root.Open(filepath.FromSlash(name))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "public, max-age=3600, immutable")
	if strings.HasPrefix(contentType, "text/html") {
		// CSP sandbox also applies when someone navigates directly to an
		// installed HTML file outside the workbench iframe.
		prefix := assetSource(r, id, revision)
		w.Header().Set("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; "+
			"script-src "+prefix+"; style-src 'unsafe-inline' "+prefix+"; img-src data: "+prefix+"; "+
			"font-src "+prefix+"; connect-src 'none'; object-src 'none'; frame-src 'none'; "+
			"form-action 'none'; base-uri 'none'; frame-ancestors 'self'")
		w.Header().Set("Cache-Control", "no-store")
	} else {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
	}
	http.ServeContent(w, r, name, info.ModTime(), file)
}

func assetSource(r *http.Request, id, revision string) string {
	return httpapi.RequestPeer(r).Origin + "/theme-assets/" + id + "/" + revision + "/"
}
