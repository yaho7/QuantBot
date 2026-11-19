# Astryx for QuantBot

An optional monitoring-home theme, extracted from QuantBot's Astryx redesign.
It changes the monitoring home; the host retains navigation, strategy details,
widget editing, administration and all trusted command workflows.

Build from the repository root with `npm --prefix web run build`. Install
`web/dist/astryx-theme.zip` through Administration > Themes, or use Install Astryx.
To update an existing Astryx installation, download and upload the new ZIP from
Administration > Themes. Enable Astryx explicitly and restore Classical to switch
back. Language, light/dark mode and the five product palettes follow host settings.

The strategy summary stays in one row on phones. The equity panel groups the
strategy and time-range controls with the chart. Each strategy view shows online
or offline as text, and controls show the selected strategy and trading mode.

All data is received through the versioned Host Bridge. The iframe cannot read
parent storage/cookies or contact API endpoints. Control buttons request the
host's trusted dialog. See `docs/THEME_DEVELOPMENT.md` for the bridge contract.

The host navigation displays the original QuantBot logo. Third-party license and
attribution files ship with the package.
