"""GitHub device flow with a fake HTTP API and an isolated local Git remote."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from quantbot.config import ConfigError
from quantbot.editor import Editor
from quantbot.github import API_URL, DEVICE_URL, OAUTH_URL, GitHubEditor
from quantbot.workspace import Workspace

REMOTE = "https://github.com/acme/strategy.git"
GIT = shutil.which("git") or "/usr/bin/git"


def test_managed_workspace_git_uses_the_dedicated_account(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = Workspace(tmp_path, 123, 456, tmp_path / "home")
    monkeypatch.setattr(Editor, "workspace", lambda self: workspace)
    monkeypatch.setattr("quantbot.workspace.shutil.which", lambda *a, **kw: "/usr/bin/setpriv")
    monkeypatch.setenv("QB_SERVER_SECRET", "secret")

    def run(command: list[str], **options: Any) -> subprocess.CompletedProcess[str]:
        assert command[:4] == ["/usr/bin/setpriv", "--no-new-privs", "--", "git"]
        assert options["user"] == 123 and options["group"] == 456
        assert options["extra_groups"] == [] and options["cwd"] == tmp_path
        assert "QB_SERVER_SECRET" not in options["env"]
        return subprocess.CompletedProcess(command, 0, "main", "")

    monkeypatch.setattr("quantbot.github.subprocess.run", run)
    assert GitHubEditor._git(Editor(tmp_path, tmp_path / "data"), "branch") == "main"


def git(directory: Path, *args: str) -> str:
    return subprocess.check_output(  # noqa: S603
        [GIT, "-C", str(directory), *args],
        text=True,
        stderr=subprocess.PIPE,
    ).strip()


def commit(directory: Path, text: str) -> str:
    (directory / "strategy.py").write_text(text)
    git(directory, "add", "strategy.py")
    git(
        directory,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "edit",
    )
    return git(directory, "rev-parse", "HEAD")


def test_workspace_commit_includes_only_selected_paths(tmp_path: Path) -> None:
    root = tmp_path / "editor"
    root.mkdir()
    git(root, "init", "--initial-branch=main")
    git(root, "config", "user.name", "Test")
    git(root, "config", "user.email", "test@example.invalid")
    commit(root, "value = 1\n")
    state = tmp_path / "state"
    Editor.enable(state, str(root))
    service = GitHubEditor(state)
    (root / "strategy.py").write_text("value = 2\n")
    git(root, "add", "strategy.py")
    (root / ":new file.py").write_text("print(1)\n")
    assert service.local_status()["files"] == [
        {"path": "strategy.py", "status": "M "},
        {"path": ":new file.py", "status": "??"},
    ]
    revision = service.commit([":new file.py"], "Add selected file")
    assert revision == git(root, "rev-parse", "--short", "HEAD")
    assert git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD") == ":new file.py"
    assert git(root, "diff", "--cached", "--name-only") == "strategy.py"
    assert service.local_status()["files"] == [{"path": "strategy.py", "status": "M "}]


def test_official_device_flow_clone_pull_push_and_refresh(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    git(upstream, "init", "--initial-branch=main")
    commit(upstream, "value = 1\n")
    remote = tmp_path / "strategy.git"
    git(tmp_path, "clone", "--bare", str(upstream), str(remote))
    git(upstream, "remote", "add", "origin", str(remote))

    # Exercise production Git commands without hitting a user's GitHub repo.
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    shim = bin_dir / "git"
    shim.write_text(
        "#!/usr/bin/env python3\n"
        "import os, sys\n"
        f"replacements = {{{REMOTE!r}: {remote.as_uri()!r},"
        " 'protocol.https.allow=always': 'protocol.file.allow=always'}\n"
        "args = [replacements.get(arg, arg) for arg in sys.argv[1:]]\n"
        "if any(arg.startswith('file://') for arg in args):\n"
        "    assert os.environ['GIT_CONFIG_VALUE_0'].startswith('Authorization: Basic ')\n"
        f"os.execv({GIT!r}, [{GIT!r}, *args])\n"
    )
    shim.chmod(0o700)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")

    root = tmp_path / "editor"
    root.mkdir()
    state = tmp_path / "state"
    Editor.enable(state, str(root))
    calls = []

    def request(url: str, *, form: dict[str, str] | None = None, token: str = "") -> dict[str, Any]:
        calls.append((url, form))
        if url == f"{DEVICE_URL}/code":
            assert form == {"client_id": "Iv1.example"}
            return {
                "device_code": "device-secret",
                "user_code": "AAAA-BBBB",
                "interval": 5,
                "expires_in": 900,
            }
        if url == f"{API_URL}/repos/acme/strategy":
            assert token == "example-access"
            return {"default_branch": "main", "private": True}
        assert url == OAUTH_URL and form
        if form["grant_type"] == "refresh_token":
            assert form["refresh_token"] == "example-refresh"
            return {"access_token": "next-access", "expires_in": 28800}
        assert form["device_code"] == "device-secret"
        if sum(call[0] == OAUTH_URL for call in calls) == 1:
            return {"error": "authorization_pending"}
        return {
            "access_token": "example-access",
            "refresh_token": "example-refresh",
            "expires_in": 60,
        }

    service = GitHubEditor(state, request=request)
    assert not service.status()["bound"]
    flow = service.begin("https://github.com/acme/strategy.git", "", "Iv1.example")
    assert flow.prompt() == {"url": DEVICE_URL, "code": "AAAA-BBBB", "interval": 5}
    assert service.poll(flow) is None and len(calls) == 1
    flow.next_poll = 0
    assert service.poll(flow) is None
    flow.next_poll = 0
    status = service.poll(flow)
    assert status and status["repo"] == "acme/strategy"
    assert status["ahead"] == status["behind"] == 0
    assert (
        "access_token" not in status and git(root, "remote", "get-url", "origin") == remote.as_uri()
    )
    assert service.store.path.stat().st_mode & 0o777 == 0o600
    assert all(entry["name"] != ".git" for entry in Editor.configured(state).entries(""))
    with pytest.raises(ConfigError, match="Git 仓库元数据"):
        Editor.configured(state).read(".git/config")

    next_sha = commit(upstream, "value = 2\n")
    git(upstream, "push", "origin", "main")
    assert service.sync("check")["behind"] == 1
    assert service.store.read()["access_token"] == "next-access"
    (root / "strategy.py").write_text("value = 3\n")
    with pytest.raises(ConfigError, match="未提交"):
        service.sync("pull")
    git(root, "restore", "strategy.py")
    assert service.sync("pull")["behind"] == 0 and git(root, "rev-parse", "HEAD") == next_sha

    ours = commit(root, "value = 4\n")
    assert service.status()["ahead"] == 1
    assert service.sync("push")["ahead"] == 0
    assert git(remote, "rev-parse", "main") == ours
    service.unbind()
    assert not service.status()["bound"] and git(root, "rev-parse", "HEAD") == ours
