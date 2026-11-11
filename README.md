# QuantBot

一个控制台，管理你所有的量化程序：网页一定有，Telegram 可选。

每个程序用自己的券商、策略、框架和环境（uv、conda、venv 都行）。QuantBot 不管这些，它只做四件事：列出程序、转发按钮、显示程序报上来的状态、推送程序发来的消息。

```text
网页 ──┐
       ├─▶ QuantBot（装在 VPS 上，后台运行）
Telegram（可选）┘    ▲  http://127.0.0.1:<随机端口>，只有本机能连
              ┌──────┴──────┐
         策略 A（uv）   策略 B（conda）
```

策略去找 QuantBot，不用自己开端口。QuantBot 重启或崩溃时，策略照常交易。

## 安装

在 VPS 上运行：

```bash
curl -fsSL https://raw.githubusercontent.com/yaho7/QuantBot/main/install.sh | bash
```

它先装好缺的依赖：git、curl、[uv](https://docs.astral.sh/uv/)，以及 QuantBot 用的 Python 3.12。不会动你的系统 Python 和策略环境。

然后一步步问你：

| 步骤 | 问什么 | 直接回车 |
|---|---|---|
| 1 | 端口：网页和策略都通过它连 QuantBot | 用随机选好的空闲端口（20000 到 39999） |
| 2 | 要不要接 Telegram。要的话再问：bot token（先在 [@BotFather](https://t.me/BotFather) 发 `/newbot`）、你的账号（给 bot 发条消息就能认出）、静音时段和时区 | 不接 |
| 3 | 心跳地址（Healthchecks.io） | 不设 |
| 4 | 要不要在后台运行：开机自启，挂了自动重启 | 要 |

最后列出你的选择，确认后才保存，并打印一个网页登录链接。接了 Telegram 的话，还会给你发一条测试消息。

不接 Telegram 也能用全部功能。以后想接，在网页的“设置”里填，或者再运行 `quantbot setup`。

## 网页

登录链接这样拿，都是 5 分钟内有效、只能用一次：

```bash
quantbot web          # 在服务器上
```

或者在 Telegram 里给 bot 发 `/web`。

QuantBot 只在服务器本机监听，所以先在你自己的电脑上连一条隧道，再打开链接：

```bash
ssh -L <端口>:127.0.0.1:<端口> 你的服务器
```

| 网页上 | 能做什么 |
|---|---|
| 策略卡片 | 在线状态、状态快照、暂停开仓、恢复开仓 |
| 更多操作 | 刷新状态、持仓、挂单和撤单、净值图、改参数、手动下单、平仓、停止程序 |
| 全部暂停开仓 | 所有在线策略一起暂停 |
| 推送 | QuantBot 这次启动后的所有推送 |
| 操作记录 | 网页和 Telegram 上点过的每个按钮 |
| 设置 | 接上、换掉或断开 Telegram，静音时段、时区、心跳地址 |

平仓、撤单、改参数、下单、停止都要再确认一次。登录后 12 小时有效。

想改设置，运行 `quantbot setup`，会用现在的值当默认。

更新：再运行一次安装命令，它不会再问问题，只更新并重启后台服务。也可以运行 `quantbot update`。

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

## Telegram 里能做什么（接了的话）

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
| `quantbot service install/uninstall/restart/status` | 后台服务；`install --port` 换端口 |
| `quantbot logs -f` | 看日志 |
| `quantbot web` | 打印网页登录链接 |
| `quantbot update` | 更新 |

设置和操作记录存在 `~/.config/quantbot/`。

## 安全

- 网页没有密码，靠一次性登录链接：5 分钟内有效，只能用一次，登录后 12 小时有效。能拿到链接的人，就能平仓和下单，所以别把链接转给别人。
- 网页的按钮请求要带一个专门的请求头，别的网站发不出来。
- Telegram 只认 `setup` 里认出的账号。
- 每个策略一个 token，不能冒充别的策略。
- `~/.config/quantbot/quantbot.json` 里有 bot token、策略 token 和网页的签名密钥，只有你自己的账号能读。删掉里面的 `web_secret`，所有网页登录都会失效。
- QuantBot 只监听 `127.0.0.1`，外网连不进来。要让别的机器连，用 `quantbot service install --listen 0.0.0.0:<端口>`，并走 Tailscale 或 HTTPS。
- QuantBot 不连券商，不启停你的策略。实盘策略崩了不要自动重启，先在券商端核对订单和持仓。
- QuantBot 自己挂了怎么办：在 `setup` 里填心跳地址，由 [Healthchecks.io](https://healthchecks.io) 报警。

## 开发

```bash
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
```

设计见 `/DESIGN.md`。
