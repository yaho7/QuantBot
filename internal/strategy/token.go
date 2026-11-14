package strategy

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

type tokenView struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Scopes    []string `json:"scopes"`
	CreatedAt int64    `json:"createdAt"`
	ExpiresAt *int64   `json:"expiresAt"`
	RevokedAt *int64   `json:"revokedAt"`
	Token     string   `json:"token,omitempty"`
}

var scopes = []struct {
	name string
	bit  int64
}{
	{"heartbeat", HeartbeatScope}, {"report", ReportScope},
	{"control", ControlScope}, {"command", CommandScope},
}

func scopeNames(mask int64) []string {
	names := make([]string, 0, len(scopes))
	for _, scope := range scopes {
		if mask&scope.bit != 0 {
			names = append(names, scope.name)
		}
	}
	return names
}

func scopeMask(names []string) int64 {
	var mask int64
	for _, name := range names {
		var bit int64
		for _, scope := range scopes {
			if name == scope.name {
				bit = scope.bit
				break
			}
		}
		if bit == 0 || mask&bit != 0 {
			return 0
		}
		mask |= bit
	}
	return mask
}

func (s *Service) tokens(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), chi.URLParam(r, "id")
	q := controldb.New(s.store.Read)
	if _, err := q.GetStrategy(ctx, id); err != nil {
		httpError(w, err)
		return
	}
	rows, err := q.ListAgentTokens(ctx, id)
	if err != nil {
		httpError(w, err)
		return
	}
	items := make([]tokenView, 0, len(rows))
	for _, row := range rows {
		items = append(items, tokenView{
			ID: row.ID, Label: row.Label, Scopes: scopeNames(row.Scopes), CreatedAt: row.CreatedAt,
			ExpiresAt: nullableInt(row.ExpiresAt), RevokedAt: nullableInt(row.RevokedAt),
		})
	}
	httpapi.JSON(w, http.StatusOK, items)
}

func (s *Service) issueToken(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Label     string   `json:"label"`
		Scopes    []string `json:"scopes"`
		ExpiresAt *int64   `json:"expiresAt"`
	}
	if !httpapi.ReadJSON(w, r, &input, 4096) {
		return
	}
	input.Label = strings.TrimSpace(input.Label)
	now, mask := time.Now().Unix(), scopeMask(input.Scopes)
	var expiry sql.NullInt64
	if input.ExpiresAt != nil {
		expiry = sql.NullInt64{Int64: *input.ExpiresAt, Valid: true}
	}
	if mask == 0 || len(input.Label) == 0 || len(input.Label) > 120 || (expiry.Valid && expiry.Int64 <= now) {
		httpapi.Error(w, http.StatusBadRequest, "invalid_token", "Provide a label, unique scopes, and an optional future expiry")
		return
	}
	ctx, id := r.Context(), chi.URLParam(r, "id")
	raw, tokenID := "qbt_"+random(32), random(16)
	err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
		q := controldb.New(tx)
		row, err := q.GetStrategy(ctx, id)
		if err != nil {
			return err
		}
		if row.ArchivedAt.Valid {
			return errConflict
		}
		if err := q.CreateAgentToken(ctx, controldb.CreateAgentTokenParams{
			ID: tokenID, StrategyID: id, Digest: digest(raw), Label: input.Label, Scopes: mask, CreatedAt: now, ExpiresAt: expiry,
		}); err != nil {
			return err
		}
		return appendAudit(ctx, q, auth.Current(r).Username, "strategy.token_issued", id)
	})
	if err != nil {
		httpError(w, err)
		return
	}
	httpapi.JSON(w, http.StatusCreated, tokenView{
		ID: tokenID, Label: input.Label, Scopes: scopeNames(mask), CreatedAt: now, ExpiresAt: input.ExpiresAt, Token: raw,
	})
}

func (s *Service) revokeToken(w http.ResponseWriter, r *http.Request) {
	s.change(w, r, "strategy.token_revoked", func(ctx context.Context, q *controldb.Queries, id string) error {
		return changed(q.RevokeAgentToken(ctx, controldb.RevokeAgentTokenParams{
			Now: sql.NullInt64{Int64: time.Now().Unix(), Valid: true}, TokenID: chi.URLParam(r, "token"), StrategyID: id,
		}))
	})
}
