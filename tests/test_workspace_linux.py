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


@pytest.mark.skipif(
    sys.platform != "linux" or os.geteuid() != 0 or not Path("/run/systemd/system").is_dir(),
    reason="requires a root Linux runner booted with systemd",
)
def test_systemd_workspace_is_reattached_after_console_shutdown() -> None:
    import pwd

    from aiohttp import web

    from quantbot.web import RUNTIME_KEY, _stop_workspace_program
    from quantbot.workspace_runtime import WorkspaceRuntime

    account = pwd.getpwnam("nobody")

    async def verify(workspace: Workspace, data_dir: Path) -> None:
        runtime = WorkspaceRuntime(data_dir, workspace.root)
        assert runtime.systemd is not None
        await runtime.configure("/bin/sh -c 'id -u; exec /bin/sleep 60'")
        try:
            await runtime.start(workspace)
            app = web.Application()
            app[RUNTIME_KEY] = {workspace.root: runtime}
            await _stop_workspace_program(app)

            reattached = WorkspaceRuntime(data_dir, workspace.root)
            assert reattached.systemd is not None
            assert reattached.systemd.unit == runtime.systemd.unit
            status = await reattached.status()
            assert status["running"]
            for _ in range(20):
                if str(account.pw_uid) in status["logs"].splitlines():
                    break
                await asyncio.sleep(0.1)
                status = await reattached.status()
            assert str(account.pw_uid) in status["logs"].splitlines()
        finally:
            await runtime.stop()

    with TemporaryDirectory(prefix="quantbot-runtime-") as directory:
        parent = Path(directory)
        parent.chmod(0o755)
        root = parent / "project"
        root.mkdir(mode=0o750)
        os.chown(root, account.pw_uid, account.pw_gid)
        workspace = Workspace(root, account.pw_uid, account.pw_gid, root)
        asyncio.run(asyncio.wait_for(verify(workspace, parent / "state"), timeout=45))
