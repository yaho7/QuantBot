"""Validate and persist strategy-declared controls and agent-reported values."""

import json
import re
from decimal import Decimal, InvalidOperation, localcontext

from .control_models import ENTRY_TOGGLE
from .db import encode, timestamp
from .errors import Problem
from .models import SHADOW_ACTIONS, Capability, Parameter


def numeric(value):
    if value is None or type(value) not in {str, int, float} or len(str(value)) > 64:
        raise Problem(422, "Expected a finite decimal value")
    if type(value) is str and not re.fullmatch(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?", value):
        raise Problem(422, "Expected a decimal string without an exponent")
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        raise Problem(422, "Expected a finite decimal value") from None
    if not number.is_finite() or abs(number.adjusted()) > 62 or (number.as_tuple().exponent < -62):
        raise Problem(422, "Decimal value exceeds the supported precision")
    return number


def number_value(definition, value):
    number = numeric(value)
    lo = numeric(definition["min"]) if definition.get("min") is not None else None
    hi = numeric(definition["max"]) if definition.get("max") is not None else None
    step = numeric(definition["step"]) if definition.get("step") is not None else None
    if (lo is not None and number < lo) or (hi is not None and number > hi):
        raise Problem(422, "Control value is outside its allowed range")
    if step is not None:
        with localcontext() as context:
            context.prec = 256
            if (number - (lo or Decimal(0))) % step != 0:
                raise Problem(422, "Control value must follow the configured step")
    if definition.get("integer"):
        if number != number.to_integral_value() or abs(number) > 2**53 - 1:
            raise Problem(422, "Expected a safe integer")
        return int(number)
    text = format(number, "f")
    if len(text) > 64:
        raise Problem(422, "Decimal value exceeds the supported precision")
    return text


class Controls:
    def __init__(self, runtime):
        self.service = runtime
        self.db = runtime.db
        self.strategies = runtime.strategies
        self.commands = runtime.commands

    def row(self, sid):
        return self.db.one("SELECT * FROM control_registries WHERE strategy_id=?", (sid,))

    def definition(self, row, cid):
        if row:
            for item in json.loads(row["payload"])["controls"]:
                if item["id"] == cid:
                    return item
        raise Problem(404, "Control component not found")

    def capabilities(self, sid, *, live=False):
        executor = self.strategies.executor(sid, live=live)
        if not executor:
            return {}
        return {
            cap["id"]: Capability.model_validate(cap)
            for cap in json.loads(executor["declarations"])["capabilities"]
        }

    def validate_binding(self, definition, caps):
        kind = definition["type"]
        action = definition.get("command")
        if kind == "readonly":
            return
        if action == ENTRY_TOGGLE:
            if (
                kind != "toggle"
                or definition.get("parameter")
                or not SHADOW_ACTIONS.keys() <= caps.keys()
            ):
                raise Problem(
                    422, "The entry toggle requires declared pause_entry and resume_entry"
                )
            return
        cap = caps.get(action)
        if not cap:
            raise Problem(422, "Component command must reference a declared capability")
        if kind == "form":
            fields = definition["fields"]
            for name, field in fields.items():
                param = cap.parameters.get(name)
                if not param or field["type"] != param.type:
                    raise Problem(422, f"Form field {name} does not match the capability")
            remaining = cap.parameters.keys() - fields.keys()
        elif kind == "button":
            remaining = cap.parameters.keys()
        else:
            name = definition.get("parameter")
            if name is None and len(cap.parameters) == 1:
                name = next(iter(cap.parameters))
            if not name or name not in cap.parameters:
                raise Problem(422, "A value component must select a declared command parameter")
            definition["parameter"] = name
            param = cap.parameters[name]
            expected = {"toggle": "boolean", "select": "choice", "text": "string"}
            value_type = "integer" if definition.get("integer") else "decimal"
            if param.type != expected.get(kind, value_type):
                raise Problem(422, "Component value type must match its command parameter")
            if kind == "select" and any(
                not param.accepts(o["value"]) for o in definition["options"]
            ):
                raise Problem(422, "Select choices must match the capability")
            if kind in {"number", "slider"}:
                self.validate_number(definition, param)
            if definition.get("default") is not None:
                default = self.value(definition, definition["default"])
                if not param.accepts(default):
                    raise Problem(422, "Component default must be accepted by the capability")
                definition["default"] = default
            remaining = cap.parameters.keys() - {name}
        if any(
            cap.parameters[key].required and cap.parameters[key].default is None
            for key in remaining
        ):
            raise Problem(422, "Component must supply all required command parameters")

    @staticmethod
    def validate_number(definition, param):
        bounds = [
            numeric(definition[field]) if definition[field] is not None else None
            for field in ("min", "max", "step")
        ]
        lo, hi, step = bounds
        if lo is not None and hi is not None and lo >= hi:
            raise Problem(422, "Minimum must be lower than maximum")
        if step is not None and step <= 0:
            raise Problem(422, "Numeric step must be positive")
        if definition["integer"] and any(
            value is not None and value != value.to_integral_value() for value in bounds
        ):
            raise Problem(422, "Integer controls require integer bounds and step")
        if lo is not None and param.minimum is not None and lo < Decimal(param.minimum):
            raise Problem(422, "Component minimum falls below the command minimum")
        if hi is not None and param.maximum is not None and hi > Decimal(param.maximum):
            raise Problem(422, "Component maximum exceeds the command maximum")
        if definition["type"] == "slider":
            with localcontext() as context:
                context.prec = 256
                if (hi - lo) % step or (hi - lo) / step > 1000:
                    raise Problem(422, "Slider requires an even range of at most 1000 steps")

    @staticmethod
    def value(definition, value):
        kind = definition["type"]
        if kind == "readonly":
            kind = {"text": "text", "number": "number", "boolean": "toggle"}[
                definition["value_type"]
            ]
        if kind == "toggle" and type(value) is bool:
            return value
        if (
            kind == "select"
            and type(value) is str
            and value in {o["value"] for o in definition["options"]}
        ):
            return value
        if (
            kind == "text"
            and type(value) is str
            and 0 < len(value.strip()) <= definition.get("max_length", 1000)
        ):
            return value
        if kind in {"number", "slider"}:
            return number_value(definition, value)
        raise Problem(422, "Invalid value for the control component")

    def publish(self, agent, registry):
        sid, instance = agent["strategy_id"], agent["instance_id"]
        caps = self.capabilities(sid, live=True)
        payload = registry.model_dump(mode="json")
        for definition in payload["controls"]:
            self.validate_binding(definition, caps)
        document = encode(payload)
        with self.db.transaction():
            row = self.row(sid)
            if row and registry.revision <= row["revision"]:
                if (
                    registry.revision == row["revision"]
                    and row["instance_id"] == instance
                    and row["payload"] == document
                ):
                    return self.public(sid)
                raise Problem(409, "Control registry revision is stale or already in use")
            if row:
                old = {item["id"]: item for item in json.loads(row["payload"])["controls"]}
                current = {item["id"]: item for item in payload["controls"]}
                for cid, definition in old.items():
                    if current.get(cid) != definition or row["instance_id"] != instance:
                        self.db.execute(
                            "DELETE FROM control_values WHERE strategy_id=? AND control_id=?",
                            (sid, cid),
                        )
                self.expire(sid, "Control registry changed")
            self.db.execute(
                """INSERT INTO control_registries VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(strategy_id) DO UPDATE SET instance_id=excluded.instance_id,
                   revision=excluded.revision, payload=excluded.payload,
               updated_at=excluded.updated_at""",
                (sid, instance, registry.revision, document, self.service.clock()),
            )
            self.strategies.audit(
                f"agent:{instance}",
                "controls.publish",
                sid,
                revision=registry.revision,
                controls=[item["id"] for item in payload["controls"]],
            )
        self.service.wake()
        return self.public(sid)

    def expire(self, sid, reason, control_id=None):
        for row in self.db.all(
            """SELECT * FROM commands WHERE strategy_id=? AND control_id IS NOT NULL
               AND (? IS NULL OR control_id=?) AND revision IS NULL
               AND state IN ('confirmation_required', 'pending', 'accepted')""",
            (sid, control_id, control_id),
        ):
            self.commands.transition(row, "expired", reason)

    def actual(self, agent, body):
        sid = agent["strategy_id"]
        row = self.row(sid)
        if (
            not row
            or body.revision != row["revision"]
            or row["instance_id"] != agent["instance_id"]
        ):
            raise Problem(
                409, "Control state must refer to the executor's current registry revision"
            )
        caps = self.capabilities(sid, live=True)
        now = self.service.clock()
        observed = self.service.telemetry.observation(body.observed_at)
        if observed < now - 7 * 86400:
            raise Problem(422, "Control observation is too old")
        with self.db.transaction():
            for cid, raw in body.values.items():
                definition = self.definition(row, cid)
                action = definition.get("command")
                if definition["type"] == "form":
                    if not isinstance(raw, dict):
                        raise Problem(422, "Form state must be an object of reported values")
                    fields = {
                        name: Parameter.model_validate(field)
                        for name, field in definition["fields"].items()
                    }
                    value = {}
                    for name, item in raw.items():
                        if name not in fields or not fields[name].accepts(item):
                            raise Problem(422, f"Invalid reported form field {name}")
                        if not caps.get(action) or not caps[action].parameters[name].accepts(item):
                            raise Problem(
                                422, f"Reported form value exceeds the capability for {name}"
                            )
                        value[name] = item
                else:
                    value = self.value(definition, raw)
                if action == ENTRY_TOGGLE:
                    control = self.strategies.control(sid)
                    if (
                        not control["reported_current"]
                        or control["reported"]["entry_enabled"] != value
                    ):
                        raise Problem(409, "Report actual entry permission via /control/reported")
                    continue
                if "parameter" in definition:
                    cap = caps.get(action)
                    param = cap.parameters.get(definition["parameter"]) if cap else None
                    if param is None or not param.accepts(value):
                        raise Problem(422, "Reported value does not match the current capability")
                self.store(sid, cid, "value", agent["session_id"], body.revision, observed, value)
            for cid, value in body.disabled.items():
                self.definition(row, cid)
                changed = self.store(
                    sid,
                    cid,
                    "disabled",
                    agent["session_id"],
                    body.revision,
                    observed,
                    value.model_dump(mode="json"),
                )
                if changed and value.disabled:
                    self.expire(sid, "Control is disabled by the strategy", cid)
        self.service.wake()
        return self.public(sid)

    def store(self, sid, cid, kind, session, revision, observed, value):
        key = (sid, cid, kind)
        old = self.db.one(
            "SELECT * FROM control_values WHERE strategy_id=? AND control_id=? AND kind=?",
            key,
        )
        document = encode(value)
        if old and old["revision"] == revision:
            if observed < old["observed_at"] or (
                observed == old["observed_at"] and old["payload"] != document
            ):
                raise Problem(409, "Control state observation is out of order or conflicts")
            if observed == old["observed_at"] and old["session_id"] == session:
                return False
        self.db.execute(
            """INSERT INTO control_values VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(strategy_id, control_id, kind) DO UPDATE SET
               session_id=excluded.session_id, revision=excluded.revision,
               observed_at=excluded.observed_at, payload=excluded.payload""",
            (*key, session, revision, observed, document),
        )
        return True

    def public(self, sid):
        strategy = self.strategies.row(sid)
        row = self.row(sid)
        if not row:
            return {
                "schema_version": 1,
                "revision": 0,
                "groups": [],
                "controls": [],
                "states": {},
                "updated_at": None,
            }
        registry = json.loads(row["payload"])
        executor = self.strategies.executor(sid, live=True)
        active = bool(
            executor
            and row["instance_id"] == strategy["executor_id"]
            and strategy["archived_at"] is None
            and json.loads(executor["declarations"])["executor"]
        )
        states = {}
        for value in self.db.all("SELECT * FROM control_values WHERE strategy_id=?", (sid,)):
            kind = value["kind"]
            state = states.setdefault(value["control_id"], {})
            state[kind] = json.loads(value["payload"])
            state[f"{kind}_observed_at"] = timestamp(value["observed_at"])
            state[f"{kind}_stale"] = not (
                active
                and value["revision"] == row["revision"]
                and value["session_id"] == executor["session_id"]
            )
        control = self.strategies.control(sid)
        caps = self.capabilities(sid)
        settings = self.strategies.settings(sid)
        for definition in registry["controls"]:
            state = states.setdefault(definition["id"], {})
            if definition.get("command") == ENTRY_TOGGLE and control["reported"]:
                state.update(
                    value=control["reported"]["entry_enabled"],
                    value_observed_at=control["reported"]["updated_at"],
                    value_stale=not control["reported_current"],
                )
            reason = None
            action = definition.get("command")
            if action and action not in {*SHADOW_ACTIONS, ENTRY_TOGGLE} and not active:
                reason = "执行实例离线"
            elif row["instance_id"] != strategy["executor_id"] or strategy["archived_at"]:
                reason = "控制注册表需要由当前执行实例发布"
            elif action:
                try:
                    self.validate_binding(dict(definition), caps)
                except Problem:
                    reason = "控制定义与当前能力不兼容"
                cap = caps.get(action)
                risky, protected = self.commands.safety(cap) if cap else (False, False)
                risky = risky or definition["risk_level"] == "high"
                state["confirmation_required"] = (
                    risky
                    or protected
                    or definition["risk_level"] == "medium"
                    or definition["confirm"]
                )
                if risky and settings["mode"] == "live" and not settings["live_trading_enabled"]:
                    reason = "实盘高风险操作未启用"
            if state.get("disabled", {}).get("disabled"):
                reason = state["disabled"]["reason"] or "策略报告此控件已禁用"
            state.update(available=reason is None, unavailable_reason=reason)
        return {**registry, "states": states, "updated_at": timestamp(row["updated_at"])}

    def bound_action(self, sid, action):
        row = self.row(sid)
        return row and any(
            item.get("command") == action for item in json.loads(row["payload"])["controls"]
        )

    def invocation(self, sid, cid, body):
        definition = self.current(sid, cid, body.revision)
        kind, action = definition["type"], definition.get("command")
        if kind == "readonly":
            raise Problem(422, "Read-only controls cannot create commands")
        if kind in {"button", "form"} and body.value is not None:
            raise Problem(422, "This control does not accept a single value")
        if kind != "form" and body.arguments:
            raise Problem(422, "Only form controls accept multiple arguments")
        if kind == "button":
            args = {}
        elif kind == "form":
            fields = {
                name: Parameter.model_validate(field)
                for name, field in definition["fields"].items()
            }
            args = self.commands.parameters(fields, body.arguments)
        else:
            value = self.value(definition, body.value)
            if action == ENTRY_TOGGLE:
                return ("resume_entry" if value else "pause_entry"), {}
            args = {definition["parameter"]: value}
        return action, args

    def current(self, sid, cid, revision):
        strategy = self.strategies.active(sid)
        row = self.row(sid)
        if not row or row["revision"] != revision or row["instance_id"] != strategy["executor_id"]:
            raise Problem(409, "Control registry changed; reload the control panel")
        definition = self.definition(row, cid)
        state = self.db.one(
            """SELECT payload FROM control_values
               WHERE strategy_id=? AND control_id=? AND kind='disabled' AND revision=?""",
            (sid, cid, revision),
        )
        if state and json.loads(state["payload"])["disabled"]:
            raise Problem(409, "The strategy currently reports this control as disabled")
        return definition

    def safety(self, sid, cid, revision, risky, protected):
        definition = self.current(sid, cid, revision)
        level = definition.get("risk_level")
        risky = risky or level == "high"
        return risky, protected or risky or level == "medium" or definition.get("confirm", False)
