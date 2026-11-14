# QuantBot theme packages

A ZIP package contains `quantbot-theme.json` and the files referenced by it. The manifest declares a unique lowercase `id`, display `name`, `author`, `description`, release `version`, `engine: "quantbot-theme-v1"`, `type` and `entry`. The inclusive `minQuantBotVersion` is required. The optional `maxQuantBotVersion` is exclusive. Versions use major.minor.patch. Use `preview` for a bundled raster image and `settingsSchema` for a bundled settings declaration.

## Declarative packages

Set the type to `declarative` and the entry to a JSON document. The presentation supports the following keys.

- `light` and `dark` palettes with `background`, `surface`, `foreground`, `muted`, `border`, `accent`, `positive`, `negative` and `chart` six-digit hex colors.
- `sections` with any ordering of `overview`, `strategies`, `activity` and `alerts`. A customized layout must include strategies.
- `cardView` of `large`, `compact`, `mini` or `list`, and `surface` of `solid` or `glass`.
- `font` of `system`, `inter`, `geist` or `ibm-plex-mono`, optional bundled raster `background`, plus `gap` and `radius` in pixels.

## Full frontend packages

Set the type to `frontend` and point `entry` at an HTML document that loads bundled JavaScript and styles. Place scripts in separate files. The document runs in an opaque browser origin. Its content security policy limits resource loads to the installed revision's static path. See [theme security](THEME_SECURITY.md).

### Host Bridge

The iframe sends versioned messages to its host with `parent.postMessage`. Use the origin of its entry URL as the target origin. Wait for `{version:1,type:"quantbot:ready",settings:{...}}` after sending `{version:1,type:"quantbot:ready"}`.

- `quantbot:strategies` with `requestId` returns strategy summaries and their last-seen time.
- `quantbot:control` with `requestId`, `strategyId` and `controlId` requests the trusted control dialog. Its acknowledgment only means the dialog opens.
- `quantbot:error` asks the host to fall back after a fatal render error.

The host validates the source iframe, opaque origin, protocol version and request shape. It limits messages and dialogs. A missing handshake triggers Classic after five seconds. The full theme renders on the workbench home; navigation, saved widget editing, strategy pages and administration remain accessible through the host.

## Settings and lifecycle

The optional settings file has a `fields` array. Each field declares `key`, `label`, `type` and `default`. Types include switch, select, number, text, color, image, background and slider. Select fields declare `options`. Number and slider fields may declare `min` and `max`. Image and background fields use an asset path or the empty string.

The admin API accepts a request body of `application/zip` at `POST /api/admin/themes`. Select a packaged or built-in theme using `PUT /api/admin/themes/active` with `{"id":"theme-id"}`. Upload a higher version with the same ID to update the package. Settings are preserved when compatible with the new schema. Use `POST /api/admin/themes/{id}/rollback` to restore the previous revision, and `DELETE /api/admin/themes/{id}` to delete a package.
