# QuantBot

一个 Telegram bot，管理你所有的量化程序。

每个程序用自己的券商、策略、框架和环境（uv、conda、venv 都行）。QuantBot 不管这些，它只做四件事：列出程序、转发按钮、显示程序报上来的状态、推送程序发来的消息。

```text
Telegram ⇄ QuantBot（装在 VPS 上，后台运行）
              ▲  http://127.0.0.1:8080，只有本机能连
   ┌──────────┴──────────┐
策略 A（uv）          策略 B（conda）
```

策略去找 QuantBot，不用自己开端口。QuantBot 重启或崩溃时，策略照常交易。

## 安装

在 VPS 上运行：

```bash
curl -fsSL https://raw.githubusercontent.com/yaho7/QuantBot/main/install.sh | bash
```

它会：

1. 装好缺的依赖：git、curl、[uv](https://docs.astral.sh/uv/)，以及 QuantBot 用的 Python 3.12。不会动你的系统 Python 和策略环境。
2. 装好 `quantbot` 命令。
3. 第一次运行时问你几个问题：
   - Bot token：先在 [@BotFather](https://t.me/BotFather) 发 `/newbot` 创建。
   - 你的账号：给 bot 发一条消息，它自己认出你。
   - 静音时段、时区、心跳地址，都可以跳过。
4. 让 QuantBot 在后台运行，开机自启。Linux 用 systemd，macOS 用 launchd。

装好后，在 Telegram 里发 `/menu`。

更新：再运行一次安装命令，或者运行 `quantbot update`。

## 连接你的策略

在策略项目的文件夹里运行：

```bash
cd ~/momentum
quantbot link
```

它会一步步问你：

1. 策略叫什么。默认用文件夹名。
2. 客户端怎么加进项目：
   - uv 项目：`uv add` 加成依赖，写进 `uv.lock`。
   - 有 `requirements.txt`：写进去。
   - 都没有：复制一个 `quantbot_client.py` 进来。
3. 代码里要加的几行：

```python
from quantbot_client import QuantBot

qb = QuantBot("momentum")              # 不用填 token，自己找到本机的 QuantBot
qb.on("positions", my_positions_text)  # 想在 Telegram 里有哪个按钮，就接哪个
qb.on("flatten", flatten_my_positions) # 只平能确认是自己的仓位

with qb:                               # 出错会推送报错，再抛出
    while not qb.stopping:
        trade_once(allow_new=qb.can_open())  # 暂停时 can_open() 是 False
        qb.status(f"净值 {equity:.2f}")
        if not qb.sleep(60):           # 等的时候也在响应按钮
            break
```

然后照你平时的方式运行，比如 `uv run main.py` 或 `conda run -n momentum python main.py`。不用设环境变量。

第一次连上时，策略会自己出现在 Telegram 的列表里。

| 方法 | 用途 |
|---|---|
| `qb.on(name, fn)` | 处理一个命令，在调用 `sleep()` 的线程里执行 |
| `qb.sleep(秒)` | 代替 `time.sleep`，停止时返回 `False` |
| `qb.can_open()` | 下开仓单前检查 |
| `qb.status(text)` | 状态快照 |
| `qb.fill()` `qb.info()` `qb.alert()` `qb.error()` | 推送 |
| `qb.summary(text, png)` | 每日总结，可带图 |
| `qb.risk_triggered(reason)` | 暂停开仓并推送原因 |
| `qb.connection(name, ok)` | 连接状态，变化时才推送 |
| `qb.expiry(name, when)` | 授权到期时间，到期前 48 和 12 小时提醒 |

`pause`、`resume`、`stop` 不写也能用。完整例子见 `/examples/demo.py`。

策略在别的机器上、或用别的语言写：设 `QB_URL` 和 `QB_TOKEN`（`quantbot token <id>` 查看），协议见 `/PROTOCOL.md`。

## Telegram 里能做什么

| 功能 | 怎么用 |
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

程序只实现想要的功能，没实现的按钮不显示。确认按钮 30 秒内有效，只能用一次。

## 命令

| 命令 | 作用 |
|---|---|
| `quantbot setup` | 改 Telegram 设置 |
| `quantbot link [文件夹]` | 连接一个策略项目 |
| `quantbot list` | 列出策略 |
| `quantbot rename <id> <名字>` | 改显示名称 |
| `quantbot remove <id>` | 删除策略 |
| `quantbot token <id> [--new]` | 看或换 token |
| `quantbot service install/uninstall/restart/status` | 后台服务 |
| `quantbot logs -f` | 看日志 |
| `quantbot update` | 更新 |

设置和操作记录存在 `~/.config/quantbot/`。

## 安全

- 只有 `setup` 里认出的账号能用命令和按钮。
- 每个策略一个 token，不能冒充别的策略。
- `~/.config/quantbot/quantbot.json` 里有 bot token 和策略 token，只有你自己的账号能读。
- QuantBot 默认只监听 `127.0.0.1`，外网连不进来。要让别的机器连，用 `quantbot service install --listen 0.0.0.0:8080`，并走 Tailscale 或 HTTPS。
- QuantBot 不连券商，不启停你的策略。实盘策略崩了不要自动重启，先在券商端核对订单和持仓。
- QuantBot 自己挂了怎么办：在 `setup` 里填心跳地址，由 [Healthchecks.io](https://healthchecks.io) 报警。

## 开发

```bash
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
```

设计见 `/DESIGN.md`。
