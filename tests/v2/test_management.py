from .test_control_plane import ADMIN, AGENT, Clock, client, connect, create, issue, log_in


def test_archive_revokes_tokens_and_preserves_identity_and_history(tmp_path):
    with client(tmp_path / "archive.db", Clock()) as http:
        log_in(http)
        sid, credential = create(http)
        headers, _ = connect(http, credential)
        operation = issue(http, sid, "pause_entry").json()
        url = f"{ADMIN}/strategies/{sid}"
        assert http.delete(url).json()["archived_at"]
        assert http.get(ADMIN + "/strategies").json() == []
        assert http.get(ADMIN + "/strategies/archived").json()[0]["id"] == sid
        assert http.put(AGENT + "/heartbeat", headers=headers, json={}).status_code == 401
        assert http.get(f"{ADMIN}/commands/{operation['id']}").json()["state"] == "expired"
        restored = http.post(url + "/restore").json()
        assert restored["id"] == sid and restored["archived_at"] is None
        assert restored["control"]["desired"]["entry_enabled"] is False
        assert http.put(AGENT + "/heartbeat", headers=headers, json={}).status_code == 401


def test_change_password_revokes_old_admin_sessions(tmp_path):
    with client(tmp_path / "admin.db", Clock()) as http:
        log_in(http)
        prior = http.cookies.get("quantbot_v2_session")
        assert (
            http.put(
                ADMIN + "/system/password",
                json={
                    "current_password": "test-password-only",
                    "new_password": "test-new-password",
                },
            ).status_code
            == 200
        )
        assert http.cookies.get("quantbot_v2_session") != prior
        assert (
            http.post(
                ADMIN + "/login",
                json={
                    "username": "admin",
                    "password": "test-password-only",
                },
            ).status_code
            == 401
        )
        assert (
            http.post(
                ADMIN + "/login",
                json={
                    "username": "admin",
                    "password": "test-new-password",
                },
            ).status_code
            == 200
        )
        system = http.get(ADMIN + "/system").json()
        assert system["schema_version"] == 6 and system["counts"]["reports"] == 0
