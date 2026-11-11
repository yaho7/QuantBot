"""The dedicated Linux identity used for workspace processes."""

from __future__ import annotations

import asyncio
import os
import shutil
import signal
import subprocess
import sys
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from quantbot.config import ConfigError, Store
from quantbot.i18n import tr

WORKSPACE_FILE = "workspace.json"
WORKSPACE_USER = "quantbot-workspace"
WORKSPACE_HOME = Path("/var/lib/quantbot-workspace")
DEFAULT_ROOT = Path("/srv/quantbot/strategies")


@dataclass(frozen=True)
class Workspace:
    root: Path
    uid: int
    gid: int
    home: Path

    @staticmethod
    def supported() -> bool:
        return sys.platform.startswith("linux") and os.geteuid() == 0

    @classmethod
    def configured(cls, data_dir: Path, root: Path) -> Workspace | None:
        data = Store(data_dir, filename=WORKSPACE_FILE).read()
        if data.get("root") != str(root):
            return None
        if not cls.supported():
            raise ConfigError(tr("工作区运行需要 Linux 上以 root 运行的 QuantBot 服务。"))
        account = cls._account()
        if (data.get("uid"), data.get("gid")) != (account.pw_uid, account.pw_gid):
            raise ConfigError(tr("工作区系统账号已变更，请在服务器上检查配置。"))
        if not root.is_dir() or root.resolve() != root or root.stat().st_uid != account.pw_uid:
            raise ConfigError(tr("工作区目录已变更，请在服务器上检查配置。"))
        return cls(root, account.pw_uid, account.pw_gid, Path(account.pw_dir))

    @staticmethod
    def _account() -> Any:
        import pwd

        try:
            account = pwd.getpwnam(WORKSPACE_USER)
        except KeyError as exc:
            raise ConfigError(tr("找不到工作区系统账号。")) from exc
        if not account.pw_uid or not account.pw_gid or Path(account.pw_dir) != WORKSPACE_HOME:
            raise ConfigError(tr("工作区系统账号已被其他用途占用。"))
        return account

    @classmethod
    def initialize(cls, data_dir: Path, path: Path) -> Workspace:
        if not cls.supported():
            raise ConfigError(tr("请在 Linux 服务器上以 root 初始化工作区。"))
        from quantbot.editor import Editor, editor_lock

        root = path.expanduser().resolve()
        editor = Editor(root, data_dir)
        if editor.data_dir.is_relative_to(root):
            raise ConfigError(tr("请选择 QuantBot 数据目录之外的策略文件夹。"))
        store = Store(data_dir, filename=WORKSPACE_FILE)
        with editor_lock(data_dir):
            saved_root = store.read().get("root")
            if saved_root and saved_root != str(root):
                raise ConfigError(tr("工作区已配置为 {0}。", saved_root))
            if current := cls.configured(data_dir, root):
                editor.write_config()
                return current
            if not shutil.which("setpriv", path=os.defpath) or not shutil.which(
                "setsid", path=os.defpath
            ):
                raise ConfigError(tr("请先安装 util-linux，再初始化工作区。"))
            root.mkdir(parents=True, exist_ok=True, mode=0o750)
            if any(root.iterdir()):
                raise ConfigError(tr("请为工作区选择空目录。已有策略仓库可以在初始化后绑定。"))
            import pwd

            try:
                pwd.getpwnam(WORKSPACE_USER)
            except KeyError:
                useradd = shutil.which("useradd", path="/usr/sbin:/usr/bin:/sbin:/bin")
                if not useradd:
                    raise ConfigError(tr("找不到 useradd，无法创建工作区系统账号。")) from None
                done = subprocess.run(  # noqa: S603
                    [
                        useradd,
                        "--system",
                        "--user-group",
                        "--create-home",
                        "--home-dir",
                        str(WORKSPACE_HOME),
                        "--shell",
                        "/usr/sbin/nologin",
                        WORKSPACE_USER,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                if done.returncode:
                    raise ConfigError(
                        tr("无法创建工作区系统账号：{0}", done.stderr.strip())
                    ) from None
            account = cls._account()
            current = cls(root, account.pw_uid, account.pw_gid, Path(account.pw_dir))
            options = {**current.process_options(), "cwd": "/"}
            accessible = subprocess.run(  # noqa: S603
                current.command(["/usr/bin/test", "-x", str(root.parent)]),
                env=current.environment(),
                check=False,
                timeout=5,
                **options,
            )
            if accessible.returncode:
                raise ConfigError(
                    tr("工作区账号无法进入目录 {0}。请选择 /srv 下的目录。", root.parent)
                )
            with editor._directory([]) as fd:
                os.fchown(fd, account.pw_uid, account.pw_gid)
                os.fchmod(fd, 0o750)
            store.write({"root": str(root), "uid": account.pw_uid, "gid": account.pw_gid})
            editor.write_config()
        return current

    def command(self, args: list[str]) -> list[str]:
        setpriv = shutil.which("setpriv", path=os.defpath)
        if not setpriv:
            raise ConfigError(tr("请先安装 util-linux，再初始化工作区。"))
        return [setpriv, "--no-new-privs", "--", *args]

    def process_options(self) -> dict[str, Any]:
        return {
            "user": self.uid,
            "group": self.gid,
            "extra_groups": [],
            "umask": 0o077,
            "cwd": self.root,
        }

    def environment(self) -> dict[str, str]:
        return {
            "HOME": str(self.home),
            "USER": WORKSPACE_USER,
            "LOGNAME": WORKSPACE_USER,
            "PATH": f"{self.home}/.local/bin:/usr/local/bin:/usr/bin:/bin",
            "LANG": "C.UTF-8",
        }


async def stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return

    def send(sig: signal.Signals) -> None:
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            with suppress(ProcessLookupError):
                process.send_signal(sig)

    send(signal.SIGTERM)
    try:
        await asyncio.wait_for(process.wait(), timeout=3)
    except asyncio.TimeoutError:
        send(signal.SIGKILL)
        await process.wait()
