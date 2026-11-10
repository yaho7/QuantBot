# QuantBot

一个 Telegram bot，管理你所有的量化程序。

每个程序用自己的券商、策略和框架，比如一个用 LumiBot 接 Schwab 行情和 Alpaca 下单，另一个是普通 Python 脚本。QuantBot 不管这些，它只做四件事：列出程序、转发按钮、显示程序报上来的状态、推送程序发来的消息。

```text
Telegram ⇄ QuantBot 容器（long polling，不开公网端口）
              ▲  HTTP，只在 Docker 内网
   ┌──────────┴──────────┐
策略容器 A             策略容器 B
```

策略去找 QuantBot，不用自己开端口。QuantBot 重启或崩溃时，策略照常交易。

## 能做什么

| 功能 | Telegram 里 |
|---|---|
| 所有策略的在线状态、状态快照 | `/menu` |
| 暂停开仓、恢复开仓，或全部暂停 | 按钮，`/pause` `/resume` |
| 持仓、挂单、撤单、净值图 | 按钮，`/positions` `/orders` `/chart` |
| 平仓、停止程序 | 按钮，点两次确认 |
| 运行中改参数 | `/set rsi_len 10`，点两次确认 |
| 手动下单 | `/buy QQQ 10` `/sell QQQ 10`，点两次确认 |
| 成交、报错、风控、断线、授权到期 | 自动推送 |
| 策略离线、恢复在线 | 自动推送 |
| 静音时段 | 只有提醒和报错会响 |

程序只实现自己想要的功能，没实现的按钮不显示。确认按钮 30 秒内有效，只能用一次。每次操作都记在 `/data/audit.jsonl`。

## 部署

建一个文件夹，比如 `quantbot/`，放一个 `compose.yaml`：

```yaml
services:
  quantbot:
    image: ghcr.io/yaho7/quantbot:latest
    restart: unless-stopped
```

然后：

```bash
docker compose up -d
docker compose exec quantbot quantbot setup
```

`setup` 会一步步问你：

1. Bot token：先在 [@BotFather](https://t.me/BotFather) 发 `/newbot` 创建。
2. 你的账号：给 bot 发一条消息，它自己认出你。
3. 静音时段和时区。
4. 心跳地址，可以不填。

填完会给你发一条测试消息。在 Telegram 里发 `/menu` 就能用了。

设置存在容器的 `/data` 里，`docker compose pull && docker compose up -d` 升级时会保留。

风险：`docker compose down` 会丢掉设置和 token，要重新 `setup`。停服务用 `docker compose stop`。

## 管理策略

```bash
docker compose exec quantbot quantbot add momentum --name 动量策略   # 生成 token
docker compose exec quantbot quantbot list
docker compose exec quantbot quantbot token momentum                 # 再看一次 token
docker compose exec quantbot quantbot token momentum --new           # 换 token
docker compose exec quantbot quantbot rename momentum 动量 2
docker compose exec quantbot quantbot remove momentum
```

`add` 会打印两行，交给策略程序：

```text
QB_URL=http://quantbot:8080
QB_TOKEN=...
```

改动几秒内生效，不用重启。

想先试一试，在 QuantBot 的文件夹里运行不连券商的示例策略（`quantbot_default` 是文件夹名加 `_default`）：

```bash
docker compose exec quantbot quantbot add demo --name 示例策略
docker run --rm --network quantbot_default -e QB_URL=http://quantbot:8080 -e QB_TOKEN=<上面的 token> \
  -v "$PWD/client/quantbot_client.py:/app/quantbot_client.py:ro" \
  -v "$PWD/examples/demo.py:/app/demo.py:ro" -w /app python:3.12-slim python demo.py
```

镜像由 GitHub Actions 构建：推送到 `main` 发布 `latest`，推送 `v1.2.3` 这样的 tag 发布同名版本。

## 接入一个策略

### Python

把 `/client/quantbot_client.py` 复制到你的程序旁边。它只用标准库。

```python
from quantbot_client import QuantBot

qb = QuantBot()                                   # 读 QB_URL 和 QB_TOKEN
qb.on("positions", lambda: my_positions_text())
qb.on("flatten", flatten_my_positions)            # 只平能确认是自己的仓位

with qb:                                          # 出错会推送报错，再抛出
    while not qb.stopping:
        trade_once(allow_new=qb.can_open())       # 暂停时 can_open() 是 False
        qb.status(f"净值 {equity:.2f}")
        qb.heartbeat()                            # 可选，需要 QB_HEARTBEAT_URL
        if not qb.sleep(60):                      # 等的时候也在执行按钮命令
            break
```

| 方法 | 用途 |
|---|---|
| `qb.on(name, fn)` | 处理一个命令；在调用 `sleep()` 的线程里执行 |
| `qb.sleep(秒)` | 代替 `time.sleep`，停止时返回 `False` |
| `qb.can_open()` | 下开仓单前检查 |
| `qb.status(text)` | 状态快照 |
| `qb.fill()` `qb.info()` `qb.alert()` `qb.error()` | 推送 |
| `qb.summary(text, png)` | 每日总结，可带图 |
| `qb.risk_triggered(reason)` | 暂停开仓并推送原因 |
| `qb.connection(name, ok)` | 连接状态，变化时才推送 |
| `qb.expiry(name, when)` | 授权到期时间，到期前 48 和 12 小时提醒 |

`pause`、`resume`、`stop` 不写也能用。完整例子见 `/examples/demo.py`。

### 其他语言

会发 HTTP 请求就行，见 `/PROTOCOL.md`。

### 策略怎么连上

最简单：把策略写进同一个 `compose.yaml`。

```yaml
services:
  quantbot:
    image: ghcr.io/yaho7/quantbot:latest
    restart: unless-stopped
  momentum:
    build: ./momentum
    restart: "no"          # 实盘程序不要自动重启
    environment:
      QB_URL: http://quantbot:8080
      QB_TOKEN: ...        # quantbot add 打印的 token
```

策略在另一个 compose 项目里时，加入 QuantBot 的网络。网络名是 QuantBot 文件夹名加 `_default`，可以用 `docker network ls` 查。

```yaml
services:
  momentum:
    build: .
    restart: "no"
    environment:
      QB_URL: http://quantbot:8080
      QB_TOKEN: ...
    networks: [quantbot]

networks:
  quantbot:
    external: true
    name: quantbot_default
```

## 安全

- 只有 `setup` 里认出的账号能用命令和按钮。
- 每个策略一个 token，不能冒充别的策略。token 和 bot token 只存在容器的 `/data/quantbot.json` 里，只有容器用户能读。
- QuantBot 不连券商，不挂载 `docker.sock`，不启停容器。
- 内网 HTTP 是明文的。策略在别的机器上时，走 HTTPS 或 Tailscale。
- 实盘容器用 `restart: "no"`。重启前先在券商端核对订单和持仓。
- QuantBot 自己挂了怎么办：在 `setup` 里填心跳地址，由 [Healthchecks.io](https://healthchecks.io) 报警。

## 开发

```bash
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
```

设计见 `/DESIGN.md`。
