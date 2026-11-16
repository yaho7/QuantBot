# QuantBot deployment, upgrades, and backups

## Docker Compose

Save [compose.yml](../compose.yml) and run `docker compose up -d`. Open
[http://127.0.0.1:8888](http://127.0.0.1:8888) to initialize the administrator.
Both databases are kept in `./data` beside the Compose file. The image sets
the listening port and data path and initializes the mounted directory with
private permissions. The
QuantBot process runs as UID/GID 10001. Keep the published port on the host
loopback interface.

If a previous Compose file uses a named volume, switching to `./data` will not
copy that volume. Back up the old volume using the old Compose file, then
restore the backup into a separate directory before switching. An existing bind
mount must contain files writable by UID/GID 10001; startup only prepares the
mount point itself.

QuantBot accepts HTTP and HTTPS without a configured hostname. The example Compose file binds to loopback. For LAN access, bind the published port to the host's LAN IP. For HTTPS, direct your reverse proxy to `http://127.0.0.1:8888` on the Docker host or `http://quantbot:8888` on a shared Docker network.

Preserve the request's `Host` and set `X-Forwarded-Proto` to the external scheme so QuantBot can generate the API URL and set browser cookies correctly. Allow at least 25 seconds for command polling and disable proxy buffering for SSE.

To use proxy-reported client IPs for login rate limiting, optionally set `QB_TRUSTED_PROXIES` to the direct proxy's address as a CIDR:

```yaml
services:
  quantbot:
    environment:
      QB_TRUSTED_PROXIES: "172.18.0.1/32"
```

Use the bridge gateway reported by `docker inspect` for a proxy connecting through the Docker host's published port, or a fixed proxy container address on a shared network. See the [Caddy configuration](../deploy/Caddyfile).

## Native Linux

Run `bash install.sh --ref v3.1.4` to install the Linux amd64 or arm64 release into `~/.local/bin`. The installer verifies the published SHA-256 checksum and binary version before replacing the executable.

```bash
mkdir -p ~/.config/systemd/user ~/.config/quantbot ~/.local/share/quantbot
install -m 0644 deploy/quantbot.service ~/.config/systemd/user/quantbot.service
printf 'QB_DATA_DIR=%s\n' "$HOME/.local/share/quantbot" > ~/.config/quantbot/service.env
systemctl --user daemon-reload
systemctl --user enable --now quantbot
```

The default native listener is `127.0.0.1:23456`. Set `QB_LISTEN` to change the bind address. Other settings include `QB_AGENT_SESSION_TTL`, `QB_COMMAND_POLL`, `QB_METRICS_QUEUE`, `QB_METRICS_BATCH` and `QB_METRICS_FLUSH`.

For performance diagnosis, set `QB_ENABLE_PPROF=true` and request a Go profile such as `/api/admin/pprof/heap` or `/api/admin/pprof/profile?seconds=10` with an administrator session. Profiles are disabled by default.

Upgrade the container with `docker compose pull && docker compose up -d`. Retain the existing 3.x data directory. Start with fresh data when moving from the Python edition to 3.x.

## Go data backup and restore

Stop QuantBot before making a backup so both databases and installed theme files represent the same service state. The ZIP includes `control.db`, `metrics.db`, the encryption key, and installed theme files. Store it privately. QuantBot writes the archive atomically and requires a new archive name.

```bash
QB_DATA_DIR=/path/to/data quantbot backup /path/to/backup.zip
QB_DATA_DIR=/path/to/restored-data quantbot restore /path/to/backup.zip
QB_DATA_DIR=/path/to/restored-data quantbot doctor
```

Restore requires a new destination directory. It checks SQLite integrity and the encryption key before publishing the restored data. It expires queued commands, marks interrupted executions unknown and revokes restored Agent credentials and sessions. Sign in again, reconcile unknown commands, and issue fresh Agent credentials before assigning executors.

Run `quantbot doctor` with the service configuration to inspect directory permissions, database integrity, WAL mode, the encryption key, the configured theme and local readiness. Configuration or storage errors produce a nonzero exit code. Use `quantbot health` for a readiness probe.

With Compose, stop the service and use a one-off container for the archive:

```bash
docker compose stop quantbot
docker compose run --rm --no-deps quantbot backup /data/backup.zip
docker compose run --rm --no-deps -e QB_DATA_DIR=/data/restored quantbot restore /data/backup.zip
```

The example verifies recovery in a new subdirectory. To run on the restored data, set `QB_DATA_DIR=/data/restored` in a Compose override before restarting.
