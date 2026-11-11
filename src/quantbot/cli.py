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
import os
import re
import secrets
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

from quantbot.config import (
    BOT_TOKEN,
    LOCALHOST,
    STRATEGY_ID,
    ConfigError,
    Store,
    check_listen,
    check_public_url,
    check_strategy_id,
    check_timezone,
    check_url,
    data_dir,
    free_port,
    new_token,
    port_free,
)
from quantbot.editor import EDITOR_FILE, Editor
from quantbot.notices import parse_quiet
from quantbot.prompt import CLIENT_REQUIREMENT, ai_prompt
from quantbot.service import Service, ServiceError, executable
from quantbot.updates import Updater, installed

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


def _service_or_none() -> Service | None:
    try:
        return detect_service()
    except ServiceError:
        return None


ANY_HOST = "0.0.0.0"  # noqa: S104 - only when the user picks it


def _ask_address(io: Console, data: dict[str, Any]) -> tuple[str, str | None]:
    """Ask who may connect and the port. Defaults: the current values, QUANTBOT_PORT,
    or this machine only on a free random port."""
    current = str(data.get("listen") or "")
    current_host, _, current_port = current.rpartition(":") if current else ("", "", "")
    io.say("     谁能打开网页：")
    io.say("     1. 只有这台机器（从别处打开用 SSH 隧道或 Tailscale）")
    io.say("     2. 任何能连到这台机器的地方（公网 IP 或局域网直接打开）")
    io.say("     3. 通过 Tunnel（Cloudflare Tunnel 的 HTTPS 域名）")
    default_mode = "3" if data.get("web_tunnel") else "2" if current_host == ANY_HOST else "1"
    while True:
        picked = io.ask("     选择", default_mode)
        if picked in {"1", "2", "3"}:
            break
        io.say("     ✗ 输入 1、2 或 3")
    host = ANY_HOST if picked == "2" else LOCALHOST
    default = current_port or os.environ.get("QUANTBOT_PORT") or str(free_port())
    while True:
        typed = io.ask("     端口（回车用这个）", default)
        if not typed.isdigit() or not 1024 <= int(typed) <= 65535:
            io.say("     ✗ 端口是 1024 到 65535 之间的数字")
            continue
        # The current port may be held by the running QuantBot itself; it frees it on restart.
        if typed != current_port and not port_free(int(typed), host):
            io.say(f"     ✗ 端口 {typed} 已经被别的程序占用，换一个")
            continue
        listen = f"{host}:{int(typed)}"
        break
    if picked != "3":
        return listen, None
    while True:
        address = io.ask("     Tunnel 的 HTTPS 地址", str(data.get("public_url") or ""))
        try:
            public_url = check_public_url(address)
            if not public_url or not public_url.startswith("https://"):
                raise ConfigError("请填写 Tunnel 的 HTTPS 地址，例如 https://bot.example.com。")
            return listen, public_url
        except ConfigError as exc:
            io.say(f"     ✗ {exc}")


def _ask_admin(io: Console, data: dict[str, Any]) -> dict[str, str]:
    """The web admin's username and password hash. Enter keeps the current password."""
    from quantbot.web import MIN_PASSWORD, USERNAME, hash_password

    old = data.get("web_admin") or {}
    while True:
        username = io.ask("     用户名", str(old.get("username") or "admin"))
        if USERNAME.match(username):
            break
        io.say("     ✗ 用户名只能用字母、数字和 _ . -，最多 32 个")
    keep = "（回车保留现在的）" if old.get("password") else ""
    while True:
        password = io.secret(f"     密码，至少 {MIN_PASSWORD} 位{keep}")
        if not password and keep:
            return {"username": username, "password": str(old["password"])}
        if len(password) < MIN_PASSWORD:
            io.say(f"     ✗ 密码至少 {MIN_PASSWORD} 位")
            continue
        if io.secret("     再输一次密码") != password:
            io.say("     ✗ 两次不一样，重新输")
            continue
        return {"username": username, "password": hash_password(password)}


def _save_admin(data: dict[str, Any], admin: dict[str, str]) -> bool:
    """Store the admin. A changed account gets a new web secret, signing everyone out."""
    if data.get("web_admin") == admin:
        return False
    data["web_admin"] = admin
    data["web_secret"] = secrets.token_urlsafe(32)
    return True


def _ask_telegram(
    io: Console, api: Api, data: dict[str, Any]
) -> tuple[dict[str, Any] | None, str | None, str]:
    """Bot token and owner, then quiet hours. Returns (telegram, quiet, time zone)."""
    old = data.get("telegram") or {}
    io.say("     第一步：在 Telegram 里找 @BotFather，发 /newbot 创建一个 bot。")
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
    io.say("     第二步：你的账号。只有这个账号能控制 QuantBot。")
    owner, owner_name = _find_owner(io, api, token, username, old)
    io.say("     第三步：静音时段。这段时间里只有提醒和报错会响。")
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
    telegram = {
        "token": token,
        "owner_id": owner,
        "owner_name": owner_name,
        "bot_username": username,
    }
    return telegram, quiet or None, timezone


def cmd_setup(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    data = store.read()
    service = _service_or_none()
    done_before = bool(data.get("setup_done") or (data.get("telegram") or {}).get("token"))
    if args.if_needed and done_before:
        if not (data.get("web_admin") or {}).get("password") and io.interactive():
            io.say("网页现在用账号密码登录。先设一个管理员：")
            _save_admin(data, _ask_admin(io, data))
            store.write(data)
            io.say("✓ 已保存管理员账号。")
        if service is not None and service.installed():
            service.restart()
            io.say("✓ 已经设置过了，后台服务已重启，用上新版本。要改设置，运行 quantbot setup")
        else:
            io.say("✓ 已经设置过了。要改设置，运行 quantbot setup")
        return 0
    if not io.interactive():
        raise Abort("setup 要在终端里交互运行：quantbot setup")
    old_tg = data.get("telegram") or {}
    ask_service = service is not None and not service.installed()
    steps = 5 if ask_service else 4
    io.say("QuantBot 设置。直接回车会用方括号里的值。")
    io.say("网页一定有；Telegram 可以不接，以后在网页的设置里再加。")
    io.say()

    io.say(f"1/{steps}  地址：网页和你的策略都通过它连 QuantBot。")
    listen, public_url = _ask_address(io, data)

    io.say()
    io.say(f"2/{steps}  网页管理员：登录网页用的用户名和密码。")
    admin = _ask_admin(io, data)

    io.say()
    io.say(f"3/{steps}  Telegram：在手机上看推送、点按钮。")
    telegram: dict[str, Any] | None = None
    quiet, timezone = data.get("quiet_hours"), str(data.get("timezone") or "Asia/Shanghai")
    if io.confirm("     要接 Telegram 吗？", default=bool(old_tg.get("token"))):
        telegram, quiet, timezone = _ask_telegram(io, api, data)

    io.say()
    io.say(f"4/{steps}  QuantBot 自己的心跳：填 Healthchecks.io 的 ping 地址，挂了会报警。")
    while True:
        heartbeat = io.ask("     地址，输入 - 不设", str(data.get("heartbeat_url") or "-"))
        try:
            heartbeat = check_url("" if heartbeat == "-" else heartbeat)
            break
        except ConfigError as exc:
            io.say(f"     ✗ {exc}")

    background = False
    if ask_service:
        io.say()
        io.say(f"5/{steps}  后台运行：开机自动启动，挂了自动重启。")
        background = io.confirm("     要在后台运行 QuantBot 吗？")

    io.say()
    io.say("就这样设置：")
    rows = [("地址", f"http://{listen}"), ("网页管理员", admin["username"])]
    if public_url:
        rows.insert(1, ("Tunnel", f"{public_url}/ui/"))
    if telegram:
        rows += [
            ("Telegram", f"@{telegram['bot_username']}"),
            (
                "主人",
                f"{telegram['owner_name'] or telegram['owner_id']}（id {telegram['owner_id']}）",
            ),
            ("静音时段", f"{quiet} {timezone}" if quiet else "不设"),
        ]
    else:
        rows.append(("Telegram", "不接，只用网页"))
    rows.append(("心跳", "已设" if heartbeat else "不设"))
    if ask_service:
        rows.append(("后台运行", "是" if background else "否"))
    for label, value in rows:
        io.say(f"  {label}\t{value}")
    if not io.confirm("保存吗？"):
        io.say("已取消，什么都没改。")
        return 1

    port_changed = bool(data.get("listen")) and data.get("listen") != listen
    data.update(
        listen=listen,
        quiet_hours=quiet,
        timezone=timezone,
        heartbeat_url=heartbeat,
        setup_done=True,
    )
    if public_url:
        data.update(public_url=public_url, web_tunnel=True)
    else:
        data.pop("public_url", None)
        data.pop("web_tunnel", None)
    if telegram:
        data["telegram"] = telegram
    else:
        data.pop("telegram", None)
    data.setdefault("strategies", [])
    signed_out = _save_admin(data, admin) and done_before
    store.write(data)
    sent = ""
    if telegram:
        try:
            api(
                telegram["token"],
                "sendMessage",
                chat_id=telegram["owner_id"],
                text="✅ QuantBot 配置好了。发 /menu 看所有策略。",
            )
            sent = "已给你的 Telegram 发了一条测试消息。"
        except TelegramError as exc:
            sent = f"Telegram 测试消息没发出去：{exc}"
    io.say()
    io.say(f"✓ 已保存。{sent}")
    running = service is not None and service.installed()
    if background and service is not None:
        try:
            for note in service.install(executable(), store.dir):
                io.say(f"  {note}")
            io.say("✓ QuantBot 已在后台运行。看日志：quantbot logs -f")
            running = True
        except ServiceError as exc:
            io.say(f"✗ 后台服务没装成：{exc}")
            io.say("  可以先用 quantbot run 在前台运行。")
    elif running and done_before:
        io.say("  正在运行的 QuantBot 会在几秒内自动重启，用上新设置。")
    elif not running:
        io.say("  运行：quantbot run，或 quantbot service install 放到后台")
    if port_changed and data["strategies"]:
        io.say("  端口变了：已经在跑的策略要重启一下，才会连到新端口。")
    if signed_out:
        io.say("  管理员账号改了：已登录的网页都要重新登录。")
    io.say()
    _print_web_address(store, io, admin["username"])
    if not data["strategies"]:
        io.say("连接一个策略：cd 你的策略项目 && quantbot link")
    return 0


def _print_web_address(store: Store, io: Console, username: str) -> None:
    listen = store.ensure_listen()
    host, _, port = listen.rpartition(":")
    data = store.read()
    public_url = check_public_url(data.get("public_url"))
    if public_url:
        io.say(f"网页：{public_url}/ui/ ，用 {username} 和你的密码登录。")
        if data.get("web_tunnel"):
            io.say(f"  在 Cloudflare Tunnel 里将该域名的源站设为 http://127.0.0.1:{port}。")
    elif host in {ANY_HOST, "::", ""}:
        io.say(f"网页：http://<这台机器的 IP 或域名>:{port}/ui/ ，用 {username} 和你的密码登录。")
        io.say(f"  云服务器要在防火墙或安全组里放行 {port} 端口。")
        io.say("  风险：这是明文 HTTP。走公网的话，建议在前面加一层 HTTPS（例如 Caddy）。")
    else:
        io.say(f"网页：http://{host}:{port}/ui/ ，用 {username} 和你的密码登录。")
        io.say("  只有这台机器能直接打开。在你自己的电脑上，可以先运行：")
        io.say(f"  ssh -L {port}:127.0.0.1:{port} 这台服务器")
        io.say("  再打开上面的地址。运行 quantbot setup 可以更改访问方式。")
    io.say("忘了密码：quantbot password")
    io.say()


def cmd_password(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    if not store.exists():
        raise Abort("还没设置。先运行：quantbot setup")
    if not io.interactive():
        raise Abort("要在终端里交互运行：quantbot password")
    data = store.read()
    io.say("设置网页管理员的用户名和密码。")
    if not _save_admin(data, _ask_admin(io, data)):
        io.say("没有改动。")
        return 0
    store.write(data)
    from quantbot.audit import Audit

    Audit(store.dir).write("password", user="cli", ok=True, result="改了网页管理员账号")
    io.say("✓ 已保存。已登录的网页都要重新登录。")
    return 0


def _print_web_link(store: Store, io: Console) -> None:
    from quantbot.web import WebAuth, login_url

    listen = store.ensure_listen()
    host, _, port = listen.rpartition(":")
    public_url = check_public_url(store.read().get("public_url"))
    io.say("一次性登录链接，不用密码，5 分钟内有效，只能用一次：")
    io.say(f"  {login_url(listen, WebAuth(store.web_secret()).link_token(), public_url)}")
    if public_url:
        return
    if host in {ANY_HOST, "::", ""}:
        io.say("从别的电脑打开时，把 127.0.0.1 换成这台机器的 IP 或域名。")
    else:
        io.say("只有这台机器能直接打开。在你自己的电脑上，可以先运行：")
        io.say(f"  ssh -L {port}:127.0.0.1:{port} 这台服务器")
    io.say()


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
    io.say("运行 quantbot web 获取网页登录链接。")
    return 0


def cmd_list(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    data = store.read()
    telegram_set = data.get("telegram") or {}
    owner = telegram_set.get("owner_name") or telegram_set.get("owner_id")
    io.say(f"Telegram：{'主人 ' + str(owner) if owner else '未接，可在网页设置里添加'}")
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
        if not (store.read().get("web_admin") or {}).get("password"):
            io.say("  运行 quantbot setup 设置网页管理员，或运行 quantbot web 获取登录链接。")
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
    updater = Updater(store.dir)
    result = updater.check()
    io.say(f"当前版本：{result['version']}")
    if result["error"]:
        raise Abort(result["error"])
    if not result["available"]:
        io.say("已经是最新版本。")
        return 0
    count = result["behind"]
    io.say(f"有新版本（{count} 个新提交）：" if count else "有新版本：")
    for commit in result["commits"]:
        io.say(f"  {commit['sha']} {commit['message']}".rstrip())
    if args.check:
        return 0
    if not args.yes:
        if not io.interactive():
            raise Abort("请在终端确认更新，或运行 quantbot update --yes。")
        if not io.confirm("安装更新吗？", default=False):
            io.say("已取消更新。")
            return 0
    io.say("正在更新 QuantBot…")
    ok, output = updater.upgrade()
    if not ok:
        raise Abort(f"更新失败。{output}")
    service = _service_or_none()
    if service is not None and service.installed():
        service.restart()
        io.say("✓ 已更新，后台服务已重启。")
    else:
        io.say("✓ 已更新。如果 QuantBot 正在前台运行，请重新运行 quantbot run。")
    return 0


def cmd_editor(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    if args.action == "on":
        if not args.root:
            raise Abort("请选择策略目录：quantbot editor on --root ~/strategies")
        root = Editor.enable(store.dir, args.root)
        io.say(f"✓ 网页策略编辑器已开启，编辑目录：{root}")
    elif args.root:
        raise Abort("--root 用于 quantbot editor on。")
    elif args.action == "off":
        Store(store.dir, filename=EDITOR_FILE).path.unlink(missing_ok=True)
        io.say("✓ 网页策略编辑器已关闭。")
    else:
        editor = Editor.configured(store.dir)
        io.say(f"编辑目录：{editor.root}" if editor else "网页策略编辑器已关闭。")
    return 0


# ---------------------------------------------------------------- link


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
        "在网页或 Telegram 的 /menu 里就能看到它。"
        "不用填 token，客户端会自己找到这台机器上的 QuantBot。"
    )
    io.say()
    io.say(f"想让 AI 帮你接：运行 quantbot prompt {sid}，把输出整段贴给 AI。")
    return 0


def cmd_prompt(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    """Print the "copy for AI" message, so `quantbot prompt momentum | pbcopy` works."""
    sid = check_strategy_id(args.id or project_name(Path.cwd()))
    known = next((s for s in store.read().get("strategies") or [] if s.get("id") == sid), None)
    name = args.name or (str(known.get("name")) if known else sid)
    io.say(ai_prompt(sid, name).rstrip("\n"))
    return 0


def cmd_web(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    if not store.exists():
        raise Abort("还没设置。先运行：quantbot setup")
    _print_web_link(store, io)
    return 0


def cmd_run(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    from quantbot.bot import serve

    return serve(store)


# --------------------------------------------------------------------- main


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="quantbot", description="一个 Telegram bot 管理所有量化程序")
    p.add_argument("--version", action="version", version=f"quantbot {installed().label}")
    sub = p.add_subparsers(dest="command", metavar="命令")
    sub.add_parser("run", help="在前台运行 QuantBot（后台服务也是用它）").set_defaults(fn=cmd_run)
    setup = sub.add_parser("setup", help="交互式设置：地址、网页管理员、Telegram（可选）、心跳")
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
    prompt = sub.add_parser("prompt", help="打印一段给 AI 的说明，让它帮你把程序接进来")
    prompt.add_argument("id", nargs="?", help="策略 id，默认用当前文件夹名")
    prompt.add_argument("--name", help="显示名称")
    prompt.set_defaults(fn=cmd_prompt)
    update = sub.add_parser("update", help="检查版本或安装更新")
    update.add_argument("--check", action="store_true", help="只检查，不安装")
    update.add_argument("--yes", action="store_true", help="直接安装，无需确认")
    update.set_defaults(fn=cmd_update)
    editor = sub.add_parser("editor", help="在服务器上管理网页策略编辑器")
    editor.add_argument("action", choices=["on", "off", "status"])
    editor.add_argument("--root", help="允许网页编辑的策略目录")
    editor.set_defaults(fn=cmd_editor)
    sub.add_parser("web", help="打印一次性的网页登录链接").set_defaults(fn=cmd_web)
    sub.add_parser("password", help="改网页管理员的用户名和密码").set_defaults(fn=cmd_password)
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
        code = int(fn(store, io, api, args))
        if code == 0 and args.command in {"list", "link", "web", "setup"}:
            update = Updater(store.dir).cached()
            if update and update.get("available"):
                io.say("有新版本，运行 quantbot update 查看。")
        return code
    except (Abort, ConfigError, ServiceError) as exc:
        io.say(f"✗ {exc}")
        return 1
    except KeyboardInterrupt:
        io.say("\n已取消。")
        return 130


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    sys.exit(main())
