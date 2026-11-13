"""Runnable HTTP-only paper strategy example. No broker connections or orders."""

import argparse
import fcntl
import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

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
    def __init__(self, url, token, instance, db, control):
        parsed = urlsplit(url)
        if parsed.scheme != "https" and not (
            parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        ):
            raise SystemExit("Use HTTPS outside localhost")
        if (
            parsed.username
            or parsed.password
            or parsed.path not in {"", "/"}
            or (parsed.query or parsed.fragment or not parsed.hostname)
        ):
            raise SystemExit("QB_URL must be the HTTP or HTTPS origin")
        self.url = url.rstrip("/") + "/api/agent"
        self.opener = build_opener(NoRedirect)
        self.headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        self.instance = instance
        self.db = db
        self.control = control
        self.started = time.monotonic()
        self.last_contact = None
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

    def http(self, method, path, payload=None, timeout=12):
        body = None if payload is None else json.dumps(payload).encode()
        request = Request(  # noqa: S310 - constructor restricts the origin and redirects
            self.url + path, data=body, headers=self.headers, method=method
        )
        with self.opener.open(request, timeout=timeout) as response:
            data = json.load(response)
        self.last_contact = time.monotonic()
        return data

    def connect(self):
        session = self.http(
            "POST",
            "/session",
            {
                "instance_id": self.instance,
                "executor": self.control,
                "capabilities": CONTROL_CAPABILITIES if self.control else [],
                "language": "Python",
                "version": "http-example-1",
            },
        )
        if session["mode"] == "live":
            raise SystemExit("The simulated example requires a paper or backtest strategy")
        if self.control and not session["executor"]:
            raise SystemExit("This example instance is not the authorized executor")
        self.headers["X-Agent-Session"] = session["session_id"]
        if self.control:
            self.http("PUT", "/controls", REGISTRY)
            self.sync(session["control"]["desired"])

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
        self.http(
            "PUT",
            "/control/reported",
            {
                "revision": desired["revision"],
                "entry_enabled": self.value("entry_enabled", True),
                "risk_locked": self.value("risk_locked", False),
                "disconnect_policy_applied": self.value("disconnect_policy", "continue"),
            },
        )

    def local_entry_allowed(self):
        policy = self.value("disconnect_policy", "block_entry")
        offline = self.last_contact is None or time.monotonic() - self.last_contact >= 50
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
        while rows := self.db.execute(
            "SELECT id, report FROM outbox ORDER BY id LIMIT 200"
        ).fetchall():
            self.http("POST", "/reports", {"records": [json.loads(row[1]) for row in rows]})
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
            try:
                self.http(
                    "POST", f"/commands/{cid}/result", {**json.loads(receipt), "permit": permit}
                )
            except HTTPError as exc:
                if exc.code != 409:
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
        permit = self.http("POST", f"/commands/{cid}/claim")
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
        if "X-Agent-Session" not in self.headers:
            self.connect()
        heartbeat = self.http("PUT", "/heartbeat", {"health": "healthy"})
        self.flush()
        if self.control:
            desired = heartbeat["control"]["desired"]
            self.sync(desired)
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
            poll = urlencode({"wait": 8 if follow else 0, "revision": desired["revision"]})
            batch = self.http("GET", "/commands?" + poll, timeout=20)
            for item in batch["commands"]:
                self.execute(item)
            self.send_receipts()


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
            demo = Demo(
                os.environ["QB_URL"],
                os.environ["QB_TOKEN"],
                os.environ.get("QB_INSTANCE_ID", "python-http-example"),
                db,
                args.control,
            )
            delay = 1
            while True:
                demo.collect()
                try:
                    demo.tick(args.follow)
                except HTTPError as exc:
                    if exc.code == 401 or not args.follow:
                        raise SystemExit(f"QuantBot returned HTTP {exc.code}") from None
                    if exc.code == 409:
                        demo.headers.pop("X-Agent-Session", None)
                    time.sleep(delay)
                    delay = min(delay * 2, 15)
                except (OSError, HTTPException, json.JSONDecodeError):
                    if not args.follow:
                        raise SystemExit(
                            "QuantBot connection failed; local reports were retained"
                        ) from None
                    demo.headers.pop("X-Agent-Session", None)
                    time.sleep(delay)
                    delay = min(delay * 2, 15)
                else:
                    if not args.follow:
                        return
                    delay = 1
                    if not args.control:
                        time.sleep(10)


if __name__ == "__main__":
    run()
