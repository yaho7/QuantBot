"""Exercise the real Linux privilege boundary without provisioning a system account."""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from quantbot.workspace import Workspace
from quantbot.workspace_terminal import TerminalProcess


@pytest.mark.skipif(
    sys.platform != "linux" or os.geteuid() != 0,
    reason="requires a root Linux runner with util-linux",
)
def test_linux_workspace_uses_an_unprivileged_controlling_terminal() -> None:
    import pwd

    account = pwd.getpwnam("nobody")
    if not shutil.which("setpriv") or not shutil.which("setsid"):
        pytest.skip("util-linux is unavailable")
    assert account.pw_uid != 0 and account.pw_gid != 0

    with TemporaryDirectory(prefix="quantbot-pty-") as directory:
        parent = Path(directory)
        parent.chmod(0o755)
        private = parent / "server-secret"
        private.touch(mode=0o600)
        root = parent / "repo"
        home = parent / "home"
        for path in (root, home):
            path.mkdir(mode=0o700)
            os.chown(path, account.pw_uid, account.pw_gid)
        workspace = Workspace(root, account.pw_uid, account.pw_gid, home)

        async def verify() -> None:
            terminal = await TerminalProcess.start(workspace)
            try:
                terminal.resize(91, 27)
                await terminal.write(
                    b"printf 'uid:%s\\n' \"$(id -u)\"; "
                    b"printf 'size:%s\\n' \"$(stty size)\"; "
                    b"test ! -r ../server-secret && printf 'secret:%s\\n' denied\r"
                )
                output = bytearray()
                marker = b"secret:denied"
                while marker not in output and (chunk := await terminal.read()):
                    output.extend(chunk)
                assert f"uid:{account.pw_uid}".encode() in output
                assert b"size:27 91" in output
                assert marker in output
            finally:
                await terminal.close()

        asyncio.run(asyncio.wait_for(verify(), timeout=10))
