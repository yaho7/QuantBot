package realtime

import (
	"context"
	"slices"
	"strings"
	"sync"
	"time"
)

type Topic string

const (
	Status    Topic = "status"
	Telemetry Topic = "telemetry"
	Controls  Topic = "controls"
	Commands  Topic = "commands"
	Alerts    Topic = "alerts"
)

type Change struct {
	StrategyID string `json:"strategyId"`
	Topic      Topic  `json:"topic"`
}

type Batch struct {
	Changes []Change `json:"changes,omitempty"`
	Reset   bool     `json:"reset,omitempty"`
}

type Notify func(string, Topic)

func (notify Notify) Emit(strategyID string, topic Topic) {
	if notify != nil {
		notify(strategyID, topic)
	}
}

type Bus struct {
	mu          sync.Mutex
	pending     map[Change]struct{}
	overflow    bool
	subscribers map[chan Batch]struct{}
	stopped     bool
}

const maxPending = 4096
const maxSubscribers = 2048

func New() *Bus {
	return &Bus{pending: make(map[Change]struct{}), subscribers: make(map[chan Batch]struct{})}
}

func (b *Bus) Publish(strategyID string, topic Topic) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stopped || b.overflow {
		return
	}
	key := Change{strategyID, topic}
	if _, exists := b.pending[key]; exists {
		return
	}
	if len(b.pending) == maxPending {
		clear(b.pending)
		b.overflow = true
		return
	}
	b.pending[key] = struct{}{}
}

func (b *Bus) subscribe() (<-chan Batch, func(), bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stopped || len(b.subscribers) >= maxSubscribers {
		return nil, nil, false
	}
	queue := make(chan Batch, 1)
	b.subscribers[queue] = struct{}{}
	return queue, func() {
		b.mu.Lock()
		delete(b.subscribers, queue)
		b.mu.Unlock()
	}, true
}

func (b *Bus) flush() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.pending) == 0 && !b.overflow {
		return
	}
	batch := Batch{Reset: b.overflow}
	for key := range b.pending {
		batch.Changes = append(batch.Changes, key)
	}
	slices.SortFunc(batch.Changes, func(a, b Change) int {
		if order := strings.Compare(a.StrategyID, b.StrategyID); order != 0 {
			return order
		}
		return strings.Compare(string(a.Topic), string(b.Topic))
	})
	clear(b.pending)
	b.overflow = false
	for subscriber := range b.subscribers {
		select {
		case subscriber <- batch:
		default:
			select {
			case <-subscriber:
			default:
			}
			subscriber <- Batch{Reset: true}
		}
	}
}

func (b *Bus) Run(ctx context.Context) {
	ticker := time.NewTicker(125 * time.Millisecond)
	defer ticker.Stop()
	defer func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		b.stopped = true
		for subscriber := range b.subscribers {
			close(subscriber)
		}
		clear(b.subscribers)
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			b.flush()
		}
	}
}
