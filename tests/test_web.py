"""Login links, the session cookie and the page API."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from aiohttp.test_utils import TestClient, TestServer

from quantbot.audit import Audit
from quantbot.config import Store, StrategyConfig
from quantbot.core import Core
from quantbot.hub import Hub
from quantbot.server import make_app
from quantbot.web import COOKIE, Feed, WebAuth, add_routes, login_url, read_audit, static_dir

SECRET = "s" * 32
BOT = "123456789:" + "A" * 35
NEW_BOT = "987654321:" + "B" * 35


class FakeTelegram:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def __call__(self, token: str, method: str, **params: Any) -> Any:
        from quantbot.cli import TelegramError

        self.calls.append((token, method, params))
        if token not in {BOT, NEW_BOT}:
            raise TelegramError("Unauthorized", 401)
        if method == "sendMessage" and params.get("chat_id") == 999:
            raise TelegramError("chat not found", 400)
        return {"username": "new_bot"} if method == "getMe" else {}


CSRF = {"X-QuantBot": "1"}


class Clock:
    now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


def test_link_is_single_use_and_expires() -> None:
    clock = Clock()
    auth = WebAuth(SECRET, clock)
    token = auth.link_token()
    cookie = auth.redeem(token)
    assert cookie and auth.valid(cookie)
    assert auth.redeem(token) is None  # once only
    late = auth.link_token()
    clock.now += 301
    assert auth.redeem(late) is None
    assert auth.redeem("1.2.3") is None and auth.redeem("junk") is None
    assert not WebAuth("other" * 8, clock).valid(cookie)  # a new secret signs everyone out
    clock.now += 12 * 3600
    assert not auth.valid(cookie)
    assert not auth.valid("") and not auth.valid("1.abc")


def test_login_url_and_secret(tmp_path: Path) -> None:
    assert login_url("0.0.0.0:23456", "x") == "http://127.0.0.1:23456/ui/login?t=x"
    store = Store(tmp_path)
    secret = store.web_secret()
    assert len(secret) >= 32 and store.web_secret() == secret


def test_read_audit_newest_first(tmp_path: Path) -> None:
    path = tmp_path / "audit.jsonl"
    path.write_text('{"action": "pause"}\nbroken\n{"action": "flatten"}\n')
    assert [r["action"] for r in read_audit(path, 10)] == ["flatten", "pause"]
    assert read_audit(path, 1) == [{"action": "flatten"}]
    assert read_audit(tmp_path / "missing", 5) == []


def scenario(
    test: Callable[[Hub, WebAuth, Feed, TestClient], Awaitable[None]], audit: Path
) -> None:
    async def main() -> None:
        hub = Hub((StrategyConfig("momentum", "动量", "m" * 20),), lambda *n: None)
        core = Core(hub, Audit(audit.parent), owner_id=42, notify=lambda *n: None)
        auth, feed = WebAuth(SECRET), Feed()
        store = Store(audit.parent / "settings")
        store.write({"telegram": {"token": BOT, "owner_id": 42, "bot_username": "old_bot"}})
        app = make_app(hub, lambda a: add_routes(a, core, auth, feed, audit, store, FakeTelegram()))
        async with TestClient(TestServer(app)) as client:
            await test(hub, auth, feed, client)

    asyncio.run(main())


def test_api_needs_the_cookie_and_returns_strategies(tmp_path: Path) -> None:
    audit = tmp_path / "audit.jsonl"
    audit.write_text(json.dumps({"action": "pause", "strategy": "momentum", "ok": True}) + "\n")

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        assert (await client.get("/ui/api/overview")).status == 401
        assert (await client.get("/ui/api/audit")).status == 401
        bad = await client.get("/ui/login?t=nope", allow_redirects=False)
        assert bad.status == 403 and "链接已失效" in await bad.text()

        hub.event(hub.strategies["momentum"], {"type": "hello", "commands": ["status", "pause"]})
        hub.event(hub.strategies["momentum"], {"type": "status", "text": "净值 1", "paused": True})
        feed.add("动量", "🧾 AAPL BUY 10", "trade")

        ok = await client.get(f"/ui/login?t={auth.link_token()}", allow_redirects=False)
        assert ok.status == 302 and ok.headers["Location"] == "/ui/"
        set_cookie = ok.headers["Set-Cookie"]
        assert COOKIE in set_cookie and "HttpOnly" in set_cookie and "SameSite=Strict" in set_cookie

        body = await (await client.get("/ui/api/overview")).json()
        (s,) = body["strategies"]
        assert (s["id"], s["online"], s["paused"], s["status"]) == (
            "momentum",
            True,
            True,
            "净值 1",
        )
        assert s["commands"] == ["status", "pause"]
        assert body["feed"][0]["text"] == "🧾 AAPL BUY 10"
        records = (await (await client.get("/ui/api/audit")).json())["records"]
        assert records[0]["action"] == "pause"

        assert (await client.post("/ui/api/logout")).status == 403  # no X-QuantBot header
        assert (await client.post("/ui/api/logout", headers=CSRF)).status == 200
        assert (await client.get("/ui/api/overview")).status == 401
        # The strategy API still wants its own token, the cookie is not enough.
        assert (await client.get("/v1/commands?wait=0")).status == 401

    scenario(test, audit)


def test_password_login_and_lock(tmp_path: Path) -> None:
    from quantbot.web import LOGIN_TRIES, hash_password

    store = Store(tmp_path / "settings")

    async def login(client: TestClient, username: str, password: str) -> Any:
        r = await client.post(
            "/ui/api/login", json={"username": username, "password": password}, headers=CSRF
        )
        return r, await r.json()

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        r, body = await login(client, "admin", "whatever1")
        assert not body["ok"] and "quantbot password" in body["message"]  # no admin yet
        data = store.read()
        data["web_admin"] = {"username": "admin", "password": hash_password("right-pass")}
        store.write(data)

        no_header = await client.post("/ui/api/login", json={"username": "admin"})
        assert no_header.status == 403
        r, body = await login(client, "admin", "wrong-pass")
        assert not body["ok"] and COOKIE not in r.headers.get("Set-Cookie", "")
        assert (await client.get("/ui/api/overview")).status == 401
        r, body = await login(client, "admin", "right-pass")
        assert body["ok"] and COOKIE in r.headers["Set-Cookie"]
        assert (await client.get("/ui/api/overview")).status == 200
        client.session.cookie_jar.clear()

        for _ in range(LOGIN_TRIES):
            await login(client, "admin", "wrong-pass")
        r, body = await login(client, "admin", "right-pass")  # locked, even with the right one
        assert not body["ok"] and "分钟后再试" in body["message"]
        records = [json.loads(line) for line in (tmp_path / "audit.jsonl").read_text().splitlines()]
        assert [r["ok"] for r in records if r["action"] == "login"][:3] == [False, True, False]

    scenario(test, tmp_path / "audit.jsonl")


def test_prompt_for_ai(tmp_path: Path) -> None:
    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        assert (await client.get("/ui/api/prompt?id=momentum")).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}", allow_redirects=False)
        text = (await (await client.get("/ui/api/prompt?id=momentum")).json())["text"]
        assert 'QuantBot("momentum", display_name="动量")' in text  # the registered name
        assert "m" * 20 not in text  # never the token
        named = await client.get("/ui/api/prompt", params={"id": "grid", "name": "网格"})
        assert 'display_name="网格"' in (await named.json())["text"]
        assert (await client.get("/ui/api/prompt?id=Bad")).status == 400

    scenario(test, tmp_path / "audit.jsonl")


def test_page_is_served_and_paths_stay_inside(tmp_path: Path) -> None:
    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        root = await client.get("/", allow_redirects=False)
        assert root.status == 302 and root.headers["Location"] == "/ui/"
        page = await client.get("/ui/")
        built = (static_dir() / "index.html").is_file()
        assert page.status == (200 if built else 503)
        if built:
            assert "QuantBot" in await page.text()
            assert page.headers["Cache-Control"] == "no-store"
        sneaky = await client.get("/ui/../../pyproject.toml")
        assert "[project]" not in await sneaky.text()

    scenario(test, tmp_path / "audit.jsonl")


def test_web_command_prints_a_link(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from quantbot.service import ServiceError
    from tests.test_cli import SETUP, run

    def no_service() -> None:
        raise ServiceError("no service manager in tests")

    monkeypatch.setattr("quantbot.cli.detect_service", no_service)

    store = Store(tmp_path)
    assert run(store, ["web"])[0] == 1
    run(store, ["setup"], SETUP)
    code, io = run(store, ["web"])
    link = next(line.strip() for line in io.out if "/ui/login?t=" in line)
    assert code == 0 and link.startswith(f"http://{store.read()['listen']}/ui/login?t=")
    token = link.split("t=", 1)[1]
    assert WebAuth(store.web_secret()).redeem(token)


def test_web_actions_go_through_the_strategy_and_the_audit_log(tmp_path: Path) -> None:
    from tests.test_core import Fake

    audit = tmp_path / "audit.jsonl"

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        fake = Fake(hub, "momentum")
        serving = asyncio.create_task(fake.serve())
        await client.get(f"/ui/login?t={auth.link_token()}")
        url = "/ui/api/strategies/momentum"

        async def post(path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
            response = await client.post(f"{url}/{path}", json=body or {}, headers=CSRF)
            assert response.status == 200, await response.text()
            return await response.json()

        assert (await client.post(f"{url}/pause")).status == 403  # no header, no action
        assert not fake.paused
        assert (await post("pause"))["ok"] and fake.paused
        assert hub.strategies["momentum"].paused is True
        assert (await post("positions"))["message"] == "QQQ 10 股"
        assert (await post("orders"))["data"] == [{"id": "ord-1", "text": "卖出 QQQ 10 @ 520 止损"}]
        assert (await post("cancel", {"order_id": "ord-1"}))["ok"]
        bad = await post("set_param", {"name": "rsi_len", "value": "abc"})
        assert not bad["ok"] and "不能改成" in bad["message"]
        done = await post("set_param", {"name": "rsi_len", "value": 10})
        assert done["ok"] and done["message"] == "rsi_len：14 → 10" and fake.params["rsi_len"] == 10
        assert not (await post("manual_order", {"side": "buy", "symbol": "QQQ", "qty": -1}))["ok"]
        assert (await post("manual_order", {"side": "buy", "symbol": "qqq", "qty": 5}))["ok"]
        assert fake.ran[-1] == ("manual_order", {"side": "buy", "symbol": "QQQ", "qty": 5})
        assert (await post("flatten"))["message"] == "flatten 完成"
        everyone = await client.post("/ui/api/pause-all", headers=CSRF)
        assert "动量" in (await everyone.json())["message"]
        missing = await client.post("/ui/api/strategies/nope/pause", headers=CSRF)
        assert missing.status == 404
        unknown = await client.post(f"{url}/rm", headers=CSRF)
        assert unknown.status == 404

        records = read_audit(audit, 50)
        assert [r["action"] for r in records][::-1] == [
            "pause", "cancel", "set_param", "manual_order", "flatten", "pause_all",
        ]  # fmt: skip
        assert all(r["user"] == "web" for r in records)
        serving.cancel()

    scenario(test, audit)


def test_settings_change_the_telegram_link(tmp_path: Path) -> None:
    audit = tmp_path / "audit.jsonl"

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        store = Store(tmp_path / "settings")
        assert (await client.get("/ui/api/settings")).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}")
        shown = await (await client.get("/ui/api/settings")).json()
        assert shown["bot_username"] == "old_bot" and shown["owner_id"] == 42
        assert "token" not in shown and BOT not in json.dumps(shown)

        async def save(body: dict[str, Any]) -> dict[str, Any]:
            response = await client.post("/ui/api/settings", json=body, headers=CSRF)
            assert response.status == 200
            return await response.json()

        assert (await client.post("/ui/api/settings", json={})).status == 403
        assert not (await save({"token": "nope"}))["ok"]
        assert not (await save({"token": "111111111:" + "C" * 35}))["ok"]  # Telegram says no
        assert not (await save({"owner_id": "me"}))["ok"]
        assert not (await save({"quiet_hours": "8"}))["ok"]
        assert not (await save({"timezone": "Mars/Base"}))["ok"]
        failed = await save({"owner_id": 999})  # test message fails: nothing saved
        assert not failed["ok"] and store.read()["telegram"]["owner_id"] == 42

        done = await save({"token": NEW_BOT, "owner_id": "77", "quiet_hours": "23-07"})
        assert done["ok"] and "重启" in done["message"]
        tg = store.read()["telegram"]
        assert (tg["token"], tg["owner_id"], tg["bot_username"]) == (NEW_BOT, 77, "new_bot")
        assert store.read()["quiet_hours"] == "23-07"
        record = read_audit(audit, 1)[0]
        assert record["action"] == "settings" and record["user"] == "web"
        assert NEW_BOT not in json.dumps(record)

    scenario(test, audit)
