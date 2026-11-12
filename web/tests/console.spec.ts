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
  await dialog.getByLabel("同步开仓权限").check();
  await dialog.getByLabel("领取一次性指令").check();
  await dialog.getByRole("button", { name: "创建并生成 Token" }).click();
  const token = await page.getByRole("dialog").locator("code").filter({ hasText: /^qb2_/ }).textContent();
  expect(token).toMatch(/^qb2_/);
  const session = await request.post("/api/v2/agent/session", {
    headers: { Authorization: `Bearer ${token}` },
    data: { instance_id: "browser-agent", executor: true,
      capabilities: [{ id: "pause_entry", label: "暂停新开仓" }] },
  });
  expect(session.ok()).toBeTruthy();
  const data = await session.json();
  const headers = { Authorization: `Bearer ${token}`, "X-Agent-Session": data.session_id };
  const reported = await request.post("/api/v2/agent/reports", { headers, data: { records: [{
    type: "portfolio", schema_version: 1, observed_at: new Date().toISOString(),
    accounts: [{ account_id: "paper", currency: "USD", equity: "100.01" }],
  }] } });
  expect(reported.ok()).toBeTruthy();
  await page.getByRole("button", { name: "完成" }).click();
  await expect(page.getByRole("heading", { name: "Web 回归策略" })).toBeVisible();
  await expect(page.getByText("browser-agent", { exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText(token!);
  await page.getByRole("link", { name: "远程控制" }).click();
  await page.getByRole("button", { name: /暂停新开仓/ }).click();
  await page.getByRole("button", { name: "提交请求" }).click();
  await expect(page.getByRole("dialog").getByText("等待策略", { exact: true })).toBeVisible();
  const control = await request.get("/api/v2/agent/control", { headers });
  expect(control.ok()).toBeTruthy();
  const desired = (await control.json()).desired;
  expect(desired.entry_enabled).toBe(false);
  const receipt = await request.put("/api/v2/agent/control/reported", {
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
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("link", { name: "API 接入", exact: true }).click();
  await expect(page.getByRole("heading", { name: "API 接入", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "数据类型与 JSON Schema" })).toBeVisible();
  await expect(page.getByText("/api/v2/agent/reports", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
