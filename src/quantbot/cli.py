"""The `quantbot` command: setup, the background service and strategy management.

quantbot setup
quantbot service install
quantbot add momentum --name 动量策略
quantbot list
"""

from __future__ import annotations

import argparse
import getpass
import json
import logging
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from importlib import resources
from pathlib import Path
from typing import Any

from quantbot import __version__
from quantbot.config import (
    BOT_TOKEN,
    LOCALHOST,
    STRATEGY_ID,
    ConfigError,
    Store,
    check_listen,
    check_strategy_id,
    check_timezone,
    check_url,
    data_dir,
    new_token,
    port_free,
)
from quantbot.notices import parse_quiet
from quantbot.service import Service, ServiceError, executable

OWNER_WAIT = 120


class Abort(Exception):
    """Stop the command with a message and exit code 1."""


class Console:
    """Terminal input and output. Tests replace it with scripted answers."""

    def say(self, text: str = "") -> None:
        print(text, flush=True)

    def ask(self, prompt: str, default: str = "") -> str:
        hint = f" [{default}]" if default else ""
        try:
            answer = input(f"{prompt}{hint}: ").strip()
        except EOFError as exc:
            raise Abort("没有输入，已取消。") from exc
        return answer or default

    def secret(self, prompt: str) -> str:
        try:
            return getpass.getpass(f"{prompt}: ").strip()
        except EOFError as exc:
            raise Abort("没有输入，已取消。") from exc

    def confirm(self, prompt: str, default: bool = True) -> bool:
        answer = self.ask(f"{prompt} {'[Y/n]' if default else '[y/N]'}").lower()
        return default if not answer else answer in {"y", "yes", "是"}

    def interactive(self) -> bool:
        return sys.stdin.isatty()


# ---------------------------------------------------------------- Telegram


class TelegramError(Exception):
    def __init__(self, message: str, code: int | None = None) -> None:
        super().__init__(message)
        self.code = code


def telegram(token: str, method: str, http_timeout: float = 15, **params: Any) -> Any:
    """Call the Bot API. The token is part of the URL, so it is never logged."""
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = json.dumps(params).encode()
    request = urllib.request.Request(  # noqa: S310 - fixed https URL
        url, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=http_timeout) as response:  # noqa: S310
            body = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read())
        except ValueError:
            raise TelegramError(f"HTTP {exc.code}", exc.code) from exc
        raise TelegramError(str(body.get("description") or exc.code), exc.code) from exc
    except (OSError, ValueError) as exc:
        raise TelegramError(f"连不上 Telegram：{exc}") from exc
    if not body.get("ok"):
        raise TelegramError(str(body.get("description") or "失败"))
    return body["result"]


Api = Callable[..., Any]


# ----------------------------------------------------------------- commands


def api_url(store: Store) -> str:
    host, _, port = store.ensure_listen().rpartition(":")
    return f"http://{'127.0.0.1' if host in {'0.0.0.0', '::', ''} else host}:{port}"  # noqa: S104


def cmd_setup(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    data = store.read()
    if args.if_needed and (data.get("telegram") or {}).get("token"):
        io.say("✓ 已经设置过了。要改设置，运行 quantbot setup")
        return 0
    if not io.interactive():
        raise Abort("setup 要在终端里交互运行：quantbot setup")
    old = data.get("telegram") or {}
    io.say("QuantBot 设置。直接回车会用方括号里的值。")
    io.say()

    io.say("1/4  Bot token：在 Telegram 里找 @BotFather，发 /newbot 创建一个 bot。")
    while True:
        token = io.secret("     粘贴 token" + ("（回车保留现在的）" if old.get("token") else ""))
        token = token or str(old.get("token") or "")
        if not BOT_TOKEN.match(token):
            io.say("     ✗ 这不像 bot token，应该像 123456789:AAH...")
            continue
        try:
            me = api(token, "getMe")
        except TelegramError as exc:
            io.say(f"     ✗ {exc}")
            continue
        username = me.get("username", "")
        io.say(f"     ✓ 连上了 @{username}")
        break

    io.say()
    io.say("2/4  你的 Telegram 账号：只有这个账号能控制 QuantBot。")
    owner, owner_name = _find_owner(io, api, token, username, old)

    io.say()
    io.say("3/4  静音时段：这段时间里只有提醒和报错会响。")
    while True:
        quiet = io.ask("     时段，例如 23-07，输入 - 不设", str(data.get("quiet_hours") or "-"))
        quiet = "" if quiet == "-" else quiet
        try:
            parse_quiet(quiet)
            timezone = check_timezone(
                io.ask("     时区", str(data.get("timezone") or "Asia/Shanghai"))
            )
            break
        except (ValueError, ConfigError) as exc:
            io.say(f"     ✗ {exc}")

    io.say()
    io.say("4/4  QuantBot 自己的心跳：填 Healthchecks.io 的 ping 地址，挂了会报警。")
    while True:
        heartbeat = io.ask("     地址，输入 - 不设", str(data.get("heartbeat_url") or "-"))
        try:
            heartbeat = check_url("" if heartbeat == "-" else heartbeat)
            break
        except ConfigError as exc:
            io.say(f"     ✗ {exc}")

    changed = old.get("token") and (old.get("token"), old.get("owner_id")) != (token, owner)
    data.update(
        telegram={"token": token, "owner_id": owner, "owner_name": owner_name},
        quiet_hours=quiet or None,
        timezone=timezone,
        heartbeat_url=heartbeat,
    )
    data.setdefault("strategies", [])
    store.write(data)
    try:
        api(token, "sendMessage", chat_id=owner, text="✅ QuantBot 配置好了。发 /menu 看所有策略。")
        sent = "已给你发了一条测试消息。"
    except TelegramError as exc:
        sent = f"测试消息没发出去：{exc}"
    listen = store.ensure_listen()
    io.say()
    io.say(f"✓ 已保存。{sent}")
    io.say(f"  QuantBot 的地址：http://{listen}")
    io.say("  换端口：quantbot service install --port <端口>")
    if changed:
        io.say("  正在运行的 QuantBot 会在几秒内自动重启，用上新设置。")
    if not args.if_needed:
        io.say("  后台运行：quantbot service install")
    if not data["strategies"]:
        io.say("  添加策略：quantbot add <id> --name <名字>")
    return 0


def _find_owner(
    io: Console, api: Api, token: str, username: str, old: dict[str, Any]
) -> tuple[int, str]:
    if isinstance(old.get("owner_id"), int):
        name = old.get("owner_name") or old["owner_id"]
        if io.confirm(f"     还是 {name}（id {old['owner_id']}）吗？"):
            return int(old["owner_id"]), str(old.get("owner_name") or "")
    while True:
        typed = io.ask(f"     给 @{username} 发一条消息后按回车；也可以直接输入你的数字 id")
        if typed.lstrip("-").isdigit():
            return int(typed), ""
        if typed:
            io.say("     ✗ id 是一串数字")
            continue
        try:
            found = _wait_for_message(io, api, token)
        except TelegramError as exc:
            if exc.code == 409:
                io.say("     ✗ QuantBot 正在用这个 bot 收消息，没法自动识别。请直接输入数字 id。")
            else:
                io.say(f"     ✗ {exc}")
            continue
        if found is None:
            io.say(f"     ✗ {OWNER_WAIT} 秒内没收到消息。")
            continue
        uid, name = found
        if io.confirm(f"     收到 {name}（id {uid}）的消息。就是你吗？"):
            return uid, name


def _wait_for_message(io: Console, api: Api, token: str) -> tuple[int, str] | None:
    io.say("     等待消息中…")
    offset = None
    deadline = time.monotonic() + OWNER_WAIT
    while time.monotonic() < deadline:
        params: dict[str, Any] = {"timeout": 20, "allowed_updates": ["message"]}
        if offset is not None:
            params["offset"] = offset
        for update in api(token, "getUpdates", http_timeout=30, **params):
            offset = update["update_id"] + 1
            user = (update.get("message") or {}).get("from") or {}
            if isinstance(user.get("id"), int) and not user.get("is_bot"):
                api(token, "getUpdates", offset=offset, timeout=0)  # mark it read
                name = " ".join(filter(None, [user.get("first_name"), user.get("last_name")]))
                handle = f" @{user['username']}" if user.get("username") else ""
                return user["id"], (name or str(user["id"])) + handle
    return None


def cmd_add(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    sid = check_strategy_id(args.id)
    data = store.read()
    items = data.setdefault("strategies", [])
    if any(item.get("id") == sid for item in items):
        raise Abort(f"已经有 {sid} 了。看它的 token：quantbot token {sid}")
    name = args.name or (io.ask("显示名称", sid) if io.interactive() else sid)
    token = new_token()
    items.append({"id": sid, "name": name, "token": token})
    store.write(data)
    io.say(f"✓ 已添加 {name}（{sid}）。把下面两行交给这个策略程序：")
    io.say()
    io.say(f"  QB_URL={api_url(store)}")
    io.say(f"  QB_TOKEN={token}")
    io.say()
    io.say("QuantBot 几秒内就会认出它，不用重启。")
    if not data.get("telegram"):
        io.say("提醒：还没配置 Telegram，先运行 quantbot setup。")
    return 0


def cmd_list(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    data = store.read()
    telegram_set = data.get("telegram") or {}
    owner = telegram_set.get("owner_name") or telegram_set.get("owner_id")
    io.say(f"Telegram：{'主人 ' + str(owner) if owner else '还没配置，运行 quantbot setup'}")
    if data.get("listen"):
        io.say(f"监听：{data['listen']}")
    items = store.strategies(data)
    if not items:
        io.say("还没有策略。添加：quantbot add <id> --name <名字>")
        return 0
    width = max(len(s.id) for s in items)
    io.say(f"{len(items)} 个策略：")
    for s in items:
        io.say(f"  {s.id.ljust(width)}  {s.name}")
    return 0


def cmd_token(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    data = store.read()
    item = _find(data, args.id)
    if args.new:
        if not args.yes and not io.confirm(
            "旧 token 会马上失效，策略要换上新的才能连上。继续吗？", False
        ):
            return 1
        item["token"] = new_token()
        store.write(data)
        io.say(f"✓ {args.id} 的新 token：")
    io.say(f"QB_TOKEN={item['token']}")
    return 0


def cmd_rename(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    data = store.read()
    _find(data, args.id)["name"] = args.name
    store.write(data)
    io.say(f"✓ {args.id} 现在叫 {args.name}")
    return 0


def cmd_remove(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    data = store.read()
    item = _find(data, args.id)
    if not args.yes and not io.confirm(
        f"删除 {item.get('name')}（{args.id}）？它的 token 会失效。", False
    ):
        return 1
    data["strategies"] = [s for s in data["strategies"] if s.get("id") != args.id]
    store.write(data)
    io.say(f"✓ 已删除 {args.id}。策略程序本身不受影响，请自己停掉它。")
    return 0


def _find(data: dict[str, Any], sid: str) -> dict[str, Any]:
    for item in data.get("strategies") or []:
        if item.get("id") == sid:
            return item
    raise Abort(f"没有策略 {sid}。看全部：quantbot list")


detect_service: Callable[[], Service] = Service.detect


def cmd_service(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    service = detect_service()
    if args.action == "install":
        if args.port is not None or args.listen:
            _set_listen(store, io, args.port, args.listen)
        listen = store.ensure_listen()
        notes = service.install(executable(), store.dir)
        io.say(f"✓ QuantBot 已在后台运行，开机自动启动。服务文件：{service.path}")
        io.say(f"  监听：{listen}")
        for note in notes:
            io.say(f"  {note}")
        io.say("  看日志：quantbot logs -f")
        if not store.exists():
            io.say("  还没设置 Telegram，它会先等着。请运行：quantbot setup")
    elif args.action == "uninstall":
        service.uninstall()
        io.say("✓ 已停止并删除服务。设置和策略 token 都还在。")
    elif args.action == "restart":
        service.restart()
        io.say("✓ 已重启。")
    else:
        io.say(service.status() or "没有安装服务。安装：quantbot service install")
    return 0


def _set_listen(store: Store, io: Console, port: int | None, listen: str | None) -> None:
    if port is not None:
        if not 1024 <= port <= 65535:
            raise Abort("端口要在 1024 到 65535 之间")
        host = (listen or LOCALHOST).rpartition(":")[0] if listen else LOCALHOST
        listen = f"{host}:{port}"
    new = check_listen(str(listen))
    data = store.read()
    if data.get("listen") == new:
        return
    host, _, port_text = new.rpartition(":")
    if not port_free(int(port_text), "0.0.0.0" if host == "0.0.0.0" else LOCALHOST):  # noqa: S104
        raise Abort(f"端口 {port_text} 已经被别的程序占用，换一个")
    data["listen"] = new
    store.write(data)
    if data.get("strategies"):
        io.say("  改了端口：已经在跑的策略要重启一下，才会连到新端口。")


def cmd_logs(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    command = detect_service().logs_command(args.follow)
    try:
        return subprocess.call(command)  # noqa: S603 - fixed journalctl/tail command
    except FileNotFoundError as exc:
        raise Abort(f"找不到 {command[0]}") from exc


def cmd_update(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    uv = shutil.which("uv")
    if not uv:
        raise Abort("没找到 uv。重新运行安装命令，也能更新到最新版。")
    io.say("正在更新 QuantBot…")
    if subprocess.call([uv, "tool", "upgrade", "--reinstall", "quantbot"]):  # noqa: S603
        raise Abort("更新失败，见上面的输出。")
    try:
        service = detect_service()
    except ServiceError:
        service = None
    if service is not None and service.installed():
        service.restart()
        io.say("✓ 已更新，后台服务已重启。")
    else:
        io.say("✓ 已更新。")
    return 0


# ---------------------------------------------------------------- link

CLIENT_GIT = "git+https://github.com/yaho7/QuantBot#subdirectory=client"
CLIENT_REQUIREMENT = f"quantbot-client @ {CLIENT_GIT}"


def client_source() -> str:
    """The client file shipped inside the package (or next to it in a checkout)."""
    try:
        return (resources.files("quantbot") / "client_template.py").read_text("utf-8")
    except (FileNotFoundError, ModuleNotFoundError):
        here = Path(__file__).resolve().parents[2] / "client" / "quantbot_client.py"
        return here.read_text("utf-8")


def project_name(path: Path) -> str:
    """The folder's name as a strategy id, matching what the client picks by default."""
    name = re.sub(r"[^a-z0-9_-]+", "-", path.name.lower()).strip("-_")[:32]
    return name if STRATEGY_ID.match(name) else "strategy"


def run_command(project: Path) -> str:
    entry = next(
        (n for n in ("main.py", "bot.py", "strategy.py", "run.py") if (project / n).exists()),
        "main.py",
    )
    if (project / "pyproject.toml").exists() and shutil.which("uv"):
        return f"uv run {entry}"
    if (project / "environment.yml").exists():
        return f"conda run -n <环境名> python {entry}"
    return f"python {entry}"


def cmd_link(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    project = Path(args.path).expanduser().resolve()
    if not project.is_dir():
        raise Abort(f"没有这个文件夹：{project}")
    data = store.read()
    if not data:
        raise Abort("这台机器上的 QuantBot 还没设置。先运行：quantbot setup")
    store.ensure_listen()
    data = store.read()
    io.say(f"把 {project} 连接到 QuantBot。直接回车会用方括号里的值。")
    io.say()

    io.say("1/3  名字")
    items = data.setdefault("strategies", [])
    while True:
        try:
            sid = check_strategy_id(io.ask("     策略 id", args.name or project_name(project)))
            break
        except ConfigError as exc:
            io.say(f"     ✗ {exc}")
    item = next((s for s in items if s.get("id") == sid), None)
    name = io.ask("     在 Telegram 里显示的名字", str(item["name"]) if item else sid)
    if item is None:
        items.append({"id": sid, "name": name, "token": new_token()})
        io.say(f"     ✓ 已添加 {name}")
    else:
        item["name"] = name
        io.say(f"     ✓ {sid} 已经连接过，沿用它的 token")
    store.write(data)

    io.say()
    io.say("2/3  把客户端加进项目")
    choices = []
    if (project / "pyproject.toml").exists() and shutil.which("uv"):
        choices.append(("uv", "用 uv add 加成依赖（uv 项目，推荐）"))
    if (project / "requirements.txt").exists():
        choices.append(("requirements", "写进 requirements.txt"))
    choices.append(("copy", "复制 quantbot_client.py 到项目里（什么环境都能用）"))
    for index, (_, label) in enumerate(choices, 1):
        io.say(f"     {index}. {label}")
    while True:
        picked = io.ask("     选择", "1")
        if picked.isdigit() and 1 <= int(picked) <= len(choices):
            how = choices[int(picked) - 1][0]
            break
        io.say(f"     ✗ 输入 1 到 {len(choices)}")
    if how == "uv":
        if subprocess.call(["uv", "add", CLIENT_REQUIREMENT], cwd=project):  # noqa: S603, S607
            raise Abort("uv add 失败，见上面的输出。可以重新运行 quantbot link 选复制文件。")
        io.say("     ✓ 已加到 pyproject.toml 和 uv.lock")
    elif how == "requirements":
        req = project / "requirements.txt"
        lines = req.read_text("utf-8").splitlines()
        if not any(line.startswith("quantbot-client") for line in lines):
            text = req.read_text("utf-8")
            req.write_text(
                text
                + ("" if text.endswith("\n") or not text else "\n")
                + CLIENT_REQUIREMENT
                + "\n",
                "utf-8",
            )
        io.say("     ✓ 已写进 requirements.txt。在你的环境里运行：pip install -r requirements.txt")
    else:
        target = project / "quantbot_client.py"
        source = client_source()
        if target.exists() and target.read_text("utf-8") != source:
            if not io.confirm("     quantbot_client.py 已存在，换成新版吗？"):
                source = ""
        if source:
            target.write_text(source, "utf-8")
        io.say("     ✓ 已复制 quantbot_client.py")

    io.say()
    io.say("3/3  在代码里加上这几行：")
    io.say()
    for line in (
        "from quantbot_client import QuantBot",
        "",
        f'qb = QuantBot("{sid}")',
        "with qb:",
        "    while not qb.stopping:",
        "        ...                          # 你的一轮交易，下开仓单前看 qb.can_open()",
        '        qb.status("净值 10000")       # 显示在 Telegram 里',
        "        if not qb.sleep(60):         # 等的时候也在响应按钮",
        "            break",
    ):
        io.say(f"    {line}")
    io.say()
    io.say(f"然后照常运行：cd {project} && {run_command(project)}")
    io.say(
        "在 Telegram 里发 /menu 就能看到它。不用填 token，客户端会自己找到这台机器上的 QuantBot。"
    )
    return 0


def cmd_run(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    from quantbot.bot import serve

    return serve(store)


# --------------------------------------------------------------------- main


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="quantbot", description="一个 Telegram bot 管理所有量化程序")
    p.add_argument("--version", action="version", version=f"quantbot {__version__}")
    sub = p.add_subparsers(dest="command", metavar="命令")
    sub.add_parser("run", help="在前台运行 QuantBot（后台服务也是用它）").set_defaults(fn=cmd_run)
    setup = sub.add_parser("setup", help="设置 Telegram bot、你的账号和静音时段")
    setup.add_argument("--if-needed", action="store_true", help="已经设置过就跳过")
    setup.set_defaults(fn=cmd_setup)
    service = sub.add_parser("service", help="后台服务：install、uninstall、restart、status")
    service.add_argument("action", choices=["install", "uninstall", "restart", "status"])
    service.add_argument("--port", type=int, help="端口，默认第一次安装时随机选一个空闲的")
    service.add_argument("--listen", help="完整监听地址，例如 0.0.0.0:23456（让别的机器也能连）")
    link = sub.add_parser("link", help="把你的策略项目连接到 QuantBot（交互式）")
    link.add_argument("path", nargs="?", default=".", help="项目文件夹，默认当前文件夹")
    link.add_argument("--name", help="策略 id，默认用文件夹名")
    link.set_defaults(fn=cmd_link)
    sub.add_parser("update", help="更新到最新版并重启后台服务").set_defaults(fn=cmd_update)
    service.set_defaults(fn=cmd_service)
    logs = sub.add_parser("logs", help="看后台服务的日志")
    logs.add_argument("-f", "--follow", action="store_true", help="一直看新日志")
    logs.set_defaults(fn=cmd_logs)
    add = sub.add_parser("add", help="添加一个策略，生成它的 token")
    add.add_argument("id", help="例如 momentum")
    add.add_argument("--name", help="在 Telegram 里显示的名字")
    add.set_defaults(fn=cmd_add)
    sub.add_parser("list", help="列出策略").set_defaults(fn=cmd_list)
    token = sub.add_parser("token", help="显示一个策略的 token")
    token.add_argument("id")
    token.add_argument("--new", action="store_true", help="换一个新 token，旧的马上失效")
    token.add_argument("--yes", action="store_true", help="不再确认")
    token.set_defaults(fn=cmd_token)
    rename = sub.add_parser("rename", help="改策略的显示名称")
    rename.add_argument("id")
    rename.add_argument("name")
    rename.set_defaults(fn=cmd_rename)
    remove = sub.add_parser("remove", help="删除一个策略")
    remove.add_argument("id")
    remove.add_argument("--yes", action="store_true", help="不再确认")
    remove.set_defaults(fn=cmd_remove)
    return p


def main(
    argv: list[str] | None = None,
    io: Console | None = None,
    api: Api = telegram,
    store: Store | None = None,
) -> int:
    args = parser().parse_args(argv)
    fn = getattr(args, "fn", cmd_run)
    io = io or Console()
    store = store or Store(data_dir())
    try:
        return int(fn(store, io, api, args))
    except (Abort, ConfigError, ServiceError) as exc:
        io.say(f"✗ {exc}")
        return 1
    except KeyboardInterrupt:
        io.say("\n已取消。")
        return 130


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    sys.exit(main())
