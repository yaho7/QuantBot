"""Is there a newer QuantBot, and install it.

Stable versions are Git tags. The installed tag and commit come from uv's
direct_url.json.

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
from quantbot.config import Store, data_dir
from quantbot.i18n import tr
from quantbot.service import executable

log = logging.getLogger(__name__)

API = "https://api.github.com/repos/yaho7/QuantBot"
CHECK_EVERY = 6 * 3600
CACHE_FILE = "update.json"
PIN_FILE = "update-pins.json"
COMMIT = re.compile(r"[0-9a-f]{40}")
TAG = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
TAG_INSTALL_REQUIRED = "请用一键安装脚本安装版本标签，再检查更新。"


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
    url, ref = direct.get("url"), vcs.get("requested_revision")
    if ref == commit:
        try:
            pinned = Store(data_dir(), filename=PIN_FILE).read().get(commit, {})
            if pinned.get("url") == url and tag_version(pinned.get("tag", "")):
                ref = pinned["tag"]
        except (OSError, ValueError, AttributeError):
            pass
    return Installed(__version__, commit, ref, url)


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
        self.pins = Store(Path(data_dir), filename=PIN_FILE)
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

    def _latest_tag(self) -> tuple[str, str | None]:
        latest: tuple[int, ...] = ()
        target = ("", None)
        pin = os.environ.get("QB_PINNED_VERSION")
        if pin and not tag_version(pin):
            raise ValueError(tr("QB_PINNED_VERSION 必须是 vX.Y.Z。"))
        page = 1
        while True:
            tags = self.fetch(f"/tags?per_page=100&page={page}")
            if not isinstance(tags, list):
                raise ValueError(tr("GitHub 返回的标签列表格式不对。"))
            for tag in tags:
                name = str(tag.get("name", ""))
                version = tag_version(name)
                if version > latest and (not pin or name == pin):
                    latest = version
                    sha = (tag.get("commit") or {}).get("sha")
                    target = (name, sha if isinstance(sha, str) and COMMIT.fullmatch(sha) else None)
            if len(tags) < 100:
                return target
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
            "latest_commit": None,
            "error": None,
            "notified": previous.get("notified"),
        }
        result["checked_at"] = datetime.fromtimestamp(result["checked"], timezone.utc).isoformat(
            timespec="seconds"
        )
        if not now.tag:
            result["error"] = tr(TAG_INSTALL_REQUIRED)
            return result
        try:
            tag, commit = self._latest_tag()
            if tag:
                result.update(
                    latest=tag,
                    latest_commit=commit,
                    available=tag_version(tag) > tag_version(now.tag),
                )
            else:
                result["error"] = tr("仓库还没有可安装的版本标签。")
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            code = getattr(exc, "code", None)
            for key in ("available", "latest", "latest_commit"):
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
            return self._check() if self.current().tag and self.due() else None

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
        if not now.tag:
            return False, tr(TAG_INSTALL_REQUIRED)
        cached = self.cached() or {}
        latest = update_label(cached)
        if cached.get("error"):
            return False, cached["error"]
        if not cached.get("available") or not latest:
            return False, tr("已经是最新的版本。")
        if not now.url:
            return False, tr("找不到安装来源。请重新运行安装命令。")
        commit = cached.get("latest_commit")
        if not isinstance(commit, str) or not COMMIT.fullmatch(commit):
            return False, tr("无法确认更新标签对应的提交，请重新检查更新。")
        pin = os.environ.get("QB_PINNED_VERSION")
        if pin and pin != latest:
            return False, tr("版本锁已变更，请重新检查更新。")
        if not now.commit or not COMMIT.fullmatch(now.commit):
            return False, tr("无法确认当前提交，不能准备回滚。")

        source = self._source(now.url, commit)
        good, output = self._run(
            [
                uv,
                "tool",
                "run",
                "--isolated",
                "--python",
                "3.12",
                "--from",
                source,
                "quantbot",
                "--version",
            ]
        )
        if not good:
            return False, tr("更新预检失败：{0}", output)

        self._remember(now.url, now.commit, now.tag)
        self._remember(now.url, commit, latest)
        good, output = self._install(uv, source)
        if good:
            good, validation = self._run([executable(), "--version"])
            if good and commit[:7] not in validation:
                good = False
                validation = tr("安装后的命令未报告目标提交 {0}。", commit[:7])
            if not good:
                output = validation
        if not good:
            restored, detail = self.restore(now)
            return False, self.rollback_message(output, restored, detail)
        try:
            self.path.unlink(missing_ok=True)  # describe the new commit next time
        except OSError:
            log.exception("Could not clear the update cache")
        return True, output

    @staticmethod
    def _source(url: str, commit: str) -> str:
        return f"quantbot @ git+{url.removeprefix('git+')}@{commit}"

    def _remember(self, url: str, commit: str, tag: str) -> None:
        with self.pins.edit() as pins:
            pins[commit] = {"url": url, "tag": tag}

    def _install(self, uv: str, source: str) -> tuple[bool, str]:
        return self._run(
            [uv, "tool", "install", "--force", "--reinstall", "--python", "3.12", source]
        )

    def restore(self, previous: Installed) -> tuple[bool, str]:
        with self._lock:
            uv = self.uv()
            if (
                not uv
                or not previous.url
                or not previous.commit
                or not COMMIT.fullmatch(previous.commit)
            ):
                return False, tr("没有可用的回滚版本。")
            return self._install(uv, self._source(previous.url, previous.commit))

    @staticmethod
    def rollback_message(error: str, restored: bool, detail: str) -> str:
        if restored:
            return tr("更新失败，已恢复上一版本：{0}", error)
        return tr("更新失败：{0}。恢复上一版本也失败：{1}", error, detail)

    def _run(self, command: list[str]) -> tuple[bool, str]:
        try:
            done = self.run(command, capture_output=True, text=True, timeout=600, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return False, tr("更新没跑完：{0}", exc)
        output = ((done.stdout or "") + (done.stderr or "")).strip()
        if done.returncode != 0:
            return False, output[-2000:] or tr("uv 退出码 {0}", done.returncode)
        return True, output[-2000:]
