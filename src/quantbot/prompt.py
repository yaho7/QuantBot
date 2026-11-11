# ruff: noqa: E501 - the message is prose, one paragraph per line
"""The "copy for AI" message: everything an AI assistant needs to connect a program.

`quantbot prompt <id>` prints it and the web page copies it. It carries the
project links and the exact way to connect, but never a token.
"""

from __future__ import annotations

from quantbot.i18n import language

REPO = "https://github.com/yaho7/QuantBot"
RAW = "https://raw.githubusercontent.com/yaho7/QuantBot/main"
CLIENT_REQUIREMENT = f"quantbot-client @ git+{REPO}#subdirectory=client"

TEMPLATE = """\
请帮我把这个量化程序接入 QuantBot。

QuantBot 是一个远程控制台：在网页和 Telegram 上看策略状态、收推送、点按钮（暂停开仓、平仓、停止程序等）。程序用一个 Python 客户端连它。QuantBot 不管交易逻辑，也不连券商。

- 项目地址：{repo}
- 客户端源码（一个文件，只用标准库，动手前先读完）：{raw}/client/quantbot_client.py
- 接入协议：{repo}/blob/main/PROTOCOL.md

## 这个策略

- 策略 id：`{sid}`
- 显示名：{name}

## 1. 把客户端加进项目（选一种）

- 在项目文件夹里运行 `quantbot link`，它会自动加好
- uv 项目：`uv add "{requirement}"`
- pip：把 `{requirement}` 写进 requirements.txt
- 都不想用：把 quantbot_client.py 直接复制进项目

## 2. 连接

```python
from quantbot_client import QuantBot

qb = QuantBot("{sid}", display_name="{name}")
```

程序和 QuantBot 在同一台机器上时，这一行就够了，地址和 token 会从本机的 QuantBot 设置里读到。在别的机器上跑时，设环境变量 `QB_URL` 和 `QB_TOKEN`（在 QuantBot 那台机器上运行 `quantbot token {sid}` 查看）。不要把 token 写进代码，也不要提交到 git。

只在实盘或模拟盘运行时连接 QuantBot，回测时不要连。

## 3. 先找到主循环，再选一种接法

按钮命令只在调用 `qb.sleep()` 或 `qb.process()` 的那个线程里执行，所以按钮函数改交易状态不用加锁。

A. 程序自己有循环（`while True` 加 `time.sleep`）：

```python
with qb:                                  # 出错会推送报错，再抛出
    while not qb.stopping:
        ...                               # 原来的一轮交易
        qb.status("净值 10234.50")         # 每轮报一次状态
        if not qb.sleep(60):              # 代替 time.sleep，等的时候执行按钮
            break
```

B. 框架掌管循环，只给你回调（LumiBot、backtrader、vn.py 这类）：

- 程序启动时调用 `qb.start()`，退出时调用 `qb.close()`
- 在框架每轮都会调用的回调里调用 `qb.process()`，例如 LumiBot 的 `on_trading_iteration`。它执行排队的按钮命令，不会等待
- 不要在回调里调用 `qb.sleep()`
- 回调间隔很长时（比如日线），按钮要等到下一轮才执行。框架有更频繁的回调或定时器的话，在那里也调用 `qb.process()`
- `qb.stopping` 为 True 时，用框架自己的方式退出
- 在框架的出错回调里调用 `qb.error(...)`

C. asyncio 程序：

- 不要在事件循环里调用 `qb.sleep()`，它会卡住事件循环
- 开一个小任务，每秒调用一次 `qb.process()`，再 `await asyncio.sleep(1)`
- 按钮函数要快，不能阻塞

D. 多线程程序：在操作交易状态的那个线程里调用 `qb.sleep()` 或 `qb.process()`。

## 4. 接按钮（只接程序真能做到的）

| 命令 | 写法 | 函数收到 | 函数返回 |
|---|---|---|---|
| status | `qb.on("status", fn)` | 无 | 状态文字 |
| positions | `qb.on("positions", fn)` | 无 | 持仓文字 |
| orders | `qb.on("orders", fn)` | 无 | `[{{"id": "…", "text": "…"}}]` |
| cancel | `qb.on("cancel", fn)` | `order_id` | 文字 |
| flatten | `qb.on("flatten", fn)` | 无 | 文字 |
| params | `qb.on("params", fn)` | 无 | `{{"参数名": 值}}` |
| set_param | `qb.on("set_param", fn)` | `name`, `value` | 文字 |
| manual_order | `qb.on("manual_order", fn)` | `side`（buy 或 sell）, `symbol`, `qty` | 文字 |
| chart | `qb.on("chart", fn)` | 无 | PNG 图片的 bytes |

`pause`、`resume`、`stop` 不用写：暂停时 `qb.can_open()` 返回 False；点了停止，`qb.stopping` 变成 True，`qb.sleep()` 返回 False。函数出错就直接抛异常，QuantBot 会显示失败原因。没接的命令，按钮不显示。

## 5. 推送和状态

| 方法 | 什么时候调用 |
|---|---|
| `qb.status(text)` | 每轮一次，显示在策略卡片上 |
| `qb.fill(text)` | 成交后 |
| `qb.info(text)` | 普通消息 |
| `qb.alert(text)` | 要提醒的事，静音时段也会响 |
| `qb.error(text)` | 出错时，静音时段也会响 |
| `qb.summary(text, png=None)` | 每日总结，可以带图 |
| `qb.risk_triggered(reason)` | 风控触发：暂停开仓并推送原因 |
| `qb.connection(name, ok)` | 券商或行情的连接状态，变了才推送 |
| `qb.expiry(name, when)` | 授权到期时间（带时区的 datetime），比如 Schwab 7 天过期 |

## 规则

- 不要改交易逻辑和下单参数，只加接入代码
- 每个开仓或加仓的下单前，先检查 `qb.can_open()`。平仓和止损不受暂停影响
- flatten 只平能确认属于本策略的仓位，比如按本策略下单时的 client_order_id 前缀。分不清就抛异常拒绝，不要猜
- stop 时不要撤掉保护性的止损单
- 按钮函数在交易线程里执行，要快，不要长时间阻塞
- 保留原来的运行方式和命令

## 改完告诉我

- 改了哪些文件、哪些地方
- 接上了哪些按钮；哪些没接，为什么
- 怎么运行
"""


ENGLISH_TEMPLATE = """\
Help me connect this trading program to QuantBot.

QuantBot is a remote console for viewing strategy status, receiving notifications, and operating strategy controls on the web or in Telegram. The program connects through a Python client. Keep all trading logic and broker connections in the strategy.

- Project: {repo}
- Client source (a single standard-library-only Python file; read it before making changes): {raw}/client/quantbot_client.py
- Protocol: {repo}/blob/main/PROTOCOL.md

## This strategy

- Strategy ID: `{sid}`
- Display name: {name}

## 1. Install the client

Choose one method:

- Run `quantbot link` inside the strategy project
- For a uv project, run `uv add "{requirement}"`
- For pip, add `{requirement}` to requirements.txt
- Copy quantbot_client.py directly into the project

## 2. Connect

```python
from quantbot_client import QuantBot

qb = QuantBot("{sid}", display_name="{name}")
```

On the same machine, the client reads the server address and token from the local QuantBot settings. On another machine, set `QB_URL` and `QB_TOKEN` (run `quantbot token {sid}` on the QuantBot server to obtain the token). Keep the token out of source code and Git.

Connect during live or paper trading only. Keep backtests disconnected.

## 3. Find the main loop and choose the integration

Controls run on the thread that calls `qb.sleep()` or `qb.process()`. Use the thread that owns the trading state.

A. The program has its own loop with `while True` and `time.sleep`:

```python
with qb:                                  # Sends a notification and re-raises on error.
    while not qb.stopping:
        ...                               # Existing trading iteration.
        qb.status("Equity 10234.50")       # Report status once per iteration.
        if not qb.sleep(60):              # Process controls while waiting.
            break
```

B. A framework such as LumiBot, backtrader, or vn.py owns the loop:

- Call `qb.start()` at startup and `qb.close()` at exit
- Call `qb.process()` from a callback such as LumiBot's `on_trading_iteration`. It runs queued controls and returns immediately
- Keep `qb.sleep()` out of callbacks
- If iterations are infrequent, also call `qb.process()` from a more frequent callback or timer on the trading thread
- Use the framework's normal shutdown when `qb.stopping` is true
- Call `qb.error(...)` from the framework's error callback

C. For asyncio:

- Keep `qb.sleep()` out of the event loop
- Run a task that calls `qb.process()` once per second, followed by `await asyncio.sleep(1)`
- Keep control handlers fast and non-blocking

D. In a multi-threaded program, call `qb.sleep()` or `qb.process()` from the trading thread.

## 4. Register the controls the strategy supports

| Command | Registration | Handler arguments | Return value |
|---|---|---|---|
| status | `qb.on("status", fn)` | None | Status text |
| positions | `qb.on("positions", fn)` | None | Position text |
| orders | `qb.on("orders", fn)` | None | `[{{"id": "…", "text": "…"}}]` |
| cancel | `qb.on("cancel", fn)` | `order_id` | Text |
| flatten | `qb.on("flatten", fn)` | None | Text |
| params | `qb.on("params", fn)` | None | `{{"parameter": value}}` |
| set_param | `qb.on("set_param", fn)` | `name`, `value` | Text |
| manual_order | `qb.on("manual_order", fn)` | `side` (buy or sell), `symbol`, `qty` | Text |
| chart | `qb.on("chart", fn)` | None | PNG bytes |

The client provides `pause`, `resume`, and `stop`. While paused, `qb.can_open()` returns false. When stopped, `qb.stopping` becomes true and `qb.sleep()` returns false. Raise errors from handlers so QuantBot can display the reason. The console shows the registered controls.

## 5. Report status and send notifications

| Method | When to call it |
|---|---|
| `qb.status(text)` | Once per iteration, for the strategy card |
| `qb.fill(text)` | After a fill |
| `qb.info(text)` | For a routine message |
| `qb.alert(text)` | For an alert, audible during quiet hours |
| `qb.error(text)` | For an error, audible during quiet hours |
| `qb.summary(text, png=None)` | For a daily summary, with an optional image |
| `qb.risk_triggered(reason)` | When risk controls pause entries and need to report why |
| `qb.connection(name, ok)` | When a broker or market data connection changes |
| `qb.expiry(name, when)` | For authorization expiry, using a timezone-aware datetime |

## Integration rules

- Limit changes to the integration and preserve trading logic and order parameters
- Check `qb.can_open()` before opening or adding to positions. Closing trades and protective stops remain active during a pause
- Flatten only positions you can verify belong to this strategy, for example using its client_order_id prefix. Raise an error if ownership is uncertain
- Keep protective stop orders in place on shutdown
- Keep handlers fast because they run on the trading thread
- Preserve the existing run commands

## Report back

- List the files and sections changed
- List the controls that were connected and explain any omissions
- Show how to run the strategy
"""


def ai_prompt(sid: str, name: str | None = None) -> str:
    """The message for an AI assistant to connect strategy `sid`."""
    name = (name or sid).replace("`", "'").replace('"', "'").strip() or sid
    template = ENGLISH_TEMPLATE if language() == "en" else TEMPLATE
    return template.format(repo=REPO, raw=RAW, requirement=CLIENT_REQUIREMENT, sid=sid, name=name)
