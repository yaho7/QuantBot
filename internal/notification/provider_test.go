package notification

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type sendRoundTrip func(*http.Request) (*http.Response, error)

func (f sendRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestProviderConfigurationAndWireFormats(t *testing.T) {
	cases := []struct {
		name        Provider
		credentials Credentials
		host        string
		answer      string
	}{
		{Telegram, Credentials{Token: "12345:local_test_token", ChatID: "-1001234"}, "api.telegram.org", `{"ok":true,"result":{"message_id":123}}`},
		{Feishu, Credentials{Webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abcd-1234", Secret: "local-signing-key"}, "open.feishu.cn", `{"code":0,"msg":"success"}`},
		{Feishu, Credentials{Webhook: "https://open.larksuite.com/open-apis/bot/v2/hook/abcd-1234"}, "open.larksuite.com", `{"StatusCode":0,"StatusMessage":"success"}`},
		{WeCom, Credentials{Webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd-1234"}, "qyapi.weixin.qq.com", `{"errcode":0,"errmsg":"ok"}`},
		{DingTalk, Credentials{Webhook: "https://oapi.dingtalk.com/robot/send?access_token=abcd-1234", Secret: "local-signing-key"}, "oapi.dingtalk.com", `{"errcode":0,"errmsg":"ok"}`},
	}
	for _, tc := range cases {
		t.Run(tc.host, func(t *testing.T) {
			sender := Sender{client: &http.Client{Transport: sendRoundTrip(func(r *http.Request) (*http.Response, error) {
				if r.Method != "POST" || r.URL.Host != tc.host {
					t.Fatalf("unexpected target: %s %s", r.Method, r.URL.Host)
				}
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Fatal(err)
				}
				_ = r.Body.Close()
				if !json.Valid(body) || !strings.Contains(string(body), "Risk notice") {
					t.Fatalf("invalid payload: %s", body)
				}
				switch tc.name {
				case Telegram:
					if r.URL.Path != "/bot"+tc.credentials.Token+"/sendMessage" || !strings.Contains(string(body), tc.credentials.ChatID) {
						t.Fatal("Telegram target and chat ID must match the configuration")
					}
				case Feishu:
					if tc.credentials.Secret != "" {
						var signed struct{ Timestamp, Sign string }
						if err := json.Unmarshal(body, &signed); err != nil {
							t.Fatal(err)
						}
						mac := hmac.New(sha256.New, []byte(signed.Timestamp+"\n"+tc.credentials.Secret))
						if signed.Timestamp == "" || signed.Sign != base64.StdEncoding.EncodeToString(mac.Sum(nil)) {
							t.Fatal("Feishu signature differs from the standard")
						}
					}
				case WeCom:
					if r.URL.Query().Get("key") != "abcd-1234" {
						t.Fatal("WeCom key was not included")
					}
				case DingTalk:
					query := r.URL.Query()
					mac := hmac.New(sha256.New, []byte(tc.credentials.Secret))
					mac.Write([]byte(query.Get("timestamp") + "\n" + tc.credentials.Secret))
					if query.Get("timestamp") == "" || query.Get("sign") != base64.StdEncoding.EncodeToString(mac.Sum(nil)) {
						t.Fatal("DingTalk signature differs from the standard")
					}
				}
				return testResponse(200, tc.answer), nil
			})}}
			delivery, err := sender.Send(t.Context(), tc.name, tc.credentials, "Risk notice", "Paper strategy")
			if err != nil || tc.name == Telegram && delivery.ProviderID != "123" {
				t.Fatalf("send failed: %+v, %v", delivery, err)
			}
		})
	}
}

func TestDeliveryErrorsAreStructuredAndRedacted(t *testing.T) {
	creds := Credentials{Webhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abcd-1234"}
	for _, tc := range []struct {
		status int
		body   string
		want   SendError
	}{
		{200, `{"code":19021,"msg":"abcd-1234"}`, SendError{Code: "provider_19021"}},
		{200, `{"code":11232}`, SendError{Code: "rate_limited", Retryable: true}},
		{200, `{}`, SendError{Code: "invalid_response"}},
		{200, "abcd-1234", SendError{Code: "invalid_response"}},
		{500, "abcd-1234", SendError{Code: "http_500", Retryable: true}},
		{429, `{"parameters":{"retry_after":12}}`, SendError{Code: "rate_limited", Retryable: true, RetryAfter: 12 * time.Second}},
	} {
		sender := Sender{client: &http.Client{Transport: sendRoundTrip(func(r *http.Request) (*http.Response, error) {
			_ = r.Body.Close()
			return testResponse(tc.status, tc.body), nil
		})}}
		_, err := sender.Send(t.Context(), Feishu, creds, "Alert", "Test")
		var actual *SendError
		if !errors.As(err, &actual) || *actual != tc.want || strings.Contains(err.Error(), "abcd-1234") {
			t.Fatalf("status=%d body=%s: got %v, want %+v", tc.status, tc.body, err, tc.want)
		}
	}
}

func TestRejectsUnsupportedDestinations(t *testing.T) {
	for _, url := range []string{
		"http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd",
		"https://127.0.0.1/cgi-bin/webhook/send?key=abcd",
		"https://qyapi.weixin.qq.com@evil.test/cgi-bin/webhook/send?key=abcd",
		"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd&key=efgh",
		"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcd#x",
		"https://qyapi.weixin.qq.com:443/cgi-bin/webhook/send?key=abcd",
	} {
		if Validate(WeCom, Credentials{Webhook: url}) == nil {
			t.Errorf("unsafe webhook accepted %q", url)
		}
	}
	client := NewSender().client
	if err := client.CheckRedirect(&http.Request{}, nil); !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatal("provider redirects must be disabled")
	}
}

func testResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status, Header: http.Header{"Content-Type": {"application/json"}},
		Body: io.NopCloser(strings.NewReader(body)),
	}
}
