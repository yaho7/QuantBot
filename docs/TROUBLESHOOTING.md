# QuantBot 接入排查

从控制台复制完整 Endpoint，例如 `https://quantbot.example.com/api/agent`。将 Secret 填入策略配置，或通过 `QB_TOKEN` 传给示例脚本。Key 用于在控制台识别凭据。

下载 Web **API 接入** 页面提供的 Python 示例，或使用仓库中的 [Python 示例](../examples/http_agent.py)。仅对模拟盘策略运行 `--control`。

```bash
export QB_ENDPOINT=https://quantbot.example.com/api/agent
read -rs QB_TOKEN
export QB_TOKEN
python3 examples/http_agent.py --follow
```

失败时，示例输出可复制的 JSON 诊断，包含请求方法、路径、HTTP 状态、响应类型、错误类别及可用的追踪标识。分享诊断时可另附 Endpoint 和出错时间。凭据、响应原文和请求负载无需分享。

| 症状 | 分类 | 排查方式 |
| --- | --- | --- |
| DNS 失败 | `dns` | 确认策略机器能解析域名，检查容器 DNS。 |
| TLS 失败 | `tls` | 检查证书链、信任库、域名及系统时间。保留证书校验。 |
| QuantBot 401 | `authentication_failed` | 核对 Secret 是否属于该策略，凭据是否已撤销或过期。 |
| QuantBot 403 | `permission_denied` | 查看安全摘要，核对 Token 权限或授权执行实例。 |
| Cloudflare 1010 | `cloudflare_1010` | 按时间与 Ray ID 核查上游的客户端检查及安全策略。 |
| HTML 403 或登录页 | `upstream_http_error` 或 `redirect_rejected` | 核对 Endpoint、Cloudflare Access、WAF 与上游代理鉴权策略。 |
| QuantBot 409 | `state_conflict` | 会话结束时用原实例名重新注册。修订冲突时重新读取状态。交易命令结果按原记录核对。 |
| 413 | `batch_too_large` | 缩小批次，QuantBot JSON 请求体上限为 1 MiB。 |
| QuantBot 422 | `schema_mismatch` | 对照 JSON Schema 及诊断中的字段路径。 |
| 429 | `rate_limited` | 按 `Retry-After` 等待再发送。 |
| 502、503、504 | `gateway_unavailable` | 检查回源健康，采用有界退避重试。 |

## Cloudflare 与反向代理

策略请求应带应用程序标识 `User-Agent: QuantBot-Integration/1.0`。Cloudflare 1010 表示客户端特征检查拒绝了请求。确认是部署侧规则触发后，在受控环境中检查 API 路径的相关规则。对使用 Access 的部署，给策略配置该部署所需的服务鉴权。QuantBot 只观察到达应用的请求。 [Cloudflare 1010 文档](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)

部署的代理应透传 Host、HTTPS 协议、Authorization、X-Agent-Session 和响应诊断头。给命令长轮询留出至少 25 秒等待时间及网络余量。用 `GET /healthz` 验证回源，再用示例验证带认证的 Agent 请求。 [部署配置](DEPLOYMENT.md)
