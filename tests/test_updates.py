"""Checks and upgrades using a fake GitHub API and uv."""

from __future__ import annotations

from pathlib import Path
from subprocess import CompletedProcess
from typing import Any

from quantbot.updates import CHECK_EVERY, Installed, Updater

OLD, NEW = "1" * 40, "2" * 40


def test_branch_cache_schedule_notice_and_upgrade(tmp_path: Path) -> None:
    now = 1_000_000.0
    fetches, commands = [], []

    def fetch(path: str) -> dict[str, Any]:
        fetches.append(path)
        return {"ahead_by": 1, "commits": [{"sha": NEW, "commit": {"message": "更新\n详情"}}]}

    def run(command: list[str], **kwargs: Any) -> CompletedProcess[str]:
        commands.append(command)
        return CompletedProcess(command, 0, "installed", "")

    current = Installed("0.1.0", OLD, "feature/updates")
    updater = Updater(
        tmp_path,
        fetch=fetch,
        current=lambda: current,
        run=run,
        uv=lambda: "/bin/uv",
        clock=lambda: now,
    )
    result = updater.check_if_due()
    assert result and result["available"] and result["latest"] == NEW
    assert result["commits"] == [{"sha": NEW[:7], "message": "更新", "date": None}]
    assert updater.cached() == result and updater.check_if_due() is None
    assert updater.take_notice() == NEW[:7]
    now += CHECK_EVERY
    assert updater.check_if_due() and updater.take_notice() is None
    assert fetches == [f"/compare/{OLD}...feature%2Fupdates"] * 2

    assert updater.upgrade() == (True, "installed")
    assert commands == [["/bin/uv", "tool", "upgrade", "--reinstall", "quantbot"]]
    assert updater.cached() is None


def test_tag_upgrade_and_error_preserve_cache(tmp_path: Path) -> None:
    def fetch(path: str) -> dict[str, str]:
        assert path == "/releases/latest"
        return {"tag_name": "v0.3.0"}

    commands = []

    def run(command: list[str], **kwargs: Any) -> CompletedProcess[str]:
        commands.append(command)
        return CompletedProcess(command, 1, "", "uv failed")

    current = Installed("0.2.0", OLD, "v0.2.0", "https://github.com/yaho7/QuantBot")
    updater = Updater(tmp_path, fetch=fetch, current=lambda: current, run=run, uv=lambda: "/bin/uv")
    assert updater.check()["latest"] == "v0.3.0"
    assert updater.upgrade() == (False, "uv failed")
    assert commands[0][-1] == "quantbot @ git+https://github.com/yaho7/QuantBot@v0.3.0"

    def offline(path: str) -> Any:
        raise OSError("offline")

    updater.fetch = offline
    result = updater.check()
    assert result["available"] and "offline" in result["error"]
    assert updater.cached() == result
    current = Installed("0.3.0", NEW, "v0.3.0")
    assert updater.cached() is None
