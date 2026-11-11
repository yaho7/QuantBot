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
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from quantbot.config import ConfigError, Store
from quantbot.editor import Editor, editor_lock
from quantbot.i18n import tr

GITHUB_FILE = "github.json"
GITHUB_APP_FILE = "github-app.json"
DEVICE_URL = "https://github.com/login/device"
OAUTH_URL = "https://github.com/login/oauth/access_token"
API_URL = "https://api.github.com"
TRACKING = "refs/quantbot/github"
SLUG = re.compile(r"[A-Za-z0-9-]+/[A-Za-z0-9_.-]+")
CLIENT_ID = re.compile(r"[A-Za-z0-9._-]{8,100}")
APP_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,99}")


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
            raise ConfigError(
                tr("GitHub 找不到仓库。请确认 GitHub App 已获准访问该仓库。")
            ) from exc
        raise ConfigError(tr("GitHub 请求失败（HTTP {0}）。", exc.code)) from exc
    except (OSError, ValueError) as exc:
        raise ConfigError(tr("连接 GitHub 失败，请稍后再试。")) from exc
    if not isinstance(result, dict):
        raise ConfigError(tr("GitHub 返回的数据格式不对。"))
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


@dataclass
class RepositoryGrant:
    flow: Authorization
    credentials: dict[str, Any] = field(repr=False)
    expires: float = field(default_factory=lambda: time.monotonic() + 600)
    repositories: list[dict[str, Any]] = field(default_factory=list)


class GitHubEditor:
    def __init__(
        self,
        data_dir: Path,
        request: Callable[..., dict[str, Any]] = _request,
    ) -> None:
        self.store = Store(data_dir, filename=GITHUB_FILE)
        self.app_store = Store(data_dir, filename=GITHUB_APP_FILE)
        self.request = request

    def _editor(self) -> Editor:
        editor = Editor.configured(self.store.dir)
        if editor is None:
            raise ConfigError(tr("请先在服务器上启用策略编辑器。"))
        if editor.data_dir.is_relative_to(editor.root):
            raise ConfigError(tr("请选择 QuantBot 数据目录之外的 Git 仓库。"))
        if not editor.root.is_dir() or editor.root.resolve() != editor.root:
            raise ConfigError(tr("编辑目录已变更，请在服务器上重新选择目录。"))
        return editor

    def _binding(self, editor: Editor) -> dict[str, Any]:
        data = self.store.read()
        return data if data.get("root") == str(editor.root) else {}

    def app(self) -> dict[str, Any]:
        app = self.app_store.read()
        client_id = (
            app.get("client_id")
            or os.environ.get("QUANTBOT_GITHUB_CLIENT_ID")
            or self.store.read().get("client_id")
            or ""
        )
        slug = app.get("slug") or os.environ.get("QUANTBOT_GITHUB_APP_SLUG") or ""
        return {
            "client_id": client_id
            if isinstance(client_id, str) and CLIENT_ID.fullmatch(client_id)
            else "",
            "slug": slug if isinstance(slug, str) and APP_SLUG.fullmatch(slug) else "",
        }

    def configure_app(self, client_id: str, slug: str = "") -> dict[str, str]:
        client_id = client_id.strip()
        slug = slug.strip().removeprefix("https://github.com/apps/").rstrip("/")
        if not CLIENT_ID.fullmatch(client_id) or (slug and not APP_SLUG.fullmatch(slug)):
            raise ConfigError(tr("请填写有效的 GitHub App Client ID 和应用名称。"))
        app = {"client_id": client_id, "slug": slug}
        self.app_store.write(app)
        return app

    def register_app(self, code: str) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,200}", code):
            raise ConfigError(tr("GitHub 应用注册码无效。"))
        result = self.request(f"{API_URL}/app-manifests/{code}/conversions", form={})
        client_id, slug = result.get("client_id"), result.get("slug")
        if not isinstance(client_id, str) or not isinstance(slug, str):
            raise ConfigError(tr("GitHub 没有返回应用配置。"))
        self.configure_app(client_id, slug)

    def begin(self, repo: str = "", branch: str = "", client_id: str = "") -> Authorization:
        editor = self._editor()
        repo = repo.strip().removeprefix("https://github.com/").rstrip("/").removesuffix(".git")
        if repo and (not SLUG.fullmatch(repo) or repo.split("/")[1] in {".", ".."}):
            raise ConfigError(tr("请输入 GitHub 仓库名，例如 owner/strategy。"))
        branch = branch.strip()
        if branch:
            self._check_branch(editor, branch)
        client_id = client_id.strip() or self.app()["client_id"]
        if not CLIENT_ID.fullmatch(client_id):
            raise ConfigError(tr("请填写启用了设备授权的 GitHub App Client ID。"))
        result = self.request(f"{DEVICE_URL}/code", form={"client_id": client_id})
        if result.get("error"):
            raise ConfigError(tr("GitHub 无法启动设备授权（{0}）。", result["error"]))
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
            raise ConfigError(tr("GitHub 没有返回设备授权码。")) from exc

    def poll(self, flow: Authorization) -> dict[str, Any] | None:
        credentials = self.poll_credentials(flow)
        return self._finish(flow, credentials) if credentials else None

    def poll_credentials(self, flow: Authorization) -> dict[str, Any] | None:
        now = time.monotonic()
        if now >= flow.expires:
            raise ConfigError(tr("GitHub 授权码已过期，请重新绑定。"))
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
            raise ConfigError(tr("GitHub 授权未完成（{0}）。请重新绑定。", error))
        return self._credentials(result)

    def _pages(self, resource: str, key: str, token: str) -> Iterator[dict[str, Any]]:
        page = 1
        while True:
            data = self.request(f"{API_URL}/{resource}?per_page=100&page={page}", token=token)
            items = data.get(key)
            if not isinstance(items, list):
                raise ConfigError(tr("GitHub 返回的仓库列表格式不对。"))
            yield from (item for item in items if isinstance(item, dict))
            total = data.get("total_count")
            if len(items) < 100 or (isinstance(total, int) and page * 100 >= total):
                return
            page += 1

    def repositories(self, grant: RepositoryGrant) -> list[dict[str, Any]]:
        self._check_grant(grant)
        token = grant.credentials["access_token"]
        repositories = {}
        for installation in self._pages("user/installations", "installations", token):
            installation_id = installation.get("id")
            if type(installation_id) is not int or installation.get("suspended_at"):
                continue
            for repo in self._pages(
                f"user/installations/{installation_id}/repositories", "repositories", token
            ):
                name = repo.get("full_name")
                if isinstance(name, str) and SLUG.fullmatch(name):
                    repositories[name] = {"name": name, "private": bool(repo.get("private"))}
        grant.repositories = sorted(repositories.values(), key=lambda item: item["name"].casefold())
        return grant.repositories

    @staticmethod
    def _check_grant(grant: RepositoryGrant) -> None:
        if time.monotonic() >= grant.expires or (
            grant.credentials.get("expires") and time.time() >= grant.credentials["expires"]
        ):
            raise ConfigError(tr("GitHub 授权已过期，请重新绑定。"))

    def select_repository(self, grant: RepositoryGrant, repo: str) -> dict[str, Any]:
        self._check_grant(grant)
        if not any(item["name"] == repo for item in grant.repositories):
            raise ConfigError(tr("请选择 GitHub 已授权的仓库。"))
        return self._finish(replace(grant.flow, repo=repo), grant.credentials)

    @staticmethod
    def _credentials(result: dict[str, Any]) -> dict[str, Any]:
        token = result.get("access_token")
        if not isinstance(token, str) or not token:
            raise ConfigError(tr("GitHub 没有签发访问凭据，请重新授权。"))
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
            raise ConfigError(tr("GitHub 授权已过期，请重新绑定。"))
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
                raise ConfigError(tr("编辑目录已变更，请重新绑定。"))
            token = credentials["access_token"]
            repo = self.request(f"{API_URL}/repos/{flow.repo}", token=token)
            url = f"https://github.com/{flow.repo}.git"
            if any(editor.root.iterdir()):
                branch = self._branch(editor)
                if flow.branch and flow.branch != branch:
                    raise ConfigError(tr("当前本地分支是 {0}，请切换到要绑定的分支。", branch))
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
            if not self.app_store.exists():
                self.configure_app(flow.client_id, self.app()["slug"])
            return self._status(editor, binding)

    def status(self) -> dict[str, Any]:
        with editor_lock(self.store.dir):
            editor = self._editor()
            return self._status(editor, self._binding(editor))

    def local_status(self) -> dict[str, Any]:
        with editor_lock(self.store.dir):
            return self._local_status(self._editor())

    def _local_status(self, editor: Editor) -> dict[str, Any]:
        if not (editor.root / ".git").exists():
            return {"repository": False, "branch": "", "files": []}
        branch = self._branch(editor)
        output = self._git(
            editor,
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
            raw=True,
        )
        return {
            "repository": True,
            "branch": branch,
            "files": [
                {"path": record[3:], "status": record[:2]}
                for record in output.split("\0")
                if record
            ],
        }

    def commit(self, paths: list[str], message: str) -> str:
        message = message.strip()
        if not message or len(message) > 1000 or "\0" in message or not paths or len(paths) > 200:
            raise ConfigError(tr("请选择要提交的文件并填写提交说明。"))
        with editor_lock(self.store.dir):
            editor = self._editor()
            files = {item["path"]: item["status"] for item in self._local_status(editor)["files"]}
            if any(path not in files for path in paths):
                raise ConfigError(tr("文件状态已变更，请刷新 Git 改动后重试。"))
            if any("U" in status or status in {"AA", "DD"} for status in files.values()):
                raise ConfigError(tr("请先在终端解决 Git 冲突。"))
            try:
                self._git(editor, "var", "GIT_AUTHOR_IDENT")
                self._git(editor, "var", "GIT_COMMITTER_IDENT")
            except ConfigError as exc:
                raise ConfigError(
                    tr("请先在工作区终端用 git config 设置 user.name 和 user.email。")
                ) from exc
            if new := [path for path in paths if files[path] == "??"]:
                self._git(editor, "add", "--intent-to-add", "--", *new)
            self._git(editor, "commit", "--only", "-m", message, "--", *paths)
            return self._git(editor, "rev-parse", "--short", "HEAD")

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
                raise ConfigError(tr("请切换回已绑定的本地分支 {0}。", binding["branch"]))
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
            raise ConfigError(tr("请选择检查、拉取或推送。"))
        with editor_lock(self.store.dir):
            editor = self._editor()
            binding = self._binding(editor)
            if not binding:
                raise ConfigError(tr("请先绑定 GitHub 策略仓库。"))
            status = self._status(editor, binding)
            if status.get("error"):
                raise ConfigError(status["error"])
            if action == "pull" and status["dirty"]:
                raise ConfigError(tr("本地有未提交的改动。请先在服务器上处理这些改动。"))
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
            if not self.app_store.exists() and (app := self.app())["client_id"]:
                self.configure_app(app["client_id"], app["slug"])
            self.store.path.unlink(missing_ok=True)

    def _branch(self, editor: Editor) -> str:
        git_dir = editor.root / ".git"
        if not git_dir.is_dir() or git_dir.is_symlink():
            raise ConfigError(tr("编辑目录需要是空文件夹，或现有 Git 仓库的根目录。"))
        if Path(self._git(editor, "rev-parse", "--show-toplevel")) != editor.root:
            raise ConfigError(tr("请选择 Git 仓库的根目录。"))
        return self._git(editor, "symbolic-ref", "--short", "HEAD")

    def _check_branch(self, editor: Editor, branch: str) -> None:
        if not branch or branch.startswith("-"):
            raise ConfigError(tr("请填写有效的 Git 分支名。"))
        self._git(editor, "check-ref-format", f"refs/heads/{branch}")

    def _fetch(self, editor: Editor, url: str, branch: str, token: str) -> None:
        self._git(
            editor, "fetch", "--no-tags", "--", url, f"+refs/heads/{branch}:{TRACKING}", token=token
        )

    @staticmethod
    def _git(editor: Editor, *args: str, token: str = "", raw: bool = False) -> str:
        workspace = editor.workspace()
        env = (
            workspace.environment()
            if workspace
            else {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        )
        env["GIT_TERMINAL_PROMPT"] = "0"
        env["GIT_LITERAL_PATHSPECS"] = "1"
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
        options = workspace.process_options() if workspace else {}
        if workspace:
            command = workspace.command(command)
        try:
            done = subprocess.run(  # noqa: S603
                command,
                env=env,
                capture_output=True,
                text=True,
                timeout=90,
                check=False,
                **options,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ConfigError(tr("Git 无法完成操作，请检查服务器上的 Git 和网络连接。")) from exc
        if done.returncode:
            output = done.stderr.strip()
            if token:
                output = output.replace(token, "***").replace(credentials, "***")
            raise ConfigError(tr("Git {0} 失败。{1}", args[0], output[-800:]))
        return done.stdout if raw else done.stdout.strip()
