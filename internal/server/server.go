package server

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/config"
	"github.com/yaho7/QuantBot/internal/secrets"
	"github.com/yaho7/QuantBot/internal/storage"
	"github.com/yaho7/QuantBot/internal/storage/controldb"
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

	listener, err := (&net.ListenConfig{}).Listen(startup, "tcp", cfg.Listen)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Handler:           routes(stores),
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

func routes(stores *storage.Stores) http.Handler {
	router := chi.NewRouter()
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
