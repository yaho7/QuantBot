"""python -m quantbot [命令]"""

from __future__ import annotations

import logging
import os
import sys

from quantbot.cli import main
from quantbot.config import data_dir


def drop_privileges() -> None:
    """In the image, start as root, hand /data to the quantbot user, then become it.

    This lets `./data:/data` work as a plain folder on the host: Docker creates it
    owned by root, and `docker compose exec quantbot quantbot setup` runs as root.
    Files are handed back to the quantbot user before anything is read or written.
    Only active when QB_UID is set, which the image does.
    """
    uid_text = os.environ.get("QB_UID")
    if not uid_text or os.name != "posix" or os.geteuid() != 0:
        return
    uid = gid = int(uid_text)
    data = data_dir()
    data.mkdir(parents=True, exist_ok=True)
    for path in [data, *data.rglob("*")]:
        os.lchown(path, uid, gid)
    os.chmod(data, 0o700)
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)


def run() -> int:
    drop_privileges()
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s | %(levelname)s | %(name)s | %(message)s"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)  # it logs every poll, with the token
    return main()


if __name__ == "__main__":
    sys.exit(run())
