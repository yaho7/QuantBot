"""Inspect project files without importing or executing them."""

import shlex
import shutil
from typing import Any

from quantbot.config import ConfigError
from quantbot.editor import Editor
from quantbot.templates import CLIENT_FILE, QUICKSTART_FILE
from quantbot.workspace import Workspace

PROJECT_TEMPLATE = """from quantbot_client import QuantBot


def main() -> None:
    qb = QuantBot().start()
    try:
        print("QuantBot project started", flush=True)
        while not qb.stopping:
            qb.status("Project running")
            qb.sleep(15)
    finally:
        qb.close()


if __name__ == "__main__":
    main()
"""


def preflight(editor: Editor, workspace: Workspace) -> dict[str, Any]:
    entries = editor.entries("")
    files = {entry["name"] for entry in entries if entry["kind"] == "file"}
    sources = sorted(
        name for name in files - {CLIENT_FILE, QUICKSTART_FILE} if name.endswith(".py")
    )
    entry = next((name for name in ("main.py", "app.py") if name in files), "")
    if not entry and len(sources) == 1:
        entry = sources[0]
    commands: dict[str, str] = {}
    recommendation = ""
    if entry:
        path = workspace.environment()["PATH"]
        script = shlex.quote(f"./{entry}")
        commands["python"] = f"python3 {script}"
        try:
            inline = "# /// script" in editor.read(entry).content.splitlines()
        except (ConfigError, OSError):
            inline = False
        if shutil.which("uv", path=path):
            requirements = (
                " --with-requirements requirements.txt"
                if "requirements.txt" in files and not inline
                else ""
            )
            commands["uv"] = f"uv run{requirements} {script}"
        if shutil.which("conda", path=path):
            commands["conda"] = f"conda run --no-capture-output python {script}"
        has_dependencies = bool(files & {"uv.lock", "pyproject.toml", "requirements.txt"}) or inline
        recommendation = "uv" if has_dependencies and "uv" in commands else "python"
    return {
        "entry": entry,
        "files": sorted(
            files & {"pyproject.toml", "uv.lock", "requirements.txt", "environment.yml"}
        ),
        "commands": commands,
        "recommendation": recommendation,
        "can_seed": not entries,
    }
