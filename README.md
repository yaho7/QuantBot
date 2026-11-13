# QuantBot

QuantBot is an HTTP monitoring and remote-control console for independently deployed trading strategies. The strategy connects outbound, reports standard data, and claims commands using its existing HTTP client. The integration starts with the strategy. Web and Telegram share strategy identity, trading permissions, command state, and receipts.

- Strategy identity, scoped credentials, rotation, revocation, and connection diagnostics.
- Fourteen standard report types with persistent history, ECharts, candlesticks, and trade and risk markers.
- Agent-defined buttons, switches, selections, number inputs, sliders, text fields, forms, and read-only controls.
- Entry-permission reconciliation, one authorized executor, high-risk confirmation, one-time permits, and an audit trail.
- Strategies continue handling market data, positions, and local risk controls. QuantBot requests pause or resume through desired state.


Use **Workbench** to view strategy status and controls. Under **Strategies → Token and diagnostics**, copy the [AI integration prompt](docs/INTEGRATION.md#one-click-ai-integration-test) for Codex or Cursor. After Sandbox verification, replace the endpoint and secret with production credentials.

## Docker Compose

Save the following as `compose.yml`. Compose pulls the image from GitHub Packages and stores data in `./data` next to the configuration.

```yaml
services:
  quantbot:
    image: ghcr.io/yaho7/quantbot:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8888:8888"
    volumes:
      - ./data:/data
```

```bash
docker compose up -d
```

Open [http://localhost:8888](http://localhost:8888) or your HTTPS endpoint and create the administrator account. Setup closes after the first administrator is created. See [Deployment and upgrades](docs/DEPLOYMENT.md).

## Local setup

Requires Python 3.11+ and SQLite 3.35+. The repository includes the built React console.

```bash
uv sync --frozen
uv run quantbot serve
```

Open the [local console](http://127.0.0.1:23456/ui/) and create an administrator. **Add strategy** creates a strategy and a credential with all four scopes. Use the AI integration prompt for a Sandbox setup, or reveal the secret and place it in the strategy configuration or the example's `QB_TOKEN`.

For a remote-control trial, use a paper strategy's secret with the full example.

```bash
export QB_ENDPOINT=http://127.0.0.1:23456/api/agent
read -rs QB_TOKEN
export QB_TOKEN
python3 examples/http_agent.py --control --follow
```

The console shows the connected agent, simulated metrics, and registered controls. Try changing the RSI period and compare the receipt with the separately reported actual value. The example uses a local SQLite file for applied permissions, receipts, and telemetry awaiting replay. [Full HTTP example](examples/http_agent.py)

## Documentation

- [HTTP protocol, curl quickstart, reports, controls, and commands](PROTOCOL.md)
- [Integration guide](docs/INTEGRATION.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)
- [OpenAPI 3.1](docs/openapi.json) · [JSON Schema](docs/schemas)
- [Telegram setup, commands, and notifications](docs/TELEGRAM.md)
- [Docker, Linux, HTTPS, backups, and upgrades](docs/DEPLOYMENT.md)
- [Architecture and safety boundaries](DESIGN.md) · [Console localization](web/LOCALIZATION.md)

The running service also exposes `/docs`, `/openapi.json`, `/api/data-types`, and `/api/schemas/{type}`.

## Development checks

```bash
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run python scripts/export_api.py --check
uv build

cd web
npm ci
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser tests start isolated HTTP services with temporary databases. Trading tests use simulated executors.
