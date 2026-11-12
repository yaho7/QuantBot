"""Temporary HTTP server for the browser acceptance suite."""

import os
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn

from quantbot.v2.api import make_app
from quantbot.v2.auth import password_hash
from quantbot.v2.db import encode


def bootstrap(runtime):
    runtime.db.execute(
        "INSERT INTO settings VALUES ('administrator', ?)",
        (encode({"username": "admin", "password_hash": password_hash("browser-test-password")}),),
    )


if __name__ == "__main__":
    with TemporaryDirectory(prefix="quantbot-browser-") as folder:
        uvicorn.run(
            make_app(Path(folder) / "control.db", bootstrap=bootstrap, telegram_network=False),
            host="127.0.0.1",
            port=int(os.environ.get("QB_BROWSER_PORT", "42356")),
            access_log=False,
        )
