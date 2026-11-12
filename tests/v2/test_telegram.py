from types import SimpleNamespace
from unittest.mock import AsyncMock

from quantbot.v2.telegram_service import Delivery, TelegramInterface

from .test_control_plane import ADMIN, AGENT, Clock, client, connect, create, log_in, poll, report


def telegram_setup(http):
    response = http.put(
        ADMIN + "/telegram",
        json={
            "enabled": True,
            "admins": [101, 202],
            "bot_token": "123456:" + "x" * 33,
            "quiet_hours": {"start": "00:00", "end": "23:59"},
            "categories": ["risk", "command"],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["has_token"] and "bot_token" not in response.json()


def update(data, update_id, uid=101, chat="private"):
    query = SimpleNamespace(data=data, answer=AsyncMock(), edit_message_text=AsyncMock())
    return SimpleNamespace(
        callback_query=query,
        effective_user=SimpleNamespace(id=uid),
        effective_chat=SimpleNamespace(type=chat),
        effective_message=AsyncMock(),
        update_id=update_id,
    )


def test_telegram_dynamic_controls_confirmation_and_shared_receipt(tmp_path):
    with client(tmp_path / "bot.sqlite3", Clock()) as http:
        log_in(http)
        telegram_setup(http)
        sid, credential = create(http)
        headers, _ = connect(http, credential)
        report(http, headers)
        service = http.app.state.runtime
        interface = TelegramInterface(service, service.telegram, "https://testserver")

        unauthorized = update(f"a:{sid}:flatten", 0, uid=303)
        http.portal.call(interface.handle, unauthorized, None)
        unauthorized.callback_query.answer.assert_awaited_once_with(text="没有操作权限")
        assert http.get(ADMIN + "/commands").json() == []

        group = update(f"a:{sid}:flatten", 1, chat="group")
        http.portal.call(interface.handle, group, None)
        assert http.get(ADMIN + "/commands").json() == []

        page = update(f"s:{sid}", 2)
        http.portal.call(interface.handle, page, None)
        markup = page.callback_query.edit_message_text.await_args.kwargs["reply_markup"]
        callbacks = [item.callback_data for row in markup.inline_keyboard for item in row]
        assert f"a:{sid}:flatten" in callbacks
        assert f"a:{sid}:stop" not in callbacks
        assert all(len(value.encode()) <= 64 for value in callbacks)

        tap = update(f"a:{sid}:flatten", 3)
        http.portal.call(interface.handle, tap, None)
        command = http.get(ADMIN + "/commands").json()[0]
        assert command["actor"] == "telegram:101"
        assert command["state"] == "confirmation_required"
        assert poll(http, headers) == []
        cid = command["id"]
        confirm = update(f"confirm:{cid}", 4, uid=202)
        http.portal.call(interface.handle, confirm, None)
        assert http.get(f"{ADMIN}/commands/{cid}").json()["state"] == "confirmation_required"
        confirm = update(f"confirm:{cid}", 5)
        http.portal.call(interface.handle, confirm, None)
        assert poll(http, headers)[0]["id"] == cid
        permit = http.post(f"{AGENT}/commands/{cid}/claim", headers=headers).json()["permit"]
        operation = update(f"op:{cid}", 6)
        http.portal.call(interface.handle, operation, None)
        assert "执行中" in operation.callback_query.edit_message_text.await_args.args[0]
        receipt = http.post(
            f"{AGENT}/commands/{cid}/result",
            headers=headers,
            json={
                "permit": permit,
                "status": "succeeded",
                "result": {"simulation": "filled"},
            },
        )
        assert receipt.json()["state"] == "succeeded"
        http.portal.call(interface.handle, operation, None)
        assert "策略已确认成功" in operation.callback_query.edit_message_text.await_args.args[0]
        assert http.get(f"{ADMIN}/commands/{cid}").json() == receipt.json()

        pause = update(f"a:{sid}:pause_entry", 7)
        http.portal.call(interface.handle, pause, None)
        queued = http.get(ADMIN + "/commands").json()[0]
        assert queued["state"] == "pending"
        report(http, headers, queued["revision"], entry_enabled=False, risk_locked=True)
        assert http.get(f"{ADMIN}/commands/{queued['id']}").json()["state"] == "succeeded"


def test_delivery_and_one_use_login(tmp_path):
    clock = Clock()
    with client(tmp_path / "delivery.db", clock) as http:
        log_in(http)
        telegram_setup(http)
        sid, _ = create(http)
        service = http.app.state.runtime
        delivery = Delivery(service, service.telegram)
        fake = SimpleNamespace(send_message=AsyncMock())
        http.portal.call(service.strategies.alert, sid, "risk", "warning", "Risk test", "r1")
        http.portal.call(service.strategies.alert, sid, "risk", "warning", "Risk test", "r1")
        http.portal.call(delivery.send, fake)
        assert fake.send_message.await_count == 2
        assert all(
            item.kwargs["disable_notification"] for item in fake.send_message.await_args_list
        )
        http.portal.call(delivery.send, fake)
        assert fake.send_message.await_count == 2
        http.portal.call(service.strategies.alert, sid, "risk", "critical", "Critical test")
        clock.value += 5
        http.portal.call(delivery.send, fake)
        assert fake.send_message.await_count == 4
        assert not fake.send_message.await_args.kwargs["disable_notification"]

        ticket = http.portal.call(service.auth.login_link, "telegram:101")
        assert http.post(ADMIN + "/login/link", json={"ticket": ticket}).status_code == 200
        assert http.get(ADMIN + "/session").json()["actor"] == "telegram:101"
        assert http.post(ADMIN + "/login/link", json={"ticket": ticket}).status_code == 401
        assert (
            http.put(ADMIN + "/telegram", json={"enabled": False, "admins": [202]}).status_code
            == 200
        )
        assert http.get(ADMIN + "/session").status_code == 401


def callback_for(mock, label):
    keyboard = mock.await_args.kwargs["reply_markup"].inline_keyboard
    return next(item.callback_data for row in keyboard for item in row if item.text == label)


def message(text, uid=101, update_id=10):
    output = AsyncMock()
    output.text = text
    return SimpleNamespace(
        callback_query=None,
        effective_user=SimpleNamespace(id=uid),
        effective_chat=SimpleNamespace(type="private"),
        effective_message=output,
        update_id=update_id,
    )


def test_telegram_control_inputs_share_registry_and_reject_old_buttons(tmp_path):
    from .test_controls import CONTROLS, connect_controls, publish, state

    clock = Clock()
    with client(tmp_path / "telegram-controls.db", clock) as http:
        log_in(http)
        telegram_setup(http)
        sid, credential = create(http)
        headers = connect_controls(http, credential)
        report(http, headers)
        assert publish(http, headers).status_code == 200
        assert state(http, headers, {"rsi_period": 14}).status_code == 200
        service = http.app.state.runtime
        interface = TelegramInterface(service, service.telegram, "https://testserver")
        opening = update(f"controlpanel:{sid}", 11)
        http.portal.call(interface.handle, opening, None)
        # The parameters group is on page two because ungrouped components are ordered first.
        next_page = callback_for(opening.callback_query.edit_message_text, "下一页")
        paging = update(next_page, 12)
        http.portal.call(interface.handle, paging, None)
        token = callback_for(paging.callback_query.edit_message_text, "RSI")
        assert token.startswith("tc:") and len(token) < 40 and sid not in token
        other = update(token, 13, uid=202)
        http.portal.call(interface.handle, other, None)
        assert "其他用户" in other.callback_query.edit_message_text.await_args.args[0]
        prompt = update(token, 14)
        http.portal.call(interface.handle, prompt, None)
        assert "实际值 14" in prompt.callback_query.edit_message_text.await_args.args[0]
        invalid = message("99", update_id=15)
        http.portal.call(interface.handle, invalid, None)
        assert "allowed range" in invalid.effective_message.reply_text.await_args.args[0]
        submit = message("21", update_id=16)
        http.portal.call(interface.handle, submit, None)
        assert "等待确认" in submit.effective_message.reply_text.await_args.args[0]
        confirm = callback_for(submit.effective_message.reply_text, "确认执行")
        row = http.get(ADMIN + "/commands").json()[0]
        assert row["control_id"] == "rsi_period" and row["arguments"] == {"period": 21}
        assert poll(http, headers) == []
        approved = update(confirm, 17)
        http.portal.call(interface.handle, approved, None)
        assert poll(http, headers)[0]["id"] == row["id"]
        assert (
            http.get(f"{ADMIN}/strategies/{sid}/controls").json()["states"]["rsi_period"]["value"]
            == 14
        )

        opening = update(f"controlpanel:{sid}", 18)
        http.portal.call(interface.handle, opening, None)
        old = callback_for(opening.callback_query.edit_message_text, "Refresh")
        assert publish(http, headers, 2, CONTROLS[:-1]).status_code == 200
        old_update = update(old, 19)
        http.portal.call(interface.handle, old_update, None)
        assert "reload" in old_update.callback_query.edit_message_text.await_args.args[0]
        assert len(http.get(ADMIN + "/commands").json()) == 1


def test_telegram_form_cancel_invalidates_other_options(tmp_path):
    from .test_controls import connect_controls, publish

    with client(tmp_path / "form.db", Clock()) as http:
        log_in(http)
        telegram_setup(http)
        sid, credential = create(http)
        headers = connect_controls(http, credential)
        assert publish(http, headers).status_code == 200
        service = http.app.state.runtime
        interface = TelegramInterface(service, service.telegram, None)
        opening = update(f"controlpanel:{sid}", 31)
        http.portal.call(interface.handle, opening, None)
        start = update(callback_for(opening.callback_query.edit_message_text, "Tune"), 32)
        http.portal.call(interface.handle, start, None)
        assert "第 1/2 项" in start.callback_query.edit_message_text.await_args.args[0]
        option = callback_for(start.callback_query.edit_message_text, "使用默认值 / 跳过")
        cancel = update(callback_for(start.callback_query.edit_message_text, "取消并返回"), 33)
        http.portal.call(interface.handle, cancel, None)
        stale = update(option, 34)
        http.portal.call(interface.handle, stale, None)
        assert "过期" in stale.callback_query.edit_message_text.await_args.args[0]
        assert http.get(ADMIN + "/commands").json() == []
