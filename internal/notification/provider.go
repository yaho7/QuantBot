package notification

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	notify "github.com/tx7do/go-utils/notify"
	"github.com/tx7do/go-utils/notify/telegram"
	"github.com/tx7do/go-utils/notify/webhook"
)

type Provider string

const (
	Telegram Provider = "telegram"
	Feishu   Provider = "feishu"
	WeCom    Provider = "wecom"
	DingTalk Provider = "dingtalk"
)

// Credentials are encrypted by the notification channel store and are
// supplied only to the transport used to deliver one message.
type Credentials struct {
	Token   string `json:"token,omitempty"`
	ChatID  string `json:"chatId,omitempty"`
	Webhook string `json:"webhook,omitempty"`
	Secret  string `json:"secret,omitempty"`
}

type Delivery struct {
	ProviderID string
}

type SendError struct {
	Code       string
	Retryable  bool
	RetryAfter time.Duration
}

func (e *SendError) Error() string { return e.Code }

var (
	botToken = regexp.MustCompile(`^[0-9]{1,20}:[A-Za-z0-9_-]{10,160}$`)
	chatID   = regexp.MustCompile(`^(-?[0-9]{1,20}|@[A-Za-z0-9_]{5,64})$`)
	hookKey  = regexp.MustCompile(`^[A-Za-z0-9_-]{4,180}$`)
)

func Validate(provider Provider, c Credentials) error {
	if provider == Telegram {
		if !botToken.MatchString(c.Token) || !chatID.MatchString(c.ChatID) || c.Webhook != "" || c.Secret != "" {
			return errors.New("Telegram requires a bot token and a numeric chat ID or @channel")
		}
		return nil
	}
	if c.Token != "" || c.ChatID != "" || len(c.Secret) > 256 || len(c.Webhook) > 512 {
		return errors.New("invalid webhook credentials")
	}
	u, err := url.Parse(c.Webhook)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || strings.Contains(c.Webhook, "#") || u.RawPath != "" {
		return errors.New("provide the HTTPS webhook copied from the robot settings")
	}
	query, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return errors.New("invalid webhook query")
	}
	exactKey := func(name string) bool {
		return len(query) == 1 && len(query[name]) == 1 && hookKey.MatchString(query.Get(name))
	}
	switch provider {
	case Feishu:
		hook, ok := strings.CutPrefix(u.Path, "/open-apis/bot/v2/hook/")
		if ok && (u.Host == "open.feishu.cn" || u.Host == "open.larksuite.com") && !u.ForceQuery && u.RawQuery == "" && hookKey.MatchString(hook) {
			return nil
		}
	case WeCom:
		if u.Host == "qyapi.weixin.qq.com" && u.Path == "/cgi-bin/webhook/send" && c.Secret == "" && exactKey("key") {
			return nil
		}
	case DingTalk:
		if u.Host == "oapi.dingtalk.com" && u.Path == "/robot/send" && exactKey("access_token") {
			return nil
		}
	default:
		return errors.New("unsupported notification provider")
	}
	return errors.New("webhook does not match the selected bot provider")
}

type Sender struct {
	client *http.Client
}

func NewSender() *Sender {
	client := notify.NewGuardedClient(false)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	client.Timeout = 10 * time.Second
	return &Sender{client: client}
}

func (s *Sender) Send(ctx context.Context, provider Provider, c Credentials, title, content string) (Delivery, error) {
	if err := Validate(provider, c); err != nil {
		return Delivery{}, err
	}
	if strings.TrimSpace(title+content) == "" {
		return Delivery{}, errors.New("notification message is empty")
	}
	message := notify.Message{Title: clip(title, 180), Content: clip(content, 1700)}
	client := *s.client
	client.Transport = guardedResponse{provider: provider, next: client.Transport}
	var transport notify.Service
	switch provider {
	case Telegram:
		transport = telegram.New(&client, telegram.Config{BotToken: c.Token})
		message.Target = c.ChatID
	case Feishu, WeCom, DingTalk:
		style := map[Provider]string{Feishu: "FEISHU", WeCom: "WECOM", DingTalk: "DINGTALK"}[provider]
		transport = webhook.New(&client, webhook.Config{SignStyle: style, Secret: c.Secret})
		message.Target = c.Webhook
	}
	receipt, err := transport.Send(ctx, &message)
	var failure *SendError
	if errors.As(err, &failure) {
		return Delivery{}, failure
	}
	if err != nil {
		// Raw upstream errors may contain the bot token, full webhook URL,
		// response details or the data embedded in the request.
		if errors.Is(err, notify.ErrBlockedTarget) || errors.Is(err, notify.ErrNotConfigured) {
			return Delivery{}, &SendError{Code: "target_rejected"}
		}
		return Delivery{}, &SendError{Code: "transport_failed", Retryable: true}
	}
	return Delivery{ProviderID: receipt.ProviderID}, nil
}

func clip(s string, size int) string {
	if len(s) <= size {
		return s
	}
	for index := range s {
		if index >= size-4 {
			return s[:index] + "…"
		}
	}
	return s
}

type guardedResponse struct {
	provider Provider
	next     http.RoundTripper
}

func (g guardedResponse) RoundTrip(r *http.Request) (*http.Response, error) {
	next := g.next
	if next == nil {
		next = http.DefaultTransport
	}
	resp, err := next.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	const maxBody = 16 << 10
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return nil, &SendError{Code: "response_read_failed", Retryable: true}
	}
	// Telegram exposes retry_after as part of its JSON error response.
	// Other providers use Retry-After or known platform error codes.
	var result struct {
		OK         *bool `json:"ok"`
		ErrorCode  int   `json:"error_code"`
		ErrCode    *int  `json:"errcode"`
		Code       *int  `json:"code"`
		LegacyCode *int  `json:"StatusCode"`
		Parameters struct {
			RetryAfter int `json:"retry_after"`
		} `json:"parameters"`
	}
	parseErr := json.Unmarshal(body, &result)
	retry := time.Duration(min(max(result.Parameters.RetryAfter, 0), 3600)) * time.Second
	if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil {
		retry = max(retry, time.Duration(min(max(seconds, 0), 3600))*time.Second)
	}
	if resp.StatusCode == 429 {
		return nil, &SendError{Code: "rate_limited", Retryable: true, RetryAfter: retry}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &SendError{Code: fmt.Sprintf("http_%d", resp.StatusCode), Retryable: resp.StatusCode >= 500}
	}
	media, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if parseErr != nil || len(body) > maxBody || media != "" && media != "application/json" && media != "text/plain" {
		return nil, &SendError{Code: "invalid_response"}
	}
	var providerCode *int
	switch g.provider {
	case Telegram:
		if result.OK == nil {
			return nil, &SendError{Code: "invalid_response"}
		}
		if !*result.OK {
			if result.ErrorCode == 429 {
				return nil, &SendError{Code: "rate_limited", Retryable: true, RetryAfter: retry}
			}
			return nil, &SendError{Code: codedError(result.ErrorCode), Retryable: result.ErrorCode >= 500}
		}
	case Feishu:
		providerCode = result.Code
		if providerCode == nil {
			providerCode = result.LegacyCode
		}
		if providerCode != nil && (*providerCode == 11232 || *providerCode == 9499) {
			return nil, &SendError{Code: "rate_limited", Retryable: true, RetryAfter: retry}
		}
		if providerCode == nil {
			return nil, &SendError{Code: "invalid_response"}
		}
	case WeCom, DingTalk:
		providerCode = result.ErrCode
		if providerCode == nil {
			return nil, &SendError{Code: "invalid_response"}
		}
		if (g.provider == WeCom && *providerCode == 45009) || (g.provider == DingTalk && *providerCode == 130101) {
			return nil, &SendError{Code: "rate_limited", Retryable: true, RetryAfter: retry}
		}
	}
	if providerCode != nil && *providerCode != 0 {
		return nil, &SendError{Code: codedError(*providerCode)}
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))
	return resp, nil
}

func codedError(code int) string { return fmt.Sprintf("provider_%d", code) }
