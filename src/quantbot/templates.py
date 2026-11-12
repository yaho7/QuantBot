"""Source files shipped with QuantBot for strategy onboarding."""

from importlib import resources
from pathlib import Path

QUICKSTART_FILE = "quickstart.py"
QUICKSTART_COMMAND = f"python3 -I {QUICKSTART_FILE}"


def _source(packaged: str, checkout: str) -> str:
    try:
        return resources.files("quantbot").joinpath(packaged).read_text("utf-8")
    except FileNotFoundError:
        return (Path(__file__).resolve().parents[2] / checkout).read_text("utf-8")


def client_source() -> str:
    return _source("client_template.py", "client/quantbot_client.py")


def quickstart_source() -> str:
    example = _source("quickstart_example.py", "examples/demo.py")
    # Keep the same demo runnable from the checkout and as a standalone download.
    example = example.replace("from quantbot_client import CommandRejected, QuantBot\n", "", 1)
    return "# QuantBot quickstart: paper trading only.\n" + client_source() + "\n\n" + example
