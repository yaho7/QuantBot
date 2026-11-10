"""The Telegram side, without talking to Telegram."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from telegram.ext import CallbackQueryHandler, CommandHandler

from quantbot.bot import COMMANDS, QuantBot, markup, silent
from quantbot.config import Settings, StrategyConfig


def test_markup_and_quiet_hours() -> None:
    keyboard = markup([[("刷新", "h"), ("暂停", "p:a")], [("平仓", "t:x")]])
    assert keyboard is not None
    rows = keyboard.inline_keyboard
    assert [[b.callback_data for b in row] for row in rows] == [["h", "p:a"], ["t:x"]]
    assert markup([]) is None
    night, day = datetime(2026, 1, 1, 2), datetime(2026, 1, 1, 12)
    assert silent("trade", (23, 7), night) and not silent("trade", (23, 7), day)
    assert not silent("error", (23, 7), night) and not silent("alert", (23, 7), night)
    assert not silent("info", None, night)


def test_app_wires_owner_only_commands(tmp_path: Path) -> None:
    settings = Settings(
        tg_token="123456:" + "A" * 35,
        owner_id=42,
        strategies=(StrategyConfig("a", "A", "a" * 20),),
        data_dir=tmp_path,
    )
    qg = QuantBot(settings)
    handlers = [h for group in qg.app.handlers.values() for h in group]
    names = {c for h in handlers if isinstance(h, CommandHandler) for c in h.commands}
    assert {name for name, _ in COMMANDS} <= names | {"start"}
    assert all(h.filters is not None for h in handlers if isinstance(h, CommandHandler))
    assert any(isinstance(h, CallbackQueryHandler) for h in handlers)
    assert qg.core.allowed(42) and not qg.core.allowed(43)
