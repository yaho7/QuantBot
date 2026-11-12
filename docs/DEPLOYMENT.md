# QuantBot 部署、升级与备份

## Docker Compose

准备能解析到服务器的域名，并开放 TCP 80 与 443 给 Caddy。配置文件只暴露 Caddy 端口。QuantBot 仅信任 Compose 网络中 Caddy 的固定地址。

```bash
export QB_DOMAIN=quantbot.example.com
docker compose build
docker compose run --rm -it quantbot admin
docker compose up -d
docker compose ps
```

访问配置的 HTTPS 域名。数据存放在 `quantbot-data` 卷。服务容器以 UID/GID 10001 运行。使用宿主目录挂载数据时，授予这个 UID 写权限。如果 Compose 网络地址与本机网络冲突，同时修改子网、Caddy 地址及 `QB_TRUST_PROXY`。 [Compose 配置](../compose.yml)

初始化也可以设置 `QB_ADMIN_USERNAME` 和 `QB_ADMIN_PASSWORD_FILE`，后者指向容器可读的私有挂载文件。首次启动会初始化 v2 数据库。已有管理员时会使用数据库中的账户。Bot Token 可以在 Web 设置，或通过 `QB_TELEGRAM_TOKEN_FILE` 提供。

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

在反向代理上终止 TLS，转发原始 `Host` 和 `X-Forwarded-Proto`，仅信任实际代理的 IP 或网段。代理的读超时至少覆盖 25 秒长轮询，SSE 路径关闭代理缓冲。Caddy 的常规反向代理配置可直接使用。HTTP 远程请求会被拒绝。

常用变量包括 `QB_DATA_DIR`、`QB_HOST`、`QB_PORT`、`QB_PUBLIC_URL`、`QB_TRUST_PROXY`、`QB_ADMIN_USERNAME`、`QB_ADMIN_PASSWORD_FILE` 和 `QB_TELEGRAM_TOKEN_FILE`。服务通过 `/healthz` 检查，系统设置页面显示版本和数据库 Schema。

## 更新与备份

使用 SQLite 在线备份获取包含已提交 WAL 的一致副本。备份文件必须是新的路径，包含管理员密码哈希和运行所需的凭据配置。将其保存到只有运维人员可访问的位置。

```bash
quantbot backup ~/quantbot-backup-$(date -u +%Y%m%dT%H%M%SZ).sqlite3
systemctl --user stop quantbot
bash install.sh --ref v2.0.0
systemctl --user start quantbot
```

`--ref` 接受已发布的版本或已验证的提交。Docker 部署从服务容器执行 `quantbot backup`，再用 `docker compose cp` 将备份拷到宿主机的私有目录。构建新镜像后执行 `docker compose up -d --build`。升级后检查健康接口、Web 登录、策略重新接入与实际控制对账。

恢复备份时先停止 QuantBot 服务。将现有数据库与 WAL/SHM 文件移至另一处保留，再复制已验证的备份到数据目录的 `quantbot-v2.sqlite3`，核对服务用户可读写。重启后已授予许可但缺少回执的命令按未知结果处理。涉及真实交易的操作按券商实际记录核对。
