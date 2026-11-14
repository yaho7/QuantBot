package telemetry

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestReportSchemaForEveryKind(t *testing.T) {
	schema, err := loadSchema()
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{schema: schema}
	now := time.Now()
	at := now.Truncate(time.Minute).UnixMilli()
	cases := map[string]string{
		"status":      `{"state":"running","allowEntry":false}`,
		"connection":  `{"brokerConnected":true}`,
		"portfolio":   `{"accounts":[{"accountId":"paper","currency":"USD","equity":"123456789012345678901234.012345678901234567"}]}`,
		"position":    `{"positions":[{"accountId":"paper","positionId":"1","symbol":"BTC","side":"long","quantity":"0.000000000000000001"}]}`,
		"equity":      `{"accountId":"paper","currency":"USD","value":"3.0","drawdown":"-0.5"}`,
		"order":       `{"accountId":"paper","orderId":"1","symbol":"BTC","side":"buy","status":"filled","quantity":"0.01"}`,
		"fill":        `{"accountId":"paper","fillId":"1","orderId":"1","symbol":"BTC","side":"buy","quantity":"0.01","price":"25.5"}`,
		"performance": `{"accountId":"paper","currency":"USD","winRate":"0.4"}`,
		"metric":      `{"name":"spread","value":"0.1"}`,
		"ohlcv":       `{"symbol":"BTC","intervalSeconds":60,"open":"25.5","high":"27","low":"25","close":"27","volume":"0.02"}`,
		"signal":      `{"symbol":"BTC","name":"breakout","direction":"buy"}`,
		"risk":        `{"code":"entry-disabled","severity":"warning","message":"Risk lock","locked":true}`,
		"alert":       `{"code":"broker","severity":"error","message":"Broker disconnected"}`,
		"log":         `{"severity":"info","message":"Started"}`,
	}
	for kind, payload := range cases {
		t.Run(kind, func(t *testing.T) {
			raw := fmt.Sprintf(`{"id":"sample","kind":%q,"observedAt":%d,"data":%s}`, kind, at, payload)
			if _, err := s.decodeRecord(json.RawMessage(raw), now); err != nil {
				t.Fatal(err)
			}
			raw = fmt.Sprintf(`{"id":"sample","kind":%q,"observedAt":%d,"data":{%s,"unknown":1}}`, kind, at, payload[1:len(payload)-1])
			if _, err := s.decodeRecord(json.RawMessage(raw), now); err == nil {
				t.Fatal("accepted unknown payload field")
			}
		})
	}
	for _, tc := range []struct {
		kind, body string
		at         int64
	}{
		{"metric", `{"name":"spread","value":0.1}`, at},
		{"status", `{"state":null}`, at},
		{"status", `{"state":"running"}`, now.Add(3 * time.Minute).UnixMilli()},
		{"status", `{"state":"running"}`, now.Add(-8 * 24 * time.Hour).UnixMilli()},
		{"portfolio", `{"accounts":[{"accountId":"paper","currency":"USD","equity":"1"},{"accountId":"paper","currency":"USD","equity":"2"}]}`, at},
		{"ohlcv", `{"symbol":"BTC","intervalSeconds":60,"open":"3","high":"2","low":"1","close":"2","volume":"1"}`, at},
		{"ohlcv", cases["ohlcv"], at + 1},
	} {
		raw := fmt.Sprintf(`{"id":"sample","kind":%q,"observedAt":%d,"data":%s}`, tc.kind, tc.at, tc.body)
		if _, err := s.decodeRecord(json.RawMessage(raw), now); err == nil {
			t.Fatalf("accepted invalid record %s", raw)
		}
	}
}
