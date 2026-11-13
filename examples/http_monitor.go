// One monitoring report using the standard library. No strategy or broker dependencies.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var endpointPattern = regexp.MustCompile(`(?i)^https?://(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]+)?/api/agent/?$`)
var instancePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,55}$`)
var secretPattern = regexp.MustCompile(`^[!-~]{1,128}$`)
var requestIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var rayPattern = regexp.MustCompile(`^[a-f0-9]{16}(?:-[A-Z]{3})?$`)
var mediaTypePattern = regexp.MustCompile(`^[a-z0-9.+/-]{1,64}$`)
var cloudflare1010 = regexp.MustCompile(`(?i)error(?:\s+code)?:?\s*1010\b`)
var agentPath = regexp.MustCompile(`^/(?:session|heartbeat|reports|control(?:/reported)?|controls(?:/state)?|monitor/[A-Za-z0-9_.-]+|commands(?:/[0-9a-f-]{36}/(?:claim|result))?)$`)

var client = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		TLSHandshakeTimeout: 5 * time.Second,
	},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func request(method, path, endpoint, secret, session string, payload []byte) (map[string]any, error) {
	endpoint = strings.TrimSpace(endpoint)
	if !endpointPattern.MatchString(endpoint) {
		return nil, errors.New("set QB_ENDPOINT to the complete /api/agent URL")
	}
	origin, err := url.Parse(endpoint)
	if err != nil || origin.Hostname() == "" {
		return nil, errors.New("invalid Endpoint")
	}
	if port := origin.Port(); port != "" {
		number, err := strconv.ParseUint(port, 10, 16)
		if err != nil || number == 0 {
			return nil, errors.New("invalid Endpoint port")
		}
	}
	if strings.EqualFold(origin.Scheme, "http") {
		switch strings.ToLower(origin.Hostname()) {
		case "localhost", "127.0.0.1", "::1":
		default:
			return nil, errors.New("HTTPS required outside loopback")
		}
	}
	if !agentPath.MatchString(path) || !secretPattern.MatchString(secret) {
		return nil, errors.New("set QB_TOKEN and a valid Agent API path")
	}
	req, err := http.NewRequest(method, strings.TrimSuffix(endpoint, "/")+path, bytes.NewReader(payload))
	if err != nil {
		return nil, errors.New("invalid HTTP request")
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "QuantBot-Integration/1.0")
	if session != "" {
		req.Header.Set("X-Agent-Session", session)
	}
	response, err := client.Do(req)
	if err != nil {
		var dns *net.DNSError
		var certificate *tls.CertificateVerificationError
		var unknownAuthority x509.UnknownAuthorityError
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			return nil, errors.New("timeout")
		case errors.As(err, &certificate), errors.As(err, &unknownAuthority):
			return nil, errors.New("tls")
		case errors.As(err, &dns):
			return nil, errors.New("dns")
		default:
			return nil, errors.New("network")
		}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 16385))
	if err != nil {
		return nil, errors.New("response could not be read")
	}
	code := response.StatusCode
	mediaType := strings.TrimSpace(strings.SplitN(response.Header.Get("Content-Type"), ";", 2)[0])
	id := response.Header.Get("X-QuantBot-Request-ID")
	ray := response.Header.Get("CF-Ray")
	originError := mediaType == "application/json" && requestIDPattern.MatchString(id)
	category := "upstream_http_error"
	switch {
	case code >= 200 && code < 300:
		var data map[string]any
		if mediaType == "application/json" && len(body) <= 16384 &&
			json.Unmarshal(body, &data) == nil && data != nil {
			if !strings.HasPrefix(path, "/monitor/") || validReport(data) {
				return data, nil
			}
		}
		category = "invalid_response"
	case code >= 300 && code < 400:
		category = "redirect_rejected"
	case code == 429:
		category = "rate_limited"
	case code >= 500:
		category = "gateway_unavailable"
	case originError:
		category = map[int]string{401: "authentication_failed", 403: "permission_denied",
			409: "state_conflict", 413: "batch_too_large", 422: "schema_mismatch"}[code]
		if category == "" {
			category = "quantbot_error"
		}
	case code == 403 && (response.Header.Get("CF-Error-Code") == "1010" || cloudflare1010.Match(body)):
		category = "cloudflare_1010"
	}
	diagnostic := map[string]any{"method": method, "path": path, "http": code, "error_class": category}
	if mediaTypePattern.MatchString(mediaType) {
		diagnostic["response_type"] = mediaType
	}
	if originError {
		diagnostic["request_id"] = id
	}
	if rayPattern.MatchString(ray) {
		diagnostic["cf_ray"] = ray
	}
	if value := response.Header.Get("Retry-After"); value != "" {
		if seconds, err := strconv.ParseUint(value, 10, 31); err == nil {
			diagnostic["retry_after"] = seconds
		} else if date, err := http.ParseTime(value); err == nil {
			diagnostic["retry_after"] = max(0, int64(time.Until(date).Seconds())+1)
		}
	}
	safe, _ := json.Marshal(diagnostic)
	return nil, errors.New(string(safe))
}

func validReport(data map[string]any) bool {
	total := 0.0
	for _, key := range []string{"inserted", "duplicates", "ignored"} {
		n, ok := data[key].(float64)
		if !ok || (n != 0 && n != 1) {
			return false
		}
		total += n
	}
	return total == 1
}

func run() error {
	endpoint, secret := os.Getenv("QB_ENDPOINT"), os.Getenv("QB_TOKEN")
	instance := os.Getenv("QB_INSTANCE_ID")
	if instance == "" {
		instance = "go-http-example"
	}
	if !instancePattern.MatchString(instance) {
		return errors.New("choose a valid stable instance name")
	}
	payload, _ := json.Marshal(map[string]any{"records": []any{map[string]any{
		"type": "status", "schema_version": 1, "observed_at": time.Now().UTC().Format("2006-01-02T15:04:05.000000Z07:00"),
		"runtime": map[string]string{"health": "healthy"},
	}}})
	_, err := request("POST", "/monitor/"+instance, endpoint, secret, "", payload)
	return err
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
