"""Use GitHub CLI for authentication and GitPython for workspace Git commands."""

from __future__ import annotations

import asyncio
import difflib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from git import Git
from git.exc import GitError

from quantbot.config import ConfigError
from quantbot.editor import MAX_FILE, Editor, EditorError, editor_lock
from quantbot.i18n import tr
from quantbot.workspace import stop_process

# Recognized by the uninstaller for installations which previously used a GitHub App.
GITHUB_FILE = "github.json"
GITHUB_APP_FILE = "github-app.json"
DEVICE_URL = "https://github.com/login/device"
TOOLS = "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"
SLUG = re.compile(r"[A-Za-z0-9-]+/[A-Za-z0-9_.-]+")
DEVICE_CODE = re.compile(rb"\bone-time code(?::\s+|\s+\()([A-Z0-9]{4}-[A-Z0-9]{4})\b", re.I)
LOGIN = ("auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web")
CONFLICTS = {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}


class DeviceLogin:
    def __init__(self, process: asyncio.subprocess.Process, github: GitHubEditor) -> None:
        self.process = process
        self.code: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self.done = asyncio.create_task(self._run(github))
        self.reported = False

    async def _run(self, github: GitHubEditor) -> bool:
        async def collect() -> bool:
            assert self.process.stdout is not None
            while line := await self.process.stdout.readline():
                if not self.code.done() and (match := DEVICE_CODE.search(line)):
                    self.code.set_result(match[1].decode("ascii"))
            return await self.process.wait() == 0

        try:
            if not await asyncio.wait_for(collect(), 900):
                return False
            await asyncio.to_thread(github.setup_git)
            return True
        except (ConfigError, OSError, asyncio.TimeoutError, ValueError):
            return False
        finally:
            if not self.code.done():
                self.code.set_result("")
            await stop_process(self.process)

    async def close(self) -> None:
        await stop_process(self.process)
        await self.done


class GitHubEditor:
    def __init__(self, data_dir: Path, project: str = "") -> None:
        self.data_dir = data_dir
        self.project = project

    def _editor(self) -> Editor:
        editor = Editor.for_project(self.data_dir, self.project)
        if editor.data_dir.is_relative_to(editor.root):
            raise ConfigError(tr("请选择 QuantBot 数据目录之外的 Git 仓库。"))
        if not editor.root.is_dir() or editor.root.resolve() != editor.root:
            raise ConfigError(tr("编辑目录已变更，请在服务器上重新选择目录。"))
        return editor

    @staticmethod
    def _context(editor: Editor) -> tuple[dict[str, str], dict[str, Any]]:
        workspace = editor.workspace()
        if workspace:
            return workspace.environment(), workspace.process_options()
        if os.geteuid() == 0:
            raise ConfigError(tr("请先初始化工作区，以普通用户运行 Git。"))
        return {
            "HOME": str(Path.home()),
            "PATH": TOOLS,
            "LANG": "C.UTF-8",
            **{
                key: os.environ[key]
                for key in ("USER", "LOGNAME", "XDG_CONFIG_HOME")
                if key in os.environ
            },
        }, {"cwd": editor.root}

    def _gh_command(self, editor: Editor, *args: str) -> tuple[list[str], dict[str, Any]]:
        env, options = self._context(editor)
        gh = shutil.which("gh", path=TOOLS)
        if not gh:
            raise ConfigError(tr("请在服务器上安装 GitHub CLI（gh）。"))
        command = [gh, *args]
        if workspace := editor.workspace():
            command = workspace.command(command)
        env.update(GH_NO_UPDATE_NOTIFIER="1", GH_PROMPT_DISABLED="1", NO_COLOR="1")
        return command, {**options, "env": env}

    def _gh(self, editor: Editor, *args: str, optional: bool = False) -> str:
        command, options = self._gh_command(editor, *args)
        try:
            result = subprocess.run(  # noqa: S603
                command,
                **options,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=90,
                stdin=subprocess.DEVNULL,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ConfigError(tr("GitHub CLI 无法完成操作，请检查服务器网络。")) from exc
        if result.returncode and not optional:
            raise ConfigError(tr("GitHub CLI 操作失败，请检查登录状态和仓库访问权限。"))
        return "" if result.returncode else result.stdout.strip()

    async def begin(self) -> DeviceLogin:
        command, options = self._gh_command(self._editor(), *LOGIN)
        process = await asyncio.create_subprocess_exec(
            *command,
            **options,
            start_new_session=True,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        return DeviceLogin(process, self)

    def login(self) -> None:
        command, options = self._gh_command(self._editor(), *LOGIN)
        options["env"].pop("GH_PROMPT_DISABLED")
        result = subprocess.run(command, **options, check=False)  # noqa: S603
        if result.returncode:
            raise ConfigError(tr("GitHub 授权未完成，请重试。"))
        self.setup_git()

    def setup_git(self) -> None:
        self._gh(self._editor(), "auth", "setup-git", "--hostname", "github.com")

    def logout(self) -> None:
        editor = self._editor()
        self._gh(editor, "auth", "logout", "--hostname", "github.com")

    def _account(self, editor: Editor) -> dict[str, Any]:
        result = self._gh(
            editor,
            "api",
            "--hostname",
            "github.com",
            "--cache",
            "1m",
            "user",
            "--jq",
            "{login: .login, id: .id}",
            optional=True,
        )
        try:
            account = json.loads(result)
        except ValueError:
            return {}
        if isinstance(account, dict) and isinstance(account.get("login"), str):
            return account
        return {}

    def status(self) -> dict[str, Any]:
        try:
            editor = self._editor()
            self._context(editor)
        except ConfigError:
            return {"configured": False, "available": False, "account": ""}
        available = bool(shutil.which("gh", path=TOOLS))
        account = self._account(editor).get("login", "") if available else ""
        return {"configured": True, "available": available, "account": account}

    def repositories(self) -> list[dict[str, Any]]:
        output = self._gh(
            self._editor(),
            "api",
            "--hostname",
            "github.com",
            "--paginate",
            "user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
            "--jq",
            ".[] | {name: .full_name, private: .private}",
        )
        return [json.loads(line) for line in output.splitlines() if line]

    def select(self, repo: str) -> dict[str, Any]:
        if not SLUG.fullmatch(repo) or repo.split("/")[1] in {".", ".."}:
            raise ConfigError(tr("请选择 GitHub 已授权的仓库。"))
        editor = self._editor()
        with editor_lock(self.data_dir, editor.root):
            if any(editor.root.iterdir()):
                if self._repository(editor) and self._origin(editor).casefold() == repo.casefold():
                    self.setup_git()
                    return self._local_status(editor)
                raise ConfigError(tr("请选择空工作区克隆仓库，或使用当前 Git 仓库的远端。"))
            self.setup_git()
            self._gh(editor, "repo", "clone", repo, ".", "--", "--no-recurse-submodules")
            return self._local_status(editor)

    @staticmethod
    def _git(editor: Editor, *args: str, raw: bool = False, optional: bool = False) -> str:
        env, options = GitHubEditor._context(editor)
        options.pop("cwd")
        env.update(
            GIT_TERMINAL_PROMPT="0",
            GIT_LITERAL_PATHSPECS="1",
            GIT_OPTIONAL_LOCKS="0",
            GH_PROMPT_DISABLED="1",
        )
        git = shutil.which("git", path=TOOLS)
        if not git:
            raise ConfigError(tr("请在服务器上安装 Git。"))
        command = [
            "/usr/bin/env",
            "-i",
            *(f"{key}={value}" for key, value in env.items()),
            git,
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "submodule.recurse=false",
            "-c",
            "fetch.recurseSubmodules=false",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.https.allow=always",
            "-c",
            "http.followRedirects=false",
            *args,
        ]
        if workspace := editor.workspace():
            command = workspace.command(command)
        try:
            status, output, _ = Git(editor.root).execute(
                command,
                with_extended_output=True,
                with_exceptions=False,
                stdout_as_string=False,
                strip_newline_in_stdout=False,
                kill_after_timeout=90,
                **options,
            )
        except (GitError, OSError) as exc:
            raise ConfigError(tr("Git 无法完成操作，请检查服务器上的 Git 和网络连接。")) from exc
        if status:
            if optional:
                return ""
            raise ConfigError(tr("Git {0} 失败。请检查工作区状态和远端权限。", args[0]))
        try:
            decoded = output.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ConfigError(tr("这个 Git 文件无法作为 UTF-8 文本显示。")) from exc
        return decoded if raw else decoded.strip()

    @staticmethod
    def _repository(editor: Editor) -> bool:
        git_dir = editor.root / ".git"
        return git_dir.is_dir() and not git_dir.is_symlink()

    def _require_repo(self, editor: Editor) -> None:
        if not self._repository(editor):
            raise ConfigError(tr("工作区里还没有 Git 仓库。"))

    def _branch(self, editor: Editor) -> str:
        return self._git(editor, "symbolic-ref", "--short", "HEAD", optional=True)

    def _origin(self, editor: Editor) -> str:
        origin = self._git(editor, "remote", "get-url", "origin", optional=True)
        for prefix in ("https://github.com/", "git@github.com:", "ssh://git@github.com/"):
            if origin.startswith(prefix):
                repo = origin.removeprefix(prefix).removesuffix(".git")
                return repo if SLUG.fullmatch(repo) else ""
        return ""

    def _local_status(self, editor: Editor) -> dict[str, Any]:
        if not self._repository(editor):
            return {"repository": False, "branch": "", "files": [], "remote": False}
        branch = self._branch(editor)
        files = self._git(
            editor,
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
            raw=True,
        )
        upstream = self._git(editor, "rev-parse", "--abbrev-ref", "@{upstream}", optional=True)
        counts = (
            self._git(
                editor,
                "rev-list",
                "--left-right",
                "--count",
                "HEAD...@{upstream}",
                optional=True,
            )
            if upstream
            else ""
        )
        ahead, behind = map(int, counts.split()) if counts else (0, 0)
        return {
            "repository": True,
            "branch": branch,
            "ahead": ahead,
            "behind": behind,
            "repo": self._origin(editor),
            "remote": bool(self._git(editor, "remote", "get-url", "origin", optional=True)),
            "files": [{"path": row[3:], "status": row[:2]} for row in files.split("\0") if row],
        }

    def local_status(self) -> dict[str, Any]:
        return self._local_status(self._editor())

    def initialize(self) -> dict[str, Any]:
        editor = self._editor()
        with editor_lock(self.data_dir, editor.root):
            if not self._repository(editor):
                if (editor.root / ".git").exists() or (editor.root / ".git").is_symlink():
                    raise ConfigError(tr("请选择 Git 仓库的根目录。"))
                self._git(editor, "init", "--initial-branch=main")
            return self._local_status(editor)

    def _validate_paths(self, editor: Editor, paths: list[str]) -> dict[str, str]:
        if not paths or len(paths) > 200:
            raise ConfigError(tr("请选择要操作的 Git 文件。"))
        self._require_repo(editor)
        files = {row["path"]: row["status"] for row in self._local_status(editor)["files"]}
        for path in paths:
            editor._file_parts(path)
            if path not in files:
                raise ConfigError(tr("文件状态已变更，请刷新 Git 改动后重试。"))
        return files

    def stage(self, paths: list[str], staged: bool) -> dict[str, Any]:
        editor = self._editor()
        with editor_lock(self.data_dir, editor.root):
            self._validate_paths(editor, paths)
            if staged:
                self._git(editor, "add", "--", *paths)
            elif self._git(editor, "rev-parse", "--verify", "HEAD", optional=True):
                self._git(editor, "reset", "--quiet", "HEAD", "--", *paths)
            else:
                self._git(editor, "rm", "--cached", "--force", "--ignore-unmatch", "--", *paths)
            return self._local_status(editor)

    def _blob(self, editor: Editor, revision: str) -> str:
        size = self._git(editor, "cat-file", "-s", revision, optional=True)
        if not size:
            return ""
        if int(size) > MAX_FILE:
            raise ConfigError(tr("文件超过 256 KiB，无法在网页编辑。"))
        content = self._git(editor, "cat-file", "blob", revision, raw=True)
        if "\0" in content:
            raise ConfigError(tr("这个 Git 文件无法作为 UTF-8 文本显示。"))
        return content

    def diff(self, path: str, staged: bool) -> dict[str, str]:
        editor = self._editor()
        files = self._validate_paths(editor, [path])
        index = self._blob(editor, ":" + path)
        if staged:
            return {"before": self._blob(editor, "HEAD:" + path), "after": index}
        try:
            current = "" if files[path][1] == "D" else editor.read(path).content
        except OSError as exc:
            raise EditorError(tr("无法打开这个路径，请检查文件是否存在且可读。")) from exc
        return {"before": index, "after": current}

    def unified_diff(self, path: str, staged: bool) -> str:
        change = self.diff(path, staged)
        return "".join(
            difflib.unified_diff(
                change["before"].splitlines(keepends=True),
                change["after"].splitlines(keepends=True),
                fromfile="a/" + path,
                tofile="b/" + path,
            )
        )

    def commit(self, paths: list[str], message: str) -> str:
        message = message.strip()
        if not message or len(message) > 1000 or "\0" in message:
            raise ConfigError(tr("请填写有效的提交说明。"))
        editor = self._editor()
        with editor_lock(self.data_dir, editor.root):
            self._require_repo(editor)
            files = {row["path"]: row["status"] for row in self._local_status(editor)["files"]}
            if paths:
                self._validate_paths(editor, paths)
            elif not any(value[0] not in {" ", "?"} for value in files.values()):
                raise ConfigError(tr("请先暂存要提交的文件。"))
            if any(value in CONFLICTS for value in files.values()):
                raise ConfigError(tr("请先在终端解决 Git 冲突。"))
            identity = self._git(editor, "var", "GIT_AUTHOR_IDENT", optional=True)
            identity_args: list[str] = []
            if not identity:
                account = self._account(editor) if shutil.which("gh", path=TOOLS) else {}
                login, user_id = account.get("login"), account.get("id")
                if not isinstance(login, str) or not isinstance(user_id, int):
                    raise ConfigError(
                        tr("请先在工作区终端用 git config 设置 user.name 和 user.email。")
                    )
                identity_args = [
                    "-c",
                    f"user.name={login}",
                    "-c",
                    f"user.email={user_id}+{login}@users.noreply.github.com",
                ]
            if new := [path for path in paths if files[path] == "??"]:
                self._git(editor, "add", "--intent-to-add", "--", *new)
            selection = ("--only", "--", *paths) if paths else ()
            self._git(editor, *identity_args, "commit", "-m", message, *selection)
            return self._git(editor, "rev-parse", "--short", "HEAD")

    def branches(self) -> dict[str, Any]:
        editor = self._editor()
        self._require_repo(editor)
        local = self._git(editor, "for-each-ref", "--format=%(refname:short)", "refs/heads")
        refs = self._git(editor, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin")
        names = set(local.splitlines()) | {
            name.removeprefix("origin/") for name in refs.splitlines() if name != "origin/HEAD"
        }
        return {"current": self._branch(editor), "branches": sorted(names, key=str.casefold)}

    def switch(self, branch: str) -> dict[str, Any]:
        editor = self._editor()
        with editor_lock(self.data_dir, editor.root):
            status = self._local_status(editor)
            self._require_repo(editor)
            if not branch or branch.startswith("-") or branch not in self.branches()["branches"]:
                raise ConfigError(tr("请填写有效的 Git 分支名。"))
            if status["files"]:
                raise ConfigError(tr("请先提交或处理本地改动，再切换分支。"))
            self._git(editor, "switch", "--no-overwrite-ignore", "--", branch)
            return self._local_status(editor)

    def sync(self, action: str) -> dict[str, Any]:
        editor = self._editor()
        with editor_lock(self.data_dir, editor.root):
            status = self._local_status(editor)
            if not status["remote"]:
                raise ConfigError(tr("请先在工作区配置 Git 远端。"))
            branch = status["branch"]
            if action == "check":
                self._git(editor, "fetch", "--prune", "--", "origin")
            elif not branch:
                raise ConfigError(tr("请选择当前 Git 分支。"))
            elif action == "pull":
                if status["files"]:
                    raise ConfigError(tr("本地有未提交的改动。请先在服务器上处理这些改动。"))
                self._git(
                    editor, "pull", "--ff-only", "--no-recurse-submodules", "--", "origin", branch
                )
            elif action == "push":
                self._git(
                    editor, "push", "--set-upstream", "--", "origin", f"HEAD:refs/heads/{branch}"
                )
            return self._local_status(editor)
