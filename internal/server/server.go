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
	"github.com/yaho7/QuantBot/internal/agentapi"
	"github.com/yaho7/QuantBot/internal/auth"
	"github.com/yaho7/QuantBot/internal/command"
	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/control"
	"github.com/yaho7/QuantBot/internal/dashboard"
	"github.com/yaho7/QuantBot/internal/httpapi"
	"github.com/yaho7/QuantBot/internal/notification"
	"github.com/yaho7/QuantBot/internal/realtime"
	"github.com/yaho7/QuantBot/internal/sandbox"
	"github.com/yaho7/QuantBot/internal/secrets"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
	"github.com/yaho7/QuantBot/internal/strategy"
	"github.com/yaho7/QuantBot/internal/telemetry"
	"github.com/yaho7/QuantBot/internal/theme"
	"github.com/yaho7/QuantBot/web"
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
	key, err := secrets.Open(startup, cfg.DataDir, controldb.New(stores.Control.Write))
	if err != nil {
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
	notifications := notification.New(stores.Control, key)
	themes, err := theme.New(stores.Control, cfg.DataDir, "3.0.0")
	if err != nil {
		return err
	}
	sandboxes := sandbox.New(ctx, stores.Control)
	defer sandboxes.Close()
	maintenance, cancelMaintenance := context.WithCancel(ctx)
	var maintained sync.WaitGroup
	maintained.Go(func() { sandboxes.Maintain(maintenance) })
	maintained.Go(func() { notifications.Run(maintenance) })
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
		Handler:           routes(stores, cfg, commands, reports, events, notifications, themes, sandboxes),
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

func routes(stores *storage.Stores, cfg config.Config, commands *command.Service, reports *telemetry.Service, events *realtime.Bus, notifications *notification.Service, themes *theme.Service, sandboxes *sandbox.Service) http.Handler {
	router := chi.NewRouter()
	origins := httpapi.Origins{Public: cfg.PublicOrigin, Proxies: cfg.TrustedProxies}
	router.Use(origins.Guard)
	accounts := auth.New(stores.Control)
	strategies := strategy.New(stores.Control, events.Publish, cfg.AgentSessionTTL)
	controls := control.New(stores.Control, events.Publish)
	layouts := dashboard.New(stores.Control)
	router.Route("/api/agent", func(r chi.Router) {
		agentapi.Register(r, strategies, controls, commands, reports)
		sandboxes.RegisterAgent(r)
		reports.RegisterSchema(r)
		r.Get("/schemas/agent.json", serveAgentSchema)
	})
	router.Route("/api", func(r chi.Router) {
		accounts.Register(r)

		r.Group(func(r chi.Router) {
			r.Use(accounts.Require)
			sandboxes.RegisterBrowser(r)
			layouts.Register(r)
			notifications.Register(r)
			themes.Register(r)
			r.Get("/admin/diagnostics", diagnostics(stores, reports, events, cfg.DataDir))
			r.Get("/events", func(w http.ResponseWriter, r *http.Request) {
				events.Stream(w, r, accounts.SessionActive)
			})
			strategies.RegisterBrowser(r)
			controls.RegisterBrowser(r)
			commands.RegisterBrowser(r)
			reports.RegisterBrowser(r)
		})
	})
	router.Get("/theme-assets/{id}/{revision}/*", themes.Assets)
	router.Head("/theme-assets/{id}/{revision}/*", themes.Assets)
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
	router.NotFound(web.Handler().ServeHTTP)
	return router
}
