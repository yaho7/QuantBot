"""Connect the authenticated terminal endpoint to ttyd over a private Unix socket."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

from aiohttp import (
    ClientConnectionError,
    ClientSession,
    ClientWebSocketResponse,
    UnixConnector,
    WSMsgType,
)

from quantbot.config import ConfigError
from quantbot.i18n import tr
from quantbot.workspace import Workspace, stop_process

TOOL_PATH = "/usr/local/bin:/usr/bin:/bin"


@dataclass
class TerminalProcess:
    process: asyncio.subprocess.Process
    directory: TemporaryDirectory
    session: ClientSession
    socket: ClientWebSocketResponse

    @classmethod
    async def start(cls, workspace: Workspace, cwd: Path | None = None) -> TerminalProcess:
        ttyd = shutil.which("ttyd", path=TOOL_PATH)
        if not ttyd:
            raise ConfigError(tr("请在服务器上安装 ttyd 后打开网页终端。"))
        directory = TemporaryDirectory(prefix="qb-terminal-", dir="/tmp")  # noqa: S108
        os.chown(directory.name, workspace.uid, workspace.gid)
        socket_path = str(Path(directory.name) / "tty.sock")
        session = ClientSession(connector=UnixConnector(path=socket_path))
        process = None
        try:
            process = await asyncio.create_subprocess_exec(
                *workspace.command(
                    [
                        ttyd,
                        "-i",
                        socket_path,
                        "-o",
                        "-W",
                        "-w",
                        str(cwd or workspace.root),
                        "--",
                        "/bin/bash",
                        "-i",
                    ]
                ),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
                env={**workspace.environment(), "SHELL": "/bin/bash"},
                **workspace.process_options(),
            )
            for _ in range(50):
                try:
                    socket = await asyncio.wait_for(
                        session.ws_connect(
                            "http://localhost/ws", protocols=("tty",), max_msg_size=1_048_576
                        ),
                        timeout=1,
                    )
                    await socket.send_bytes(b'{"AuthToken":"","columns":80,"rows":24}')
                    return cls(process, directory, session, socket)
                except ClientConnectionError:
                    if process.returncode is not None:
                        raise ConfigError(
                            tr("ttyd 启动失败（退出状态 {0}）。", process.returncode)
                        ) from None
                    await asyncio.sleep(0.05)
            raise ConfigError(tr("无法连接 ttyd，请检查服务器上的 ttyd 安装。"))
        except BaseException:
            await session.close()
            if process:
                await stop_process(process)
            directory.cleanup()
            raise

    async def read(self) -> bytes:
        async for message in self.socket:
            if (
                message.type == WSMsgType.BINARY
                and len(message.data) > 1
                and message.data.startswith(b"0")
            ):
                return message.data[1:]
        return b""

    async def write(self, data: bytes) -> None:
        await self.socket.send_bytes(b"0" + data)

    async def resize(self, columns: int, rows: int) -> None:
        if 1 <= columns <= 500 and 1 <= rows <= 300:
            await self.socket.send_bytes(
                b"1" + json.dumps({"columns": columns, "rows": rows}).encode()
            )

    async def close(self) -> None:
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self.socket.close(), 1)
        await self.session.close()
        await stop_process(self.process)
        self.directory.cleanup()
