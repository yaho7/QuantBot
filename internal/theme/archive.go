package theme

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/yaho7/QuantBot/internal/httpapi"
)

const MaxArchiveBytes = 12 << 20
const maxExtractedBytes = 32 << 20
const maxFileBytes = 8 << 20
const maxMetadataBytes = 128 << 10
const maxFiles = 256
const manifestName = "quantbot-theme.json"

var pathComponent = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$`)

type Bundle struct {
	Manifest     Manifest
	Presentation Presentation
	Settings     []Setting
	Files        map[string]string
}

func Extract(body []byte, dest, current string) (Bundle, error) {
	var bundle Bundle
	if len(body) == 0 || len(body) > MaxArchiveBytes {
		return bundle, errors.New("theme ZIP has an invalid compressed size")
	}
	archive, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil || len(archive.File) == 0 || len(archive.File) > maxFiles {
		return bundle, errors.New("invalid theme ZIP or file count")
	}
	seen := make(map[string]bool, len(archive.File))
	aliases := make(map[string]string)
	bundle.Files = make(map[string]string)
	var extracted uint64
	for _, file := range archive.File {
		name := strings.TrimSuffix(file.Name, "/")
		if !cleanPath(name) || len(name) > 240 || file.Mode()&os.ModeSymlink != 0 ||
			(!file.Mode().IsRegular() && !file.FileInfo().IsDir()) ||
			seen[strings.ToLower(name)] || file.FileInfo().IsDir() != strings.HasSuffix(file.Name, "/") {
			return Bundle{}, fmt.Errorf("theme ZIP contains an invalid or conflicting path %q", file.Name)
		}
		seen[strings.ToLower(name)] = true
		for prefix := name; prefix != "."; prefix = path.Dir(prefix) {
			key := strings.ToLower(prefix)
			if previous, exists := aliases[key]; exists && previous != prefix {
				return Bundle{}, errors.New("theme ZIP contains conflicting path casing")
			}
			aliases[key] = prefix
		}
		if file.FileInfo().IsDir() {
			if file.UncompressedSize64 != 0 {
				return Bundle{}, errors.New("theme ZIP directory contains data")
			}
			continue
		}
		if file.UncompressedSize64 > maxFileBytes || extracted+file.UncompressedSize64 > maxExtractedBytes {
			return Bundle{}, errors.New("theme ZIP exceeds extracted size limits")
		}
		extracted += file.UncompressedSize64
		value, err := readFile(file)
		if err != nil {
			return Bundle{}, err
		}
		contentType, err := mediaType(name, value)
		if err != nil {
			return Bundle{}, err
		}
		bundle.Files[name] = contentType
		target := filepath.Join(dest, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return Bundle{}, err
		}
		if err := os.WriteFile(target, value, 0600); err != nil {
			return Bundle{}, err
		}
	}
	for name := range bundle.Files {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if _, exists := bundle.Files[parent]; exists {
				return Bundle{}, errors.New("theme ZIP contains an overlapping file and directory")
			}
		}
	}
	if err := loadMetadata(dest, manifestName, bundle.Files, &bundle.Manifest); err != nil {
		return Bundle{}, err
	}
	m := bundle.Manifest
	if err := m.validate(current); err != nil {
		return Bundle{}, err
	}
	if m.Preview != "" && !imageAsset(bundle.Files[m.Preview]) {
		return Bundle{}, errors.New("preview must reference an image in the theme bundle")
	}
	if m.Type == "declarative" {
		if m.Entry == manifestName {
			return Bundle{}, errors.New("theme entry and manifest must be separate")
		}
		if err := loadMetadata(dest, m.Entry, bundle.Files, &bundle.Presentation); err != nil {
			return Bundle{}, err
		}
		if err := bundle.Presentation.validate(bundle.Files); err != nil {
			return Bundle{}, err
		}
		for _, media := range bundle.Files {
			if media == "text/html; charset=utf-8" || media == "text/javascript; charset=utf-8" || media == "text/css; charset=utf-8" {
				return Bundle{}, errors.New("declarative themes use structured tokens and cannot contain active files")
			}
		}
	} else if bundle.Files[m.Entry] != "text/html; charset=utf-8" {
		return Bundle{}, errors.New("frontend theme entry must be an HTML document")
	}
	if m.Settings != "" {
		var settings struct {
			Fields []Setting `json:"fields"`
		}
		if err := loadMetadata(dest, m.Settings, bundle.Files, &settings); err != nil {
			return Bundle{}, err
		}
		if err := validateSettingsSchema(settings.Fields, bundle.Files); err != nil {
			return Bundle{}, err
		}
		bundle.Settings = settings.Fields
	}
	return bundle, nil
}

func cleanPath(name string) bool {
	if !fs.ValidPath(name) || name == "." || strings.Contains(name, "\\") || name != path.Clean(name) {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		stem := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		reserved := stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
			(len(stem) == 4 && (strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) &&
				stem[3] >= '1' && stem[3] <= '9')
		if !pathComponent.MatchString(part) || strings.HasSuffix(part, ".") || reserved {
			return false
		}
	}
	return true
}

func readFile(file *zip.File) ([]byte, error) {
	stream, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	value, err := io.ReadAll(io.LimitReader(stream, int64(file.UncompressedSize64)+1))
	if err != nil {
		return nil, err
	}
	if uint64(len(value)) != file.UncompressedSize64 {
		return nil, errors.New("theme ZIP file exceeds declared size")
	}
	return value, nil
}

func loadMetadata(dir, name string, files map[string]string, out any) error {
	if files[name] != "application/json" {
		return fmt.Errorf("missing JSON metadata %q", name)
	}
	value, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
	if err != nil {
		return err
	}
	if err := httpapi.Decode(value, out); err != nil {
		return fmt.Errorf("invalid %s: %w", name, err)
	}
	return nil
}

func imageAsset(media string) bool { return strings.HasPrefix(media, "image/") }

func mediaType(name string, value []byte) (string, error) {
	invalid := fmt.Errorf("unsupported or invalid theme file type %q", name)
	switch strings.ToLower(path.Ext(name)) {
	case ".png", ".jpeg", ".jpg", ".gif", ".webp":
		detected := http.DetectContentType(value)
		expected := map[string]string{".png": "image/png", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
		if expected[strings.ToLower(path.Ext(name))] != detected {
			return "", invalid
		}
		if detected != "image/webp" {
			config, _, err := image.DecodeConfig(bytes.NewReader(value))
			if err != nil || config.Width > 8192 || config.Height > 8192 {
				return "", invalid
			}
		}
		return detected, nil
	case ".json":
		var doc any
		if len(value) > maxMetadataBytes || httpapi.Decode(value, &doc) != nil {
			return "", invalid
		}
		return "application/json", nil
	case ".css", ".js", ".mjs", ".html", ".txt", ".md", "":
		if !utf8.Valid(value) || bytes.Contains(value, []byte{0}) {
			return "", invalid
		}
		switch strings.ToLower(path.Ext(name)) {
		case ".css":
			return "text/css; charset=utf-8", nil
		case ".js", ".mjs":
			return "text/javascript; charset=utf-8", nil
		case ".html":
			if !strings.HasPrefix(http.DetectContentType(value), "text/html") {
				return "", invalid
			}
			return "text/html; charset=utf-8", nil
		default:
			if path.Ext(name) == "" && name != "LICENSE" && name != "NOTICE" {
				return "", invalid
			}
			return "text/plain; charset=utf-8", nil
		}
	case ".woff2":
		if len(value) >= 48 && bytes.HasPrefix(value, []byte("wOF2")) {
			return "font/woff2", nil
		}
	}
	return "", invalid
}
