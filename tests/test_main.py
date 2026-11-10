"""Handing /data to the quantbot user when the container starts as root."""

from __future__ import annotations

from pathlib import Path

import pytest

from quantbot import __main__ as entry


def test_drop_privileges_hands_data_over_then_switches_user(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "quantbot.json").write_text("{}")  # written by a root `setup`
    calls: list[tuple[str, object]] = []
    monkeypatch.setenv("QB_UID", "10001")
    monkeypatch.setenv("QB_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(entry.os, "geteuid", lambda: 0)
    monkeypatch.setattr(entry.os, "lchown", lambda p, u, g: calls.append(("chown", Path(p).name)))
    monkeypatch.setattr(entry.os, "setgroups", lambda groups: calls.append(("groups", groups)))
    monkeypatch.setattr(entry.os, "setgid", lambda gid: calls.append(("gid", gid)))
    monkeypatch.setattr(entry.os, "setuid", lambda uid: calls.append(("uid", uid)))
    entry.drop_privileges()
    assert calls == [
        ("chown", tmp_path.name),
        ("chown", "quantbot.json"),
        ("groups", []),
        ("gid", 10001),
        ("uid", 10001),
    ]


def test_drop_privileges_does_nothing_outside_the_image(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("QB_UID", raising=False)
    monkeypatch.setattr(entry.os, "geteuid", lambda: 0)
    monkeypatch.setattr(entry.os, "setuid", lambda uid: pytest.fail("must not switch user"))
    entry.drop_privileges()
    monkeypatch.setenv("QB_UID", "10001")
    monkeypatch.setattr(entry.os, "geteuid", lambda: 501)
    entry.drop_privileges()
