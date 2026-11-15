"""Optional, standard-library helpers for an existing QuantBot Agent connection.

Pass your Agent's authenticated request function (method, path, payload).
That function is responsible for session renewal and network retries.
"""

from datetime import datetime, timezone
from os import environ, link
from pathlib import Path
from socket import gethostname
from tempfile import NamedTemporaryFile
from uuid import UUID, uuid4


def machine_id(scope="machine", state_dir=None):
    """Create a private, stable ID per resource pool; keep it outside source control."""
    if scope not in ("machine", "container"):
        raise ValueError("Host scope must be machine or container")
    default = Path(environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "quantbot"
    directory = Path(state_dir or default)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / f"{scope}-id"
    if not path.exists():
        # Publish a complete file atomically when several strategies start together.
        with NamedTemporaryFile(dir=directory, delete=False, mode="w") as draft:
            draft.write(uuid4().hex)
        temporary = Path(draft.name)
        try:
            link(temporary, path)
        except FileExistsError:
            pass
        finally:
            temporary.unlink()
    source = UUID(path.read_text().strip())
    if source.version != 4:
        raise ValueError("Expected a locally generated UUIDv4")
    return source.hex


def bind_host(agent, *, capacity=None, process_budget=None, scope="machine", state_dir=None):
    """Register through a report session. Only hostReporter=true may send host samples."""
    body = {
        "machine_id": machine_id(scope, state_dir),
        "name": gethostname(),
        "scope": scope,
    }
    if capacity is not None:
        body["capacity"] = capacity
    if process_budget is not None:
        body["process_budget"] = process_budget
    return agent("PUT", "/host", body)

def sample(duration_ms, *, host=None, process=None, observed_at=None):
    """Make one record from measured data. Save the result and reuse it on retry."""
    if not host and not process:
        raise ValueError("Supply at least one measured host or process metric")
    observed = observed_at or datetime.now(timezone.utc)
    if observed.utcoffset() is None:
        raise ValueError("Use a timezone-aware observation timestamp")
    record = {
        "record_id": uuid4().hex,
        "observed_at": observed.isoformat(timespec="milliseconds"),
        "sample_duration_ms": duration_ms,
    }
    if host:
        record["host"] = host
    if process:
        record["process"] = process
    return record


def report_performance(agent, records):
    """Submit saved records. Retries must preserve timestamps, IDs, and values."""
    return agent("POST", "/performance", {"records": records})
