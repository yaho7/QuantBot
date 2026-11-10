# QuantBot 设计

QuantBot 是一个 Telegram 远程控制中心。一个 bot 管理你所有的量化程序。每个程序用自己的券商、策略和框架，比如一个用 LumiBot 加 Schwab 和 Alpaca，另一个是普通 Python 脚本。

它不是交易框架。它不连接券商，不计算净值，不判断交易日，也不替程序做决定。它只做四件事：列出程序、转发按钮、显示程序报上来的状态、推送程序发来的消息。

## 结构

```text
Telegram ⇄ QuantBot 容器（long polling，不开公网端口）
              ▲  HTTP，只在 Docker 内网
              │
   ┌──────────┴──────────┐
策略容器 A             策略容器 B
LumiBot                原生 Python
Schwab 行情 + Alpaca    其他券商
```

策略找 QuantBot，QuantBot 不去找策略。策略不开端口，只发三种请求：

| 请求 | 用途 |
|---|---|
| `POST /v1/events` | 发成交、报错、提醒、状态快照 |
| `GET /v1/commands?wait=25` | 长轮询：挂着等命令，有命令马上返回 |
| `POST /v1/commands/{id}/result` | 回报命令执行结果 |

协议细节见 [PROTOCOL.md](PROTOCOL.md)。任何语言，会发 HTTP 请求就能接入。

| 好处 | 原因 |
|---|---|
| 接入简单 | 策略不用写服务端 |
| 哪里都能跑 | Docker 内网、本机、别的机器（走 HTTPS 或 Tailscale） |
| 互不影响 | QuantBot 更新、重启、崩溃，策略照常交易；命令只是暂时发不出去 |
| 离线看得出 | 45 秒没来取命令，就标成离线，并推送提醒 |
| 状态不冒充实时 | 显示的是快照，旁边写“12 秒前” |

QuantBot 不挂载 `docker.sock`，不启停容器。容器的启动、停止和重启交给 Docker Compose 或 1Panel。它只发命令，暂停、平仓、退出由策略自己决定怎么做。

## 组成

| 模块 | 作用 |
|---|---|
| `config.py` | 读写 `/data/quantbot.json` |
| `cli.py` | `quantbot` 命令：setup、add、list、token、rename、remove、run |
| `hub.py` | 每个策略的在线状态、快照、能力、命令队列、等待结果 |
| `server.py` | 内网 HTTP 接口，按策略 token 认证 |
| `core.py` | 菜单、按钮、二次确认、审计，不含 Telegram 类型 |
| `bot.py` | 把 Telegram 消息和按钮接到 `core.py` |
| `notices.py` | 静音时段、授权到期提醒 |
| `heartbeat.py` | QuantBot 自己向外部监控报心跳 |
| `client/quantbot_client.py` | 给 Python 策略用的单文件客户端，只用标准库 |

没有数据库、消息队列或 Web 框架页面。命令只存在内存里，审计写进一个 JSONL 文件。

## 策略注册

```bash
quantbot add momentum --name 动量策略   # id 用小写字母、数字、- 和 _
```

每个策略一个随机 token。token 认出是哪个策略，所以一个策略不能冒充另一个。

## 能力和菜单

策略启动时发一个 `hello` 事件，列出它支持的命令。QuantBot 按这个生成菜单，不支持的按钮不显示。

| 命令 | 参数 | 按钮 |
|---|---|---|
| `status` | 无 | 刷新 |
| `pause` / `resume` | 无 | 暂停开仓 / 恢复开仓 |
| `positions` | 无 | 持仓 |
| `orders` | 无 | 挂单 |
| `cancel` | `order_id` | 撤单（确认） |
| `flatten` | 无 | 平仓（确认） |
| `params` | 无 | `/set` 先用它检查名字和类型 |
| `set_param` | `name`, `value` | `/set`（确认） |
| `manual_order` | `side`, `symbol`, `qty` | `/buy` `/sell`（确认） |
| `chart` | 无 | 净值图 |
| `stop` | 无 | 停止程序（确认） |

## Telegram 里怎么用

- `/menu` 列出所有策略：🟢 在线或 🔴 离线、状态第一行、快照多久以前。只注册了一个策略时，直接打开它。
- 点一个策略，看它的状态和按钮。它也会成为“当前策略”，`/set`、`/buy`、`/positions` 这些命令都作用在它上面。`/use <id>` 也能切换。
- 列表页有“⏸ 全部暂停开仓”，一次发给所有在线策略。
- 策略离线时，按钮仍然显示，但命令会排队，回复里写明“离线，命令已排队”。命令 2 分钟后作废，不会在很久以后突然执行。

## 安全

| 规则 | 做法 |
|---|---|
| 只认主人 | 命令和按钮都检查 setup 认出的主人 |
| 二次确认 | 平仓、停止、撤单、改参数、手动下单，第二次点击的票据 30 秒内有效，只能用一次 |
| 幂等 | 每个命令有 id。没收到结果的命令 20 秒后会重发；策略按 id 去重，不会执行两次 |
| 超时 | 15 秒没结果，先回复“已发出，还没回报”；结果到了再推送 |
| 审计 | 每次操作和结果写进 `audit.jsonl` |
| 内网认证 | 每个策略一个 token，比较时用常量时间 |
| 大小限制 | 请求体最大 6 MB（净值图） |
| 平仓归属 | 策略只能平自己能确认归属的仓位，分不清就拒绝 |
| 停止 | `stop` 只请求策略退出，保护性止损单留着 |
| 不自动重启实盘 | 实盘容器用 `restart: "no"`；Docker 的健康检查只标记 unhealthy，不会重启 |

风险：内网 HTTP 是明文的。策略在别的机器上时，要走 HTTPS 或 Tailscale。

## 推送

| 策略事件 | 推送样子 | 静音时段 |
|---|---|---|
| `fill` | `[动量策略] 🟢 AAPL BUY 10 @ 280.50` | 静默送达 |
| `info`、`summary` | 普通消息，`summary` 可带一张图 | 静默送达 |
| `alert` | `⚠️` 开头 | 响铃 |
| `error` | `❌` 开头 | 响铃 |
| `connection` | 只在断开、恢复时推送 | 断开响铃 |
| `expiry` | 到期前 48 小时、12 小时、过期时提醒 | 响铃 |
| 离线 / 恢复在线 | QuantBot 自己发 | 离线响铃 |

风控上限和交易日历归策略管：策略自己暂停，再发一条 `alert`。

## 心跳

| 谁 | 怎么报 |
|---|---|
| QuantBot | 每 60 秒 ping 一次 setup 里填的心跳地址，证明 bot 还活着 |
| 每个策略 | 一轮正常跑完后 ping 自己的监控地址，客户端里有 `heartbeat()` |

超时没收到心跳，由 [Healthchecks.io](https://healthchecks.io) 自己的 Telegram 集成报警。这样 QuantBot 挂了也能知道。

## 配置

不用环境变量，也不用配置文件挂载。所有设置都由 `quantbot` 命令写进 `/data/quantbot.json`（权限 600）。`compose.yaml` 只写镜像、重启策略和 `./data:/data`。容器先以 root 启动，把 `/data` 交给 quantbot 用户，再切换成它，所以宿主机上普通的 `./data` 文件夹就能用；`docker compose exec` 以 root 运行的 `setup` 也一样。

| 命令 | 写什么 |
|---|---|
| `quantbot setup` | bot token、主人、静音时段、时区、心跳地址 |
| `quantbot add/rename/remove` | 策略的 id、名字、token |
| `quantbot token <id> --new` | 换 token |

`setup` 认主人的方法：用户给 bot 发一条消息，`setup` 用 `getUpdates` 读到发件人。QuantBot 已经在收消息时 Telegram 会报冲突，这时改为手动输入 id。

运行中的 QuantBot 每 5 秒看一次文件有没有变：

| 改了什么 | 怎么生效 |
|---|---|
| 策略 | 马上生效；删掉的策略，排队的命令作废 |
| Telegram 设置 | 进程退出，容器按 `unless-stopped` 重启 |

还没 `setup` 时，进程不退出，每 3 秒检查一次，这样 `docker compose exec` 能连进去。

两个可选变量改的是位置：`QB_DATA_DIR`（默认 `/data`）、`QB_LISTEN`（默认 `0.0.0.0:8080`）。

## 不做的事

- 不连接券商，不存行情和成交。
- 不启停容器，不挂载 `docker.sock`。
- 不保存命令：QuantBot 重启时，还没执行的命令会丢掉，这比重启后突然执行更安全。
