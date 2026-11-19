# QuantBot interface

The monitoring workspace and administration use shadcn/ui with Tailwind CSS 4. The official preset `b5nglgBLHc` supplies Base Lyra components, Neutral light and dark tokens, Neutral chart colors, Remix Icon, Outfit and Oxanium. The preset was generated with the official CLI and `--pointer`. QuantBot uses the generated components and theme with its existing React/Vite entry and embedded Go deployment.

Recharts renders equity curves, metrics and OHLC candles through the official shadcn Chart components. Axes use numeric coordinates. Values in chart tooltips and readouts retain the reported decimal text. Candles use the reported open, high, low and close. The range control supports pointer and keyboard operation.

Classical is the default workspace. The separately installable Lyra package replaces the monitoring home inside an isolated iframe. The host owns the navigation, administration and command confirmation. See [Theme development](THEME_DEVELOPMENT.md) for the bridge contract and ZIP build.

Registry components and theme definitions come from [shadcn/ui](https://ui.shadcn.com/docs) under MIT. QuantBot supplies its routes, data integration, layout and monitoring interactions. Base UI and Recharts carry MIT licenses. Outfit and Oxanium use the SIL Open Font License. The bundled Lyra archive carries license notices in its `licenses` directory.
