"""Public HTTP payloads. Financial decimals travel as strings."""

import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    model_validator,
)

Key = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$")]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
ShortText = Annotated[str, StringConstraints(max_length=1000)]
Currency = Annotated[str, StringConstraints(pattern=r"^[A-Z0-9]{2,12}$")]
Number = Annotated[str, StringConstraints(pattern=r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?$", max_length=64)]


def parse_stamp(value):
    if isinstance(value, str) and re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
        r"(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})",
        value,
    ):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if not isinstance(value, datetime) or value.utcoffset() is None:
        raise ValueError("a timestamp with time zone is required")
    return value


Stamp = Annotated[
    datetime, BeforeValidator(parse_stamp), AfterValidator(lambda dt: dt.astimezone(timezone.utc))
]


def strict_version(value):
    if type(value) is not int:
        raise ValueError("schema_version must be the integer 1")
    return value


SchemaVersion = Annotated[Literal[1], BeforeValidator(strict_version)]
Scope = Literal["session", "telemetry", "control", "commands"]
Mode = Literal["live", "paper", "backtest"]
Disconnect = Literal["continue", "block_entry"]
Severity = Literal["debug", "info", "warning", "error", "critical"]
Category = Literal[
    "trade",
    "open",
    "close",
    "risk",
    "error",
    "warning",
    "log",
    "custom",
    "online",
    "offline",
    "authorization",
    "alert",
    "command",
]
TERMINAL = ("succeeded", "failed", "unknown", "expired", "superseded")
SHADOW_ACTIONS = {
    "pause_entry": ("entry_enabled", False),
    "resume_entry": ("entry_enabled", True),
}
STANDARD = frozenset(
    (
        *SHADOW_ACTIONS,
        "refresh",
        "set_parameters",
        "cancel_order",
        "close_position",
        "flatten",
    )
)
TRADE_ACTIONS = {"cancel_order", "close_position", "flatten", "buy", "sell"}
MANDATORY_CONFIRM = TRADE_ACTIONS | {"set_parameters"}
RESERVED_BINDINGS = {"set_trading_enabled"}
PROCESS_ACTIONS = {"start", "stop", "restart", "pause_strategy", "resume_strategy", "shell"}
RISK_ACTIONS = TRADE_ACTIONS | {"set_parameters"}
TARGET_FIELDS = {
    "cancel_order": "order_id",
    "close_position": "position_id",
    "buy": "symbol",
    "sell": "symbol",
}


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class AlertPolicy(Payload):
    enabled: bool = True
    minimum: Severity = "info"
    categories: list[Category] = Field(default_factory=list, max_length=14)


class StrategySettings(Payload):
    name: Name
    mode: Mode
    description: ShortText = ""
    group: Annotated[str, StringConstraints(max_length=100)] = ""
    tags: list[Name] = Field(default_factory=list, max_length=20)
    disconnect_policy: Disconnect = "continue"
    retention_days: int = Field(90, ge=1, le=3650)
    live_trading_enabled: bool = False
    alerts: AlertPolicy = Field(default_factory=AlertPolicy)


class TokenSettings(Payload):
    scopes: list[Scope] = Field(
        default_factory=lambda: ["session", "telemetry"], min_length=1, max_length=4
    )
    expires_at: Stamp | None = None

    @model_validator(mode="after")
    def check_scopes(self):
        if len(set(self.scopes)) != len(self.scopes) or "session" not in self.scopes:
            raise ValueError("scopes must be unique and include session")
        if "commands" in self.scopes and "control" not in self.scopes:
            raise ValueError("commands requires control")
        return self


class StrategyCreate(StrategySettings):
    token: TokenSettings = Field(default_factory=TokenSettings)


class Parameter(Payload):
    label: Name
    type: Literal["string", "integer", "decimal", "boolean", "choice"]
    required: bool = False
    default: str | int | bool | None = None
    minimum: Number | None = None
    maximum: Number | None = None
    choices: list[Name] = Field(default_factory=list, max_length=30)

    def accepts(self, value: object) -> bool:
        if self.type == "boolean":
            return type(value) is bool
        if self.type == "choice":
            return type(value) is str and value in self.choices
        if self.type == "string":
            return type(value) is str and 0 < len(value.strip()) <= 1000
        if self.type == "integer":
            if type(value) is not int or value.bit_length() > 53:
                return False
        else:
            if (
                type(value) is not str
                or not re.fullmatch(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?", value[:65])
                or len(value) > 64
            ):
                return False
        return (self.minimum is None or Decimal(value) >= Decimal(self.minimum)) and (
            self.maximum is None or Decimal(value) <= Decimal(self.maximum)
        )

    @model_validator(mode="after")
    def check_definition(self):
        if bool(self.choices) != (self.type == "choice"):
            raise ValueError("choices are required for choice parameters only")
        if self.minimum is not None or self.maximum is not None:
            if self.type not in {"integer", "decimal"}:
                raise ValueError("only numeric parameters accept bounds")
            if self.minimum is not None and self.maximum is not None:
                if Decimal(self.minimum) > Decimal(self.maximum):
                    raise ValueError("minimum exceeds maximum")
        if self.default is not None and not self.accepts(self.default):
            raise ValueError("invalid default")
        return self


class Capability(Payload):
    id: Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]{0,23}$")]
    label: Name
    parameters: dict[Key, Parameter] = Field(default_factory=dict, max_length=16)
    confirm: bool = False
    high_risk: bool = False

    @model_validator(mode="after")
    def check_definition(self):
        if self.id in PROCESS_ACTIONS:
            raise ValueError("Process and shell controls are not supported")
        if self.id in RESERVED_BINDINGS:
            raise ValueError("This action is reserved for the entry permission control")
        if self.id in SHADOW_ACTIONS and self.parameters:
            raise ValueError("persistent controls do not accept parameters")
        if self.id in TARGET_FIELDS:
            param = self.parameters.get(TARGET_FIELDS[self.id])
            if not param or not param.required or param.type not in {"string", "choice"}:
                raise ValueError(f"{self.id} requires {TARGET_FIELDS[self.id]}")
        if self.id in {"buy", "sell"}:
            quantity = self.parameters.get("quantity")
            if not quantity or not quantity.required or quantity.type != "decimal":
                raise ValueError("manual orders require a decimal quantity")
        return self


class SessionOpen(Payload):
    instance_id: Key
    executor: bool = False
    version: Name | None = None
    broker: Name | None = None
    language: Name | None = None
    framework: Name | None = None
    capabilities: list[Capability] = Field(default_factory=list, max_length=32)

    @model_validator(mode="after")
    def check_capabilities(self):
        if len({cap.id for cap in self.capabilities}) != len(self.capabilities):
            raise ValueError("duplicate capability")
        return self


class Heartbeat(Payload):
    health: Literal["healthy", "degraded", "error"] = "healthy"
    uptime_seconds: int | None = Field(None, ge=0)
    broker_connected: bool | None = None
    authorization_expires_at: Stamp | None = None


class Account(Payload):
    account_id: Key
    currency: Currency
    balance: Number | None = None
    cash: Number | None = None
    equity: Number | None = None
    buying_power: Number | None = None
    realized_pnl: Number | None = None
    unrealized_pnl: Number | None = None
    daily_pnl: Number | None = None


class Position(Payload):
    position_id: Key
    account_id: Key
    symbol: Name
    currency: Currency
    quantity: Number
    cost: Number | None = None
    market_price: Number | None = None
    unrealized_pnl: Number | None = None


OrderStatus = Literal[
    "new",
    "pending",
    "submitted",
    "open",
    "working",
    "partially_filled",
    "filled",
    "pending_cancel",
    "cancelled",
    "rejected",
    "expired",
]


class Order(Payload):
    order_id: Key
    account_id: Key
    symbol: Name
    currency: Currency
    quantity: Number
    filled_quantity: Number | None = None
    side: Literal["buy", "sell"]
    status: OrderStatus
    broker_status: Name | None = None
    price: Number | None = None
    fee: Number | None = None
    fee_currency: Currency | None = None
    updated_at: Stamp | None = None

    @model_validator(mode="after")
    def valid_quantity(self):
        quantity = Decimal(self.quantity)
        if quantity <= 0 or (
            self.filled_quantity is not None and not 0 <= Decimal(self.filled_quantity) <= quantity
        ):
            raise ValueError("order quantities are invalid")
        return self


class Fill(Payload):
    fill_id: Key
    order_id: Key
    account_id: Key
    symbol: Name
    currency: Currency
    side: Literal["buy", "sell"]
    quantity: Number
    price: Number
    fee: Number | None = None
    fee_currency: Currency | None = None
    occurred_at: Stamp

    @model_validator(mode="after")
    def positive_quantity(self):
        if Decimal(self.quantity) <= 0:
            raise ValueError("fill quantity must be positive")
        return self


class Performance(Payload):
    cumulative_return: Number | None = None
    daily_return: Number | None = None
    max_drawdown: Number | None = None
    sharpe_ratio: Number | None = None
    sortino_ratio: Number | None = None
    win_rate: Number | None = None
    profit_loss_ratio: Number | None = None
    profit_factor: Number | None = None


class Metric(Payload):
    name: Key
    value: Number
    unit: Name | None = None
    label: Name | None = None
    account_id: Key | None = None


def unique_records(items, *keys):
    identities = {tuple(getattr(item, key) for key in keys) for item in items}
    if len(identities) != len(items):
        raise ValueError(f"duplicate records by {', '.join(keys)}")


class Snapshot(Payload):
    type: Literal["snapshot"]
    schema_version: SchemaVersion
    observed_at: Stamp
    runtime: Heartbeat = Field(default_factory=Heartbeat)
    accounts: list[Account] = Field(default_factory=list, max_length=100)
    broker_positions: list[Position] = Field(default_factory=list, max_length=2000)
    strategy_positions: list[Position] = Field(default_factory=list, max_length=2000)
    open_orders: list[Order] = Field(default_factory=list, max_length=1000)
    completed_orders: list[Order] = Field(default_factory=list, max_length=1000)
    fills: list[Fill] = Field(default_factory=list, max_length=1000)
    performance: Performance = Field(default_factory=Performance)
    metrics: list[Metric] = Field(default_factory=list, max_length=100)
    attributes: dict[Key, ShortText | int | bool | None] = Field(
        default_factory=dict, max_length=100
    )

    @model_validator(mode="after")
    def unique_series(self):
        series = {(item.name, item.account_id, item.unit) for item in self.metrics}
        if len(series) != len(self.metrics):
            raise ValueError("duplicate metric series")
        accounts = {(item.account_id, item.currency) for item in self.accounts}
        if len(accounts) != len(self.accounts):
            raise ValueError("duplicate account and currency")
        unique_records(self.strategy_positions, "account_id", "position_id")
        unique_records(self.broker_positions, "account_id", "position_id")
        unique_records(self.open_orders + self.completed_orders, "account_id", "order_id")
        unique_records(self.fills, "account_id", "fill_id")
        return self


class EventMarker(Payload):
    kind: Literal["order", "fill", "signal", "risk"]
    symbol: Name
    side: Literal["buy", "sell"] | None = None
    price: Number | None = None
    order_id: Key | None = None


class Event(Payload):
    type: Literal["event"]
    schema_version: SchemaVersion
    id: Key
    occurred_at: Stamp
    category: Literal[
        "trade", "open", "close", "risk", "error", "warning", "log", "custom", "alert"
    ]
    severity: Severity = "info"
    message: Annotated[str, StringConstraints(min_length=1, max_length=4000)]
    attributes: dict[Key, ShortText | int | bool | None] = Field(
        default_factory=dict, max_length=100
    )
    fill: Fill | None = None
    marker: EventMarker | None = None
    dedup_key: Key | None = None

    @model_validator(mode="after")
    def matching_fill(self):
        if self.fill and self.fill.occurred_at != self.occurred_at:
            raise ValueError("fill timestamp must match occurred_at")
        return self


class Events(Payload):
    events: list[Event] = Field(min_length=1, max_length=200)


class MetricPoint(Metric):
    type: Literal["metric"]
    schema_version: SchemaVersion
    observed_at: Stamp


class Metrics(Payload):
    metrics: list[MetricPoint] = Field(min_length=1, max_length=500)


class ControlReport(Payload):
    revision: int = Field(ge=0)
    entry_enabled: bool
    risk_locked: bool
    disconnect_policy_applied: Disconnect


class CommandRequest(Payload):
    action: Key
    arguments: dict[Key, JsonValue] = Field(default_factory=dict, max_length=16)
    request_id: Key


class CommandResult(Payload):
    permit: Annotated[str, StringConstraints(min_length=32, max_length=100)]
    status: Literal["succeeded", "failed", "unknown"]
    result: JsonValue = None
    error: ShortText | None = None


class Reconciliation(Payload):
    status: Literal["succeeded", "failed"]
    evidence: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=3, max_length=1000)
    ]


class Login(Payload):
    username: Name
    password: Annotated[str, StringConstraints(min_length=1, max_length=1024)]


MIN_PASSWORD_LENGTH = 8
NewPassword = Annotated[str, StringConstraints(min_length=MIN_PASSWORD_LENGTH, max_length=1024)]


class SetupAdmin(Login):
    password: NewPassword
