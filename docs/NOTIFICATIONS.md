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
