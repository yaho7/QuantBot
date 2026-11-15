// Exercise the declarative Agent API against a dedicated paper strategy.
package main

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/yaho7/QuantBot/agent"
)

func main() {
	control := flag.Bool("demo-control", false, "wait for a simulated Refresh demo state command")
	flag.Parse()
	if err := run(*control); err != nil {
		log.Fatal(err)
	}
}

//go:embed capabilities.json
var fixture []byte

type localConfig struct {
	Endpoint   string `json:"endpoint"`
	Secret     string `json:"secret"`
	Instance   string `json:"instance_name"`
	StrategyID string `json:"strategy_id"`
	Heartbeat  int    `json:"heartbeat_seconds"`
	Policy     string `json:"disconnect_policy"`
}

func loadConfig() (localConfig, error) {
	cfg := localConfig{Heartbeat: 15, Policy: "continue"}
	body, err := os.ReadFile("quantbot.json")
	if err != nil || json.Unmarshal(body, &cfg) != nil {
		return cfg, errors.New("create a valid local quantbot.json using quantbot.example.json")
	}
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || u.Hostname() == "" || u.User != nil || strings.ContainsAny(cfg.Endpoint, "?#\\ \t\r\n") ||
		(u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"))) {
		return cfg, errors.New("set endpoint to a QuantBot HTTPS URL or local loopback URL in quantbot.json")
	}
	path := strings.TrimRight(u.EscapedPath(), "/")
	if path == "" {
		path = "/api/agent"
	}
	if !regexp.MustCompile("^/api/agent(/sandbox/[A-Za-z0-9_-]+)?$").MatchString(path) {
		return cfg, errors.New("set endpoint to a QuantBot origin, Agent or Sandbox URL")
	}
	cfg.Endpoint = u.Scheme + "://" + u.Host + path
	if !regexp.MustCompile("^qbt_[A-Za-z0-9_-]+$").MatchString(cfg.Secret) {
		return cfg, errors.New("paste the Agent Token into secret in quantbot.json")
	}
	if !regexp.MustCompile("^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$").MatchString(cfg.Instance) {
		return cfg, errors.New("set a stable instance_name in quantbot.json")
	}
	if cfg.Heartbeat < 1 || cfg.Heartbeat > 15 {
		return cfg, errors.New("heartbeat_seconds must be an integer from 1 to 15")
	}
	if cfg.Policy != "continue" {
		return cfg, errors.New("the demo supports only disconnect_policy 'continue'")
	}
	return cfg, nil
}

func run(control bool) error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	var entropy [16]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return err
	}
	boot := hex.EncodeToString(entropy[:])
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := agent.NewClient(cfg.Endpoint, cfg.Secret, cfg.Instance, boot, nil)
	session, err := client.Connect(ctx)
	if err != nil {
		return err
	}
	if cfg.StrategyID != "" && session.StrategyID != cfg.StrategyID {
		return errors.New("session strategy does not match strategy_id in quantbot.json")
	}
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
	interval := time.Duration(cfg.Heartbeat) * time.Second
	for attempt := 1; !heartbeat.Executor && attempt*cfg.Heartbeat <= 120; attempt++ {
		time.Sleep(interval)
		if err := request("PUT", "/heartbeat", nil, &heartbeat); err != nil {
			return err
		}
	}
	if !heartbeat.Executor {
		return fmt.Errorf("assign %s as the paper executor", cfg.Instance)
	}
	background := make(chan error, 1)
	go func() { background <- client.RunWithHeartbeat(ctx, interval) }()
	defer func() {
		cancel()
		<-background
	}()
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
