"""Manage files under a server-selected root."""

from __future__ import annotations

import hashlib
import os
import secrets
import shutil
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from quantbot.config import ConfigError, Store
from quantbot.i18n import tr
from quantbot.workspace import Workspace, workspace_id, workspace_projects

EDITOR_FILE = "editor.json"
MAX_FILE = 256 * 1024


class EditorError(ConfigError):
    pass


@dataclass(frozen=True)
class SourceFile:
    content: str
    revision: str


@contextmanager
def editor_lock(data_dir: Path, root: Path | None = None) -> Iterator[None]:
    """Serialize editor changes from the server and CLI."""
    if os.name != "posix":
        raise EditorError(tr("网页策略编辑器支持 Linux 和 macOS。"))
    import fcntl

    data_dir.mkdir(parents=True, exist_ok=True)
    name = f"editor-{workspace_id(root)}.lock" if root else "editor.lock"
    with (data_dir / name).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


class Editor:
    def __init__(self, root: Path, data_dir: Path) -> None:
        if os.name != "posix":
            raise EditorError(tr("网页策略编辑器支持 Linux 和 macOS。"))
        self.root = root
        self.data_dir = data_dir.resolve()
        if not root.is_absolute() or ".." in root.parts or root.is_relative_to(self.data_dir):
            raise EditorError(tr("请选择 QuantBot 数据目录之外的策略文件夹。"))

    @classmethod
    def configured(cls, data_dir: Path) -> Editor | None:
        root = Store(data_dir, filename=EDITOR_FILE).read().get("root")
        return cls(Path(root), data_dir) if isinstance(root, str) and root else None

    @classmethod
    def for_project(cls, data_dir: Path, project: str = "") -> Editor:
        if project:
            for item in workspace_projects(data_dir):
                if item["id"] == project:
                    return cls(Path(item["path"]), data_dir)
            raise EditorError(tr("找不到此工作区。请从工作区列表重新打开。"))
        if editor := cls.configured(data_dir):
            return editor
        raise EditorError(tr("网页策略编辑器已关闭。"))

    @classmethod
    def enable(cls, data_dir: Path, path: str) -> Path:
        try:
            root = Path(path).expanduser().resolve(strict=True)
            editor = cls(root, data_dir)
            with editor._directory([]):
                pass
            with editor_lock(data_dir):
                editor.write_config()
        except (OSError, RuntimeError, EditorError) as exc:
            raise ConfigError(tr("无法打开编辑目录：{0}", exc)) from exc
        return root

    def write_config(self) -> None:
        Store(self.data_dir, filename=EDITOR_FILE).write({"root": str(self.root)})

    def workspace(self) -> Workspace | None:
        return Workspace.configured(self.data_dir, self.root)

    def _parts(self, path: str) -> list[str]:
        if not path:
            return []
        parts = path.split("/")
        if any(part in {"", ".", ".."} or "\0" in part for part in parts):
            raise EditorError(tr("请选择编辑目录内的相对路径。"))
        if any(part.casefold() == ".git" for part in parts):
            raise EditorError(tr("Git 仓库元数据由 Git 管理。"))
        if self.root.joinpath(*parts).is_relative_to(self.data_dir):
            raise EditorError(tr("这个路径位于 QuantBot 数据目录中。"))
        return parts

    @contextmanager
    def _directory(self, parts: list[str]) -> Iterator[int]:
        # Keep traversal anchored to open directories and reject symlinks at every level.
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        fd = os.open(self.root.anchor, flags)
        try:
            for name in (*self.root.parts[1:], *parts):
                next_fd = os.open(name, flags, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            yield fd
        finally:
            os.close(fd)

    def entries(self, path: str) -> list[dict[str, str]]:
        parts = self._parts(path)
        folder = self.root.joinpath(*parts)
        items = []
        with self._directory(parts) as fd, os.scandir(fd) as entries:
            for entry in entries:
                if entry.name.casefold() == ".git" or (folder / entry.name).is_relative_to(
                    self.data_dir
                ):
                    continue
                if entry.is_dir(follow_symlinks=False):
                    items.append({"name": entry.name, "kind": "directory"})
                elif (
                    entry.is_file(follow_symlinks=False)
                    and entry.stat(follow_symlinks=False).st_nlink == 1
                ):
                    items.append({"name": entry.name, "kind": "file"})
        return sorted(items, key=lambda item: (item["kind"], item["name"].casefold()))

    def _mutable_parts(self, path: str) -> tuple[list[str], str]:
        parts, name = self._file_parts(path)
        if self.data_dir.is_relative_to(self.root.joinpath(*parts, name)):
            raise EditorError(tr("这个路径包含 QuantBot 数据目录。"))
        return parts, name

    @staticmethod
    def _entry(fd: int, name: str) -> os.stat_result:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if not (stat.S_ISDIR(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink == 1)):
            raise EditorError(tr("只能操作工作区内的普通文件和目录。"))
        return info

    @staticmethod
    def _create(fd: int, name: str, directory: bool, workspace: Workspace | None) -> None:
        if directory:
            os.mkdir(name, 0o750, dir_fd=fd)
            if workspace:
                os.chown(name, workspace.uid, workspace.gid, dir_fd=fd, follow_symlinks=False)
        else:
            with os.fdopen(
                os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640, dir_fd=fd), "wb"
            ) as out:
                if workspace:
                    os.fchown(out.fileno(), workspace.uid, workspace.gid)

    @staticmethod
    def _remove(fd: int, name: str, directory: bool) -> None:
        if directory:
            # fwalk anchors recursive removal to an open directory on Python 3.10 as well.
            for _, directories, files, child_fd in os.fwalk(name, topdown=False, dir_fd=fd):
                for file in files:
                    os.unlink(file, dir_fd=child_fd)
                for child in directories:
                    if stat.S_ISLNK(os.stat(child, dir_fd=child_fd, follow_symlinks=False).st_mode):
                        os.unlink(child, dir_fd=child_fd)
                    else:
                        os.rmdir(child, dir_fd=child_fd)
            os.rmdir(name, dir_fd=fd)
        else:
            os.unlink(name, dir_fd=fd)

    def _copy(
        self, source: int, name: str, target: int, dest: str, workspace: Workspace | None
    ) -> None:
        info = self._entry(source, name)
        directory = stat.S_ISDIR(info.st_mode)
        if not directory:
            with os.fdopen(
                os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=source), "rb"
            ) as incoming:
                opened = os.fstat(incoming.fileno())
                if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                    raise EditorError(tr("只能操作工作区内的普通文件和目录。"))
                output = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=target)
                try:
                    with os.fdopen(output, "wb") as out:
                        shutil.copyfileobj(incoming, out)
                        if workspace:
                            os.fchown(out.fileno(), workspace.uid, workspace.gid)
                        os.fchmod(out.fileno(), stat.S_IMODE(opened.st_mode) & 0o777)
                except BaseException:
                    os.unlink(dest, dir_fd=target)
                    raise
            return
        self._create(target, dest, True, workspace)
        try:
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            with (
                self._directory_from(source, name, flags) as child,
                self._directory_from(target, dest, flags) as copied,
            ):
                for entry in os.listdir(child):
                    if entry.casefold() != ".git":
                        self._copy(child, entry, copied, entry, workspace)
        except BaseException:
            self._remove(target, dest, directory)
            raise

    @staticmethod
    @contextmanager
    def _directory_from(fd: int, name: str, flags: int) -> Iterator[int]:
        child = os.open(name, flags, dir_fd=fd)
        try:
            yield child
        finally:
            os.close(child)

    def change(self, action: str, path: str, destination: str = "") -> None:
        parts, name = self._mutable_parts(path)
        workspace = self.workspace()
        with self._directory(parts) as fd:
            if action in {"file", "folder"}:
                self._create(fd, name, action == "folder", workspace)
                return
            info = self._entry(fd, name)
            directory = stat.S_ISDIR(info.st_mode)
            if action == "delete":
                self._remove(fd, name, directory)
                return
            parents, dest = self._mutable_parts(destination)
            if destination == path or destination.startswith(path + "/"):
                raise EditorError(tr("请选择另一个目标路径。"))
            if directory and action == "copy":
                for depth in range(1, len(parents) + 1):
                    with self._directory(parents[:depth]) as ancestor:
                        if os.path.samestat(info, os.fstat(ancestor)):
                            raise EditorError(tr("请选择另一个目标路径。"))
            with self._directory(parents) as target:
                if action == "copy":
                    self._copy(fd, name, target, dest, workspace)
                else:
                    # Reserve a new name first so moving never replaces an existing entry.
                    self._create(target, dest, directory, workspace)
                    try:
                        os.rename(name, dest, src_dir_fd=fd, dst_dir_fd=target)
                    except OSError:
                        self._remove(target, dest, directory)
                        raise

    def _read(self, fd: int, name: str) -> tuple[SourceFile, int]:
        with os.fdopen(
            os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=fd), "rb"
        ) as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise EditorError(tr("只能打开编辑目录内的普通文件。"))
            raw = file.read(MAX_FILE + 1)
        if len(raw) > MAX_FILE:
            raise EditorError(tr("文件超过 256 KiB，无法在网页编辑。"))
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise EditorError(tr("请选择 UTF-8 文本文件。")) from exc
        if "\0" in content:
            raise EditorError(tr("请选择 UTF-8 文本文件。"))
        identity = f"{self.root}\0{info.st_dev}:{info.st_ino}:{info.st_mtime_ns}\0".encode()
        revision = hashlib.sha256(identity + raw).hexdigest()
        return SourceFile(content, revision), stat.S_IMODE(info.st_mode) & 0o777

    def _file_parts(self, path: str) -> tuple[list[str], str]:
        parts = self._parts(path)
        if not parts:
            raise EditorError(tr("请选择要编辑的文件。"))
        return parts[:-1], parts[-1]

    def read(self, path: str) -> SourceFile:
        parts, name = self._file_parts(path)
        with self._directory(parts) as fd:
            source, _ = self._read(fd, name)
        return source

    def seed(self, path: str, content: str) -> None:
        """Install a template without replacing any existing workspace entry."""
        parts, name = self._mutable_parts(path)
        workspace = self.workspace()
        with self._directory(parts) as fd:
            temp = ".quantbot-seed-" + secrets.token_hex(16)
            output = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
            try:
                with os.fdopen(output, "w", encoding="utf-8") as file:
                    file.write(content)
                    file.flush()
                    if workspace:
                        os.fchown(file.fileno(), workspace.uid, workspace.gid)
                    os.fchmod(file.fileno(), 0o640)
                    os.fsync(file.fileno())
                try:
                    os.link(temp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                except FileExistsError:
                    current, _ = self._read(fd, name)
                    if current.content != content:
                        raise EditorError(
                            tr("工作区已有不同内容的 {0}，请选择另一个工作区。", path)
                        ) from None
            finally:
                os.unlink(temp, dir_fd=fd)

    def save(self, path: str, content: str, revision: str) -> SourceFile:
        try:
            raw = content.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise EditorError(tr("内容必须是 UTF-8 文本。")) from exc
        if len(raw) > MAX_FILE or b"\0" in raw:
            raise EditorError(tr("请保存 256 KiB 以内的 UTF-8 文本。"))
        parts, name = self._file_parts(path)
        workspace = self.workspace()
        with self._directory(parts) as fd:
            current, mode = self._read(fd, name)
            if current.revision != revision:
                raise EditorError(tr("服务器上的文件已变更。请重新打开文件，再合并你的改动。"))
            if current.content == content:
                return current
            tmp = ".quantbot-edit-" + secrets.token_hex(16)
            output = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
            try:
                with os.fdopen(output, "wb") as file:
                    file.write(raw)
                    file.flush()
                    if workspace:
                        os.fchown(file.fileno(), workspace.uid, workspace.gid)
                    os.fchmod(file.fileno(), mode)
                    os.fsync(file.fileno())
                latest, _ = self._read(fd, name)
                if latest.revision != revision:
                    raise EditorError(tr("服务器上的文件已变更。请重新打开文件，再合并你的改动。"))
                os.replace(tmp, name, src_dir_fd=fd, dst_dir_fd=fd)
            finally:
                try:
                    os.unlink(tmp, dir_fd=fd)
                except FileNotFoundError:
                    pass
            saved, _ = self._read(fd, name)
            return saved
