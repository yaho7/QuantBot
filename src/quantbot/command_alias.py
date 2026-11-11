"""Manage the optional qb entry point in QuantBot's executable directory."""

from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

from quantbot.config import ConfigError
from quantbot.i18n import tr


@dataclass(frozen=True)
class ShortCommand:
    target: Path

    @classmethod
    def detect(cls) -> ShortCommand:
        invoked = Path(sys.argv[0]).absolute()
        if invoked.name in {"quantbot", "qb"}:
            candidate = invoked.with_name("quantbot")
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return cls(candidate)
        target = shutil.which("quantbot")
        if target:
            return cls(Path(target).absolute())
        raise ConfigError(tr("找不到 QuantBot 命令。请先安装 QuantBot，再启用 qb。"))

    @property
    def path(self) -> Path:
        return self.target.with_name("qb")

    def enabled(self) -> bool:
        try:
            return self.path.readlink() == Path(self.target.name)
        except OSError:
            return False

    def conflict(self) -> Path | None:
        if os.path.lexists(self.path) and not self.enabled():
            return self.path
        found = shutil.which("qb")
        if found and Path(found).parent.resolve() != self.path.parent.resolve():
            return Path(found).absolute()
        return None

    def enable(self) -> None:
        if conflict := self.conflict():
            raise ConfigError(tr("同名命令已存在（{0}）。请改用 quantbot。", conflict))
        if self.enabled():
            return
        try:
            self.path.symlink_to(self.target.name)
        except FileExistsError as exc:
            if not self.enabled():
                raise ConfigError(tr("命令路径已被占用（{0}）。", self.path)) from exc
        except OSError as exc:
            raise ConfigError(tr("无法创建短命令 qb（{0}）\n{1}", self.path, exc)) from exc

    def disable(self) -> None:
        if not self.enabled():
            return
        try:
            self.path.unlink(missing_ok=True)
        except OSError as exc:
            raise ConfigError(tr("无法停用短命令 qb（{0}）\n{1}", self.path, exc)) from exc
