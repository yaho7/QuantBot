"""Read and replace existing UTF-8 files under a server-selected root."""

from __future__ import annotations

import hashlib
import os
import secrets
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from quantbot.config import ConfigError, Store
from quantbot.i18n import tr

EDITOR_FILE = "editor.json"
MAX_FILE = 256 * 1024


class EditorError(ConfigError):
    pass


@dataclass(frozen=True)
class SourceFile:
    content: str
    revision: str


@contextmanager
def editor_lock(data_dir: Path) -> Iterator[None]:
    """Serialize editor changes from the server and CLI."""
    if os.name != "posix":
        raise EditorError(tr("网页策略编辑器支持 Linux 和 macOS。"))
    import fcntl

    data_dir.mkdir(parents=True, exist_ok=True)
    with (data_dir / "editor.lock").open("a") as lock:
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
    def enable(cls, data_dir: Path, path: str) -> Path:
        try:
            root = Path(path).expanduser().resolve(strict=True)
            editor = cls(root, data_dir)
            with editor._directory([]):
                pass
            with editor_lock(data_dir):
                Store(data_dir, filename=EDITOR_FILE).write({"root": str(root)})
        except (OSError, RuntimeError, EditorError) as exc:
            raise ConfigError(tr("无法打开编辑目录：{0}", exc)) from exc
        return root

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

    def save(self, path: str, content: str, revision: str) -> SourceFile:
        try:
            raw = content.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise EditorError(tr("内容必须是 UTF-8 文本。")) from exc
        if len(raw) > MAX_FILE or b"\0" in raw:
            raise EditorError(tr("请保存 256 KiB 以内的 UTF-8 文本。"))
        parts, name = self._file_parts(path)
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
