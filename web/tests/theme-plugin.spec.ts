import { expect, test } from "@playwright/test";

test.afterEach(async ({ page }) => {
  const response = await page.request.get("/api/auth/session");
  if (!response.ok()) return;
  await page.request.put("/api/admin/themes/active", { headers: { Origin: "http://127.0.0.1:42357", "X-CSRF-Token": (await response.json()).csrf }, data: { id: "classical" } });
});

test("Astryx is an optional isolated package and Classical stays the default", async ({ page }, testInfo) => {
  const request = page.request;
  test.setTimeout(120_000);
  const origin = "http://127.0.0.1:42357";
  const init = (await (await request.get("/api/auth/setup")).json()).required;
  const session = await request.post(init ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: origin }, data: { username: "browser-admin", password: "browser-test-password" },
  });
  expect(session.ok()).toBeTruthy();
  const headers = { Origin: origin, "X-CSRF-Token": (await session.json()).csrf };
  expect((await (await request.get("/api/theme")).json()).id).toBe("classical");
  const created = await request.post("/api/admin/strategies", { headers, data: { name: "跨期价差", group: "期货", mode: "paper" } });
  const { strategy, credential } = await created.json();
  expect((await request.post("/api/admin/strategies", { headers, data: { name: "低波动轮动", group: "股票", mode: "paper" } })).ok()).toBeTruthy();
  const agent = await request.post("/api/agent/session", { headers: { Authorization: "Bearer " + credential.token }, data: { instanceId: "theme-worker", bootId: "theme-boot" } });
  const agentHeaders = { Authorization: "Bearer " + (await agent.json()).session };
  await request.put("/api/admin/strategies/" + strategy.id + "/executor", { headers, data: { instanceId: "theme-worker" } });
  const register = await request.put("/api/agent/capabilities", { headers: agentHeaders, data: { revision: 0, capabilities: [{ id: "refresh", kind: "action", value_type: "null", title: "刷新模拟状态", writable: true, confirm: true }] } });
  const revision = (await register.json()).revision;
  const now = Date.now();
  await request.put("/api/agent/state", { headers: agentHeaders, data: { revision, states: [{ id: "refresh", value: null, available: true, observedAt: now }] } });
  const variation = [0, 260, -130, 90, -310, 170, -90, 150, 335, -160, 80, -200, 210];
  const report = await request.post("/api/agent/reports", { headers: agentHeaders, data: { records: Array.from({ length: 40 }, (_, index) => ({ id: "theme-equity-" + index, kind: "equity", observedAt: now - (39 - index) * 60_000, data: { accountId: "paper", currency: "USD", value: String(100000 + index * 100 + variation[index % variation.length]!) } })) } });
  expect((await report.json()).rejected).toBe(0);

  await page.goto("/admin/themes");
  await page.getByRole("button", { name: "安装 Astryx 主题", exact: true }).click();
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "Astryx", exact: true }) });
  await expect(card).toContainText("1.1.0");
  expect((await (await request.get("/api/theme")).json()).id).toBe("classical");
  await card.getByRole("button", { name: "启用主题", exact: true }).click();
  await expect(card).toContainText("使用中");
  await page.goto("/");
  const frame = page.frameLocator('iframe[title="Astryx"]');
  await expect(frame.getByRole("heading", { name: "运行总览", exact: true })).toBeVisible();
  const selector = frame.getByRole("combobox", { name: "策略", exact: true });
  await selector.click();
  await frame.getByRole("option", { name: "跨期价差", exact: true }).click();
  await expect(frame.locator(".tv-lightweight-charts")).toBeVisible();
  await expect(frame.getByText("103,900", { exact: true })).toBeVisible();
  const panel = frame.getByRole("region", { name: "账户权益" });
  await panel.getByText("7天", { exact: true }).click();
  await expect(panel.locator(".tv-lightweight-charts")).toBeVisible();
  await expect(panel.getByText("103,900", { exact: true })).toBeVisible();

  const directory = frame.getByRole("region", { name: "策略", exact: true });
  const onlineCard = directory.locator(".astryx-card").filter({ hasText: "跨期价差" });
  const offlineCard = directory.locator(".astryx-card").filter({ hasText: "低波动轮动" });
  await expect(onlineCard.getByText("在线", { exact: true })).toBeVisible();
  await expect(offlineCard.getByText("离线", { exact: true })).toBeVisible();
  await offlineCard.getByRole("button", { name: "切换净值图" }).click();
  await expect(panel.getByText("该时段暂无净值数据")).toBeVisible();
  await expect(panel.getByText("103,900", { exact: true })).toHaveCount(0);
  await onlineCard.getByRole("button", { name: "切换净值图" }).click();
  await expect(panel.getByText("103,900", { exact: true })).toBeVisible();
  await directory.getByRole("combobox", { name: "分组", exact: true }).click();
  await frame.getByRole("option", { name: "股票", exact: true }).click();
  await expect(directory.getByRole("heading", { name: "低波动轮动" })).toBeVisible();
  await expect(directory.getByRole("heading", { name: "跨期价差" })).toHaveCount(0);
  const search = directory.getByRole("textbox", { name: "搜索策略" });
  await search.fill("跨期");
  await expect(directory.getByText("暂无符合筛选条件的策略")).toBeVisible();
  await search.clear();
  await directory.getByRole("combobox", { name: "分组", exact: true }).click();
  await frame.getByRole("option", { name: "全部", exact: true }).click();
  await directory.getByText("列表", { exact: true }).click();
  await expect(directory.getByRole("row").filter({ hasText: "低波动轮动" })).toContainText("离线");
  await directory.getByText("迷你", { exact: true }).click();
  await expect(directory.getByRole("heading", { name: "跨期价差" })).toBeVisible();
  await directory.getByText("大卡片", { exact: true }).click();
  await expect(offlineCard.getByText("最近在线 · —", { exact: true })).toBeVisible();
  await directory.getByText("紧凑", { exact: true }).click();

  expect(await page.locator('iframe[title="Astryx"]').getAttribute("sandbox")).toBe("allow-scripts");
  const isolation = await frame.locator("body").evaluate(() => {
    let parentBlocked = false, storageBlocked = false;
    try { void parent.document.cookie; } catch { parentBlocked = true; }
    try { void localStorage.length; } catch { storageBlocked = true; }
    return { parentBlocked, storageBlocked };
  });
  expect(isolation).toEqual({ parentBlocked: true, storageBlocked: true });
  expect(await frame.locator("body").evaluate(async () => {
    try { await fetch(new URL("/api/auth/session", location.href)); return false; }
    catch { return true; }
  })).toBeTruthy();

  await frame.getByRole("button", { name: "打开控制", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "刷新模拟状态", exact: true })).toBeVisible();
  expect(await (await request.get("/api/agent/commands?wait=0", { headers: agentHeaders })).json()).toHaveLength(0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(() => scrollTo(0, 0));
  await frame.locator("body").evaluate(() => scrollTo(0, 0));

  for (const appearance of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: appearance, reducedMotion: "reduce" });
    await expect(frame.locator("html")).toHaveAttribute("data-appearance", appearance);
    for (const width of [390, 430, 768, 1280, 1600]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await frame.locator("body").evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      const summaryTop = await frame.getByText("策略总数", { exact: true }).evaluate(el => el.getBoundingClientRect().top);
      for (const status of ["在线", "离线"]) {
        const top = await frame.getByText(status, { exact: true }).first().evaluate(el => el.getBoundingClientRect().top);
        expect(top).toBe(summaryTop);
      }
      await page.screenshot({ path: testInfo.outputPath(`astryx-${width}-${appearance}.png`), fullPage: true });
      if (width === 1600 && appearance === "light") await frame.locator(".page-layout").screenshot({ path: testInfo.outputPath("astryx-preview.png"), style: ".topbar, .floating-tools { visibility: hidden !important; }" });
    }
  }
  await frame.locator("body").evaluate(() => parent.postMessage({ version: 1, type: "quantbot:error" }, new URL(location.href).origin));
  await expect(page.locator(".workbench-shell")).toHaveAttribute("data-theme", "classical");
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.goto("/admin/themes");
  await expect(page.locator(".admin-shell")).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "恢复 Classic", exact: true }).click();
  expect((await (await request.get("/api/theme")).json()).id).toBe("classical");
  await page.goto("/");
  await expect(page.locator(".antquant-workbench")).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
});
