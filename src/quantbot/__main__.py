"""python -m quantbot"""

from __future__ import annotations

import logging
import sys

from quantbot.config import ConfigError, load


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s | %(levelname)s | %(name)s | %(message)s"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)  # it logs every poll, with the token
    try:
        settings = load()
    except ConfigError as exc:
        print(f"QuantBot config error: {exc}", file=sys.stderr)
        return 2
    from quantbot.bot import QuantBot

    QuantBot(settings).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
