"""Report the status of a test strategy with the Python standard library."""

import json
import os
import time
import urllib.request
import uuid

endpoint = os.environ["QB_AGENT_URL"].rstrip("/")
token = os.environ["QB_TOKEN"]
instance = os.environ.get("QB_INSTANCE_ID", "python-example")


def call(method, route, bearer, body=None):
    headers = {"Authorization": f"Bearer {bearer}"}
    payload = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body).encode()
    request = urllib.request.Request(
        endpoint + route, method=method, headers=headers, data=payload
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


boot = uuid.uuid4().hex
session = call("POST", "/session", token, {"instanceId": instance, "bootId": boot})["session"]
call("PUT", "/heartbeat", session)
result = call(
    "POST",
    "/reports",
    session,
    {
        "version": 1,
        "records": [
            {
                "id": f"{boot}-status",
                "kind": "status",
                "observedAt": time.time_ns() // 1_000_000,
                "data": {"state": "running"},
            }
        ],
    },
)
print(json.dumps(result))
