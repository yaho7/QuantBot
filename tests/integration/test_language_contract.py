"""Run the same paper-only Agent API lifecycle using three standard HTTP transports."""

import json
import os
import shutil
import sqlite3
import subprocess
import sys
from contextlib import closing
from datetime import datetime, timezone
from uuid import uuid4

import httpx
import pytest
from examples.http_agent import Demo, RequestFailure

from tests.integration.test_http_example import ADMIN, ROOT, eventually, stop, unused_port

FIXTURE = ROOT / "tests/fixtures/go_contract_test.go"


class TransportFailure(RuntimeError):
    pass


NODE_DRIVER = """
import {request} from "./examples/http_monitor.mjs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const response = await request(process.env.QB_METHOD, process.env.QB_PATH,
    input ? JSON.parse(input) : undefined, process.env.QB_SESSION);
  console.log(JSON.stringify(response));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
"""


@pytest.fixture(params=["Python", "Node.js", "Go"])
def transport(request, tmp_path):
    name = request.param
    if name == "Python":

        def send(endpoint, secret, method, path, payload=None, session=None):
            with closing(sqlite3.connect(":memory:")) as db:
                agent = Demo(endpoint, secret, "contract", db, False)
                if session:
                    agent.headers["X-Agent-Session"] = session
                return agent.http(method, path, payload)

        return name, send

    executable = shutil.which("node" if name == "Node.js" else "go")
    if not executable:
        if os.environ.get("QB_REQUIRE_LANGUAGE_TESTS"):
            pytest.fail(f"{name} runtime missing")
        pytest.skip(f"{name} runtime missing")

    if name == "Node.js":
        command = [executable, "--input-type=module", "-e", NODE_DRIVER]
    else:
        shutil.copy(ROOT / "examples/http_monitor.go", tmp_path)
        shutil.copy(FIXTURE, tmp_path)
        binary = tmp_path / "go-contract"
        subprocess.run(  # noqa: S603
            [executable, "test", "-c", "-o", str(binary), "http_monitor.go", FIXTURE.name],
            cwd=tmp_path,
            check=True,
            capture_output=True,
            timeout=60,
        )
        command = [str(binary), "-test.run=^TestContractRequest$"]

    def send(endpoint, secret, method, path, payload=None, session=None):
        result = subprocess.run(  # noqa: S603
            command,
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=12,
            env={
                **os.environ,
                "QB_ENDPOINT": endpoint,
                "QB_TOKEN": secret,
                "QB_METHOD": method,
                "QB_PATH": path,
                "QB_SESSION": session or "",
            },
            input=json.dumps(payload) if payload is not None else "",
        )
        if result.returncode:
            for line in (result.stderr + result.stdout).splitlines():
                try:
                    category = json.loads(line.strip())["error_class"]
                except (ValueError, KeyError, TypeError):
                    continue
                if category in {"state_conflict", "network", "dns", "timeout"}:
                    raise TransportFailure(category)
            if "network" in (result.stderr + result.stdout).split():
                raise TransportFailure("network")
            raise TransportFailure("Unexpected transport error")
        return json.loads(result.stdout.splitlines()[0])

    return name, send


def test_standard_http_control_contract(tmp_path, transport):
    language, send = transport
    password = "paper-contract-fixture-password"
    origin = f"http://127.0.0.1:{unused_port()}"
    endpoint = origin + "/api/agent"
    env = {key: value for key, value in os.environ.items() if not key.startswith("QB_")}
    env["QB_ADMIN_PASSWORD"] = password
    args = [
        sys.executable,
        "-m",
        "quantbot",
        "--data-dir",
        str(tmp_path / "server"),
        "serve",
        "--port",
        origin.rsplit(":", 1)[1],
    ]

    def start():
        return subprocess.Popen(  # noqa: S603
            args, cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )

    with httpx.Client(base_url=origin, timeout=2, trust_env=False) as admin:
        service = start()
        try:
            eventually(lambda: admin.get("/healthz").is_success)
            assert admin.post(
                ADMIN + "/login", json={"username": "admin", "password": password}
            ).is_success
            created = admin.post(
                ADMIN + "/strategies", json={"name": language, "mode": "paper"}
            ).json()
            assert created["strategy"]["mode"] == "paper"
            secret = created["credential"]["token"]
            sid = created["strategy"]["id"]
            strategy = f"{ADMIN}/strategies/{sid}"
            session = None
            state_path = tmp_path / "entry-state.json"

            def api(method, path, data=None):
                return send(endpoint, secret, method, path, data, session)

            def connect():
                return api(
                    "POST",
                    "/session",
                    {
                        "instance_id": "contract",
                        "language": language,
                        "executor": True,
                        "capabilities": [
                            {"id": "pause_entry", "label": "Pause entries"},
                            {"id": "resume_entry", "label": "Resume entries"},
                            {"id": "refresh", "label": "Refresh simulated cache"},
                        ],
                    },
                )

            def report():
                return api(
                    "POST",
                    "/reports",
                    {
                        "records": [
                            {
                                "schema_version": 1,
                                "type": "status",
                                "observed_at": datetime.now(timezone.utc).isoformat(),
                                "runtime": {"health": "healthy"},
                            }
                        ]
                    },
                )

            def sync(expected):
                desired = api("GET", "/control")["desired"]
                assert desired.get("entry_enabled", True) is expected
                state = {
                    "entry_enabled": expected,
                    "revision": desired["revision"],
                    "risk_locked": True,
                    "disconnect_policy_applied": "continue",
                }
                state_path.write_text(json.dumps(state))
                assert api("PUT", "/control/reported", state)["in_sync"]

            def issue(action):
                result = admin.post(
                    strategy + "/commands",
                    json={
                        "action": action,
                        "request_id": uuid4().hex,
                    },
                )
                assert result.status_code == 201, result.text
                return result.json()["id"]

            connected = connect()
            assert connected["executor"] and connected["mode"] == "paper"
            session = connected["session_id"]
            assert api("PUT", "/heartbeat", {})["scopes"]
            assert report()["inserted"] == 1
            registry = {
                "schema_version": 1,
                "revision": 1,
                "groups": [],
                "controls": [
                    {
                        "id": "readonly_phase",
                        "label": "Phase",
                        "type": "readonly",
                        "value_type": "text",
                    },
                ],
            }
            assert api("PUT", "/controls", registry)["controls"][0]["type"] == "readonly"
            controls = api(
                "PUT",
                "/controls/state",
                {
                    "revision": 1,
                    "observed_at": datetime.now(timezone.utc).isoformat(),
                    "values": {"readonly_phase": "paper"},
                },
            )
            assert controls["states"]["readonly_phase"]["value"] == "paper"

            pause = issue("pause_entry")
            sync(False)
            assert admin.get(f"{ADMIN}/commands/{pause}").json()["state"] == "succeeded"
            refresh = issue("refresh")
            assert api("GET", "/commands")["commands"][0]["id"] == refresh
            claim = f"/commands/{refresh}/claim"
            permit = api("POST", claim)["permit"]
            with pytest.raises((TransportFailure, RequestFailure), match="state_conflict"):
                api("POST", claim)
            runs = 1
            receipt = {"status": "succeeded", "permit": permit, "result": {"simulated_runs": runs}}
            result = f"/commands/{refresh}/result"
            assert api("POST", result, receipt)["state"] == "succeeded"
            assert api("POST", result, receipt)["result"]["simulated_runs"] == 1
            assert api("GET", "/commands")["commands"] == []

            stop(service)
            with pytest.raises((TransportFailure, RequestFailure), match="network"):
                report()
            assert not json.loads(state_path.read_text())["entry_enabled"]
            service = start()
            eventually(lambda: admin.get("/healthz").is_success)
            session = connect()["session_id"]
            sync(False)
            assert report()["inserted"] == 1
            assert api("GET", "/commands")["commands"] == []
            resume = issue("resume_entry")
            sync(True)
            assert admin.get(f"{ADMIN}/commands/{resume}").json()["state"] == "succeeded"
            assert admin.get(strategy).json()["control"]["effective_entry_enabled"] is False
        finally:
            stop(service)
