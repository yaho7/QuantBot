# QuantBot

QuantBot is an HTTP monitoring and remote-control console for independently deployed trading strategies. Agents declare metrics, states, parameters, actions, resources and events, then report observations through the unversioned `/api/agent/` namespace. QuantBot resolves widgets from those declarations and uses one-time execution permits for commands.

Use **Workbench** to see strategy data and controls. In **Administration → Integration**, copy the Agent URL or the [AI integration prompt](docs/INTEGRATION.md#ai-integration-prompt).

## Docker Compose

Save [compose.yml](compose.yml) and start the single container. Docker Compose keeps both databases in `./data`. The image prepares the data directory and uses the loopback port automatically.

```bash
docker compose up -d
```

Open [http://localhost:8888](http://localhost:8888) or your HTTPS endpoint and create the administrator account. Setup closes after the first administrator is created. See [Deployment and upgrades](docs/DEPLOYMENT.md).

## Local setup

Run the Go server with a local data directory.

```bash
go run ./cmd/quantbot serve
```

Open the [local console](http://127.0.0.1:23456/) and create an administrator. Create a dedicated paper strategy to try the [Python, JavaScript, Go and curl examples](docs/INTEGRATION.md#try-the-protocol-on-a-paper-strategy).

## Documentation

- [Agent protocol and request lifecycle](docs/AGENT_PROTOCOL.md)
- [Integration guide](docs/INTEGRATION.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Agent OpenAPI 3.1](docs/openapi.json) · [JSON Schema](internal/server/schemas/agent.json)
- [Telegram, Feishu, WeCom and DingTalk notifications](docs/NOTIFICATIONS.md)
- [Docker, Linux, HTTPS, backups, and upgrades](docs/DEPLOYMENT.md)
- [Architecture and safety boundaries](docs/ARCHITECTURE.md) · [Console localization](web/LOCALIZATION.md)

For Mac/VPS resource monitoring and planning how many similar instances can run, see [host performance and capacity](docs/HOST_PERFORMANCE.md).

The running service publishes JSON Schema at `/api/agent/schemas/agent.json` and `/api/agent/schemas/report.json`.

## Development checks

```bash
go test -race ./...
go vet ./...

cd web
npm ci
npm run build
npm run test:unit
npx playwright install chromium
npm run test:e2e
```

Browser tests start isolated HTTP services with temporary databases. Trading tests use simulated executors.
