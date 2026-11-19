# QuantBot web

This React and TypeScript frontend covers the monitoring workspace, the separate administration area, and the bundled Lyra theme. Vite builds the host and theme with Tailwind CSS 4. The Go executable embeds the resulting `dist` directory. Keep browser code client-side and route authenticated calls through the existing API client.

## Components and theme

- `components.json` describes the official shadcn/ui preset `b5nglgBLHc` (Base Lyra, Neutral, Remix Icon, Outfit and Oxanium). Enabled buttons use a pointer cursor.
- Use the generated components in `src/components/ui`, semantic Tailwind tokens, and the official registry for additions. Keep QuantBot workflows in the relevant page or feature module.
- Use `ChartContainer` and Recharts 3 for charts. Preserve decimal strings for labels, readouts and tooltips. Treat numeric conversions as chart coordinates.
- Support keyboard access, visible focus, localized control labels and layouts from phone to desktop. Preserve trading confirmation and the theme iframe boundary.

## Verification

Use the existing npm lockfile. Run `npm ci`, `npm run typecheck`, `npm run test:unit`, and `npm run build` from this directory. The build packages the isolated Lyra theme. Use `npm run test:e2e` to verify browser workflows in both color modes. The Playwright server builds Go with the embedded frontend.
