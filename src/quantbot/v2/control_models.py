"""Versioned control declarations and state. Layout and code are server-owned."""

from typing import Annotated, Literal

from pydantic import Field, StringConstraints, TypeAdapter, model_validator

from .models import Key, Name, Number, Parameter, Payload, SchemaVersion, ShortText, Stamp

ENTRY_TOGGLE = "set_trading_enabled"
Numeric = int | float | Number
ControlValue = bool | str | int | float | None
FormValue = Annotated[dict[Key, ControlValue], Field(min_length=1, max_length=12)]
StateValue = ControlValue | FormValue
ControlID = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,31}$")]


class ControlGroup(Payload):
    id: ControlID
    label: Name
    order: int = Field(0, ge=0, le=1000)


class Definition(Payload):
    id: ControlID
    label: Name
    description: ShortText = ""
    group: ControlID | None = None
    order: int = Field(0, ge=0, le=1000)


class ActionDefinition(Definition):
    command: ControlID
    risk_level: Literal["low", "medium", "high"] = "low"
    confirm: bool = False


class Button(ActionDefinition):
    type: Literal["button"]


class SingleValue(ActionDefinition):
    parameter: Key | None = None


class Toggle(SingleValue):
    type: Literal["toggle"]
    default: bool | None = None


class Option(Payload):
    label: Name
    value: Name


class Select(SingleValue):
    type: Literal["select"]
    options: list[Option] = Field(min_length=2, max_length=20)
    default: Name | None = None

    @model_validator(mode="after")
    def unique(self):
        choices = {item.value for item in self.options}
        if len(choices) != len(self.options) or (
            self.default is not None and self.default not in choices
        ):
            raise ValueError("duplicate select option or invalid default")
        return self


class NumberControl(SingleValue):
    type: Literal["number"]
    min: Numeric | None = None
    max: Numeric | None = None
    step: Numeric | None = None
    default: Numeric | None = None
    integer: bool = False
    unit: Name | None = None


class Slider(NumberControl):
    type: Literal["slider"]
    min: Numeric
    max: Numeric
    step: Numeric


class Text(SingleValue):
    type: Literal["text"]
    max_length: int = Field(200, ge=1, le=1000)
    default: ShortText | None = None


class Form(ActionDefinition):
    type: Literal["form"]
    fields: dict[Key, Parameter] = Field(min_length=1, max_length=12)


class ReadOnly(Definition):
    type: Literal["readonly"]
    value_type: Literal["boolean", "text", "number"]
    unit: Name | None = None


ControlDefinition = Annotated[
    Button | Toggle | Select | NumberControl | Slider | Text | Form | ReadOnly,
    Field(discriminator="type"),
]
DEFINITION_SCHEMA = TypeAdapter(ControlDefinition)


class ControlRegistry(Payload):
    schema_version: SchemaVersion
    revision: int = Field(ge=1, le=2**31 - 1)
    groups: list[ControlGroup] = Field(default_factory=list, max_length=12)
    controls: list[ControlDefinition] = Field(max_length=40)

    @model_validator(mode="after")
    def unique(self):
        groups = {item.id for item in self.groups}
        if len(groups) != len(self.groups) or len({c.id for c in self.controls}) != len(
            self.controls
        ):
            raise ValueError("duplicate control or group ID")
        if any(item.group is not None and item.group not in groups for item in self.controls):
            raise ValueError("unknown control group")
        return self


class Disabled(Payload):
    disabled: bool
    reason: ShortText = ""


class ControlValues(Payload):
    revision: int = Field(ge=1, le=2**31 - 1)
    observed_at: Stamp
    values: dict[ControlID, StateValue] = Field(default_factory=dict, max_length=40)
    disabled: dict[ControlID, Disabled] = Field(default_factory=dict, max_length=40)

    @model_validator(mode="after")
    def has_changes(self):
        if not self.values and not self.disabled:
            raise ValueError("provide at least one value or disabled state")
        return self


class ControlInvocation(Payload):
    revision: int = Field(ge=1, le=2**31 - 1)
    request_id: Key
    value: ControlValue = None
    arguments: dict[Key, ControlValue] = Field(default_factory=dict, max_length=12)
