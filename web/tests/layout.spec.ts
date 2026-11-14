import { expect, test } from "@playwright/test";

test("aligns workbench controls and keeps the grid inside each supported viewport", async ({ page }, testInfo) => {
  const http = page.request;
  expect((await http.post("/api/admin/login", { data: { username: "admin", password: "browser-test-password" } })).ok()).toBeTruthy();
  const created = await http.post("/api/admin/strategies", {
    data: { name: "需要截断的非常长的策略名称 · Alpha Pacific Global Portfolio", mode: "paper" },
  });
  expect(created.ok()).toBeTruthy();
  const { strategy, credential } = await created.json();
  const token = { Authorization: `Bearer ${credential.token}` };
  const connected = await http.post("/api/agent/session", { headers: token, data: {
    instance_id: "visual-review", executor: true,
    capabilities: [{ id: "pause_entry", label: "Pause" }, { id: "resume_entry", label: "Resume" }, { id: "refresh", label: "Refresh" }],
  } });
  expect(connected.ok()).toBeTruthy();
  const headers = { ...token, "X-Agent-Session": (await connected.json()).session_id };
  const reported = await http.put("/api/agent/control/reported", { headers, data: {
    revision: 0, entry_enabled: true, risk_locked: false, disconnect_policy_applied: "continue",
  } });
  expect(reported.ok()).toBeTruthy();
  const observed_at = new Date().toISOString();
  const positions = Array.from({ length: 12 }, (_, index) => ({
    position_id: `position-${index}`, account_id: "paper", symbol: `ASSET-${index}`,
    currency: "USD", quantity: "1000", unrealized_pnl: "100.24",
  }));
  expect((await http.post("/api/agent/reports", { headers, data: { records: [
    { type: "portfolio", schema_version: 1, observed_at, accounts: [
      { account_id: "paper", currency: "USD", equity: "1234567890.12", daily_pnl: "1275.35" },
    ] },
    { type: "position", schema_version: 1, observed_at, strategy_positions: positions, broker_positions: [] },
  ] } })).ok()).toBeTruthy();
  expect((await http.put("/api/agent/controls", { headers, data: {
    schema_version: 1, revision: 1, groups: [], controls: [
      { id: "diagnostics", type: "readonly", label: "Execution gateway and order routing diagnostics", value_type: "text" },
    ],
  } })).ok()).toBeTruthy();
  expect((await http.put("/api/agent/controls/state", { headers, data: {
    revision: 1, observed_at, values: { diagnostics: "RECONCILIATION_AWAITING_NEXT_SCHEDULED_CLEARING_WINDOW" },
  } })).ok()).toBeTruthy();
  const queued = await http.post(`/api/admin/strategies/${strategy.id}/commands`, {
    data: { action: "refresh", request_id: "layout-review-refresh" },
  });
  expect(queued.ok()).toBeTruthy();
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/ui/#workbench");
  await expect(page.getByRole("button", { name: "当前策略" })).toContainText(strategy.name);
  const grid = page.locator(".workbench-grid");
  const entry = grid.locator('[data-widget="builtin-entry"]');
  const program = grid.locator('[data-widget="builtin-program"]');
  const risk = grid.locator('[data-widget="builtin-risk"]');
  const accounts = grid.locator('[data-widget="default-accounts"] .widget-content');
  const positionsCard = grid.locator('[data-widget="default-positions"]');
  const selection = page.locator(".strategy-picker");
  const edit = page.locator(".dashboard-heading > .icon-button");
  for (const [width, height] of [[1280, 800], [768, 1024], [390, 844], [430, 932], [640, 900], [767, 900], [840, 900], [1024, 800], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await expect(entry).toBeVisible();
    const activeNav = page.locator(width >= 768 ? ".top-nav" : ".bottom-nav");
    const inactiveNav = page.locator(width >= 768 ? ".bottom-nav" : ".top-nav");
    await expect(activeNav).toBeVisible();
    await expect(inactiveNav).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await expect.poll(async () => {
      const selectBox = (await selection.boundingBox())!;
      const addBox = (await edit.boundingBox())!;
      return Math.abs(selectBox.y + selectBox.height - addBox.y - addBox.height);
    }).toBeLessThan(1);
    await expect.poll(async () => {
      const panel = (await grid.boundingBox())!;
      const control = (await entry.boundingBox())!;
      return Math.abs(control.width / panel.width - (width >= 768 ? 0.5 : 1));
    }).toBeLessThan(0.03);
    await expect.poll(async () => Math.abs((await program.boundingBox())!.y - (await risk.boundingBox())!.y)).toBeLessThan(2);
    await expect.poll(async () => Math.abs((await page.locator("main h1").boundingBox())!.x - (await grid.boundingBox())!.x)).toBeLessThan(2);
    await expect.poll(async () => Math.abs((await entry.boundingBox())!.y - (await program.boundingBox())!.y)
      - (width < 768 ? (await entry.boundingBox())!.height + 12 : 0)).toBeCloseTo(0, 0);
    await page.evaluate(() => localStorage.setItem("quantbot.language", "en"));
    await page.reload();
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect(entry.getByText("Reported entry permission")).toBeVisible();
    await expect(accounts.getByText("1,234,567,890.12")).toBeVisible();
    await expect.poll(() => accounts.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeLessThan(3);
    const permission = entry.locator(".entry-actions");
    await expect.poll(async () => {
      const viewport = (await entry.locator(".widget-content").boundingBox())!;
      const actions = (await permission.boundingBox())!;
      return actions.y + actions.height - viewport.y - viewport.height;
    }).toBeLessThan(2);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if (width === 390 || width === 1280) {
      const image = await page.screenshot({ animations: "disabled" });
      await testInfo.attach(`workbench-${width}-en-dark`, { body: image, contentType: "image/png" });
      if (process.env.QB_VISUAL_BASELINES === "1") {
        await expect(page).toHaveScreenshot(`workbench-${width}-en-dark.png`, { animations: "disabled", maxDiffPixelRatio: 0.001 });
      }
    }
    await page.evaluate(() => localStorage.setItem("quantbot.language", "zh-CN"));
    await page.reload();
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  }
  await page.getByRole("button", { name: "编辑布局" }).click();
  await expect(entry.getByText("有效开仓权限")).toBeVisible();
  await expect(program.getByText("在线", { exact: true })).toBeVisible();
  await expect(entry.getByRole("button", { name: "暂停新开仓" })).toHaveCount(0);
  await page.getByRole("button", { name: "放弃修改" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const scrollViewport = positionsCard.locator(".widget-viewport");
  const scrollContent = positionsCard.locator(".widget-content");
  await expect.poll(async () => (await positionsCard.boundingBox())?.width).toBe(358);
  await expect(positionsCard.getByText("ASSET-11", { exact: true })).toBeAttached();
  await scrollContent.scrollIntoViewIfNeeded();
  await expect(scrollContent).toHaveCSS("scrollbar-width", "none");
  await expect(scrollViewport).toHaveAttribute("data-scroll-edges", /bottom right/);
  await expect(scrollContent).toHaveAttribute("tabindex", "0");
  await scrollContent.press("End");
  await expect(scrollViewport).toHaveAttribute("data-scroll-edges", /top/);
  await expect(scrollViewport).not.toHaveAttribute("data-scroll-edges", /bottom/);
  await expect.poll(() => positionsCard.getByText("ASSET-11", { exact: true }).evaluate((cell) => {
    const viewport = cell.closest(".widget-content")!.getBoundingClientRect();
    const row = cell.getBoundingClientRect();
    return row.top >= viewport.top && row.bottom <= viewport.bottom;
  })).toBe(true);
  await page.getByRole("button", { name: "当前策略" }).click();
  await expect(page.getByRole("group", { name: "当前策略" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "当前策略" })).toBeHidden();
  await expect(page.getByRole("button", { name: "当前策略" })).toBeFocused();
  await page.getByRole("button", { name: "当前策略" }).click();
  await page.getByRole("link", { name: "全部策略", exact: true }).click();
  await expect(page).toHaveURL(/#workbench\/all$/);
  await page.goto("/ui/#workbench");
  await expect(page.getByRole("button", { name: "当前策略" })).toHaveText("全部策略");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/ui/#operations");
  const row = page.getByRole("row").filter({ hasText: "刷新监控" });
  await expect(row.getByText("等待策略", { exact: true })).toBeInViewport();
  await expect(row.getByRole("button", { name: "详情" })).toBeInViewport();
  await row.getByRole("button", { name: "详情" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "详情" })).toBeFocused();

  for (const width of [390, 640, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["strategies", `strategy/${strategy.id}`, "operations", "system", `api/${strategy.id}`, `strategy/${strategy.id}/api`, "telegram"]) {
      await page.goto(`/ui/#${route}`);
      await expect(page.locator("main h1")).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/ui/#system");
  const appearance = page.locator(".panel").filter({ has: page.getByRole("heading", { name: "外观" }) });
  const language = appearance.getByRole("button", { name: "语言" });
  await language.press("Enter");
  const options = page.getByRole("group", { name: "语言" });
  await expect(options).toBeInViewport({ ratio: 1 });
  await expect(options.getByRole("button", { name: "简体中文" })).toHaveAttribute("aria-pressed", "true");
  if (process.env.QB_VISUAL_BASELINES === "1") {
    await expect(page).toHaveScreenshot("settings-390-zh-light.png", { animations: "disabled", maxDiffPixelRatio: 0.001 });
  }
});
