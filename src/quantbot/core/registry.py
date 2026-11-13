"""Standard telemetry types, storage, and compatible visualization components."""

import json
from collections import defaultdict
from decimal import Decimal, localcontext

from .auth import digest
from .dashboard_models import ControlWidget
from .db import encode, record, timestamp
from .errors import Problem
from .models import Event, EventMarker, MetricPoint
from .report_models import DATA_TYPES, REPORT_SCHEMA, EventRecord
from .strategies import OFFLINE_AFTER

# Only these components and renderers may be stored in a dashboard.
COMPONENTS = {
    "status": ("运行状态", "status", ["cards"]),
    "status_history": ("运行历史", "status", ["timeline"]),
    "accounts": ("账户资金", "portfolio", ["cards", "table"]),
    "positions": ("持仓", "position", ["table"]),
    "position_mix": ("持仓分布", "position", ["pie", "bar"]),
    "orders": ("订单", "order", ["table"]),
    "order_status": ("订单状态", "order", ["bar", "pie"]),
    "fills": ("成交记录", "fill", ["table"]),
    "fill_count": ("成交统计", "fill", ["bar", "line"]),
    "equity": ("账户净值", "equity", ["line", "area", "bar"]),
    "drawdown": ("回撤", "equity", ["area", "line"]),
    "returns": ("策略收益率", "performance", ["line", "area", "bar"]),
    "performance": ("绩效指标", "performance", ["cards", "table"]),
    "metric_cards": ("自定义指标", "metric", ["cards", "table"]),
    "metrics": ("指标时间序列", "metric", ["line", "area", "bar", "scatter"]),
    "candles": ("交易 K 线", "ohlcv", ["candlestick"]),
    "volume": ("市场成交量", "ohlcv", ["bar"]),
    "signals": ("交易信号", "signal", ["timeline", "table"]),
    "risk": ("风控记录", "risk", ["timeline", "table"]),
    "logs": ("策略日志", "log", ["timeline", "table"]),
    "connections": ("券商连接", "connection", ["cards", "timeline"]),
    "alerts": ("告警历史", "alert", ["timeline", "table"]),
}
MODES = {
    "status": "snapshot",
    "portfolio": "snapshot",
    "position": "snapshot",
    "order": "snapshot",
    "fill": "event",
    "equity": "series",
    "performance": "snapshot",
    "metric": "series",
    "ohlcv": "series",
    "signal": "event",
    "risk": "event",
    "log": "event",
    "connection": "snapshot",
    "alert": "event",
}
SECTION = {
    "status": ("runtime",),
    "portfolio": ("accounts",),
    "position": ("strategy_positions", "broker_positions"),
    "order": ("open_orders", "completed_orders"),
    "performance": ("performance",),
}
NAMED_SERIES = {
    "equity": {"account.equity"},
    "drawdown": {"account.drawdown", "performance.max_drawdown"},
    "returns": {"performance.cumulative_return", "performance.daily_return"},
}


def component_series(component, name):
    if component in NAMED_SERIES:
        return name in NAMED_SERIES[component] or (
            component == "drawdown" and name.startswith("account.drawdown.")
        )
    if component in {"metrics", "metric_cards"}:
        return not name.startswith(("account.", "performance."))
    return False


class Registry:
    def __init__(self, runtime):
        self.service = runtime
        self.db = runtime.db
        self.telemetry = runtime.telemetry
        self.strategies = runtime.strategies
        self.clock = runtime.clock

    @staticmethod
    def definition():
        return [
            {
                "type": kind,
                "schema_version": 1,
                "storage": MODES[kind],
                "schema": f"/api/schemas/{kind}",
                "components": [key for key, (_, source, _) in COMPONENTS.items() if source == kind],
                "timestamp": "observed_at",
            }
            for kind in DATA_TYPES
        ]

    def reject(self, sid, kinds):
        for kind in set(kinds):
            self.db.execute(
                """INSERT INTO schema_failures(strategy_id, type, observed_at) VALUES (?, ?, ?)
                   ON CONFLICT(strategy_id, type) DO UPDATE SET observed_at=excluded.observed_at,
                   count=count+1, active=1""",
                (sid, kind, self.clock()),
            )
        self.service.wake("telemetry")

    def clear_failures(self, sid, kinds):
        for kind in set(kinds):
            self.db.execute(
                "UPDATE schema_failures SET active=0 WHERE strategy_id=? AND type=?",
                (sid, kind),
            )

    def register_metrics(self, agent, definitions):
        sid, instance = agent["strategy_id"], agent["instance_id"]
        with self.db.transaction():
            for item in definitions.metrics:
                if item.name.startswith(("account.", "performance.")):
                    raise Problem(422, "This metric namespace is reserved")
                self.db.execute(
                    """INSERT INTO metric_definitions VALUES (?, ?, ?, ?, ?, ?)
                       ON CONFLICT(strategy_id, instance_id, name, account_id, unit) DO UPDATE
                       SET definition=excluded.definition""",
                    (
                        sid,
                        instance,
                        item.name,
                        item.account_id or "",
                        item.unit or "",
                        encode(item.model_dump(mode="json")),
                    ),
                )
        self.service.wake("metrics")
        return {"registered": len(definitions.metrics)}

    def reports(self, agent, batch):
        sid, instance = agent["strategy_id"], agent["instance_id"]
        cutoff = self.telemetry.cutoff(sid)
        counts = dict.fromkeys(("inserted", "duplicates", "ignored"), 0)
        with self.db.transaction():
            for item in batch.records:
                observed = self.telemetry.observation(item.observed_at)
                if observed < cutoff:
                    counts["ignored"] += 1
                    continue
                inserted = self.store(sid, instance, item, observed)
                counts["inserted" if inserted else "duplicates"] += 1
            self.clear_failures(sid, [item.type for item in batch.records])
        kinds = {item.type for item in batch.records}
        self.service.wake("metrics" if kinds <= {"metric", "equity", "ohlcv"} else "telemetry")
        return counts

    def store(self, sid, instance, item, observed):
        data = item.model_dump(mode="json")
        kind = item.type
        if isinstance(item, MetricPoint):
            return self.telemetry.sample(sid, instance, item, observed)
        if isinstance(item, EventRecord):
            return self.store_event(sid, instance, item, observed, data)
        series = ""
        if kind == "ohlcv":
            series = encode([item.symbol, item.interval_seconds])
        if kind == "equity":
            series = encode([item.account_id, item.currency])
        if not self.insert(sid, instance, kind, series, observed, data):
            return False
        if kind == "portfolio":
            self.account_samples(sid, instance, item.accounts, observed)
        elif kind == "equity":
            self.equity(
                sid, instance, item.account_id, item.currency, observed, item.value, item.drawdown
            )
        elif kind == "performance":
            self.performance_samples(sid, instance, item.performance, observed)
        elif kind == "status":
            fields = item.runtime.model_dump(mode="json", exclude_unset=True)
            self.apply_runtime(sid, instance, fields, observed)
        elif kind == "connection":
            fields = item.model_dump(
                mode="json",
                include={"broker_connected", "authorization_expires_at"},
                exclude_unset=True,
            )
            self.apply_runtime(sid, instance, fields, observed)
        return True

    def insert(self, sid, instance, kind, series, observed, data):
        payload = encode(data)
        key = (sid, instance, kind, series, observed)
        result = self.db.execute(
            "INSERT OR IGNORE INTO typed_reports VALUES (?, ?, ?, ?, ?, ?)", (*key, payload)
        )
        if result.rowcount:
            return True
        previous = self.db.one(
            """SELECT payload FROM typed_reports WHERE strategy_id=? AND instance_id=?
               AND type=? AND series=? AND observed_at=?""",
            key,
        )
        if previous["payload"] != payload:
            raise Problem(409, "The report key and timestamp already identify different data")
        return False

    def store_event(self, sid, instance, item, observed, data):
        kind = item.type
        marker = None
        fill = None
        attributes = {}
        if kind == "fill":
            fill = item.fill
            marker = EventMarker(
                kind="fill",
                symbol=fill.symbol,
                side=fill.side,
                price=fill.price,
                order_id=fill.order_id,
            )
            category, severity = "trade", "info"
            message = f"{fill.symbol} {fill.side} {fill.quantity} @ {fill.price} {fill.currency}"
        elif kind == "signal":
            category, severity = "custom", "info"
            marker = EventMarker(
                kind="signal",
                symbol=item.symbol,
                side={"buy": "buy", "sell": "sell"}.get(item.direction),
            )
            message = item.message or f"{item.name} · {item.symbol} · {item.direction}"
            attributes = {
                "signal": item.name,
                "direction": item.direction,
                "strength": item.strength,
            }
        else:
            category = kind
            severity = item.severity
            message = item.message
            if kind == "risk":
                attributes = {"code": item.code, "locked": item.locked}
                if item.symbol:
                    marker = EventMarker(kind="risk", symbol=item.symbol)
            elif kind == "alert":
                attributes = {"important": True, "code": item.code}
        event = Event(
            type="event",
            schema_version=1,
            id=item.id,
            occurred_at=item.observed_at,
            category=category,
            severity=severity,
            message=message,
            fill=fill,
            marker=marker,
            dedup_key=getattr(item, "dedup_key", None),
            attributes=attributes,
        )
        existing = self.db.one(
            """SELECT payload FROM typed_reports WHERE strategy_id=? AND type=? AND series=?
               ORDER BY observed_at DESC LIMIT 1""",
            (sid, kind, item.id),
        )
        if existing and existing["payload"] != encode(data):
            raise Problem(409, "Event ID already identifies a different typed report")
        if existing:
            return False
        if self.db.one(
            "SELECT 1 FROM report_event_ids WHERE strategy_id=? AND id=?", (sid, item.id)
        ):
            raise Problem(409, "Event ID already identifies a different typed report")
        self.telemetry.insert_event(sid, instance, event, observed)
        self.db.execute("INSERT INTO report_event_ids VALUES (?, ?, ?)", (sid, item.id, observed))
        return self.insert(sid, instance, kind, item.id, observed, data)

    def apply_runtime(self, sid, instance, fields, observed):
        if observed < self.clock() - OFFLINE_AFTER:
            return
        agent = self.db.one(
            "SELECT * FROM agent_instances WHERE strategy_id=? AND instance_id=?", (sid, instance)
        )
        self.strategies.update_runtime(agent, fields, observed)
        self.strategies.refresh_presence(sid)

    def from_snapshot(self, sid, instance, snapshot, observed):
        data = snapshot.model_dump(mode="json")
        for kind, keys in SECTION.items():
            if snapshot.model_fields_set.isdisjoint(keys):
                continue
            section = {
                "type": kind,
                "schema_version": 1,
                "observed_at": data["observed_at"],
                **{key: data[key] for key in keys},
            }
            added = self.insert(sid, instance, kind, "", observed, section)
            if added and kind == "status":
                fields = snapshot.runtime.model_dump(mode="json", exclude_unset=True)
                self.apply_runtime(sid, instance, fields, observed)
        # Explicitly reported fill records and markers are read from this snapshot as well.
        for fill in snapshot.fills:
            when = self.telemetry.observation(fill.occurred_at)
            if when >= self.telemetry.cutoff(sid):
                data = {
                    "type": "fill",
                    "schema_version": 1,
                    "id": "snapshot-fill-" + digest(encode([fill.account_id, fill.fill_id]))[:40],
                    "observed_at": fill.model_dump(mode="json")["occurred_at"],
                    "fill": fill.model_dump(mode="json"),
                }
                self.store(sid, instance, REPORT_SCHEMA.validate_python(data), when)

    def account_samples(self, sid, instance, accounts, observed):
        for account in accounts:
            if account.equity is not None:
                self.equity(
                    sid, instance, account.account_id, account.currency, observed, account.equity
                )

    def equity(self, sid, instance, account, unit, observed, value, drawdown=None):
        self.telemetry.insert_sample(
            sid, instance, "account.equity", account, unit, observed, value, "账户净值"
        )
        if drawdown is not None:
            self.telemetry.insert_sample(
                sid, instance, f"account.drawdown.{unit}", account, "%", observed, drawdown, "回撤"
            )

    def performance_samples(self, sid, instance, performance, observed):
        for name, value in performance.model_dump(exclude_none=True).items():
            unit = (
                "%"
                if name in {"cumulative_return", "daily_return", "max_drawdown", "win_rate"}
                else ""
            )
            self.telemetry.insert_sample(
                sid, instance, f"performance.{name}", "", unit, observed, value, None
            )

    def merge(self, sid, instance, snapshot):
        if not instance:
            return snapshot
        output = dict(snapshot or {})
        section_times = {}
        snapshot_time = (
            self.telemetry.timestamp_value(output["observed_at"]) if snapshot else float("-inf")
        )
        for kind, keys in SECTION.items():
            row = self.db.one(
                """SELECT payload, observed_at FROM typed_reports
                   WHERE strategy_id=? AND instance_id=? AND type=?
                   ORDER BY observed_at DESC LIMIT 1""",
                (sid, instance, kind),
            )
            if row:
                data = json.loads(row["payload"])
                section_times[kind] = data["observed_at"]
                output.update({key: data[key] for key in keys})
                self.newest(output, data["observed_at"])
            else:
                for key in keys:
                    output.pop(key, None)
        fills = self.db.all(
            """SELECT occurred_at, json_extract(payload, '$.fill') AS fill FROM strategy_events
               WHERE strategy_id=? AND instance_id=? AND json_type(payload, '$.fill')='object'
               ORDER BY occurred_at DESC LIMIT 40""",
            (sid, instance),
        )
        if fills:
            output["fills"] = [json.loads(item["fill"]) for item in fills]
            section_times["fill"] = timestamp(fills[0]["occurred_at"])
            self.newest(output, section_times["fill"])
        if snapshot and snapshot.get("metrics"):
            section_times["metric"] = timestamp(snapshot_time)
        if output:
            output["section_observed_at"] = section_times
        return output or None

    def newest(self, output, observed):
        prior = output.get("observed_at")
        if not prior or self.telemetry.timestamp_value(observed) > self.telemetry.timestamp_value(
            prior
        ):
            output["observed_at"] = observed

    def query(self, sid, kind, *, instance=None, start=None, end=None, series=None, limit=100):
        self.strategies.row(sid)
        rows = self.db.all(
            """SELECT * FROM typed_reports WHERE strategy_id=? AND type=?
               AND (? IS NULL OR instance_id=?) AND (? IS NULL OR series=?)
               AND (? IS NULL OR observed_at>=?) AND (? IS NULL OR observed_at<=?)
               ORDER BY observed_at DESC, instance_id, series LIMIT ?""",
            (sid, kind, instance, instance, series, series, start, start, end, end, limit),
        )
        return [{"instance_id": row["instance_id"], **json.loads(row["payload"])} for row in rows]

    def metric_sources(self, sid):
        rows = self.db.all(
            """SELECT strategy_id, instance_id, name, account_id, unit, max(label) AS label,
                      count(*) AS samples, max(observed_at) AS last
               FROM metric_samples WHERE strategy_id=?
               GROUP BY instance_id, name, account_id, unit
               ORDER BY last DESC LIMIT 1000""",
            (sid,),
        )
        result = []
        for row in rows:
            meta = self.db.one(
                """SELECT definition FROM metric_definitions WHERE strategy_id=? AND instance_id=?
                   AND name=? AND account_id=? AND unit=?""",
                tuple(row[k] for k in ("strategy_id", "instance_id", "name", "account_id", "unit")),
            )
            definition = json.loads(meta["definition"]) if meta else {}
            result.append(
                {
                    **record(row),
                    "last": timestamp(row["last"]),
                    "label": definition.get("label") or row["label"] or row["name"],
                    "kind": definition.get("kind", "gauge"),
                    "description": definition.get("description", ""),
                }
            )
        return result

    def candle_sources(self, sid):
        rows = self.db.all(
            """SELECT strategy_id, instance_id, series, count(*) AS samples,
                      max(observed_at) AS last
               FROM typed_reports WHERE strategy_id=? AND type='ohlcv'
               GROUP BY instance_id, series ORDER BY last DESC LIMIT 200""",
            (sid,),
        )
        return [
            {
                **record(row, omit=("series",), times=("last",)),
                "symbol": symbol,
                "interval_seconds": interval,
            }
            for row in rows
            for symbol, interval in [json.loads(row["series"])]
        ]

    def discover(self, sid):
        strategy = self.strategies.detail(sid)
        reports = {
            row["type"]: row
            for row in self.db.all(
                """SELECT type, count(*) AS samples, max(observed_at) AS last FROM typed_reports
               WHERE strategy_id=? GROUP BY type""",
                (sid,),
            )
        }
        rejected = {
            row["type"]: record(row, times=("observed_at",), omit=("strategy_id",))
            for row in self.db.all("SELECT * FROM schema_failures WHERE strategy_id=?", (sid,))
        }
        samples = self.metric_sources(sid)
        reported_types = set(reports)
        if any(component_series("metrics", item["name"]) for item in samples):
            reported_types.add("metric")
        candles = self.candle_sources(sid)
        self.discover_events(sid, reports)
        sections = strategy["snapshot"] or {}
        now = self.clock()
        available = []
        for component, (label, kind, charts) in COMPONENTS.items():
            series = [item for item in samples if component_series(component, item["name"])]
            bases = candles if kind == "ohlcv" else series
            observation = reports.get(kind)
            if component in NAMED_SERIES or kind == "metric":
                observation = (
                    None
                    if not series
                    else {
                        "samples": max(item["samples"] for item in series),
                        "last": max(
                            (item["last"] for item in series), key=self.telemetry.timestamp_value
                        ),
                    }
                )
            if kind == "ohlcv" and candles:
                observation = {
                    "samples": max(c["samples"] for c in candles),
                    "last": max((c["last"] for c in candles), key=self.telemetry.timestamp_value),
                }
            if not observation:
                continue
            last = observation["last"]
            last = timestamp(last) if isinstance(last, (int, float)) else last
            age = now - self.telemetry.timestamp_value(last)
            minimum = (
                2
                if component in {"status_history", "equity", "drawdown", "returns", "metrics"}
                else 1
            )
            has_data = observation["samples"] >= minimum
            if component == "position_mix":
                has_data = any(
                    row["market_price"] is not None
                    and Decimal(row["quantity"]) != 0
                    and Decimal(row["market_price"]) != 0
                    for row in sections.get("strategy_positions", [])
                )
            elif component == "order_status":
                has_data = bool(sections.get("open_orders") or sections.get("completed_orders"))
            elif component == "accounts":
                has_data = bool(sections.get("accounts"))
            elif component == "performance":
                has_data = any(
                    value is not None for value in sections.get("performance", {}).values()
                )
            ttl = (
                max((c["interval_seconds"] * 3 for c in candles), default=300)
                if (kind == "ohlcv")
                else 300
            )
            failure = rejected.get(kind)
            if failure and failure["active"]:
                state = "incompatible"
            elif not has_data:
                state = "insufficient"
            elif MODES[kind] != "event" and (age > ttl or strategy["status"] == "offline"):
                state = "stale"
            else:
                state = "ready"
            available.append(
                {
                    "id": component,
                    "label": label,
                    "type": kind,
                    "charts": charts,
                    "recommended_chart": charts[0],
                    "state": state,
                    "last_observed_at": last,
                    "sources": bases,
                },
            )
        return {
            "components": available,
            "reported_types": sorted(reported_types),
            "schema_failures": list(rejected.values()),
        }

    def discover_events(self, sid, reports):
        for kind, path, values in (
            ("risk", "$.category", ("risk",)),
            ("alert", "$.category", ("alert", "error", "warning")),
            ("log", "$.category", ("log", "error", "warning")),
            ("signal", "$.marker.kind", ("signal",)),
        ):
            stats = self.db.one(
                """SELECT count(*) AS samples, max(occurred_at) AS last FROM strategy_events
                   WHERE strategy_id=? AND json_extract(payload, ?) IN (?, ?, ?)""",
                (sid, path, *values, *[None] * (3 - len(values))),
            )
            if stats["samples"]:
                reports[kind] = stats
        stats = self.db.one(
            """SELECT count(*) AS samples, max(occurred_at) AS last FROM strategy_events
               WHERE strategy_id=? AND json_type(payload,'$.fill')='object'""",
            (sid,),
        )
        if stats["samples"]:
            reports["fill"] = stats

    def history(self, query):
        output = []
        for source in query.sources:
            self.strategies.row(source.strategy_id)
            rows = self.db.all(
                """SELECT observed_at, value FROM metric_samples
                   WHERE strategy_id=? AND instance_id=? AND name=? AND account_id=? AND unit=?
                   AND observed_at BETWEEN ? AND ? ORDER BY observed_at DESC LIMIT ?""",
                (
                    source.strategy_id,
                    source.instance_id,
                    source.name,
                    source.account_id,
                    source.unit,
                    query.start.timestamp(),
                    query.end.timestamp(),
                    100001 if query.bucket_seconds else query.limit,
                ),
            )
            if len(rows) > 100000:
                raise Problem(422, "Too many raw samples; select a shorter range")
            if query.bucket_seconds:
                points = self.aggregate(rows, query.bucket_seconds, query.aggregation, query.limit)
            else:
                points = [record(row, times=("observed_at",)) for row in reversed(rows)]
            output.append({"source": source.model_dump(), "points": points})
        return output

    @staticmethod
    def aggregate(rows, seconds, operation, limit):
        groups = defaultdict(list)
        for row in rows:
            key = int(row["observed_at"] // seconds) * seconds
            if key not in groups and len(groups) == limit:
                break
            groups[key].append(Decimal(row["value"]))
        points = []
        with localcontext() as context:
            context.prec = 84
            for key, values in reversed(list(groups.items())):
                if operation == "last":
                    value = values[0]
                elif operation == "min":
                    value = min(values)
                elif operation == "max":
                    value = max(values)
                elif operation == "sum":
                    value = sum(values, Decimal(0))
                else:
                    value = sum(values, Decimal(0)) / len(values)
                points.append({"observed_at": timestamp(key), "value": format(value, "f")})
        return points

    def dashboard(self, sid):
        self.strategies.row(sid)
        row = self.db.one("SELECT revision, widgets FROM dashboards WHERE strategy_id=?", (sid,))
        return (
            {"revision": row["revision"], "widgets": json.loads(row["widgets"])}
            if row
            else {
                "revision": 0,
                "widgets": [],
            }
        )

    def save_dashboard(self, sid, body, actor):
        with self.db.transaction():
            current = self.dashboard(sid)
            if body.revision != current["revision"]:
                raise Problem(409, "Dashboard changed in another session; reload before saving")
            existing = {item["id"]: item for item in current["widgets"]}
            available = {
                item["id"]
                for item in self.discover(sid)["components"]
                if item["state"] in {"ready", "stale"}
            }
            for widget in body.widgets:
                if isinstance(widget, ControlWidget):
                    continue
                if widget.chart not in COMPONENTS[widget.component][2]:
                    raise Problem(422, "Chart renderer is not compatible with this component")
                if widget.component not in available and (
                    existing.get(widget.id, {}).get("component") != widget.component
                ):
                    raise Problem(422, "This strategy has not reported data for the component")
                if any(
                    not component_series(widget.component, item.name) for item in widget.sources
                ):
                    raise Problem(422, "Metric source is not compatible with this component")
                for item in widget.sources:
                    self.strategies.row(item.strategy_id)
                if widget.candle and (
                    widget.component not in {"candles", "volume"}
                    or widget.candle.strategy_id != sid
                ):
                    raise Problem(422, "Invalid candle source for this component")
            revision = body.revision + 1
            widgets = body.model_dump(mode="json")["widgets"]
            self.db.execute(
                "INSERT OR REPLACE INTO dashboards VALUES (?, ?, ?)",
                (sid, revision, encode(widgets)),
            )
            self.strategies.audit(
                actor, "dashboard.save", sid, revision=revision, count=len(widgets)
            )
        self.service.wake()
        return self.dashboard(sid)

    def market(self, sid, instance, symbol, interval, start, end, limit):
        candles = self.query(
            sid,
            "ohlcv",
            instance=instance,
            series=encode([symbol, interval]),
            start=start,
            end=end,
            limit=limit,
        )
        rows = self.db.all(
            """SELECT payload FROM strategy_events WHERE strategy_id=? AND instance_id=?
               AND occurred_at BETWEEN ? AND ?
               AND (json_extract(payload, '$.marker.symbol')=?
                    OR json_extract(payload, '$.fill.symbol')=?)
               ORDER BY occurred_at DESC LIMIT 1000""",
            (sid, instance, start, end, symbol, symbol),
        )
        markers = []
        for row in rows:
            item = json.loads(row["payload"])
            marker = item.get("marker")
            if not marker and item.get("fill"):
                fill = item["fill"]
                marker = {
                    "kind": "fill",
                    "symbol": fill["symbol"],
                    "side": fill["side"],
                    "price": fill["price"],
                    "order_id": fill["order_id"],
                }
            if marker:
                markers.append(
                    {
                        "id": item["id"],
                        "occurred_at": item["occurred_at"],
                        "message": item["message"],
                        **marker,
                    }
                )
        # An order with an update timestamp can mark its report even without a separate event.
        orders = self.query(sid, "order", instance=instance, start=start, end=end, limit=250)
        seen = set()
        for entry in orders:
            for order in [*entry["open_orders"], *entry["completed_orders"]]:
                when = order["updated_at"]
                key = (order["account_id"], order["order_id"], when)
                if order["symbol"] != symbol or not when or key in seen:
                    continue
                if not start <= self.telemetry.timestamp_value(when) <= end:
                    continue
                seen.add(key)
                markers.append(
                    {
                        "id": order["order_id"],
                        "occurred_at": when,
                        "kind": "order",
                        "symbol": symbol,
                        "side": order["side"],
                        "price": order["price"],
                        "message": order["status"],
                    }
                )
        return {
            "candles": list(reversed(candles)),
            "markers": sorted(
                markers, key=lambda item: self.telemetry.timestamp_value(item["occurred_at"])
            )[:1500],
        }

    def component_data(self, sid, component, start, end, limit, bucket_seconds=3600):
        kind = COMPONENTS[component][1]
        strategy = self.strategies.detail(sid)
        instance = strategy["snapshot_instance_id"] or strategy["executor_id"]
        if component == "fill_count":
            if bucket_seconds not in {60, 300, 3600, 86400, 604800}:
                raise Problem(422, "Unsupported aggregation interval")
            rows = self.db.all(
                """SELECT cast(occurred_at / ? AS INTEGER) * ? AS observed_at,
                          json_extract(payload, '$.fill.side') AS side, count(*) AS value
                   FROM strategy_events WHERE strategy_id=? AND occurred_at BETWEEN ? AND ?
                     AND json_type(payload, '$.fill')='object'
                   GROUP BY observed_at, side ORDER BY observed_at DESC, side LIMIT ?""",
                (bucket_seconds, bucket_seconds, sid, start, end, limit),
            )
            return [
                {**record(row, times=("observed_at",)), "value": str(row["value"])}
                for row in reversed(rows)
            ]
        if kind in {"fill", "risk", "signal", "log", "alert"}:
            rows = self.db.all(
                """SELECT payload FROM strategy_events WHERE strategy_id=? AND occurred_at
                   BETWEEN ? AND ? AND CASE ?
                       WHEN 'fill' THEN json_type(payload,'$.fill')='object'
                       WHEN 'risk' THEN json_extract(payload,'$.category')='risk'
                       WHEN 'signal' THEN json_extract(payload,'$.marker.kind')='signal'
                       WHEN 'log' THEN json_extract(payload,'$.category')
                            IN ('log','error','warning')
                       WHEN 'alert' THEN json_extract(payload,'$.category')
                            IN ('alert','error','warning')
                   END ORDER BY occurred_at DESC LIMIT ?""",
                (sid, start, end, kind, limit),
            )
            return [json.loads(row["payload"]) for row in rows]
        if component in {"status_history", "connections"}:
            return self.query(sid, kind, instance=instance, start=start, end=end, limit=limit)
        if component == "metric_cards":
            return [
                row
                for row in self.telemetry.history(sid, start=start, end=end, limit=limit)
                if component_series(component, row["name"])
            ]
        return strategy["snapshot"] or {}
