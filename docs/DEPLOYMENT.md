# QuantBot 部署、升级与备份

## Docker Compose

保存仓库的 [compose.yml](../compose.yml)，在同一目录启动：

```bash
docker compose up -d
```

打开 [http://localhost:8888](http://localhost:8888)，按网页引导创建管理员。端口绑定在宿主机回环地址，数据库保存在 Compose 文件旁的 `./data` 目录。镜像启动时会为该目录和 QuantBot 数据库文件设置权限，然后以 UID/GID 10001 运行服务。请使用专用的数据目录。

如果原部署使用 Docker 命名卷，先按下文备份，再停止旧容器。将备份复制到新部署的 `./data/quantbot-v2.sqlite3` 后启动。旧卷可以保留到验证完成。如果旧容器因权限问题无法启动，可停止旧容器后从命名卷复制数据库及其存在的 `-wal`、`-shm` 和 `-journal` 文件，再启动新容器。

如果 Docker 运行在另一台机器，在浏览器所在机器执行下列命令，再访问本机 8888 端口。

```bash
ssh -N -L 8888:127.0.0.1:8888 user@your-server
```

远程开放控制台或策略 API 时，在宿主机使用 HTTPS 反向代理转发至 `127.0.0.1:8888`，保留原始 Host 并传递 `X-Forwarded-Proto`。镜像默认信任本机和检测到的 Docker 网桥网关。请保留 Compose 的回环端口绑定。可用 `QB_PUBLIC_URL` 指定外部地址，用于 Telegram 登录链接和限制公开域名。

已有管理员时会进入登录页。自动部署可以用 `QB_ADMIN_USERNAME` 和 `QB_ADMIN_PASSWORD_FILE` 预置管理员。Bot Token 可以在 Web 设置，也可以用 `QB_TELEGRAM_TOKEN_FILE` 提供。

### Cloudflare Tunnel

如果 `cloudflared` 在 Docker 宿主机上运行，在 Cloudflare 的公开主机名路由中将 Service URL 设为 `http://127.0.0.1:8888`，浏览器使用 `https://quantbot.example.com`。保留原始 Host。Cloudflare 会通过 `X-Forwarded-Proto` 传递访客使用的协议。[Cloudflare 回源协议](https://developers.cloudflare.com/tunnel/concepts/routing/#supported-protocols) · [Cloudflare 请求头](https://developers.cloudflare.com/fundamentals/reference/http-headers/#x-forwarded-proto)

如果 HTTPS 域名返回 `HTTPS is required for remote connections`，先确认回源传递了 `X-Forwarded-Proto: https`。如果网桥网关未自动检测到，可在部署目录查看地址并显式信任：

```bash
docker inspect --format '{{range .NetworkSettings.Networks}}{{println .Gateway}}{{end}}' \
  "$(docker compose ps -q quantbot)"
```

在部署目录新建 `compose.override.yaml`，填入实际域名和代理地址。下面的 `172.18.0.1` 是示例，请换成上一步查到的地址。

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

如果 `cloudflared` 也是容器，且与 QuantBot 直连同一个 Docker 网络，回源使用 `http://quantbot:8888`，`QB_TRUST_PROXY` 填 `cloudflared` 在该网络上的固定容器 IP。显式设置会覆盖默认代理地址。只信任实际代理的地址，并保留 QuantBot 的回环端口绑定。

打开 HTTPS 域名即可创建管理员。第一个成功提交的人将成为管理员，创建后初始化入口关闭。需要在公开域名前创建账号时，可先在本机初始化，或用上文的方式预置账号。

## Linux 用户服务

从克隆的仓库安装，或使用仓库安装脚本安装指定版本。

```bash
uv tool install .
quantbot admin
mkdir -p ~/.config/systemd/user ~/.config/quantbot-v2
install -m 0644 deploy/quantbot.service ~/.config/systemd/user/quantbot.service
systemctl --user daemon-reload
systemctl --user enable --now quantbot
systemctl --user status quantbot
journalctl --user -u quantbot
```

服务单元默认使用 `~/.local/bin/quantbot`。通过 `uv tool dir --bin` 检查实际目录并在需要时调整 `ExecStart`。若希望 SSH 退出后用户服务继续运行，可以为服务账户启用 systemd linger。 [服务单元](../deploy/quantbot.service)

将部署配置写入 `~/.config/quantbot-v2/service.env`。默认监听 `127.0.0.1:23456`，数据位于 `~/.local/share/quantbot`。本地访问使用浏览器回环地址或 SSH 端口转发。

```dotenv
QB_HOST=127.0.0.1
QB_PORT=23456
QB_PUBLIC_URL=https://quantbot.example.com
QB_TRUST_PROXY=127.0.0.1,::1
```

在反向代理上终止 TLS，转发原始 `Host` 和 `X-Forwarded-Proto`，仅信任实际代理的 IP 或网段。代理的读超时至少覆盖 25 秒长轮询，SSE 路径关闭代理缓冲。Caddy 示例可参考 [deploy/Caddyfile](../deploy/Caddyfile)。HTTP 远程请求会被拒绝。

常用变量包括 `QB_DATA_DIR`、`QB_HOST`、`QB_PORT`、`QB_PUBLIC_URL`、`QB_TRUST_PROXY`、`QB_ADMIN_USERNAME`、`QB_ADMIN_PASSWORD_FILE` 和 `QB_TELEGRAM_TOKEN_FILE`。服务通过 `/healthz` 检查，系统设置页面显示版本和数据库 Schema。

## 更新与备份

使用 SQLite 在线备份获取包含已提交 WAL 的一致副本。备份文件必须是新的路径，包含管理员密码哈希和运行所需的凭据配置。将其保存到只有运维人员可访问的位置。

```bash
quantbot backup ~/quantbot-backup-$(date -u +%Y%m%dT%H%M%SZ).sqlite3
systemctl --user stop quantbot
bash install.sh --ref v2.0.5
systemctl --user start quantbot
```

`--ref` 接受已发布的版本或已验证的提交。Docker 部署用 `docker compose exec --user 10001:10001 quantbot quantbot backup /tmp/quantbot-backup.sqlite3` 创建备份，再用 `docker compose cp quantbot:/tmp/quantbot-backup.sqlite3 ./quantbot-backup.sqlite3` 将备份拷到宿主机的私有目录。执行 `docker compose pull && docker compose up -d` 获取并应用最新镜像。升级后检查健康接口、Web 登录、策略重新接入与实际控制对账。

恢复备份时先停止 QuantBot 服务。将现有数据库与 WAL/SHM 文件移至另一处保留，再复制已验证的备份到数据目录的 `quantbot-v2.sqlite3`，核对服务用户可读写。重启后已授予许可但缺少回执的命令按未知结果处理。涉及真实交易的操作按券商实际记录核对。
