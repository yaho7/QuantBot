"""Remove this uv tool installation and the state owned by QuantBot."""

from __future__ import annotations

import errno
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from quantbot.audit import AUDIT_FILE
from quantbot.command_alias import ShortCommand
from quantbot.config import (
    FILE_NAME,
    USED_LINKS_FILE,
    ConfigError,
    Store,
    check_listen,
    local_origin,
)
from quantbot.editor import EDITOR_FILE
from quantbot.github import GITHUB_FILE
from quantbot.i18n import tr
from quantbot.service import NAME, Service
from quantbot.updates import CACHE_FILE, find_uv
from quantbot.workspace import WORKSPACE_FILE

STATE_FILES = {
    FILE_NAME,
    AUDIT_FILE,
    CACHE_FILE,
    EDITOR_FILE,
    GITHUB_FILE,
    USED_LINKS_FILE,
    WORKSPACE_FILE,
    "editor.lock",
    f".{FILE_NAME}.lock",
    f".{USED_LINKS_FILE}.lock",
    f".{EDITOR_FILE}.lock",
    f".{GITHUB_FILE}.lock",
}
TEMP_STATE = re.compile(r"\.(?:quantbot|update)-[a-z0-9_]{8}")


def _running_instance(directory: Path) -> bool:
    """Detect a foreground server via its unauthenticated overview response."""
    try:
        listen = os.environ.get("QB_LISTEN") or Store(directory).read().get("listen")
        if not listen:
            return False
        address = local_origin(check_listen(str(listen)))
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"{address}/ui/api/overview", timeout=1):
            return False
    except urllib.error.HTTPError as exc:
        with exc:
            if exc.code != 401:
                return False
            try:
                return json.loads(exc.read(512)) == {"ok": False, "error": "login required"}
            except (OSError, ValueError):
                return False
    except (ValueError, OSError):
        return False


@dataclass(frozen=True)
class UninstallPlan:
    uv: str
    prefix: Path
    shortcut: ShortCommand
    directories: tuple[Path, ...]
    service: Service | None
    service_directory: Path | None

    @classmethod
    def prepare(cls, directory: Path, service: Service | None) -> UninstallPlan:
        prefix = Path(sys.prefix).resolve()
        shortcut = ShortCommand.detect()
        if (
            prefix.name != NAME
            or not (prefix / "uv-receipt.toml").is_file()
            or shortcut.target.resolve() != (prefix / "bin" / NAME).resolve()
        ):
            raise ConfigError(tr("请从 uv 安装的 QuantBot 命令运行完全卸载。"))
        uv = find_uv()
        if not uv:
            raise ConfigError(tr("找不到 uv。请先恢复 uv 命令，再重试卸载。"))
        directories = [directory.resolve()]
        service_directory = None
        if service is not None and service.installed():
            command, managed_dir = service.configured_instance()
            if command.resolve() != shortcut.target.resolve():
                raise ConfigError(tr("后台服务属于另一套 QuantBot 安装（{0}）。", command))
            service_directory = managed_dir.resolve()
            if service_directory not in directories:
                directories.append(service_directory)
        return cls(uv, prefix, shortcut, tuple(directories), service, service_directory)

    def stop_service(self) -> None:
        for directory in self.directories:
            if directory != self.service_directory and _running_instance(directory):
                self._require_stop(directory)
        if self.service and self.service.installed():
            command, directory = self.service.configured_instance()
            if (
                command.resolve() != self.shortcut.target.resolve()
                or directory.resolve() != self.service_directory
            ):
                raise ConfigError(tr("后台服务配置已变更，请重新运行卸载。"))
            self.service.uninstall()
        for directory in self.directories:
            if _running_instance(directory):
                self._require_stop(directory)

    @staticmethod
    def _require_stop(directory: Path) -> None:
        raise ConfigError(tr("请先停止仍在运行的 QuantBot（{0}），再重试卸载。", directory))

    def remove_state(self) -> None:
        self.shortcut.disable()
        if self.service and self.service.kind == "launchd":
            self.service.log_file.unlink(missing_ok=True)
        for directory in self.directories:
            if not directory.is_dir():
                continue
            for path in directory.iterdir():
                if (path.name in STATE_FILES or TEMP_STATE.fullmatch(path.name)) and (
                    path.is_symlink() or path.is_file()
                ):
                    path.unlink(missing_ok=True)
            if directory.name == NAME:
                try:
                    directory.rmdir()
                except OSError as exc:
                    if exc.errno not in {errno.ENOENT, errno.ENOTEMPTY, errno.EEXIST}:
                        raise

    def remove_program(self) -> None:
        # uv receives the locations belonging to this executable, including custom installs.
        env = dict(
            os.environ,
            UV_TOOL_DIR=str(self.prefix.parent),
            UV_TOOL_BIN_DIR=str(self.shortcut.target.parent),
        )
        try:
            result = subprocess.run(  # noqa: S603
                [self.uv, "tool", "uninstall", NAME],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ConfigError(tr("无法完成 uv 卸载：{0}", exc)) from exc
        if result.returncode:
            raise ConfigError(tr("uv 卸载失败：{0}", (result.stderr or result.stdout).strip()))
