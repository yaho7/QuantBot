"""Credentials for managed workspace programs, outside their project trees."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from quantbot.config import ConfigError, Store, new_token
from quantbot.i18n import tr
from quantbot.workspace import workspace_id


def fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class WorkspaceCredentials:
    def __init__(self, data_dir: Path) -> None:
        self.directory = data_dir / "workspace-credentials"

    def for_root(self, root: Path) -> Store:
        return Store(self.directory, filename=f"{workspace_id(root)}.json")

    def records(self) -> list[dict[str, Any]]:
        return [
            Store(self.directory, filename=path.name).read()
            for path in self.directory.glob("*.json")
        ]

    def bind(self, root: Path, sid: str, primary: str, *, rotate: bool = False) -> None:
        from quantbot.editor import editor_lock

        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        store = self.for_root(root)
        digest = fingerprint(primary)
        with editor_lock(self.directory):
            if any(
                item.get("QB_NAME") == sid
                and item.get("primary") == digest
                and item.get("workspace") != workspace_id(root)
                for item in self.records()
            ):
                raise ConfigError(tr("此策略已绑定到另一个工作区。"))
            saved = store.read()
            if not rotate and saved.get("QB_NAME") == sid and saved.get("primary") == digest:
                return
            store.write(
                {
                    "QB_NAME": sid,
                    "QB_TOKEN": new_token(),
                    "primary": digest,
                    "workspace": workspace_id(root),
                }
            )

    def revoke(self, root: Path) -> None:
        from quantbot.editor import editor_lock

        if self.directory.is_dir():
            with editor_lock(self.directory):
                self.for_root(root).path.unlink(missing_ok=True)
