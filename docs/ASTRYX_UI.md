# Astryx UI

The React UI uses Astryx 0.7.16 for its application shell, responsive navigation,
forms, dialogs, surfaces, typography and tables. The monitoring and administration
shells remain separate. API authorization, command confirmation, execution
receipts and the isolated frontend theme bridge remain owned by QuantBot.

The shell follows Astryx's `shell-nav` frame; monitoring content follows the
`dashboard-alert-rail` hierarchy (headline values, primary chart, supporting
strategy and attention sections). Existing uPlot and Lightweight Charts renderers
are retained, so no overlapping chart library is added.

The QuantBot palette was generated with the Astryx theme editor from `neutral`.
`web/themes/quantbot/quantbot.settings.json` and its theme source are the editable
inputs; `web/src/themes/quantbot` is the generated app copy. Rebuild with:

```sh
cd web
npx astryx experimental theme compile themes/quantbot/quantbot.theme.ts
npm run build
npx astryx doctor --built dist
```

Astryx is MIT licensed; see `docs/licenses/astryx.txt`. No new dependency was
introduced for this redesign. LuminaPlus's shell, token hierarchy and card density
and Komari Web's grouped admin navigation were inspected as interaction references
at the repository's pinned baselines:

- LuminaPlus: `f479ff0bb298b1e9d2a27f0641ed6775c1c05180` (MIT).
- Komari Web: `05c3bad5dedf42796aae3cc0a528f474a0860fc0` (independent file licensing
  was not established, so no source or assets were copied).

The redesign independently implements these interactions with Astryx. It does
not copy upstream monitoring models, source, media or compiled themes.

The five fixed product palettes are compiled from `web/themes/quantbot-app` with
`astryx theme build`; runtime `defineTheme` is reserved for user-installed,
validated declarative presentation settings. The theme host adapts those settings
to Astryx tokens, scoped to the workbench. Administration keeps the product theme.
The default font uses the system stack and needs no font service.

All former page CSS layers have been removed. Layout props and token-backed
Tailwind utilities provide spacing and responsive composition. The remaining
application stylesheet contains only saved-grid/resize geometry and iframe size;
uPlot retains its required renderer stylesheet. Native `code`, `time`, `dt` and
`dd` keep their document semantics around Astryx text. Lucide artwork is rendered
through Astryx Icon, retaining the project's icon set.

Run `npm run check:ui` to reject raw layout/control/table elements, page CSS
imports, arbitrary utility values and hardcoded product colors in React source.
Astryx Doctor also flags `className` usage conservatively; the remaining utilities
use its documented Tailwind token bridge. These are reviewed hints, not an
additional visual system.

Verified: TypeScript/build, UI guard, layout unit tests, Go tests, and all four
Playwright flows. Browser coverage includes 390/430/768/1280/1600 widths in light
and dark, setup/login, both shells, four strategy views, controls and receipts,
layout persistence and keyboard resizing, Sandbox, notifications and settings.
It also checks that installed theme colors cannot alter administration.

The original user-authored QuantBot favicon artwork is retained in BrandIcon and
rendered through Astryx Icon. Required-field markers are omitted from the UI;
server validation remains authoritative. Administrator passwords accept 8–256
bytes. Notification channels use their provider label without a custom name
field. Sandbox command validation starts automatically once a null-input action
and its available state are registered, with one idempotent probe per run.
