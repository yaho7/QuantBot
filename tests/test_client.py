"""The client against the real QuantBot HTTP API, running in a background thread."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from aiohttp import web

from quantbot.config import Store, StrategyConfig
from quantbot.hub import Hub, Result

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "client"))
from quantbot_client import QuantBot  # noqa: E402

TOKEN = "t" * 20


@pytest.fixture(autouse=True)
def isolated_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.delenv("QB_STATE_FILE", raising=False)


class Server:
    """QuantBot's hub and API on a free port, with helpers to drive it from the test."""

    def __init__(self) -> None:
        self.notes: list[tuple[str, str, str, Any]] = []
        self.loop = asyncio.new_event_loop()
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        ready = threading.Event()
        self.thread = threading.Thread(target=self._main, args=(ready,), daemon=True)
        self.thread.start()
        assert ready.wait(5)

    def _main(self, ready: threading.Event) -> None:
        from quantbot.server import make_app

        asyncio.set_event_loop(self.loop)
        self.hub = Hub(
            (StrategyConfig("bot", "Bot", TOKEN),),
            lambda *note: self.notes.append(note),
            redeliver_after=0.3,
        )
        self.runner = web.AppRunner(make_app(self.hub), shutdown_timeout=0.5)
        self.loop.run_until_complete(self.runner.setup())
        site = web.TCPSite(self.runner, "127.0.0.1", self.port)
        self.loop.run_until_complete(site.start())
        ready.set()
        self.loop.run_forever()

    @property
    def strategy(self) -> Any:
        return self.hub.strategies["bot"]

    def send(self, name: str, args: dict[str, Any] | None = None, timeout: float = 5) -> Result:
        async def go() -> Result:
            command = self.hub.send(self.strategy, name, args)
            return await asyncio.wait_for(command.future, timeout)

        return asyncio.run_coroutine_threadsafe(go(), self.loop).result(timeout + 1)

    def stop(self) -> None:
        asyncio.run_coroutine_threadsafe(self.runner.cleanup(), self.loop).result(5)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)


def wait_until(check: Callable[[], bool], timeout: float = 5) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.02)


@pytest.fixture
def server() -> Iterator[Server]:
    server = Server()
    yield server
    server.stop()


def serve(qb: QuantBot) -> threading.Thread:
    def loop() -> None:
        with qb:
            while qb.sleep(0.05):
                pass

    thread = threading.Thread(target=loop, name="trading")
    thread.start()
    return thread


def test_hello_commands_and_events(server: Server, tmp_path: Path) -> None:
    ran: list[tuple[str, str]] = []
    qb = QuantBot(
        url=f"http://127.0.0.1:{server.port}", token=TOKEN, state_file=str(tmp_path / "s.json")
    )
    qb.on(
        "positions", lambda: ran.append(("positions", threading.current_thread().name)) or "QQQ 10"
    )
    qb.on("orders", lambda: [{"id": "o1", "text": "卖 QQQ"}])
    qb.on("chart", lambda: b"PNG")
    qb.on("set_param", lambda name, value: f"{name}={value}")
    trading = serve(qb)
    wait_until(lambda: server.strategy.said_hello)
    assert server.strategy.commands == (
        "pause", "resume", "positions", "orders", "set_param", "chart", "stop",
    )  # fmt: skip

    assert server.send("positions").message == "QQQ 10"
    assert ran == [("positions", "trading")]  # handlers run on the trading thread
    assert server.send("orders").data == [{"id": "o1", "text": "卖 QQQ"}]
    assert server.send("chart").data == "UE5H"
    assert server.send("set_param", {"name": "n", "value": 3}).message == "n=3"
    failed = server.send("flatten")
    assert not failed.ok and "不支持 flatten" in failed.message

    assert server.send("pause").ok and qb.paused and not qb.can_open()
    assert json.loads((tmp_path / "s.json").read_text()) == {"paused": True, "reasons": ["manual"]}
    assert QuantBot(url="http://x", token=TOKEN, state_file=str(tmp_path / "s.json")).paused

    qb.status("净值 10000")
    qb.fill("AAPL BUY 10 @ 280.50")
    wait_until(lambda: server.strategy.status_text == "净值 10000")
    assert server.strategy.paused is True
    wait_until(lambda: any("AAPL" in note[1] for note in server.notes))

    assert server.send("stop").ok
    trading.join(5)
    assert not trading.is_alive() and qb.stopping


def test_slow_protected_command_runs_once(server: Server) -> None:
    count = []
    qb = QuantBot(url=f"http://127.0.0.1:{server.port}", token=TOKEN)

    def flatten() -> str:
        count.append(1)
        time.sleep(0.8)  # slower than redelivery, so the same id arrives again
        return "平掉了"

    qb.on("flatten", flatten)
    trading = serve(qb)
    wait_until(lambda: server.strategy.said_hello)
    assert server.send("flatten").message == "平掉了"
    time.sleep(0.5)
    assert count == [1]
    server.send("stop")
    trading.join(5)


def test_lost_result_after_broker_acceptance_cannot_repeat_on_client_restart(
    server: Server,
) -> None:
    async def command() -> dict[str, Any]:
        await server.hub.poll(server.strategy, 0, claims=True)
        server.hub.send(server.strategy, "manual_order", {"qty": 1})
        return (await server.hub.poll(server.strategy, 0, claims=True))["commands"][0]

    item = asyncio.run_coroutine_threadsafe(command(), server.loop).result(5)
    settings = {"url": f"http://127.0.0.1:{server.port}", "token": TOKEN}
    first = QuantBot("bot", **settings)
    orders = []
    first.on("manual_order", lambda qty: orders.append((first.operation_id, qty)))
    first._accept(item)
    assert first.process() == 1
    # The process exits without a sender thread, simulating a lost command receipt.
    restarted = QuantBot("bot", **settings)
    restarted.on("manual_order", lambda qty: orders.append((restarted.operation_id, qty)))
    restarted._accept(item)
    assert restarted.process() == 0
    assert orders == [(item["id"], 1)]
    rejected = server.send("manual_order", {"qty": 1})
    assert rejected.state == "EXECUTING" and rejected.operation_id == item["id"]


def test_error_in_trading_loop_is_reported(server: Server) -> None:
    qb = QuantBot(url=f"http://127.0.0.1:{server.port}", token=TOKEN)
    with pytest.raises(ZeroDivisionError), qb:
        1 / 0  # noqa: B018
    wait_until(lambda: any(note[2] == "error" for note in server.notes))
    note = next(n for n in server.notes if n[2] == "error")
    assert "ZeroDivisionError" in note[1]


def test_trading_goes_on_while_quantbot_is_down() -> None:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    qb = QuantBot(url=f"http://127.0.0.1:{port}", token=TOKEN).start()
    qb.status("x")
    start = time.monotonic()
    assert qb.sleep(0.2) is True
    assert time.monotonic() - start < 1
    qb.close(timeout=0.2)


def test_bad_settings_and_unknown_command() -> None:
    with pytest.raises(ValueError):
        QuantBot(url="quantbot:8080", token=TOKEN)
    with pytest.raises(ValueError):
        QuantBot(url="http://127.0.0.1:8080", token=TOKEN).on("rm", lambda: None)


def test_resume_callback_failure_preserves_pause() -> None:
    qb = QuantBot("bot", url="http://localhost", token=TOKEN)
    qb._execute("pause", {})

    def check() -> None:
        assert not qb.can_open()
        raise RuntimeError("broker unavailable")

    qb.on("resume", check)
    with pytest.raises(RuntimeError, match="broker unavailable"):
        qb._execute("resume", {})
    assert not qb.can_open()
    assert QuantBot("bot", url=qb.url, token=TOKEN).pause_reasons == {"manual"}


def test_protective_pauses_survive_restart_and_token_rotation() -> None:
    qb = QuantBot("bot", url="http://localhost", token=TOKEN)
    qb.risk_triggered("loss limit")
    qb.connection("broker", False, pause_on_failure=True)
    restarted = QuantBot("bot", url="http://localhost:9999", token="new")
    assert restarted.pause_reasons == {"risk", "connection"}
    with pytest.raises(RuntimeError, match="explicit clearance"):
        restarted._execute("resume", {})
    restarted.clear_pause("risk")
    assert not restarted.can_open()
    restarted.clear_pause("connection")
    assert restarted.can_open()


def test_failed_resume_write_preserves_pause(monkeypatch: pytest.MonkeyPatch) -> None:
    qb = QuantBot("bot", url="http://localhost", token=TOKEN)
    qb._execute("pause", {})

    def write(_reasons: frozenset[str]) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(qb, "_write_pause_reasons", write)
    with pytest.raises(OSError, match="disk full"):
        qb._execute("resume", {})
    assert not qb.can_open()


def test_connects_locally_by_name(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import json as _json

    from quantbot_client import connect_locally

    monkeypatch.delenv("QB_TOKEN", raising=False)
    monkeypatch.delenv("QB_URL", raising=False)
    monkeypatch.setenv("QB_DATA_DIR", str(tmp_path))
    with pytest.raises(RuntimeError, match="quantbot setup"):
        QuantBot("momentum")
    (tmp_path / "quantbot.json").write_text(_json.dumps({"telegram": {}, "listen": "0.0.0.0:9001"}))
    qb = QuantBot("momentum", display_name="动量")  # new: added to the settings
    saved = _json.loads((tmp_path / "quantbot.json").read_text())
    assert saved["strategies"][0]["id"] == "momentum" and saved["strategies"][0]["name"] == "动量"
    assert qb.url == "http://127.0.0.1:9001"
    assert connect_locally("momentum")[1] == saved["strategies"][0]["token"]  # reused
    project = tmp_path / "Grid Bot"
    project.mkdir()
    monkeypatch.chdir(project)
    assert QuantBot().name == "grid-bot"
    with pytest.raises(ValueError):
        QuantBot("Bad Name")


@pytest.mark.skipif(os.name != "posix", reason="QuantBot's local config lock uses flock")
def test_concurrent_client_registration_preserves_server_settings(tmp_path: Path) -> None:
    store = Store(tmp_path)
    store.write({"listen": "127.0.0.1:9001", "web_secret": "old"})
    client_dir = Path(__file__).resolve().parents[1] / "client"
    env = {**os.environ, "QB_DATA_DIR": str(tmp_path), "PYTHONPATH": str(client_dir)}
    processes = []
    try:
        with store.edit() as config:
            config["web_secret"] = "rotated"
            for sid in ("one", "two"):
                proc = subprocess.Popen(  # noqa: S603 - fixed Python fixture, separate strategy process
                    [
                        sys.executable,
                        "-c",
                        "import sys; from quantbot_client import connect_locally; "
                        "print('ready', flush=True); connect_locally(sys.argv[1])",
                        sid,
                    ],
                    env=env,
                    stdout=subprocess.PIPE,
                    text=True,
                )
                processes.append(proc)
                assert proc.stdout.readline().strip() == "ready"
            for proc in processes:
                with pytest.raises(subprocess.TimeoutExpired):
                    proc.wait(timeout=0.1)
        assert [proc.wait(timeout=5) for proc in processes] == [0, 0]
        data = store.read()
        assert data["web_secret"] == "rotated"
        assert {item["id"] for item in data["strategies"]} == {"one", "two"}
    finally:
        for proc in processes:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            proc.stdout.close()


def test_client_reports_metric_and_runs_custom_action(server: Server, tmp_path: Path) -> None:
    qb = QuantBot(
        url=f"http://127.0.0.1:{server.port}", token=TOKEN, state_file=str(tmp_path / "s")
    )
    qb.action(
        "refresh",
        lambda force: {"forced": force, "thread": threading.current_thread().name},
        label="Refresh cache",
        fields={"force": {"type": "boolean"}},
        confirm=True,
    )
    thread = serve(qb)
    try:
        qb.metric("equity", 12_000, label="Equity", unit="USDT")
        wait_until(
            lambda: "equity" in server.strategy.metrics and "refresh" in server.strategy.actions
        )
        assert server.strategy.metrics["equity"].summary()["value"] == 12_000
        assert server.strategy.actions["refresh"].confirm
        result = server.send("action:refresh", {"force": True})
        assert result.ok and result.data == {"forced": True, "thread": "trading"}
    finally:
        qb.close()
        thread.join(5)
        assert not thread.is_alive()


def test_fill_survives_client_restart_and_lost_ack(server: Server) -> None:
    url = f"http://127.0.0.1:{server.port}"
    original = QuantBot(url=url, token=TOKEN)
    original.fill("persistent fill")
    for index in range(550):
        original.status(str(index))
    original.close(timeout=0)
    restarted = QuantBot(url=url, token=TOKEN)
    request = restarted._request
    attempted = []

    def lose_first_ack(method, path, body=None, timeout=10):
        response = request(method, path, body, timeout)
        if method == "POST" and body and body.get("type") == "fill":
            attempted.append(body["event_id"])
            if len(attempted) == 1:
                raise OSError("ack lost")
        return response

    restarted._request = lose_first_ack
    with restarted:
        wait_until(lambda: len(attempted) == 2 and restarted._outbox.peek() is None)
    assert attempted[0] == attempted[1]
    assert sum("persistent fill" in item[1] for item in server.notes) == 1
