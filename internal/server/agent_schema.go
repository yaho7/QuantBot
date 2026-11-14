package server

import (
	_ "embed"
	"net/http"
)

//go:embed schemas/agent.json
var agentSchema []byte

func serveAgentSchema(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/schema+json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(agentSchema)
}
