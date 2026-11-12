"""Exercise the real Linux privilege boundary without provisioning a system account."""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

import pytest

from quantbot.workspace import Workspace, web_create_directory, web_initialize, workspace_projects
from quantbot.workspace_terminal import TerminalProcess


@pytest.mark.skipif(
    sys.platform != "linux" or os.geteuid() != 0,
    reason="requires a root Linux runner with util-linux",
)
def test_linux_workspace_uses_an_unprivileged_controlling_terminal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import pwd

    account = pwd.getpwnam("nobody")
    if not shutil.which("setpriv") or not shutil.which("setsid"):
        pytest.skip("util-linux is unavailable")
    if not shutil.which("ttyd"):
        pytest.skip("ttyd is unavailable")
    assert account.pw_uid != 0 and account.pw_gid != 0

    with TemporaryDirectory(prefix="quantbot-pty-") as directory:
        parent = Path(directory)
        parent.chmod(0o755)
        private = parent / "server-secret"
        private.touch(mode=0o600)
        home = parent / "home"
        home.mkdir(mode=0o700)
        os.chown(home, account.pw_uid, account.pw_gid)
        base = parent / "projects"
        monkeypatch.setattr("quantbot.workspace.WEB_ROOT", base)
        monkeypatch.setattr("quantbot.workspace.WORKSPACE_USER", account.pw_name)
        user = SimpleNamespace(pw_uid=account.pw_uid, pw_gid=account.pw_gid, pw_dir=str(home))
        monkeypatch.setattr(Workspace, "_account", staticmethod(lambda: user))
        data_dir = parent / "state"
        mask = os.umask(0o077)
        try:
            assert web_create_directory(data_dir, "", "repo") == "repo"
        finally:
            os.umask(mask)
        workspace = web_initialize(data_dir, "repo")
        assert workspace.root.stat().st_uid == account.pw_uid
        assert web_create_directory(data_dir, "", "second") == "second"
        second = web_initialize(data_dir, "second")
        assert Workspace.configured(data_dir, second.root) == second
        assert [project["name"] for project in workspace_projects(data_dir)] == ["repo", "second"]

        async def verify() -> None:
            terminal = await TerminalProcess.start(workspace)
            try:
                await terminal.resize(91, 27)
                await terminal.write(
                    b"printf 'uid:%s\\n' \"$(id -u)\"; "
                    b"printf 'size:%s\\n' \"$(stty size)\"; "
                    b"awk '/^NoNewPrivs:/ {print \"privs:\" $2}' /proc/self/status; "
                    b"test ! -r ../../server-secret && printf 'secret:%s\\n' denied\r"
                )
                output = bytearray()
                marker = b"secret:denied"
                while marker not in output and (chunk := await terminal.read()):
                    output.extend(chunk)
                assert f"uid:{account.pw_uid}".encode() in output
                assert b"size:27 91" in output
                assert b"privs:0" in output
                assert marker in output
            finally:
                await terminal.close()

        asyncio.run(asyncio.wait_for(verify(), timeout=10))
