# Astryx for QuantBot

An optional monitoring-home theme, extracted from QuantBot's Astryx redesign.
It changes the monitoring home; the host retains navigation, strategy details,
widget editing, administration and all trusted command workflows.

Build from the repository root with `npm --prefix web run build`. Install
`web/dist/astryx-theme.zip` through Administration > Themes, or use Install Astryx.
Enable it explicitly; restore Classical to switch back. Language, light/dark mode
and the five product palettes follow host settings.

All data is received through the versioned Host Bridge. The iframe cannot read
parent storage/cookies or contact API endpoints. Control buttons request the
host's trusted dialog. See `docs/THEME_DEVELOPMENT.md` for the bridge contract.

The original QuantBot logo is preserved. Third-party license and attribution
files ship with the package. No new runtime dependency is introduced.
