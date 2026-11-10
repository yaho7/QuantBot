# tgctl 设计

`tgctl` 是一个小模块：给任何 Python 量化程序加上 Telegram 控制。它不是交易框架。程序怎么写、用什么库、接哪家券商，全由程序自己决定，比如用 Schwab 取行情、用 Alpaca 下单。

`tgctl` 只做三件事：回答查询、转发按钮、推送消息。它不认识任何券商，不知道净值和交易日历，也不替程序做交易决定。不需要开放端口：bot 主动向 Telegram 拉取消息（long polling）。

它放在 AntQuant 仓库的 `tgctl/` 目录里，有自己的 `pyproject.toml`，可以直接 `pip install`，以后也可以整个目录搬成单独的仓库。

## 结构

```text
Telegram ⇄ Bot（主线程，python-telegram-bot，asyncio）
              │ 命令 ──▶ 命令队列 ──▶ 交易线程在安全的时候执行
              │ 推送 ◀── notify() ◀── 交易线程
              ▼
           策略对象（交易线程，非 daemon）
              ├─ 行情：随便哪家，比如 schwab-py
              └─ 下单：随便哪家，比如 alpaca-py
```

| 部分 | 运行位置 | 说明 |
|---|---|---|
| Bot | 主线程 | `run_polling()` 占住主线程，处理 `Ctrl+C` 和 `SIGTERM` |
| 交易循环 | 普通线程（非 daemon） | 退出要走明确的流程，见“退出” |
| 命令队列 | 两边之间 | 会读写策略状态的操作都排进队列，由交易线程执行，不和交易循环抢 |
| 推送 | `notify()` | 线程安全；bot 还没连上时先缓存 |

### 命令队列和“睡觉”

按钮不直接调用策略方法。`tgctl` 把操作排进队列，交易线程在自己觉得安全的时候执行，再把结果交回 bot。

交易循环里的 `time.sleep()` 要换成 `tg.sleep(秒数)`。它一边等，一边执行排进来的命令；收到停止请求就马上返回 `False`。这样用日线的程序睡几个小时，点了按钮也能马上响应。

```python
def run(tg):
    while not tg.stopping:
        do_one_round()
        tg.heartbeat()               # 一轮正常跑完才报心跳
        if not tg.sleep(60):         # 等的时候也在执行命令
            break
```

如果命令在 15 秒内没被执行，bot 回复“程序正忙”。命令仍在排队，执行完会再推送结果。

## 策略对象的接口

不用继承任何类。策略实现了哪些方法，Telegram 上就出现哪些功能。这些方法都在交易线程里被调用。

| 方法 | 返回 | 用途 |
|---|---|---|
| `status()` | 文本 | `/status` 和菜单上方的文字 |
| `positions()` | 文本 | `/positions` |
| `orders()` | `[{"id": ..., "text": ...}]` | `/orders`，每个挂单一个撤单按钮 |
| `cancel(order_id)` | 文本 | 撤一个挂单 |
| `flatten()` | 文本 | 平掉本程序的仓位，见“平仓” |
| `params()` | `dict` | `/set` 用来检查名字和类型 |
| `set_param(name, value)` | 文本 | 运行中改参数 |
| `manual_order(side, symbol, qty)` | 文本 | `/buy` `/sell` |
| `chart()` | PNG 字节 | `/chart` |
| `shutdown()` | 无 | 停止时在交易线程里调用，做收尾 |

方法里抛出的异常会作为失败结果回给你，不会让程序停下。

`tgctl` 提供给策略的：

| 名字 | 用途 |
|---|---|
| `tg.sleep(秒)` | 代替 `time.sleep`，同时执行命令 |
| `tg.stopping` | 是否已请求停止 |
| `tg.can_open()` | 下开仓单前最后检查一次；暂停时返回 `False` |
| `tg.paused` | 是否暂停开仓 |
| `tg.notify(text, kind="info")` | 推送；`kind` 是 `info`、`trade`、`error` |
| `tg.trade(text)` | 成交推送 |
| `tg.error(text)` | 报错推送 |
| `tg.daily_summary(text, chart=None)` | 每日总结，什么时候发由程序决定 |
| `tg.risk_triggered(reason)` | 暂停开仓并推送原因 |
| `tg.connection(name, ok, detail="")` | 连接断开、恢复时推送，状态不变不重复推送 |
| `tg.watch_expiry(name, expires_at)` | 授权快过期时提醒，比如 Schwab 的 7 天授权 |
| `tg.heartbeat()` | 一轮正常跑完后调用，去 ping 外部心跳地址 |

风控上限和交易日历归程序管。程序自己算净值、判断今天开不开市、决定收盘后什么时候发总结。`tgctl` 只负责显示和推送。

## 功能

| 批次 | 功能 | 形式 |
|---|---|---|
| 一 | 主菜单 | `/menu`，状态文字加按钮，点完原地更新 |
| 一 | 状态 | `/status`，带刷新按钮 |
| 一 | 暂停开仓 / 恢复 | 按钮；状态写进文件，重启后还记得 |
| 一 | 平仓 | 按钮或 `/flatten`，点两次确认 |
| 一 | 停止程序 | `/stop`，点两次确认 |
| 一 | 成交、报错推送 | `tg.trade()` `tg.error()` |
| 一 | 线程故障 | 交易线程出错退出时推送报错，整个程序退出 |
| 一 | 外部心跳 | `tg.heartbeat()` ping Healthchecks.io |
| 一 | 只认主人 | 命令和按钮都检查用户 id |
| 一 | 操作记录 | 每次操作写进 `audit.jsonl` |
| 二 | 持仓、挂单、撤单 | `/positions` `/orders` |
| 二 | 改参数 | `/set rsi_len 10`，检查名字和类型，回显改前改后 |
| 二 | 每日总结 | `tg.daily_summary()` |
| 二 | 风控触发 | `tg.risk_triggered()` |
| 二 | 连接状态 | `tg.connection()` |
| 二 | 授权到期提醒 | `tg.watch_expiry()`，到期前 48 小时和 12 小时各提醒一次 |
| 三 | 净值图 | `/chart`，或随每日总结发送 |
| 三 | 手动下单 | `/buy QQQ 10`，点两次确认 |
| 三 | 静音时段 | 时段内只有报错会响，其他消息静默送达 |

不做“一个 bot 管几个程序”：那需要几个进程之间互相通信，超出这个模块的范围。每个程序用自己的 bot token。

## 交易安全

### 二次确认

平仓、停止、撤单、改参数、手动下单都要点两次。第一次点击生成一个一次性的确认 id，30 秒内有效。第二次点击时检查它没过期、没用过，然后才排进命令队列。旧消息里的按钮点了只会提示“已失效”。确认 id 同时是操作 id，写进操作记录，同一个 id 不会执行两次。

执行时的检查由策略在自己的方法里做，因为只有策略知道当前的持仓和订单。

### 平仓

`flatten()` 只能平掉确定属于本程序的仓位。建议下单时给 `client_order_id` 加上程序自己的前缀，按成交记账。几个策略共用一个账户、又分不清仓位时，`flatten()` 应该拒绝并说明原因，不要按账户持仓去猜。

### 停止和撤单分开

- `/stop`：请求停止。交易线程执行完手上的命令，`tg.sleep()` 返回 `False`，循环退出，`shutdown()` 做收尾。止损这类保护单留着，不撤。
- `/flatten`：平仓，并按需要撤掉相关挂单。

### 退出

| 情况 | 结果 |
|---|---|
| `/stop`、`Ctrl+C`、`docker stop` | 设置停止标志，最多等交易线程 30 秒 |
| 30 秒内没退出 | 记录日志并推送，进程强制退出 |
| 交易线程出错退出 | 推送报错和最后几行日志，向心跳地址报失败，bot 停止，进程以非 0 退出 |
| Bot 自己出错 | 同样先请求交易线程停止，再退出 |

实盘程序不要自动重启。重启前要先在券商端核对订单和持仓，否则可能重复下单。Docker 用 `restart: "no"`。Docker 的健康检查只会把容器标成 unhealthy，不会因此重启它，所以不能靠它恢复。

## 心跳

程序卡死时，它自己发不出提醒，所以心跳放在外面检查：

- 交易循环每次正常跑完一轮，调用 `tg.heartbeat()`。它在后台去 GET `HEARTBEAT_URL`，最多 30 秒一次，不会卡住循环。
- 交易线程出错时，`tgctl` 会请求 `HEARTBEAT_URL/fail`（Healthchecks.io 的失败地址）。
- 超时没收到心跳，由 [Healthchecks.io](https://healthchecks.io) 自己的 Telegram 集成发提醒。这样即使程序和 bot 都挂了，也能收到。

## 配置

都放在环境变量里，用 `.env` 文件传给容器。`.env` 不提交到 git。

| 变量 | 必填 | 说明 |
|---|---|---|
| `TG_TOKEN` | 是 | bot token，在 [@BotFather](https://t.me/BotFather) 创建，每个程序一个 |
| `TG_OWNER_ID` | 是 | 你的 Telegram 数字 id，可以向 [@userinfobot](https://t.me/userinfobot) 查询 |
| `TG_STATE_DIR` | 否 | 暂停状态和操作记录放在哪里，默认 `./tgctl-state` |
| `TG_QUIET_HOURS` | 否 | 静音时段，例如 `23-07` |
| `TG_TIMEZONE` | 否 | 静音时段用的时区，默认 `Asia/Shanghai` |
| `HEARTBEAT_URL` | 否 | 心跳地址 |

多个程序共用一个 token 时，几个进程同时拉取消息会互相抢，Telegram 会报冲突。

## 不做的事

- 不连接任何券商，不计算净值，不判断交易日。
- 不用 Web 框架、消息队列或数据库。状态只是一个 JSON 文件和一个 JSONL 记录文件。
- 不在多个进程之间通信。以后如果要求 bot 重启时交易不中断，再把 bot 拆成单独的进程。
