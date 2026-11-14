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

type Config struct {
	Listen         string
	DataDir        string
	PublicOrigin   string
	TrustedProxies []netip.Prefix
	CommandPoll    time.Duration
}

func Load() (Config, error) {
	config := Config{Listen: "127.0.0.1:23456", DataDir: "data", CommandPoll: 25 * time.Second}
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
	if value := os.Getenv("QB_COMMAND_POLL"); value != "" {
		poll, err := time.ParseDuration(value)
		if err != nil || poll <= 0 || poll > 25*time.Second {
			return Config{}, fmt.Errorf("QB_COMMAND_POLL must be a duration up to 25s")
		}
		config.CommandPoll = poll
	}
	return config, nil
}
