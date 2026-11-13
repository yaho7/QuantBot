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

## Upgrades and backups

Run Docker upgrades from the original Compose directory and keep the same `./data` mounted at `/data`. It contains the administrator, strategies, settings, and history. If setup reappears, check the actual mount.

```bash
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' \
  "$(docker compose ps -q quantbot)"
```

If the deployment directory or volume changed, take a backup and point Compose to the original storage. The service reuses the only existing database in the directory. If both database filenames exist, it uses `quantbot.sqlite3`, logs a notice, and retains the other file. Before restoring, stop the service and back up both databases, WAL/SHM files, and keys.

Use SQLite online backup for a consistent copy that includes committed WAL changes. Choose a new destination path. The copy contains password hashes and encrypted credentials. To retain secret reveal after restoration, also back up the matching `.key` file, usually `quantbot.key`, in a private location.

```bash
quantbot backup ~/quantbot-backup-$(date -u +%Y%m%dT%H%M%SZ).sqlite3
systemctl --user stop quantbot
bash install.sh
systemctl --user start quantbot
```

`--ref` accepts a release tag or verified commit. For Docker, use `docker compose exec --user 10001:10001 quantbot quantbot backup /tmp/quantbot-backup.sqlite3`, then copy it out with `docker compose cp quantbot:/tmp/quantbot-backup.sqlite3 ./quantbot-backup.sqlite3`. Upgrade with `docker compose pull && docker compose up -d`. Verify health, login, reconnection, and actual control reconciliation.

Stop QuantBot before restoring. Keep the existing database and WAL/SHM files elsewhere, copy a verified backup to `quantbot.sqlite3`, and verify the service user can read and write it. Claimed commands without receipts become unknown after restart. Reconcile real trades against broker records.
