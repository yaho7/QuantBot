package config

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
)

type Config struct {
	Listen  string
	DataDir string
}

func Load() (Config, error) {
	config := Config{Listen: "127.0.0.1:23456", DataDir: "data"}
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
	return config, nil
}
