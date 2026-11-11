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
import shlex
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Sequence
from importlib import resources
from pathlib import Path
from typing import Any

from quantbot.command_alias import ShortCommand
from quantbot.config import (
    BOT_TOKEN,
    LOCALHOST,
    STRATEGY_ID,
    ConfigError,
    Store,
    add_strategy,
    check_listen,
    check_public_url,
    check_strategy_id,
    check_timezone,
    check_url,
    data_dir,
    free_port,
    new_token,
    port_free,
    require_strategy,
    set_web_admin,
    strategy_item,
)
from quantbot.editor import EDITOR_FILE, Editor, editor_lock
from quantbot.github import GitHubEditor
from quantbot.notices import parse_quiet
from quantbot.prompt import CLIENT_REQUIREMENT, ai_prompt
from quantbot.service import Service, ServiceError, executable, wait_until_ready
from quantbot.updates import Updater, installed

OWNER_WAIT = 120


class Abort(Exception):
    """Stop the command with a message and exit code 1."""


class Console:
    """Terminal input and output. Tests replace it with scripted answers."""

    def styled(self, text: str, style: str) -> str:
        if (
            sys.stdout.isatty()
            and "NO_COLOR" not in os.environ
            and os.environ.get("TERM") != "dumb"
        ):
            return f"\x1b[{style}m{text}\x1b[0m"
        return text

    def say(self, text: str = "") -> None:
        print(text, flush=True)

    def status(self, level: str, message: str) -> None:
        label, color = {
            "step": ("进行", "1;36"),
            "ok": ("完成", "1;32"),
            "note": ("提示", "1;36"),
            "warn": ("注意", "1;33"),
            "error": ("失败", "1;31"),
        }[level]
        self.say(f"{self.styled(f'[{label}]', color)} {message}")

    def section(self, title: str) -> None:
        self.say()
        self.say(self.styled(f"── {title} ──", "1;36"))

    def rows(self, rows: Sequence[tuple[str, str]]) -> None:
        def width(label: str) -> int:
            return sum(2 if unicodedata.east_asian_width(char) in "FW" else 1 for char in label)

        label_width = max((width(label) for label, _ in rows), default=0)
        for label, value in rows:
            self.say(f"  {label}{' ' * (label_width - width(label) + 3)}{value}")

    def _prompt(self, label: str) -> str:
        return f"{self.styled('›', '1;36')} {label} "

    def ask(self, prompt: str, default: str = "") -> str:
        hint = f" [{default}]" if default else ""
        try:
            answer = input(self._prompt(f"{prompt.strip()}{hint}")).strip()
        except EOFError as exc:
            raise Abort("没有输入，已取消。") from exc
        return answer or default

    def secret(self, prompt: str) -> str:
        try:
            return getpass.getpass(self._prompt(prompt.strip()), stream=sys.stdout).strip()
        except EOFError as exc:
            raise Abort("没有输入，已取消。") from exc

    def reveal(self, label: str, value: str) -> None:
        """Show a generated credential on the terminal, even if stdout is redirected."""
        if sys.stdout.isatty():
            self.rows([(label, value)])
            return
        try:
            with open("/dev/tty", "w", encoding="utf-8") as terminal:
                print(f"  {label}   {value}", file=terminal, flush=True)
        except OSError:
            self.status("warn", "请运行 quantbot password 设置管理员密码。")

    def confirm(self, prompt: str, default: bool = True) -> bool:
        choices = "[Y/n]" if default else "[y/N]"
        while True:
            answer = self.ask(f"{prompt} {choices}").lower()
            if not answer:
                return default
            if answer in {"y", "yes", "是"}:
                return True
            if answer in {"n", "no", "否"}:
                return False
            self.status("warn", "请输入 y 或 n。")

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
    return _local_origin(store.ensure_listen())


def _local_origin(listen: str) -> str:
    host, _, port = listen.rpartition(":")
    if host in {ANY_HOST, "::", ""}:
        host = LOCALHOST
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{port}"


def _service_or_none() -> Service | None:
    try:
        return detect_service()
    except ServiceError:
        return None


ANY_HOST = "0.0.0.0"  # noqa: S104 - only when the user picks it
ACCESS_MODES = {
    "1": "本机 / SSH",
    "2": "网络直连",
    "3": "Cloudflare Tunnel",
}


def _valid_setup_port(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9]{4,5}", value)) and 1024 <= int(value) <= 65535


def _ask_address(io: Console, data: dict[str, Any]) -> tuple[str, str | None]:
    """Ask who may connect and the port. Defaults: the current values, QUANTBOT_PORT,
    or this machine only on a free random port."""
    current = str(data.get("listen") or "")
    current_host, _, current_port = current.rpartition(":") if current else ("", "", "")
    for key, label in ACCESS_MODES.items():
        io.say(f"  {key}. {label}")
    default_mode = "3" if data.get("web_tunnel") else "2" if current_host == ANY_HOST else "1"
    while True:
        picked = io.ask("访问方式", default_mode)
        if picked in ACCESS_MODES:
            break
        io.status("warn", "请输入 1、2 或 3。")
    host = ANY_HOST if picked == "2" else LOCALHOST
    default = current_port or os.environ.get("QUANTBOT_PORT") or str(free_port())
    while True:
        typed = io.ask("监听端口", default)
        if not _valid_setup_port(typed):
            io.status("warn", "端口范围为 1024 到 65535。")
            continue
        # The current port may be held by the running QuantBot itself; it frees it on restart.
        if typed != current_port and not port_free(int(typed), host):
            io.status("warn", f"端口 {typed} 已被占用，请选择其他端口。")
            continue
        listen = f"{host}:{int(typed)}"
        break
    if picked != "3":
        return listen, None
    while True:
        address = io.ask("Tunnel 的 HTTPS 地址", str(data.get("public_url") or ""))
        try:
            public_url = check_public_url(address)
            if not public_url or not public_url.startswith("https://"):
                raise ConfigError("请填写 Tunnel 的 HTTPS 地址，例如 https://bot.example.com。")
            return listen, public_url
        except ConfigError as exc:
            io.status("warn", str(exc))


def _ask_admin(
    io: Console, data: dict[str, Any], *, generate: bool = False
) -> tuple[dict[str, str], str | None]:
    from quantbot.web import MIN_PASSWORD, USERNAME, hash_password

    old = data.get("web_admin") or {}
    while True:
        username = io.ask("管理员用户名", str(old.get("username") or "admin"))
        if USERNAME.match(username):
            break
        io.status("warn", "用户名可用字母、数字、下划线、点和连字符，最多 32 个字符。")
    if old.get("password"):
        hint = "，回车保留当前密码"
    else:
        hint = "，回车生成初始密码" if generate else ""
    while True:
        password = io.secret(f"管理员密码（至少 {MIN_PASSWORD} 位{hint}）")
        if not password:
            if old.get("password"):
                return {"username": username, "password": str(old["password"])}, None
            if generate:
                initial = new_token()
                return {"username": username, "password": hash_password(initial)}, initial
        if len(password) < MIN_PASSWORD:
            io.status("warn", f"密码至少 {MIN_PASSWORD} 位。")
            continue
        if io.secret("确认管理员密码") != password:
            io.status("warn", "两次输入不一致，请重新输入。")
            continue
        return {"username": username, "password": hash_password(password)}, None


def _ask_telegram(
    io: Console, api: Api, data: dict[str, Any]
) -> tuple[dict[str, Any] | None, str | None, str]:
    """Bot token and owner, then quiet hours. Returns (telegram, quiet, time zone)."""
    old = data.get("telegram") or {}
    io.status("note", "可在 Telegram 向 @BotFather 发送 /newbot 创建机器人。")
    while True:
        token = io.secret("Telegram Bot Token" + ("（回车保留）" if old.get("token") else ""))
        token = token or str(old.get("token") or "")
        if not BOT_TOKEN.match(token):
            io.status("warn", "Bot Token 格式无效，请检查 @BotFather 提供的令牌。")
            continue
        try:
            me = api(token, "getMe")
        except TelegramError as exc:
            io.status("warn", str(exc))
            continue
        username = me.get("username", "")
        io.status("ok", f"已验证 Telegram 机器人 @{username}。")
        break
    owner, owner_name = _find_owner(io, api, token, username, old)
    while True:
        quiet = io.ask("静音时段（例如 23-07，输入 - 清除）", str(data.get("quiet_hours") or "-"))
        quiet = "" if quiet == "-" else quiet
        try:
            parse_quiet(quiet)
            timezone = check_timezone(io.ask("时区", str(data.get("timezone") or "Asia/Shanghai")))
            break
        except (ValueError, ConfigError) as exc:
            io.status("warn", str(exc))
    telegram = {
        "token": token,
        "owner_id": owner,
        "owner_name": owner_name,
        "bot_username": username,
    }
    return telegram, quiet or None, timezone


def _unattended_admin(data: dict[str, Any]) -> dict[str, str] | None:
    from quantbot.web import MIN_PASSWORD, USERNAME, hash_password

    password = os.environ.get("QUANTBOT_ADMIN_PASSWORD")
    if (data.get("web_admin") or {}).get("password") or password is None:
        return None
    username = os.environ.get("QUANTBOT_ADMIN_USERNAME", "admin")
    if not USERNAME.fullmatch(username):
        raise Abort("QUANTBOT_ADMIN_USERNAME 应为 1 到 32 个字母、数字、下划线、点或连字符。")
    if len(password) < MIN_PASSWORD:
        raise Abort(f"QUANTBOT_ADMIN_PASSWORD 至少需要 {MIN_PASSWORD} 位。")
    return {"username": username, "password": hash_password(password)}


def _ask_shortcut(io: Console) -> tuple[ShortCommand | None, bool]:
    try:
        shortcut = ShortCommand.detect()
    except ConfigError:
        io.status("note", "安装后可用 quantbot alias enable 启用短命令 qb。")
        return None, False
    if conflict := shortcut.conflict():
        io.status("warn", f"qb 已被占用（{conflict}），使用 quantbot。")
        return None, False
    return shortcut, io.confirm("启用短命令 qb", default=shortcut.enabled())


def _apply_shortcut(io: Console, shortcut: ShortCommand | None, enable: bool) -> str:
    if shortcut is None:
        try:
            existing = ShortCommand.detect()
            return "quantbot / qb" if existing.enabled() and not existing.conflict() else "quantbot"
        except ConfigError:
            return "quantbot"
    try:
        if enable:
            shortcut.enable()
        else:
            shortcut.disable()
    except ConfigError as exc:
        io.status("warn", str(exc))
    return "quantbot / qb" if shortcut.enabled() and not shortcut.conflict() else "quantbot"


def _start_setup_service(store: Store, io: Console, service: Service | None) -> str:
    if service is None:
        return "跳过启动"
    try:
        if service.installed():
            io.status("step", "正在重启后台服务。")
            service.restart()
        else:
            io.status("step", "正在安装并启动后台服务。")
            for note in service.install(executable(), store.dir.resolve()):
                io.status("warn", note)
        io.status("step", "正在等待本机健康检查。")
        wait_until_ready(_local_origin(store.ensure_listen({})))
    except (ServiceError, OSError) as exc:
        io.status("error", str(exc))
        return "未就绪"
    io.status("ok", "后台服务已就绪。")
    return "已就绪"


def _setup_result(
    store: Store, io: Console, service_state: str, entry: str, initial: str | None
) -> int:
    data = store.read()
    listen = store.ensure_listen({})
    host, _, port = listen.rpartition(":")
    public_url = check_public_url(data.get("public_url"))
    if public_url:
        address = f"{public_url}/ui/"
    elif host in {ANY_HOST, "::"}:
        address = f"http://<服务器 IP 或域名>:{port}/ui/"
    else:
        address = f"{_local_origin(listen)}/ui/"

    admin = data.get("web_admin") or {}
    io.section("安装结果" if service_state == "已就绪" else "配置结果")
    io.rows(
        [
            ("版本", installed().label),
            ("后台服务", service_state),
            ("网页地址" if service_state == "已就绪" else "启动后访问", address),
            ("管理员", str(admin.get("username") or "待设置")),
            ("命令入口", entry),
            ("配置文件", str(store.path)),
        ]
    )
    if initial:
        io.reveal("初始密码", initial)
        io.status("note", "请保存初始密码。之后可用 quantbot password 重设。")
    elif not admin.get("password"):
        io.status(
            "note", "运行 quantbot password 设置管理员，或用 quantbot web 获取一次性登录链接。"
        )

    if data.get("web_tunnel") and public_url:
        io.status("note", f"Cloudflare Tunnel 源站  http://127.0.0.1:{port}")
    elif host in {ANY_HOST, "::"}:
        io.status("note", f"直连使用 HTTP。请在防火墙或云安全组放行 TCP {port}。")
    elif host == LOCALHOST:
        io.status("note", f"远程访问  ssh -L {port}:127.0.0.1:{port} <服务器>")

    if service_state == "跳过启动":
        io.rows([("前台启动", "quantbot run"), ("后台启动", "quantbot service install")])
    else:
        io.rows([("查看状态", "quantbot service status"), ("查看日志", "quantbot logs -f")])
    if service_state == "未就绪":
        io.status("note", "配置已保存。排查后运行 quantbot service install 重试。")
        return 1
    if not data.get("strategies"):
        io.rows([("接入策略", "在策略项目目录运行 quantbot link")])
    return 0


def cmd_setup(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    current = store.read()
    service = None if args.no_service else _service_or_none()
    installed_service = service is not None and service.installed()
    configured = bool(current.get("setup_done") or (current.get("telegram") or {}).get("token"))
    unattended = args.non_interactive or (args.if_needed and configured and not io.interactive())
    if not unattended and not io.interactive():
        raise Abort("请在终端交互运行 quantbot setup，或加上 --non-interactive。")

    if args.if_needed and configured:
        io.status("note", "已读取现有配置。")
        initial = None
        if (current.get("web_admin") or {}).get("password"):
            admin = None
        elif unattended:
            admin = _unattended_admin(current)
        else:
            io.section("配置网页管理员")
            admin, initial = _ask_admin(io, current, generate=True)
        if admin:
            with store.edit() as data:
                if (data.get("web_admin") or {}).get("password"):
                    raise Abort("管理员账号已由其他进程配置，请重新运行。")
                set_web_admin(data, admin)
            io.status("ok", "已保存网页管理员配置。")
        state = _start_setup_service(store, io, service if installed_service else None)
        return _setup_result(store, io, state, _apply_shortcut(io, None, False), initial)

    if unattended:
        admin = _unattended_admin(current)
        with store.edit() as data:
            if not data.get("listen"):
                port = os.environ.get("QUANTBOT_PORT") or str(free_port())
                if not _valid_setup_port(port):
                    raise Abort("QUANTBOT_PORT 必须在 1024 到 65535 之间。")
                if not port_free(int(port), LOCALHOST):
                    raise Abort(f"端口 {port} 已被占用。")
                data["listen"] = f"{LOCALHOST}:{int(port)}"
            if admin and not (data.get("web_admin") or {}).get("password"):
                set_web_admin(data, admin)
            data["setup_done"] = True
        io.status("ok", "已保存非交互式配置。")
        state = _start_setup_service(store, io, service)
        return _setup_result(store, io, state, _apply_shortcut(io, None, False), None)

    io.section("QuantBot 配置向导")
    io.status("note", "回车接受方括号中的默认值。")
    io.section("1/5  网页访问")
    listen, public_url = _ask_address(io, current)

    io.section("2/5  网页管理员")
    admin, initial = _ask_admin(io, current, generate=True)

    io.section("3/5  通知与心跳")
    telegram = None
    quiet, timezone = current.get("quiet_hours"), str(current.get("timezone") or "Asia/Shanghai")
    if io.confirm("连接 Telegram", default=bool((current.get("telegram") or {}).get("token"))):
        telegram, quiet, timezone = _ask_telegram(io, api, current)
    heartbeat = current.get("heartbeat_url")
    while True:
        hint = "回车保留，输入 - 清除" if heartbeat else "回车跳过"
        value = io.secret(f"Healthchecks.io 心跳地址（{hint}）")
        try:
            heartbeat = check_url(None if value == "-" else value or heartbeat)
            break
        except ConfigError as exc:
            io.status("warn", str(exc))

    io.section("4/5  后台服务")
    if installed_service:
        io.status("note", "已安装后台服务，应用配置后会重启。")
        start = True
    elif service is not None:
        start = io.confirm("安装并启动后台服务")
    else:
        start = False
        io.status("note", "本次仅配置。可通过 quantbot run 前台启动。")

    io.section("5/5  命令入口")
    shortcut, enable_alias = _ask_shortcut(io)

    io.section("确认配置")
    mode = "3" if public_url else "2" if listen.startswith(f"{ANY_HOST}:") else "1"
    rows = [
        ("访问方式", ACCESS_MODES[mode]),
        ("监听地址", listen),
        ("管理员", admin["username"]),
        ("密码", "自动生成" if initial else "已填写或保留"),
        ("Telegram", f"@{telegram['bot_username']}" if telegram else "未配置"),
        ("心跳", "已配置" if heartbeat else "未配置"),
        ("后台服务", "启动并检查" if start else "跳过启动"),
        ("短命令 qb", "启用" if enable_alias else "跳过"),
    ]
    if public_url:
        rows.insert(2, ("Tunnel 地址", f"{public_url}/ui/"))
    io.rows(rows)
    if not io.confirm("应用以上配置"):
        io.status("note", "已取消配置。")
        return 1

    with store.edit() as data:
        if any(data.get(key) != current.get(key) for key in ("web_admin", "listen")):
            raise Abort("配置已由其他进程更新，请重新运行 quantbot setup。")
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
        signed_out = set_web_admin(data, admin) and configured
    io.status("ok", "配置已保存。")
    if port_changed and data["strategies"]:
        io.status("note", "请更新现有策略的连接地址并重启策略进程。")
    if signed_out:
        io.status("note", "管理员凭据已更新，网页会话需要重新登录。")
    if telegram:
        try:
            api(
                telegram["token"],
                "sendMessage",
                chat_id=telegram["owner_id"],
                text="✅ QuantBot 配置好了。发 /menu 看所有策略。",
            )
            io.status("ok", "已发送 Telegram 测试消息。")
        except TelegramError as exc:
            io.status("warn", f"Telegram 测试消息发送失败。{exc}")
    entry = _apply_shortcut(io, shortcut, enable_alias)
    state = _start_setup_service(store, io, service if start else None)
    return _setup_result(store, io, state, entry, initial)


def cmd_password(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    if not store.exists():
        raise Abort("还没设置。先运行：quantbot setup")
    if not io.interactive():
        raise Abort("要在终端里交互运行：quantbot password")
    data = store.read()
    io.section("网页管理员")
    admin, _ = _ask_admin(io, data)
    with store.edit() as fresh:
        if fresh.get("web_admin") != data.get("web_admin"):
            raise Abort("管理员账号已变更，请重试。")
        if not set_web_admin(fresh, admin):
            io.say("没有改动。")
            return 0
    from quantbot.audit import Audit

    Audit(store.dir).write("password", user="cli", ok=True, result="改了网页管理员账号")
    io.status("ok", "已更新管理员账号。网页会话需要重新登录。")
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
        if io.confirm(f"保留 Telegram 管理员 {name}（ID {old['owner_id']}）"):
            return int(old["owner_id"]), str(old.get("owner_name") or "")
    while True:
        typed = io.ask(f"管理员 ID，或向 @{username} 发送消息后按回车")
        if re.fullmatch(r"-?[0-9]{1,20}", typed):
            return int(typed), ""
        if typed:
            io.status("warn", "管理员 ID 必须为数字。")
            continue
        try:
            found = _wait_for_message(io, api, token)
        except TelegramError as exc:
            if exc.code == 409:
                io.status("warn", "该机器人已有接收进程，请直接输入管理员 ID。")
            else:
                io.status("warn", str(exc))
            continue
        if found is None:
            io.status("warn", f"{OWNER_WAIT} 秒内未收到 Telegram 消息。")
            continue
        uid, name = found
        if io.confirm(f"授权 {name}（ID {uid}）为 Telegram 管理员"):
            return uid, name


def _wait_for_message(io: Console, api: Api, token: str) -> tuple[int, str] | None:
    io.status("step", "等待 Telegram 消息。")
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
    if strategy_item(store.read(), sid):
        raise Abort(f"已经有 {sid} 了。看它的 token：quantbot token {sid}")
    name = args.name or (io.ask("显示名称", sid) if io.interactive() else sid)
    with store.edit() as data:
        token = add_strategy(data, sid, name)["token"]
    io.status("ok", f"已添加策略 {name}（{sid}）。")
    io.say()
    io.say(f"  QB_URL={api_url(store)}")
    io.say(f"  QB_TOKEN={token}")
    io.say()
    io.status("note", "连接配置会在几秒内生效。")
    io.say("运行 quantbot web 获取网页登录链接。")
    return 0


def cmd_list(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    data = store.read()
    telegram_set = data.get("telegram") or {}
    owner = telegram_set.get("owner_name") or telegram_set.get("owner_id")
    rows = [("Telegram", f"管理员 {owner}" if owner else "未配置")]
    if data.get("listen"):
        rows.append(("监听地址", str(data["listen"])))
    io.rows(rows)
    items = store.strategies(data)
    if not items:
        io.status("note", "暂无策略。运行 quantbot add <id> --name <名称> 添加。")
        return 0
    width = max(len(s.id) for s in items)
    io.section(f"已注册策略（{len(items)}）")
    for s in items:
        io.say(f"  {s.id.ljust(width)}  {s.name}")
    return 0


def cmd_token(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    item = require_strategy(store.read(), args.id)
    if args.new:
        if not args.yes and not io.confirm(
            "旧 token 会马上失效，策略要换上新的才能连上。继续吗？", False
        ):
            return 1
        with store.edit() as data:
            item = require_strategy(data, args.id)
            item["token"] = new_token()
        io.status("ok", f"已为 {args.id} 换发连接令牌。")
    io.say(f"QB_TOKEN={item['token']}")
    return 0


def cmd_rename(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    with store.edit() as data:
        require_strategy(data, args.id)["name"] = args.name
    io.status("ok", f"已将 {args.id} 的显示名称更新为 {args.name}。")
    return 0


def cmd_remove(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    item = require_strategy(store.read(), args.id)
    if not args.yes and not io.confirm(
        f"删除 {item.get('name')}（{args.id}）？它的 token 会失效。", False
    ):
        return 1
    with store.edit() as data:
        data["strategies"].remove(require_strategy(data, args.id))
    io.status("ok", f"已移除策略 {args.id}，连接令牌已撤销。")
    io.status("note", "可在策略所在的服务器上单独停止进程。")
    return 0


detect_service: Callable[[], Service] = Service.detect


def cmd_service(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    service = detect_service()
    if args.action == "install":
        if args.port is not None or args.listen:
            _set_listen(store, io, args.port, args.listen)
        listen = store.ensure_listen()
        notes = service.install(executable(), store.dir.resolve())
        io.status("ok", "已注册后台服务并提交启动请求。")
        io.rows(
            [
                ("监听地址", listen),
                ("自动启动", "登录时" if service.kind == "launchd" else "开机时"),
                ("服务文件", str(service.path)),
            ]
        )
        for note in notes:
            io.say(f"  {note}")
        io.status("note", "查看日志  quantbot logs -f")
        if not (store.read().get("web_admin") or {}).get("password"):
            io.say("  运行 quantbot setup 设置网页管理员，或运行 quantbot web 获取登录链接。")
    elif args.action == "uninstall":
        service.uninstall()
        io.status("ok", "后台服务已停止并卸载。")
    elif args.action == "restart":
        service.restart()
        io.status("ok", "已提交后台服务重启请求。")
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
    with store.edit() as data:
        if data.get("listen") == new:
            return
        host, _, port_text = new.rpartition(":")
        if not port_free(int(port_text), "0.0.0.0" if host == "0.0.0.0" else LOCALHOST):  # noqa: S104
            raise Abort(f"端口 {port_text} 已经被别的程序占用，换一个")
        data["listen"] = new
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
        io.status("ok", "当前已是最新版本。")
        return 0
    count = result["behind"]
    io.status("note", f"有新版本（{count} 个新提交）。" if count else "有新版本。")
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
    io.status("step", "正在安装 QuantBot 更新。")
    ok, output = updater.upgrade()
    if not ok:
        raise Abort(f"更新失败。{output}")
    service = _service_or_none()
    if service is not None and service.installed():
        service.restart()
        io.status("ok", "QuantBot 已更新，后台服务已重启。")
    else:
        io.status("ok", "QuantBot 已更新。")
        io.status("note", "前台进程可通过 quantbot run 重新启动。")
    return 0


def cmd_editor(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    if args.action == "on":
        if not args.root:
            raise Abort("请选择策略目录：quantbot editor on --root ~/strategies")
        root = Editor.enable(store.dir, args.root)
        io.status("ok", "网页策略编辑器已启用。")
        io.rows([("编辑目录", str(root))])
    elif args.action == "off":
        with editor_lock(store.dir):
            Store(store.dir, filename=EDITOR_FILE).path.unlink(missing_ok=True)
        io.status("ok", "网页策略编辑器已关闭。")
    else:
        editor = Editor.configured(store.dir)
        io.say(f"编辑目录：{editor.root}" if editor else "网页策略编辑器已关闭。")
    return 0


def cmd_editor_github(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    github = GitHubEditor(store.dir)
    action = args.github_action
    if action == "bind":
        flow = github.begin(args.repo, args.branch, args.client_id)
        prompt = flow.prompt()
        io.say(f"打开 {prompt['url']}，输入验证码 {prompt['code']}。")
        while (status := github.poll(flow)) is None:
            time.sleep(flow.interval)
        io.status("ok", "已绑定 GitHub 仓库。")
    elif action == "unbind":
        github.unbind()
        io.status("ok", "已解除 GitHub 仓库绑定。")
        return 0
    elif action == "status":
        status = github.status()
    else:
        if action in {"pull", "push"} and not args.yes:
            if not io.interactive():
                raise Abort("请在终端确认，或加上 --yes。")
            label = "拉取远端提交" if action == "pull" else "推送本地已有提交"
            if not io.confirm(f"{label}？", default=False):
                return 0
        status = github.sync(action)
    if not status["bound"]:
        io.status("note", "尚未绑定 GitHub 仓库。")
    elif status.get("error"):
        raise Abort(status["error"])
    else:
        io.say(f"{status['repo']} · {status['branch']}")
        io.say(f"领先 {status['ahead']}，落后 {status['behind']}。")
        if status["dirty"]:
            io.say("本地有未提交的改动。")
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
    io.section("接入策略")
    io.rows([("项目目录", str(project))])
    io.section("1/3  策略信息")
    while True:
        try:
            sid = check_strategy_id(io.ask("     策略 id", args.name or project_name(project)))
            break
        except ConfigError as exc:
            io.status("warn", str(exc))
    item = strategy_item(data, sid)
    name = io.ask("     策略显示名称", str(item["name"]) if item else sid)
    with store.edit() as data:
        item = strategy_item(data, sid)
        if item is None:
            add_strategy(data, sid, name)
        else:
            item["name"] = name
    if item:
        io.status("note", f"策略 {sid} 已注册，使用现有连接令牌。")
    else:
        io.status("ok", f"已注册策略 {name}（{sid}）。")

    io.section("2/3  安装策略客户端")
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
        io.status("warn", f"请输入 1 到 {len(choices)}。")
    if how == "uv":
        if subprocess.call(["uv", "add", CLIENT_REQUIREMENT], cwd=project):  # noqa: S603, S607
            raise Abort("uv add 失败，见上面的输出。可以重新运行 quantbot link 选复制文件。")
        io.status("ok", "已通过 uv 安装策略客户端。")
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
        io.status("ok", "已更新 requirements.txt。")
        io.status("note", "在策略环境执行 pip install -r requirements.txt。")
    else:
        target = project / "quantbot_client.py"
        source = client_source()
        if target.exists() and target.read_text("utf-8") != source:
            if not io.confirm("     quantbot_client.py 已存在，换成新版吗？"):
                source = ""
        if source:
            target.write_text(source, "utf-8")
            io.status("ok", "已复制 quantbot_client.py。")

    io.section("3/3  将客户端接入策略代码")
    io.say()
    for line in (
        "from quantbot_client import QuantBot",
        "",
        f'qb = QuantBot("{sid}")',
        "with qb:",
        "    while not qb.stopping:",
        "        ...                          # 你的一轮交易，下开仓单前看 qb.can_open()",
        '        qb.status("净值 10000")       # 更新控制台里的策略状态',
        "        if not qb.sleep(60):         # 等的时候也在响应按钮",
        "            break",
    ):
        io.say(f"    {line}")
    io.say()
    io.rows(
        [
            ("运行策略", f"cd {shlex.quote(str(project))} && {run_command(project)}"),
            ("AI 接入说明", f"quantbot prompt {sid}"),
        ]
    )
    io.status("note", "本机客户端会自动读取连接配置。连接后可在网页或 Telegram /menu 查看策略。")
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


def cmd_alias(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    shortcut = ShortCommand.detect()
    if args.action == "enable":
        shortcut.enable()
        io.status("ok", "已启用短命令 qb。")
        io.rows([("命令路径", str(shortcut.path)), ("用法", "qb --help")])
    elif args.action == "disable":
        shortcut.disable()
        io.status("ok", "已停用 QuantBot 的短命令 qb。")
    elif conflict := shortcut.conflict():
        io.status("warn", f"命令 qb 已被占用（{conflict}）。")
    elif shortcut.enabled():
        io.status("ok", "已启用短命令 qb。")
        io.rows([("命令路径", str(shortcut.path))])
    else:
        io.status("note", "短命令 qb 未启用。运行 quantbot alias enable 启用。")
    return 0


def cmd_run(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    from quantbot.bot import serve

    return serve(store)


# --------------------------------------------------------------------- main


def parser(io: Console | None = None) -> argparse.ArgumentParser:
    io = io or Console()
    p = argparse.ArgumentParser(
        prog="qb" if Path(sys.argv[0]).name == "qb" else "quantbot",
        usage="%(prog)s [选项] [命令 ...]",
        description="QuantBot · 量化策略控制台",
        add_help=False,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    options = p.add_argument_group("选项")
    options.add_argument("-h", "--help", action="help", help="显示帮助")
    options.add_argument(
        "--version",
        action="version",
        version=f"quantbot {installed().label}",
        help="显示版本与提交",
    )
    sub = p.add_subparsers(prog=p.prog, dest="command", metavar="命令", help=argparse.SUPPRESS)
    sub.add_parser("run", description="在前台运行 QuantBot").set_defaults(fn=cmd_run)
    setup = sub.add_parser("setup", description="交互式配置访问、管理员与通知")
    setup.add_argument(
        "--if-needed", action="store_true", help="已有配置时仅补齐管理员并重启后台服务"
    )
    setup.add_argument("--non-interactive", action="store_true", help="使用默认值，跳过交互问答")
    setup.add_argument("--no-service", action="store_true", help="只保存配置，跳过服务启动")
    setup.set_defaults(fn=cmd_setup)
    service = sub.add_parser("service", description="安装、卸载、重启或查看后台服务")
    service.add_argument("action", choices=["install", "uninstall", "restart", "status"])
    service.add_argument("--port", type=int, help="端口，默认第一次安装时随机选一个空闲的")
    service.add_argument("--listen", help="完整监听地址，例如 0.0.0.0:23456（让别的机器也能连）")
    link = sub.add_parser("link", description="为策略项目安装客户端并接入 QuantBot")
    link.add_argument("path", nargs="?", default=".", help="项目文件夹，默认当前文件夹")
    link.add_argument("--name", help="策略 id，默认用文件夹名")
    link.set_defaults(fn=cmd_link)
    prompt = sub.add_parser("prompt", description="输出给 AI 的策略接入说明")
    prompt.add_argument("id", nargs="?", help="策略 id，默认用当前文件夹名")
    prompt.add_argument("--name", help="显示名称")
    prompt.set_defaults(fn=cmd_prompt)
    update = sub.add_parser("update", description="检查版本或安装更新")
    update.add_argument("--check", action="store_true", help="只检查，不安装")
    update.add_argument("--yes", action="store_true", help="直接安装，无需确认")
    update.set_defaults(fn=cmd_update)
    editor = sub.add_parser("editor", description="管理策略编辑器与 GitHub 同步")
    editor.set_defaults(fn=cmd_editor)
    editor_actions = editor.add_subparsers(dest="action", required=True)
    enable = editor_actions.add_parser("on", help="开启编辑器并选择目录")
    enable.add_argument("--root", help="允许网页编辑的策略目录")
    editor_actions.add_parser("off", help="关闭编辑器")
    editor_actions.add_parser("status", help="查看编辑目录")
    github = editor_actions.add_parser("github", help="绑定 GitHub 策略仓库并同步")
    github.set_defaults(fn=cmd_editor_github)
    github_actions = github.add_subparsers(dest="github_action", required=True)
    bind = github_actions.add_parser("bind", help="用 GitHub 设备授权绑定仓库")
    bind.add_argument("--repo", required=True, help="GitHub 仓库名，例如 owner/strategy")
    bind.add_argument("--branch", default="", help="分支，默认使用本地分支或仓库默认分支")
    bind.add_argument("--client-id", default="", help="GitHub App Client ID")
    github_actions.add_parser("status", help="查看绑定和本地状态")
    github_actions.add_parser("check", help="检查远端状态")
    github_actions.add_parser("unbind", help="解除绑定")
    for action, label in (("pull", "拉取远端提交"), ("push", "推送本地已有提交")):
        sync = github_actions.add_parser(action, help=label)
        sync.add_argument("--yes", action="store_true", help="无需确认")
    sub.add_parser("web", description="打印一次性的网页登录链接").set_defaults(fn=cmd_web)
    sub.add_parser("password", description="改网页管理员的用户名和密码").set_defaults(
        fn=cmd_password
    )
    shortcut = sub.add_parser("alias", description="启用、停用或查看短命令 qb")
    shortcut.add_argument("action", choices=["enable", "disable", "status"])
    shortcut.set_defaults(fn=cmd_alias)
    service.set_defaults(fn=cmd_service)
    logs = sub.add_parser("logs", description="看后台服务的日志")
    logs.add_argument("-f", "--follow", action="store_true", help="一直看新日志")
    logs.set_defaults(fn=cmd_logs)
    add = sub.add_parser("add", description="注册策略并生成连接令牌")
    add.add_argument("id", help="例如 momentum")
    add.add_argument("--name", help="策略显示名称")
    add.set_defaults(fn=cmd_add)
    sub.add_parser("list", description="列出策略").set_defaults(fn=cmd_list)
    token = sub.add_parser("token", description="查看或换发策略连接令牌")
    token.add_argument("id")
    token.add_argument("--new", action="store_true", help="换一个新 token，旧的马上失效")
    token.add_argument("--yes", action="store_true", help="不再确认")
    token.set_defaults(fn=cmd_token)
    rename = sub.add_parser("rename", description="改策略的显示名称")
    rename.add_argument("id")
    rename.add_argument("name")
    rename.set_defaults(fn=cmd_rename)
    remove = sub.add_parser("remove", description="移除策略并撤销连接令牌")
    remove.add_argument("id")
    remove.add_argument("--yes", action="store_true", help="不再确认")
    remove.set_defaults(fn=cmd_remove)

    groups = (
        ("访问与设置", ("setup", "web", "password", "alias")),
        ("服务运维", ("run", "service", "logs")),
        ("策略管理", ("list", "add", "link", "prompt", "rename", "token", "remove")),
        ("编辑与同步", ("editor",)),
        ("版本更新", ("update",)),
    )
    sections = []
    for title, names in groups:
        commands = [f"  {name:<10} {sub.choices[name].description}" for name in names]
        sections.append("\n".join([io.styled(title, "1;36"), *commands]))
    p.epilog = "\n\n".join(sections)
    return p


def main(
    argv: list[str] | None = None,
    io: Console | None = None,
    api: Api = telegram,
    store: Store | None = None,
) -> int:
    io = io or Console()
    args = parser(io).parse_args(argv)
    fn = getattr(args, "fn", cmd_run)
    store = store or Store(data_dir())
    try:
        code = int(fn(store, io, api, args))
        if code == 0 and args.command in {"list", "link", "web", "setup"}:
            update = Updater(store.dir).cached()
            if update and update.get("available"):
                io.status("note", "有新版本，运行 quantbot update 查看。")
        return code
    except (Abort, ConfigError, OSError, ServiceError) as exc:
        io.status("error", str(exc))
        return 1
    except KeyboardInterrupt:
        io.say()
        io.status("note", "已取消。")
        return 130


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    sys.exit(main())
