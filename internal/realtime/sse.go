package realtime

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/yaho7/QuantBot/internal/httpapi"
)

func (b *Bus) Stream(w http.ResponseWriter, r *http.Request, active func(*http.Request) bool) {
	queue, unsubscribe, ok := b.subscribe()
	if !ok {
		w.Header().Set("Retry-After", "2")
		httpapi.Error(w, http.StatusServiceUnavailable, "stream_unavailable", "Realtime subscriber capacity reached")
		return
	}
	defer unsubscribe()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	controller := http.NewResponseController(w)

	// Every connection starts with a cache refresh. There is no event replay
	// because notifications carry invalidations rather than database contents.
	if !writeEvent(w, controller, "retry: 2000\nevent: change\ndata: {\"reset\":true}\n\n") {
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case batch, ok := <-queue:
			if !ok {
				return
			}
			body, err := json.Marshal(batch)
			if err != nil || !writeEvent(w, controller, "event: change\ndata: "+string(body)+"\n\n") {
				return
			}
		case <-heartbeat.C:
			if !active(r) || !writeEvent(w, controller, ": heartbeat\n\n") {
				return
			}
		case <-r.Context().Done():
			return
		}
	}
}

func writeEvent(w http.ResponseWriter, controller *http.ResponseController, event string) bool {
	_ = controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err := fmt.Fprint(w, event)
	return err == nil && controller.Flush() == nil
}
