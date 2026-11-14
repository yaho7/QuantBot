package notification

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
)

type deliverer interface {
	Send(context.Context, Provider, Credentials, string, string) (Delivery, error)
}

type Service struct {
	store  storage.Database
	cipher cipher.AEAD
	sender deliverer
	wake   chan struct{}
}

func New(store storage.Database, key [32]byte) *Service {
	block, err := aes.NewCipher(key[:])
	if err != nil {
		panic(err)
	}
	aead, err := cipher.NewGCMWithRandomNonce(block)
	if err != nil {
		panic(err)
	}
	return &Service{store: store, cipher: aead, sender: NewSender(), wake: make(chan struct{}, 1)}
}

func channelID() string {
	var value [18]byte
	rand.Read(value[:])
	return base64.RawURLEncoding.EncodeToString(value[:])
}

func (s *Service) seal(id, provider string, credentials Credentials) ([]byte, error) {
	body, err := json.Marshal(credentials)
	if err != nil {
		return nil, err
	}
	return s.cipher.Seal(nil, nil, body, associatedData(id, provider)), nil
}

func (s *Service) open(id, provider string, encrypted []byte) (Credentials, error) {
	var credentials Credentials
	body, err := s.cipher.Open(nil, nil, encrypted, associatedData(id, provider))
	if err != nil {
		return credentials, err
	}
	return credentials, json.Unmarshal(body, &credentials)
}

func associatedData(id, provider string) []byte {
	return []byte("notification-channel:v1:" + id + ":" + provider)
}

func (s *Service) Run(ctx context.Context) {
	poll := time.NewTicker(time.Second)
	defer poll.Stop()
	prune := time.NewTicker(time.Hour)
	defer prune.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-poll.C:
			s.deliver(ctx)
		case <-s.wake:
			s.deliver(ctx)
		case now := <-prune.C:
			if err := controldb.New(s.store.Write).PruneNotificationEvents(ctx, now.Add(-30*24*time.Hour).UnixMilli()); err != nil && ctx.Err() == nil {
				slog.Error("notification retention", "error", err)
			}
		}
	}
}

func (s *Service) deliver(ctx context.Context) {
	items, err := controldb.New(s.store.Read).NextNotificationDeliveries(ctx, time.Now().UnixMilli())
	if err != nil {
		if ctx.Err() == nil {
			slog.Error("query notification outbox", "error", err)
		}
		return
	}
	// Process at most one item per destination in each pass.
	destinations := make(map[string]bool)
	var jobs sync.WaitGroup
	limit := make(chan struct{}, 8)
	for _, row := range items {
		if destinations[row.ChannelID] {
			continue
		}
		destinations[row.ChannelID] = true
		select {
		case limit <- struct{}{}:
		case <-ctx.Done():
			jobs.Wait()
			return
		}
		jobs.Go(func() {
			defer func() { <-limit }()
			result := s.send(ctx, row)
			if ctx.Err() != nil {
				return
			}
			if err := controldb.New(s.store.Write).CompleteNotificationDelivery(ctx, result); err != nil && ctx.Err() == nil {
				slog.Error("persist notification receipt", "delivery", row.ID, "error", err)
			}
		})
	}
	jobs.Wait()
}

func (s *Service) send(ctx context.Context, row controldb.NextNotificationDeliveriesRow) controldb.CompleteNotificationDeliveryParams {
	now := time.Now()
	result := controldb.CompleteNotificationDeliveryParams{ID: row.ID, Status: "failed", NextAt: now.UnixMilli()}
	result.FinishedAt.Int64, result.FinishedAt.Valid = now.UnixMilli(), true
	credentials, err := s.open(row.ChannelID, row.Provider, row.Encrypted)
	if err != nil {
		result.LastError = "credentials_unavailable"
		return result
	}
	timeout, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	receipt, err := s.sender.Send(timeout, Provider(row.Provider), credentials, row.Title, row.Body)
	now = time.Now()
	result.FinishedAt.Int64 = now.UnixMilli()
	if err == nil {
		result.Status, result.ProviderID = "sent", receipt.ProviderID
		return result
	}
	result.LastError = "delivery_failed"
	var sendErr *SendError
	if errors.As(err, &sendErr) {
		result.LastError = sendErr.Code
		if sendErr.Retryable && row.Attempts < 5 {
			backoff := time.Second * time.Duration(5<<row.Attempts)
			result.Status = "queued"
			result.NextAt = now.Add(max(backoff, sendErr.RetryAfter)).UnixMilli()
			result.FinishedAt.Valid = false
		}
	}
	return result
}
