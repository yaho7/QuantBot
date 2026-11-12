"""Checks and upgrades using a fake GitHub API and uv."""

from __future__ import annotations

import json
from pathlib import Path
from subprocess import CompletedProcess
from typing import Any

from quantbot.updates import CHECK_EVERY, Installed, Updater

OLD, NEW = "1" * 40, "2" * 40
REPO = "https://github.com/yaho7/QuantBot"


def test_tag_cache_schedule_notice_and_upgrade(tmp_path: Path) -> None:
    now = 1_000_000.0
    fetches, commands = [], []

    def fetch(path: str) -> Any:
        fetches.append(path)
        assert path == "/tags?per_page=100&page=1"
        return [{"name": "v0.3.0", "commit": {"sha": NEW}}]

    def run(command: list[str], **kwargs: Any) -> CompletedProcess[str]:
        commands.append(command)
        return CompletedProcess(
            command, 0, f"v0.3.0 ({NEW[:7]})" if command[-1] == "--version" else "installed", ""
        )

    current = Installed("0.1.0", OLD, "v0.2.0", REPO)
    updater = Updater(
        tmp_path,
        fetch=fetch,
        current=lambda: current,
        run=run,
        uv=lambda: "/bin/uv",
        clock=lambda: now,
    )
    result = updater.check_if_due()
    assert result and result["available"] and result["latest"] == "v0.3.0"
    assert updater.cached() == result and updater.check_if_due() is None
    assert updater.take_notice() == "v0.3.0"
    now += CHECK_EVERY
    assert updater.check_if_due() and updater.take_notice() is None
    assert fetches == ["/tags?per_page=100&page=1"] * 2

    assert updater.upgrade() == (True, "installed")
    assert commands[0][1:4] == ["tool", "run", "--isolated"]
    assert commands[1][-1] == f"quantbot @ git+{REPO}@{NEW}"
    assert commands[2][-1] == "--version"
    assert updater.cached() is None


def test_tag_upgrade_and_error_preserve_cache(tmp_path: Path) -> None:
    def fetch(path: str) -> list[dict[str, Any]]:
        assert path == "/tags?per_page=100&page=1"
        return [{"name": "v0.3.0", "commit": {"sha": NEW}}]

    commands = []

    def run(command: list[str], **kwargs: Any) -> CompletedProcess[str]:
        commands.append(command)
        if command[1:3] == ["tool", "run"] or command[-1].endswith(OLD):
            return CompletedProcess(command, 0, "ok", "")
        return CompletedProcess(command, 1, "", "uv failed")

    current = Installed("0.1.0", OLD, "refs/tags/v0.2.0", REPO)
    updater = Updater(tmp_path, fetch=fetch, current=lambda: current, run=run, uv=lambda: "/bin/uv")
    assert current.label == "v0.2.0 (1111111)"
    assert updater.check()["latest"] == "v0.3.0"
    ok, message = updater.upgrade()
    assert not ok and "已恢复" in message and "uv failed" in message
    assert commands[1][-1] == f"quantbot @ git+{REPO}@{NEW}"
    assert commands[2][-1] == f"quantbot @ git+{REPO}@{OLD}"

    def offline(path: str) -> Any:
        raise OSError("offline")

    updater.fetch = offline
    result = updater.check()
    assert result["available"] and "offline" in result["error"]
    assert updater.cached() == result
    assert updater.upgrade() == (False, result["error"])
    current = Installed("0.3.0", NEW, "v0.3.0")
    assert updater.cached() is None


def test_tag_check_orders_versions_across_pages_and_discards_old_cache(tmp_path: Path) -> None:
    def fetch(path: str) -> list[dict[str, Any]]:
        if path.endswith("&page=1"):
            return [{"name": "v0.9.99", "commit": {"sha": OLD}}] + [
                {"name": f"v100.0.{index}-rc.1", "commit": {"sha": OLD}} for index in range(99)
            ]
        assert path.endswith("&page=2")
        return [{"name": tag} for tag in ("9.10.0", "v0.10.0", "v0.9.0")]

    current = Installed("0.1.0", OLD, "v0.9.99", REPO)
    updater = Updater(tmp_path, fetch=fetch, current=lambda: current)
    updater.path.write_text(json.dumps({"current": OLD, "checked": 1, "latest": NEW}))
    assert updater.cached() is None
    result = updater.check()
    assert result["available"] and result["latest"] == "v0.10.0"


def test_non_tag_install_does_not_check_or_upgrade(tmp_path: Path) -> None:
    def fetch(path: str) -> Any:
        raise AssertionError("only tagged installations should check")

    current = Installed("0.1.0", NEW, "main", REPO)
    updater = Updater(tmp_path, fetch=fetch, current=lambda: current, uv=lambda: "/bin/uv")
    result = updater.check()
    assert not result["available"] and "安装版本标签" in result["error"]
    assert updater.check_if_due() is None
    assert updater.upgrade() == (False, result["error"])
