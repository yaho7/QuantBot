// Exercise the declarative Agent API against a dedicated paper strategy.
package main

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/yaho7/QuantBot/agent"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

//go:embed capabilities.json
var fixture []byte

func run() error {
	endpoint := strings.TrimRight(os.Getenv("QB_AGENT_URL"), "/")
	token := os.Getenv("QB_TOKEN")
	if endpoint == "" || token == "" {
		return fmt.Errorf("set QB_AGENT_URL and QB_TOKEN")
	}
	instance := os.Getenv("QB_INSTANCE_ID")
	if instance == "" {
		instance = "go-example"
	}
	control := os.Getenv("QB_DEMO_CONTROL") == "1"
	var entropy [16]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return err
	}
	boot := hex.EncodeToString(entropy[:])
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := agent.NewClient(endpoint, token, instance, boot, nil)
	session, err := client.Connect(ctx)
	if err != nil {
		return err
	}
	background := make(chan error, 1)
	go func() { background <- client.Run(ctx) }()
	defer func() {
		cancel()
		<-background
	}()
	request := func(method, path string, body, output any) error {
		return client.Do(ctx, method, path, body, output)
	}
	var capabilities []json.RawMessage
	if err := json.Unmarshal(fixture, &capabilities); err != nil {
		return err
	}
	var heartbeat struct{ Executor bool }
	if err := request("PUT", "/heartbeat", nil, &heartbeat); err != nil {
		return err
	}
	for attempt := 0; !heartbeat.Executor && attempt < 120; attempt++ {
		time.Sleep(time.Second)
		if err := request("PUT", "/heartbeat", nil, &heartbeat); err != nil {
			return err
		}
	}
	if !heartbeat.Executor {
		return fmt.Errorf("assign %s as the paper executor", instance)
	}
	if control {
		capabilities = append(capabilities, json.RawMessage(`{
			"id":"demo-refresh","kind":"action","title":"Refresh demo state","value_type":"null",
			"writable":true,"timeout_seconds":30,"presentation":{"suggested":true,"surface":["strategy"]}
		}`))
	}
	var registry struct{ Revision int64 }
	if err := request("PUT", "/capabilities", map[string]any{
		"revision": session.Revision, "capabilities": capabilities,
	}, &registry); err != nil {
		return err
	}

	sendState := func(at int64) error {
		states := []map[string]any{{"id": "broker", "value": true, "observedAt": at}}
		if control {
			states = append(states, map[string]any{"id": "demo-refresh", "value": nil, "observedAt": at})
		}
		var ack json.RawMessage
		if err := request("PUT", "/state", map[string]any{"revision": registry.Revision, "states": states}, &ack); err != nil {
			return err
		}
		fmt.Println(string(ack))
		return nil
	}
	at := time.Now().UnixMilli()
	if err := sendState(at); err != nil {
		return err
	}
	for _, record := range []struct {
		path, capability string
		value            any
	}{
		{"/reports", "poll-latency", "2.50"},
		{"/events", "sample-event", map[string]string{"message": "Paper demo started"}},
	} {
		var ack json.RawMessage
		payload := map[string]any{
			"revision": registry.Revision,
			"records": []any{map[string]any{
				"id": boot + "-" + record.capability, "capabilityId": record.capability,
				"value": record.value, "observedAt": at, "associations": map[string]string{"correlation_id": boot},
			}},
		}
		if err := request("POST", record.path, payload, &ack); err != nil {
			return err
		}
		fmt.Println(string(ack))
	}
	if !control {
		return nil
	}

	for attempt := 0; attempt < 32; attempt++ {
		var offers []struct{ ID, ControlID string }
		if err := request("GET", "/commands?wait=2", nil, &offers); err != nil {
			return err
		}
		for _, offer := range offers {
			if offer.ControlID != "demo-refresh" {
				continue
			}
			path := "/commands/" + offer.ID
			var grant struct {
				Permit, Command string
				Deadline        int64
			}
			claimKey := "claim-" + offer.ID
			if err := client.Claim(ctx, offer.ID, claimKey, &grant); err != nil {
				var response *agent.Error
				if errors.As(err, &response) {
					return err
				}
				if err := client.Claim(ctx, offer.ID, claimKey, &grant); err != nil {
					return err
				}
			}
			now := time.Now().UnixMilli()
			if grant.Command != "demo-refresh" || grant.Permit == "" || grant.Deadline <= now {
				return fmt.Errorf("invalid or expired grant")
			}
			if err := sendState(now); err != nil {
				return err
			}
			receipt := map[string]string{"permit": grant.Permit, "status": "succeeded", "message": "Refreshed demo state"}
			if err := request("POST", path+"/result", receipt, nil); err != nil {
				return err
			}
			var saved struct{ Status string }
			if err := request("POST", path+"/result", receipt, &saved); err != nil {
				return err
			}
			fmt.Println(saved.Status)
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("queue the Refresh demo state command on the paper strategy")
}
