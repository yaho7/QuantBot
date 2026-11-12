"""Exercise workspace Git and the interface to the GitHub CLI."""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from quantbot.editor import Editor
from quantbot.github import LOGIN, GitHubEditor
from quantbot.workspace import Workspace

GIT = shutil.which("git") or "/usr/bin/git"


def test_managed_workspace_git_uses_the_dedicated_account(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = Workspace(tmp_path, 123, 456, tmp_path / "home")
    monkeypatch.setattr(Editor, "workspace", lambda self: workspace)
    monkeypatch.setenv("QB_SERVER_SECRET", "secret")

    def execute(git, command: list[str], **options: Any):
        assert command[:5] == ["/usr/bin/setpriv", "--no-new-privs", "--", "/usr/bin/env", "-i"]
        assert options["user"] == 123 and options["group"] == 456
        assert options["extra_groups"] == [] and git.working_dir == tmp_path
        assert f"HOME={workspace.home}" in command
        assert not any("QB_SERVER_SECRET" in value for value in command)
        return 0, b"main", ""

    monkeypatch.setattr(
        Workspace, "command", lambda self, args: ["/usr/bin/setpriv", "--no-new-privs", "--", *args]
    )
    monkeypatch.setattr("quantbot.github.Git.execute", execute)
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


def test_workspace_git_staging_diff_and_branches(tmp_path: Path) -> None:
    root = tmp_path / "editor"
    root.mkdir()
    state = tmp_path / "state"
    Editor.enable(state, str(root))
    service = GitHubEditor(state)
    assert service.initialize()["branch"] == "main"
    git(root, "config", "user.name", "Test")
    git(root, "config", "user.email", "test@example.invalid")
    source = root / "strategy.py"
    source.write_text("value = 1\n")
    assert service.diff("strategy.py", False) == {"before": "", "after": "value = 1\n"}
    assert service.stage(["strategy.py"], True)["files"][0]["status"] == "A "
    assert service.diff("strategy.py", True)["after"] == "value = 1\n"
    assert service.stage(["strategy.py"], False)["files"][0]["status"] == "??"
    service.stage(["strategy.py"], True)
    source.write_text("value = 2\n")
    assert service.commit([], "Commit the index") == git(root, "rev-parse", "--short", "HEAD")
    assert git(root, "show", "HEAD:strategy.py") == "value = 1"
    assert service.diff("strategy.py", False) == {"before": "value = 1\n", "after": "value = 2\n"}
    git(root, "restore", "strategy.py")
    git(root, "branch", "feature")
    assert service.branches()["branches"] == ["feature", "main"]
    assert service.switch("feature")["branch"] == "feature"
    git(root, "update-ref", "refs/remotes/origin/feature", "HEAD")
    assert service.local_status()["remote_branch"]
    commit(root, "value = 3\n")
    assert service.local_status()["ahead"] == 1


def test_gh_process_handles_official_device_login(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "editor"
    root.mkdir()
    state = tmp_path / "state"
    Editor.enable(state, str(root))
    service = GitHubEditor(state)
    git_ready = tmp_path / "git-ready"

    def command(self, editor, *args):
        if args == LOGIN:
            script = "print('! First copy your one-time code: ABCD-EFGH', flush=True)"
        else:
            assert args == ("auth", "setup-git", "--hostname", "github.com")
            script = f"from pathlib import Path; Path({str(git_ready)!r}).touch()"
        return [sys.executable, "-c", script], {"cwd": root}

    monkeypatch.setattr(GitHubEditor, "_gh_command", command)

    async def authorize() -> None:
        login = await service.begin()
        assert await login.code == "ABCD-EFGH"
        assert await login.done

    asyncio.run(asyncio.wait_for(authorize(), 4))
    assert git_ready.exists()


@pytest.mark.parametrize(
    ("initialized", "remote_has_commit"), [(False, False), (True, False), (True, True)]
)
def test_clone_empty_workspace_and_unborn_repository(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, initialized: bool, remote_has_commit: bool
) -> None:
    remote = tmp_path / "origin.git"
    root = tmp_path / "editor"
    root.mkdir()
    git(tmp_path, "init", "--bare", "--initial-branch=main", str(remote))
    if remote_has_commit:
        seed = tmp_path / "seed"
        seed.mkdir()
        git(seed, "init", "--initial-branch=main")
        commit(seed, "print('remote')\n")
        git(seed, "push", str(remote), "main")
    state = tmp_path / "state"
    Editor.enable(state, str(root))
    service = GitHubEditor(state)
    if initialized:
        service.initialize()

    original = GitHubEditor._git

    def isolated(editor: Editor, *args: str, **options: Any) -> str:
        if args[0] in {"clone", "ls-remote", "fetch"}:
            args = (
                "-c",
                "protocol.file.allow=always",
                "-c",
                f"url.{remote.as_uri()}.insteadOf=https://github.com/acme/project.git",
                *args,
            )
        return original(editor, *args, **options)

    monkeypatch.setattr(GitHubEditor, "_git", staticmethod(isolated))
    monkeypatch.setattr(GitHubEditor, "setup_git", lambda self: None)
    result = service.select("acme/project")
    assert result["remote"] and result["repo"] == "acme/project"
    assert result["files"] == []
    assert (root / "strategy.py").exists() == remote_has_commit
