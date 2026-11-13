"""Run or maintain the standalone QuantBot API service."""

import argparse
import getpass
import logging
import os
import sqlite3
from ipaddress import IPv4Address
from pathlib import Path
from urllib.parse import urlsplit

import uvicorn

from quantbot import __version__
from quantbot.core.api import make_app
from quantbot.core.auth import password_hash
from quantbot.core.db import backup_sqlite, encode
from quantbot.core.errors import Problem
from quantbot.core.models import MIN_PASSWORD_LENGTH
from quantbot.core.runtime import Runtime, exclusive_database

DEFAULT_DATA = Path.home() / ".local/share/quantbot"
LOOPBACK_PROXIES = "127.0.0.1,::1"


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
    if not (1 <= len(username) <= 100 and MIN_PASSWORD_LENGTH <= len(password) <= 1024):
        raise ValueError(
            f"Provide a username and a password of {MIN_PASSWORD_LENGTH}–1024 characters"
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


def docker_gateway(routes=Path("/proc/net/route"), interfaces=Path("/sys/class/net")):
    """Find the host gateway of the container's default veth route."""
    try:
        for line in routes.read_text().splitlines()[1:]:
            interface, destination, gateway, flags, *_ = line.split()
            if destination != "00000000" or int(flags, 16) & 3 != 3:
                continue
            link = interfaces / interface
            if (link / "ifindex").read_text() != (link / "iflink").read_text():
                return str(IPv4Address(bytes.fromhex(gateway)[::-1]))
    except (OSError, ValueError):
        pass
    return None


def trusted_proxies(docker_local_http):
    trusted = os.environ.get("QB_TRUST_PROXY")
    if trusted is None:
        gateway = docker_gateway() if docker_local_http else None
        trusted = f"{LOOPBACK_PROXIES},{gateway}" if gateway else LOOPBACK_PROXIES
    if any(item.strip() == "*" for item in trusted.split(",")):
        raise ValueError("QB_TRUST_PROXY must name the proxy addresses or networks")
    return trusted


def serve(args, path):
    origin = public_origin(os.environ.get("QB_PUBLIC_URL"))
    docker_local_http = os.environ.get("QB_DOCKER_LOCAL_HTTP") == "1"
    trusted = trusted_proxies(docker_local_http)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    for name in ("httpx", "httpcore", "telegram"):
        logging.getLogger(name).setLevel(logging.CRITICAL)

    def bootstrap(service):
        if service.auth.has_administrator():
            return
        password = secret("QB_ADMIN_PASSWORD")
        if password:
            configure_admin(service, os.environ.get("QB_ADMIN_USERNAME", "admin"), password)
        else:
            logging.getLogger("quantbot").info(
                "Open the local web console to create the administrator."
            )

    local_url = f"http://127.0.0.1:{args.port}"
    app = make_app(
        path,
        public_url=origin,
        bootstrap=bootstrap,
        telegram_token=secret("QB_TELEGRAM_TOKEN"),
        local_url=local_url,
        docker_local_http=docker_local_http,
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


def database_path(data_dir: Path) -> Path:
    directory = data_dir.expanduser().resolve()
    current = directory / "quantbot.sqlite3"
    previous = directory / "quantbot-v2.sqlite3"
    if previous.exists():
        if not current.exists():
            return previous
        logging.getLogger("quantbot").warning(
            "Found two databases in %s. Using %s and leaving %s untouched.",
            directory,
            current.name,
            previous.name,
        )
    return current


def run():
    command = parser()
    args = command.parse_args()
    if args.operation is None:
        command.print_help()
        return 0
    try:
        path = database_path(args.data_dir)
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
        return 0
    except (OSError, RuntimeError, ValueError, sqlite3.Error, Problem) as exc:
        command.exit(1, f"QuantBot: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(run())
