package agentapi

import (
	"github.com/go-chi/chi/v5"
	"github.com/yaho7/QuantBot/internal/command"
	"github.com/yaho7/QuantBot/internal/control"
	"github.com/yaho7/QuantBot/internal/strategy"
	"github.com/yaho7/QuantBot/internal/telemetry"
)

func Register(r chi.Router, strategies *strategy.Service, controls *control.Service, commands *command.Service, reports *telemetry.Service) {
	strategies.RegisterAgent(r)
	controls.RegisterAgent(r)
	commands.RegisterAgent(r)
	reports.RegisterAgent(r)
}
