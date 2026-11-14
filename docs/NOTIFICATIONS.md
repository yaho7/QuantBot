# Bot notifications

QuantBot uses [tx7do/go-utils/notify v0.0.7](https://github.com/tx7do/go-utils/tree/notify/v0.0.7/notify) for outbound bot message formats and webhook signatures. It can run in the Go service process.

| Channel | Credentials |
| --- | --- |
| Telegram Bot | BotFather token and numeric Chat ID or `@channel` |
| Feishu / Lark | Custom group bot HTTPS webhook URL and its signing secret when signature verification is enabled |
| WeCom | Enterprise WeChat group bot HTTPS webhook URL |
| DingTalk | Custom bot HTTPS webhook URL and its signing secret when signature verification is enabled |

The QuantBot adapter validates the supported official HTTPS endpoints, disables redirects, and verifies platform acknowledgement bodies before recording a successful send. An HTTP 200 response can still carry a platform error. Known throttling responses return a retryable result and preserve a provided retry delay. Errors outwardly expose a stable code without credentials or arbitrary upstream response text.

All four integrations are outbound delivery. Feishu and WeCom use group webhook bots. Telegram interactive controls require a separate update receiver and the shared QuantBot command policy.

The library's MIT notice is distributed in [tx7do-go-utils-notify.txt](licenses/tx7do-go-utils-notify.txt).

## Configuration and delivery

Use the authenticated `/api/admin/notifications` API to list channels or create a channel. A channel has a name, provider, enabled state, an event list and write-only credentials. Select any combination of `alert`, `risk`, `fill` and `command`. Telegram credentials use `token` and `chatId`. Group bot credentials use `webhook` and optional `secret`.

Use `PUT /api/admin/notifications/{id}` to update a channel. Omitting credentials keeps the existing destination. Changing credentials stops pending sends to that channel so queued messages cannot follow the new destination. `POST /api/admin/notifications/{id}/test` queues a fixed test message, even for a disabled channel. Check `GET /api/admin/notifications/{id}/deliveries` for delivery status, attempt count and errors. Delete a channel with `DELETE /api/admin/notifications/{id}`.

QuantBot encrypts bot credentials with AES-GCM. Durable alert, risk, fill and terminal command events enqueue notifications in the control database transaction. Fill messages contain a symbol and avoid account details. Delivery runs in the background and uses bounded automatic retries for transient failures. If a process crashes after an external service accepts a message and before QuantBot saves the receipt, the notification may be delivered again. Notification retries have no effect on trading commands.
