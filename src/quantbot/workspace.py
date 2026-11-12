"""The dedicated Linux identity used for workspace processes."""

from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import signal
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from quantbot.config import ConfigError, Store
from quantbot.i18n import tr

WORKSPACE_FILE = "workspace.json"
WORKSPACE_USER = "quantbot-workspace"
WORKSPACE_HOME = Path("/var/lib/quantbot-workspace")
DEFAULT_ROOT = Path("/srv/quantbot/strategies")
WEB_ROOT = DEFAULT_ROOT.parent


def workspace_id(root: Path) -> str:
    return hashlib.sha256(os.fsencode(root)).hexdigest()[:24]


def registered_roots(data: dict[str, Any]) -> list[Path]:
    roots = data.get("roots")
    values = [data.get("root"), *(roots if isinstance(roots, list) else [])]
    return list(
        dict.fromkeys(
            Path(value)
            for value in values
            if isinstance(value, str)
            and Path(value).is_absolute()
            and ".." not in Path(value).parts
        )
    )


def workspace_projects(data_dir: Path) -> list[dict[str, Any]]:
    from quantbot.editor import Editor

    editor = Editor.configured(data_dir)
    if not editor:
        return []
    managed = registered_roots(Store(data_dir, filename=WORKSPACE_FILE).read())
    return [
        {
            "id": workspace_id(root),
            "path": str(root),
            "name": root.name or str(root),
            "managed": root in managed and Workspace.supported(),
            "default": root == editor.root,
        }
        for root in dict.fromkeys([editor.root, *managed])
    ]


def unregister_workspace(data_dir: Path, root: Path) -> None:
    """Remove a project from the catalog, promoting the next default if needed."""
    from quantbot.editor import EDITOR_FILE, Editor, editor_lock

    registry = Store(data_dir, filename=WORKSPACE_FILE)
    editor_store = Store(data_dir, filename=EDITOR_FILE)
    with editor_lock(data_dir):
        state = registry.read()
        roots = registered_roots(state)
        editor = Editor.configured(data_dir)
        if root not in roots and (editor is None or editor.root != root):
            return
        remaining = [path for path in roots if path != root]
        if root in roots:
            state.update(
                root=str(remaining[0]) if remaining else "",
                roots=[str(path) for path in remaining],
            )
            registry.write(state)
        if editor is not None and editor.root == root:
            if remaining:
                Editor(remaining[0], data_dir).write_config()
            else:
                editor_store.path.unlink(missing_ok=True)


def _web_parts(path: str) -> list[str]:
    parts = path.split("/") if path else []
    try:
        if any(
            not part.strip()
            or part.startswith(".")
            or "\\" in part
            or len(part.encode("utf-8")) > 255
            or any(ord(char) < 32 or ord(char) == 127 for char in part)
            for part in parts
        ):
            raise ValueError
    except ValueError as exc:
        raise ConfigError(tr("请选择工作区范围内的目录，并使用有效的文件夹名称。")) from exc
    return parts


def _protected(info: os.stat_result) -> bool:
    return info.st_uid == os.geteuid() and not info.st_mode & 0o022


def _make_web_directory(fd: int, name: str) -> None:
    os.mkdir(name, mode=0o755, dir_fd=fd)
    created = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    try:
        os.fchmod(created, 0o755)
    finally:
        os.close(created)


@contextmanager
def _web_directory(
    parts: list[str], *, create_base: bool = False, owner: int | None = None
) -> Iterator[int]:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    if create_base:
        parent = os.open(WEB_ROOT.parent.parent, flags)
        try:
            with suppress(FileExistsError):
                _make_web_directory(parent, WEB_ROOT.parent.name)
        finally:
            os.close(parent)
    fd = os.open(WEB_ROOT.parent, flags)
    try:
        if not _protected(os.fstat(fd)):
            raise ConfigError(tr("目录需要由 QuantBot 服务账号管理。"))
        if create_base:
            with suppress(FileExistsError):
                _make_web_directory(fd, WEB_ROOT.name)
        for index, name in enumerate([WEB_ROOT.name, *parts]):
            next_fd = os.open(name, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            info = os.fstat(fd)
            owned_leaf = bool(parts) and index == len(parts) and info.st_uid == owner
            if not _protected(info) and not owned_leaf:
                raise ConfigError(tr("目录需要由 QuantBot 服务账号管理。"))
        yield fd
    finally:
        os.close(fd)


def _web_location(data_dir: Path, parts: list[str]) -> Path:
    path = WEB_ROOT.joinpath(*parts)
    if path.is_relative_to(data_dir.resolve()):
        raise ConfigError(tr("请选择 QuantBot 数据目录之外的策略文件夹。"))
    return path


def web_directories(data_dir: Path, path: str) -> dict[str, Any]:
    supported = Workspace.supported()
    if not supported:
        return {"supported": False}
    parts = _web_parts(path)
    location = _web_location(data_dir, parts)
    registered = registered_roots(Store(data_dir, filename=WORKSPACE_FILE).read())
    owner = _workspace_owner()
    folders = []
    empty = True
    owned = False
    try:
        with _web_directory(parts, owner=owner) as fd, os.scandir(fd) as entries:
            owned = os.fstat(fd).st_uid == owner
            for entry in entries:
                empty = False
                if entry.name.startswith(".") or not entry.is_dir(follow_symlinks=False):
                    continue
                info = entry.stat(follow_symlinks=False)
                if (_protected(info) or info.st_uid == owner) and not (
                    location / entry.name
                ).is_relative_to(data_dir.resolve()):
                    folders.append(entry.name)
    except FileNotFoundError:
        if parts:
            raise
    overlaps = any(
        root != location and (root.is_relative_to(location) or location.is_relative_to(root))
        for root in registered
    )
    return {
        "supported": True,
        "base": str(WEB_ROOT),
        "folders": sorted(folders, key=str.casefold),
        "empty": empty,
        "selectable": bool(parts) and not overlaps and (empty or owned),
        "can_create": not owned and not any(location.is_relative_to(root) for root in registered),
    }


def web_create_directory(data_dir: Path, path: str, name: str) -> str:
    if not Workspace.supported():
        raise ConfigError(tr("请在 Linux 服务器上以 root 初始化工作区。"))
    parts, child = _web_parts(path), _web_parts(name)
    if len(child) != 1:
        raise ConfigError(tr("请输入单个文件夹名称。"))
    from quantbot.editor import editor_lock

    _web_location(data_dir, parts + child)
    with editor_lock(data_dir):
        location = WEB_ROOT.joinpath(*parts, name)
        if any(
            location.is_relative_to(root)
            for root in registered_roots(Store(data_dir, filename=WORKSPACE_FILE).read())
        ):
            raise ConfigError(tr("请在已打开的工作区中管理它的子目录。"))
        try:
            with _web_directory(parts, create_base=True) as fd:
                _make_web_directory(fd, name)
        except FileExistsError as exc:
            raise ConfigError(tr("同名文件夹或文件已存在。")) from exc
    return "/".join(parts + child)


def web_initialize(data_dir: Path, path: str) -> Workspace:
    if not Workspace.supported():
        raise ConfigError(tr("请在 Linux 服务器上以 root 初始化工作区。"))
    saved = Store(data_dir, filename=WORKSPACE_FILE).read().get("root")
    if not path and isinstance(saved, str) and saved:
        return Workspace.initialize(data_dir, Path(saved))
    parts = _web_parts(path)
    if not parts:
        raise ConfigError(tr("请选择一个工作区文件夹。"))
    location = _web_location(data_dir, parts)
    with _web_directory(parts, owner=_workspace_owner()):
        return Workspace.initialize(data_dir, location)


def _workspace_owner() -> int | None:
    try:
        return Workspace._account().pw_uid
    except ConfigError:
        return None


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
        if root not in registered_roots(data):
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
    def ensure_account(cls) -> Any:
        if not cls.supported():
            raise ConfigError(tr("请在 Linux 服务器上以 root 初始化工作区。"))
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
                raise ConfigError(tr("无法创建工作区系统账号：{0}", done.stderr.strip())) from None
        return cls._account()

    @classmethod
    def account_workspace(cls, *, provision: bool = False) -> Workspace:
        account = cls.ensure_account() if provision else cls._account()
        home = Path(account.pw_dir)
        if not home.is_dir() or home.resolve() != home or home.stat().st_uid != account.pw_uid:
            raise ConfigError(tr("工作区账号的主目录不可用。"))
        return cls(home, account.pw_uid, account.pw_gid, home)

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
            state = store.read()
            roots = registered_roots(state)
            if current := cls.configured(data_dir, root):
                if not Editor.configured(data_dir):
                    editor.write_config()
                return current
            if any(root.is_relative_to(other) or other.is_relative_to(root) for other in roots):
                raise ConfigError(tr("工作区目录不能与已注册的项目重叠。"))
            if not shutil.which("setpriv", path=os.defpath) or not shutil.which(
                "setsid", path=os.defpath
            ):
                raise ConfigError(tr("请先安装 util-linux，再初始化工作区。"))
            root.mkdir(parents=True, exist_ok=True, mode=0o750)
            account = cls.ensure_account()
            if roots and (state.get("uid"), state.get("gid")) != (account.pw_uid, account.pw_gid):
                raise ConfigError(tr("工作区系统账号已变更，请在服务器上检查配置。"))
            if root.stat().st_uid != account.pw_uid and any(root.iterdir()):
                raise ConfigError(tr("请选择空目录，或由工作区账号拥有的现有项目目录。"))
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
            store.write(
                {
                    "root": str(roots[0] if roots else root),
                    "roots": [str(item) for item in (*roots, root)],
                    "uid": account.pw_uid,
                    "gid": account.pw_gid,
                }
            )
            if not Editor.configured(data_dir):
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
