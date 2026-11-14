# QuantBot deployment, upgrades, and backups

## Docker Compose

Save [compose.yml](../compose.yml) and start the service from the same directory.

```bash
docker compose up -d
```

Open [http://localhost:8888](http://localhost:8888) and create an administrator. The port binds to the host loopback interface and the database lives in `./data` next to the Compose file. The image configures permissions for this directory and database files before running as UID/GID 10001. Use a dedicated data directory.

If Docker runs on another machine, forward the port from the machine running your browser.

```bash
ssh -N -L 8888:127.0.0.1:8888 user@your-server
```

For remote console or Agent access, use an HTTPS reverse proxy to `127.0.0.1:8888`. Preserve the original Host and pass `X-Forwarded-Proto`. The image trusts loopback and the detected Docker bridge gateway by default. Keep the loopback binding. Set `QB_PUBLIC_URL` for Telegram login links and public hostname validation.

An existing administrator sees the login screen. For unattended deployments, seed the account with `QB_ADMIN_USERNAME` and `QB_ADMIN_PASSWORD_FILE`. Configure the bot token in the console or supply `QB_TELEGRAM_TOKEN_FILE`.

### Cloudflare Tunnel

If `cloudflared` runs on the Docker host, route the public hostname to `http://127.0.0.1:8888` and browse to `https://quantbot.example.com`. Preserve the original Host. Cloudflare forwards the visitor protocol in `X-Forwarded-Proto`. [Origin protocols](https://developers.cloudflare.com/tunnel/concepts/routing/#supported-protocols) · [Cloudflare headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/#x-forwarded-proto)

If the HTTPS hostname returns `HTTPS is required for remote connections`, verify `X-Forwarded-Proto: https` reaches the origin. If the bridge gateway was not detected, inspect it and configure it explicitly.

```bash
docker inspect --format '{{range .NetworkSettings.Networks}}{{println .Gateway}}{{end}}' \
  "$(docker compose ps -q quantbot)"
```

Create `compose.override.yaml` with the real hostname and proxy address. Replace the example gateway `172.18.0.1` with the address from the previous step.

```yaml
services:
  quantbot:
    environment:
      QB_PUBLIC_URL: "https://quantbot.example.com"
      QB_TRUST_PROXY: "172.18.0.1"
```

```bash
docker compose -f compose.yml -f compose.override.yaml up -d
curl -fsS https://quantbot.example.com/healthz
```

If `cloudflared` and QuantBot share a Docker network, use `http://quantbot:8888` as the origin and set `QB_TRUST_PROXY` to the fixed container IP for `cloudflared`. Explicit settings replace the default trust list. Trust only the actual proxy and retain loopback binding.

The first successful setup creates the administrator and closes setup. If needed, initialize on loopback or seed the account before exposing the HTTPS hostname.

## Linux user service

Install from a checkout or use the installer with a specific version.

```bash
uv tool install .
quantbot admin
mkdir -p ~/.config/systemd/user ~/.config/quantbot
install -m 0644 deploy/quantbot.service ~/.config/systemd/user/quantbot.service
systemctl --user daemon-reload
systemctl --user enable --now quantbot
systemctl --user status quantbot
journalctl --user -u quantbot
```

The service unit defaults to `~/.local/bin/quantbot`. Check `uv tool dir --bin` and adjust `ExecStart` as needed. Enable systemd lingering for the service account if it must continue after logout. [Service unit](../deploy/quantbot.service)

Write configuration to `~/.config/quantbot/service.env`. The default bind address is `127.0.0.1:23456` and the default data directory is `~/.local/share/quantbot`. Use loopback access or SSH forwarding.

```dotenv
QB_HOST=127.0.0.1
QB_PORT=23456
QB_PUBLIC_URL=https://quantbot.example.com
QB_TRUST_PROXY=127.0.0.1,::1
```

Terminate TLS at the proxy, forward the original `Host` and `X-Forwarded-Proto`, and trust only the actual proxy addresses. Allow at least 25 seconds for long polling and disable proxy buffering for SSE. See the [Caddy example](../deploy/Caddyfile). Remote HTTP is rejected.

Common settings include `QB_DATA_DIR`, `QB_HOST`, `QB_PORT`, `QB_PUBLIC_URL`, `QB_TRUST_PROXY`, `QB_ADMIN_USERNAME`, `QB_ADMIN_PASSWORD_FILE`, and `QB_TELEGRAM_TOKEN_FILE`. Check `/healthz` for health and System settings for the version and database schema.

## Go data backup and restore

Stop QuantBot before making a backup so both databases and installed theme files represent the same service state. The ZIP includes `control.db`, `metrics.db`, the encryption key, and installed theme files. Store it privately. QuantBot writes the archive atomically and requires a new archive name.

```bash
QB_DATA_DIR=/path/to/data quantbot backup /path/to/backup.zip
QB_DATA_DIR=/path/to/restored-data quantbot restore /path/to/backup.zip
QB_DATA_DIR=/path/to/restored-data quantbot doctor
```

Restore requires a new destination directory. It checks SQLite integrity and the encryption key before publishing the restored data. It expires queued commands, marks interrupted executions unknown and revokes restored Agent credentials and sessions. Sign in again, reconcile unknown commands, and issue fresh Agent credentials before assigning executors.

Run `quantbot doctor` with the service configuration to inspect directory permissions, database integrity, WAL mode, the encryption key, the configured theme and local readiness. Configuration or storage errors produce a nonzero exit code. Use `quantbot health` for a readiness probe.
