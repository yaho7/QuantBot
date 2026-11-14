package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

type workload struct {
	api      *api
	stats    requests
	sent     atomic.Int64
	saved    atomic.Int64
	replays  atomic.Int64
	retries  atomic.Int64
	rejected atomic.Int64
	seq      atomic.Int64
}

type report struct {
	ID   string            `json:"id"`
	Kind string            `json:"kind"`
	At   int64             `json:"observedAt"`
	Data map[string]string `json:"data"`
}

func (w *workload) agentCycle(ctx context.Context, worker agent, points int) error {
	if _, err := w.stats.call(w.api, ctx, "heartbeat", "PUT", "/agent/heartbeat", worker.session, "", nil, nil); err != nil {
		return err
	}
	sequence := w.seq.Add(1)
	batch := make([]report, points)
	at := time.Now().UnixMilli()
	for i := range batch {
		batch[i] = report{
			ID: fmt.Sprintf("%s-%d-%d", worker.instance, sequence, i), Kind: "metric",
			At: at + int64(i), Data: map[string]string{"name": "spread", "value": "0.00125"},
		}
	}
	w.sent.Add(int64(points))
	if err := w.upload(ctx, worker, batch); err != nil {
		return err
	}
	if sequence%23 == 0 {
		return w.upload(ctx, worker, batch)
	}
	return nil
}

func (w *workload) upload(ctx context.Context, worker agent, batch []report) error {
	body := struct {
		Version int      `json:"version"`
		Records []report `json:"records"`
	}{1, batch}
	for attempt := range 6 {
		var ack struct{ Inserted, Duplicate, Rejected int }
		code, err := w.stats.call(w.api, ctx, "reports", "POST", "/agent/reports", worker.session, "", body, &ack)
		if err == nil {
			w.saved.Add(int64(ack.Inserted))
			w.replays.Add(int64(ack.Duplicate))
			w.rejected.Add(int64(ack.Rejected))
			if ack.Inserted+ack.Duplicate != len(batch) || ack.Rejected != 0 {
				return fmt.Errorf("incomplete telemetry acknowledgement: %+v", ack)
			}
			return nil
		}
		if code != 429 && code != 503 || attempt == 5 {
			return err
		}
		w.retries.Add(1)
		select {
		case <-time.After(time.Duration(attempt+1) * 30 * time.Millisecond):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return errors.New("retry attempts exhausted")
}

func (w *workload) openStreams(ctx context.Context, count int) (*sync.WaitGroup, error) {
	var streams sync.WaitGroup
	for range count {
		res, err := w.api.request(ctx, "GET", "/events", "", "", nil)
		if err != nil {
			return &streams, err
		}
		if res.StatusCode != 200 {
			res.Body.Close()
			return &streams, fmt.Errorf("SSE returned %d", res.StatusCode)
		}
		streams.Go(func() {
			defer res.Body.Close()
			_, _ = io.Copy(io.Discard, res.Body)
		})
	}
	return &streams, nil
}

func (w *workload) prepareControl(ctx context.Context) (agent, error) {
	id, token, err := w.api.createStrategy(ctx, "Control latency")
	if err != nil {
		return agent{}, err
	}
	worker, err := w.api.connect(ctx, "executor", id, token)
	if err != nil {
		return agent{}, err
	}
	if _, err := w.api.call(ctx, "PUT", "/admin/strategies/"+id+"/executor", "", "",
		map[string]string{"instanceId": worker.instance}, nil); err != nil {
		return agent{}, err
	}
	definition := json.RawMessage(`{"version":1,"baseRevision":0,"controls":[{"id":"pause","kind":"toggle","title":"Pause entries"}]}`)
	if _, err := w.api.call(ctx, "PUT", "/agent/controls", worker.session, "", definition, nil); err != nil {
		return agent{}, err
	}
	actual := json.RawMessage(fmt.Sprintf(`{"version":1,"revision":1,"states":[{"id":"pause","available":true,"observedAt":%d,"value":false}]}`, time.Now().UnixMilli()))
	_, err = w.api.call(ctx, "PUT", "/agent/controls/state", worker.session, "", actual, nil)
	return worker, err
}

func (w *workload) controlCycle(ctx context.Context, worker agent, index int) error {
	var created struct{ ID string }
	_, err := w.stats.call(w.api, ctx, "command_create", "POST", "/strategies/"+worker.strategy+"/commands", "",
		fmt.Sprintf("cycle-%d", index), json.RawMessage(`{"controlId":"pause","revision":1,"input":true}`), &created)
	if err != nil {
		return err
	}
	path := "/agent/commands/" + created.ID
	var claimed struct{ Permit string }
	if _, err := w.stats.call(w.api, ctx, "command_claim", "POST", path+"/claim", worker.session, "", nil, &claimed); err != nil {
		return err
	}
	_, err = w.stats.call(w.api, ctx, "command_result", "POST", path+"/result", worker.session, "",
		map[string]string{"permit": claimed.Permit, "status": "succeeded"}, nil)
	return err
}

func (w *workload) historyCycle(ctx context.Context, worker agent, repeats int) error {
	now := time.Now().UnixMilli()
	query := url.Values{
		"kind": {"metric"}, "instanceId": {worker.instance}, "series": {`["spread",""]`},
		"from": {fmt.Sprint(now - 3600000)}, "to": {fmt.Sprint(now + 30000)}, "points": {"60"},
	}
	path := "/strategies/" + worker.strategy + "/history?" + query.Encode()
	for range repeats {
		if _, err := w.stats.call(w.api, ctx, "history", "GET", path, "", "", nil, nil); err != nil {
			return err
		}
	}
	return nil
}
