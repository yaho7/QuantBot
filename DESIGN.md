# QuantBot 设计

QuantBot 是一个远程控制中心，管理你所有的量化程序。网页一定有，Telegram 可选。每个程序用自己的券商、策略和框架，比如一个用 LumiBot 加 Schwab 和 Alpaca，另一个是普通 Python 脚本。

它不是交易框架。它不连接券商，不计算净值，不判断交易日，也不替程序做决定。它只做四件事：列出程序、转发按钮、显示程序报上来的状态、推送程序发来的消息。

## 结构

```text
Telegram ⇄ QuantBot（装在 VPS 上，long polling，不开公网端口）
              ▲  HTTP，setup 时选只给本机还是对外
              │
   ┌──────────┴──────────┐
策略 A（uv）           策略 B（conda）
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
| 哪里都能跑 | 本机直接连；别的机器设 `QB_URL`，走 HTTPS 或 Tailscale |
| 互不影响 | QuantBot 更新、重启、崩溃，策略照常交易；命令只是暂时发不出去 |
| 离线看得出 | 45 秒没来取命令，就标成离线，并推送提醒 |
| 状态不冒充实时 | 显示的是快照，旁边写“12 秒前” |

QuantBot 不启停你的策略。策略用什么环境、怎么启动，由你自己决定（uv、conda、systemd、tmux 都行）。它只发命令，暂停、平仓、退出由策略自己决定怎么做。

## 组成

| 模块 | 作用 |
|---|---|
| `config.py` | 读写 `~/.config/quantbot/quantbot.json` |
| `service.py` | 后台服务：Linux 的 systemd、macOS 的 launchd |
| `cli.py` | `quantbot` 命令：setup、link、list、token、rename、remove、service、logs、update、run |
| `hub.py` | 每个策略的在线状态、快照、能力、命令队列、等待结果 |
| `server.py` | 给策略用的 HTTP 接口，按策略 token 认证 |
| `core.py` | 菜单、按钮、二次确认、审计，不含 Telegram 类型 |
| `bot.py` | 运行 QuantBot；接了 Telegram 就把消息和按钮接到 `core.py`，没接就只跑网页和策略接口 |
| `web.py` | 网页：一次性登录链接、会话 cookie、和 Telegram 同样的命令、设置 |
| `web/` | 网页前端源码（React、Vite、Tailwind，组件和配色取自 AntQuant），构建到 `src/quantbot/web/` 随包发布 |
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

## 网页

网页和策略接口共用一个端口，路径是 `/ui/`。

| 部分 | 做法 |
|---|---|
| 登录 | `POST /ui/api/login` 用 `setup` 或 `quantbot password` 设的管理员账号。密码存成 scrypt 哈希（`web_admin`）。同一来源连错 5 次锁 15 分钟，每次登录写审计 |
| 备用登录 | `quantbot web` 或 Telegram `/web` 给一个一次性链接，5 分钟有效，不用密码 |
| 会话 | 两种登录都设置 HttpOnly、SameSite=Strict 的 cookie，12 小时有效 |
| 签名 | 链接和 cookie 都用 `quantbot.json` 里的 `web_secret` 做 HMAC 签名，所以命令行生成的链接，运行中的 QuantBot 也认。改管理员账号会换一个 `web_secret`，运行中的 QuantBot 读到后，旧 cookie 全部失效 |
| 防跨站 | 所有 POST 都要带 `X-QuantBot: 1` 请求头 |
| 命令 | `POST /ui/api/strategies/{id}/{命令}`，走和 Telegram 一样的 `Core.call`，检查参数的规则也一样；改动写进审计记录，`user` 是 `web` |
| 设置 | `GET/POST /ui/api/settings`：接上、换掉、断开 Telegram，静音时段、时区、心跳。换 bot 或主人时先发一条测试消息，发不出去就不保存 |
| 推送 | 最近 300 条推送存在内存里，网页的“推送”页显示它们 |

监听地址由 `setup` 让用户选：只给本机（127.0.0.1，用 SSH 隧道或 Tailscale 打开），或所有地址（0.0.0.0）。

## Telegram 里怎么用（接了的话）

- `/menu` 列出所有策略：🟢 在线或 🔴 离线、状态第一行、快照多久以前。只注册了一个策略时，直接打开它。
- 点一个策略，看它的状态和按钮。它也会成为“当前策略”，`/set`、`/buy`、`/positions` 这些命令都作用在它上面。`/use <id>` 也能切换。
- 列表页有“⏸ 全部暂停开仓”，一次发给所有在线策略。
- 策略离线时保留最后状态，查询及交易命令直接拒绝。暂停意图持久保存，直到策略确认暂停。

## 安全

| 规则 | 做法 |
|---|---|
| 只认主人 | 命令和按钮都检查 setup 认出的主人 |
| 二次确认 | 平仓、停止、撤单、改参数、手动下单，第二次点击的票据 30 秒内有效，只能用一次 |
| 幂等 | 每个受保护命令有持久化 ID 和绝对失效时间，策略执行前必须领取一次性许可。执行结果未知时阻止新的同类操作，等待回执或人工核对 |
| 超时 | 15 秒没结果，先回复“已发出，还没回报”；结果到了再推送 |
| 审计 | 每次操作和结果写进 `audit.jsonl` |
| 接口认证 | 每个策略一个 token，比较时用常量时间 |
| 大小限制 | 请求体最大 6 MB（净值图） |
| 平仓归属 | 策略只能平自己能确认归属的仓位，分不清就拒绝 |
| 停止 | `stop` 只请求策略退出，保护性止损单留着 |
| 不自动重启实盘 | QuantBot 不启停策略；你自己跑策略时，崩了不要自动重启 |

风险：接口是明文 HTTP。选了对外监听、要走公网时，前面要加 HTTPS 或用 Tailscale。

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

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/yaho7/QuantBot/main/install.sh | bash
```

`install.sh` 用系统的包管理器装上缺的 git 和 curl，装 uv，再用 `uv tool install` 装 QuantBot。uv 会给 QuantBot 单独下载 Python 3.12，不碰系统 Python 和策略环境。第一次运行时它会跑 `quantbot setup`，最后跑 `quantbot service install`。再运行一次就是更新。

| 系统 | 后台服务 | 日志 |
|---|---|---|
| Linux，普通用户 | systemd 用户服务，打开 linger，退出登录也不停 | `journalctl --user -u quantbot` |
| Linux，root | systemd 系统服务 | `journalctl -u quantbot` |
| macOS | launchd agent | `~/Library/Logs/quantbot.log` |

服务都设成退出后重启：QuantBot 不交易，重启它是安全的。

## 配置

不用环境变量。所有设置都由 `quantbot` 命令写进 `~/.config/quantbot/quantbot.json`（权限 600）。

| 命令 | 写什么 |
|---|---|
| `quantbot setup` | bot token、主人、静音时段、时区、心跳地址 |
| `quantbot link` | 策略的 id、名字、token |
| `quantbot rename/remove` | 改名、删除 |
| `quantbot token <id> --new` | 换 token |
| `quantbot service install --port/--listen` | 监听地址。`setup` 先问只给本机（127.0.0.1）还是所有地址（0.0.0.0），再问端口；默认随机选一个 20000 到 39999 之间的空闲端口 |

`setup` 认主人的方法：用户给 bot 发一条消息，`setup` 用 `getUpdates` 读到发件人。QuantBot 已经在收消息时 Telegram 会报冲突，这时改为手动输入 id。

运行中的 QuantBot 每 5 秒看一次文件有没有变：

| 改了什么 | 怎么生效 |
|---|---|
| 策略 | 马上生效；删掉的策略，排队的命令作废 |
| Telegram 设置 | 进程退出，服务管理器把它重新拉起来 |

还没 `setup` 时，进程不退出，每 3 秒检查一次。

`QB_DATA_DIR` 和 `QB_LISTEN` 两个变量可以覆盖设置的位置和监听地址。

## 连接策略

`quantbot link` 在策略项目里交互式完成三件事：起名并登记 token；把客户端加进项目（`uv add`、写进 `requirements.txt`，或复制 `quantbot_client.py`）；打印要加进代码的几行。

客户端 `QuantBot("momentum")` 不需要 token：它读本机的 `quantbot.json`，按名字找到 token 和监听地址。名字还没登记过，就自己登记，QuantBot 几秒内认出它。策略和 QuantBot 用同一个系统账号运行时才行；否则设 `QB_URL` 和 `QB_TOKEN`。

客户端可以从 git 装：`quantbot-client @ git+https://github.com/yaho7/QuantBot#subdirectory=client`。它只有一个文件，只用标准库。

## 不做的事

- 不连接券商，不存行情和成交。
- 不启停你的策略，不管它们的环境。
- 交易命令和执行许可保留在 SQLite 中。重启后已领取许可的操作仍可回报，旧命令不会重新投递。
