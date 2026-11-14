package config

import (
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const DefaultAgentSessionTTL = time.Hour

type Config struct {
	AgentSessionTTL time.Duration
	Listen          string
	DataDir         string
	PublicOrigin    string
	TrustedProxies  []netip.Prefix
	LoopbackGateway netip.Addr
	Profiling       bool
	CommandPoll     time.Duration
	MetricsQueue    int
	MetricsBatch    int
	MetricsFlush    time.Duration
}

func Load() (Config, error) {
	config := Config{AgentSessionTTL: DefaultAgentSessionTTL, Listen: "127.0.0.1:23456", DataDir: "data", CommandPoll: 25 * time.Second,
		MetricsQueue: 128, MetricsBatch: 16, MetricsFlush: 12 * time.Millisecond}
	if value, ok := os.LookupEnv("QB_LISTEN"); ok {
		config.Listen = value
	}
	if value, ok := os.LookupEnv("QB_DATA_DIR"); ok {
		config.DataDir = value
	}
	_, port, err := net.SplitHostPort(config.Listen)
	if err != nil {
		return Config{}, fmt.Errorf("QB_LISTEN: %w", err)
	}
	if _, err := strconv.ParseUint(port, 10, 16); err != nil {
		return Config{}, fmt.Errorf("QB_LISTEN: invalid port")
	}
	if config.DataDir == "" {
		return Config{}, fmt.Errorf("QB_DATA_DIR cannot be empty")
	}
	config.DataDir, err = filepath.Abs(config.DataDir)
	if err != nil {
		return Config{}, fmt.Errorf("QB_DATA_DIR: %w", err)
	}
	if value := os.Getenv("QB_PUBLIC_ORIGIN"); value != "" {
		public, err := url.Parse(value)
		if err != nil || public.Scheme != "https" || public.Hostname() == "" || public.User != nil ||
			public.Path != "" || public.ForceQuery || public.RawQuery != "" || public.Fragment != "" ||
			strings.ContainsAny(value, "?#") {
			return Config{}, fmt.Errorf("QB_PUBLIC_ORIGIN must be an HTTPS origin without a path")
		}
		config.PublicOrigin = "https://" + strings.ToLower(public.Host)
	}
	if value := os.Getenv("QB_TRUSTED_PROXIES"); value != "" {
		for part := range strings.SplitSeq(value, ",") {
			prefix, err := netip.ParsePrefix(strings.TrimSpace(part))
			if err != nil || prefix.Bits() == 0 || prefix.Addr().Is4In6() {
				return Config{}, fmt.Errorf("QB_TRUSTED_PROXIES must contain explicit IPv4 or IPv6 CIDRs")
			}
			config.TrustedProxies = append(config.TrustedProxies, prefix.Masked())
		}
	}
	if os.Getenv("QB_DOCKER_LOOPBACK") == "1" {
		config.LoopbackGateway, err = dockerGateway()
		if err != nil {
			return Config{}, fmt.Errorf("QB_DOCKER_LOOPBACK: %w", err)
		}
	}
	if value := os.Getenv("QB_ENABLE_PPROF"); value != "" {
		config.Profiling, err = strconv.ParseBool(value)
		if err != nil {
			return Config{}, fmt.Errorf("QB_ENABLE_PPROF: %w", err)
		}
	}
	if value := os.Getenv("QB_AGENT_SESSION_TTL"); value != "" {
		ttl, err := time.ParseDuration(value)
		if err != nil || ttl < time.Second || ttl%time.Second != 0 {
			return Config{}, fmt.Errorf("QB_AGENT_SESSION_TTL must be a positive whole-second duration")
		}
		config.AgentSessionTTL = ttl
	}
	if value := os.Getenv("QB_COMMAND_POLL"); value != "" {
		poll, err := time.ParseDuration(value)
		if err != nil || poll <= 0 || poll > 25*time.Second {
			return Config{}, fmt.Errorf("QB_COMMAND_POLL must be a duration up to 25s")
		}
		config.CommandPoll = poll
	}
	for _, item := range []struct {
		name    string
		target  *int
		maximum int
	}{
		{"QB_METRICS_QUEUE", &config.MetricsQueue, 1024},
		{"QB_METRICS_BATCH", &config.MetricsBatch, 128},
	} {
		if value := os.Getenv(item.name); value != "" {
			number, err := strconv.Atoi(value)
			if err != nil || number < 1 || number > item.maximum {
				return Config{}, fmt.Errorf("%s must be an integer between 1 and %d", item.name, item.maximum)
			}
			*item.target = number
		}
	}
	if value := os.Getenv("QB_METRICS_FLUSH"); value != "" {
		flush, err := time.ParseDuration(value)
		if err != nil || flush < time.Millisecond || flush > time.Second {
			return Config{}, fmt.Errorf("QB_METRICS_FLUSH must be a duration between 1ms and 1s")
		}
		config.MetricsFlush = flush
	}
	return config, nil
}
