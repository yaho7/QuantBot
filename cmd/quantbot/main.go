package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/yaho7/QuantBot/internal/config"
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
	if len(args) != 1 {
		return fmt.Errorf("usage: quantbot serve | version")
	}
	switch args[0] {
	case "version":
		fmt.Println(version)
		return nil
	case "serve":
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return server.Serve(ctx, cfg)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}
