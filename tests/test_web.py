"""Login links, the session cookie and the page API."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path
from subprocess import CompletedProcess
from types import SimpleNamespace
from typing import Any

import pytest
from aiohttp.test_utils import TestClient, TestServer
from multidict import CIMultiDict

from quantbot.audit import Audit
from quantbot.config import Store, StrategyConfig
from quantbot.core import Core
from quantbot.editor import EDITOR_FILE, Editor
from quantbot.github import DEVICE_URL, GitHubEditor
from quantbot.hub import Hub
from quantbot.server import make_app
from quantbot.updates import Installed, Updater
from quantbot.web import COOKIE, Feed, WebAuth, add_routes, login_url, read_audit, static_dir
from quantbot.workspace import WORKSPACE_FILE, Workspace, workspace_id

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


def test_restarting_preserves_used_login_links(tmp_path: Path) -> None:
    clock = Clock()
    used = Store(tmp_path, filename="used-web-links.json")
    auth = WebAuth(SECRET, clock, used_links=used)
    link = auth.link_token()
    session = auth.redeem(link)
    restarted = WebAuth(SECRET, clock, used_links=used)
    assert restarted.valid(session)
    assert restarted.redeem(link) is None
    clock.now += 301
    assert restarted.redeem(restarted.link_token())
    assert len(used.read()) == 1


def test_read_audit_newest_first(tmp_path: Path) -> None:
    path = tmp_path / "audit.jsonl"
    path.write_text('{"action": "pause"}\nbroken\n{"action": "flatten"}\n')
    assert [r["action"] for r in read_audit(path, 10)] == ["flatten", "pause"]
    assert read_audit(path, 1) == [{"action": "flatten"}]
    assert read_audit(tmp_path / "missing", 5) == []


def scenario(
    test: Callable[[Hub, WebAuth, Feed, TestClient], Awaitable[None]], audit: Path, **options: Any
) -> None:
    async def main() -> None:
        hub = Hub((StrategyConfig("momentum", "动量", "m" * 20),), lambda *n: None)
        core = Core(hub, Audit(audit.parent), owner_id=42, notify=lambda *n: None)
        auth, feed = WebAuth(SECRET), Feed()
        store = Store(audit.parent / "settings")
        store.write({"telegram": {"token": BOT, "owner_id": 42, "bot_username": "old_bot"}})
        app = make_app(
            hub, lambda a: add_routes(a, core, auth, feed, audit, store, FakeTelegram(), **options)
        )
        async with TestClient(TestServer(app)) as client:
            await test(hub, auth, feed, client)

    asyncio.run(main())


def test_web_language_switch_keeps_the_session(tmp_path: Path) -> None:
    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        chinese = await client.get("/ui/")
        assert '<html lang="zh-CN">' in await chinese.text()
        await client.get(f"/ui/login?t={auth.link_token()}")
        response = await client.post("/ui/api/settings", json={"language": "en"}, headers=CSRF)
        assert (await response.json())["ok"]
        settings = await (await client.get("/ui/api/settings")).json()
        assert settings["language"] == "en" and settings["telegram"]

        english = await client.get("/ui/")
        assert '<html lang="en">' in await english.text()
        assert english.headers["Cache-Control"] == "no-store"
        invalid_link = await client.get("/ui/login?t=invalid")
        assert "Login link expired" in await invalid_link.text()
        prompt = await (await client.get("/ui/api/prompt?id=momentum")).json()
        assert "Help me connect this trading program" in prompt["text"]
        assert "动量" in prompt["text"]
        invalid = await client.post("/ui/api/settings", json={"language": "de"}, headers=CSRF)
        assert (await invalid.json())["message"] == "Choose Simplified Chinese or English."

    scenario(test, tmp_path / "audit.jsonl")


@pytest.mark.parametrize("service", [True, False])
def test_update_endpoints(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, service: bool) -> None:
    audit = tmp_path / "audit.jsonl"
    fetches, restarts, commands = [], [], []
    repo = "https://github.com/yaho7/QuantBot"
    current = Installed("0.1.0", "1" * 40, "v0.2.2", repo)

    def fetch(path: str) -> list[dict[str, Any]]:
        fetches.append(path)
        assert path == "/tags?per_page=100&page=1"
        return [{"name": "v0.2.3", "commit": {"sha": "2" * 40}}]

    def run(command: list[str], **kwargs: Any) -> CompletedProcess[str]:
        commands.append(command)
        return CompletedProcess(command, 0, "done", "")

    updater = Updater(tmp_path, fetch=fetch, current=lambda: current, run=run, uv=lambda: "/bin/uv")
    monkeypatch.setattr("quantbot.web._service_installed", lambda: service)

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        url = "/ui/api/update"
        assert (await client.get(url)).status == 401
        assert (await client.post(url + "/check", headers=CSRF)).status == 401
        assert (await client.post(url, headers=CSRF)).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}")
        status = await (await client.get(url)).json()
        assert status == {
            "version": current.label,
            "result": None,
            "uv": True,
            "service": service,
            "updated": False,
        }
        assert (await client.post(url + "/check")).status == 403
        assert (await client.post(url)).status == 403
        assert not (await (await client.post(url, headers=CSRF)).json())["ok"]
        assert (await (await client.post(url + "/check", headers=CSRF)).json())["ok"]
        cached = await (await client.get(url)).json()
        assert cached["result"]["available"]
        throttled = await (await client.post(url + "/check", headers=CSRF)).json()
        assert not throttled["ok"] and "每分钟" in throttled["message"]
        assert len(fetches) == 1
        updated = await (await client.post(url, headers=CSRF)).json()
        assert updated["ok"] and len(commands) == 1
        assert commands[0][-1] == f"quantbot @ git+{repo}@refs/tags/v0.2.3"
        assert bool(restarts) == service
        assert ("自动重连" if service else "quantbot run") in updated["message"]
        assert read_audit(audit, 1)[0]["action"] == "update"
        assert read_audit(audit, 1)[0]["ok"]

    scenario(test, audit, updater=updater, restart=lambda: restarts.append(True))


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


def test_editor_requires_local_enable_and_refuses_unsafe_paths(tmp_path: Path) -> None:
    store = Store(tmp_path / "settings")
    root = tmp_path / "strategies"
    root.mkdir()
    sub = root / "signals"
    sub.mkdir()
    source = sub / "动量.py"
    source.write_bytes(b"x = 1\r\n")
    source.chmod(0o640)
    outside = tmp_path / "outside.py"
    outside.write_text("outside")
    (root / "symlink.py").symlink_to(outside)
    (root / "symlink-folder").symlink_to(tmp_path, target_is_directory=True)
    (root / "hardlink.py").hardlink_to(outside)
    audit = tmp_path / "audit.jsonl"

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        tree, file = "/ui/api/editor/tree", "/ui/api/editor/file"
        path = "signals/动量.py"
        assert (await client.get(tree)).status == 401
        assert (await client.post(file, headers=CSRF)).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}")
        assert not (await (await client.get(tree)).json())["ok"]
        assert not (await (await client.get("/ui/api/overview")).json())["editor_enabled"]
        assert (await client.post(file)).status == 403

        Editor.enable(store.dir, str(root))
        assert (await (await client.get("/ui/api/overview")).json())["editor_enabled"]
        entries = (await (await client.get(tree)).json())["data"]["entries"]
        assert entries == [{"name": "signals", "kind": "directory"}]
        for bad in (
            "../outside.py",
            str(outside),
            "symlink.py",
            "symlink-folder/outside.py",
            "hardlink.py",
        ):
            result = await (await client.get(file, params={"path": bad})).json()
            assert not result["ok"]
        first = (await (await client.get(file, params={"path": path})).json())["data"]
        assert first["content"] == "x = 1\r\n"
        changes = {"path": path, "content": "x = 2\r\n", "revision": first["revision"]}
        saved = await (await client.post(file, json=changes, headers=CSRF)).json()
        assert saved["ok"] and saved["data"]["revision"] != first["revision"]
        assert source.read_bytes() == b"x = 2\r\n" and source.stat().st_mode & 0o777 == 0o640
        stale = await (await client.post(file, json=changes, headers=CSRF)).json()
        assert not stale["ok"] and "服务器上的文件已变更" in stale["message"]
        outside_write = await (
            await client.post(file, json={**changes, "path": "symlink.py"}, headers=CSRF)
        ).json()
        assert not outside_write["ok"] and outside.read_text() == "outside"
        assert any(r["action"] == "editor_save" and r["ok"] for r in read_audit(audit, 5))
        assert "x = 2" not in audit.read_text()

        # Even a root which contains the data directory cannot edit editor.json.
        Editor.enable(store.dir, str(tmp_path))
        response = await client.get(file, params={"path": f"settings/{EDITOR_FILE}"})
        assert not (await response.json())["ok"]
        Store(store.dir, filename=EDITOR_FILE).path.unlink()
        assert not (await (await client.get(file, params={"path": path})).json())["ok"]

    scenario(test, audit)


def test_workspace_file_operations_and_external_refresh(tmp_path: Path) -> None:
    root = tmp_path / "strategies"
    root.mkdir()
    Editor.enable(tmp_path / "settings", str(root))
    outside = tmp_path / "outside"
    outside.write_text("keep me")

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        endpoint = "/ui/api/editor/events"
        assert (await client.get(endpoint)).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}")

        async def change(action: str, path: str, **extra: str) -> bool:
            response = await client.post(
                f"/ui/api/editor/files/{action}", json={"path": path, **extra}, headers=CSRF
            )
            return (await response.json())["ok"]

        async with client.get(endpoint) as events, client.get(endpoint) as other:
            for stream in (events, other):
                assert await stream.content.readuntil(b"\n\n") == b"data: refresh\n\n"
            # This mutation bypasses the web server, as mkdir from the terminal would.
            await asyncio.sleep(0.2)
            (root / "from-terminal").mkdir()
            for stream in (events, other):
                assert (
                    await asyncio.wait_for(stream.content.readuntil(b"\n\n"), 4)
                    == b"data: refresh\n\n"
                )
        assert await change("folder", "project")
        assert await change("file", "project/code.py")
        assert not await change("file", "project/code.py")
        (root / "project" / "code.py").write_text("print('test')")
        assert not await change("copy", "project", destination="project/child")
        assert await change("copy", "project", destination="duplicate")
        assert await change("move", "duplicate/code.py", destination="from-terminal/new.py")
        assert (root / "from-terminal" / "new.py").read_text() == "print('test')"
        (root / "project" / "escape").symlink_to(outside)
        assert not await change("move", "project/escape", destination="escape")
        assert not await change("file", "../invalid")
        assert await change("delete", "project")
        assert not (root / "project").exists()
        assert outside.read_text() == "keep me"

    scenario(test, tmp_path / "audit.jsonl")


def test_github_web_official_device_authorization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    flows = []
    cloned = []

    class Login:
        reported = False

        def __init__(self) -> None:
            loop = asyncio.get_running_loop()
            self.code = loop.create_future()
            self.code.set_result("ABCD-EFGH")
            self.done = loop.create_future()

        async def close(self) -> None:
            if not self.done.done():
                self.done.set_result(False)

    async def begin(github: GitHubEditor) -> Login:
        login = Login()
        flows.append(login)
        return login

    monkeypatch.setattr(GitHubEditor, "begin", begin)
    monkeypatch.setattr(
        GitHubEditor,
        "repositories",
        lambda self: [
            {"name": "acme/private", "private": True},
        ],
    )
    monkeypatch.setattr(
        GitHubEditor, "select", lambda self, repo: cloned.append(repo) or {"repo": repo}
    )

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        base = "/ui/api/editor/github"
        assert (await client.post(f"{base}/bind", headers=CSRF)).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}")

        async def post(action: str, **body: str) -> Any:
            return await (await client.post(f"{base}/{action}", headers=CSRF, json=body)).json()

        first = (await post("bind"))["data"]
        assert first["url"] == DEVICE_URL and first["code"] == "ABCD-EFGH"
        assert set(first) == {"url", "code", "state"}
        assert not (await post("authorize", state="wrong"))["ok"]
        assert (await post("authorize", state=first["state"]))["data"] == {"ready": False}
        assert (await post("cancel", state=first["state"]))["ok"]
        assert not await flows[0].done

        second = (await post("bind"))["data"]
        assert second["state"] != first["state"]
        flows[1].done.set_result(True)
        for _ in range(2):
            assert (await post("authorize", state=second["state"]))["data"] == {"ready": True}
        assert (await post("repositories"))["data"]["repositories"] == [
            {"name": "acme/private", "private": True},
        ]
        assert (await post("select", repo="acme/private"))["data"]["repo"] == "acme/private"
        assert cloned == ["acme/private"]
        assert "ABCD-EFGH" not in (tmp_path / "audit.jsonl").read_text()

    scenario(test, tmp_path / "audit.jsonl")


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


def test_tunnel_login_secure_cookie_and_per_client_lockout(tmp_path: Path) -> None:
    from quantbot.web import LOGIN_TRIES, _login_client, hash_password

    store = Store(tmp_path / "settings")
    public_url = "https://bot.example.com"

    def headers(ip: str) -> dict[str, str]:
        return {**CSRF, "Host": "bot.example.com", "CF-Connecting-IP": ip}

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        data = store.read()
        data.update(
            public_url=public_url,
            web_tunnel=True,
            web_admin={"username": "admin", "password": hash_password("right-pass")},
        )
        store.write(data)
        url = "/ui/api/login"
        wrong = {"username": "admin", "password": "bad"}
        right = {"username": "admin", "password": "right-pass"}
        for _ in range(LOGIN_TRIES):
            response = await client.post(url, headers=headers("192.0.2.1"), json=wrong)
            assert not (await response.json())["ok"]
        response = await client.post(url, headers=headers("192.0.2.1"), json=right)
        assert "分钟后再试" in (await response.json())["message"]
        response = await client.post(url, headers=headers("2001:db8::1"), json=right)
        assert (await response.json())["ok"]
        assert (
            response.cookies[COOKIE]["secure"] and response.headers["Cache-Control"] == "no-store"
        )
        link = await client.get(f"/ui/login?t={auth.link_token()}", allow_redirects=False)
        assert link.cookies[COOKIE]["secure"]
        assert read_audit(tmp_path / "audit.jsonl", 1)[0]["client"] == "2001:db8::1"

    scenario(test, tmp_path / "audit.jsonl")
    req = SimpleNamespace(
        remote="192.0.2.3", host="bot.example.com", headers=CIMultiDict(headers("192.0.2.4"))
    )
    assert _login_client(req, True, public_url) == "192.0.2.3"
    req.remote, req.host = "127.0.0.1", "localhost"
    assert _login_client(req, True, public_url) == "127.0.0.1"
    req.host = "bot.example.com"
    assert _login_client(req, False, public_url) == "127.0.0.1"


def test_web_admin_can_change_password_and_create_login_link(tmp_path: Path) -> None:
    from quantbot.web import check_password, hash_password

    store = Store(tmp_path / "settings")

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        with store.edit() as data:
            data["web_admin"] = {"username": "old", "password": hash_password("right-pass")}
        old_cookie = auth.session()
        old_link = auth.link_token()
        change = {
            "username": "new",
            "current": "bad",
            "password": "new-pass",
            "confirm": "new-pass",
        }
        assert (await client.post("/ui/api/password", headers=CSRF, json=change)).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}")
        assert (await client.post("/ui/api/password", json=change)).status == 403
        wrong = await (await client.post("/ui/api/password", headers=CSRF, json=change)).json()
        assert not wrong["ok"] and auth.valid(old_cookie)
        change["current"] = "right-pass"
        response = await client.post("/ui/api/password", headers=CSRF, json=change)
        assert (await response.json())["ok"]
        assert COOKIE in response.cookies and auth.valid(response.cookies[COOKIE].value)
        assert not auth.valid(old_cookie) and auth.redeem(old_link) is None
        assert (await client.get("/ui/api/settings")).status == 200
        admin = store.read()["web_admin"]
        assert admin["username"] == "new" and check_password("new-pass", admin["password"])
        assert store.read()["telegram"]["token"] == BOT

        generated = await client.post("/ui/api/web-link", headers=CSRF)
        assert generated.headers["Cache-Control"] == "no-store"
        url = (await generated.json())["data"]["url"]
        assert (await client.get(url, allow_redirects=False)).status == 302
        assert (await client.get(url, allow_redirects=False)).status == 403
        audit = tmp_path / "audit.jsonl"
        assert [r["action"] for r in read_audit(audit, 2)] == ["web_link", "password"]
        assert "new-pass" not in audit.read_text() and url not in audit.read_text()

    scenario(test, tmp_path / "audit.jsonl")


def test_web_strategy_configuration_and_token_revocation(tmp_path: Path) -> None:
    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        url = "/ui/api/strategy-config"
        item = {"id": "grid", "name": "网格策略"}
        assert (await client.post(url + "/add", headers=CSRF, json=item)).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}")
        assert (await client.post(url + "/add", json=item)).status == 403
        created = await client.post(url + "/add", headers=CSRF, json=item)
        token = (await created.json())["data"]["token"]
        assert created.headers["Cache-Control"] == "no-store"
        assert not (await (await client.post(url + "/add", headers=CSRF, json=item)).json())["ok"]
        credentials = await client.post(url + "/credentials", headers=CSRF, json=item)
        assert (await credentials.json())["data"]["token"] == token
        overview = await client.get("/ui/api/overview")
        assert token not in await overview.text()
        assert (await overview.json())["strategies"][0]["name"] == "网格策略"

        old = {"Authorization": f"Bearer {token}"}
        poll = asyncio.create_task(client.get("/v1/commands?wait=10", headers=old))

        async def polling() -> None:
            while not hub.strategies["grid"].polling:
                await asyncio.sleep(0.01)

        await asyncio.wait_for(polling(), 2)
        rotated = await client.post(url + "/rotate", headers=CSRF, json=item)
        new_token = (await rotated.json())["data"]["token"]
        assert new_token != token
        assert (await asyncio.wait_for(poll, 2)).status == 401
        assert (await client.get("/v1/commands?wait=0", headers=old)).status == 401
        new = {"Authorization": f"Bearer {new_token}"}
        assert (await client.get("/v1/commands?wait=0", headers=new)).status == 200

        renamed = await client.post(
            url + "/rename", headers=CSRF, json={**item, "name": "新策略名"}
        )
        assert (await renamed.json())["ok"] and hub.strategies["grid"].name == "新策略名"
        removed = await client.post(url + "/remove", headers=CSRF, json=item)
        assert (await removed.json())["ok"] and "grid" not in hub.strategies
        assert (await client.get("/v1/commands?wait=0", headers=new)).status == 401
        audit = tmp_path / "audit.jsonl"
        assert read_audit(audit, 1)[0]["action"] == "strategy_remove"
        assert token not in audit.read_text() and new_token not in audit.read_text()

    scenario(test, tmp_path / "audit.jsonl")


def test_web_service_status_logs_and_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = Store(tmp_path / "settings")
    log_token = "ghu_examplecredential"
    manager = SimpleNamespace(
        status=lambda: "state = running",
        recent_logs=lambda: f"Started QuantBot\ncredentials: {BOT} {log_token}",
    )
    monkeypatch.setattr("quantbot.web._service", lambda: manager)
    restarted = []

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        url = "/ui/api/service"
        assert (await client.get(url + "/status")).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}")
        status = await (await client.get(url + "/status")).json()
        assert status["data"] == {"installed": True, "text": "state = running"}
        with store.edit() as data:
            data["telegram"] = {"token": BOT, "owner_id": 42}
        response = await client.get(url + "/logs")
        logs = (await response.json())["data"]["text"]
        assert "Started QuantBot" in logs and BOT not in logs and log_token not in logs
        assert response.headers["Cache-Control"] == "no-store"
        assert (await client.post(url + "/restart")).status == 403 and not restarted
        result = await (await client.post(url + "/restart", headers=CSRF)).json()
        assert result["ok"] and restarted == [True]
        assert read_audit(tmp_path / "audit.jsonl", 1)[0]["action"] == "service_restart"

    scenario(test, tmp_path / "audit.jsonl", restart=lambda: restarted.append(True))


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

    code, io = run(store, ["workspace"])
    link = next(line.strip() for line in io.out if "/ui/login?t=" in line)
    assert code == 0 and link.endswith("&view=workspace")
    assert WebAuth(store.web_secret()).redeem(link.split("t=", 1)[1].split("&", 1)[0])


def test_workspace_link_redirects_to_workspace(tmp_path: Path) -> None:
    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        link = f"/ui/login?t={auth.link_token()}&view=workspace"
        response = await client.get(link, allow_redirects=False)
        assert response.headers["Location"] == "/ui/?view=workspace"
        assert COOKIE in response.cookies

    scenario(test, tmp_path / "audit.jsonl")


def test_web_workspace_can_create_and_select_a_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = tmp_path / "workspace"
    monkeypatch.setattr("quantbot.workspace.WEB_ROOT", base)
    monkeypatch.setattr(Workspace, "supported", staticmethod(lambda: True))

    def initialize(state: Path, path: Path) -> Workspace:
        assert path == base / "策略 项目"
        assert not any(path.iterdir())
        Editor.enable(state, str(path))
        Store(state, filename="workspace.json").write({"root": str(path)})
        return Workspace(path, 123, 123, tmp_path / "home")

    monkeypatch.setattr(Workspace, "initialize", staticmethod(initialize))

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        url = "/ui/api/workspace"
        assert (await client.get(url + "/directories")).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}")
        listing = await (await client.get(url + "/directories")).json()
        assert listing["data"]["folders"] == [] and not base.exists()
        assert (await client.post(url + "/folder", json={"name": "策略 项目"})).status == 403
        created = await (
            await client.post(url + "/folder", json={"name": "策略 项目"}, headers=CSRF)
        ).json()
        assert created["data"]["path"] == "策略 项目"
        outside = tmp_path / "outside"
        outside.mkdir()
        (base / "escape").symlink_to(outside, target_is_directory=True)
        listing = await (await client.get(url + "/directories")).json()
        assert listing["data"]["folders"] == ["策略 项目"]
        for path in ("../outside", str(outside), "escape"):
            response = await client.post(url + "/init", json={"path": path}, headers=CSRF)
            assert not (await response.json())["ok"]
        assert not any(outside.iterdir())
        result = await client.post(url + "/init", json={"path": "策略 项目"}, headers=CSRF)
        assert (await result.json())["ok"]
        overview = await (await client.get("/ui/api/overview")).json()
        assert overview["workspace_managed"] and overview["editor_enabled"]

    scenario(test, tmp_path / "audit.jsonl")


def test_workspaces_keep_file_and_program_state_separate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = tmp_path / "settings"
    first, second = tmp_path / "first", tmp_path / "second"
    for root in (first, second):
        root.mkdir()
        (root / ".gitignore").write_text(".env\n")
        (root / ".env").write_text(root.name)
    Editor.enable(state, str(first))
    Store(state, filename=WORKSPACE_FILE).write(
        {"root": str(first), "roots": [str(first), str(second)]}
    )
    monkeypatch.setattr(Editor, "workspace", lambda self: Workspace(self.root, 123, 123, tmp_path))

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        assert (await client.get("/ui/api/workspaces")).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}")
        listing = (await (await client.get("/ui/api/workspaces")).json())["data"]["projects"]
        assert [item["id"] for item in listing] == [workspace_id(first), workspace_id(second)]
        for root in (first, second):
            params = {"workspace": workspace_id(root)}
            tree = await (await client.get("/ui/api/editor/tree", params=params)).json()
            assert {item["name"] for item in tree["data"]["entries"]} == {".gitignore", ".env"}
            file = await (
                await client.get("/ui/api/editor/file", params={**params, "path": ".env"})
            ).json()
            assert file["data"]["content"] == root.name
            program = "/ui/api/workspace/program"
            assert (
                await (
                    await client.post(
                        program + "/configure",
                        params=params,
                        headers=CSRF,
                        json={"command": f"echo {root.name}"},
                    )
                ).json()
            )["ok"]
        for root in (first, second):
            status = await (
                await client.get(program, params={"workspace": workspace_id(root)})
            ).json()
            assert status["data"]["command"] == f"echo {root.name}"
        unknown = await (
            await client.get("/ui/api/editor/tree", params={"workspace": str(first)})
        ).json()
        assert not unknown["ok"]

    scenario(test, tmp_path / "audit.jsonl")


def test_workspace_terminal_requires_session_and_origin_and_reports_latency(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Terminal:
        closed = False
        size = (0, 0)

        def __init__(self) -> None:
            self.output: asyncio.Queue[bytes] = asyncio.Queue()

        async def read(self) -> bytes:
            return await self.output.get()

        async def write(self, data: bytes) -> None:
            await self.output.put(data)

        async def resize(self, cols: int, rows: int) -> None:
            self.size = (cols, rows)

        async def close(self) -> None:
            self.closed = True

    terminal = Terminal()

    async def start(workspace: Workspace, cwd: Path) -> Terminal:
        assert workspace.uid == 123
        assert cwd == root / "nested"
        return terminal

    monkeypatch.setattr("quantbot.web.TerminalProcess.start", start)
    monkeypatch.setattr(Editor, "workspace", lambda self: Workspace(self.root, 123, 123, tmp_path))
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "nested").mkdir()

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        url = "/ui/api/workspace/terminal?path=nested"
        assert (await client.get(url)).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}")
        denied = await client.get(url, headers={"Origin": "https://untrusted.example"})
        assert not (await denied.json())["ok"]
        Editor.enable(tmp_path / "settings", str(root))
        origin = str(client.make_url("/").origin())
        async with client.ws_connect(url, origin=origin) as socket:
            assert await socket.receive_json() == {"type": "ready"}
            await socket.send_json({"type": "resize", "cols": 90, "rows": 25})
            await socket.send_json({"type": "ping", "sent": 123.4})
            assert await socket.receive_json() == {"type": "pong", "sent": 123.4}
            await socket.send_bytes(b"pwd\r")
            assert await socket.receive_bytes() == b"pwd\r"
            assert terminal.size == (90, 25)
        for _ in range(100):
            if terminal.closed:
                break
            await asyncio.sleep(0.001)
        assert terminal.closed

    scenario(test, tmp_path / "audit.jsonl")


def test_workspace_program_survives_the_browser_session_and_can_stop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    Editor.enable(tmp_path / "settings", str(root))
    monkeypatch.setattr(Editor, "workspace", lambda self: Workspace(self.root, 123, 123, tmp_path))
    monkeypatch.setattr(Workspace, "command", lambda self, argv: argv)
    monkeypatch.setattr(Workspace, "process_options", lambda self: {"cwd": self.root})
    url = "/ui/api/workspace/program"
    command = "/bin/sh -c 'echo ready; exec sleep 60'"

    async def test(hub: Hub, auth: WebAuth, feed: Feed, client: TestClient) -> None:
        assert (await client.get(url)).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}")
        assert (await client.post(url + "/start")).status == 403
        assert not (await (await client.post(url + "/start", headers=CSRF)).json())["ok"]
        saved = await client.post(url + "/configure", json={"command": command}, headers=CSRF)
        assert (await saved.json())["data"]["command"] == command
        assert (await (await client.post(url + "/start", headers=CSRF)).json())["ok"]
        await client.post("/ui/api/logout", headers=CSRF)
        assert (await client.get(url)).status == 401
        await client.get(f"/ui/login?t={auth.link_token()}")
        for _ in range(100):
            status = (await (await client.get(url)).json())["data"]
            if "ready" in status["logs"]:
                break
            await asyncio.sleep(0.005)
        assert status["running"] and "ready" in status["logs"]
        assert not (await (await client.post(url + "/start", headers=CSRF)).json())["ok"]
        stopped = await (await client.post(url + "/stop", headers=CSRF)).json()
        assert stopped["ok"] and not stopped["data"]["running"]
        assert "ready" in stopped["data"]["logs"]

    scenario(test, tmp_path / "audit.jsonl")


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
