// Package agent provides a session client for use inside a strategy process.
package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string {
	return fmt.Sprintf("QuantBot HTTP %d (%s): %s", e.Status, e.Code, e.Message)
}

type Session struct {
	StrategyID string `json:"strategyId"`
	Executor   bool   `json:"executor"`
	ExpiresAt  int64  `json:"expiresAt"`
	RenewAt    *int64 `json:"renewAt"`
	Revision   int64  `json:"revision"`
	bearer     string
}

type Client struct {
	endpoint   string
	token      string
	instanceID string
	bootID     string
	http       *http.Client
	session    atomic.Pointer[Session]
	renew      sync.Mutex
}

func NewClient(endpoint, token, instanceID, bootID string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	copy := *httpClient
	copy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{endpoint: strings.TrimRight(endpoint, "/"), token: token, instanceID: instanceID, bootID: bootID, http: &copy}
}

func (c *Client) connect(ctx context.Context, previous *Session) (*Session, error) {
	c.renew.Lock()
	defer c.renew.Unlock()
	if current := c.session.Load(); current != previous {
		return current, nil
	}
	var identity struct {
		Session
		Bearer string `json:"session"`
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	err := c.call(ctx, "POST", "/session", c.token, "", map[string]string{
		"instanceId": c.instanceID, "bootId": c.bootID,
	}, &identity)
	if err != nil {
		return nil, err
	}
	if identity.Bearer == "" || identity.ExpiresAt <= time.Now().Unix() {
		return nil, errors.New("invalid QuantBot session response")
	}
	identity.Session.bearer = identity.Bearer
	c.session.Store(&identity.Session)
	return &identity.Session, nil
}

// Connect obtains the initial session. Run maintains it during the strategy's lifetime.
func (c *Client) Connect(ctx context.Context) (Session, error) {
	session := c.session.Load()
	if session == nil || session.ExpiresAt <= time.Now().Unix() {
		var err error
		session, err = c.connect(ctx, session)
		if err != nil {
			return Session{}, err
		}
	}
	public := *session
	public.bearer = ""
	if public.RenewAt != nil {
		value := *public.RenewAt
		public.RenewAt = &value
	}
	return public, nil
}

// Run blocks until cancellation or permanent credential failure. Run it in a
// background task. A transient renewal failure keeps the currently valid session.
func (c *Client) Run(ctx context.Context) error {
	return c.RunWithHeartbeat(ctx, 15*time.Second)
}

// RunWithHeartbeat maintains the session with a caller-configured heartbeat.
// Use 15 seconds unless the local Agent configuration asks for a shorter interval.
func (c *Client) RunWithHeartbeat(ctx context.Context, interval time.Duration) error {
	if interval <= 0 || interval > 15*time.Second {
		return errors.New("QuantBot heartbeat interval must be greater than zero and at most 15 seconds")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	heartbeatError := make(chan error, 1)
	go c.heartbeat(ctx, interval, heartbeatError)
	backoff := time.Second
	var retryAt time.Time
	for ctx.Err() == nil {
		current := c.session.Load()
		if current != nil && current.RenewAt == nil && time.Now().Unix() >= current.ExpiresAt {
			return &Error{Status: http.StatusUnauthorized, Code: "agent_token_expired", Message: "Agent token expired"}
		}
		renewAt := retryAt
		if renewAt.IsZero() && current != nil {
			at := current.ExpiresAt
			if current.RenewAt != nil {
				at = *current.RenewAt
			}
			renewAt = time.Unix(at, 0)
		}
		timer := time.NewTimer(time.Until(renewAt))
		select {
		case <-ctx.Done():
			timer.Stop()
		case err := <-heartbeatError:
			timer.Stop()
			return err
		case <-timer.C:
			if _, err := c.connect(ctx, current); err != nil {
				if permanent(err) {
					return err
				}
				retryAt = time.Now().Add(backoff + rand.N(backoff/2))
				backoff = min(2*backoff, time.Minute)
			} else {
				backoff, retryAt = time.Second, time.Time{}
			}
		}
	}
	return ctx.Err()
}

// Heartbeat runs independently of session renewal and command requests.
func (c *Client) heartbeat(ctx context.Context, interval time.Duration, terminal chan<- error) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			current := c.session.Load()
			if current == nil || time.Now().Unix() >= current.ExpiresAt {
				continue
			}
			call, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := c.call(call, "PUT", "/heartbeat", current.bearer, "", nil, nil)
			cancel()
			if permanent(err) {
				terminal <- err
				return
			}
		}
	}
}

// Do retries an explicitly rejected expired credential once, after switching
// sessions. Transport failures are returned so the caller can use its protocol
// idempotency key or durable execution journal.
func (c *Client) Do(ctx context.Context, method, path string, body, response any) error {
	return c.request(ctx, method, path, "", body, response)
}

// Claim uses the persisted attempt key. Reusing a key can require reconciliation.
func (c *Client) Claim(ctx context.Context, commandID, key string, response any) error {
	return c.request(ctx, "POST", "/commands/"+url.PathEscape(commandID)+"/claim", key, nil, response)
}

func (c *Client) request(ctx context.Context, method, path, key string, body, response any) error {
	current := c.session.Load()
	if current == nil {
		var err error
		current, err = c.connect(ctx, nil)
		if err != nil {
			return err
		}
	}
	err := c.call(ctx, method, path, current.bearer, key, body, response)
	var status *Error
	if !errors.As(err, &status) || status.Code != "session_expired" {
		return err
	}
	next, err := c.connect(ctx, current)
	if err != nil {
		return err
	}
	return c.call(ctx, method, path, next.bearer, key, body, response)
}

func permanent(err error) bool {
	var status *Error
	if !errors.As(err, &status) {
		return false
	}
	return status.Status >= 400 && status.Status < 500 &&
		status.Status != http.StatusRequestTimeout && status.Status != http.StatusTooManyRequests &&
		status.Code != "session_expired"
}

func (c *Client) call(ctx context.Context, method, path, bearer, key string, body, output any) error {
	if !strings.HasPrefix(path, "/") {
		return errors.New("Agent path must begin with /")
	}
	ctx, cancel := context.WithTimeout(ctx, 32*time.Second)
	defer cancel()
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint+path, payload)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	reply, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer reply.Body.Close()
	if reply.StatusCode >= 300 {
		status := &Error{Status: reply.StatusCode}
		_ = json.NewDecoder(io.LimitReader(reply.Body, 8192)).Decode(status)
		return status
	}
	if output == nil {
		_, err := io.Copy(io.Discard, reply.Body)
		return err
	}
	return json.NewDecoder(reply.Body).Decode(output)
}
