"""Schemas and bounded observations published by strategy clients."""

from __future__ import annotations

import math
import re
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from quantbot.i18n import tr

FEATURE_ID = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}")
FIELD_ID = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,31}")
FIELD_TYPES = {"text", "number", "boolean", "select"}
MAX_ACTIONS = 16
MAX_METRICS = 12
MAX_POINTS = 240


@dataclass(frozen=True)
class ActionField:
    label: str
    type: str
    required: bool
    options: tuple[str, ...] = ()


@dataclass(frozen=True)
class ActionSpec:
    id: str
    label: str
    confirm: bool
    fields: dict[str, ActionField]


def parse_actions(value: Any) -> dict[str, ActionSpec]:
    if not isinstance(value, list) or len(value) > MAX_ACTIONS:
        raise ValueError("hello actions must be a list of up to 16 items")
    actions: dict[str, ActionSpec] = {}
    for action in value:
        if not isinstance(action, dict):
            raise ValueError("each action needs an object schema")
        name, label = action.get("id"), action.get("label")
        fields = action.get("fields", {})
        confirm = action.get("confirm", False)
        if (
            not isinstance(name, str)
            or not FEATURE_ID.fullmatch(name)
            or name in actions
            or not isinstance(label, str)
            or not 1 <= len(label.strip()) <= 80
            or not isinstance(confirm, bool)
            or not isinstance(fields, dict)
            or len(fields) > 8
        ):
            raise ValueError("invalid action schema")
        parsed: dict[str, ActionField] = {}
        for key, spec in fields.items():
            if not FIELD_ID.fullmatch(key) or not isinstance(spec, dict):
                raise ValueError("invalid action field")
            kind = spec.get("type")
            caption = spec.get("label", key)
            required = spec.get("required", True)
            options = spec.get("options", [])
            if (
                not isinstance(kind, str)
                or kind not in FIELD_TYPES
                or not isinstance(caption, str)
                or not 1 <= len(caption.strip()) <= 80
                or not isinstance(required, bool)
                or not isinstance(options, list)
                or len(options) > 20
                or not all(
                    isinstance(option, str) and 1 <= len(option) <= 100 for option in options
                )
                or (kind == "select" and not options)
            ):
                raise ValueError("invalid action field schema")
            parsed[key] = ActionField(
                caption.strip(), kind, required, tuple(dict.fromkeys(options))
            )
        actions[name] = ActionSpec(name, label.strip(), confirm, parsed)
    return actions


def finite_number(value: Any) -> bool:
    return type(value) in (int, float) and abs(value) <= 1e100 and math.isfinite(value)


def action_arguments(action: ActionSpec, values: Any) -> dict[str, Any]:
    if not isinstance(values, dict) or not values.keys() <= action.fields.keys():
        raise ValueError(tr("操作参数与策略声明不匹配。"))
    result = {}
    for key, spec in action.fields.items():
        if key not in values:
            if spec.required:
                raise ValueError(tr("请填写 {0}。", spec.label))
            continue
        value = values[key]
        valid = {
            "text": isinstance(value, str)
            and len(value) <= 1000
            and (bool(value) or not spec.required),
            "number": finite_number(value),
            "boolean": isinstance(value, bool),
            "select": isinstance(value, str) and value in spec.options,
        }
        if not valid[spec.type]:
            raise ValueError(tr("{0} 的值无效。", spec.label))
        result[key] = value
    return result


@dataclass
class Metric:
    id: str
    label: str
    unit: str
    points: deque[tuple[int, float]] = field(default_factory=lambda: deque(maxlen=MAX_POINTS))

    def report(self, timestamp: int, value: float) -> None:
        if self.points and timestamp <= self.points[-1][0]:
            self.points[-1] = self.points[-1][0], value
        else:
            self.points.append((timestamp, value))

    def summary(self) -> dict[str, str | float]:
        return {"id": self.id, "label": self.label, "unit": self.unit, "value": self.points[-1][1]}


def record_metric(metrics: dict[str, Metric], body: dict[str, Any], timestamp: int) -> None:
    name, value = body.get("name"), body.get("value")
    label, unit = body.get("label"), body.get("unit")
    if (
        not isinstance(name, str)
        or not FEATURE_ID.fullmatch(name)
        or not finite_number(value)
        or (label is not None and (not isinstance(label, str) or not 1 <= len(label.strip()) <= 80))
        or (unit is not None and (not isinstance(unit, str) or len(unit) > 24))
    ):
        raise ValueError("metric needs a valid name, a finite number and optional label and unit")
    series = metrics.get(name)
    if series is None:
        if len(metrics) >= MAX_METRICS:
            raise ValueError("each strategy can publish up to 12 metrics")
        series = metrics[name] = Metric(name, label.strip() if label else name, unit or "")
    if label is not None:
        series.label = label.strip()
    if unit is not None and unit != series.unit:
        series.points.clear()
        series.unit = unit
    series.report(timestamp, float(value))
