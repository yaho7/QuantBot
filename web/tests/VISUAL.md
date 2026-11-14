# QuantBot 3.0 browser verification

Build the React assets and provide Go 1.26 on PATH, then run `npm run test:e2e` from `web`. Install Chromium using `npx playwright install chromium`, or use an installed Chrome with `QB_BROWSER_CHANNEL=chrome npm run test:e2e`.

The suite starts an isolated native Go service and exercises administrator setup, strategy creation, Agent reports, dynamic control confirmation, the execution grant, the receipt and separately reported actual state. It also verifies capability data and associations, layout changes and persistence, theme configuration and recovery, Sandbox controls, notification configuration, and storage and settings.

Screenshots cover the workbench, strategy detail, dashboard, audit, notifications, storage, settings, Sandbox and themes at 390, 430, 768, 1280 and 1600 pixels in light and dark. Detail screenshots wait for the chart canvas. The suite checks JavaScript errors and horizontal page overflow. Screenshots are written under `web/test-results` and are ignored by Git.
