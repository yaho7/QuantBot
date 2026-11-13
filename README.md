# QuantBot v2

QuantBot 是面向独立量化交易程序的 HTTP 监控与远程控制平台。程序主动连接、上报标准数据并领取远程指令。Web 和 Telegram 共用策略身份、交易权限、指令状态和回执。

- 策略身份、独立 Token、权限范围、轮换、撤销和连接诊断。
- 14 种标准数据类型和持久化历史。仪表盘按实际收到的数据提供 ECharts 图表、交易 K 线、成交与风控标记。
- 策略通过 HTTP 注册按钮、开关、下拉菜单、数值、滑块、文本、表单和只读控件。Web 与 Telegram 共用配置和实际状态。
- 开仓权限对账、单一授权执行实例、高风险二次确认、一次性执行许可、未知结果核对与审计。
- 策略自行部署，持续处理行情、持仓和本地风控。QuantBot 通过期望状态请求暂停或恢复新开仓。

## Docker Compose（推荐）

将以下内容保存为 `compose.yml`。Compose 会从 GitHub Packages 拉取镜像，数据存放在配置文件旁边的 `./data` 目录。

```yaml
services:
  quantbot:
    image: ghcr.io/yaho7/quantbot:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8888:8888"
    volumes:
      - ./data:/data
```

```bash
docker compose up -d
```

打开 [http://localhost:8888](http://localhost:8888)，按网页引导创建管理员。服务器部署时，可通过 SSH 转发本机的 8888 端口完成初始化。 [部署与更新](docs/DEPLOYMENT.md)

## 本地启动

需要 Python 3.11+、SQLite 3.35+。仓库包含已构建的 React 控制台。

```bash
uv sync --frozen
uv run quantbot serve
```

打开控制台，按网页引导创建管理员。在 **添加策略** 中输入名称和交易模式。只监控时选会话与上报权限。需要暂停和恢复时加开仓权限，需要领取一次性指令时加命令权限。将一次性显示的 Token 保存到策略自己的密钥配置。 [本地控制台](http://127.0.0.1:23456/ui/)

以下示例使用普通 Python 标准库。先在 Web 创建一个模拟盘策略并赋予相应权限。

```bash
export QB_URL=http://127.0.0.1:23456
read -rs QB_TOKEN
export QB_TOKEN
python3 examples/http_agent.py --control --follow
```

Web 将显示实例上线、模拟指标及已声明的控件。尝试修改 RSI 周期，确认后查看执行回执与独立的实际值上报。脚本使用自己的 SQLite 文件保存期望权限、本地回执及待补传遥测。 [完整 HTTP 示例](examples/http_agent.py)

## 文档

- [HTTP 协议、curl、标准报告、动态控制及命令示例](PROTOCOL.md)
- [OpenAPI 3.1](docs/openapi.json) · [JSON Schema](docs/schemas)
- [Telegram 配置、命令和推送](docs/TELEGRAM.md)
- [Docker、Linux 服务、HTTPS、备份和更新](docs/DEPLOYMENT.md)
- [目录结构、数据模型和安全边界](DESIGN.md)

运行中的服务还提供 `/docs`、`/openapi.json`、`/api/v2/data-types` 和 `/api/v2/schemas/{type}`。Web **API 接入** 页面可复制完整规范、接入示例和 AI 提示词。

## 开发验证

```bash
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run python scripts/export_api.py --check
uv build

cd web
npm ci
npm run build
npx playwright install chromium
npm run test:e2e
```

浏览器回归测试启动独立的本地 HTTP 服务和临时数据库。交易类验收使用模拟执行器。
