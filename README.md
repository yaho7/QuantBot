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

1. 在 [@BotFather](https://t.me/BotFather) 建一个 bot，拿到 token。
2. 向 [@userinfobot](https://t.me/userinfobot) 查你的数字 id。
3. 复制配置，填上 token 和 id：

   ```bash
   cp .env.example .env
   python3 -c "import secrets; print(secrets.token_urlsafe(32))"   # 每个策略生成一个 token
   ```

4. 在 `config/strategies.yaml` 里登记每个策略。
5. 启动：

   ```bash
   docker compose up -d
   docker compose --profile demo up -d   # 可选：一个不连券商的示例策略
   ```

6. 在 Telegram 里给你的 bot 发 `/menu`。

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

### 放在另一个 compose 项目里

```yaml
services:
  momentum:
    build: .
    restart: "no"          # 实盘程序不要自动重启
    environment:
      QB_URL: http://quantbot:8080
      QB_TOKEN: ${QB_TOKEN_MOMENTUM}
    networks: [quant]

networks:
  quant:
    external: true
```

## 安全

- 只有 `TG_OWNER_ID` 能用命令和按钮。
- 每个策略一个 token，不能冒充别的策略。
- QuantBot 不连券商，不挂载 `docker.sock`，不启停容器。
- 内网 HTTP 是明文的。策略在别的机器上时，走 HTTPS 或 Tailscale。
- 实盘容器用 `restart: "no"`。重启前先在券商端核对订单和持仓。
- QuantBot 自己挂了怎么办：设 `HEARTBEAT_URL`，由 [Healthchecks.io](https://healthchecks.io) 报警。

## 开发

```bash
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
```

设计见 `/DESIGN.md`。
