"""Run the installed entry point and the HTTP-only sample across a server outage."""

import os
import socket
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from pathlib import Path
from uuid import uuid4

import httpx

ROOT = Path(__file__).resolve().parents[2]
ADMIN = "/api/v2/admin"


def eventually(check, seconds=15):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        try:
            result = check()
            if result:
                return result
        except (httpx.TransportError, sqlite3.OperationalError):
            pass
        time.sleep(0.12)
    raise AssertionError("Expected state was not reached before the test deadline")


def stop(process):
    if process and process.poll() is None:
        process.kill()
        process.wait(timeout=4)


def unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def test_plain_http_program_reconnects_and_replays_its_outbox(tmp_path):
    port = unused_port()
    origin = f"http://127.0.0.1:{port}"
    state_file = tmp_path / "agent.sqlite3"
    data = tmp_path / "server"
    password = "http-example-fixture-password"
    env = {key: value for key, value in os.environ.items() if not key.startswith("QB_")}
    env["QB_ADMIN_PASSWORD"] = password
    service_args = [
        sys.executable,
        "-m",
        "quantbot",
        "--data-dir",
        str(data),
        "serve",
        "--port",
        str(port),
    ]

    def server():
        return subprocess.Popen(  # noqa: S603
            service_args, cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )

    def local(sql):
        if state_file.exists():
            with closing(sqlite3.connect(state_file)) as connection:
                row = connection.execute(sql).fetchone()
                return row[0] if row else None
        return None

    with httpx.Client(base_url=origin, timeout=2, trust_env=False) as http:
        process = server()
        agent = None
        try:
            eventually(lambda: http.get("/healthz").is_success)
            assert http.post(
                ADMIN + "/login", json={"username": "admin", "password": password}
            ).is_success
            response = http.post(
                ADMIN + "/strategies",
                json={
                    "name": "HTTP example",
                    "mode": "paper",
                    "token": {"scopes": ["session", "telemetry", "control", "commands"]},
                },
            )
            assert response.status_code == 201, response.text
            data = response.json()
            sid = data["strategy"]["id"]
            agent = subprocess.Popen(  # noqa: S603
                [
                    sys.executable,
                    str(ROOT / "examples/http_agent.py"),
                    "--control",
                    "--follow",
                    "--state",
                    str(state_file),
                ],
                cwd=ROOT,
                env={**env, "QB_URL": origin, "QB_TOKEN": data["credential"]["token"]},
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            strategy = f"{ADMIN}/strategies/{sid}"
            eventually(
                lambda: (
                    http.get(strategy + "/controls")
                    .json()
                    .get("states", {})
                    .get("rsi_period", {})
                    .get("value")
                    == 14
                )
            )
            issue = http.post(
                strategy + "/controls/rsi_period/invoke",
                json={
                    "revision": 1,
                    "request_id": uuid4().hex,
                    "value": 21,
                },
            ).json()
            command = f"{ADMIN}/commands/{issue['id']}"
            assert http.post(command + "/confirm").json()["state"] == "pending"
            eventually(lambda: http.get(command).json()["state"] == "succeeded")
            eventually(
                lambda: (
                    http.get(strategy + "/controls").json()["states"]["rsi_period"]["value"] == 21
                )
            )

            pause = http.post(
                strategy + "/commands",
                json={
                    "action": "pause_entry",
                    "request_id": uuid4().hex,
                },
            ).json()
            eventually(
                lambda: http.get(f"{ADMIN}/commands/{pause['id']}").json()["state"] == "succeeded"
            )
            before = len(http.get(strategy + "/metrics").json())
            assert before > 0

            stop(process)
            eventually(lambda: local("SELECT count(*) FROM outbox") or 0)
            assert agent.poll() is None
            assert local("SELECT value FROM local_state WHERE name='entry_enabled'") == "false"

            process = server()
            eventually(lambda: http.get("/healthz").is_success)
            eventually(lambda: len(http.get(strategy + "/metrics").json()) > before)
            actual = eventually(
                lambda: row if (row := http.get(strategy).json()["control"])["in_sync"] else None
            )
            assert actual["desired"]["entry_enabled"] is False
            assert actual["reported"]["entry_enabled"] is False
            assert local("SELECT count(*) FROM execution WHERE phase='done'") == 1
        finally:
            stop(agent)
            stop(process)
