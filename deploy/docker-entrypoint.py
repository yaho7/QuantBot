"""Prepare the Docker data mount, then run QuantBot as the service user."""

import os
import stat
import sys

SERVICE_ID = 10001
DATA = "/data"
DATA_FILES = (
    "quantbot-v2.lock",
    "quantbot-v2.sqlite3",
    "quantbot-v2.sqlite3-wal",
    "quantbot-v2.sqlite3-shm",
    "quantbot-v2.sqlite3-journal",
)


def make_private(fd: int, mode: int) -> None:
    current = os.fstat(fd)
    if stat.S_IMODE(current.st_mode) != mode:
        os.fchmod(fd, mode)
    if (current.st_uid, current.st_gid) != (SERVICE_ID, SERVICE_ID):
        os.fchown(fd, SERVICE_ID, SERVICE_ID)


def prepare_data() -> None:
    mount = os.open(DATA, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # Handle files left by an earlier deployment, including an uncheckpointed WAL.
        for name in DATA_FILES:
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=mount)
            except FileNotFoundError:
                continue
            try:
                current = os.fstat(fd)
                if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
                    raise OSError(f"{name} must be a regular file with no other hard links")
                make_private(fd, 0o600)
            finally:
                os.close(fd)
        make_private(mount, 0o700)
    finally:
        os.close(mount)


def main() -> None:
    os.umask(0o077)
    if os.geteuid() == 0:
        try:
            prepare_data()
        except OSError as exc:
            raise SystemExit(f"QuantBot cannot prepare {DATA}: {exc}") from exc
        os.setgroups([])
        os.setgid(SERVICE_ID)
        os.setuid(SERVICE_ID)
    os.execv("/app/.venv/bin/quantbot", ["quantbot", *sys.argv[1:]])  # noqa: S606


if __name__ == "__main__":
    main()
