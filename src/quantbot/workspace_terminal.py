"""Attach a non-root shell to a PTY without forking Python application code."""

from __future__ import annotations

import asyncio
import errno
import os
import shutil
import struct
from contextlib import suppress
from dataclasses import dataclass

from quantbot.config import ConfigError
from quantbot.i18n import tr
from quantbot.workspace import Workspace, stop_process


@dataclass
class TerminalProcess:
    fd: int
    process: asyncio.subprocess.Process

    @classmethod
    async def start(cls, workspace: Workspace) -> TerminalProcess:
        setsid = shutil.which("setsid", path=os.defpath)
        if not setsid:
            raise ConfigError(tr("请先安装 util-linux，再初始化工作区。"))
        master, slave = os.openpty()
        try:
            os.fchown(slave, workspace.uid, workspace.gid)
            os.set_blocking(master, False)
            command = workspace.command([setsid, "--ctty", "/bin/bash", "-i"])
            process = await asyncio.create_subprocess_exec(
                *command,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                env={**workspace.environment(), "TERM": "xterm-256color", "SHELL": "/bin/bash"},
                **workspace.process_options(),
            )
        except BaseException:
            os.close(master)
            raise
        finally:
            os.close(slave)
        terminal = cls(master, process)
        terminal.resize(80, 24)
        return terminal

    async def _ready(self, *, write: bool = False) -> None:
        loop = asyncio.get_running_loop()
        future = loop.create_future()

        def ready() -> None:
            if not future.done():
                future.set_result(None)

        add = loop.add_writer if write else loop.add_reader
        remove = loop.remove_writer if write else loop.remove_reader
        add(self.fd, ready)
        try:
            await future
        finally:
            remove(self.fd)

    async def read(self) -> bytes:
        while True:
            try:
                return os.read(self.fd, 8192)
            except BlockingIOError:
                await self._ready()
            except OSError as exc:
                if exc.errno == errno.EIO:  # Linux reports EIO when the slave closes.
                    return b""
                raise

    async def write(self, data: bytes) -> None:
        remaining = memoryview(data)
        while remaining:
            try:
                remaining = remaining[os.write(self.fd, remaining) :]
            except BlockingIOError:
                await self._ready(write=True)

    def resize(self, columns: int, rows: int) -> None:
        import fcntl
        import termios

        if 1 <= columns <= 500 and 1 <= rows <= 300:
            with suppress(OSError):
                fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    async def close(self) -> None:
        os.close(self.fd)
        await stop_process(self.process)
