"""python -m quantbot [命令]"""

from __future__ import annotations

import logging
import sys

from quantbot.cli import main


def run() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s | %(levelname)s | %(name)s | %(message)s"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)  # it logs every poll, with the token
    return main()


if __name__ == "__main__":
    sys.exit(run())
