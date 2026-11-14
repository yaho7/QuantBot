package theme

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type zipEntry struct {
	name string
	body string
	mode fs.FileMode
}

func makeZIP(t *testing.T, entries ...zipEntry) []byte {
	t.Helper()
	var data bytes.Buffer
	archive := zip.NewWriter(&data)
	for _, file := range entries {
		header := &zip.FileHeader{Name: file.name, Method: zip.Deflate}
		if file.mode != 0 {
			header.SetMode(file.mode)
		}
		w, err := archive.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(file.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func exampleManifest(t *testing.T, kind, entry string) zipEntry {
	t.Helper()
	body, err := json.Marshal(Manifest{
		ID: "graphite", Name: "Graphite", Version: "1.0.0", Engine: Engine, Type: kind,
		Entry: entry, MinVersion: "3.0.0", MaxVersion: "4.0.0", Author: "Test author",
	})
	if err != nil {
		t.Fatal(err)
	}
	return zipEntry{name: manifestName, body: string(body)}
}

func TestExtractThemeAndValidateMetadata(t *testing.T) {
	dir := t.TempDir()
	manifest := exampleManifest(t, "declarative", "theme.json")
	var data Manifest
	if err := json.Unmarshal([]byte(manifest.body), &data); err != nil {
		t.Fatal(err)
	}
	data.Settings = "settings.schema.json"
	meta, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	manifest.body = string(meta)
	body := makeZIP(t, manifest,
		zipEntry{name: "theme.json", body: `{"dark":{"background":"#121519"},"sections":["strategies","overview"],"radius":12,"cardView":"mini"}`},
		zipEntry{name: "settings.schema.json", body: `{"fields":[{"key":"dense","label":"Dense","type":"switch","default":true}]}`},
	)
	bundle, err := Extract(body, dir, "3.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if bundle.Manifest.ID != "graphite" || bundle.Presentation.CardView != "mini" || len(bundle.Settings) != 1 {
		t.Fatalf("unexpected bundle: %+v", bundle)
	}
	if value, err := os.ReadFile(filepath.Join(dir, "theme.json")); err != nil || !bytes.Contains(value, []byte("#121519")) {
		t.Fatalf("invalid on-disk theme entry: %v", err)
	}
	if _, err := Extract(body, t.TempDir(), "4.0.0"); err == nil {
		t.Fatal("accepted theme outside supported release range")
	}
	if _, err := Extract(makeZIP(t,
		exampleManifest(t, "frontend", "index.html"),
		zipEntry{name: "index.html", body: "<!doctype html><html><body>Theme</body></html>"},
		zipEntry{name: "assets/theme.js", body: "console.log('theme');"},
	), t.TempDir(), "3.0.0"); err != nil {
		t.Fatalf("valid frontend package rejected: %v", err)
	}
}

func TestRejectsUnsafeArchiveEntries(t *testing.T) {
	base := []zipEntry{exampleManifest(t, "declarative", "theme.json"), {name: "theme.json", body: "{}"}}
	cases := map[string][]zipEntry{
		"traversal":             {{name: "../outside.json", body: "{}"}},
		"absolute":              {{name: "/escape.png"}},
		"backslash":             {{name: "assets\\bad.json", body: "{}"}},
		"symlink":               {{name: "link.json", body: "../../control.db", mode: os.ModeSymlink | 0777}},
		"duplicate":             {{name: "theme.json", body: "{}"}},
		"case":                  {{name: "ASSETS/a.json", body: "{}"}, {name: "assets/b.json", body: "{}"}},
		"file-directory":        {{name: "folder.txt", body: "folder"}, {name: "folder.txt/nested.json", body: "{}"}},
		"windows alias":         {{name: "AUX.txt", body: "reserved"}},
		"script":                {{name: "assets/theme.js", body: "document.write('theme')"}},
		"svg":                   {{name: "preview.svg", body: "<svg></svg>"}},
		"html disguised as png": {{name: "preview.png", body: "<!doctype html><html></html>"}},
		"oversized entry":       {{name: "asset.txt", body: strings.Repeat("x", maxFileBytes+1)}},
		"bad extension":         {{name: "archive.zip", body: "ZIP"}},
	}
	for name, extra := range cases {
		t.Run(name, func(t *testing.T) {
			body := makeZIP(t, append(append([]zipEntry{}, base...), extra...)...)
			if _, err := Extract(body, t.TempDir(), "3.0.0"); err == nil {
				t.Fatal("accepted unsafe archive")
			}
		})
	}
}
