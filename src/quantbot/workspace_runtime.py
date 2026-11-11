"""Run a saved command in the workspace, independently of browser sessions."""

from __future__ import annotations

import asyncio
import shlex
from pathlib import Path
from typing import Any

from quantbot.config import ConfigError, Store
from quantbot.editor import Editor
from quantbot.i18n import tr
from quantbot.workspace import Workspace, stop_process

RUN_FILE = "workspace-run.json"
LOG_LIMIT = 65_536


class WorkspaceRuntime:
    def __init__(self, data_dir: Path) -> None:
        self.store = Store(data_dir, filename=RUN_FILE)
        self.lock = asyncio.Lock()
        self.process: asyncio.subprocess.Process | None = None
        self.capture: asyncio.Task[None] | None = None
        self.log = bytearray()

    def workspace(self) -> Workspace:
        editor = Editor.configured(self.store.dir)
        workspace = editor.workspace() if editor else None
        if workspace is None:
            raise ConfigError(tr("请先在服务器上运行 quantbot workspace init。"))
        return workspace

    def _saved(self, workspace: Workspace) -> str:
        data = self.store.read()
        command = data.get("command")
        return (
            command if data.get("root") == str(workspace.root) and isinstance(command, str) else ""
        )

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    def status(self, workspace: Workspace) -> dict[str, Any]:
        return {
            "command": self._saved(workspace),
            "running": self.running,
            "exit_code": self.process.returncode if self.process else None,
            "logs": self.log.decode("utf-8", errors="replace"),
        }

    @staticmethod
    def _arguments(command: str) -> list[str]:
        if len(command) > 4096 or "\0" in command:
            raise ConfigError(tr("请输入有效的启动命令。"))
        try:
            arguments = shlex.split(command)
        except ValueError as exc:
            raise ConfigError(tr("启动命令中的引号没有配对。")) from exc
        if not arguments:
            raise ConfigError(tr("请输入有效的启动命令。"))
        return arguments

    def configure(self, workspace: Workspace, command: str) -> None:
        if self.running:
            raise ConfigError(tr("请先停止程序，再修改启动命令。"))
        self._arguments(command)
        self.store.write({"root": str(workspace.root), "command": command.strip()})

    async def start(self, workspace: Workspace) -> None:
        if self.running:
            raise ConfigError(tr("工作区程序已经在运行。"))
        command = self._saved(workspace)
        if not command:
            raise ConfigError(tr("请先保存启动命令。"))
        await self._finish_capture()
        arguments = self._arguments(command)
        process = await asyncio.create_subprocess_exec(
            *workspace.command(arguments),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
            env={**workspace.environment(), "PYTHONUNBUFFERED": "1"},
            **workspace.process_options(),
        )
        self.process = process
        self.log.clear()
        self.capture = asyncio.create_task(self._read_log(process))

    async def _read_log(self, process: asyncio.subprocess.Process) -> None:
        assert process.stdout is not None
        while data := await process.stdout.read(8192):
            self.log.extend(data)
            del self.log[:-LOG_LIMIT]
        await process.wait()

    async def _finish_capture(self) -> None:
        if self.capture is None:
            return
        try:
            await asyncio.wait_for(self.capture, timeout=1)
        except asyncio.TimeoutError:
            pass
        self.capture = None

    async def stop(self) -> None:
        if self.process is not None:
            await stop_process(self.process)
        await self._finish_capture()
