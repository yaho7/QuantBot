"""Optional, standard-library helpers for an existing QuantBot Agent connection.

Pass your Agent's authenticated request function (method, path, payload).
That function is responsible for session renewal and network retries.
"""

from datetime import datetime, timezone
from socket import gethostname
from uuid import uuid4

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


def report_performance(agent, records, *, capacity=None, process_budget=None):
    """Submit stable records. QuantBot groups hosts by the reported name."""
    batch = {"host_name": gethostname(), "records": records}
    if capacity is not None:
        batch["capacity"] = capacity
    if process_budget is not None:
        batch["process_budget"] = process_budget
    return agent("POST", "/performance", batch)
