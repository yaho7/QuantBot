package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

type api struct {
	origin string
	client *http.Client
	cookie *http.Cookie
	csrf   string
}

func (a *api) request(ctx context.Context, method, path, token, key string, input any) (*http.Response, error) {
	var body io.Reader
	if input != nil {
		payload, err := json.Marshal(input)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.origin+apiPath(path), body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	} else {
		req.Header.Set("Origin", a.origin)
		req.Header.Set("X-CSRF-Token", a.csrf)
		if a.cookie != nil {
			req.AddCookie(a.cookie)
		}
	}
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	return a.client.Do(req)
}

func (a *api) call(ctx context.Context, method, path, token, key string, body, output any) (int, error) {
	res, err := a.request(ctx, method, path, token, key, body)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(res.Body, 1024))
		return res.StatusCode, fmt.Errorf("%s %s returned %d: %s", method, path, res.StatusCode, message)
	}
	if output != nil {
		err = json.NewDecoder(res.Body).Decode(output)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	return res.StatusCode, err
}

type agent struct {
	strategy string
	instance string
	session  string
}

func (a *api) setup(ctx context.Context) error {
	res, err := a.request(ctx, "POST", "/auth/setup", "", "", map[string]string{
		"username": "benchmark", "password": "local-benchmark-fixture",
	})
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var session struct{ CSRF string }
	if res.StatusCode != 200 || len(res.Cookies()) != 1 {
		return fmt.Errorf("benchmark requires an empty service, setup returned %d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&session); err != nil {
		return err
	}
	a.cookie, a.csrf = res.Cookies()[0], session.CSRF
	return nil
}

func (a *api) createStrategy(ctx context.Context, label string) (string, string, error) {
	var response struct {
		Strategy   struct{ ID string }
		Credential struct{ Token string }
	}
	_, err := a.call(ctx, "POST", "/admin/strategies", "", "", map[string]string{
		"name": label, "group": "Benchmark", "mode": "paper",
	}, &response)
	return response.Strategy.ID, response.Credential.Token, err
}

func (a *api) connect(ctx context.Context, id, strategyID, token string) (agent, error) {
	var response struct{ Session string }
	_, err := a.call(ctx, "POST", "/agent/session", token, "", map[string]string{
		"instanceId": id, "bootId": "benchmark",
	}, &response)
	return agent{strategyID, id, response.Session}, err
}

type requests struct {
	mu     sync.Mutex
	byName map[string][]time.Duration
	errors int
}

func (r *requests) call(a *api, ctx context.Context, name, method, path, token, key string, body, result any) (int, error) {
	start := time.Now()
	code, err := a.call(ctx, method, path, token, key, body, result)
	r.mu.Lock()
	r.byName[name] = append(r.byName[name], time.Since(start))
	if err != nil {
		r.errors++
	}
	r.mu.Unlock()
	return code, err
}

func apiPath(path string) string {
	if strings.HasPrefix(path, "/agent/") {
		return "/api" + path
	}
	return "/api/v1" + path
}
