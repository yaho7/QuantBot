# Lyra for QuantBot

Lyra is an optional monitoring-home theme built with QuantBot's shared shadcn/ui
components and theme tokens. It replaces the monitoring home while the host
renders navigation, strategy details, administration, and command confirmation.

Build from the repository root with `npm --prefix web run build`. Install
`web/dist/lyra-theme.zip` through Administration > Themes, or use Install Lyra.
Enable Lyra explicitly and restore Classical to switch back. The theme follows the host's language and light or dark mode.

The equity chart and time-range selector open the workspace. The selected
strategy, its trading mode and available controls share the panel beside the
chart. On phones that panel follows the chart. The strategy directory below
includes connection counts, filters and a choice of views.

Lyra reads data through the versioned Host Bridge. Control buttons open the
host's trusted dialog. See `docs/THEME_DEVELOPMENT.md` for the bridge contract.

The host navigation displays the original QuantBot logo. Third-party license
files ship with the package.
