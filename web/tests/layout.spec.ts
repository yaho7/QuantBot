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
  const queued = await http.post(`/api/admin/strategies/${strategy.id}/commands`, {
    data: { action: "refresh", request_id: "layout-review-refresh" },
  });
  expect(queued.ok()).toBeTruthy();
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/ui/#workbench");
  await expect(page.getByLabel("当前策略")).toHaveValue(strategy.id);
  const grid = page.locator(".workbench-grid");
  const entry = grid.locator('[data-widget="builtin-entry"]');
  const program = grid.locator('[data-widget="builtin-program"]');
  const risk = grid.locator('[data-widget="builtin-risk"]');
  const selection = page.locator(".workbench-tools select");
  const add = page.locator(".workbench-tools button");
  for (const [width, height] of [[1280, 800], [768, 1024], [390, 844], [430, 932], [640, 900], [1024, 800], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await expect(entry).toBeVisible();
    const activeNav = page.locator(width >= 768 ? ".top-nav" : ".bottom-nav");
    const inactiveNav = page.locator(width >= 768 ? ".bottom-nav" : ".top-nav");
    await expect(activeNav).toBeVisible();
    await expect(inactiveNav).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await expect.poll(async () => {
      const selectBox = (await selection.boundingBox())!;
      const addBox = (await add.boundingBox())!;
      return Math.abs(selectBox.y + selectBox.height - addBox.y - addBox.height);
    }).toBeLessThan(1);
    await expect.poll(async () => {
      const panel = (await grid.boundingBox())!;
      const control = (await entry.boundingBox())!;
      return Math.abs(control.width / panel.width - (width >= 768 ? 0.5 : 1));
    }).toBeLessThan(0.03);
    await expect.poll(async () => Math.abs((await program.boundingBox())!.y - (await risk.boundingBox())!.y)).toBeLessThan(2);
    await page.locator(".language-picker").selectOption("en");
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect(entry.getByText("Reported entry permission")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if (width === 390 || width === 1280) {
      const image = await page.screenshot({ animations: "disabled" });
      await testInfo.attach(`workbench-${width}-en-dark`, { body: image, contentType: "image/png" });
      if (process.env.QB_VISUAL_BASELINES === "1") {
        await expect(page).toHaveScreenshot(`workbench-${width}-en-dark.png`, { animations: "disabled", maxDiffPixelRatio: 0.001 });
      }
    }
    await page.locator(".language-picker").selectOption("zh-CN");
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  }
  await page.getByRole("button", { name: "编辑布局" }).click();
  await expect(entry.getByText("有效开仓权限")).toBeVisible();
  await expect(program.getByText("在线", { exact: true })).toBeVisible();
  await expect(entry.getByRole("button", { name: "暂停新开仓" })).toHaveCount(0);
  await page.getByRole("button", { name: "放弃修改" }).click();
  await page.getByLabel("当前策略").selectOption("");
  await expect(page).toHaveURL(/#workbench\/all$/);
  await page.goto("/ui/#workbench");
  await expect(page.getByLabel("当前策略")).toHaveValue("");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/ui/#operations");
  const row = page.getByRole("row").filter({ hasText: "刷新监控" });
  await expect(row.getByText("等待策略", { exact: true })).toBeInViewport();
  await expect(row.getByRole("button", { name: "详情" })).toBeInViewport();
  await row.getByRole("button", { name: "详情" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
