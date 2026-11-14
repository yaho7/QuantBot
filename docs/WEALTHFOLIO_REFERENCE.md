# Wealthfolio layout reference

Reference repository: https://github.com/afadil/wealthfolio
Pinned commit: 560e803f64ed0d4fa6e4c2ea786e5ce789e40b45
Inspected on: 2026-11-15

The upstream repository declares AGPL-3.0 in LICENSE. QuantBot retains its
existing license. This adaptation independently implements the observed layout
rules; it does not vendor upstream components, source code, icons, or assets.

Source files inspected:
- apps/frontend/src/pages/layouts/app-layout.tsx: application shell and mobile navigation.
- apps/frontend/src/pages/layouts/navigation/app-sidebar.tsx: compact navigation rail.
- apps/frontend/src/pages/dashboard/dashboard-content.tsx: balance, 280px chart,
  centered period controls, content-width breakpoint at 53rem, two-column grid
  with a 24rem minimum right column and 5rem column gap.
- apps/frontend/src/pages/dashboard/accounts-summary.tsx: two-line summary rows,
  name and description on the left, amount and secondary metric on the right.
- apps/frontend/src/pages/dashboard/top-holdings.tsx: holdings section and filters.
- apps/frontend/src/components/history-chart.tsx: chart presentation.

QuantBot mapping: portfolio scope becomes selected strategy; account summary rows
become strategy rows; holdings remain reported positions; trading controls use
the existing trusted command flow. Currency values are not combined across
strategies. Missing data is displayed as unavailable. Saved widget layouts remain
independent of this default dashboard presentation.

Implementation: web/src/styles/wealthfolio.css, web/src/app/home.tsx,
web/src/app/App.tsx, web/src/components/chart.tsx.
