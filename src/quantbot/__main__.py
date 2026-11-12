"""Run or maintain the standalone QuantBot API service."""

import argparse
import getpass
import logging
import os
import sqlite3
from pathlib import Path
from urllib.parse import urlsplit

import uvicorn

from quantbot import __version__
from quantbot.v2.api import make_app
from quantbot.v2.auth import password_hash
from quantbot.v2.db import backup_sqlite, encode
from quantbot.v2.errors import Problem
from quantbot.v2.runtime import Runtime, exclusive_database

DEFAULT_DATA = Path.home() / ".local/share/quantbot"


def secret(name):
    filename = os.environ.get(f"{name}_FILE")
    return Path(filename).read_text().strip() if filename else os.environ.get(name)


def public_origin(url):
    if not url:
        return None
    origin = urlsplit(url)
    if (
        origin.scheme != "https"
        or not origin.hostname
        or origin.username
        or origin.password
        or origin.path not in {"", "/"}
        or origin.query
        or origin.fragment
        or any(character.isspace() for character in url)
    ):
        raise ValueError(
            "QB_PUBLIC_URL must be an HTTPS origin, such as https://quantbot.example.com"
        )
    return f"https://{origin.netloc.lower()}"


def configure_admin(service, username, password, *, replace=False):
    username = username.strip()
    if not (1 <= len(username) <= 100 and 12 <= len(password) <= 1024):
        raise ValueError(
            "Administrator username is required and password must have 12–1024 characters"
        )
    with service.db.transaction():
        if replace:
            service.db.execute("DELETE FROM admin_sessions")
            service.db.execute("DELETE FROM login_links")
        verb = "INSERT OR REPLACE" if replace else "INSERT OR IGNORE"
        service.db.execute(
            f"{verb} INTO settings VALUES ('administrator', ?)",  # noqa: S608
            (encode({"username": username, "password_hash": password_hash(password)}),),
        )
        if replace:
            service.strategies.audit("local", "admin.configure")


def serve(args, path):
    origin = public_origin(os.environ.get("QB_PUBLIC_URL"))
    trusted = os.environ.get("QB_TRUST_PROXY", "127.0.0.1,::1")
    if any(item.strip() == "*" for item in trusted.split(",")):
        raise ValueError("QB_TRUST_PROXY must name the proxy addresses or networks")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    for name in ("httpx", "httpcore", "telegram"):
        logging.getLogger(name).setLevel(logging.CRITICAL)

    def bootstrap(service):
        if service.db.one("SELECT 1 FROM settings WHERE name='administrator'"):
            return
        password = secret("QB_ADMIN_PASSWORD")
        if password:
            configure_admin(service, os.environ.get("QB_ADMIN_USERNAME", "admin"), password)
        else:
            logging.getLogger("quantbot").info(
                "No administrator configured. Use quantbot admin or QB_ADMIN_PASSWORD_FILE."
            )

    local_url = f"http://127.0.0.1:{args.port}"
    app = make_app(
        path,
        public_url=origin,
        bootstrap=bootstrap,
        telegram_token=secret("QB_TELEGRAM_TOKEN"),
        local_url=local_url,
    )
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        access_log=False,
        proxy_headers=True,
        forwarded_allow_ips=trusted,
    )


def parser():
    command = argparse.ArgumentParser(prog="quantbot")
    command.add_argument("--version", action="version", version=f"QuantBot {__version__}")
    command.add_argument(
        "--data-dir", type=Path, default=Path(os.environ.get("QB_DATA_DIR", DEFAULT_DATA))
    )
    sub = command.add_subparsers(dest="operation")
    server = sub.add_parser("serve", help="Run the QuantBot HTTP and Telegram service")
    server.add_argument("--host", default=os.environ.get("QB_HOST", "127.0.0.1"))
    server.add_argument("--port", type=int, default=os.environ.get("QB_PORT", "23456"))
    admin = sub.add_parser(
        "admin", help="Set an administrator password while the service is stopped"
    )
    admin.add_argument("--username", default=os.environ.get("QB_ADMIN_USERNAME", "admin"))
    backup = sub.add_parser("backup", help="Create an integrity-checked SQLite backup")
    backup.add_argument("file", type=Path)
    return command


def run():
    command = parser()
    args = command.parse_args()
    path = args.data_dir.expanduser().resolve() / "quantbot-v2.sqlite3"
    try:
        if args.operation == "serve":
            serve(args, path)
        elif args.operation == "admin":
            password = secret("QB_ADMIN_PASSWORD")
            if password is None:
                password = getpass.getpass("New administrator password: ")
                if password != getpass.getpass("Repeat password: "):
                    raise ValueError("Passwords do not match")
            with exclusive_database(path):
                service = Runtime(path)
                try:
                    configure_admin(service, args.username, password, replace=True)
                finally:
                    service.db.close()
            print("Administrator configured")
        elif args.operation == "backup":
            backup_sqlite(path, args.file.expanduser())
            print(f"Backup verified at {args.file}")
        else:
            command.print_help()
        return 0
    except (OSError, RuntimeError, ValueError, sqlite3.Error, Problem) as exc:
        command.exit(1, f"QuantBot: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(run())
