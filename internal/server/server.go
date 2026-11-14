package server

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/command"
	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/control"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/realtime"
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

	events := realtime.New()
	commands := command.New(stores.Control, ctx, cfg.CommandPoll, events.Publish)
	if err := commands.Recover(startup); err != nil {
		return err
	}
	reports, err := telemetry.New(stores, telemetry.QueueConfig{Capacity: cfg.MetricsQueue, Batch: cfg.MetricsBatch, Flush: cfg.MetricsFlush}, events.Publish)
	if err != nil {
		return err
	}
	defer reports.Close()
	maintenance, cancelMaintenance := context.WithCancel(ctx)
	var maintained sync.WaitGroup
	maintained.Go(func() { events.Run(maintenance) })
	maintained.Go(func() { commands.Maintain(maintenance) })
	maintained.Go(func() { reports.Maintain(maintenance, cfg.DataDir) })
	defer func() {
		cancelMaintenance()
		maintained.Wait()
	}()

	listener, err := (&net.ListenConfig{}).Listen(startup, "tcp", cfg.Listen)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Handler:           routes(stores, cfg, commands, reports, events),
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

func routes(stores *storage.Stores, cfg config.Config, commands *command.Service, reports *telemetry.Service, events *realtime.Bus) http.Handler {
	router := chi.NewRouter()
	origins := httpapi.Origins{Public: cfg.PublicOrigin, Proxies: cfg.TrustedProxies}
	router.Use(origins.Guard)
	accounts := auth.New(stores.Control)
	strategies := strategy.New(stores.Control, events.Publish)
	controls := control.New(stores.Control, events.Publish)
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
			r.Get("/events", func(w http.ResponseWriter, r *http.Request) {
				events.Stream(w, r, accounts.SessionActive)
			})
			strategies.RegisterBrowser(r)
			controls.RegisterBrowser(r)
			commands.RegisterBrowser(r)
			reports.RegisterBrowser(r)
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
