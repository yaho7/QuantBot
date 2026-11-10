from __future__ import annotations

import json
import threading
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from quantbot.audit import Audit
from quantbot.heartbeat import Heartbeat
from quantbot.notices import Expiries, is_quiet, parse_quiet


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
