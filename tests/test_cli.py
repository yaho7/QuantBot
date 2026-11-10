"""The quantbot command and the settings file, with scripted terminal answers."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Any

import pytest

from quantbot.cli import Console, TelegramError, main
from quantbot.config import ConfigError, Store, StrategyConfig
from quantbot.hub import Hub

BOT = "123456789:" + "A" * 35


class Script(Console):
    def __init__(self, answers: list[str], tty: bool = True) -> None:
        self.answers = list(answers)
        self.out: list[str] = []
        self.tty = tty

    def say(self, text: str = "") -> None:
        self.out.append(text)

    def ask(self, prompt: str, default: str = "") -> str:
        self.out.append(f"? {prompt}")
        answer = self.answers.pop(0)
        return answer or default

    def secret(self, prompt: str) -> str:
        self.out.append(f"? {prompt}")
        return self.answers.pop(0)

    def interactive(self) -> bool:
        return self.tty

    def text(self) -> str:
        return "\n".join(self.out)


class FakeTelegram:
    def __init__(self, updates: list[dict[str, Any]] | None = None, conflict: bool = False) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.updates = updates or []
        self.conflict = conflict

    def __call__(self, token: str, method: str, http_timeout: float = 15, **params: Any) -> Any:
        self.calls.append((method, params))
        if token != BOT:
            raise TelegramError("Unauthorized", 401)
        if method == "getMe":
            return {"username": "my_quant_bot"}
        if method == "getUpdates":
            if self.conflict:
                raise TelegramError("Conflict", 409)
            return [] if "offset" in params else self.updates
        return {}


def message(uid: int = 42) -> dict[str, Any]:
    return {"update_id": 7, "message": {"from": {"id": uid, "first_name": "Ya", "username": "ya"}}}


def run(
    store: Store, argv: list[str], answers: list[str] | None = None, **kw: Any
) -> tuple[int, Script]:
    io = Script(answers or [], tty=kw.pop("tty", True))
    api = kw.pop("api", FakeTelegram([message()]))
    return main(argv, io=io, api=api, store=store), io


def test_setup_finds_owner_from_a_message(tmp_path: Path) -> None:
    store = Store(tmp_path)
    api = FakeTelegram([message()])
    # bad token, good token, wait for message, confirm, quiet, tz, heartbeat
    code, io = run(store, ["setup"], ["nope", BOT, "", "", "23-07", "", ""], api=api)
    assert code == 0, io.text()
    assert "✓ 连上了 @my_quant_bot" in io.text() and "收到 Ya @ya（id 42）" in io.text()
    settings = store.settings({})
    assert (settings.owner_id, settings.quiet_hours, settings.timezone) == (
        42,
        (23, 7),
        "Asia/Shanghai",
    )
    assert (
        "sendMessage",
        {"chat_id": 42, "text": "✅ QuantBot 配置好了。发 /menu 看所有策略。"},
    ) in api.calls
    assert stat.S_IMODE(os.stat(store.path).st_mode) == 0o600
    assert "quantbot add" in io.text()


def test_setup_again_keeps_values_and_typed_id_works(tmp_path: Path) -> None:
    store = Store(tmp_path)
    run(store, ["setup"], [BOT, "", "", "23-07", "", ""])
    # keep token (empty), not the same owner, type id, keep quiet, new tz, bad url, no url
    code, io = run(
        store,
        ["setup"],
        ["", "n", "99", "", "America/New_York", "ftp://x", "-"],
        api=FakeTelegram(conflict=True),
    )
    assert code == 0, io.text()
    settings = store.settings({})
    assert (settings.owner_id, settings.quiet_hours, settings.timezone) == (
        99,
        (23, 7),
        "America/New_York",
    )
    assert "自动重启" in io.text()


def test_setup_while_running_asks_for_the_id(tmp_path: Path) -> None:
    code, io = run(
        Store(tmp_path), ["setup"], [BOT, "", "42", "-", "", "-"], api=FakeTelegram(conflict=True)
    )
    assert code == 0 and "没法自动识别" in io.text()


def test_setup_needs_a_terminal(tmp_path: Path) -> None:
    code, io = run(Store(tmp_path), ["setup"], tty=False)
    assert code == 1 and "交互" in io.text()


def test_add_list_token_rename_remove(tmp_path: Path) -> None:
    store = Store(tmp_path)
    code, io = run(store, ["add", "momentum", "--name", "动量策略"])
    assert code == 0
    token = next(line for line in io.out if "QB_TOKEN=" in line).split("=", 1)[1]
    listen = store.read()["listen"]
    assert len(token) >= 32 and f"QB_URL=http://{listen}" in io.text()
    assert "还没配置 Telegram" in io.text()
    assert run(store, ["add", "momentum"])[0] == 1
    assert run(store, ["add", "Bad!"])[0] == 1
    run(store, ["add", "grid"], ["网格"])
    assert store.strategies() == (
        StrategyConfig("momentum", "动量策略", token),
        StrategyConfig("grid", "网格", store.strategies()[1].token),
    )
    assert "momentum  动量策略" in run(store, ["list"])[1].text()
    assert f"QB_TOKEN={token}" in run(store, ["token", "momentum"])[1].text()
    run(store, ["token", "momentum", "--new", "--yes"])
    assert store.strategies()[0].token != token
    run(store, ["rename", "grid", "网格 2"])
    assert store.strategies()[1].name == "网格 2"
    assert run(store, ["remove", "grid"], ["n"])[0] == 1
    run(store, ["remove", "grid", "--yes"])
    assert [s.id for s in store.strategies()] == ["momentum"]
    assert run(store, ["token", "nope"])[0] == 1


def test_settings_say_what_is_missing(tmp_path: Path) -> None:
    store = Store(tmp_path)
    with pytest.raises(ConfigError, match="quantbot setup"):
        store.settings({})
    store.path.write_text("{broken")
    with pytest.raises(ConfigError, match="读不出来"):
        store.settings({})
    run(store_ok := Store(tmp_path / "ok"), ["setup"], [BOT, "", "", "-", "", "-"])
    assert store_ok.settings({"QB_LISTEN": "127.0.0.1:9000"}).port == 9000
    with pytest.raises(ConfigError, match="监听地址"):
        store_ok.settings({"QB_LISTEN": "9000"})


def test_hub_sync_adds_renames_and_removes() -> None:
    import asyncio

    async def go() -> None:
        hub = Hub(
            (StrategyConfig("a", "A", "a" * 20), StrategyConfig("b", "B", "b" * 20)),
            lambda *n: None,
        )
        pending = hub.send(hub.strategies["b"], "flatten")
        changes = hub.sync(
            (StrategyConfig("c", "C", "c" * 20), StrategyConfig("a", "A2", "x" * 20))
        )
        assert changes == ["删除 b", "添加 c", "换了 a 的 token", "a 改名为 A2"]
        assert list(hub.strategies) == ["c", "a"]
        assert pending.future.result().ok is False
        assert hub.by_token("x" * 20) is hub.strategies["a"] and hub.by_token("a" * 20) is None

    asyncio.run(go())


def test_link_copies_the_client_and_registers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = Store(tmp_path / "data")
    run(store, ["setup"], [BOT, "", "", "-", "", "-"])
    project = tmp_path / "My Momentum"
    project.mkdir()
    (project / "main.py").write_text("print('hi')\n")
    monkeypatch.setattr("quantbot.cli.shutil.which", lambda name: None)  # no uv here
    # id (default), display name, choice 1 = copy
    code, io = run(store, ["link", str(project)], ["", "动量", ""])
    assert code == 0, io.text()
    assert [(s.id, s.name) for s in store.strategies()] == [("my-momentum", "动量")]
    assert "class QuantBot" in (project / "quantbot_client.py").read_text()
    assert 'qb = QuantBot("my-momentum")' in io.text() and "python main.py" in io.text()
    token = store.strategies()[0].token
    code, io = run(store, ["link", str(project)], ["", "", ""])  # again: same token
    assert code == 0 and "已经连接过" in io.text() and store.strategies()[0].token == token


def test_link_writes_requirements(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = Store(tmp_path / "data")
    run(store, ["setup"], [BOT, "", "", "-", "", "-"])
    project = tmp_path / "grid"
    project.mkdir()
    (project / "requirements.txt").write_text("pandas")
    monkeypatch.setattr("quantbot.cli.shutil.which", lambda name: None)
    code, io = run(store, ["link", str(project)], ["", "", "9", "1"])  # bad choice, then 1
    assert code == 0, io.text()
    assert (project / "requirements.txt").read_text().splitlines() == [
        "pandas",
        "quantbot-client @ git+https://github.com/yaho7/QuantBot#subdirectory=client",
    ]
    run(store, ["link", str(project)], ["", "", "1"])
    assert (project / "requirements.txt").read_text().count("quantbot-client") == 1


def test_link_needs_setup_first(tmp_path: Path) -> None:
    code, io = run(Store(tmp_path), ["link", str(tmp_path)])
    assert code == 1 and "quantbot setup" in io.text()


def test_random_port_is_picked_once_and_env_wins(tmp_path: Path) -> None:
    from quantbot.config import PORT_RANGE

    store = Store(tmp_path)
    first = store.ensure_listen({})
    host, _, port = first.rpartition(":")
    assert host == "127.0.0.1" and PORT_RANGE[0] <= int(port) <= PORT_RANGE[1]
    assert store.ensure_listen({}) == first == store.read()["listen"]
    assert store.ensure_listen({"QB_LISTEN": "127.0.0.1:30001"}) == "127.0.0.1:30001"
    with pytest.raises(ConfigError):
        store.ensure_listen({"QB_LISTEN": "nope"})
