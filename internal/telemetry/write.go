package telemetry

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/storage/metricsdb"
	"github.com/yaho7/QuantBot/internal/strategy"
)

type indexedRecord struct {
	Record
	index int
}

type Rejection struct {
	Index   int    `json:"index"`
	Message string `json:"message"`
}

type Ack struct {
	Inserted  int         `json:"inserted"`
	Duplicate int         `json:"duplicate"`
	Rejected  int         `json:"rejected"`
	Errors    []Rejection `json:"errors,omitempty"`
}

const (
	inserted  = ""
	duplicate = "duplicate"
	conflict  = "report ID already exists with different data"
)

func (a *Ack) add(index int, result string) {
	switch result {
	case inserted:
		a.Inserted++
	case duplicate:
		a.Duplicate++
	default:
		a.Rejected++
		a.Errors = append(a.Errors, Rejection{Index: index, Message: result})
	}
}

func (a *Ack) merge(other Ack) {
	a.Inserted += other.Inserted
	a.Duplicate += other.Duplicate
	a.Rejected += other.Rejected
	a.Errors = append(a.Errors, other.Errors...)
}

func fingerprint(instance string, r Record) string {
	hash := sha256.New()
	fmt.Fprintf(hash, "%s\x00%d\x00", instance, r.ObservedAt)
	hash.Write(r.Data)
	return hex.EncodeToString(hash.Sum(nil))
}

func compareFingerprint(existing, current string, err error) (string, error) {
	if err != nil {
		return "", err
	}
	if existing == current {
		return duplicate, nil
	}
	return conflict, nil
}

func writeTrade(ctx context.Context, q *controldb.Queries, agent strategy.Agent, r Record) (string, error) {
	instance := agent.InstanceID
	if r.Kind == "fill" {
		instance = ""
	}
	hash := fingerprint(instance, r)
	count, err := q.InsertTradeEvent(ctx, controldb.InsertTradeEventParams{
		StrategyID: agent.StrategyID, InstanceID: agent.InstanceID, ReportID: r.ID,
		Kind: r.Kind, Series: r.Series, ObservedAt: r.ObservedAt, Data: string(r.Data), Fingerprint: hash,
	})
	if err != nil || count == 1 {
		return inserted, err
	}
	existing, err := q.TradeEventFingerprint(ctx, controldb.TradeEventFingerprintParams{
		StrategyID: agent.StrategyID, Kind: r.Kind, ReportID: r.ID,
	})
	if r.Kind == "fill" && errors.Is(err, sql.ErrNoRows) {
		existing, err = q.FillFingerprint(ctx, controldb.FillFingerprintParams{
			StrategyID: agent.StrategyID, Series: r.Series,
		})
	}
	return compareFingerprint(existing, hash, err)
}

func writeMetric(ctx context.Context, q *metricsdb.Queries, agent strategy.Agent, r Record) (string, error) {
	hash := fingerprint(agent.InstanceID, r)
	count, err := q.InsertSample(ctx, metricsdb.InsertSampleParams{
		StrategyID: agent.StrategyID, InstanceID: agent.InstanceID, ReportID: r.ID,
		Kind: r.Kind, Series: r.Series, ObservedAt: r.ObservedAt, Data: string(r.Data), Fingerprint: hash,
	})
	if err != nil {
		return inserted, err
	}
	if count == 0 {
		existing, err := q.SampleFingerprint(ctx, metricsdb.SampleFingerprintParams{
			StrategyID: agent.StrategyID, Kind: r.Kind, ReportID: r.ID,
		})
		return compareFingerprint(existing, hash, err)
	}
	// Historical event streams are read from the samples table.
	if r.Kind == "log" || r.Kind == "signal" || r.Kind == "ohlcv" {
		return inserted, nil
	}
	err = q.PutLatestSample(ctx, metricsdb.PutLatestSampleParams{
		StrategyID: agent.StrategyID, InstanceID: agent.InstanceID, ReportID: r.ID,
		Kind: r.Kind, Series: r.Series, ObservedAt: r.ObservedAt, Data: string(r.Data),
	})
	return inserted, err
}

type snapshot struct {
	Version    int               `json:"version"`
	ObservedAt int64             `json:"observedAt"`
	Records    []json.RawMessage `json:"records"`
}

func writeSnapshot(ctx context.Context, q *metricsdb.Queries, agent strategy.Agent, input snapshot) (Ack, error) {
	var ack Ack
	body, err := json.Marshal(input.Records)
	if err != nil {
		return ack, err
	}
	old, err := q.GetSnapshot(ctx, metricsdb.GetSnapshotParams{StrategyID: agent.StrategyID, InstanceID: agent.InstanceID, BootID: agent.BootID})
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return ack, err
	}
	switch {
	case old.ObservedAt == input.ObservedAt && old.Records == string(body):
		ack.Duplicate = len(input.Records)
	case old.ObservedAt >= input.ObservedAt:
		ack.Rejected = len(input.Records)
		ack.Errors = []Rejection{{Index: -1, Message: "snapshot observation is older or already has different data"}}
	default:
		err = q.PutSnapshot(ctx, metricsdb.PutSnapshotParams{
			StrategyID: agent.StrategyID, InstanceID: agent.InstanceID, BootID: agent.BootID,
			ObservedAt: input.ObservedAt, Records: string(body),
		})
		if err == nil {
			ack.Inserted = len(input.Records)
		}
		return ack, err
	}
	return ack, nil
}
