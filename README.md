# QuantBot

一个控制台，管理你所有的量化程序：网页一定有，Telegram 可选。

每个程序用自己的券商、策略、框架和环境（uv、conda、venv 都行）。QuantBot 不管这些，它只做四件事：列出程序、转发按钮、显示程序报上来的状态、推送程序发来的消息。

```text
网页 ──┐
       ├─▶ QuantBot（装在 VPS 上，后台运行）
Telegram（可选）┘    ▲  http://<地址>:<随机端口>，安装时选只给本机还是对外
              ┌──────┴──────┐
         策略 A（uv）   策略 B（conda）
```

策略去找 QuantBot，不用自己开端口。QuantBot 重启或崩溃时，策略照常交易。

## 安装

在 VPS 上运行：

```bash
(set -o pipefail; curl -fsSL https://raw.githubusercontent.com/yaho7/QuantBot/main/install.sh | bash) && export PATH="${UV_TOOL_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}:$PATH"
```

脚本检查 git、curl 和 [uv](https://docs.astral.sh/uv/)，再用 uv 安装 QuantBot 和独立的 Python 3.12 环境。首次安装会逐项确认配置。

交互安装的第一项是选择简体中文或 English。确认配置后，CLI、网页和 Telegram 会使用所选语言。可以在网页「设置 → 语言」切换，也可运行 `quantbot language en` 或 `quantbot language zh`。

For English, select **2. English** when the installer opens. To switch later, use **Settings → Language** or run `quantbot language en`. For automation, pass `--language en` after `bash -s --`, or set `QUANTBOT_LANG=en`.

| 步骤 | 问什么 | 直接回车 |
|---|---|---|
| 1 | 网页访问方式和端口，可选本机 / SSH、网络直连或 Cloudflare Tunnel | 本机 / SSH，随机空闲端口（20000 到 39999） |
| 2 | 网页管理员用户名和密码，自设密码至少 8 位 | 用户名 `admin`，生成初始密码 |
| 3 | Telegram 和 Healthchecks.io 心跳，可在网页设置中补配 | 跳过 |
| 4 | 安装并启动后台服务 | 支持 systemd 或 launchd 时启动 |
| 5 | 启用可选短命令 `qb` | 跳过 |

确认清单后才保存配置。选择后台服务时，安装程序通过本机健康检查后显示网页地址、管理员和运维命令。自动生成的初始密码只在本次终端显示。服务未通过检查时，结果会给出查看日志和重试的命令。

交互式重跑安装脚本时，可选择更新程序、重新配置当前版本或退出。`quantbot setup` 也可直接启动配置向导。

一键命令会在安装成功后刷新当前 Bash / Zsh 的 PATH。若已用旧命令安装，或 uv 使用了不同的目录，可运行安装结果末尾显示的 `export PATH=…` 命令。默认目录对应 `export PATH="$HOME/.local/bin:$PATH"`。启用可选的 `qb` 入口请运行 `quantbot alias enable`。

无终端时自动采用非交互模式，也可以显式传入参数：

```bash
curl -fsSL https://raw.githubusercontent.com/yaho7/QuantBot/main/install.sh | bash -s -- --non-interactive
```

首次安装可用 `QUANTBOT_PORT` 指定端口。非交互安装可通过 `QUANTBOT_ADMIN_USERNAME` 和 `QUANTBOT_ADMIN_PASSWORD` 设置管理员，或之后运行 `quantbot password`。只需安装程序并保存配置时，加上 `--no-service`。

## 网页

打开安装时打印的网页地址，用管理员账号登录。密码连错 5 次，锁 15 分钟。

| 安装时选的 | 怎么打开 |
|---|---|
| 只有这台机器 | 用 SSH 隧道（`ssh -L <端口>:127.0.0.1:<端口> 你的服务器`）或 Tailscale，再开 `http://127.0.0.1:<端口>/ui/` |
| 任何地方 | 直接开 `http://<服务器 IP 或域名>:<端口>/ui/`。云服务器要在防火墙或安全组里放行这个端口 |
| 通过 Tunnel | 打开 `https://<你的域名>/ui/`。QuantBot 监听 `127.0.0.1`，由本机的 `cloudflared` 转发请求 |

选择“通过 Tunnel”后，填写 HTTPS 域名，QuantBot 会把它保存为 `public_url`。在 Cloudflare Tunnel 添加该域名的 Published application 路由，将源站设为安装时打印的 `http://127.0.0.1:<端口>`。QuantBot 在 HTTPS 下使用 Secure 登录 Cookie，并通过 Tunnel 提供的访客 IP 分别计算登录失败次数。 [Cloudflare Tunnel 配置指南](https://developers.cloudflare.com/tunnel/get-started/)

忘了密码，在服务器上运行 `quantbot password`。也可以运行 `quantbot web`，或在 Telegram 里给 bot 发 `/web`，拿一个不用密码的一次性链接（5 分钟内有效，只能用一次）。

已经登录时，在“设置 → 网页管理员”可用当前密码更新用户名和密码，也可生成一次性登录链接。更新后，当前浏览器会继续保持登录，其他会话需要重新登录。

| 网页上 | 能做什么 |
|---|---|
| 策略卡片 | 在线状态、状态快照、暂停开仓、恢复开仓 |
| 添加策略 / 管理 | 添加和移除策略、改显示名称、复制连接信息、换发令牌 |
| 更多操作 | 刷新状态、持仓、挂单和撤单、净值图、改参数、手动下单、平仓、停止程序 |
| 全部暂停开仓 | 所有在线策略一起暂停 |
| 推送 | QuantBot 这次启动后的所有推送 |
| 操作记录 | 网页和 Telegram 上点过的每个按钮 |
| 设置 | 查看网页地址和版本，管理 Telegram、静音时段、时区和心跳地址 |
| 设置 → 后台服务 | 查看服务状态和最近日志，确认后重启服务 |

平仓、撤单、改参数、下单、停止都要再确认一次。登录后 12 小时有效。

想改设置，运行 `quantbot setup`，会用现在的值当默认。

### 更新 QuantBot

QuantBot 启动后每小时查看一次检查缓存，每 6 小时向 GitHub 查询一次。可在网页「设置 → 维护」或 `qb` 菜单点击「检查更新」，也可运行 `quantbot update --check`。后台发现新版本时，版本更新卡片和 `qb` 菜单会显示目标版本或提交号，推送与已连接的 Telegram 也会收到提醒。按版本标签安装时检查最新 GitHub Release。

- 在网页点“有新版本”，或从“设置 → 版本”打开更新窗口。点“检查更新”可以立即查询，每分钟最多一次。确认“一键更新”后，已安装的后台服务会重启，网页会自动重连。前台运行时，请在服务器上停止 QuantBot，再运行 `quantbot run`。
- 在终端运行 `quantbot update --check` 只检查更新。运行 `quantbot update` 会先列出变更再询问是否安装，`--yes` 跳过确认。`quantbot --version` 显示 Git 安装的提交。
- 也可以再运行一次安装命令，它会更新并重启后台服务。

### 网页工作区

QuantBot 在 Linux 上以 root 运行时，可登录网页「工作区」，在 `/srv/quantbot` 下选择或新建一个空文件夹，点击「初始化此文件夹」。也可以在安装向导里初始化，或在服务器上运行：

```bash
quantbot workspace init
# 或指定另一个空目录
quantbot workspace init --root /srv/quantbot/strategies
```

初始化会创建普通系统账号 `quantbot-workspace`，Git 操作用这个账号运行。默认目录是 `/srv/quantbot/strategies`。可在网页上把私有仓库克隆进去。

如果只需要启用已有目录的编辑器，可以用：

```bash
quantbot editor on --root ~/strategies
quantbot editor status
quantbot editor off
```

网页顶栏的「工作区」无需注册策略即可打开。也可以用 `quantbot workspace` 获取一次性直达链接。启用目录后，可以编辑其中的 UTF-8 文件，单个文件最大 256 KiB。请选择存放策略代码的目录。打开 Python 文件时，可以在光标处插入连接、等待、开仓检查、状态、推送和按钮回调的示例。

点“预览并保存”查看改动，确认后才会写入服务器，并在“操作记录”里留下一条保存记录。保存时会检测服务器上的文件是否已变更。文件保存后，由你决定何时启动或重启策略、何时提交 Git。

使用 `quantbot workspace init` 初始化后，点工作区右上方的「终端」即可在目录内打开交互式 Bash。终端和 Git 使用 `quantbot-workspace` 系统账号。右上角的延迟是浏览器到终端的往返时间。关闭终端会结束当前 shell。

「运行」面板可保存一条启动命令，在工作区目录下启动、停止和查看最近输出。选用会在前台保持运行的命令，例如 `uv run python main.py`。如果普通账号还没有 uv，可先在工作区终端安装。关闭浏览器后程序继续运行，QuantBot 服务停止或重启时会停止工作区程序。

```bash
quantbot workspace run set -- uv run python main.py
quantbot workspace run start
quantbot workspace run status
quantbot workspace run logs
quantbot workspace run stop
```

#### 绑定 GitHub 策略仓库

QuantBot 使用 GitHub App 的设备授权，支持私有仓库。首次使用时，在 GitHub 注册 App 并启用 Device Flow。为 App 配置仓库 Contents 权限，读取代码选择 Read-only，需要推送时选择 Read and write。将 App 安装到要同步的仓库，并记下 App 的 Client ID。 [GitHub App 注册指南](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) · [Git 访问权限](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app#choosing-permissions-for-git-access)

- 网页里打开「工作区 → Git → GitHub 仓库」，填仓库名和 Client ID。点击「开始 GitHub 授权」，按提示在 GitHub 输入验证码。
- 在服务器也可运行 `quantbot editor github bind --repo owner/strategy --client-id <Client-ID>`。完成授权后，可以用 `quantbot editor github status/check/pull/push/unbind` 管理绑定和同步。
- 一个编辑目录绑定一个仓库。目录可以是现有 Git 仓库的根目录，也可以是用于克隆的空目录。同步默认使用现有本地分支或 GitHub 的默认分支。
- 拉取需要干净的工作区，且只做快进更新。保存后，在「Git → 本地改动」选择文件并填写提交说明，再推送。首次提交前用 `git config user.name` 和 `git config user.email` 设置身份。CLI 对应命令为 `quantbot workspace git status` 和 `quantbot workspace git commit -m "提交说明" 文件路径`。绑定凭据保存在服务器的私有配置目录。

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

`quantbot --help` 按访问与设置、服务运维、策略管理、编辑与同步、版本更新分组。终端用颜色标记操作状态，重定向输出使用纯文本。也可以通过 `NO_COLOR=1` 关闭颜色。

可运行 `quantbot alias enable` 启用短命令 `qb`。例如 `qb list` 等同于 `quantbot list`。用 `quantbot alias status` 查看状态，或用 `quantbot alias disable` 停用。启用时会检查本机已有的同名命令。

在终端直接输入 `qb` 会打开管理菜单，可查看后台服务、修改设置、获取网页登录链接或选择「完全卸载 QuantBot」。如果要在前台运行服务，请用 `qb run`。

「完全卸载 QuantBot」和 `quantbot uninstall` 都会先列出受影响的路径，再请你确认。卸载会停止并移除这套安装的后台服务、uv 工具、`qb` 快捷命令及 QuantBot 管理的设置、凭据、记录和缓存。策略文件和 Git 仓库会保留。前台运行的实例需先停止。脚本可用 `quantbot uninstall --yes` 跳过确认。

| 命令 | 作用 |
|---|---|
| `quantbot setup` | 改设置：地址、网页管理员、Telegram、心跳 |
| `quantbot password` | 改网页管理员的用户名和密码 |
| `quantbot link [文件夹]` | 连接一个策略项目 |
| `quantbot prompt [id]` | 打印一段给 AI 的说明：项目地址和具体接法，不含 token。网页上是“让 AI 接入策略”和“复制给 AI” |
| `quantbot list` | 列出策略 |
| `quantbot rename <id> <名字>` | 改显示名称 |
| `quantbot remove <id>` | 删除策略 |
| `quantbot token <id> [--new]` | 看或换 token |
| `quantbot service install/uninstall/restart/status` | 后台服务；`install --port` 换端口 |
| `quantbot uninstall [--yes]` | 完全卸载当前 uv 安装与 QuantBot 数据 |
| `quantbot logs -f` | 看日志 |
| `quantbot web` | 打印一次性的网页登录链接 |
| `quantbot update [--check] [--yes]` | 检查或安装更新 |
| `quantbot editor on/off/status` | 管理网页策略编辑器 |
| `quantbot workspace [init]` | 获取网页工作区直达链接，或初始化 Linux 工作区 |

设置和操作记录存在 `~/.config/quantbot/`。

在服务器终端可以安装或卸载后台服务、修改监听端口、启停策略编辑器，或用 `quantbot link` 安装策略项目的客户端依赖。

## 安全

- 网页用管理员账号密码登录，登录后 12 小时有效。密码用 scrypt 加盐存，不存明文。连错 5 次锁 15 分钟，每次登录都写进操作记录。改密码会让所有已登录的网页失效。
- 一次性登录链接不用密码，能拿到链接的人就能平仓和下单，所以别把链接转给别人。
- 网页的按钮请求要带一个专门的请求头，别的网站发不出来。
- Telegram 只认 `setup` 里认出的账号。
- 每个策略一个 token，不能冒充别的策略。
- `~/.config/quantbot/quantbot.json` 里有 bot token、策略 token 和网页的签名密钥，只有你自己的账号能读。删掉里面的 `web_secret`，所有网页登录都会失效。
- 只给本机还是对外，在 `quantbot setup` 里选。对外时网页和策略接口都是明文 HTTP，走公网建议在前面加一层 HTTPS（例如 Caddy）。
- QuantBot 不连券商，不启停你的策略。实盘策略崩了不要自动重启，先在券商端核对订单和持仓。
- QuantBot 自己挂了怎么办：在 `setup` 里填心跳地址，由 [Healthchecks.io](https://healthchecks.io) 报警。

## 开发

```bash
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
```

设计见 `/DESIGN.md`。
