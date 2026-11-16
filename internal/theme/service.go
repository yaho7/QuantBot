package theme

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sync"
	"time"

	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

const activeKey = "active_theme"

var revisionPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var errConflict = errors.New("theme has no previous version or is already installed")

type Service struct {
	store   storage.Database
	dir     string
	version string
	mu      sync.RWMutex
}

func New(store storage.Database, dataDir, version string) (*Service, error) {
	dir := filepath.Join(dataDir, "themes")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode().Perm()&0022 != 0 {
		return nil, errors.New("themes directory is not private")
	}
	return &Service{store: store, dir: dir, version: version}, nil
}

type instance struct {
	ID           string                     `json:"id"`
	Revision     string                     `json:"revision"`
	Previous     string                     `json:"previousRevision,omitempty"`
	Manifest     Manifest                   `json:"manifest"`
	Presentation Presentation               `json:"presentation"`
	Fields       []Setting                  `json:"fields,omitempty"`
	Settings     map[string]json.RawMessage `json:"settings"`
	Assets       []string                   `json:"assets,omitempty"`
	EntryURL     string                     `json:"entryUrl,omitempty"`
	PreviewURL   string                     `json:"previewUrl,omitempty"`
	AssetBase    string                     `json:"assetBase,omitempty"`
	Builtin      bool                       `json:"builtin"`
	Available    bool                       `json:"available"`
}

func builtin(id string) instance {
	name, cardView := "Classical", "list"
	return instance{
		ID: id, Builtin: true, Available: true,
		Manifest:     Manifest{ID: id, Name: name, Engine: Engine, Type: "declarative"},
		Presentation: Presentation{CardView: cardView, Surface: "solid"},
		Settings:     map[string]json.RawMessage{},
	}
}

func parseBundle(data string) (Bundle, error) {
	var bundle Bundle
	err := json.Unmarshal([]byte(data), &bundle)
	return bundle, err
}

func (s *Service) readInstance(row controldb.GetThemeRow) (instance, error) {
	bundle, err := parseBundle(row.Bundle)
	if err != nil {
		return instance{}, err
	}
	view := instance{
		ID: row.ID, Revision: row.Revision, Previous: row.PreviousRevision, Manifest: bundle.Manifest,
		Presentation: bundle.Presentation, Fields: bundle.Settings,
	}
	if err := json.Unmarshal([]byte(row.Configuration), &view.Settings); err != nil {
		return instance{}, err
	}
	if !identifier.MatchString(row.ID) || !revisionPattern.MatchString(row.Revision) ||
		bundle.Manifest.ID != row.ID || bundle.Manifest.validate(s.version) != nil {
		return view, nil
	}
	if info, err := os.Lstat(filepath.Join(s.dir, row.ID, row.Revision, filepath.FromSlash(bundle.Manifest.Entry))); err != nil || !info.Mode().IsRegular() {
		return view, nil
	}
	view.Available = true
	for name, mime := range bundle.Files {
		if imageAsset(mime) {
			view.Assets = append(view.Assets, name)
		}
	}
	slices.Sort(view.Assets)
	view.AssetBase = "/theme-assets/" + row.ID + "/" + row.Revision + "/"
	if bundle.Manifest.Type == "frontend" {
		view.EntryURL = view.AssetBase + bundle.Manifest.Entry
	}
	if bundle.Manifest.Preview != "" {
		view.PreviewURL = view.AssetBase + bundle.Manifest.Preview
	}
	return view, nil
}

func activeTheme(ctx context.Context, q *controldb.Queries) (string, error) {
	value, err := q.GetSetting(ctx, activeKey)
	var active string
	if err == nil {
		err = json.Unmarshal([]byte(value), &active)
	}
	return active, err
}

func setActive(ctx context.Context, q *controldb.Queries, id string) error {
	body, _ := json.Marshal(id)
	return q.SetSetting(ctx, controldb.SetSettingParams{Key: activeKey, Value: string(body)})
}

func (s *Service) install(ctx context.Context, actor string, body []byte) (instance, error) {
	stage, err := os.MkdirTemp(s.dir, ".upload-")
	if err != nil {
		return instance{}, err
	}
	defer os.RemoveAll(stage)
	bundle, err := Extract(body, stage, s.version)
	if err != nil {
		return instance{}, invalid(err.Error())
	}
	// Synchronize archives before the database can reference their files.
	if err := syncTree(stage); err != nil {
		return instance{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	id := bundle.Manifest.ID
	var randomness [16]byte
	rand.Read(randomness[:])
	revision := hex.EncodeToString(randomness[:])
	parent := filepath.Join(s.dir, id)
	if err := os.MkdirAll(parent, 0700); err != nil {
		return instance{}, err
	}
	if err := syncDirectory(s.dir); err != nil {
		return instance{}, err
	}
	target := filepath.Join(parent, revision)
	if err := os.Rename(stage, target); err != nil {
		return instance{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(target)
		}
	}()
	if err := syncDirectory(parent); err != nil {
		return instance{}, err
	}
	metadata, err := json.Marshal(bundle)
	if err != nil {
		return instance{}, err
	}
	var previous, obsolete, settings string
	now := time.Now().UnixMilli()
	err = storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		old, err := q.GetTheme(ctx, id)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var oldSettings map[string]json.RawMessage
		if err == nil {
			oldBundle, err := parseBundle(old.Bundle)
			if err != nil {
				return err
			}
			if compareVersion(bundle.Manifest.Version, oldBundle.Manifest.Version) <= 0 {
				return errConflict
			}
			previous, obsolete = old.Revision, old.PreviousRevision
			if err := json.Unmarshal([]byte(old.Configuration), &oldSettings); err != nil {
				return err
			}
		} else {
			all, err := q.ListThemes(ctx)
			if err != nil {
				return err
			}
			if len(all) >= 24 {
				return invalid("Theme limit reached")
			}
		}
		settings, err = validConfiguration(bundle, oldSettings, false)
		if err != nil {
			return err
		}
		if err := q.StoreTheme(ctx, controldb.StoreThemeParams{ID: id, Revision: revision, PreviousRevision: previous, UpdatedAt: now}); err != nil {
			return err
		}
		if err := q.StoreThemeRevision(ctx, controldb.StoreThemeRevisionParams{ThemeID: id, Revision: revision, Bundle: string(metadata), Configuration: settings}); err != nil {
			return err
		}
		if obsolete != "" {
			if err := q.DeleteThemeRevision(ctx, controldb.DeleteThemeRevisionParams{ThemeID: id, Revision: obsolete}); err != nil {
				return err
			}
		}
		return audit(ctx, q, actor, "theme.installed", id)
	})
	if err != nil {
		return instance{}, err
	}
	committed = true
	if revisionPattern.MatchString(obsolete) {
		s.removeDirectory(filepath.Join(parent, obsolete))
	}
	return s.readInstance(controldb.GetThemeRow{
		ID: id, Revision: revision, PreviousRevision: previous, UpdatedAt: now, Bundle: string(metadata), Configuration: settings,
	})
}

func validConfiguration(bundle Bundle, input map[string]json.RawMessage, rejectUnknown bool) (string, error) {
	config := make(map[string]json.RawMessage, len(bundle.Settings))
	for _, field := range bundle.Settings {
		value, exists := input[field.Key]
		if exists {
			if err := field.validateValue(value, bundle.Files); err != nil {
				if rejectUnknown {
					return "", invalid(err.Error())
				}
				value = field.Default
			}
		} else {
			value = field.Default
		}
		config[field.Key] = value
	}
	if rejectUnknown {
		for key := range input {
			if _, ok := config[key]; !ok {
				return "", invalid("Unknown theme setting: " + key)
			}
		}
	}
	body, err := json.Marshal(config)
	return string(body), err
}

func audit(ctx context.Context, q *controldb.Queries, actor, action, id string) error {
	details, _ := json.Marshal(map[string]string{"themeId": id})
	return q.AppendAudit(ctx, controldb.AppendAuditParams{At: time.Now().UnixMilli(), Actor: actor, Action: action, Details: string(details)})
}

func syncTree(dir string) error {
	var dirs []string
	err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			dirs = append(dirs, path)
			return nil
		}
		return syncDirectory(path)
	})
	if err != nil {
		return err
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		if err := syncDirectory(dirs[i]); err != nil {
			return err
		}
	}
	return nil
}

func syncDirectory(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(file.Sync(), file.Close())
}

func (s *Service) removeDirectory(dir string) {
	if err := os.RemoveAll(dir); err != nil {
		slog.Warn("theme asset cleanup", "error", err)
	}
}

func (s *Service) getActive(ctx context.Context, q *controldb.Queries) (instance, error) {
	active, err := activeTheme(ctx, q)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (active == "" || active == BuiltinClassical) {
		return builtin(BuiltinClassical), nil
	}
	if err != nil {
		return instance{}, err
	}
	row, err := q.GetTheme(ctx, active)
	if err == nil {
		view, readErr := s.readInstance(row)
		if readErr == nil && view.Available {
			return view, nil
		}
		err = readErr
	}
	slog.Warn("active theme fallback", "theme", active, "error", err)
	return builtin(BuiltinClassical), nil
}

// CheckActive validates the configured theme without creating data directories.
func CheckActive(ctx context.Context, db *sql.DB, dir, version string) (string, error) {
	s := &Service{store: storage.Database{Read: db}, dir: filepath.Join(dir, "themes"), version: version}
	view, err := s.getActive(ctx, controldb.New(db))
	return view.ID, err
}
