"""Source files shipped with QuantBot for strategy onboarding."""

import hashlib
import logging
import os
import tempfile
from importlib import resources
from pathlib import Path

from quantbot.config import ConfigError, Store
from quantbot.editor import Editor, editor_lock
from quantbot.workspace import workspace_id

log = logging.getLogger(__name__)
CLIENT_FILE = "quantbot_client.py"
QUICKSTART_FILE = "quickstart.py"
QUICKSTART_COMMAND = f"python3 -I {QUICKSTART_FILE}"
OFFICIAL_SOURCES = {
    CLIENT_FILE: {
        "953b663331a707a4c4c11bdb116a14ee7b614b9e7e0d84b7adf89a52ca3b09c7",  # v0.3.x
        "ef3ef68d7161c4354938019941794099c346f5cab66a91c519a2e1bfa4a0d0c8",  # v0.4.x
        "5ca1d0898c129892dbe947cb99bcfe606572f1ee513cf9ba1af83e59d2b2df42",  # v0.5.0
    },
    QUICKSTART_FILE: {"53fec86e06caa03d79ad1c752c8d415bbf958216445f068658c1f1acef8d5049"},
}


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


def _digest(source: str) -> str:
    return hashlib.sha256(source.encode()).hexdigest()


def refresh_workspace_sources(editor: Editor) -> dict[str, str]:
    """Refresh official copies from this installation while preserving project edits."""
    stamps = Store(editor.data_dir / "workspace-sdk", filename=f"{workspace_id(editor.root)}.json")
    official: dict[str, str] = {}
    with editor_lock(editor.data_dir, editor.root), stamps.edit() as known:
        for name, source in (
            (CLIENT_FILE, client_source()),
            (QUICKSTART_FILE, quickstart_source()),
        ):
            try:
                current = editor.read(name)
            except (OSError, ConfigError):
                continue
            digest, target = _digest(current.content), _digest(source)
            if digest == target:
                known[name] = target
                official[name] = target
            elif digest in OFFICIAL_SOURCES[name] or digest == known.get(name):
                editor.save(name, source, current.revision)
                known[name] = target
                official[name] = target
                log.info("Updated official %s in workspace %s", name, editor.root)
    return official


def runtime_sdk(data_dir: Path) -> Path:
    """Publish the bundled SDK as a root-readable systemd credential source."""
    directory = data_dir / "workspace-sdk"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / CLIENT_FILE
    source = client_source()
    try:
        if path.read_text("utf-8") == source:
            return path
    except FileNotFoundError:
        pass
    fd, temp = tempfile.mkstemp(dir=directory, prefix=".client-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(source)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)
    return path
