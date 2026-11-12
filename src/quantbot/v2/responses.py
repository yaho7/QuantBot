"""Public response contracts for enrollment, telemetry, and command execution."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field, JsonValue

from .control_models import ControlDefinition, ControlGroup, Disabled, StateValue
from .models import (
    Capability,
    Disconnect,
    Heartbeat,
    Scope,
    SessionOpen,
    Stamp,
    StrategySettings,
)

ISOTime = Annotated[str, Field(json_schema_extra={"format": "date-time"})]
CommandState = Literal[
    "confirmation_required",
    "pending",
    "accepted",
    "executing",
    "succeeded",
    "failed",
    "unknown",
    "expired",
    "superseded",
    "cancelled",
]


class ValidationIssue(BaseModel):
    location: list[str | int]
    type: str


class Error(BaseModel):
    detail: str
    errors: list[ValidationIssue] | None = None


class Desired(BaseModel):
    revision: int
    entry_enabled: bool | None = None
    disconnect_policy: Disconnect
    updated_at: ISOTime


class Reported(BaseModel):
    revision: int
    entry_enabled: bool
    risk_locked: bool | None = None
    disconnect_policy_applied: Disconnect
    instance_id: str
    updated_at: ISOTime


class ControlView(BaseModel):
    desired: Desired
    reported: Reported | None
    reported_current: bool
    in_sync: bool
    effective_entry_enabled: bool | None


class AgentSession(BaseModel):
    strategy_id: str
    session_id: str
    instance_id: str
    executor: bool
    heartbeat_interval_seconds: int
    offline_after_seconds: int
    mode: Literal["live", "paper", "backtest"]
    control: ControlView


class HeartbeatAck(BaseModel):
    server_time: ISOTime
    control: ControlView


class SnapshotAck(BaseModel):
    current: bool
    observed_at: Stamp


class EventAck(BaseModel):
    accepted: list[str]
    duplicates: list[str]
    ignored: list[str]


class MetricsAck(BaseModel):
    inserted: int
    ignored: int


class ReportsAck(MetricsAck):
    duplicates: int


class MetricDefinitionsAck(BaseModel):
    registered: int


class CommandView(BaseModel):
    id: str
    strategy_id: str
    instance_id: str
    actor: str
    request_id: str
    action: str
    arguments: dict[str, JsonValue]
    state: CommandState
    protected: int
    risky: int
    revision: int | None
    created_at: ISOTime
    updated_at: ISOTime
    expires_at: ISOTime
    result: JsonValue
    error: str | None
    control_id: str | None
    control_revision: int | None


class CommandQueue(BaseModel):
    commands: list[CommandView]
    control: ControlView


class Permit(BaseModel):
    permit: str
    start_before: ISOTime
    server_time: ISOTime


class CredentialView(BaseModel):
    id: str
    strategy_id: str
    scopes: list[Scope]
    created_at: ISOTime
    expires_at: ISOTime | None
    revoked_at: ISOTime | None
    last_used_at: ISOTime | None


class CredentialIssued(CredentialView):
    token: str


class InstanceView(BaseModel):
    instance_id: str
    online: bool
    last_seen: ISOTime
    runtime: Heartbeat
    declarations: SessionOpen
    token_id: str


class StrategyView(StrategySettings):
    id: str
    status: Literal["online", "offline", "abnormal"]
    executor_id: str | None
    created_at: ISOTime
    last_seen: ISOTime | None
    archived_at: ISOTime | None


class StrategyDetail(StrategyView):
    control: ControlView
    snapshot: dict[str, JsonValue] | None
    snapshot_instance_id: str | None
    instances: list[InstanceView]
    capabilities: list[Capability]
    executor_online: bool


class StrategyCreated(BaseModel):
    strategy: StrategyDetail
    credential: CredentialIssued


class ComponentState(BaseModel):
    value: StateValue = None
    value_observed_at: ISOTime | None = None
    value_stale: bool = False
    disabled: Disabled | None = None
    disabled_observed_at: ISOTime | None = None
    disabled_stale: bool = False
    available: bool
    unavailable_reason: str | None
    confirmation_required: bool = False


class ControlCatalog(BaseModel):
    schema_version: Literal[1]
    revision: int
    groups: list[ControlGroup]
    controls: list[ControlDefinition]
    states: dict[str, ComponentState]
    updated_at: ISOTime | None
