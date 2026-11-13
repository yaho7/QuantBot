"""Export JSON Schema from the same models that validate HTTP requests."""

from .control_models import ControlInvocation, ControlRegistry, ControlValues
from .errors import Problem
from .models import Event, MetricPoint, Snapshot
from .report_models import REPORT_SCHEMA, MetricDefinitions, ReportBatch

DRAFT = "https://json-schema.org/draft/2020-12/schema"
AUXILIARY = {
    "snapshot": Snapshot,
    "event": Event,
    "metric": MetricPoint,
    "batch": ReportBatch,
    "metric-definitions": MetricDefinitions,
    "controls": ControlRegistry,
    "control-state": ControlValues,
    "control-invocation": ControlInvocation,
}


def schema_document(kind):
    root = {"$schema": DRAFT}
    if kind in AUXILIARY:
        return {**root, **AUXILIARY[kind].model_json_schema()}
    document = REPORT_SCHEMA.json_schema()
    mapping = document["discriminator"]["mapping"]
    if kind not in mapping:
        raise Problem(404, "Unknown telemetry or control schema")
    return {**root, "$ref": mapping[kind], "$defs": document["$defs"]}
