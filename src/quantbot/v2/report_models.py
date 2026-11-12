"""Versioned records accepted by the canonical telemetry endpoint."""

from decimal import Decimal
from typing import Annotated, Literal

from pydantic import Field, TypeAdapter, model_validator

from .models import (
    Account,
    Currency,
    Fill,
    Heartbeat,
    Key,
    MetricPoint,
    Name,
    Number,
    Order,
    Payload,
    Performance,
    Position,
    SchemaVersion,
    Severity,
    ShortText,
    Stamp,
    unique_records,
)

DATA_TYPES = (
    "status",
    "portfolio",
    "position",
    "order",
    "fill",
    "equity",
    "performance",
    "metric",
    "ohlcv",
    "signal",
    "risk",
    "log",
    "connection",
    "alert",
)


class Record(Payload):
    schema_version: SchemaVersion
    observed_at: Stamp


class StatusRecord(Record):
    type: Literal["status"]
    runtime: Heartbeat


class PortfolioRecord(Record):
    type: Literal["portfolio"]
    accounts: list[Account] = Field(max_length=100)

    @model_validator(mode="after")
    def unique_accounts(self):
        if len({(a.account_id, a.currency) for a in self.accounts}) != len(self.accounts):
            raise ValueError("duplicate account and currency")
        return self


class PositionRecord(Record):
    type: Literal["position"]
    strategy_positions: list[Position] = Field(max_length=2000)
    broker_positions: list[Position] = Field(max_length=2000)

    @model_validator(mode="after")
    def unique_positions(self):
        unique_records(self.strategy_positions, "account_id", "position_id")
        unique_records(self.broker_positions, "account_id", "position_id")
        return self


class OrderRecord(Record):
    type: Literal["order"]
    open_orders: list[Order] = Field(max_length=1000)
    completed_orders: list[Order] = Field(max_length=1000)

    @model_validator(mode="after")
    def unique_orders(self):
        unique_records(self.open_orders + self.completed_orders, "account_id", "order_id")
        return self


class EquityRecord(Record):
    type: Literal["equity"]
    account_id: Key
    currency: Currency
    value: Number
    drawdown: Number | None = None


class PerformanceRecord(Record):
    type: Literal["performance"]
    performance: Performance


class OhlcvRecord(Record):
    type: Literal["ohlcv"]
    symbol: Name
    interval_seconds: int = Field(ge=1, le=2678400)
    open: Number
    high: Number
    low: Number
    close: Number
    volume: Number

    @model_validator(mode="after")
    def coherent_bar(self):
        low, high, opening, closing, volume = map(
            Decimal, (self.low, self.high, self.open, self.close, self.volume)
        )
        if not low <= min(opening, closing) <= max(opening, closing) <= high or volume < 0:
            raise ValueError("invalid candle price range or volume")
        if self.observed_at.microsecond:
            raise ValueError("candles require whole-second timestamps")
        return self


class EventRecord(Record):
    id: Key


class FillRecord(EventRecord):
    type: Literal["fill"]
    fill: Fill

    @model_validator(mode="after")
    def matching_time(self):
        if self.observed_at != self.fill.occurred_at:
            raise ValueError("fill timestamp must match observed_at")
        return self


class SignalRecord(EventRecord):
    type: Literal["signal"]
    symbol: Name
    name: Key
    direction: Literal["buy", "sell", "long", "short", "flat", "hold"]
    strength: Number | None = None
    message: ShortText = ""


class RiskRecord(EventRecord):
    type: Literal["risk"]
    code: Key
    severity: Severity = "warning"
    message: Annotated[str, Field(min_length=1, max_length=1000)]
    locked: bool | None = None
    symbol: Name | None = None
    dedup_key: Key | None = None


class LogRecord(EventRecord):
    type: Literal["log"]
    severity: Severity
    message: Annotated[str, Field(min_length=1, max_length=4000)]
    logger: Key | None = None


class ConnectionRecord(Record):
    type: Literal["connection"]
    broker_connected: bool
    authorization_expires_at: Stamp | None = None
    message: ShortText = ""


class AlertRecord(EventRecord):
    type: Literal["alert"]
    code: Key
    severity: Severity
    message: Annotated[str, Field(min_length=1, max_length=4000)]
    dedup_key: Key | None = None


TypedReport = Annotated[
    StatusRecord
    | PortfolioRecord
    | PositionRecord
    | OrderRecord
    | FillRecord
    | EquityRecord
    | PerformanceRecord
    | MetricPoint
    | OhlcvRecord
    | SignalRecord
    | RiskRecord
    | LogRecord
    | ConnectionRecord
    | AlertRecord,
    Field(discriminator="type"),
]
REPORT_SCHEMA = TypeAdapter(TypedReport)


class ReportBatch(Payload):
    records: list[TypedReport] = Field(min_length=1, max_length=250)


class MetricDefinition(Payload):
    name: Key
    label: Name
    unit: Name | None = None
    account_id: Key | None = None
    description: ShortText = ""
    kind: Literal["gauge", "counter", "ratio"] = "gauge"


class MetricDefinitions(Payload):
    metrics: list[MetricDefinition] = Field(min_length=1, max_length=100)
