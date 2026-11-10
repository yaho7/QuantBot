from __future__ import annotations

import json
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from quantgram.audit import Audit
from quantgram.bridge import Bridge, Stopped
from quantgram.heartbeat import Heartbeat
from quantgram.notices import Expiries, is_quiet, parse_quiet


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


def test_audit_appends_json_lines(tmp_path: Path) -> None:
    log = Audit(tmp_path)
    log.write("pause", user=1)
    log.write("flatten", op="abc", result="ok")
    lines = [json.loads(x) for x in (tmp_path / "audit.jsonl").read_text().splitlines()]
    assert [x["action"] for x in lines] == ["pause", "flatten"] and lines[1]["op"] == "abc"


def test_quiet_hours_and_expiry_reminders() -> None:
    assert parse_quiet("23-07") == (23, 7) and parse_quiet("") is None
    assert is_quiet(23, (23, 7)) and is_quiet(3, (23, 7)) and not is_quiet(7, (23, 7))
    assert is_quiet(13, (12, 14)) and not is_quiet(14, (12, 14))
    with pytest.raises(ValueError):
        parse_quiet("8")
    expiries = Expiries()
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    expiries.watch("k", "Schwab", start + timedelta(hours=60))
    assert expiries.due(start) == []
    assert expiries.due(start + timedelta(hours=13)) == [
        ("k", "⏰ Schwab 的授权约 47 小时后过期，请尽快续期。")
    ]
    assert expiries.due(start + timedelta(hours=14)) == []
    assert [m for _, m in expiries.due(start + timedelta(hours=61))] == [
        "⛔ Schwab 的授权已经过期，请重新授权。"
    ]
    assert expiries.due(start + timedelta(hours=62)) == []
    expiries.watch("k", "Schwab", start + timedelta(days=9))  # renewed
    assert expiries.due(start + timedelta(days=8, hours=1))[0][1].startswith("⏰")
    with pytest.raises(ValueError):
        expiries.watch("k", "x", datetime(2026, 1, 1))


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
