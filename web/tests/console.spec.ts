import { expect, test } from "@playwright/test";

test("creates a strategy, connects over HTTP and confirms the applied entry state", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/ui/");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
  await page.getByRole("button", { name: "添加策略", exact: true }).last().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("策略名称").fill("Web 回归策略");
  await expect(dialog.getByLabel("交易模式")).toHaveValue("paper");
  await expect(dialog.locator("input, select, textarea")).toHaveCount(2);
  await dialog.getByRole("button", { name: "创建并生成 Token" }).click();
  const basicToken = await dialog.locator("code").filter({ hasText: /^qb_/ }).textContent();
  expect(basicToken).toMatch(/^qb_/);
  await expect(dialog.getByRole("button", { name: "复制 AI 提示词" })).toBeVisible();
  await expect(dialog.locator(".agent-prompt")).toContainText("github.com/yaho7/QuantBot");
  await expect(dialog.locator(".agent-prompt")).toContainText("/api/agent/monitor/");
  await expect(dialog.locator(".agent-prompt")).not.toContainText(basicToken!);
  await expect(dialog.getByText(/request\("\/monitor\/my-program"/)).toBeHidden();
  await dialog.getByRole("button", { name: "完成" }).click();
  await expect(page.getByRole("heading", { name: "Web 回归策略" })).toBeVisible();
  const strategyId = decodeURIComponent(new URL(page.url()).hash.split("/")[1]!);
  const issued = await page.request.post(`/api/admin/strategies/${strategyId}/tokens`, {
    data: { scopes: ["session", "telemetry", "control", "commands"] },
  });
  expect(issued.status()).toBe(201);
  const token = (await issued.json()).token;
  const session = await request.post("/api/agent/session", {
    headers: { Authorization: `Bearer ${token}` },
    data: { instance_id: "browser-agent", executor: true,
      capabilities: [{ id: "pause_entry", label: "暂停新开仓" }] },
  });
  expect(session.ok()).toBeTruthy();
  const data = await session.json();
  const headers = { Authorization: `Bearer ${token}`, "X-Agent-Session": data.session_id };
  const reported = await request.post("/api/agent/reports", { headers, data: { records: [{
    type: "portfolio", schema_version: 1, observed_at: new Date().toISOString(),
    accounts: [{ account_id: "paper", currency: "USD", equity: "100.01" }],
  }] } });
  expect(reported.ok()).toBeTruthy();
  await expect(page.getByText("browser-agent", { exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(token!);
  await page.getByRole("link", { name: "远程控制" }).click();
  await page.getByRole("button", { name: /暂停新开仓/ }).click();
  await page.getByRole("button", { name: "提交请求" }).click();
  await expect(page.getByRole("dialog").getByText("等待策略", { exact: true })).toBeVisible();
  const control = await request.get("/api/agent/control", { headers });
  expect(control.ok()).toBeTruthy();
  const desired = (await control.json()).desired;
  expect(desired.entry_enabled).toBe(false);
  const receipt = await request.put("/api/agent/control/reported", {
    headers, data: { revision: desired.revision, entry_enabled: false, risk_locked: true,
      disconnect_policy_applied: "continue" },
  });
  expect(receipt.ok()).toBeTruthy();
  await expect(page.getByRole("dialog").getByText("策略确认成功", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect(page.getByText("已锁定", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "资金与绩效" }).click();
  await expect(page.getByText("100.01", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile navigation and API schema are accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/ui/");
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
  const added = await page.request.post("/api/admin/strategies", {
    data: { name: "手机连接状态", mode: "paper", group: "响应式布局" },
  });
  expect(added.ok()).toBeTruthy();
  const row = page.getByRole("row").filter({ hasText: "手机连接状态" });
  await expect(row.getByText("离线", { exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("link", { name: "API 接入", exact: true }).click();
  await expect(page.getByRole("heading", { name: "API 接入", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "数据类型与 JSON Schema" })).toBeVisible();
  await expect(page.getByText("/api/agent/reports", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("serves the original brand and remembers the appearance setting", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/ui/");
  const brand = page.getByRole("link", { name: "QuantBot 首页" }).locator(".brand-icon");
  await expect(brand).toHaveCSS("mask-image", /\/ui\/favicon\.svg/);
  const favicon = await page.request.get("/ui/favicon.svg");
  expect(favicon.ok()).toBe(true);
  expect(await favicon.text()).toContain('viewBox="0 0 174 223"');
  await expect(page.locator("html")).toHaveCSS("background-color", "rgb(16, 15, 15)");

  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("link", { name: "系统设置", exact: true }).click();
  const theme = page.getByLabel("主题");
  await theme.selectOption("light");
  await expect(page.locator("html")).toHaveCSS("background-color", "rgb(255, 252, 240)");
  await page.reload();
  await expect(theme).toHaveValue("light");
  await theme.selectOption("system");
  await expect(page.locator("html")).toHaveCSS("background-color", "rgb(16, 15, 15)");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveCSS("background-color", "rgb(255, 252, 240)");
});

test("registered controls render safely and retain the last reported state", async ({ page }) => {
  await page.goto("/ui/");
  const admin = page.request;
  const login = await admin.post("/api/admin/login", {
    data: { username: "admin", password: "browser-test-password" },
  });
  expect(login.ok()).toBeTruthy();
  const create = await admin.post("/api/admin/strategies", {
    data: { name: "SPCX 浏览器模拟", mode: "paper", token: { scopes: ["session", "telemetry", "control", "commands"] } },
  });
  const { strategy, credential } = await create.json();
  const token = { Authorization: `Bearer ${credential.token}` };
  const session = await admin.post("/api/agent/session", { headers: token, data: {
    instance_id: "spcx", executor: true,
    capabilities: [{ id: "set_rsi", label: "RSI", parameters: {
      period: { type: "integer", label: "周期", required: true, minimum: "5", maximum: "30" },
    } }],
  } });
  const headers = { ...token, "X-Agent-Session": (await session.json()).session_id };
  const registry = await admin.put("/api/agent/controls", { headers, data: {
    schema_version: 1, revision: 1,
    groups: [{ id: "parameters", label: "策略参数", order: 1 }],
    controls: [
      { id: "period", type: "number", group: "parameters", label: "RSI 周期", command: "set_rsi",
        min: 5, max: 30, step: 1, integer: true },
      { id: "text_only", type: "readonly", label: "<img src=x onerror=alert(1)>", value_type: "text" },
    ],
  } });
  expect(registry.ok()).toBeTruthy();
  await admin.put("/api/agent/control/reported", { headers, data: {
    revision: 0, entry_enabled: true, risk_locked: false, disconnect_policy_applied: "continue",
  } });
  await admin.put("/api/agent/controls/state", { headers, data: {
    revision: 1, observed_at: new Date().toISOString(), values: { period: 14 },
  } });
  await page.goto(`/ui/#strategy/${strategy.id}/control`);
  await page.reload();
  await expect(page.getByText("<img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
  await expect(page.locator("img[src=x]")).toHaveCount(0);
  await page.getByRole("button", { name: "修改 RSI 周期" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("请求数值").fill("20");
  await dialog.getByRole("button", { name: "提交请求" }).click();
  await expect(dialog.getByText("等待确认")).toBeVisible();
  await expect(page.locator(".control-card").filter({ hasText: "RSI 周期" })).toContainText("实际值 14");
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/confirm") && response.ok()),
    dialog.getByRole("button", { name: "确认执行" }).click(),
  ]);
  const poll = await admin.get("/api/agent/commands", { headers });
  const command = (await poll.json()).commands[0];
  expect(command.control_id).toBe("period");
  const claim = await admin.post(`/api/agent/commands/${command.id}/claim`, { headers });
  const { permit } = await claim.json();
  expect(permit).toBeTruthy();
  await admin.post(`/api/agent/commands/${command.id}/result`, { headers, data: { permit, status: "succeeded" } });
  await expect(dialog.getByText("策略确认成功")).toBeVisible();
  await expect(page.locator(".control-card").filter({ hasText: "RSI 周期" })).toContainText("实际值 14");
  await admin.put("/api/agent/controls/state", { headers, data: {
    revision: 1, observed_at: new Date().toISOString(), values: { period: 20 },
  } });
  await expect(page.locator(".control-card").filter({ hasText: "RSI 周期" })).toContainText("实际值 20");
});

test("builds a dashboard using real metrics, OHLCV, and chart markers", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const http = page.request;
  expect((await http.post("/api/admin/login", { data: { username: "admin", password: "browser-test-password" } })).ok()).toBeTruthy();
  const response = await http.post("/api/admin/strategies", { data: { name: "图表验收策略", mode: "paper" } });
  const { strategy, credential } = await response.json();
  await page.goto(`/ui/#strategy/${strategy.id}/charts`);
  await expect(page.getByText("等待标准数据上报", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "添加组件" })).toBeDisabled();

  const token = { Authorization: `Bearer ${credential.token}` };
  const session = await http.post("/api/agent/session", { headers: token, data: { instance_id: "history-agent" } });
  const headers = { ...token, "X-Agent-Session": (await session.json()).session_id };
  const time = Math.floor(Date.now() / 60000) * 60000;
  const observed = (offset: number) => new Date(time + offset).toISOString();
  const result = await http.post("/api/agent/reports", { headers, data: { records: [
    { type: "equity", schema_version: 1, observed_at: observed(-120000), account_id: "paper", currency: "USD", value: "1000.01" },
    { type: "equity", schema_version: 1, observed_at: observed(-60000), account_id: "paper", currency: "USD", value: "1001.24" },
    { type: "ohlcv", schema_version: 1, observed_at: observed(-120000), symbol: "SPY", interval_seconds: 60,
      open: "100", high: "105", low: "99", close: "103", volume: "210" },
    { type: "ohlcv", schema_version: 1, observed_at: observed(-60000), symbol: "SPY", interval_seconds: 60,
      open: "103", high: "106", low: "101", close: "105", volume: "180" },
    { type: "signal", schema_version: 1, observed_at: observed(-90000), id: "signal-1", symbol: "SPY", name: "entry", direction: "buy" },
  ] } });
  expect(result.ok()).toBeTruthy();
  await expect(page.getByRole("img", { name: "历史时间序列" })).toBeVisible();
  await page.getByRole("button", { name: "添加组件" }).click();
  await expect(page.getByRole("button", { name: "添加 持仓", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "添加 交易 K 线" }).click();
  await page.getByRole("button", { name: "应用组件配置" }).click();
  await page.getByRole("button", { name: "上移 交易 K 线" }).click();
  await page.getByRole("button", { name: "保存布局" }).click();
  await expect(page.getByRole("button", { name: "编辑布局" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("img", { name: "历史时间序列" })).toBeVisible();
  await expect(page.getByRole("img", { name: "交易 K 线" })).toBeVisible();
  await expect(page.getByText("订单、成交、信号与风控标记（1）")).toBeVisible();
  await expect(page.locator("[data-widget]").first()).toContainText("交易 K 线");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(errors).toEqual([]);
});
