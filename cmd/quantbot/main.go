package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/maintenance"
	"github.com/yaho7/QuantBot/internal/server"
)

const version = "3.0.0"

func main() {
	if err := run(os.Args[1:]); err != nil {
		slog.Error("QuantBot", "error", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	const usage = "usage: quantbot serve | version | doctor | health | backup <archive.zip> | restore <archive.zip>"
	if len(args) == 0 {
		return fmt.Errorf("%s", usage)
	}
	switch args[0] {
	case "backup", "restore":
		if len(args) != 2 {
			return fmt.Errorf("%s", usage)
		}
	case "version", "serve", "doctor", "health":
		if len(args) != 1 {
			return fmt.Errorf("%s", usage)
		}
	default:
		return fmt.Errorf("%s", usage)
	}
	if args[0] == "version" {
		fmt.Println(version)
		return nil
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	switch args[0] {
	case "serve":
		return server.Serve(ctx, cfg)
	case "doctor":
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		return maintenance.Doctor(ctx, cfg, version, os.Stdout)
	case "health":
		return maintenance.ProbeHealth(ctx, cfg)
	case "backup":
		return maintenance.Backup(ctx, cfg.DataDir, args[1])
	default:
		return maintenance.Restore(ctx, args[1], cfg.DataDir)
	}
}
