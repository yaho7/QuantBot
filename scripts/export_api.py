"""Generate the checked-in HTTP API and request schema documents."""

import argparse
import json
from pathlib import Path

from quantbot.v2.api import make_app
from quantbot.v2.schemas import AUXILIARY, schema_document

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    app = make_app(DOCS / "unused.sqlite3", telegram_network=False)
    documents = {DOCS / "openapi.json": app.openapi()}
    for kind in AUXILIARY:
        documents[DOCS / "schemas" / f"{kind}.schema.json"] = schema_document(kind)
    drift = []
    for path, document in documents.items():
        rendered = json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        if args.check:
            if not path.is_file() or path.read_text(encoding="utf-8") != rendered:
                drift.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(rendered, encoding="utf-8")
    if drift:
        parser.exit(1, "Regenerate API contracts: " + ", ".join(drift) + "\n")


if __name__ == "__main__":
    main()
