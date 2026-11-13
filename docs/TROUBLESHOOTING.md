# QuantBot troubleshooting

Copy the full endpoint from the console, for example `https://quantbot.example.com/api/agent`. Put the secret in the strategy configuration or pass it to the [Python example](../examples/http_agent.py) as `QB_TOKEN`. The key identifies the credential in the console. Use `--control` only with a paper strategy.

```bash
export QB_ENDPOINT=https://quantbot.example.com/api/agent
read -rs QB_TOKEN
export QB_TOKEN
python3 examples/http_agent.py --follow
```

On failure, the example prints JSON diagnostics with the method, path, HTTP status, response type, error class, and available trace IDs. Share the endpoint and time if helpful. Keep credentials, raw response bodies, and request payloads private.

| Symptom | Error class | What to check |
| --- | --- | --- |
| DNS failure | `dns` | Confirm the strategy host resolves the domain. Check container DNS. |
| TLS failure | `tls` | Check the certificate chain, trust store, hostname, and system time. Keep verification enabled. |
| QuantBot 401 | `authentication_failed` | Confirm the secret belongs to the strategy and remains active. |
| QuantBot 403 | `permission_denied` | Check token scopes and executor authorization. |
| Cloudflare 1010 | `cloudflare_1010` | Review upstream security checks using the time and Ray ID. |
| HTML 403 or login page | `upstream_http_error` or `redirect_rejected` | Check the endpoint, Cloudflare Access, WAF, and proxy authentication. |
| QuantBot 409 | `state_conflict` | Reopen expired sessions with the same instance ID. Read current state on revision conflicts. Reconcile trade outcomes against actual records. |
| 413 | `batch_too_large` | Shrink the batch. Production JSON is limited to 1 MiB, and Sandbox requests to 64 KiB. |
| QuantBot 422 | `schema_mismatch` | Compare the diagnostic field paths with the JSON Schema. |
| 429 | `rate_limited` | Wait for `Retry-After`. |
| 502, 503, 504 | `gateway_unavailable` | Check the origin and retry with bounded backoff. |

## Cloudflare and reverse proxies

Send `User-Agent: QuantBot-Integration/1.0`. Cloudflare 1010 indicates a client check rejected the request. Verify which deployment rule triggered the response and review that API path in a controlled environment. If the deployment uses Access, configure its service authentication on the strategy host. QuantBot only observes requests that reach the app. [Cloudflare 1010 documentation](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)

Forward the original host, HTTPS scheme, Authorization, X-Agent-Session, and response diagnostics. Allow at least 25 seconds plus network latency for command long polling. Check the origin with `GET /healthz`, then verify an authenticated Agent request. [Deployment guide](DEPLOYMENT.md)
