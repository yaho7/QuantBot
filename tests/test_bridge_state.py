from __future__ import annotations

import json
import threading
import time
import urllib.request
from pathlib import Path

import pytest

from tgctl.bridge import Bridge, Stopped
from tgctl.heartbeat import Heartbeat
from tgctl.state import State


def test_commands_run_on_the_thread_that_sleeps() -> None:
    bridge = Bridge()
    seen: list[str] = []
    worker = threading.Thread(target=lambda: bridge.sleep(5))
    worker.start()
    future = bridge.submit(lambda: seen.append(threading.current_thread().name) or "done")
    assert future.result(timeout=2) == "done"
    assert seen == [worker.name]
    bridge.request_stop()
    worker.join(timeout=2)
    assert not worker.is_alive()


def test_sleep_returns_true_on_time_and_false_on_stop() -> None:
    bridge = Bridge()
    start = time.monotonic()
    assert bridge.sleep(0.05) is True
    assert time.monotonic() - start >= 0.05
    bridge.request_stop()
    assert bridge.sleep(10) is False


def test_errors_come_back_and_stopped_bridge_refuses_work() -> None:
    bridge = Bridge()

    def boom() -> None:
        raise ValueError("bad")

    failing = bridge.submit(boom)
    assert bridge.process() == 1
    with pytest.raises(ValueError, match="bad"):
        failing.result(timeout=1)

    waiting = bridge.submit(lambda: 1)
    bridge.request_stop()
    bridge.cancel_pending()
    with pytest.raises(Stopped):
        waiting.result(timeout=1)
    with pytest.raises(Stopped):
        bridge.submit(lambda: 1).result(timeout=1)


def test_pause_survives_restart_and_bad_file_starts_paused(tmp_path: Path) -> None:
    state = State(tmp_path)
    assert state.paused is False
    assert state.set_paused(True, "risk") is True
    assert state.set_paused(True, "risk") is False
    again = State(tmp_path)
    assert again.paused and again.pause_reason == "risk"

    (tmp_path / "state.json").write_text("{broken")
    assert State(tmp_path).paused is True


def test_audit_appends_json_lines(tmp_path: Path) -> None:
    state = State(tmp_path)
    state.audit("pause", user=1)
    state.audit("flatten", op="abc", result="ok")
    lines = [json.loads(x) for x in (tmp_path / "audit.jsonl").read_text().splitlines()]
    assert [x["action"] for x in lines] == ["pause", "flatten"] and lines[1]["op"] == "abc"


def test_heartbeat_rate_limit_and_fail_body() -> None:
    sent: list[tuple[str, str, bytes | None]] = []
    done = threading.Event()

    def opener(request: urllib.request.Request, timeout: float) -> int:
        sent.append((request.get_method(), request.full_url, request.data))
        done.set()
        return 200

    beat = Heartbeat("https://hc-ping.com/abc/", min_interval=60, opener=opener)
    assert beat.ping() is True
    assert done.wait(2)
    assert beat.ping() is False
    beat.fail("Traceback ...")
    assert sent == [
        ("GET", "https://hc-ping.com/abc", None),
        ("POST", "https://hc-ping.com/abc/fail", b"Traceback ..."),
    ]
    assert Heartbeat(None).ping() is False
    with pytest.raises(ValueError):
        Heartbeat("file:///etc/passwd")
