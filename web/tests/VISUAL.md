# QuantBot 3.0 browser verification

Build the React assets and provide Go 1.26 on PATH, then run `npm run test:e2e` from `web`. Install Chromium using `npx playwright install chromium`, or use an installed Chrome with `QB_BROWSER_CHANNEL=chrome npm run test:e2e`.

The suite starts an isolated native Go service and drives administrator setup, strategy creation, an HTTP Agent, reports, dynamic control confirmation, one execution grant, the receipt, and independently reported actual state. Screenshot outputs cover home, strategy detail, system dashboard and audit at 390, 430, 768, 1280 and 1600 pixels in light and dark. Detail screenshots wait for the chart canvas to render. The suite checks JavaScript errors and document-level horizontal overflow.

Layout editing, theme administration, Sandbox and notification flows require their feature-level browser checks as those features land. Screenshots are written under `web/test-results` and are ignored by Git.
