"""Exercise the declarative Agent API against a dedicated paper strategy."""

import argparse
import json
import re
import time
import urllib.parse
import urllib.request
import urllib.error
import random
import uuid
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def load_config():
    try:
        config = json.loads(Path("quantbot.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise SystemExit("Create a valid local quantbot.json using quantbot.example.json") from None
    if not isinstance(config, dict):
        raise SystemExit("quantbot.json must contain a JSON object")
    raw = config.get("endpoint")
    try:
        url = urllib.parse.urlsplit(raw if isinstance(raw, str) else "")
        host = url.hostname
        path = url.path.rstrip("/") or "/api/agent"
        secure = url.scheme == "https" or url.scheme == "http" and host in ("localhost", "127.0.0.1", "::1")
        if not (secure and host and not re.search(r"[\s?#\\]", raw) and not url.username and url.password is None
                and "@" not in url.netloc and re.fullmatch(r"/api/agent(?:/sandbox/[A-Za-z0-9_-]+)?", path)):
            raise ValueError()
    except (ValueError, TypeError):
        raise SystemExit("Set endpoint to a QuantBot HTTPS URL or local loopback URL in quantbot.json") from None
    secret, instance = config.get("secret"), config.get("instance_name")
    heartbeat = config.get("heartbeat_seconds", 15)
    if not isinstance(secret, str) or not re.fullmatch(r"qbt_[A-Za-z0-9_-]+", secret):
        raise SystemExit("Paste the Agent Token into secret in quantbot.json")
    if not isinstance(instance, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,95}", instance):
        raise SystemExit("Set a stable instance_name in quantbot.json")
    if type(heartbeat) is not int or not 1 <= heartbeat <= 15:
        raise SystemExit("heartbeat_seconds must be an integer from 1 to 15")
    if config.get("disconnect_policy", "continue") != "continue":
        raise SystemExit("The demo supports only disconnect_policy 'continue'")
    if not isinstance(config.get("strategy_id", ""), str):
        raise SystemExit("strategy_id must be a string")
    return config, f"{url.scheme}://{url.netloc}{path}", secret, instance, heartbeat


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo-control", action="store_true", help="wait for a simulated Refresh demo state command")
    control = parser.parse_args().demo_control
    config, endpoint, token, instance, heartbeat = load_config()
    boot = uuid.uuid4().hex
    opener = urllib.request.build_opener(NoRedirect())

    def call(method, path, bearer, payload=None, key=None):
        headers = {"Authorization": "Bearer " + bearer}
        if key:
            headers["Idempotency-Key"] = key
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload).encode()
        request = urllib.request.Request(endpoint + path, body, headers, method=method)
        with opener.open(request, timeout=8) as response:
            return json.load(response)

    identity = {"instanceId": instance, "bootId": boot}

    def connect():
        result = call("POST", "/session", token, identity)
        if config.get("strategy_id") and result["strategyId"] != config["strategy_id"]:
            raise SystemExit("Session strategy does not match strategy_id in quantbot.json")
        return result

    session = connect()

    def renew():
        nonlocal session
        for attempt in range(6):
            try:
                session = connect()
                print("session renewed", flush=True)
                return
            except urllib.error.HTTPError as error:
                if error.code != 429 and error.code < 500:
                    raise RuntimeError(json.load(error)["code"]) from None
            except (urllib.error.URLError, TimeoutError):
                pass
            time.sleep(min(2**attempt, 15) + random.random())
        raise RuntimeError("Session renewal unavailable")

    def agent(method, path, payload=None, key=None):
        if session["renewAt"] is not None and time.time() >= session["renewAt"]:
            renew()
        try:
            return call(method, path, session["session"], payload, key)
        except urllib.error.HTTPError as error:
            code = json.load(error)["code"]
            if code != "session_expired":
                raise RuntimeError(code) from None
            renew()
            return call(method, path, session["session"], payload, key)
    capabilities = json.loads(Path(__file__).with_name("capabilities.json").read_text())

    for _ in range(1 + 120 // heartbeat):
        if agent("PUT", "/heartbeat")["executor"]:
            break
        time.sleep(heartbeat)
    else:
        raise SystemExit(f"Assign {instance} as the paper executor")
    if control:
        capabilities.append({
            "id": "demo-refresh", "kind": "action", "title": "Refresh demo state",
            "value_type": "null", "writable": True, "timeout_seconds": 30,
            "presentation": {"suggested": True, "surface": ["strategy"]},
        })

    revision = agent("PUT", "/capabilities", {
        "revision": session["revision"], "capabilities": capabilities,
    })["revision"]

    def send_state(at):
        states = [{"id": "broker", "value": True, "observedAt": at}]
        if control:
            states.append({"id": "demo-refresh", "value": None, "observedAt": at})
        return agent("PUT", "/state", {"revision": revision, "states": states})

    at = time.time_ns() // 1_000_000
    print(send_state(at), flush=True)
    for path, capability, value in [
        ("/reports", "poll-latency", "2.50"),
        ("/events", "sample-event", {"message": "Paper demo started"}),
    ]:
        record = {
            "id": boot + "-" + capability, "capabilityId": capability,
            "observedAt": at, "value": value, "associations": {"correlation_id": boot},
        }
        print(agent("POST", path, {"revision": revision, "records": [record]}), flush=True)

    if not control:
        return
    next_heartbeat = time.monotonic() + heartbeat
    for _ in range(40):
        if time.monotonic() >= next_heartbeat:
            agent("PUT", "/heartbeat")
            next_heartbeat = time.monotonic() + heartbeat
        commands = agent("GET", "/commands?wait=2")
        offer = next((item for item in commands if item["controlId"] == "demo-refresh"), None)
        if offer is None:
            time.sleep(0.5)
            continue
        path = "/commands/" + offer["id"]
        # A failed or lost claim provides no execution permission.
        claim_key = "claim-" + offer["id"]
        try:
            grant = agent("POST", path + "/claim", key=claim_key)
        except (urllib.error.URLError, TimeoutError):
            grant = agent("POST", path + "/claim", key=claim_key)
        now = time.time_ns() // 1_000_000
        if grant["command"] != "demo-refresh" or not grant["permit"] or grant["deadline"] <= now:
            raise SystemExit("Invalid or expired grant")
        send_state(now)
        receipt = {"permit": grant["permit"], "status": "succeeded", "message": "Refreshed demo state"}
        agent("POST", path + "/result", receipt)
        print(agent("POST", path + "/result", receipt)["status"])
        return
    raise SystemExit("Queue the Refresh demo state command on the paper strategy")


if __name__ == "__main__":
    main()
