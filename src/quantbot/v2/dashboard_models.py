"""Administrator-owned dashboard layouts and bounded historical queries."""

from typing import Annotated, Literal

from pydantic import Field, model_validator

from .models import Key, Name, Payload, Stamp

Component = Literal[
    "status",
    "status_history",
    "accounts",
    "positions",
    "position_mix",
    "orders",
    "order_status",
    "fills",
    "fill_count",
    "equity",
    "drawdown",
    "returns",
    "performance",
    "metric_cards",
    "metrics",
    "candles",
    "volume",
    "signals",
    "risk",
    "logs",
    "connections",
    "alerts",
]
Chart = Literal[
    "table", "cards", "line", "area", "bar", "scatter", "pie", "candlestick", "timeline"
]


class Series(Payload):
    strategy_id: Key
    name: Key
    instance_id: Key
    account_id: Annotated[str, Field(max_length=64)] = ""
    unit: Annotated[str, Field(max_length=100)] = ""


class CandleSource(Payload):
    strategy_id: Key
    instance_id: Key
    symbol: Name
    interval_seconds: int = Field(ge=1, le=2678400)


class HistoryQuery(Payload):
    sources: list[Series] = Field(min_length=1, max_length=10)
    start: Stamp
    end: Stamp
    bucket_seconds: Literal[0, 60, 300, 3600, 86400, 604800] = 0
    aggregation: Literal["last", "mean", "min", "max", "sum"] = "last"
    limit: int = Field(500, ge=2, le=3000)

    @model_validator(mode="after")
    def order(self):
        if self.end < self.start:
            raise ValueError("history end must follow start")
        return self


class Widget(Payload):
    id: Key
    component: Component
    title: Name
    chart: Chart
    width: Literal[1, 2] = 1
    height: int = Field(320, ge=220, le=720)
    hours: Literal[1, 6, 24, 168, 720, 2160, 8760] = 24
    bucket_seconds: Literal[0, 60, 300, 3600, 86400, 604800] = 0
    aggregation: Literal["last", "mean", "min", "max", "sum"] = "last"
    sources: list[Series] = Field(default_factory=list, max_length=10)
    candle: CandleSource | None = None
    markers: bool = True


class Dashboard(Payload):
    revision: int = Field(ge=0)
    widgets: list[Widget] = Field(default_factory=list, max_length=24)

    @model_validator(mode="after")
    def widget_ids(self):
        if len({w.id for w in self.widgets}) != len(self.widgets):
            raise ValueError("widget IDs must be unique")
        return self
