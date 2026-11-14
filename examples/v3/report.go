// Report the status of a test strategy with the Go standard library.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

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
	var entropy [16]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return err
	}
	boot := hex.EncodeToString(entropy[:])
	client := &http.Client{Timeout: 10 * time.Second}
	var session struct{ Session string }
	if err := call(client, "POST", endpoint+"/session", token, map[string]string{
		"instanceId": instance, "bootId": boot,
	}, &session); err != nil {
		return err
	}
	if err := call(client, "PUT", endpoint+"/heartbeat", session.Session, nil, nil); err != nil {
		return err
	}
	report := map[string]any{
		"id": boot + "-status", "kind": "status", "observedAt": time.Now().UnixMilli(),
		"data": map[string]string{"state": "running"},
	}
	var result json.RawMessage
	if err := call(client, "POST", endpoint+"/reports", session.Session, map[string]any{
		"version": 1, "records": []any{report},
	}, &result); err != nil {
		return err
	}
	fmt.Println(string(result))
	return nil
}

func call(client *http.Client, method, url, token string, body, output any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if reader != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("QuantBot returned %s", res.Status)
	}
	if output == nil {
		_, err := io.Copy(io.Discard, res.Body)
		return err
	}
	return json.NewDecoder(res.Body).Decode(output)
}
