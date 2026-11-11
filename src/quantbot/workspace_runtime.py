"""Run a saved command in the workspace, independently of browser sessions."""

from __future__ import annotations

import asyncio
import hashlib
import shlex
import time
from contextlib import suppress
from pathlib import Path
from typing import Any

from quantbot.config import ConfigError, Store
from quantbot.i18n import tr
from quantbot.workspace import Workspace, stop_process

RUN_FILE = "workspace-run.json"
LOG_LIMIT = 65_536


class SystemdProgram:
    """Use the system manager and journal on Linux hosts booted with systemd."""

    def __init__(self, data_dir: Path, root: Path | None = None) -> None:
        identity = str(data_dir.resolve()) if root is None else f"{data_dir.resolve()}\0{root}"
        instance = hashlib.sha256(identity.encode()).hexdigest()[:16]
        self.unit = f"quantbot-workspace-{instance}.service"
        self.stopped = False

    @staticmethod
    async def _call(*args: str) -> tuple[int, str]:
        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            output, _ = await asyncio.wait_for(process.communicate(), 25)
        except BaseException:
            if process.returncode is None:
                with suppress(ProcessLookupError):
                    process.kill()
                await process.wait()
            raise
        return process.returncode or 0, output[-LOG_LIMIT:].decode(errors="replace")

    async def state(self) -> tuple[bool, int | None]:
        code, result = await self._call(
            "/usr/bin/systemctl",
            "show",
            "--property=LoadState,SubState,ExecMainCode,ExecMainStatus",
            self.unit,
        )
        props = dict(line.split("=", 1) for line in result.splitlines() if "=" in line)
        if props.get("LoadState") == "not-found":
            return False, -15 if self.stopped else None
        if code:
            raise ConfigError(tr("无法读取工作区程序状态。"))
        running = props.get("SubState") in {
            "start",
            "running",
            "stop",
            "stop-sigterm",
            "stop-sigkill",
        }
        status = props.get("ExecMainStatus", "0")
        main_code = props.get("ExecMainCode", "0")
        if running or not status.isdecimal() or main_code == "0":
            return running, None
        return False, int(status) if main_code == "1" else -int(status)

    async def start(self, workspace: Workspace, arguments: list[str]) -> None:
        # A completed or failed transient service can retain its name until it is stopped.
        await self._call("/usr/bin/systemctl", "stop", self.unit)
        await self._call("/usr/bin/systemctl", "reset-failed", self.unit)
        environment = {**workspace.environment(), "PYTHONUNBUFFERED": "1"}
        code, _ = await self._call(
            "/usr/bin/systemd-run",
            "--quiet",
            "--remain-after-exit",
            f"--unit={self.unit}",
            "--property=Type=exec",
            f"--property=User={workspace.uid}",
            f"--property=Group={workspace.gid}",
            "--property=NoNewPrivileges=yes",
            "--property=UMask=0077",
            "--property=KillMode=control-group",
            f"--working-directory={workspace.root}",
            *(f"--setenv={key}={value}" for key, value in environment.items()),
            "--",
            "/usr/bin/env",
            "--",
            *(arg.replace("$", "$$") for arg in arguments),
        )
        if code:
            raise ConfigError(tr("systemd 无法启动工作区程序，请检查启动命令和服务日志。"))
        self.stopped = False

    async def stop(self) -> None:
        running, _ = await self.state()
        if running:
            code, _ = await self._call("/usr/bin/systemctl", "stop", self.unit)
            if code:
                raise ConfigError(tr("systemd 无法停止工作区程序。"))
            self.stopped = True

    async def logs(self, since: int) -> str:
        if not since:
            return ""
        _, output = await self._call(
            "/usr/bin/journalctl",
            "--quiet",
            "--no-pager",
            "--output=cat",
            "--lines=200",
            f"--since=@{since}",
            f"--unit={self.unit}",
        )
        return output


class WorkspaceRuntime:
    def __init__(self, data_dir: Path, root: Path) -> None:
        self.store = Store(data_dir, filename=RUN_FILE)
        self.root = str(root)
        self.lock = asyncio.Lock()
        self.process: asyncio.subprocess.Process | None = None
        self.capture: asyncio.Task[None] | None = None
        self.log = bytearray()
        self.systemd = (
            SystemdProgram(data_dir, None if self.store.read().get("root") == self.root else root)
            if Workspace.supported() and Path("/run/systemd/system").is_dir()
            else None
        )

    def _settings(self) -> dict[str, Any]:
        data = self.store.read()
        return data.get("workspaces", {}).get(
            self.root, data if data.get("root") == self.root else {}
        )

    def _saved(self) -> str:
        command = self._settings().get("command")
        return command if isinstance(command, str) else ""

    def _save(self, command: str, started_at: int | None = None) -> None:
        with self.store.edit() as data:
            workspaces = data.setdefault("workspaces", {})
            previous = workspaces.get(self.root, data if data.get("root") == self.root else {})
            workspaces[self.root] = {
                "command": command,
                "started_at": started_at
                if started_at is not None
                else previous.get("started_at", 0),
            }

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None

    async def status(self) -> dict[str, Any]:
        if self.systemd:
            running, exit_code = await self.systemd.state()
            since = self._settings().get("started_at", 0)
            return {
                "command": self._saved(),
                "running": running,
                "exit_code": exit_code,
                "logs": await self.systemd.logs(since if isinstance(since, int) else 0),
            }
        return {
            "command": self._saved(),
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

    async def configure(self, command: str) -> None:
        running = (await self.systemd.state())[0] if self.systemd else self.running
        if running:
            raise ConfigError(tr("请先停止程序，再修改启动命令。"))
        self._arguments(command)
        self._save(command.strip())

    async def start(self, workspace: Workspace) -> None:
        running = (await self.systemd.state())[0] if self.systemd else self.running
        if running:
            raise ConfigError(tr("工作区程序已经在运行。"))
        command = self._saved()
        if not command:
            raise ConfigError(tr("请先保存启动命令。"))
        arguments = self._arguments(command)
        if self.systemd:
            since = int(time.time())
            await self.systemd.start(workspace, arguments)
            self._save(command, since)
            return
        await self._finish_capture()
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
        if self.systemd:
            await self.systemd.stop()
            return
        if self.process is not None:
            await stop_process(self.process)
        await self._finish_capture()
