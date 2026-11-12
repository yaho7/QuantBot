"""The Telegram side, without talking to Telegram."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, Mock

from telegram import Update
from telegram.ext import CallbackQueryHandler, CommandHandler

from quantbot.bot import COMMANDS, QuantBot, markup, silent
from quantbot.config import Settings, StrategyConfig
from quantbot.i18n import language


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


def test_app_wires_private_owner_only_commands(tmp_path: Path) -> None:
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

    for name in ("web", "positions", "flatten"):
        handler = next(h for h in handlers if isinstance(h, CommandHandler) and name in h.commands)
        for chat_type, user_id, allowed in (
            ("group", 42, False),
            ("private", 43, False),
            ("private", 42, True),
        ):
            update = Update.de_json(
                {
                    "update_id": 1,
                    "message": {
                        "message_id": 1,
                        "date": 1,
                        "from": {"id": user_id, "first_name": "Trader", "is_bot": False},
                        "chat": {"id": user_id, "type": chat_type},
                        "text": f"/{name}",
                        "entities": [{"offset": 0, "length": len(name) + 1, "type": "bot_command"}],
                    },
                },
                qg.app.bot,
            )
            assert bool(handler.filters.check_update(update)) is allowed


def test_group_web_and_trade_callback_do_not_execute(tmp_path: Path, monkeypatch) -> None:
    bot = QuantBot(Settings(None, 42, (), tmp_path))
    issue_link = Mock()
    tap = AsyncMock()
    monkeypatch.setattr(bot.web_auth, "link_token", issue_link)
    monkeypatch.setattr(bot.core, "tap", tap)
    query = Mock(answer=AsyncMock())
    update = Mock(
        effective_chat=Mock(type="supergroup"), effective_user=Mock(id=42), callback_query=query
    )
    asyncio.run(bot._web(update, None))
    asyncio.run(bot._tap(update, None))
    issue_link.assert_not_called()
    tap.assert_not_awaited()
    query.answer.assert_awaited_once()


def test_runs_without_telegram(tmp_path: Path) -> None:
    import json
    import urllib.request

    from quantbot.config import Store

    store = Store(tmp_path)
    settings = store.settings({})
    assert not settings.telegram
    qg = QuantBot(settings, store)
    assert qg.app is None

    async def main() -> None:
        running = asyncio.create_task(qg._run_without_telegram())
        url = f"http://127.0.0.1:{settings.port}"
        loop = asyncio.get_running_loop()
        for _ in range(50):
            try:
                body = await loop.run_in_executor(
                    None, lambda: urllib.request.urlopen(f"{url}/healthz", timeout=2).read()
                )
                break
            except OSError:
                await asyncio.sleep(0.05)
        assert json.loads(body) == {"ok": True}
        qg._hub_notice("A", "hello", "info", None)  # no Telegram: only the web feed
        assert qg.feed.items[-1]["text"] == "hello"
        data = store.read()
        data["telegram"] = {"token": "123456:" + "A" * 35, "owner_id": 42}
        store.write(data)
        qg.reload()  # Telegram was added: stop so the service restarts with it
        await asyncio.wait_for(running, 5)

    asyncio.run(main())


def test_telegram_callback_uses_the_current_language(tmp_path: Path) -> None:
    bot = QuantBot(Settings(None, None, (), tmp_path, language="en"))
    replies: list[str] = []

    async def menu() -> None:
        replies.append((await bot.core.home()).text)

    async def run() -> None:
        handler = bot._localized(menu)
        await handler()
        assert language() == "zh"
        bot.settings = replace(bot.settings, language="zh")
        await handler()

    asyncio.run(run())
    assert replies[0].startswith("No strategies yet.")
    assert replies[1].startswith("还没有策略。")
