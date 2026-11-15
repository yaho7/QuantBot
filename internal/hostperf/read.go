package hostperf

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"slices"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/httpapi"
)

type reading[T any] struct {
	ObservedAt int64 `json:"observedAt"`
	ReceivedAt int64 `json:"receivedAt"`
	Data       T     `json:"data"`
}

type hostView struct {
	host
	Capacity *resources           `json:"capacity"`
	Latest   *reading[hostSample] `json:"latest"`
	Stale    bool                 `json:"stale"`
}

type member struct {
	Strategy string                  `json:"strategyId"`
	Name     string                  `json:"strategyName"`
	Instance string                  `json:"instanceId"`
	Host     string                  `json:"hostId"`
	HostName string                  `json:"hostName"`
	Boot     string                  `json:"-"`
	Budget   *resources              `json:"budget"`
	Latest   *reading[processSample] `json:"latest"`
	Stale    bool                    `json:"stale"`
}

func sampleRows[T any](ctx context.Context, db *sql.DB, query string, args ...any) ([]reading[T], error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]reading[T], 0)
	for rows.Next() {
		var item reading[T]
		var payload string
		if err := rows.Scan(&item.ObservedAt, &item.ReceivedAt, &payload); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(payload), &item.Data); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Service) hostReadings(ctx context.Context, id string, from int64, limit int) ([]reading[hostSample], error) {
	return sampleRows[hostSample](ctx, s.stores.Metrics.Read, `SELECT observed_at,received_at,host_data FROM performance_samples
		WHERE host_id=? AND host_run>0 AND host_data IS NOT NULL AND observed_at>=?
		AND host_run=(SELECT host_run FROM performance_samples WHERE host_id=? AND host_data IS NOT NULL AND host_run>0
			ORDER BY observed_at DESC,received_at DESC,record_id DESC LIMIT 1)
		ORDER BY observed_at DESC,received_at DESC,record_id DESC LIMIT ?`, id, from, id, limit)
}

func fresh(now time.Time, observed int64) bool {
	return observed >= now.Add(-freshness).UnixMilli() && observed <= now.UnixMilli()
}

func (s *Service) viewHost(ctx context.Context, h host, now time.Time) (hostView, error) {
	v := hostView{host: h, Stale: true}
	var item reading[hostSample]
	var payload string
	var capacity sql.NullString
	err := s.stores.Metrics.Read.QueryRowContext(ctx, `SELECT observed_at,received_at,host_data,host_capacity FROM performance_samples
		WHERE host_id=? AND host_data IS NOT NULL AND host_run>0 ORDER BY observed_at DESC,received_at DESC,record_id DESC LIMIT 1`, h.ID).
		Scan(&item.ObservedAt, &item.ReceivedAt, &payload, &capacity)
	if err == sql.ErrNoRows {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	if err = json.Unmarshal([]byte(payload), &item.Data); err != nil {
		return v, err
	}
	if capacity.Valid {
		if err = json.Unmarshal([]byte(capacity.String), &v.Capacity); err != nil {
			return v, err
		}
	}
	v.Latest, v.Stale = &item, !fresh(now, item.ObservedAt)
	return v, nil
}

func (s *Service) list(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := s.stores.Control.Read.QueryContext(ctx, "SELECT id,name FROM performance_hosts WHERE "+discovered+" ORDER BY name,id")
	if err != nil {
		writeError(w, err)
		return
	}
	var hosts []host
	for rows.Next() {
		var h host
		if err := rows.Scan(&h.ID, &h.Name); err != nil {
			rows.Close()
			writeError(w, err)
			return
		}
		hosts = append(hosts, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	out := make([]hostView, 0, len(hosts))
	now := time.Now()
	for _, h := range hosts {
		v, err := s.viewHost(ctx, h, now)
		if err != nil {
			writeError(w, err)
			return
		}
		out = append(out, v)
	}
	httpapi.JSON(w, 200, out)
}

const memberFields = `SELECT b.strategy_id,s.name,b.instance_id,b.host_id,h.name,b.boot_id,b.budget
	FROM performance_bindings b JOIN performance_hosts h ON h.id=b.host_id
	JOIN agent_instances a ON (a.strategy_id,a.instance_id,a.boot_id)=(b.strategy_id,b.instance_id,b.boot_id)
	JOIN strategies s ON s.id=b.strategy_id AND s.archived_at IS NULL`

func (s *Service) members(ctx context.Context, where string, args ...any) ([]member, error) {
	rows, err := s.stores.Control.Read.QueryContext(ctx, memberFields+" WHERE "+where+" ORDER BY s.name,b.instance_id", args...)
	if err != nil {
		return nil, err
	}
	var out = make([]member, 0)
	for rows.Next() {
		var m member
		var raw string
		if err := rows.Scan(&m.Strategy, &m.Name, &m.Instance, &m.Host, &m.HostName, &m.Boot, &raw); err != nil {
			rows.Close()
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &m.Budget); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	now := time.Now()
	for i, m := range out {
		latest, err := s.processReadings(ctx, m, 0, 1)
		if err != nil {
			return nil, err
		}
		out[i].Stale = true
		if len(latest) > 0 {
			out[i].Latest = &latest[0]
			out[i].Stale = !fresh(now, latest[0].ObservedAt)
		}
	}
	return out, nil
}

func (s *Service) processReadings(ctx context.Context, m member, from int64, limit int) ([]reading[processSample], error) {
	return sampleRows[processSample](ctx, s.stores.Metrics.Read, `SELECT observed_at,received_at,process_data FROM performance_samples
		WHERE strategy_id=? AND instance_id=? AND boot_id=? AND process_data IS NOT NULL AND process_run>0 AND observed_at>=?
		AND process_run=(SELECT process_run FROM performance_samples WHERE strategy_id=? AND instance_id=? AND boot_id=?
			AND process_data IS NOT NULL AND process_run>0 ORDER BY observed_at DESC,received_at DESC,record_id DESC LIMIT 1)
		ORDER BY observed_at DESC,received_at DESC,record_id DESC LIMIT ?`, m.Strategy, m.Instance, m.Boot, from, m.Strategy, m.Instance, m.Boot, limit)
}

func (s *Service) findHost(ctx context.Context, id string) (host, error) {
	var h host
	err := s.stores.Control.Read.QueryRowContext(ctx, "SELECT id,name FROM performance_hosts WHERE id=? AND "+discovered, id).Scan(&h.ID, &h.Name)
	return h, err
}

func (s *Service) detail(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	h, err := s.findHost(ctx, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	now := time.Now()
	view, err := s.viewHost(ctx, h, now)
	if err != nil {
		writeError(w, err)
		return
	}
	members, err := s.members(ctx, "b.host_id=?", h.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	// Only chart the current uninterrupted run within the last hour.
	history, err := s.hostReadings(ctx, h.ID, now.Add(-time.Hour).UnixMilli(), 240)
	if err != nil {
		writeError(w, err)
		return
	}
	slices.Reverse(history)
	httpapi.JSON(w, 200, struct {
		hostView
		Members []member              `json:"members"`
		History []reading[hostSample] `json:"history"`
	}{view, members, history})
}

func (s *Service) strategyPerformance(w http.ResponseWriter, r *http.Request) {
	members, err := s.members(r.Context(), "b.strategy_id=? AND h."+discovered, chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, err)
		return
	}
	httpapi.JSON(w, 200, members)
}

func (s *Service) processHistory(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	targets, err := s.members(ctx, "b.strategy_id=? AND b.instance_id=? AND h."+discovered, chi.URLParam(r, "id"), chi.URLParam(r, "instanceId"))
	if err != nil {
		writeError(w, err)
		return
	}
	if len(targets) == 0 {
		writeError(w, sql.ErrNoRows)
		return
	}
	history, err := s.processReadings(ctx, targets[0], time.Now().Add(-time.Hour).UnixMilli(), 240)
	if err != nil {
		writeError(w, err)
		return
	}
	slices.Reverse(history)
	httpapi.JSON(w, 200, history)
}
