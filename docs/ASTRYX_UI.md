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
