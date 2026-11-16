# Agent troubleshooting

Compare the configured Agent URL with the **API** dialog in **Administration → Strategies**. For example, the local server uses `http://127.0.0.1:23456/api/agent`. Check connectivity with `GET /healthz`, then try an authenticated session request using the [paper strategy examples](INTEGRATION.md#try-the-protocol-on-a-paper-strategy).

| Symptom | Check |
| --- | --- |
| 401 | Use the Agent credential for `POST /api/agent/session` and the returned session Bearer for subsequent requests. Check scopes, expiration and revocation. |
| Browser login returns `origin_required` | Preserve the public `Host` and set `X-Forwarded-Proto` to the browser's scheme at the reverse proxy. |
| 409 | Check executor assignment, online presence, registry revision and boot identity. A failed claim provides no permission. |
| 422 | Inspect rejected record indices, observation timestamps and the declared value type. |
| 429 or 503 | Back off and retry the same batch IDs and contents. Honor `Retry-After` when present. |
| Strategy offline | Send a heartbeat more often than the 45-second presence window. |
| Data stale | Check the observed timestamp and the capability's `stale_after_seconds`. |
| Unknown command outcome | Reconcile with the strategy journal or broker records before issuing a replacement. |

Pass Authorization through the proxy, preserve the external host and scheme, and allow at least 25 seconds plus network latency for command polling. Redact credentials and permits from diagnostics. See the [Agent protocol](AGENT_PROTOCOL.md).
