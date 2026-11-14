"""Exercise the declarative Agent API against a dedicated paper strategy."""

import json
import os
import time
import urllib.request
import uuid
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    endpoint = os.environ["QB_AGENT_URL"].rstrip("/")
    token = os.environ["QB_TOKEN"]
    instance = os.getenv("QB_INSTANCE_ID", "python-example")
    control = os.getenv("QB_DEMO_CONTROL") == "1"
    boot = uuid.uuid4().hex
    opener = urllib.request.build_opener(NoRedirect())

    def call(method, path, bearer, payload=None):
        headers = {"Authorization": "Bearer " + bearer}
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload).encode()
        request = urllib.request.Request(endpoint + path, body, headers, method=method)
        with opener.open(request, timeout=8) as response:
            return json.load(response)

    session = call("POST", "/session", token, {"instanceId": instance, "bootId": boot})
    bearer = session["session"]
    capabilities = json.loads(Path(__file__).with_name("capabilities.json").read_text())

    if control:
        for _ in range(120):
            if call("PUT", "/heartbeat", bearer)["executor"]:
                break
            time.sleep(1)
        else:
            raise SystemExit(f"Assign {instance} as the paper executor")
        capabilities.append({
            "id": "demo-refresh", "kind": "action", "title": "Refresh demo state",
            "value_type": "null", "writable": True, "timeout_seconds": 30,
            "presentation": {"suggested": True, "surface": ["strategy"]},
        })
    else:
        call("PUT", "/heartbeat", bearer)

    revision = call("PUT", "/capabilities", bearer, {
        "revision": session["revision"], "capabilities": capabilities,
    })["revision"]

    def send_state(at):
        states = [{"id": "broker", "value": True, "observedAt": at}]
        if control:
            states.append({"id": "demo-refresh", "value": None, "observedAt": at})
        return call("PUT", "/state", bearer, {"revision": revision, "states": states})

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
        print(call("POST", path, bearer, {"revision": revision, "records": [record]}), flush=True)

    if not control:
        return
    for _ in range(32):
        call("PUT", "/heartbeat", bearer)
        commands = call("GET", "/commands?wait=2", bearer)
        offer = next((item for item in commands if item["controlId"] == "demo-refresh"), None)
        if offer is None:
            time.sleep(0.5)
            continue
        path = "/commands/" + offer["id"]
        # A failed or lost claim provides no execution permission.
        grant = call("POST", path + "/claim", bearer)
        now = time.time_ns() // 1_000_000
        if grant["command"] != "demo-refresh" or not grant["permit"] or grant["deadline"] <= now:
            raise SystemExit("Invalid or expired grant")
        send_state(now)
        receipt = {"permit": grant["permit"], "status": "succeeded", "message": "Refreshed demo state"}
        call("POST", path + "/result", bearer, receipt)
        print(call("POST", path + "/result", bearer, receipt)["status"])
        return
    raise SystemExit("Queue the Refresh demo state command on the paper strategy")


if __name__ == "__main__":
    main()
