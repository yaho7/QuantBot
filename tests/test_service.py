"""Background service files and commands, with a fake systemctl/launchctl."""

from __future__ import annotations

import plistlib
import subprocess
from collections.abc import Sequence
from pathlib import Path

import pytest

from quantbot import cli
from quantbot.cli import main
from quantbot.config import Store
from quantbot.service import LABEL, Service, ServiceError
from tests.test_cli import Script


class Recorder:
    def __init__(self, fail: set[str] | None = None) -> None:
        self.calls: list[list[str]] = []
        self.fail = fail or set()

    def __call__(self, cmd: Sequence[str]) -> subprocess.CompletedProcess[str]:
        self.calls.append(list(cmd))
        code = 1 if any(word in self.fail for word in cmd) else 0
        return subprocess.CompletedProcess(list(cmd), code, "state = running\n", "boom")


def test_systemd_user_service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "cfg"))
    monkeypatch.setenv("USER", "yaho")
    run = Recorder(fail={"enable-linger"})
    service = Service("systemd-user", tmp_path, run)
    notes = service.install("/home/yaho/.local/bin/quantbot", tmp_path / "data")
    unit = service.path.read_text()
    assert service.path == tmp_path / "cfg/systemd/user/quantbot.service"
    assert "ExecStart=/home/yaho/.local/bin/quantbot run" in unit
    assert f"Environment=QB_DATA_DIR={tmp_path / 'data'}" in unit
    assert "Restart=always" in unit and "WantedBy=default.target" in unit
    assert run.calls == [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "quantbot"],
        ["systemctl", "--user", "restart", "quantbot"],
        ["loginctl", "enable-linger", "yaho"],
    ]
    assert notes == [
        "退出登录后 QuantBot 会停。要一直运行，请执行：sudo loginctl enable-linger yaho"
    ]
    assert service.logs_command(True) == [
        "journalctl", "--user", "-u", "quantbot", "-n", "100", "-f",
    ]  # fmt: skip
    service.uninstall()
    assert not service.path.exists()
    assert ["systemctl", "--user", "disable", "--now", "quantbot"] in run.calls


def test_systemd_failure_is_reported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    service = Service("systemd-user", tmp_path, Recorder(fail={"enable"}))
    with pytest.raises(ServiceError, match="systemctl enable quantbot 失败：boom"):
        service.install("/bin/quantbot", tmp_path)


def test_launchd_agent(tmp_path: Path) -> None:
    run = Recorder(fail={"bootout"})  # not loaded yet: ignored
    service = Service("launchd", tmp_path, run)
    service.install("/Users/yaho/.local/bin/quantbot", tmp_path / "data")
    plist = plistlib.loads(service.path.read_bytes())
    assert service.path == tmp_path / f"Library/LaunchAgents/{LABEL}.plist"
    assert plist["ProgramArguments"] == ["/Users/yaho/.local/bin/quantbot", "run"]
    assert plist["EnvironmentVariables"] == {"QB_DATA_DIR": str(tmp_path / "data")}
    assert plist["KeepAlive"] is True and plist["RunAtLoad"] is True
    assert [c[:2] for c in run.calls] == [["launchctl", "bootout"], ["launchctl", "bootstrap"]]
    assert service.status().endswith("state = running")
    assert service.logs_command(False)[-1] == str(tmp_path / "Library/Logs/quantbot.log")


def test_detect_without_a_service_manager() -> None:
    with pytest.raises(ServiceError, match="quantbot run"):
        Service.detect(platform="win32")


def test_service_command_saves_listen(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    service = Service("launchd", tmp_path, Recorder())
    monkeypatch.setattr(cli, "detect_service", lambda: service)
    store = Store(tmp_path / "data")
    io = Script([])
    assert main(["service", "install", "--listen", "0.0.0.0:9000"], io=io, store=store) == 0
    assert store.read()["listen"] == "0.0.0.0:9000"
    assert "还没设置 Telegram" not in io.text() and "开机自动启动" in io.text()
    assert "设置网页管理员" in io.text()
    assert main(["service", "install", "--listen", "9000"], io=Script([]), store=store) == 1
    assert cli.api_url(store) == "http://127.0.0.1:9000"


def test_service_install_port_choice(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import socket

    service = Service("launchd", tmp_path, Recorder())
    monkeypatch.setattr(cli, "detect_service", lambda: service)
    store = Store(tmp_path / "data")
    io = Script([])
    assert main(["service", "install"], io=io, store=store) == 0  # random port
    picked = store.read()["listen"]
    assert f"监听：{picked}" in io.text()
    assert main(["service", "install", "--port", "31234"], io=Script([]), store=store) == 0
    assert store.read()["listen"] == "127.0.0.1:31234"
    assert main(["service", "install", "--port", "80"], io=Script([]), store=store) == 1
    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        port = busy.getsockname()[1]
        io = Script([])
        assert main(["service", "install", "--port", str(port)], io=io, store=store) == 1
        assert "占用" in io.text()
    assert store.read()["listen"] == "127.0.0.1:31234"
