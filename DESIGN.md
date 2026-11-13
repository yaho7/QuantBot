# QuantBot 架构

```text
独立策略 ── HTTP Bearer Token ── Agent API
                                     │
React ── 管理员 Cookie ── Admin API ──┼── 策略、标准数据、控制、告警服务
                                     │                    │
Telegram ── 授权私聊 ─────────────────┘                    └── SQLite
```

## 目录

| 路径 | 职责 |
|---|---|
| `src/quantbot/__main__.py` | 服务启动、管理员初始化和备份 |
| `src/quantbot/core/api.py`、`management.py`、`responses.py` | HTTP 路由、会话、系统设置和接口契约 |
| `src/quantbot/core/auth.py`、`strategies.py` | 独立认证、Token、实例、在线状态与开仓权限对账 |
| `src/quantbot/core/models.py`、`report_models.py`、`schemas.py` | 版本化报告、控件及操作数据类型 |
| `src/quantbot/core/telemetry.py`、`registry.py`、`dashboard_models.py` | 快照、事件、时序存储、可视化注册表和布局 |
| `src/quantbot/core/control_models.py`、`control_registry.py`、`commands.py` | 声明控件、实际值、命令队列、执行许可与回执 |
| `src/quantbot/core/telegram_*.py` | 授权交互、动态控件、通知及 Polling 生命周期 |
| `src/quantbot/core/db.py`、`runtime.py` | SQLite Schema、事务、备份、单进程锁和回收 |
| `web/src/console/`、`src/quantbot/web/` | React 源码和打包控制台 |
| `tests/integration/`、`web/tests/` | API、存储、模拟 Telegram 与浏览器回归 |
| `examples/`、`docs/`、`deploy/` | 普通 HTTP 示例、协议和部署文件 |

## 关键设计

- 策略凭据使用高熵随机值。SQLite 保存用于鉴权的摘要和一份供管理员查看的加密副本，解密密钥存放在独立的 `quantbot.key` 文件。Web 登录使用 scrypt 密码哈希、独立会话摘要和 HttpOnly Cookie。Telegram 接口通过私聊管理员 ID 鉴权。
- 单一执行实例以策略、实例、会话和权限绑定。交易指令领取在 SQLite 写事务中完成，一个命令只有一个执行许可。重启后缺少回执的已领取指令转为未知，策略负责交易端的幂等标识和人工核对。
- 期望开仓权限持久化，实际状态由实例回报。风险锁与连接状态分开显示。权限命令以实际回报修订为完成条件。离线策略在各自程序内执行。
- 控件定义按修订保存，最近实际值及禁用原因按组件和时间戳持久化。Web 和 Telegram 将相同定义转换为本地组件。策略提交的是受限 Schema，命令仍受服务端风控权限、确认和授权执行约束。
- 遥测以标准类型、实例和时间存储。事件 ID 在策略内去重。余额、价格和数量保留十进制表示。图表目录由成功写入的数据决定，渲染时使用相应组件的标准映射。已保存布局保留数据源、时间范围、组件类型及顺序。
- SQLite 单体使用 WAL 和进程锁。通知进度、布局、命令、期望状态和实际回报可从重启恢复。历史按策略设置的保留期清理，操作与审计独立保存。
- 服务默认监听本机。远程 HTTPS 由可信代理终止。策略消息与 UI 标签按纯文本处理。有限请求体、严格 Schema 和速率限制保护敏感端点。

设计参考了程序主动连接的监控方式、期望与实际上报状态分离、项目级凭据和显式遥测字段。 [Komari](https://github.com/komari-monitor/komari) · [Komari Agent](https://github.com/komari-monitor/komari-agent) · [AWS IoT Device Shadow](https://docs.aws.amazon.com/iot/latest/developerguide/device-shadow-document.html) · [AWS IoT Jobs](https://docs.aws.amazon.com/iot/latest/developerguide/iot-jobs.html) · [Sentry Projects](https://docs.sentry.io/product/projects/) · [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
