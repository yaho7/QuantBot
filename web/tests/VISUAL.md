# Console visual checks

The layout project seeds a paper strategy in its own temporary QuantBot
database. It checks the navigation breakpoint, page width, toolbar alignment,
widget sizing, read-only editing, and command-detail access at narrow widths.
Its report includes representative screenshots.

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
