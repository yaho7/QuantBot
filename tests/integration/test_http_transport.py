"""Exercise the public example against real HTTP responses at the network boundary."""

import json
import sqlite3
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest
from examples.http_agent import Demo, RequestFailure, normalize_endpoint, wait_after_failure

SECRET = "fixture-secret-never-log"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (" https://bot.example:8443/api/agent/ ", "https://bot.example:8443/api/agent"),
        ("http://[::1]:8888/api/agent", "http://[::1]:8888/api/agent"),
        ("http://localhost/api/agent", "http://localhost/api/agent"),
    ],
)
def test_endpoint_preserves_scheme_and_port(value, expected):
    assert normalize_endpoint(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "https://bot.example",
        "https://bot.example/api/agent/api/agent",
        "https://bot.example:bad/api/agent",
        "https://bot.example:65536/api/agent",
        "https://bot.example:/api/agent",
        "https://user:secret@bot.example/api/agent",
        "https://bot.example/api/agent?",
        "https://bot.example/api/agent#",
        "https://bot.example/other/../api/agent",
        "https://bot.example\\/api/agent",
        "https://bot.example\n/api/agent",
        "http://bot.example/api/agent",
    ],
)
def test_endpoint_rejects_credentials_paths_and_insecure_remote_http(value):
    with pytest.raises(ValueError, match="Endpoint must be"):
        normalize_endpoint(value)


def test_proxy_failures_and_headers_are_safe():
    requests = []
    request_id = "a" * 32
    upstream = [
        (
            403,
            {"Content-Type": "text/html", "CF-Ray": "abcdef0123456789-SEA"},
            f"<h1>Error 1010</h1>echo={SECRET}",
        ),
        (403, {"Content-Type": "text/html"}, f"<h1>Blocked</h1>echo={SECRET}"),
        (
            403,
            {"Content-Type": "application/json", "X-QuantBot-Request-ID": request_id},
            '{"detail":"Token lacks the required scope"}',
        ),
        (
            401,
            {"Content-Type": "application/json", "X-QuantBot-Request-ID": request_id},
            json.dumps({"detail": SECRET}),
        ),
        (
            429,
            {"Retry-After": "31", "Content-Type": "application/json"},
            '{"detail":"Rate limit exceeded"}',
        ),
        (302, {"Location": "http://localhost:1/collect"}, ""),
        (
            422,
            {"Content-Type": "application/json", "X-QuantBot-Request-ID": request_id},
            json.dumps({"errors": [{"location": ["body", "records", 0, "observed_at"]}]}),
        ),
        (200, {"Content-Type": "text/html"}, f"<h1>Login</h1>echo={SECRET}"),
        (200, {"Content-Type": "application/json"}, '{"wrong":"shape"}'),
        (200, {"Content-Type": "application/json"}, '{"inserted":1}'),
    ]

    class Proxy(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            requests.append((self.path, dict(self.headers.items())))
            status, headers, body = upstream.pop(0)
            self.send_response(status)
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body.encode())

    with ThreadingHTTPServer(("127.0.0.1", 0), Proxy) as server:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with closing(sqlite3.connect(":memory:")) as db:
                client = Demo(
                    f"http://127.0.0.1:{server.server_port}/api/agent", SECRET, "test", db, False
                )
                expected = [
                    ("cloudflare_1010", 403),
                    ("upstream_http_error", 403),
                    ("permission_denied", 403),
                    ("authentication_failed", 401),
                    ("rate_limited", 429),
                    ("redirect_rejected", 302),
                    ("schema_mismatch", 422),
                    ("invalid_response", 200),
                    ("invalid_response", 200),
                ]
                for category, status in expected:
                    with pytest.raises(RequestFailure) as failure:
                        client.http(
                            "POST",
                            "/monitor/test?debug=private",
                            validate=lambda data: data["inserted"] == 1,
                        )
                    result = failure.value
                    diagnostic = json.loads(str(result))
                    assert diagnostic["error_class"] == category
                    assert diagnostic["http"] == status
                    assert diagnostic["path"] == "/monitor/test"
                    assert SECRET not in str(result)
                    assert "private" not in str(result)
                    if category == "rate_limited":
                        assert wait_after_failure(result, 9) == 31
                    if category == "permission_denied":
                        assert diagnostic["detail"] == "Token lacks the required scope"
                        assert diagnostic["request_id"] == request_id
                    if category == "schema_mismatch":
                        assert diagnostic["detail"] == "Invalid fields: body.records.0.observed_at"
                assert client.http("POST", "/monitor/test") == {"inserted": 1}
        finally:
            server.shutdown()
            worker.join()
    assert not upstream
    assert all(path.startswith("/api/agent/monitor/test") for path, _ in requests)
    assert all(headers["User-Agent"] == "QuantBot-Integration/1.0" for _, headers in requests)
    assert all(headers["Accept"] == "application/json" for _, headers in requests)
    assert all(headers["Content-Type"] == "application/json" for _, headers in requests)
