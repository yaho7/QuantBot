# Optional Astryx monitoring theme

Classical keeps the original workbench, administration, authentication and trusted
command UI. Astryx is distributed as an opt-in `quantbot-theme-v1` frontend ZIP.
Its monitoring home retains the Astryx dashboard frame, compiled product palettes,
original QuantBot artwork, strategy views and financial equity charts. It renders
in an opaque sandbox iframe and communicates through the documented Host Bridge.
No token, session, CSRF value or command execution permission is given to it.

Source: `web/theme-plugins/astryx`. Palettes: `web/themes/quantbot-app`. Build with
`npm --prefix web run build`; the package is `web/dist/astryx-theme.zip`.
`npm --prefix web run check:ui` verifies the plugin's Astryx-only component usage.
The default UI deliberately retains the user's original CSS and layout.

The package reuses this repository's Astryx redesign, generated palettes and
user-authored logo. Astryx is MIT licensed; Lightweight Charts is Apache-2.0.
Their license files and TradingView NOTICE are included in the ZIP, and the chart
attribution remains visible. No new dependency is added. Pinned LuminaPlus and
Komari Web references remain interaction references; no upstream source or assets
were copied into this plugin.

The equity renderer is shared by Classical and Astryx. Its canvas uses numeric
coordinates while the hover readout preserves the server's decimal strings.
Live data updates retain the chart instance; resizing retains the visible time
range. The UI uses theme-derived colors, localized times and responsive heights.
