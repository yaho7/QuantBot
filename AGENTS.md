# QuantBot 3.0 完整重构开发任务书

## 0. 项目定位与总目标

**项目名称：QuantBot**

**QuantBot 仓库：**
https://github.com/yaho7/QuantBot

**重点参考项目：**

1. Komari 后端：https://github.com/komari-monitor/komari
2. Komari 管理后台：https://github.com/komari-monitor/komari-web
3. LuminaPlus 前台主题：https://github.com/shanyang242/Komari-Theme-LuminaPlus

本次任务不是修补、优化、渐进迁移，而是 **QuantBot 3.0 全面重构**。

请直接在当前仓库实施新的架构，重新实现前后端、数据库、API、动态控制、监控工作台、管理后台、主题插件及部署方案。

允许借鉴或依法复用参考项目的代码、UI 设计、组件实现和工程结构，但必须针对 QuantBot 的量化交易场景重新组织。

### 最终产品定位

QuantBot 是一个轻量级、自托管、与券商和策略语言无关的量化交易监控及远程控制平台。

用户可以将任意量化程序接入 QuantBot，实现：

- 策略运行状态监控
- 账户、资产、持仓、订单和收益监控
- 历史数据、图表和交易事件分析
- 动态参数与控制按钮
- 远程启动、暂停、恢复及其他策略声明的操作
- 命令确认、执行结果、审计及异常处理
- Telegram 等通知
- AI 辅助自动接入与 Sandbox 测试
- 用户自定义工作台布局
- 可安装、切换和更新的前台主题

平台本身不负责策略计算，不连接具体券商，不擅自执行交易。

### 五项不可妥协的架构要求

1. **Go 后端，单体模块化架构。**
2. **监控工作台与管理后台完全分离。**
3. **控制数据与高频指标数据独立存储。**
4. **前台采用 LuminaPlus 风格，支持独立主题插件包。**
5. **单二进制、单 Docker 容器即可部署。**

---

# 第一部分：项目重构原则

## 1.1 从零构建，不考虑历史兼容

本次按全新 QuantBot 3.0 产品实施。

明确要求：

- 不兼容旧 Python 后端。
- 不迁移旧 SQLite 数据库。
- 不保留旧 API 路径，仅因为历史原因。
- 不需要兼容旧 Token、Session 或客户端配置。
- 不需要保留旧版前端布局格式。
- 不编写历史数据迁移工具。
- 不同时维护 Go 和 Python 两套服务。
- 可以重新设计 API、协议和数据库表。

但是，必须保留 QuantBot 的**产品能力和交易安全目标**。

请在重构开始前梳理旧版的功能清单，形成新版本的功能验收表。

旧代码仅用于理解业务需求，不作为新架构的约束。

不要逐文件翻译 Python 代码，应根据新的架构重新设计。

## 1.2 不要过度设计

禁止为了架构完整性引入不必要的组件：

- 不使用微服务。
- 不强制 Redis。
- 不强制 PostgreSQL。
- 不使用 RabbitMQ、Kafka。
- 不使用 Celery。
- 不使用 Kubernetes。
- 不要求量化策略安装额外 Agent。
- 不要求用户安装 Python SDK、Go SDK 或其他开发包。
- 不引入重量级的后端插件运行时。
- 不引入不必要的抽象、工厂模式或服务容器。

优先选择 Go 标准库和成熟的轻量依赖。

任何新增依赖都必须说明它解决的具体问题。

---

# 第二部分：参考项目的复用要求

## 2.1 先完整考察 Komari 和 LuminaPlus

正式编写代码前，必须阅读以下源码。

### Komari 后端

重点：

- `internal/server/`
- `internal/metricstore/`
- `database/dbcore/`
- `database/models/theme.go`
- `web/api/admin/theme.go`
- `web/router/`

研究：

- Go 服务初始化与生命周期
- SQLite 连接管理与 WAL 配置
- 指标存储与普通业务数据库的分离
- 监控数据的批量写入
- 数据聚合、压缩、过期清理
- SSE/WebSocket 通信实现
- 主题 ZIP 包安装、校验、启用与删除
- 管理 API 分组
- 单容器和单二进制部署

### Komari 管理后台

重点：

- `src/pages/admin/_layout.tsx`
- `src/components/admin/AdminPanelBar.tsx`
- `src/config/menuConfig.json`
- `src/pages/admin/settings/`
- `src/pages/admin/dashboard/`
- `src/components/admin/dashboard/`

研究：

- 独立管理后台布局
- 左侧导航
- 设置页面分组
- 管理仪表盘
- 动态卡片与布局
- 统一间距
- 页面加载与反馈

### LuminaPlus

重点：

- `src/components/shell/`
- `src/components/node/`
- `src/pages/Home.tsx`
- `src/pages/Instance.tsx`
- `src/hooks/useViewMode.ts`
- `src/styles/tokens.css`
- `src/styles/surface.css`
- `src/styles/home.css`
- `src/dev/mockApi.ts`
- `komari-theme.json`

研究：

- 大卡片、紧凑卡片、迷你卡片、列表四种视图
- 首页整体排版
- 顶部总览指标
- 分组、筛选与排序
- 右侧悬浮快捷工具
- 浅色、深色和半透明表面
- 组件高度与布局密度
- 移动端响应式布局
- 图表的局部更新
- Mock 数据驱动的 UI 测试

## 2.2 复用优先级

按下列顺序实施：

1. 已有成熟、许可明确的组件，优先依法复用。
2. 组件与 QuantBot 业务差异较小时，改造后复用。
3. 业务差异明显时，复用设计规范和交互方法，重新实现。
4. 不要复制 Komari 的服务器监控业务模型。
5. 不要为复刻 Komari 而复制无关模块。

必须记录每个复用部分的来源、许可证和修改内容。

### 许可要求

Komari 服务端和 LuminaPlus 仓库标注为 MIT，但不能因此推定所有上游素材、继承代码和 Komari Web 的独立代码均获得同样授权。

复用前检查文件及依赖的许可来源。

保留必要的 MIT 许可证、版权声明、NOTICE 和第三方归属信息。

对来源不明确的代码或媒体素材，仅参考交互设计，独立实现。

**不允许直接把整个 Komari Web 或整个 LuminaPlus 仓库未经筛选复制进 QuantBot。**

## 2.3 参考版本

为了避免开发过程中参考代码发生变化，首次分析时记录：

- Komari 后端参考提交：`62af91037924057b961dff7b93beacd3f76a81e8`
- Komari Web 参考提交：`05c3bad5dedf42796aae3cc0a528f474a0860fc0`
- LuminaPlus 参考提交：`f479ff0bb298b1e9d2a27f0641ed6775c1c05180`

可以查看更新版本，但不得在实施中无记录地切换参考基线。

---

# 第三部分：Go 后端总体架构

## 3.1 技术栈

采用：

| 模块 | 技术 |
|---|---|
| 后端 | Go |
| HTTP | `net/http` + Chi |
| 数据库 | SQLite WAL |
| SQL | `database/sql` + sqlc |
| SQLite 驱动 | 优先评估 `mattn/go-sqlite3` |
| 实时 Web 数据 | SSE |
| Agent 命令获取 | HTTP 长轮询 |
| 后台任务 | Goroutine + Context |
| 内部事件 | 有界事件总线 |
| 静态前端 | `go:embed` |
| 性能调试 | `pprof` |
| 部署 | 单 Go 进程、单 Docker 容器 |

不要同时使用 Gin、Chi、Echo 等多个 HTTP 框架。

采用 `net/http` + Chi 是本项目明确的默认选择。

SQLite 驱动应做实际基准测试。若采用 CGO，必须提供可靠的 Linux amd64/arm64 Docker 构建；不得为了无 CGO 而未经测试牺牲存储性能。

## 3.2 Go 项目结构

建议：

```text
quantbot/
├── cmd/quantbot/main.go
├── internal/
│   ├── server/
│   ├── config/
│   ├── auth/
│   ├── strategy/
│   ├── agent/
│   ├── control/
│   ├── command/
│   ├── telemetry/
│   ├── metrics/
│   ├── realtime/
│   ├── dashboard/
│   ├── theme/
│   ├── sandbox/
│   ├── notification/
│   ├── audit/
│   └── storage/
│       ├── control/
│       ├── metrics/
│       └── migrations/
├── web/
│   ├── src/
│   │   ├── app/
│   │   ├── admin/
│   │   ├── components/
│   │   ├── themes/
│   │   └── shared/
│   └── package.json
├── docs/
├── tests/
├── go.mod
├── Dockerfile
└── compose.yml
```

这是模块划分参考，不要求机械创建空目录。

每个模块只负责自己的业务逻辑。

不同模块通过明确的 Go 接口和数据类型交互。

禁止在单体进程内部使用 HTTP 或 RPC 调用其他模块。

## 3.3 服务生命周期

严格实现：

1. 加载环境变量和配置。
2. 检查数据目录权限。
3. 初始化数据库。
4. 执行数据库版本迁移。
5. 检查密钥及加密配置。
6. 初始化策略与控制服务。
7. 初始化遥测写入服务。
8. 初始化实时事件中心。
9. 初始化主题管理器。
10. 启动通知适配器和后台任务。
11. 启动 HTTP 服务。

关闭时反向释放资源。

必须支持 SIGTERM、SIGINT 的优雅退出。

退出时停止接收新上报，等待已接收的持久化任务完成或明确失败，不得直接丢弃未确认的数据。

---

# 第四部分：数据库与性能架构

## 4.1 使用两个独立的 SQLite 数据库

默认目录：

```text
/data/
├── control.db
├── metrics.db
├── secrets/
├── themes/
└── backups/
```

### control.db

存储：

- 管理员账户
- 登录会话
- 策略
- Agent 实例及会话
- API Token 与权限
- 动态控件定义
- 期望状态
- 实际上报状态
- 命令
- 命令执行许可
- 命令状态转移
- 完整交易控制审计
- 订单与成交等重要业务事件
- 用户布局
- 已安装主题和主题配置
- 通知配置
- Sandbox 元数据
- 系统设置

### metrics.db

存储：

- 高频指标样本
- 账户权益时序
- 普通状态历史
- K线数据
- 指标定义
- 图表聚合数据
- 非关键监控日志
- 历史统计缓存

交易命令和关键审计不允许仅保存在 metrics.db。

## 4.2 SQLite 并发

两个数据库都采用 WAL 模式。

每个数据库设计独立的写入路径。

SQLite 仍然只有一个写入者，不能依靠增加大量写连接提升吞吐。

建议：

- control.db 使用短事务，避免持有写锁期间等待网络请求。
- metrics.db 使用有界批量写入队列。
- 读查询使用受控连接池。
- 设置合理 busy timeout。
- 定期监测 WAL 文件大小。
- 对长时间读事务设置限制。
- 明确磁盘满、数据库繁忙的错误处理。

不得让遥测队列积压导致控制请求长期等待。

## 4.3 遥测写入

采用：

```text
HTTP 接收
  → 身份校验
  → JSON Schema 校验
  → 数据分类
  → 有界队列
  → 批量事务
  → 持久化确认
  → ACK
```

优先参考 Komari 的 report batcher 设计。

但必须遵循 QuantBot 的确认语义：

- 普通指标可以批量提交。
- 关键交易记录必须可靠持久化。
- 请求不能在仅写入易失内存时宣称持久化成功。
- Queue Full 必须返回明确错误。
- 客户端可以安全重试。
- 重复记录不能重复插入或重复触发操作。

默认批次大小、队列长度、Flush 间隔必须可配置，并通过压力测试确定。

## 4.4 数据保留和聚合

采用原始数据 + 分层时间序列聚合：

- 原始采样
- 1分钟
- 5分钟
- 1小时
- 1天

不同记录类型采用不同保留策略。

不能把 K 线简单平均。

K线聚合规则为：

- Open：第一条
- High：最高
- Low：最低
- Close：最后一条
- Volume：求和

金额与数量使用十进制表示和计算，不能在业务控制流程中依赖二进制浮点数保证精确性。

历史图表应根据时间跨度和屏幕像素宽度请求合理数量的数据点。

---

# 第五部分：Agent 通信协议

## 5.1 完全语言无关

QuantBot 不要求策略程序安装任何特殊 SDK。

所有语言只需具备普通 HTTP 客户端即可接入。

必须提供可直接复制的：

- Python 示例
- JavaScript 示例
- Go 示例
- curl 示例

QuantBot 不接管策略进程，不执行策略用户代码，不自动连接券商。

## 5.2 统一 API

建议新版本使用 `/api/v1`。

主要接口：

```text
POST /api/v1/agent/session
PUT  /api/v1/agent/heartbeat
PUT  /api/v1/agent/snapshot
POST /api/v1/agent/reports

PUT  /api/v1/agent/controls
PUT  /api/v1/agent/controls/state

GET  /api/v1/agent/commands
POST /api/v1/agent/commands/{id}/claim
POST /api/v1/agent/commands/{id}/result
```

正式接口应使用 Bearer Token，临时 Agent 会话采用独立短期 Session。

策略注册后分配稳定的 Strategy ID。

Agent 实例还需要 Instance ID 与 Boot ID，能够区分进程重启和重复实例。

## 5.3 标准上报数据

至少支持：

- status
- connection
- portfolio
- equity
- position
- order
- fill
- performance
- metric
- ohlcv
- signal
- risk
- alert
- log

每种数据提供严格的版本化 Schema。

未知字段、非法类型、错误时间戳、重复 ID 的行为必须有明确协议定义。

上报结果应返回 inserted、duplicate、rejected 等统计，不允许无条件返回成功。

## 5.4 长轮询

Agent 主动获取命令。

服务端等待窗口最高建议 25 秒，实际值可配置。

命令不依赖网络连接本身存活。

断线重连后重新读取持久化命令状态。

不得因为服务器重启自动重新执行结果未知的实盘操作。

---

# 第六部分：交易控制核心

这部分优先保证正确性，再考虑性能。

## 6.1 完整命令状态机

必须明确定义：

```text
created
  → confirmation_required
  → pending
  → accepted
  → executing
  → succeeded / failed / unknown
```

同时支持：

- cancelled
- expired
- rejected

状态转移必须严格校验，不允许任意跳跃。

## 6.2 执行许可

对于有副作用的命令：

1. 用户发起。
2. 服务器验证身份和操作权限。
3. 检查策略能力声明。
4. 检查所需确认。
5. 服务器持久化命令。
6. Agent 领取命令。
7. Agent 原子领取执行许可。
8. Agent 实际执行。
9. Agent 提交执行结果。
10. 服务端记录最终结果与审计。

执行许可只能领取一次。

服务端只保存许可的安全摘要。

同一命令的重复请求必须具备幂等语义。

### 重要安全原则

- 提交命令不等于执行成功。
- 超时不等于执行失败。
- 无回执不能自动重试真实交易。
- 执行结果未知必须进入待核对状态。
- 停止新开仓不等于强制平仓。
- 控制系统不得绕过策略自身风控。
- 控制按钮必须显示期望状态与实际生效状态。
- 当策略离线时，不得显示虚假的已执行成功。

## 6.3 动态控件

量化程序能够通过 API 声明：

- Button
- Toggle
- Slider
- NumberInput
- TextInput
- Select
- MultiSelect
- Status
- MetricDisplay

每个控件支持：

- 唯一 ID
- 标题
- 描述
- 图标
- 分类
- 默认尺寸
- 是否只读
- 可用状态
- 参数范围
- 类型验证
- 风险等级
- 是否需要二次确认
- 操作超时
- 执行结果映射

注意区分：

**控件定义由策略提供；控件外观与布局由用户自定义。**

用户调整控件大小、颜色、标签和位置，不应该修改策略的底层控制协议或提升操作权限。

---

# 第七部分：前端技术栈

## 7.1 优先复用 LuminaPlus 的轻量技术方案

采用：

| 技术 | 用途 |
|---|---|
| React 19 | UI |
| TypeScript | 类型安全 |
| Vite | 构建 |
| Tailwind CSS 4 | 布局与样式 |
| React Router | 页面路由 |
| TanStack Query | 数据查询与缓存 |
| Radix UI | 无障碍交互控件 |
| Lucide React | 图标 |
| uPlot | 高频指标和净值趋势 |
| Lightweight Charts | K线等金融图表 |
| dnd-kit | 组件拖动与重排 |
| Sonner | 操作通知 |
| Zod | 客户端输入校验 |

不要同时安装多套功能重复的图表库、拖拽库或 UI 框架。

优先让 uPlot 负责普通时序曲线，Lightweight Charts 负责金融 K线。

不使用完整 Komari Web 的前端代码作为 QuantBot 管理后台的直接基础，除非逐项确认复用权限。

---

# 第八部分：监控工作台与管理后台分离

## 8.1 两套独立布局

必须提供：

**监控与控制工作台：**

```text
/
```

**管理后台：**

```text
/admin
```

二者共享账户、认证和后端 API，但拥有独立的导航及页面布局。

监控工作台采用 LuminaPlus 风格。

管理后台采用 Komari 式侧边栏布局。

监控工作台允许主题替换。

管理后台不受第三方主题替换。

## 8.2 监控页面路由

```text
/
├── strategies
├── strategies/:id
├── controls
├── activity
└── alerts
```

### 首页 `/`

显示：

1. QuantBot 名称及快捷工具
2. 在线策略数
3. 离线策略数
4. 异常策略数
5. 待确认指令数
6. 策略分组及筛选
7. 策略卡片列表
8. 最近告警和操作

首页不应首先显示大量 Token、设置和接入教程。

### 策略详情

参考 LuminaPlus 的实例详情布局，适配量化策略：

- 顶部：策略名称、状态、运行时长
- 第一组：账户权益、当日盈亏、回撤等
- 第二组：关键控制按钮
- 第三组：净值、绩效、K线及自定义指标
- 第四组：持仓和订单
- 第五组：事件、日志、风险记录

控制区域必须直接可见，不能藏在第六、第七个标签内。

## 8.3 管理后台路由

```text
/admin
├── dashboard
├── strategies
├── integration
├── notifications
├── themes
├── storage
├── audit
├── security
└── settings
```

建议侧栏宽 240px。

侧栏按功能分组：

**总览**
- 系统仪表盘

**管理**
- 策略管理
- API 与接入
- 通知渠道

**外观**
- 主题管理
- 默认布局

**系统**
- 数据与备份
- 审计日志
- 安全与账户
- 系统设置

底部固定：

- 返回工作台
- 版本信息

手机端侧边栏变为 Drawer。

---

# 第九部分：LuminaPlus 风格 UI 设计规范

## 9.1 不允许只换颜色

必须借鉴 LuminaPlus 的：

- 卡片信息密度
- 大小卡片组合
- 浅色与深色层级
- 标题与数据的相对位置
- 状态颜色
- 迷你图表
- 标签设计
- 分组筛选
- 顶部汇总
- 响应式排列
- 轻量交互反馈

不要机械复制服务器 CPU、流量、Ping 等字段。

应替换为量化策略相关数据。

## 9.2 统一尺寸

建议：

| 项目 | 默认值 |
|---|---|
| 内容最大宽度 | 1560px |
| 桌面水平边距 | 24～32px |
| 手机水平边距 | 12～16px |
| 卡片间距 | 12～16px |
| 卡片圆角 | 14px |
| 卡片内边距 | 16px |
| 页面主要区域间距 | 24px |
| 普通按钮高度 | 40px |
| 手机主要触控区 | 至少 44px |
| 主标题 | 24px |
| 卡片标题 | 14～16px |
| 主要数据 | 24～30px |
| 辅助文字 | 12～13px |

统一使用 CSS Design Tokens。

所有页面共享相同的间距、颜色、字号与交互状态标准。

## 9.3 组件对齐

强制要求：

- 页面标题与卡片容器左边缘对齐。
- 右侧操作入口与内容容器右边缘对齐。
- 同一行卡片顶部对齐。
- 相邻卡片尽量统一底边。
- 主要数值使用 tabular numbers，避免数字变化导致抖动。
- 卡片内标题左上、辅助状态右上。
- 主操作按钮尽量统一位于卡片底部。
- 文本不允许因数据暂缺导致布局大幅移动。
- 加载状态保持组件原始尺寸。

不要出现多个 Panel 层层嵌套，形成大量空白边框。

## 9.4 四种策略卡片模式

直接参考 LuminaPlus 的四种视图：

### Large

适合桌面宽屏。

显示完整状态、账户信息、净值摘要、风险与主要操作。

### Compact

默认推荐模式。

显示策略名称、在线状态、权益、收益、风险、快捷控制。

### Mini

用于同时监控大量策略。

仅显示名称、状态、关键数值和异常提示。

### List

桌面表格模式。

适合排序、筛选和大量策略。

手机端不强制提供 List。

视图切换入口应直接可见，保留用户偏好。

## 9.5 主题色与表面

优先参考 LuminaPlus 的 `tokens.css` 和 `surface.css`。

支持：

- Light
- Dark
- System
- Solid
- Glass

Glass 模式仅用于展示层。

默认使用 Solid，避免不必要的背景渲染开销。

允许用户选择背景图片。

视频背景设为可选高级功能，默认关闭，并在移动设备、低性能设备、省流量模式及减少动态效果时关闭。

不能因为动画和玻璃特效影响策略控制的可用性。

---

# 第十部分：iOS 小组件式自定义工作台

## 10.1 用户可以编辑组件

工作台提供「编辑布局」模式。

进入编辑后：

- 组件显示拖动手柄。
- 可以改变位置。
- 可以调整大小。
- 可以添加、删除组件。
- 可以恢复默认布局。
- 可以保存、取消修改。
- 支持撤销。
- 编辑时所有控制组件只读，禁止执行真实命令。

## 10.2 网格布局

建议：

- 桌面：12 列
- 平板：8 列
- 手机：4 列

支持尺寸：

- Small
- Medium
- Large
- Full

这些是语义尺寸，应根据断点换算为实际网格跨度。

使用 CSS Grid + dnd-kit。

优先参考 Komari 的 `DashboardBoard`、`layout.ts`、`placement.ts` 所采用的动态布局、自然高度测量和边缘对齐方法。

对于合法可复用部分可以移植；否则重新实现对应算法。

不能让卡片随意漂浮在像素坐标上。

拖动后自动吸附网格。

避免明显空洞、不规则底边和重叠。

## 10.3 动态控制组件

动态按钮支持用户自定义：

- 显示名称
- 图标
- 颜色
- 大小
- 排列位置
- 是否显示说明
- 紧凑/详细模式

但不允许用户仅通过 UI 配置将只读组件变成高权限操作。

不同尺寸显示不同密度的信息。

例如：

**小尺寸开仓组件**

- 当前开仓状态
- 一个操作入口

**大尺寸开仓组件**

- 期望状态
- 实际状态
- 最后同步时间
- 本地风控状态
- 操作按钮
- 执行反馈

动态组件可由策略注册，用户自行决定是否放入工作台。

所有用户布局保存到服务端。

---

# 第十一部分：主题插件系统（重点）

这是 QuantBot 3.0 的核心功能，不得简化成 CSS 配色切换。

## 11.1 目标

参考 Komari 的主题机制，允许用户安装第三方主题包。

主题可以更改监控工作台的：

- 页面布局
- 策略卡片样式
- 组件排布
- 颜色
- 字体
- 背景
- 卡片显示密度
- 监控展示方式
- 图表视觉
- 移动端样式

**主题不可替换管理后台、认证系统、服务端交易逻辑。**

核心管理后台必须永远可用。

## 11.2 内置主题

至少提供：

1. **Lumina**：以 LuminaPlus 为主要参考的默认主题。
2. **Classic**：简洁的系统默认主题，用于恢复与排障。

Lumina 是 QuantBot 的独立适配版本，不是直接把原 Komari 主题 ZIP 安装进 QuantBot。

保留必要第三方版权声明。

## 11.3 主题安装形式

支持上传 ZIP。

后续可以支持通过 GitHub Release 下载主题包，但第一版不得为了市场功能引入远程代码执行机制。

定义新的 QuantBot Theme Manifest。

建议：

```json
{
  "id": "lumina",
  "name": "Lumina",
  "version": "1.0.0",
  "author": "Theme Author",
  "description": "QuantBot monitoring theme",
  "engine": "quantbot-theme-v1",
  "type": "declarative",
  "entry": "theme.json",
  "preview": "preview.png",
  "minQuantBotVersion": "3.0.0",
  "settingsSchema": "settings.schema.json"
}
```

文件名：

```text
quantbot-theme.json
```

同时支持两种清晰区分的主题能力：

**A. Declarative Theme**

通过 JSON、CSS Token、组件布局配置、资源文件实现主题。

默认使用这种形式。

不执行第三方 JavaScript。

**B. Full Frontend Theme**

允许作者提供独立编译的前端展示包，实现类似 LuminaPlus 的完整页面设计。

必须在受限制的浏览器隔离环境中运行。

不能和管理后台共享可直接访问的执行环境。

不得把访问 Token、管理员 Cookie 内容、CSRF Token 或交易密钥交给主题脚本。

主题需要数据时，通过受控的 Host Bridge 读取授权范围内的数据。

主题需要执行操作时，只能向主应用请求打开由主应用渲染的可信控制流程，由主应用完成权限、确认及执行检查。

禁止第三方主题直接调用交易命令执行 API。

对于无法安全实现的高级主题能力，必须明确限制，而不是默认赋予全部权限。

## 11.4 主题包目录

例如：

```text
lumina-theme.zip
├── quantbot-theme.json
├── theme.json
├── settings.schema.json
├── preview.png
├── assets/
│   ├── styles.css
│   └── images/
└── LICENSE
```

Full Frontend Theme 可以额外包含编译后的静态 HTML/JS/CSS 资源，必须经过隔离加载。

## 11.5 主题安装流程

后台 `/admin/themes` 提供：

- 已安装主题
- 当前主题
- 主题预览
- 上传 ZIP
- 版本与作者信息
- 启用
- 禁用
- 更新
- 删除
- 主题设置
- 恢复默认主题

安装时必须验证：

- Manifest 格式
- 版本兼容
- 文件数量与压缩后大小限制
- ZIP 解压总大小
- Zip Slip 路径穿越
- 符号链接及特殊文件
- 重复路径与冲突文件名
- MIME 与资源类型
- 不允许访问主题目录外文件

不能先删除旧主题，再尝试安装新版。

应先解压到临时目录，完整验证后原子切换。

保留可回滚的前一版本。

## 11.6 主题安全边界

第三方主题不得拥有：

- 数据库连接
- 文件系统写权限
- 系统命令执行权限
- 读取密钥权限
- 自由调用管理员 API 的权限
- 直接操作交易命令的权限

对于包含 JavaScript 的完整主题包，优先采用独立、无同源权限的 sandbox iframe，通过严格的消息桥与主应用通信。

需要防御同源 Cookie、CSRF、跨框架消息伪造及恶意导航。

不能仅因为主题 ZIP 由管理员上传，就假设脚本天然安全。

主题数据能力应按最小权限开放。

主题切换失败时，应自动回退到内置 Classic 主题。

## 11.7 主题配置

参考 Komari 的 Managed Configuration 思路。

主题作者可以通过 Schema 声明设置项：

- switch
- select
- number
- text
- color
- image
- background
- slider

后台自动生成配置表单。

主题设置与 QuantBot 系统设置分开保存。

主题的设置变更只能影响展示，不得改变控制权限。

## 11.8 主题兼容与版本

主题 API 必须有独立版本。

例如：

```text
quantbot-theme-v1
```

主题包中声明兼容范围。

升级 QuantBot 时，不允许不加检查地加载不兼容主题。

应提供：

- 兼容版本检查
- 主题错误边界
- 主题加载失败回退
- 主题版本回滚
- 开发者调试日志

## 11.9 不要混淆主题与功能插件

QuantBot 3.0 的主题系统主要负责前端展示。

不需要在第一版实现任意后端插件或脚本执行市场。

通知渠道、数据库、交易能力仍然是 Go 核心模块。

不要为了主题机制照搬 Komari 完整的 JavaScript 插件运行时。

---

# 第十二部分：AI 接入与 Sandbox

## 12.1 接入目标

用户创建策略后，可以点击「复制 AI 接入提示词」。

系统自动生成：

- Strategy ID
- 临时 Sandbox Key
- Sandbox Endpoint
- 有效期
- QuantBot 协议文档链接
- 量化策略集成要求

AI 可以直接使用这些信息完成接入和测试。

## 12.2 Sandbox

临时测试 Key 默认有效 60 分钟。

支持：

- 自动生成
- 续期
- 提前撤销
- 过期失效
- 测试记录
- 接口验证
- 请求限流
- 全局资源上限

必须与正式控制系统隔离。

模拟成功不代表真实交易已经执行。

模拟控制不得调用真实券商接口。

## 12.3 接入测试范围

至少覆盖：

- Session
- Heartbeat
- Snapshot
- Reports
- Controls
- Control State
- Command Poll
- Claim
- Result

测试通过后主动提醒用户切换正式配置。

临时密钥到期后明确提示失效。

不应自动把 Sandbox 密钥提升为正式权限。

---

# 第十三部分：实时通信与性能优化

## 13.1 Web 工作台

使用 SSE 推送状态变更通知。

不要每次数据变化都刷新整个页面。

按策略和 Topic 推送：

- status
- telemetry
- controls
- commands
- alerts

服务端合并短时间内的重复更新。

前端只刷新受影响的数据查询或组件。

## 13.2 Agent

默认 HTTP 长轮询。

不要求 Agent 保持 WebSocket 长连接。

未来可增加 WebSocket 作为可选传输，但不得改变命令的持久化及幂等性语义。

## 13.3 前端性能

参考 LuminaPlus 的优化思路：

- React.memo
- 缓存计算结果
- 稳定组件 Key
- 图表按需挂载
- 大列表虚拟滚动
- 局部 Query 更新
- Skeleton 占位
- 减少 DOM 数量
- 只在必要时使用动画
- 不可见页面减少非关键刷新

优先减少不必要渲染，而不是为了性能引入复杂状态管理框架。

---

# 第十四部分：认证与安全

必须实现：

- 管理员首次初始化
- 安全密码哈希
- 登录会话管理
- HttpOnly Cookie
- CSRF 防护
- 登录限流
- Agent Token 权限范围
- Token 撤销
- 审计日志
- 可信反向代理配置
- 安全的来源与 Host 校验
- 敏感设置加密存储

工作台默认需要登录。

可以实现只读分享页面，但必须默认关闭，且脱敏。

不能公开 Token、账户机密、交易命令或完整隐私数据。

操作权限必须在服务端执行检查，不能只靠前端隐藏按钮。

---

# 第十五部分：部署与运维

## 15.1 部署目标

普通用户只需要：

```bash
docker compose up -d
```

不需要另外安装数据库、Redis、Nginx 或机器人网关。

一个容器提供：

- Go 后端
- React 前端
- Admin 后台
- Theme 静态资源
- Agent API

支持 amd64 和 arm64。

默认使用本地数据目录持久化。

## 15.2 原生部署

必须支持：

```bash
quantbot serve
quantbot version
quantbot backup
quantbot doctor
```

其中 doctor 用于检查：

- 数据目录权限
- 数据库健康
- 配置格式
- SQLite WAL
- 密钥文件
- 网络监听地址
- 主题状态
- 后台任务状态

## 15.3 反向代理

兼容：

- Caddy
- Nginx
- Cloudflare Tunnel
- 1Panel 反向代理

不得假设用户一定部署在 Cloudflare。

本地 HTTP 可以使用；公网登录、密钥传输和真实控制必须通过 HTTPS 或等价的安全传输通道。

不要默认信任所有 `X-Forwarded-*` 请求头。

---

# 第十六部分：性能测试与验收

## 16.1 后端

必须提供可重复运行的 Benchmark。

测试场景：

1. 空闲服务
2. 10 个 Agent
3. 100 个 Agent
4. 1000 个模拟 Agent
5. 高频遥测
6. 遥测与控制混合负载
7. 大量 SSE 订阅
8. SQLite 查询
9. 历史图表查询
10. 主题切换

记录：

- RSS 内存
- CPU
- 请求吞吐
- P50/P95/P99
- Agent 在线数量
- Queue 深度
- 数据库写入速度
- WAL 大小
- 数据丢失和重复情况

优先以 2 vCPU、2GB RAM 的普通 VPS 作为一组验收环境。

不能仅宣称 Go 比 Python 快，必须提供实际测量结果。

## 16.2 故障测试

至少覆盖：

- Agent 断线
- Agent 重复连接
- 网络延迟
- 命令重复领取
- 结果回执丢失
- 服务重启
- 数据库锁竞争
- 磁盘满
- Sandbox 过载
- 非法主题 ZIP
- 主题崩溃
- 不合法 Token
- 数据重复上报

重点验证交易命令不会因为恢复逻辑而被重复执行。

## 16.3 前端测试

使用 Playwright 检查：

- 390px 手机
- 430px 手机
- 768px 平板
- 1280px 桌面
- 1600px 桌面

每个视口检查：

- 工作台首页
- 策略卡片
- 策略详情
- 动态控制
- 编辑组件
- Admin 后台
- 主题管理
- 登录
- Sandbox

至少在明暗两种主题下截图。

检查：

- 对齐
- 间距
- 文字溢出
- 卡片高度
- 触控面积
- 拖拽
- 缩放
- 弹窗
- 控制反馈
- 图表性能

不要仅以构建成功作为 UI 验收完成标准。

---

# 第十七部分：完整交付标准

最终必须交付一个可运行的 QuantBot 3.0，而不是架构演示项目。

验收流程：

1. 启动服务。
2. 完成管理员初始化。
3. 创建策略。
4. 自动生成 Token。
5. 使用 AI 提示词接入测试程序。
6. Sandbox 验证通过。
7. 切换正式接入。
8. 策略持续上报数据。
9. 工作台实时显示状态和图表。
10. 策略注册动态按钮。
11. 用户自定义控件大小及位置。
12. 用户下发控制命令。
13. Agent 领取并执行。
14. Web 显示真实回执。
15. Admin 能查看完整审计。
16. 能安装第三方主题 ZIP。
17. 能切换、配置和删除主题。
18. 主题故障后能恢复默认界面。
19. 系统能够备份和恢复。
20. Docker 能在全新环境中完成部署。

此外应提供文档：

```text
docs/
├── ARCHITECTURE.md
├── API.md
├── AGENT_PROTOCOL.md
├── CONTROL_SECURITY.md
├── DATABASE.md
├── THEME_DEVELOPMENT.md
├── THEME_SECURITY.md
├── INTEGRATION.md
├── DEPLOYMENT.md
└── BENCHMARK.md
```

## 十八、开发执行要求

请按以下顺序实施：

### 阶段 A：设计与参考审查

阅读 Komari、Komari Web、LuminaPlus。

形成：

- 新架构说明
- 复用组件清单
- 第三方许可证清单
- UI 页面与路由清单
- 数据库 Schema
- API Schema
- 测试验收清单

### 阶段 B：Go 核心

实现：

- 应用生命周期
- 配置
- 数据库
- 身份验证
- 策略管理
- 命令状态机
- 动态控件
- Agent API

### 阶段 C：高性能监控

实现：

- 遥测
- 指标存储
- 数据聚合
- 历史查询
- 实时事件
- 压测工具

### 阶段 D：前端

实现：

- Lumina 风格监控首页
- 多种策略卡片
- 策略详情
- 动态控制
- iOS 式组件布局
- Komari 式管理后台

### 阶段 E：主题机制

实现：

- 内置主题
- Theme Manifest
- ZIP 安装
- 主题设置
- 主题安全边界
- 切换与回滚
- 完整前端主题的安全加载

### 阶段 F：完整功能

实现：

- Sandbox
- AI 接入
- 通知
- 安全
- 日志
- 备份
- 系统诊断

### 阶段 G：测试与发布

完成：

- Go 单元测试
- Go Race 测试
- 前端类型检查
- 前端单元测试
- Playwright
- 集成测试
- 压力测试
- Docker 构建
- 文档完善

---

# 十九、禁止事项

1. 不允许只做一个漂亮的静态前端。
2. 不允许用 Mock 数据代替正式业务实现。
3. 不允许直接把 Komari 服务器监控代码改名后当成 QuantBot。
4. 不允许为了视觉风格破坏控制交互。
5. 不允许绕过交易确认机制。
6. 不允许把重要交易记录写入会丢失的缓存后立即确认。
7. 不允许为每种聊天平台增加独立交易逻辑。
8. 不允许为每个量化策略安装独立网关或 Agent。
9. 不允许第三方主题直接访问管理 API 或真实交易密钥。
10. 不允许让第三方主题覆盖核心管理后台。
11. 不允许缺少主题故障回退机制。
12. 不允许在生产模式展示虚假交易数据。
13. 不允许引入无必要的微服务、消息队列和数据库。
14. 不允许只修改 README 后声称完成重构。
15. 不允许测试失败后直接跳过。
16. 不允许以 TODO、占位方法、空函数替代需求。
17. 不允许声称已经测试没有实际执行的场景。
18. 不允许未经确认复制许可不明确的第三方代码或素材。
19. 不允许为了兼容旧 Python 实现增加冗余抽象。
20. 不允许在完成新系统前破坏仓库的构建、测试或回退能力。

# 二十、最终完成标准

QuantBot 3.0 应当达到：

**产品体验：**
像 Komari + LuminaPlus 一样，开箱即用，监控面板整洁，管理后台清晰，主题可自由安装与切换。

**技术架构：**
像 Komari 一样，采用 Go 单体服务、简单部署、高效存储和稳定的后台管理体系。

**量化交易特性：**
保留独立策略运行、通用 HTTP 接入、动态控制、命令确认、幂等处理、交易安全和完整审计。

**扩展能力：**
用户可以开发和发布独立的 QuantBot 主题插件，策略开发者可以自行声明动态控件和遥测数据，而无需修改 QuantBot 核心代码。

**最终要求：请实际完成重构、运行服务、截图检查、执行测试并修复问题，不要只提供架构建议。**

如果部分功能因当前环境限制无法验证，应明确列出未验证项与原因，不得虚报完成。

优先保证所有核心功能完整运行，其次优化性能，最后打磨视觉细节。不要偏离本任务书自行增加功能。