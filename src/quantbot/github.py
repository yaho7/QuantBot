"""GitHub App device authorization and explicit Git sync for the editor root."""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from quantbot.config import ConfigError, Store
from quantbot.editor import Editor, editor_lock

GITHUB_FILE = "github.json"
DEVICE_URL = "https://github.com/login/device"
OAUTH_URL = "https://github.com/login/oauth/access_token"
API_URL = "https://api.github.com"
TRACKING = "refs/quantbot/github"
SLUG = re.compile(r"[A-Za-z0-9-]+/[A-Za-z0-9_.-]+")
CLIENT_ID = re.compile(r"[A-Za-z0-9._-]{8,100}")


def _request(url: str, *, form: dict[str, str] | None = None, token: str = "") -> dict[str, Any]:
    headers = {"Accept": "application/json", "User-Agent": "QuantBot"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = urllib.parse.urlencode(form).encode() if form is not None else None
    request = urllib.request.Request(url, data=data, headers=headers)  # noqa: S310 - fixed HTTPS URLs
    try:
        with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise ConfigError("GitHub 找不到仓库。请确认 GitHub App 已获准访问该仓库。") from exc
        raise ConfigError(f"GitHub 请求失败（HTTP {exc.code}）。") from exc
    except (OSError, ValueError) as exc:
        raise ConfigError("连接 GitHub 失败，请稍后再试。") from exc
    if not isinstance(result, dict):
        raise ConfigError("GitHub 返回的数据格式不对。")
    return result


@dataclass
class Authorization:
    repo: str
    branch: str
    root: Path
    client_id: str
    device_code: str = field(repr=False)
    user_code: str
    expires: float
    interval: int
    next_poll: float

    def prompt(self) -> dict[str, Any]:
        return {"url": DEVICE_URL, "code": self.user_code, "interval": self.interval}


class GitHubEditor:
    def __init__(
        self,
        data_dir: Path,
        request: Callable[..., dict[str, Any]] = _request,
    ) -> None:
        self.store = Store(data_dir, filename=GITHUB_FILE)
        self.request = request

    def _editor(self) -> Editor:
        editor = Editor.configured(self.store.dir)
        if editor is None:
            raise ConfigError("请先在服务器上启用策略编辑器。")
        if editor.data_dir.is_relative_to(editor.root):
            raise ConfigError("请选择 QuantBot 数据目录之外的 Git 仓库。")
        if not editor.root.is_dir() or editor.root.resolve() != editor.root:
            raise ConfigError("编辑目录已变更，请在服务器上重新选择目录。")
        return editor

    def _binding(self, editor: Editor) -> dict[str, Any]:
        data = self.store.read()
        return data if data.get("root") == str(editor.root) else {}

    def begin(self, repo: str, branch: str, client_id: str) -> Authorization:
        editor = self._editor()
        repo = repo.strip().removeprefix("https://github.com/").rstrip("/").removesuffix(".git")
        if not SLUG.fullmatch(repo) or repo.split("/")[1] in {".", ".."}:
            raise ConfigError("请输入 GitHub 仓库名，例如 owner/strategy。")
        branch = branch.strip()
        if branch:
            self._check_branch(editor, branch)
        client_id = client_id.strip() or str(self._binding(editor).get("client_id") or "")
        if not CLIENT_ID.fullmatch(client_id):
            raise ConfigError("请填写启用了设备授权的 GitHub App Client ID。")
        result = self.request(f"{DEVICE_URL}/code", form={"client_id": client_id})
        if result.get("error"):
            raise ConfigError(f"GitHub 无法启动设备授权（{result['error']}）。")
        now = time.monotonic()
        try:
            interval = max(5, int(result["interval"]))
            return Authorization(
                repo,
                branch,
                editor.root,
                client_id,
                str(result["device_code"]),
                str(result["user_code"]),
                now + int(result["expires_in"]),
                interval,
                now + interval,
            )
        except (KeyError, ValueError, TypeError) as exc:
            raise ConfigError("GitHub 没有返回设备授权码。") from exc

    def poll(self, flow: Authorization) -> dict[str, Any] | None:
        now = time.monotonic()
        if now >= flow.expires:
            raise ConfigError("GitHub 授权码已过期，请重新绑定。")
        if now < flow.next_poll:
            return None
        flow.next_poll = now + flow.interval
        result = self.request(
            OAUTH_URL,
            form={
                "client_id": flow.client_id,
                "device_code": flow.device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
        )
        error = result.get("error")
        if error == "authorization_pending":
            return None
        if error == "slow_down":
            flow.interval = max(flow.interval + 5, int(result.get("interval") or 0))
            flow.next_poll = now + flow.interval
            return None
        if error:
            raise ConfigError(f"GitHub 授权未完成（{error}）。请重新绑定。")
        return self._finish(flow, self._credentials(result))

    @staticmethod
    def _credentials(result: dict[str, Any]) -> dict[str, Any]:
        token = result.get("access_token")
        if not isinstance(token, str) or not token:
            raise ConfigError("GitHub 没有签发访问凭据，请重新授权。")
        lifetime = int(result.get("expires_in") or 0)
        return {
            "access_token": token,
            "refresh_token": result.get("refresh_token"),
            "expires": time.time() + lifetime if lifetime else 0,
        }

    def _token(self, binding: dict[str, Any]) -> str:
        if not binding.get("expires") or binding["expires"] > time.time() + 60:
            return binding["access_token"]
        if not binding.get("refresh_token"):
            raise ConfigError("GitHub 授权已过期，请重新绑定。")
        result = self.request(
            OAUTH_URL,
            form={
                "client_id": binding["client_id"],
                "grant_type": "refresh_token",
                "refresh_token": binding["refresh_token"],
            },
        )
        binding.update(self._credentials(result))
        self.store.write(binding)
        return binding["access_token"]

    def _finish(self, flow: Authorization, credentials: dict[str, Any]) -> dict[str, Any]:
        with editor_lock(self.store.dir):
            editor = self._editor()
            if editor.root != flow.root:
                raise ConfigError("编辑目录已变更，请重新绑定。")
            token = credentials["access_token"]
            repo = self.request(f"{API_URL}/repos/{flow.repo}", token=token)
            url = f"https://github.com/{flow.repo}.git"
            if any(editor.root.iterdir()):
                branch = self._branch(editor)
                if flow.branch and flow.branch != branch:
                    raise ConfigError(f"当前本地分支是 {branch}，请切换到要绑定的分支。")
                self._git(
                    editor, "fetch", "--no-tags", "--", url, f"refs/heads/{branch}", token=token
                )
                self._git(editor, "merge-base", "HEAD", "FETCH_HEAD")
                self._git(editor, "update-ref", TRACKING, "FETCH_HEAD")
            else:
                branch = flow.branch or str(repo.get("default_branch") or "")
                self._check_branch(editor, branch)
                self._git(
                    editor,
                    "clone",
                    "--single-branch",
                    "--branch",
                    branch,
                    "--",
                    url,
                    ".",
                    token=token,
                )
                self._git(editor, "update-ref", TRACKING, "HEAD")
            binding = {
                **credentials,
                "repo": flow.repo,
                "root": str(editor.root),
                "branch": branch,
                "client_id": flow.client_id,
            }
            self.store.write(binding)
            return self._status(editor, binding)

    def status(self) -> dict[str, Any]:
        with editor_lock(self.store.dir):
            editor = self._editor()
            return self._status(editor, self._binding(editor))

    def _status(self, editor: Editor, binding: dict[str, Any]) -> dict[str, Any]:
        if not binding:
            return {"bound": False}
        result = {
            "bound": True,
            "repo": binding["repo"],
            "branch": binding["branch"],
            "client_id": binding["client_id"],
        }
        try:
            branch = self._branch(editor)
            if branch != binding["branch"]:
                raise ConfigError(f"请切换回已绑定的本地分支 {binding['branch']}。")
            ahead, behind = self._git(
                editor, "rev-list", "--left-right", "--count", f"HEAD...{TRACKING}"
            ).split()
            result.update(
                ahead=int(ahead),
                behind=int(behind),
                dirty=bool(self._git(editor, "status", "--porcelain", "--untracked-files=all")),
            )
        except ConfigError as exc:
            result["error"] = str(exc)
        return result

    def sync(self, action: str) -> dict[str, Any]:
        if action not in {"check", "pull", "push"}:
            raise ConfigError("请选择检查、拉取或推送。")
        with editor_lock(self.store.dir):
            editor = self._editor()
            binding = self._binding(editor)
            if not binding:
                raise ConfigError("请先绑定 GitHub 策略仓库。")
            status = self._status(editor, binding)
            if status.get("error"):
                raise ConfigError(status["error"])
            if action == "pull" and status["dirty"]:
                raise ConfigError("本地有未提交的改动。请先在服务器上处理这些改动。")
            token = self._token(binding)
            url = f"https://github.com/{binding['repo']}.git"
            branch = binding["branch"]
            self._fetch(editor, url, branch, token)
            if action == "pull":
                self._git(editor, "merge", "--ff-only", "--no-overwrite-ignore", TRACKING)
            if action == "push":
                self._git(
                    editor,
                    "push",
                    "--no-verify",
                    "--",
                    url,
                    f"HEAD:refs/heads/{branch}",
                    token=token,
                )
                self._git(editor, "update-ref", TRACKING, "HEAD")
            return self._status(editor, binding)

    def unbind(self) -> None:
        with editor_lock(self.store.dir):
            self.store.path.unlink(missing_ok=True)

    def _branch(self, editor: Editor) -> str:
        git_dir = editor.root / ".git"
        if not git_dir.is_dir() or git_dir.is_symlink():
            raise ConfigError("编辑目录需要是空文件夹，或现有 Git 仓库的根目录。")
        if Path(self._git(editor, "rev-parse", "--show-toplevel")) != editor.root:
            raise ConfigError("请选择 Git 仓库的根目录。")
        return self._git(editor, "symbolic-ref", "--short", "HEAD")

    def _check_branch(self, editor: Editor, branch: str) -> None:
        if not branch or branch.startswith("-"):
            raise ConfigError("请填写有效的 Git 分支名。")
        self._git(editor, "check-ref-format", f"refs/heads/{branch}")

    def _fetch(self, editor: Editor, url: str, branch: str, token: str) -> None:
        self._git(
            editor, "fetch", "--no-tags", "--", url, f"+refs/heads/{branch}:{TRACKING}", token=token
        )

    @staticmethod
    def _git(editor: Editor, *args: str, token: str = "") -> str:
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        env["GIT_TERMINAL_PROMPT"] = "0"
        if token:
            credentials = base64.b64encode(f"x-access-token:{token}".encode()).decode("ascii")
            env.update(
                GIT_CONFIG_COUNT="1",
                GIT_CONFIG_KEY_0="http.https://github.com/.extraheader",
                GIT_CONFIG_VALUE_0=f"Authorization: Basic {credentials}",
            )
        command = [
            "git",
            "-C",
            str(editor.root),
            "-c",
            "credential.helper=",
            "-c",
            "credential.https://github.com.helper=",
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
        try:
            done = subprocess.run(  # noqa: S603
                command,
                env=env,
                capture_output=True,
                text=True,
                timeout=90,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ConfigError("Git 无法完成操作，请检查服务器上的 Git 和网络连接。") from exc
        if done.returncode:
            output = done.stderr.strip()
            if token:
                output = output.replace(token, "***").replace(credentials, "***")
            raise ConfigError(f"Git {args[0]} 失败。{output[-800:]}")
        return done.stdout.strip()
