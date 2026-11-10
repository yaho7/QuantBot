"""The `quantbot` command: setup and strategy management in the terminal.

docker compose exec quantbot quantbot setup
docker compose exec quantbot quantbot add momentum --name 动量策略
docker compose exec quantbot quantbot list
"""

from __future__ import annotations

import argparse
import getpass
import json
import logging
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

from quantbot import __version__
from quantbot.config import (
    BOT_TOKEN,
    ConfigError,
    Store,
    check_strategy_id,
    check_timezone,
    check_url,
    data_dir,
    new_token,
)
from quantbot.notices import parse_quiet

API_URL = "http://quantbot:8080"
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


def cmd_setup(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    if not io.interactive():
        raise Abort("setup 要在终端里交互运行：docker compose exec quantbot quantbot setup")
    data = store.read()
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
    io.say()
    io.say(f"✓ 已保存。{sent}")
    if changed:
        io.say("  正在运行的 QuantBot 会在几秒内自动重启，用上新设置。")
    if not data["strategies"]:
        io.say("  下一步，添加一个策略：quantbot add <id> --name <名字>")
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
    io.say(f"  QB_URL={API_URL}")
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


def cmd_run(store: Store, io: Console, api: Api, args: argparse.Namespace) -> int:
    from quantbot.bot import serve

    return serve(store)


# --------------------------------------------------------------------- main


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="quantbot", description="一个 Telegram bot 管理所有量化程序")
    p.add_argument("--version", action="version", version=f"quantbot {__version__}")
    sub = p.add_subparsers(dest="command", metavar="命令")
    sub.add_parser("run", help="运行 QuantBot（容器默认就是这个）").set_defaults(fn=cmd_run)
    sub.add_parser("setup", help="设置 Telegram bot、你的账号和静音时段").set_defaults(fn=cmd_setup)
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
    except (Abort, ConfigError) as exc:
        io.say(f"✗ {exc}")
        return 1
    except KeyboardInterrupt:
        io.say("\n已取消。")
        return 130


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    sys.exit(main())
