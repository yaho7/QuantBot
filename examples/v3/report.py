"""Exercise the declarative Agent API against a dedicated paper strategy."""

import json
import os
import time
import urllib.request
import urllib.error
import random
import uuid
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    endpoint = os.environ["QB_AGENT_URL"].rstrip("/")
    token = os.environ["QB_AGENT_TOKEN"]
    instance = os.getenv("QB_INSTANCE_ID", "python-example")
    control = os.getenv("QB_DEMO_CONTROL") == "1"
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
    session = call("POST", "/session", token, identity)

    def renew():
        nonlocal session
        for attempt in range(6):
            try:
                session = call("POST", "/session", token, identity)
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

    for _ in range(120):
        if agent("PUT", "/heartbeat")["executor"]:
            break
        time.sleep(1)
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
    next_heartbeat = time.monotonic() + 15
    for _ in range(40):
        if time.monotonic() >= next_heartbeat:
            agent("PUT", "/heartbeat")
            next_heartbeat = time.monotonic() + 15
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
