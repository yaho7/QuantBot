package server

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/command"
	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/control"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/secrets"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/strategy"
	"github.com/yaho7/QuantBot/internal/telemetry"
)

const shutdownTimeout = 35 * time.Second

func Serve(ctx context.Context, cfg config.Config) (err error) {
	startup, cancelStartup := context.WithTimeout(ctx, 30*time.Second)
	defer cancelStartup()
	stores, err := storage.Open(startup, cfg.DataDir)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, stores.Close()) }()
	if _, err := secrets.Open(startup, cfg.DataDir, controldb.New(stores.Control.Write)); err != nil {
		return err
	}

	commands := command.New(stores.Control, ctx, cfg.CommandPoll)
	if err := commands.Recover(startup); err != nil {
		return err
	}
	reports, err := telemetry.New(stores, telemetry.QueueConfig{Capacity: cfg.MetricsQueue, Batch: cfg.MetricsBatch, Flush: cfg.MetricsFlush})
	if err != nil {
		return err
	}
	defer reports.Close()
	maintenance, cancelMaintenance := context.WithCancel(ctx)
	maintained := make(chan struct{})
	go func() {
		defer close(maintained)
		commands.Maintain(maintenance)
	}()
	defer func() {
		cancelMaintenance()
		<-maintained
	}()

	listener, err := (&net.ListenConfig{}).Listen(startup, "tcp", cfg.Listen)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Handler:           routes(stores, cfg, commands, reports),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       35 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(listener) }()
	slog.Info("QuantBot listening", "address", listener.Addr().String())
	select {
	case err = <-served:
		return errors.Join(err, srv.Close())
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdown); err != nil {
			return errors.Join(err, srv.Close())
		}
		if err := <-served; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}

func routes(stores *storage.Stores, cfg config.Config, commands *command.Service, reports *telemetry.Service) http.Handler {
	router := chi.NewRouter()
	origins := httpapi.Origins{Public: cfg.PublicOrigin, Proxies: cfg.TrustedProxies}
	router.Use(origins.Guard)
	accounts := auth.New(stores.Control)
	strategies := strategy.New(stores.Control)
	controls := control.New(stores.Control)
	router.Route("/api/v1", func(r chi.Router) {
		accounts.Register(r)
		reports.RegisterSchema(r)
		r.Route("/agent", func(r chi.Router) {
			strategies.RegisterAgent(r)
			controls.RegisterAgent(r)
			commands.RegisterAgent(r)
			reports.RegisterAgent(r)
		})
		r.Group(func(r chi.Router) {
			r.Use(accounts.Require)
			strategies.RegisterBrowser(r)
			controls.RegisterBrowser(r)
			commands.RegisterBrowser(r)
		})
	})
	router.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if err := errors.Join(stores.Control.Read.PingContext(ctx), stores.Metrics.Read.PingContext(ctx)); err != nil {
			http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{\"status\":\"ok\"}\n"))
	})
	return router
}
