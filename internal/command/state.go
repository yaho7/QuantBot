package command

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/yaho7/QuantBot/internal/realtime"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

const (
	created      = "created"
	confirmation = "confirmation_required"
	pending      = "pending"
	accepted     = "accepted"
	executing    = "executing"
	succeeded    = "succeeded"
	failed       = "failed"
	unknown      = "unknown"
	cancelled    = "cancelled"
	expired      = "expired"
	rejected     = "rejected"

	queueTTL = 2 * time.Minute
)

var errState = errors.New("command is unavailable in its current state")

func allowed(from, to string) bool {
	switch from {
	case created:
		return to == confirmation || to == pending
	case confirmation:
		return to == pending || to == cancelled || to == expired
	case pending:
		return to == accepted || to == rejected || to == cancelled || to == expired
	case accepted:
		return to == executing || to == rejected || to == cancelled || to == expired
	case executing:
		return to == succeeded || to == failed || to == unknown
	case unknown:
		return to == succeeded || to == failed
	default:
		return false
	}
}

func transition(ctx context.Context, q *controldb.Queries, cmd *controldb.Command, next, actor, reason string, now int64) error {
	if !allowed(cmd.Status, next) {
		return errState
	}
	count, err := q.TransitionCommand(ctx, controldb.TransitionCommandParams{
		ID: cmd.ID, Previous: cmd.Status, Next: next, UpdatedAt: now,
		AcceptedBy: cmd.AcceptedBy, Deadline: cmd.Deadline, Receipt: cmd.Receipt,
	})
	if err != nil {
		return err
	}
	if count != 1 {
		return errState
	}
	if err := record(ctx, q, *cmd, next, actor, reason, now); err != nil {
		return err
	}
	cmd.Status, cmd.UpdatedAt = next, now
	return nil
}

func record(ctx context.Context, q *controldb.Queries, cmd controldb.Command, next, actor, reason string, now int64) error {
	if err := q.AppendCommandTransition(ctx, controldb.AppendCommandTransitionParams{
		CommandID: cmd.ID, Previous: sql.NullString{String: cmd.Status, Valid: cmd.Status != ""},
		Next: next, Actor: actor, Reason: reason, At: now,
	}); err != nil {
		return err
	}
	details, err := json.Marshal(map[string]string{"controlId": cmd.ControlID, "reason": reason})
	if err != nil {
		return err
	}
	return q.AppendAudit(ctx, controldb.AppendAuditParams{
		At: now, Actor: actor, Action: "command." + next, Details: string(details),
		StrategyID: sql.NullString{String: cmd.StrategyID, Valid: true}, CommandID: sql.NullString{String: cmd.ID, Valid: true},
	})
}

func (s *Service) Recover(ctx context.Context) error {
	return s.expireCommands(ctx, true)
}

func (s *Service) Maintain(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := s.expireCommands(run, false)
			cancel()
			if err != nil && ctx.Err() == nil {
				slog.Error("expire commands", "error", err)
			}
		}
	}
}

func (s *Service) expireCommands(ctx context.Context, restart bool) error {
	now := time.Now()
	args := controldb.GetStaleCommandsParams{
		Now: now.Unix(), NowMs: now.UnixMilli(), SeenAfter: now.Add(-strategy.PresenceTTL).Unix(),
		Restart: restart,
	}
	for {
		rows, err := controldb.New(s.store.Read).GetStaleCommands(ctx, args)
		if err != nil || len(rows) == 0 {
			return err
		}
		var changed []string
		if err := storage.WithTx(ctx, s.store.Write, func(tx *sql.Tx) error {
			q := controldb.New(tx)
			current, err := q.GetStaleCommands(ctx, args)
			if err != nil {
				return err
			}
			for _, cmd := range current {
				next := expired
				reason := "deadline elapsed or execution authority changed"
				if cmd.Status == executing {
					next = unknown
					if restart {
						reason = "service restarted before an execution result was recorded"
					}
				}
				if err := transition(ctx, q, &cmd, next, "system", reason, args.NowMs); err != nil {
					return fmt.Errorf("expire command %s: %w", cmd.ID, err)
				}
				changed = append(changed, cmd.StrategyID)
			}
			return nil
		}); err != nil {
			return err
		}
		for _, id := range changed {
			s.notify.Emit(id, realtime.Commands)
		}
		if len(rows) < 128 {
			return nil
		}
	}
}
