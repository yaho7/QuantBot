"""Run QuantBot in the background: starts at boot or login, restarts when it exits.

* Linux: a systemd service. As a normal user it is a user service with
  lingering turned on, so it keeps running after you log out; as root it is a
  system service.
* macOS: a launchd agent in ~/Library/LaunchAgents.
"""

from __future__ import annotations

import json
import os
import plistlib
import shlex
import shutil
import subprocess
import sys
import time
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from quantbot.i18n import tr

NAME = "quantbot"
LABEL = "io.github.yaho7.quantbot"

Runner = Callable[[Sequence[str]], "subprocess.CompletedProcess[str]"]


def _run(cmd: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(list(cmd), capture_output=True, text=True, check=False)  # noqa: S603


class ServiceError(Exception):
    pass


def wait_until_ready(origin: str, timeout: float = 25) -> None:
    url = f"{origin}/healthz"
    deadline = time.monotonic() + timeout
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while True:
        try:
            with opener.open(url, timeout=1) as response:
                if json.loads(response.read(256)) == {"ok": True}:
                    return
        except (OSError, ValueError):
            pass
        if time.monotonic() >= deadline:
            raise ServiceError(tr("服务未通过健康检查（{0}）。", url))
        time.sleep(0.5)


def executable() -> str:
    """The installed `quantbot` command, with a full path for the service manager."""
    found = shutil.which(NAME)
    return str(Path(found or sys.argv[0]).absolute())  # keep uv's link, it survives upgrades


@dataclass
class Service:
    kind: str  # "systemd-user" | "systemd-system" | "launchd"
    home: Path
    run: Runner = _run
    env: dict[str, str] = field(default_factory=dict)

    @classmethod
    def detect(cls, run: Runner = _run, platform: str | None = None) -> Service:
        platform = platform or sys.platform
        home = Path.home()
        if platform == "darwin":
            return cls("launchd", home, run)
        if platform.startswith("linux") and shutil.which("systemctl"):
            kind = "systemd-system" if os.geteuid() == 0 else "systemd-user"
            return cls(kind, home, run)
        raise ServiceError(tr("这台机器没有 systemd 或 launchd。请用 quantbot run 在前台运行。"))

    # --------------------------------------------------------------- paths

    @property
    def path(self) -> Path:
        if self.kind == "launchd":
            return self.home / "Library" / "LaunchAgents" / f"{LABEL}.plist"
        if self.kind == "systemd-system":
            return Path("/etc/systemd/system") / f"{NAME}.service"
        config = os.environ.get("XDG_CONFIG_HOME") or str(self.home / ".config")
        return Path(config) / "systemd" / "user" / f"{NAME}.service"

    @property
    def log_file(self) -> Path:
        return self.home / "Library" / "Logs" / "quantbot.log"

    # --------------------------------------------------------------- files

    def unit(self, executable: str, data_dir: Path) -> str:
        if self.kind == "launchd":
            return plistlib.dumps(
                {
                    "Label": LABEL,
                    "ProgramArguments": [executable, "run"],
                    "EnvironmentVariables": {"QB_DATA_DIR": str(data_dir)},
                    "RunAtLoad": True,
                    "KeepAlive": True,  # QuantBot does not trade, so restarting it is safe
                    "ThrottleInterval": 5,
                    "StandardOutPath": str(self.log_file),
                    "StandardErrorPath": str(self.log_file),
                }
            ).decode()
        target = "default.target" if self.kind == "systemd-user" else "multi-user.target"
        return "\n".join(
            [
                "[Unit]",
                "Description=QuantBot: Telegram control for trading programs",
                "After=network-online.target",
                "Wants=network-online.target",
                "",
                "[Service]",
                f"ExecStart={shlex.quote(executable)} run",
                f"Environment={shlex.quote(f'QB_DATA_DIR={data_dir}')}",
                # QuantBot does not trade, so restarting it is safe. It also exits on
                # purpose after `quantbot setup` changes Telegram settings.
                "Restart=always",
                "RestartSec=5",
                "",
                "[Install]",
                f"WantedBy={target}",
                "",
            ]
        )

    # ------------------------------------------------------------ commands

    def _systemctl(self, *args: str) -> subprocess.CompletedProcess[str]:
        user = ["--user"] if self.kind == "systemd-user" else []
        return self.run(["systemctl", *user, *args])

    def _launchctl(self, *args: str) -> subprocess.CompletedProcess[str]:
        return self.run(["launchctl", *args])

    def _domain(self) -> str:
        return f"gui/{os.getuid()}"

    def _check(self, result: subprocess.CompletedProcess[str], what: str) -> None:
        if result.returncode != 0:
            raise ServiceError(tr("{0} 失败：{1}", what, (result.stderr or result.stdout).strip()))

    def install(self, executable: str, data_dir: Path) -> list[str]:
        """Write the service file, enable it and (re)start it. Returns notes for the user."""
        notes: list[str] = []
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.kind == "launchd":
            self.log_file.parent.mkdir(parents=True, exist_ok=True)
            self._launchctl("bootout", f"{self._domain()}/{LABEL}")  # fine if it was not loaded
            self.path.write_text(self.unit(executable, data_dir), "utf-8")
            self._check(self._launchctl("bootstrap", self._domain(), str(self.path)), "launchctl")
            return notes
        self.path.write_text(self.unit(executable, data_dir), "utf-8")
        for args in (("daemon-reload",), ("enable", NAME), ("restart", NAME)):
            self._check(self._systemctl(*args), f"systemctl {' '.join(args)}")
        if self.kind == "systemd-user":
            user = os.environ.get("USER") or ""
            if self.run(["loginctl", "enable-linger", *([user] if user else [])]).returncode:
                notes.append(
                    tr(
                        "退出登录后 QuantBot 会停。要一直运行，请执行："
                        "sudo loginctl enable-linger {0}",
                        user or "$USER",
                    )
                )
        return notes

    def uninstall(self) -> None:
        if not self.installed():
            return
        if self.kind == "launchd":
            target = f"{self._domain()}/{LABEL}"
            result = self._launchctl("bootout", target)
            if result.returncode and self._launchctl("print", target).returncode == 0:
                self._check(result, "launchctl bootout")
        else:
            self._check(self._systemctl("disable", "--now", NAME), "systemctl disable --now")
        self.path.unlink(missing_ok=True)
        if self.kind != "launchd":
            self._check(self._systemctl("daemon-reload"), "systemctl daemon-reload")

    def configured_instance(self) -> tuple[Path, Path]:
        """Read the executable and data directory from a QuantBot service file."""
        try:
            if self.kind == "launchd":
                with self.path.open("rb") as file:
                    config = plistlib.load(file)
                args = config["ProgramArguments"]
                directory = config["EnvironmentVariables"]["QB_DATA_DIR"]
            else:
                lines = self.path.read_text("utf-8").splitlines()
                args = shlex.split(
                    next(line.split("=", 1)[1] for line in lines if line.startswith("ExecStart="))
                )
                env = dict(
                    pair.split("=", 1)
                    for line in lines
                    if line.startswith("Environment=")
                    for pair in shlex.split(line.split("=", 1)[1])
                )
                directory = env["QB_DATA_DIR"]
            command, data_dir = Path(args[0]), Path(directory)
            if args[1:] != ["run"] or not command.is_absolute() or not data_dir.is_absolute():
                raise ValueError
        except (OSError, ValueError, TypeError, KeyError, IndexError, StopIteration) as exc:
            raise ServiceError(
                tr("无法识别服务文件中的 QuantBot 实例（{0}）。", self.path)
            ) from exc
        return command, data_dir

    def installed(self) -> bool:
        return self.path.exists()

    def restart(self) -> None:
        if self.kind == "launchd":
            result = self._launchctl("kickstart", "-k", f"{self._domain()}/{LABEL}")
        else:
            result = self._systemctl("restart", NAME)
        self._check(result, tr("重启"))

    def status(self) -> str:
        if not self.installed():
            return ""
        if self.kind == "launchd":
            result = self._launchctl("print", f"{self._domain()}/{LABEL}")
            state = next(
                (line.strip() for line in result.stdout.splitlines() if "state =" in line), ""
            )
            return f"{LABEL}: {state or tr('没有在运行')}"
        result = self._systemctl("status", "--no-pager", "--lines=0", NAME)
        return (result.stdout or result.stderr).strip()

    def logs_command(self, follow: bool) -> list[str]:
        if self.kind == "launchd":
            return ["tail", "-n", "100", *(["-f"] if follow else []), str(self.log_file)]
        user = ["--user"] if self.kind == "systemd-user" else []
        return [
            "journalctl",
            *user,
            "-u",
            NAME,
            "-n",
            "100",
            *(["-f"] if follow else ["--no-pager"]),
        ]

    def recent_logs(self) -> str:
        if self.kind == "launchd" and not self.log_file.exists():
            return ""
        result = self.run(self.logs_command(follow=False))
        self._check(result, tr("读取日志"))
        return result.stdout
