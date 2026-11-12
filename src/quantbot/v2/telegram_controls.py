"""Short-lived Telegram controls and bounded multi-step input."""

import secrets
from dataclasses import dataclass, field, replace

from .control_models import ControlInvocation
from .errors import Problem
from .models import Parameter

EXPIRES = 180
PAGE_SIZE = 7


@dataclass(frozen=True)
class Flow:
    user: int
    strategy: str
    revision: int
    control: str
    expires: float
    index: int = 0
    values: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Callback:
    flow: Flow
    action: str
    value: object = None


class TelegramControls:
    def __init__(self, service, button, operation):
        self.service = service
        self.button = button
        self.operation = operation
        self.callbacks = {}
        self.inputs = {}

    def callback(self, label, flow, action, value=None):
        now = self.service.clock()
        self.callbacks = {
            key: item for key, item in self.callbacks.items() if item.flow.expires > now
        }
        while len(self.callbacks) >= 4000:
            del self.callbacks[next(iter(self.callbacks))]
        key = secrets.token_urlsafe(12)
        self.callbacks[key] = Callback(flow, action, value)
        return self.button(label, f"tc:{key}")

    def command_button(self, label, user, command, action):
        flow = Flow(
            user,
            command["strategy_id"],
            command["control_revision"],
            command["control_id"],
            self.service.clock() + EXPIRES,
        )
        return self.callback(label, flow, action, command["id"])

    def take(self, key, user):
        token = self.callbacks.get(key)
        if not token or token.flow.expires <= self.service.clock() or token.flow.user != user:
            raise Problem(409, "此按钮已过期或属于其他用户，请重新打开控制面板")
        self.invalidate(token.flow)
        return token

    def invalidate(self, flow):
        self.callbacks = {
            key: item for key, item in self.callbacks.items() if item.flow is not flow
        }

    def dismiss(self, user):
        flow = self.inputs.pop(user, None)
        if flow:
            self.invalidate(flow)

    def open(self, sid, user, page=0):
        self.dismiss(user)
        registry = self.service.controls.public(sid)
        groups = {g["id"]: g for g in registry["groups"]}
        controls = sorted(
            registry["controls"],
            key=lambda c: (
                groups.get(c["group"], {}).get("order", -1),
                c["order"],
                c["id"],
            ),
        )
        last = max(0, (len(controls) - 1) // PAGE_SIZE)
        page = min(max(0, page), last)
        rows = []
        names = []
        current_group = None
        for item in controls[page * PAGE_SIZE : (page + 1) * PAGE_SIZE]:
            state = registry["states"][item["id"]]
            group = groups.get(item["group"], {}).get("label", "常规")
            if group != current_group:
                names.append(f"【{group}】")
                current_group = group
            actual = self.display(state)
            reason = state.get("unavailable_reason")
            names.append(f"{item['label']} · {actual}" + (f" · {reason}" if reason else ""))
            if item["type"] != "readonly" and state["available"]:
                flow = Flow(
                    user, sid, registry["revision"], item["id"], self.service.clock() + EXPIRES
                )
                rows.append([self.callback(item["label"], flow, "open")])
        navigation = []
        menu = Flow(user, sid, registry["revision"], "", self.service.clock() + EXPIRES)
        if page > 0:
            navigation.append(self.callback("上一页", menu, "page", page - 1))
        if page < last:
            navigation.append(self.callback("下一页", menu, "page", page + 1))
        if navigation:
            rows.append(navigation)
        rows.append([self.button("返回策略", f"s:{sid}")])
        detail = "\n".join(names) or "尚未注册动态控件"
        return f"控制面板 {page + 1}/{last + 1}\n\n{detail}", rows, None

    @staticmethod
    def display(state):
        value = state.get("value")
        actual = "未上报" if value is None else str(value)
        return actual + ("（上次上报）" if state.get("value_stale") else "")

    def route(self, key, actor, user, update_id):
        token = self.take(key, user)
        flow = token.flow
        self.dismiss(user)
        if token.action in {"page", "cancel_input"}:
            registry = self.service.controls.public(flow.strategy)
            if registry["revision"] != flow.revision:
                raise Problem(409, "控件版本已变更，请重新打开控制面板")
            return self.open(flow.strategy, user, token.value or 0)
        if token.action in {"confirm", "cancel_command"}:
            row = self.service.commands.row(token.value, flow.strategy)
            if row["control_id"] != flow.control or row["control_revision"] != flow.revision:
                raise Problem(409, "控件和指令不匹配")
            if token.action == "confirm":
                self.service.controls.current(flow.strategy, flow.control, flow.revision)
                command = self.service.commands.confirm(token.value, actor)
            else:
                command = self.service.commands.cancel(token.value, actor)
            return self.operation(command, user)

        definition = self.service.controls.current(flow.strategy, flow.control, flow.revision)
        kind = definition["type"]
        if token.action == "open" and kind == "button":
            return self.submit(flow, actor, update_id)
        if token.action in {"open", "back"}:
            if token.action == "back":
                flow = replace(flow, index=flow.index - 1)
            return self.prompt(flow, definition)
        if token.action == "submit":
            return self.submit(flow, actor, update_id, arguments=flow.values)
        if token.action == "skip":
            return self.advance(flow, definition, omit=True)
        if kind == "form":
            return self.advance(flow, definition, token.value)
        return self.submit(flow, actor, update_id, value=token.value)

    def text(self, user, actor, update_id, text):
        flow = self.inputs.pop(user, None)
        if not flow:
            return None
        self.invalidate(flow)
        if flow.expires <= self.service.clock():
            raise Problem(409, "输入已超时，请重新打开控制面板")
        definition = self.service.controls.current(flow.strategy, flow.control, flow.revision)
        if definition["type"] == "form":
            name = list(definition["fields"])[flow.index]
            field = definition["fields"][name]
            try:
                raw = int(text.strip()) if field["type"] == "integer" else text.strip()
                return self.advance(flow, definition, raw)
            except (ValueError, Problem) as exc:
                prompt, rows, photo = self.prompt(flow, definition)
                reason = str(exc) if isinstance(exc, Problem) else "请输入整数"
                return f"{reason}\n\n{prompt}", rows, photo
        try:
            value = self.service.controls.value(definition, text.strip())
        except Problem as exc:
            prompt, rows, photo = self.prompt(flow, definition)
            return f"{exc}\n\n{prompt}", rows, photo
        return self.submit(flow, actor, update_id, value=value)

    def advance(self, flow, definition, value=None, *, omit=False):
        name = list(definition["fields"])[flow.index]
        field = Parameter.model_validate(definition["fields"][name])
        if not omit and not field.accepts(value):
            raise Problem(422, f"{field.label} 的输入无效")
        values = dict(flow.values)
        if omit:
            values.pop(name, None)
        else:
            values[name] = value
        return self.prompt(replace(flow, index=flow.index + 1, values=values), definition)

    def prompt(self, flow, definition):
        kind = definition["type"]
        view = self.service.controls.public(flow.strategy)
        state = view["states"][flow.control]
        if not state["available"]:
            raise Problem(409, state.get("unavailable_reason") or "控件暂不可用")
        rows = []
        text = [definition["label"], f"实际值 {self.display(state)}"]
        if definition["description"]:
            text.append(definition["description"])
        if kind == "form":
            fields = list(definition["fields"].values())
            if flow.index >= len(fields):
                text.append(f"待提交参数 {flow.values}")
                rows.append([self.callback("提交参数", flow, "submit")])
            else:
                f = fields[flow.index]
                text.append(f"第 {flow.index + 1}/{len(fields)} 项 · {f['label']}")
                rows.extend(self.parameter_buttons(flow, f["type"], f["choices"]))
                if not rows:
                    self.inputs[flow.user] = flow
                    text.append("请直接发送该参数值。")
                if not f["required"] or f["default"] is not None:
                    rows.append([self.callback("使用默认值 / 跳过", flow, "skip")])
            if flow.index:
                rows.append([self.callback("上一项", flow, "back")])
        elif kind == "toggle":
            rows.append(
                [
                    self.callback("开启", flow, "value", True),
                    self.callback("关闭", flow, "value", False),
                ]
            )
        elif kind == "select":
            rows.extend(
                [self.callback(o["label"], flow, "value", o["value"])]
                for o in definition["options"]
            )
        else:
            self.inputs[flow.user] = flow
            if kind in {"slider", "number"}:
                bounds = " · ".join(
                    f"{title} {definition[key]}"
                    for key, title in (("min", "最小"), ("max", "最大"), ("step", "步长"))
                    if definition[key] is not None
                )
                text.append(f"请直接发送数值。{bounds}")
            else:
                text.append(f"请直接发送文本，最多 {definition['max_length']} 个字符。")
        rows.append([self.callback("取消并返回", flow, "cancel_input")])
        return "\n".join(text), rows, None

    def parameter_buttons(self, flow, kind, choices):
        if kind == "boolean":
            return [
                [
                    self.callback("是", flow, "value", True),
                    self.callback("否", flow, "value", False),
                ]
            ]
        if kind == "choice":
            return [[self.callback(value, flow, "value", value)] for value in choices]
        return []

    def submit(self, flow, actor, update_id, *, value=None, arguments=None):
        self.service.limit("operations", actor, 30, 60)
        command = self.service.commands.create_control(
            flow.strategy,
            flow.control,
            ControlInvocation(
                revision=flow.revision,
                request_id=f"tg:{update_id}",
                value=value,
                arguments=arguments or {},
            ),
            actor,
        )
        return self.operation(command, flow.user)
