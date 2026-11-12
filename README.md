# QuantBot v2

QuantBot 是面向独立量化交易程序的 HTTP 监控与远程控制平台。Web 与 Telegram 共用策略身份、开仓权限、命令队列和回执。策略由用户部署，程序主动连接服务并上报标准数据。

## 本地运行

需要 Python 3.10+ 和 SQLite 3.35+。仓库包含已构建的 React 控制台。

```bash
uv sync --frozen
uv run quantbot admin
uv run quantbot serve
```

打开 [控制台](http://127.0.0.1:23456/ui/) 创建策略。在接入页面复制 API 地址和一次性显示的策略 Token。访问 [OpenAPI 交互文档](http://127.0.0.1:23456/docs) 和 [标准数据类型注册表](http://127.0.0.1:23456/api/v2/data-types)。

## 部署与升级

`install.sh` 安装或更新 QuantBot 服务 CLI。远程访问通过 HTTPS 反向代理，设置 `QB_PUBLIC_URL` 和可信代理地址 `QB_TRUST_PROXY`。服务默认监听 `127.0.0.1:23456`，数据库默认位于 `~/.local/share/quantbot/quantbot-v2.sqlite3`。

升级 v1 时先停止旧 QuantBot 服务，保留运行中的外部策略。使用 `quantbot migrate-v1 --from ~/.config/quantbot` 将身份和历史导入新数据库。旧数据目录保留，迁移另外创建私有备份。策略需签发新的 v2 Token 并改用 HTTP API。详见 [HTTP 接入协议](PROTOCOL.md) 与 [架构说明](DESIGN.md)。

## 验证

```bash
uv run pytest
uv run ruff check .
cd web
npm ci
npm run build
npx playwright install chromium
npm run test:e2e
```
