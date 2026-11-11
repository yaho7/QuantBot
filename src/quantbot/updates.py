"""Is there a newer QuantBot, and install it.

Stable versions are Git tags. The installed tag and commit come from uv's
direct_url.json. An older branch installation can migrate to a tag that contains
its installed commit.

The running QuantBot checks every 6 hours and keeps the answer in `update.json`,
so the CLI can show a hint without going online.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
from typing import Any

from quantbot import __version__
from quantbot.i18n import tr

log = logging.getLogger(__name__)

API = "https://api.github.com/repos/yaho7/QuantBot"
CHECK_EVERY = 6 * 3600
CACHE_FILE = "update.json"
TAG = re.compile(r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


def tag_version(tag: str) -> tuple[int, ...]:
    match = TAG.fullmatch(tag)
    return tuple(map(int, match.groups())) if match else ()


@dataclass(frozen=True)
class Installed:
    version: str
    commit: str | None  # None: not installed from git, e.g. a development checkout
    ref: str | None  # the branch or tag it was installed from
    url: str | None = None  # the git repository it was installed from

    @property
    def tag(self) -> str:
        name = (self.ref or "").removeprefix("refs/tags/")
        return name if tag_version(name) else ""

    @property
    def label(self) -> str:
        if not self.commit:
            return tr("{0}（开发版）", self.version)
        if self.tag:
            return f"{self.tag} ({self.commit[:7]})"
        return tr("{0}（{1} {2}）", self.version, self.ref or "main", self.commit[:7])


def installed() -> Installed:
    try:
        raw = metadata.distribution("quantbot").read_text("direct_url.json")
        direct = json.loads(raw) if raw else {}
    except (metadata.PackageNotFoundError, OSError, ValueError):
        direct = {}
    vcs = direct.get("vcs_info") or {}
    commit = vcs.get("commit_id") if vcs.get("vcs") == "git" else None
    if not commit:
        return Installed(__version__, None, None)
    return Installed(__version__, commit, vcs.get("requested_revision"), direct.get("url"))


def github_json(path: str, source: str | None = None) -> Any:
    api = API
    if source:
        origin = urllib.parse.urlsplit(source.removeprefix("git+"))
        repo = origin.path.strip("/").removesuffix(".git")
        if origin.hostname != "github.com" or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            raise ValueError(tr("此安装来源不支持 GitHub 标签检查。"))
        api = f"https://api.github.com/repos/{repo}"
    request = urllib.request.Request(  # noqa: S310 - fixed https URL
        f"{api}{path}",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "quantbot"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310
        return json.loads(response.read())


def find_uv() -> str | None:
    """uv, also when the service's PATH does not include ~/.local/bin."""
    found = shutil.which("uv")
    if found:
        return found
    for candidate in (
        Path.home() / ".local/bin/uv",
        Path.home() / ".cargo/bin/uv",
        Path("/opt/homebrew/bin/uv"),
        Path("/usr/local/bin/uv"),
    ):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def update_label(result: dict[str, Any] | None) -> str:
    latest = (result or {}).get("latest")
    return latest if isinstance(latest, str) and tag_version(latest) else ""


class Updater:
    def __init__(
        self,
        data_dir: Path,
        fetch: Callable[[str], Any] | None = None,
        current: Callable[[], Installed] = installed,
        run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
        uv: Callable[[], str | None] = find_uv,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.path = Path(data_dir) / CACHE_FILE
        self.current = current
        self.fetch = fetch or (lambda path: github_json(path, self.current().url))
        self.run = run
        self.uv = uv
        self.clock = clock
        self._lock = threading.RLock()

    # ------------------------------------------------------------- check

    def cached(self) -> dict[str, Any] | None:
        """The last answer, if it still describes the installed commit."""
        try:
            data = json.loads(self.path.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        now = self.current()
        if (
            not isinstance(data, dict)
            or data.get("channel") != "tags"
            or (data.get("current"), data.get("ref")) != (now.commit, now.ref)
        ):
            return None
        if not isinstance(data.get("checked"), int | float):
            return None
        return data

    def due(self) -> bool:
        data = self.cached()
        return data is None or self.clock() - data["checked"] >= CHECK_EVERY

    def check(self) -> dict[str, Any]:
        """Ask GitHub now and remember the answer."""
        with self._lock:
            return self._check()

    def _latest_tag(self) -> tuple[str, str] | None:
        latest: tuple[tuple[int, ...], str, str] = ((), "", "")
        page = 1
        while True:
            tags = self.fetch(f"/tags?per_page=100&page={page}")
            if not isinstance(tags, list):
                raise ValueError(tr("GitHub 返回的标签列表格式不对。"))
            for tag in tags:
                name = str(tag.get("name", ""))
                if version := tag_version(name):
                    sha = str((tag.get("commit") or {}).get("sha") or "")
                    if not re.fullmatch(r"[a-fA-F0-9]{40}|[a-fA-F0-9]{64}", sha):
                        raise ValueError(tr("GitHub 返回的标签列表格式不对。"))
                    latest = max(latest, (version, name, sha))
            if len(tags) < 100:
                return (latest[1], latest[2]) if latest[0] else None
            page += 1

    def _check(self) -> dict[str, Any]:
        now = self.current()
        previous = self.cached() or {}
        result: dict[str, Any] = {
            "channel": "tags",
            "current": now.commit,
            "ref": now.ref,
            "version": now.label,
            "checked": self.clock(),
            "checked_at": None,
            "available": False,
            "latest": None,
            "behind": 0,
            "commits": [],
            "error": None,
            "notified": previous.get("notified"),
        }
        result["checked_at"] = datetime.fromtimestamp(result["checked"], timezone.utc).isoformat(
            timespec="seconds"
        )
        if not now.commit:
            result["error"] = tr("这是开发版，不是从 GitHub 装的，不检查更新。")
            return result
        try:
            latest = self._latest_tag()
            if latest is None:
                result["error"] = tr("仓库还没有可安装的版本标签。")
            else:
                tag, sha = latest
                result["latest"] = tag
                if now.tag:
                    result["available"] = tag_version(tag) > tag_version(now.tag)
                else:
                    if sha == now.commit:
                        result["available"] = True
                    else:
                        comparison = self.fetch(f"/compare/{now.commit}...{sha}?per_page=1")
                        result["available"] = comparison.get("status") in {"ahead", "identical"}
                    if not result["available"]:
                        result["error"] = tr("最新标签 {0} 尚未包含当前安装的提交。", tag)
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            code = getattr(exc, "code", None)
            for key in ("available", "latest"):
                if key in previous:
                    result[key] = previous[key]
            result["error"] = (
                tr("GitHub 暂时不让查（每小时 60 次的限制），稍后再试。")
                if code in {403, 429}
                else tr("查不到 GitHub：{0}", exc)
            )
        self._save(result)
        return result

    def check_if_due(self) -> dict[str, Any] | None:
        with self._lock:
            return self._check() if self.current().commit and self.due() else None

    def take_notice(self) -> str | None:
        """Return a new revision once, including after a process restart."""
        with self._lock:
            result = self.cached()
            if not result or not result.get("available"):
                return None
            latest = result.get("latest")
            if not isinstance(latest, str) or latest == result.get("notified"):
                return None
            result["notified"] = latest
            self._save(result)
            return update_label(result)

    def _save(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".update-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    # ------------------------------------------------------------ update

    def upgrade(self) -> tuple[bool, str]:
        """Install the tag from the last update check. Returns (ok, output)."""
        with self._lock:
            return self._upgrade()

    def _upgrade(self) -> tuple[bool, str]:
        uv = self.uv()
        if not uv:
            return False, tr("没找到 uv。重新运行安装命令，也能更新到最新版。")
        now = self.current()
        if not now.commit:
            return False, tr("开发版请通过 Git 更新。")
        cached = self.cached() or {}
        latest = update_label(cached)
        if cached.get("error"):
            return False, cached["error"]
        if not cached.get("available") or not latest:
            return False, tr("已经是最新的版本。")
        if not now.url:
            return False, tr("找不到安装来源。请重新运行安装命令。")
        source = f"quantbot @ git+{now.url.removeprefix('git+')}@refs/tags/{latest}"
        command = [uv, "tool", "install", "--force", "--reinstall", "--python", "3.12", source]
        try:
            done = self.run(command, capture_output=True, text=True, timeout=600, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return False, tr("更新没跑完：{0}", exc)
        output = ((done.stdout or "") + (done.stderr or "")).strip()
        if done.returncode != 0:
            return False, output[-2000:] or tr("uv 退出码 {0}", done.returncode)
        try:
            self.path.unlink(missing_ok=True)  # describe the new commit next time
        except OSError:
            log.exception("Could not clear the update cache")
        return True, output[-2000:]
