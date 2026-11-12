"""Telegram access and delivery settings, kept separate from strategy credentials."""

import asyncio
import json
import re
from datetime import datetime
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, StringConstraints, field_validator

from .db import encode
from .errors import Problem
from .models import Category, Payload, Severity
from .strategies import SEVERITIES

UserID = Annotated[int, Field(gt=0, le=2**52 - 1)]
ClockTime = Annotated[str, StringConstraints(pattern=r"^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$")]
TG_TOKEN = re.compile(r"[0-9]{5,20}:[A-Za-z0-9_-]{25,100}")


class QuietHours(Payload):
    start: ClockTime
    end: ClockTime


class TelegramSettings(Payload):
    enabled: bool = False
    admins: list[UserID] = Field(default_factory=list, max_length=30)
    notify: bool = True
    minimum: Severity = "info"
    categories: list[Category] = Field(default_factory=list, max_length=14)
    quiet_hours: QuietHours | None = None
    timezone: Annotated[str, StringConstraints(max_length=64)] = "Asia/Shanghai"
    min_interval_seconds: int = Field(2, ge=1, le=300)

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ValueError, ZoneInfoNotFoundError):
            raise ValueError("Unknown IANA time zone") from None
        return value

    @field_validator("admins")
    @classmethod
    def unique_users(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("Duplicate Telegram user ID")
        return value


class TelegramUpdate(TelegramSettings):
    bot_token: Annotated[str, StringConstraints(max_length=128)] | None = None
    clear_token: bool = False


class TelegramConfig:
    def __init__(self, service, environment_token=None):
        self.service = service
        self.db = service.db
        self.environment_token = environment_token
        self.status = "disabled"
        self.connection_changed = asyncio.Event()

    def get(self):
        row = self.db.one("SELECT value FROM settings WHERE name='telegram'")
        return TelegramSettings.model_validate_json(row["value"]) if row else TelegramSettings()

    def token(self):
        if self.environment_token:
            return self.environment_token
        row = self.db.one("SELECT value FROM settings WHERE name='telegram_bot_token'")
        return row["value"] if row else None

    def public(self):
        return {
            **self.get().model_dump(mode="json"),
            "has_token": bool(self.token()),
            "token_source": "environment"
            if self.environment_token
            else "database"
            if self.token()
            else None,
            "connection_status": self.status,
        }

    def update(self, update, actor):
        secret = update.bot_token
        if secret is not None and not TG_TOKEN.fullmatch(secret):
            raise Problem(422, "Invalid Telegram Bot token format")
        if self.environment_token and (secret is not None or update.clear_token):
            raise Problem(409, "Telegram token is managed by the server environment")
        if update.clear_token and secret is not None:
            raise Problem(422, "Provide a replacement token or clear the current one")
        if update.enabled and (
            not update.admins or not (secret or (self.token() and not update.clear_token))
        ):
            raise Problem(422, "A bot token and an authorized Telegram user are required")
        settings = update.model_dump(mode="json", exclude={"bot_token", "clear_token"})
        old_token = self.token()
        with self.db.transaction():
            self.db.execute(
                "INSERT OR REPLACE INTO settings VALUES ('telegram', ?)", (encode(settings),)
            )
            if secret:
                self.db.execute(
                    "INSERT OR REPLACE INTO settings VALUES ('telegram_bot_token', ?)", (secret,)
                )
            elif update.clear_token:
                self.db.execute("DELETE FROM settings WHERE name='telegram_bot_token'")
            cursor = self.db.one("SELECT coalesce(max(id), 0) AS id FROM alerts")["id"]
            existing = {
                row["user_id"] for row in self.db.all("SELECT user_id FROM telegram_cursors")
            }
            for user_id in existing - set(update.admins):
                self.db.execute("DELETE FROM telegram_cursors WHERE user_id=?", (user_id,))
                self.db.execute(
                    "DELETE FROM admin_sessions WHERE actor=?", (f"telegram:{user_id}",)
                )
                self.db.execute("DELETE FROM login_links WHERE actor=?", (f"telegram:{user_id}",))
            for user_id in set(update.admins) - existing:
                self.db.execute(
                    "INSERT INTO telegram_cursors(user_id, alert_id) VALUES (?, ?)",
                    (user_id, cursor),
                )
            self.service.strategies.audit(
                actor,
                "telegram.settings",
                settings=settings,
                token_changed=old_token != self.token(),
            )
        self.connection_changed.set()
        self.service.wake()
        return self.public()

    def notice_allowed(self, settings, row):
        return (
            settings.notify
            and SEVERITIES.index(row["severity"]) >= SEVERITIES.index(settings.minimum)
            and (not settings.categories or row["category"] in settings.categories)
        )

    def silent(self, settings, row):
        if settings.quiet_hours is None or row["severity"] in {"error", "critical"}:
            return False
        hours = settings.quiet_hours
        now = datetime.fromtimestamp(self.service.clock(), ZoneInfo(settings.timezone)).strftime(
            "%H:%M"
        )
        if hours.start <= hours.end:
            return hours.start <= now < hours.end
        return now >= hours.start or now < hours.end

    def selection(self, user_id, sid=None):
        key = f"telegram_selection:{user_id}"
        if sid:
            self.db.execute("INSERT OR REPLACE INTO settings VALUES (?, ?)", (key, encode(sid)))
            return sid
        row = self.db.one("SELECT value FROM settings WHERE name=?", (key,))
        return json.loads(row["value"]) if row else None
