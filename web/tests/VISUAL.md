# Console visual checks

The layout project uses a temporary QuantBot database with paper strategy
telemetry and simulated commands. It checks nine viewport widths from 390 to
1440 CSS pixels, including both sides of the 768px navigation breakpoint. It
verifies toolbar and widget alignment, long amounts, permission action
visibility, scroll cues, keyboard dismissal and focus return. Workbench
screenshots cover desktop and mobile in English dark mode. The mobile settings
baseline covers the open language picker in Chinese light mode.

Run the layout checks with the bundled Chromium browser:

```sh
npm run build
npm run test:e2e -- --project=layout
```

The checked-in pixel baselines were captured with Chrome on macOS. To compare
against them in the same environment, run:

```sh
QB_BROWSER_CHANNEL=chrome QB_VISUAL_BASELINES=1 npm run test:e2e -- --project=layout
```

After an intentional visual change, use the same environment with
`--update-snapshots`, then inspect both images before committing them. The
geometry checks run on every platform without enabling pixel comparisons.
