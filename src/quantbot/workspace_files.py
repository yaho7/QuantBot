"""Shared filesystem notifications and ripgrep-backed workspace search."""

from __future__ import annotations

import asyncio
import shutil
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from watchfiles import awatch

from quantbot.editor import Editor, EditorError
from quantbot.i18n import tr


class WorkspaceChanges:
    def __init__(self) -> None:
        self._watchers: dict[Path, tuple[asyncio.Task[None], set[asyncio.Event]]] = {}

    @asynccontextmanager
    async def subscribe(self, root: Path):
        changed = asyncio.Event()
        if root not in self._watchers:
            listeners: set[asyncio.Event] = set()
            task = asyncio.create_task(self._watch(root, listeners))
            self._watchers[root] = task, listeners
        task, listeners = self._watchers[root]
        listeners.add(changed)
        try:
            yield changed
        finally:
            listeners.discard(changed)
            if not listeners and self._watchers.pop(root, None):
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def _watch(self, root: Path, listeners: set[asyncio.Event]) -> None:
        try:
            async for changes in awatch(root, watch_filter=None, debounce=300, step=80):
                if any(
                    not Path(path).name.startswith(".quantbot-edit-") and not path.endswith(".lock")
                    for _, path in changes
                ):
                    for listener in listeners:
                        listener.set()
        except OSError:
            # The SSE heartbeat also reconciles files when a root disappears or is replaced.
            pass

    async def close(self) -> None:
        for task, listeners in self._watchers.values():
            task.cancel()
            for listener in listeners:
                listener.set()
        await asyncio.gather(*(task for task, _ in self._watchers.values()), return_exceptions=True)


async def search(editor: Editor, query: str, content: bool) -> list[dict[str, str | int]]:
    rg = shutil.which("rg")
    if not rg:
        raise EditorError(tr("请在服务器上安装 ripgrep 后使用搜索。"))
    args = [rg, "--null", "--hidden", "--glob", "!.git", "--glob", "!.git/**"]
    if editor.data_dir.is_relative_to(editor.root):
        protected = editor.data_dir.relative_to(editor.root).as_posix()
        args.extend(["--glob", f"!/{protected}", "--glob", f"!/{protected}/**"])
    if content:
        args.extend(
            ["--files-with-matches", "--max-filesize", "256K", "-i", "-F", "--", query, "."]
        )
    else:
        args.append("--files")
    workspace = editor.workspace()
    options = {"cwd": editor.root}
    if workspace:
        args = workspace.command(args)
        options = {**workspace.process_options(), "env": workspace.environment()}
    process = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, **options
    )

    async def collect() -> list[dict[str, str | int]]:
        results: list[dict[str, str | int]] = []
        assert process.stdout is not None
        while len(results) < 100:
            try:
                raw = await process.stdout.readuntil(b"\0")
            except asyncio.IncompleteReadError:
                break
            path = raw[:-1].decode(errors="replace").removeprefix("./")
            if not content and query.casefold() not in path.casefold():
                continue
            try:
                # Revalidate ripgrep's paths against the same rules as the editor.
                parts, name = editor._file_parts(path)
                with editor._directory(parts) as fd:
                    editor._entry(fd, name)
                if content:
                    source = await asyncio.to_thread(editor.read, path)
                    for line, value in enumerate(source.content.splitlines(), 1):
                        if query.casefold() in value.casefold():
                            results.append(
                                {"path": path, "line": line, "text": value.strip()[:240]}
                            )
                            break
                else:
                    results.append({"path": path})
            except (EditorError, OSError):
                continue
        return results

    try:
        return await asyncio.wait_for(collect(), 10)
    except asyncio.TimeoutError as exc:
        raise EditorError(tr("搜索超时，请缩小搜索范围。")) from exc
    finally:
        if process.returncode is None:
            with suppress(ProcessLookupError):
                process.kill()
            await process.communicate()
