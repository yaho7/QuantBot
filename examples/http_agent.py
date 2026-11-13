"""Runnable HTTP-only paper strategy example. No broker connections or orders."""

import argparse
import fcntl
import json
import math
import os
import random
import re
import socket
import sqlite3
import ssl
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

USER_AGENT = "QuantBot-Integration/1.0"
RESPONSE_LIMIT = 2 * 1024 * 1024
ERROR_TYPES = {
    400: "invalid_json",
    401: "authentication_failed",
    403: "permission_denied",
    404: "resource_not_found",
    409: "state_conflict",
    413: "batch_too_large",
    415: "unsupported_content_type",
    421: "public_host_mismatch",
    422: "schema_mismatch",
    426: "https_required",
    429: "rate_limited",
}
SAFE_DETAILS = {
    "Invalid strategy credential",
    "Token lacks the required scope",
    "Executor declarations require the control scope",
    "One-time capabilities require the commands scope",
    "This instance is not the authorized executor",
    "The command is assigned to a different session",
    "Establish an agent session first",
    "Agent session ended; reconnect",
    "Instance is already attached to another credential",
    "Synchronize desired and reported controls before claiming",
    "An execution permit is no longer available",
    "Invalid execution permit",
    "A final result has already been recorded",
}


def normalize_endpoint(value):
    value = value.strip()
    try:
        if not value.isascii() or any(c.isspace() or ord(c) < 32 for c in value):
            raise ValueError
        parsed = urlsplit(value)
        _port = parsed.port  # Also validates invalid or out-of-range ports.
        loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if (
            (parsed.scheme != "https" and not (parsed.scheme == "http" and loopback))
            or not parsed.hostname
            or not re.fullmatch(r"(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::[0-9]+)?", parsed.netloc)
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"/api/agent", "/api/agent/"}
            or any(char in value for char in "?#\\")
        ):
            raise ValueError
    except ValueError:
        raise ValueError(
            "Endpoint must be https://host[:port]/api/agent; HTTP is allowed only on loopback"
        ) from None
    return f"{parsed.scheme}://{parsed.netloc}/api/agent"


def retry_after(value):
    if not value:
        return None
    try:
        if value.isascii() and value.isdigit():
            delay = float(value)
        else:
            delay = (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
        return max(0, delay) if math.isfinite(delay) else None
    except (TypeError, ValueError, OverflowError):
        return None


class RequestFailure(Exception):
    def __init__(self, category, method, path, *, headers=None, status=None, detail=None):
        self.category = category
        self.status = status
        self.detail = detail
        headers = headers or {}
        self.retry_after = retry_after(headers.get("Retry-After"))
        content_type = headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        request_id = headers.get("X-QuantBot-Request-ID", "")
        cf_ray = headers.get("CF-Ray", "")
        diagnostic = {
            "runtime": f"Python {sys.version_info.major}.{sys.version_info.minor}",
            "method": method,
            "path": path.split("?", 1)[0],
            "http": status,
            "response_type": content_type
            if re.fullmatch(r"[a-z0-9.+/-]{1,64}", content_type)
            else None,
            "error_class": category,
            "request_id": request_id if re.fullmatch(r"[0-9a-f]{32}", request_id) else None,
            "cf_ray": cf_ray if re.fullmatch(r"[0-9a-f]{16}(?:-[A-Z]{3})?", cf_ray) else None,
            "upstream_code": 1010 if category == "cloudflare_1010" else None,
            "detail": detail,
        }
        super().__init__(json.dumps({k: v for k, v in diagnostic.items() if v is not None}))

    @property
    def retryable(self):
        return self.category in {"network", "timeout", "dns", "gateway_unavailable", "rate_limited"}

    @property
    def session_ended(self):
        return self.detail in {"Establish an agent session first", "Agent session ended; reconnect"}


def http_failure(exc, method, path, secret):
    with exc:
        try:
            body = exc.read(16384)
        except (OSError, HTTPException):
            body = b""
    content_type = exc.headers.get_content_type()
    request_id = exc.headers.get("X-QuantBot-Request-ID", "")
    detail = None
    if 300 <= exc.code < 400:
        category = "redirect_rejected"
    elif exc.code == 429:
        category = "rate_limited"
    elif exc.code >= 500:
        category = "gateway_unavailable"
    elif content_type == "application/json" and re.fullmatch(r"[0-9a-f]{32}", request_id):
        category = ERROR_TYPES.get(exc.code, "quantbot_error")
        try:
            data = json.loads(body)
        except (ValueError, RecursionError):
            data = None
        if isinstance(data, dict):
            raw = data.get("detail")
            if isinstance(raw, str) and raw in SAFE_DETAILS:
                detail = raw
            errors = data.get("errors")
            if exc.code == 422 and isinstance(errors, list):
                fields = []
                for error in errors[:3]:
                    loc = error.get("location") if isinstance(error, dict) else None
                    if isinstance(loc, list) and all(
                        type(part) is int
                        or (
                            isinstance(part, str)
                            and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,39}", part)
                        )
                        for part in loc[:12]
                    ):
                        fields.append(".".join(map(str, loc[:12])))
                if fields:
                    detail = "Invalid fields: " + ", ".join(fields)
    elif exc.code == 403 and (
        exc.headers.get("CF-Error-Code") == "1010"
        or (exc.headers.get("CF-Ray") and re.search(rb"\b1010\b", body))
        or re.search(rb"(?:error(?:\s+code)?:?\s*1010)\b", body, re.IGNORECASE)
    ):
        category = "cloudflare_1010"
        detail = "Check the API path in the upstream security policy"
    else:
        category = "upstream_http_error"
    if detail and secret in detail:
        detail = None
    return RequestFailure(
        category, method, path, headers=exc.headers, status=exc.code, detail=detail
    )


def network_failure(exc, method, path):
    reason = exc.reason if isinstance(exc, URLError) else exc
    if isinstance(reason, ssl.SSLError):
        category = "tls"
    elif isinstance(reason, socket.gaierror):
        category = "dns"
    elif isinstance(reason, TimeoutError):
        category = "timeout"
    else:
        category = "network"
    return RequestFailure(category, method, path)


CONTROL_CAPABILITIES = [
    {"id": "pause_entry", "label": "暂停新开仓"},
    {"id": "resume_entry", "label": "恢复新开仓"},
    {"id": "refresh", "label": "刷新行情"},
    {
        "id": "set_rsi",
        "label": "设置 RSI 周期",
        "parameters": {"period": {"type": "integer", "label": "周期", "required": True}},
    },
    {
        "id": "set_mode",
        "label": "切换模式",
        "parameters": {
            "mode": {
                "type": "choice",
                "label": "模式",
                "choices": ["conservative", "balanced", "aggressive"],
            }
        },
    },
    {
        "id": "set_risk",
        "label": "设置模拟风险比例",
        "parameters": {"ratio": {"type": "decimal", "label": "比例", "required": True}},
    },
    {"id": "flatten", "label": "模拟全部平仓"},
]
REGISTRY = {
    "schema_version": 1,
    "revision": 1,
    "groups": [{"id": "parameters", "label": "策略参数", "order": 1}],
    "controls": [
        {"id": "refresh_market", "type": "button", "label": "刷新行情", "command": "refresh"},
        {
            "id": "trading_enabled",
            "type": "toggle",
            "label": "允许新开仓",
            "command": "set_trading_enabled",
        },
        {
            "id": "trading_mode",
            "type": "select",
            "label": "交易模式",
            "command": "set_mode",
            "group": "parameters",
            "options": [
                {"label": "保守", "value": "conservative"},
                {"label": "均衡", "value": "balanced"},
                {"label": "激进", "value": "aggressive"},
            ],
        },
        {
            "id": "rsi_period",
            "type": "number",
            "label": "RSI 周期",
            "command": "set_rsi",
            "group": "parameters",
            "min": 5,
            "max": 30,
            "step": 1,
            "integer": True,
        },
        {
            "id": "max_risk",
            "type": "slider",
            "label": "最大模拟风险",
            "command": "set_risk",
            "group": "parameters",
            "min": "0.5",
            "max": "5",
            "step": "0.5",
            "unit": "%",
        },
        {"id": "close_positions", "type": "button", "label": "模拟全部平仓", "command": "flatten"},
    ],
}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Demo:
    def __init__(self, endpoint, secret, instance, db, control):
        self.url = normalize_endpoint(endpoint)
        if not re.fullmatch(r"[!-~]{1,256}", secret):
            raise ValueError("Set QB_TOKEN to the strategy Secret")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,55}", instance):
            raise ValueError("Choose a stable instance name of up to 56 letters, digits or ._-")
        self.secret = secret
        self.opener = build_opener(NoRedirect)
        self.headers = {
            "Authorization": f"Bearer {secret}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        self.instance = instance
        self.db = db
        self.control = control
        self.started = time.monotonic()
        self.last_contact = None
        self.last_control = None
        self.offline_after = 50
        self.executor = False
        self.scopes = set()
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS local_state (name TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, report TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS execution (
                id TEXT PRIMARY KEY, permit TEXT, phase TEXT NOT NULL, receipt TEXT
            );
        """)
        with self.db:
            # A process interrupted after receiving a permit must never replay the operation.
            self.db.execute(
                """UPDATE execution SET phase='result', receipt=?
                   WHERE phase='executing' AND permit IS NOT NULL""",
                (json.dumps({"status": "unknown", "error": "Interrupted after claim"}),),
            )

    def http(self, method, path, payload=None, timeout=10, validate=None):
        body = None if payload is None else json.dumps(payload).encode()
        request = Request(  # noqa: S310 - constructor restricts the origin and redirects
            self.url + path, data=body, headers=self.headers, method=method
        )
        try:
            with self.opener.open(request, timeout=timeout) as response:
                headers = response.headers
                try:
                    if headers.get_content_type() != "application/json":
                        raise ValueError
                    raw = response.read(RESPONSE_LIMIT + 1)
                    if len(raw) > RESPONSE_LIMIT:
                        raise ValueError
                    data = json.loads(raw)
                    if not isinstance(data, dict) or (validate and not validate(data)):
                        raise ValueError
                except (ValueError, KeyError, TypeError, RecursionError):
                    raise RequestFailure(
                        "invalid_response", method, path, status=response.status, headers=headers
                    ) from None
        except HTTPError as exc:
            raise http_failure(exc, method, path, self.secret) from None
        except (OSError, HTTPException) as exc:
            raise network_failure(exc, method, path) from None
        self.last_contact = time.monotonic()
        return data

    def connect(self, requested_scopes=None):
        scopes = {"control", "commands"} if requested_scopes is None else requested_scopes
        capabilities = [
            item
            for item in CONTROL_CAPABILITIES
            if "commands" in scopes or item["id"] in {"pause_entry", "resume_entry"}
        ]
        executor = "control" in scopes
        try:
            session = self.http(
                "POST",
                "/session",
                {
                    "instance_id": self.instance,
                    "executor": executor,
                    "capabilities": capabilities if executor else [],
                    "language": "Python",
                    "version": "http-example-1",
                },
                validate=lambda data: (
                    isinstance(data["session_id"], str)
                    and isinstance(data["strategy_id"], str)
                    and data["mode"] in {"paper", "backtest", "live"}
                    and type(data["executor"]) is bool
                    and type(data["heartbeat_interval_seconds"]) is int
                    and 0 < data["heartbeat_interval_seconds"] <= 60
                    and type(data["offline_after_seconds"]) is int
                    and data["offline_after_seconds"] > data["heartbeat_interval_seconds"]
                    and valid_control(data["control"])
                    and valid_scopes(data["scopes"])
                ),
            )
        except RequestFailure as exc:
            if requested_scopes is None and exc.category == "permission_denied":
                # Discover restricted scopes via a monitoring session using the same instance ID.
                self.connect(set())
                return
            raise
        if session["mode"] == "live":
            raise SystemExit("The simulated control example requires a paper or backtest strategy")
        bound = self.value("strategy_id", None)
        if bound is not None and bound != session["strategy_id"]:
            raise SystemExit("Use a separate --state file for each strategy")
        with self.db:
            self.save("strategy_id", session["strategy_id"])
        self.headers["X-Agent-Session"] = session["session_id"]
        self.heartbeat_interval = session["heartbeat_interval_seconds"]
        self.offline_after = session["offline_after_seconds"]
        self.scopes = set(session["scopes"])
        if not executor and "control" in self.scopes:
            self.connect(self.scopes)
            return
        self.executor = session["executor"]
        if self.executor:
            self.sync(session["control"]["desired"])
            if "commands" in self.scopes:
                self.http("PUT", "/controls", REGISTRY)

    def value(self, name, default):
        row = self.db.execute("SELECT value FROM local_state WHERE name=?", (name,)).fetchone()
        return json.loads(row[0]) if row else default

    def save(self, name, value):
        self.db.execute(
            "INSERT OR REPLACE INTO local_state VALUES (?, ?)", (name, json.dumps(value))
        )

    def sync(self, desired):
        # An existing integration applies these values in its own entry gate before acknowledging.
        with self.db:
            if "entry_enabled" in desired:
                self.save("entry_enabled", desired["entry_enabled"])
            self.save("disconnect_policy", desired["disconnect_policy"])
            self.save("applied_revision", desired["revision"])
        self.http(
            "PUT",
            "/control/reported",
            {
                "revision": desired["revision"],
                "entry_enabled": self.value("entry_enabled", True),
                "risk_locked": self.value("risk_locked", False),
                "disconnect_policy_applied": self.value("disconnect_policy", "continue"),
            },
            validate=valid_control,
        )
        self.last_control = time.monotonic()

    def local_entry_allowed(self):
        policy = self.value("disconnect_policy", "block_entry")
        last_seen = self.last_control if self.control else self.last_contact
        offline = last_seen is None or time.monotonic() - last_seen >= self.offline_after
        return (
            self.value("entry_enabled", True)
            and not self.value("risk_locked", False)
            and not (offline and policy == "block_entry")
        )

    def collect(self):
        data = {"schema_version": 1, "observed_at": utc_now()}
        records = [
            {
                **data,
                "type": "status",
                "runtime": {
                    "health": "healthy",
                    "uptime_seconds": int(time.monotonic() - self.started),
                },
            },
            {
                **data,
                "type": "metric",
                "name": "example.rsi",
                "value": "56.25",
                "label": "示例 RSI",
                "unit": "index",
            },
            {
                **data,
                "type": "metric",
                "name": "example.entry_allowed",
                "value": "1" if self.local_entry_allowed() else "0",
                "label": "示例本地开仓权限",
            },
        ]
        with self.db:
            self.db.executemany(
                "INSERT INTO outbox(report) VALUES (?)",
                [(json.dumps(record),) for record in records],
            )
            self.db.execute(
                """DELETE FROM outbox WHERE id IN
                   (SELECT id FROM outbox ORDER BY id DESC LIMIT -1 OFFSET 5000)"""
            )

    def flush(self):
        rows = self.db.execute("SELECT id, report FROM outbox ORDER BY id LIMIT 200").fetchall()
        if rows:
            records = [json.loads(row[1]) for row in rows]
            size = len(records)
            path = "/reports" if self.control else f"/monitor/{self.instance}"
            self.http(
                "POST",
                path,
                {"records": records},
                validate=lambda data, size=size: (
                    all(
                        type(data[key]) is int and data[key] >= 0
                        for key in ("inserted", "ignored", "duplicates")
                    )
                    and data["inserted"] + data["ignored"] + data["duplicates"] == size
                ),
            )
            with self.db:
                self.db.execute("DELETE FROM outbox WHERE id<=?", (rows[-1][0],))

    def receipt(self, cid, result):
        self.db.execute(
            "UPDATE execution SET phase='result', receipt=? WHERE id=?", (json.dumps(result), cid)
        )

    def send_receipts(self):
        for cid, permit, receipt in self.db.execute(
            "SELECT id, permit, receipt FROM execution WHERE phase='result'"
        ).fetchall():
            result = json.loads(receipt)
            expected_state = result["status"]
            try:
                self.http(
                    "POST",
                    f"/commands/{cid}/result",
                    {**result, "permit": permit},
                    validate=lambda data, cid=cid, state=expected_state: (
                        data["id"] == cid and data["state"] == state
                    ),
                )
            except RequestFailure as exc:
                if exc.category != "state_conflict" or exc.session_ended:
                    raise
                # The administrator may already have reconciled it. Keep a local record.
                with self.db:
                    self.db.execute("UPDATE execution SET phase='reconcile' WHERE id=?", (cid,))
            else:
                with self.db:
                    self.db.execute("UPDATE execution SET phase='done' WHERE id=?", (cid,))

    def execute(self, item):
        cid = item["id"]
        with self.db:
            added = self.db.execute(
                "INSERT OR IGNORE INTO execution VALUES (?, NULL, 'claiming', NULL)", (cid,)
            ).rowcount
        if not added:
            return
        start = time.monotonic()
        try:
            permit = self.http(
                "POST",
                f"/commands/{cid}/claim",
                validate=lambda data: (
                    isinstance(data["permit"], str)
                    and valid_timestamp(data["start_before"])
                    and valid_timestamp(data["server_time"])
                ),
            )
        except RequestFailure as exc:
            if exc.category == "state_conflict" and not exc.session_ended:
                # A refused or ambiguous claim never authorizes execution.
                with self.db:
                    self.db.execute("UPDATE execution SET phase='reconcile' WHERE id=?", (cid,))
                return
            raise
        deadline = datetime.fromisoformat(permit["start_before"].replace("Z", "+00:00"))
        server = datetime.fromisoformat(permit["server_time"].replace("Z", "+00:00"))
        with self.db:
            self.db.execute(
                "UPDATE execution SET phase='executing', permit=? WHERE id=?",
                (permit["permit"], cid),
            )
        if time.monotonic() - start >= (deadline - server).total_seconds():
            with self.db:
                self.receipt(cid, {"status": "failed", "error": "Execution permit expired"})
            return
        # These effects are local and simulated. A real integration must enforce its own risk
        # checks and use broker-supported idempotency or reconcile before retrying anything.
        with self.db:
            action = item["action"]
            args = item["arguments"]
            updates = {
                "set_rsi": ("rsi_period", "period"),
                "set_mode": ("trading_mode", "mode"),
                "set_risk": ("max_risk", "ratio"),
            }
            if action in updates:
                name, key = updates[action]
                self.save(name, args[key])
            if action in {*updates, "refresh"}:
                self.receipt(cid, {"status": "succeeded", "result": {"simulated": True}})
            else:
                self.receipt(cid, {"status": "failed", "error": "The sample has no open positions"})

    def tick(self, follow):
        if not self.control:
            self.flush()
            return 15
        if "X-Agent-Session" not in self.headers:
            self.connect()
        heartbeat = self.http(
            "PUT",
            "/heartbeat",
            {"health": "healthy"},
            validate=lambda data: valid_control(data["control"]) and valid_scopes(data["scopes"]),
        )
        scopes = set(heartbeat["scopes"])
        if (scopes ^ self.scopes) & {"control", "commands"}:
            self.connect(scopes)
            return 0
        self.scopes = scopes
        if self.executor:
            self.sync(heartbeat["control"]["desired"])
        else:
            self.last_control = None
        if "telemetry" in scopes:
            self.flush()
        if not self.executor or "commands" not in scopes:
            return self.heartbeat_interval
        self.send_receipts()
        self.http(
            "PUT",
            "/controls/state",
            {
                "revision": REGISTRY["revision"],
                "observed_at": utc_now(),
                "values": {
                    "rsi_period": self.value("rsi_period", 14),
                    "trading_mode": self.value("trading_mode", "conservative"),
                    "max_risk": self.value("max_risk", "2.0"),
                },
                "disabled": {"close_positions": {"disabled": True, "reason": "模拟账户无持仓"}},
            },
        )
        poll = urlencode(
            {
                "wait": max(0, min(self.heartbeat_interval - 2, 25)) if follow else 0,
                "revision": heartbeat["control"]["desired"]["revision"],
            }
        )
        batch = self.http(
            "GET",
            "/commands?" + poll,
            timeout=35,
            validate=lambda data: (
                valid_control(data["control"])
                and isinstance(data["commands"], list)
                and all(
                    isinstance(item, dict)
                    and re.fullmatch(r"[0-9a-f-]{36}", item["id"])
                    and isinstance(item["action"], str)
                    and isinstance(item["arguments"], dict)
                    for item in data["commands"]
                )
            ),
        )
        self.sync(batch["control"]["desired"])
        for item in batch["commands"]:
            self.execute(item)
        self.send_receipts()
        return 0


def valid_scopes(scopes):
    return (
        isinstance(scopes, list)
        and set(scopes)
        <= {
            "session",
            "telemetry",
            "control",
            "commands",
        }
        and "session" in scopes
    )


def valid_timestamp(value):
    return isinstance(value, str) and datetime.fromisoformat(value).utcoffset() is not None


def valid_control(data):
    desired = data["desired"]
    return (
        type(desired["revision"]) is int
        and desired["revision"] >= 0
        and ("entry_enabled" not in desired or type(desired["entry_enabled"]) is bool)
        and desired["disconnect_policy"] in {"continue", "block_entry"}
    )


def wait_after_failure(exc, attempt):
    return max(exc.retry_after or 0, min(15, 2 ** min(attempt, 4)) * random.uniform(0.5, 1))  # noqa: S311


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--control", action="store_true")
    parser.add_argument("--follow", action="store_true")
    parser.add_argument("--state", type=Path, default=Path("data/http-example.sqlite3"))
    args = parser.parse_args()
    args.state.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    args.state.touch(mode=0o600, exist_ok=True)
    lock_path = args.state.with_suffix(".lock")
    lock_path.touch(mode=0o600, exist_ok=True)
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with sqlite3.connect(args.state) as db:
            try:
                demo = Demo(
                    os.environ.get("QB_ENDPOINT", ""),
                    os.environ.get("QB_TOKEN", ""),
                    os.environ.get("QB_INSTANCE_ID", "python-http-example"),
                    db,
                    args.control,
                )
            except ValueError as exc:
                raise SystemExit(str(exc)) from None
            failures = 0
            while True:
                demo.collect()
                try:
                    delay = demo.tick(args.follow)
                except RequestFailure as exc:
                    changed_scope = (
                        demo.control
                        and "X-Agent-Session" in demo.headers
                        and exc.detail
                        in {
                            "Token lacks the required scope",
                            "Executor declarations require the control scope",
                            "One-time capabilities require the commands scope",
                        }
                    )
                    if not args.follow or not (exc.retryable or exc.session_ended or changed_scope):
                        raise SystemExit(str(exc)) from None
                    if exc.session_ended or exc.status is None:
                        demo.headers.pop("X-Agent-Session", None)
                    print(exc, file=sys.stderr, flush=True)
                    time.sleep(wait_after_failure(exc, failures))
                    failures += 1
                else:
                    if not args.follow:
                        return
                    failures = 0
                    if delay:
                        time.sleep(delay)


if __name__ == "__main__":
    run()
