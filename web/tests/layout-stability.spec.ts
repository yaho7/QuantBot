import { expect, test, type Page } from "@playwright/test";

async function layoutBox(page: Page) {
  await page.locator(".route-surface .page-layout > .page-body").waitFor({ state: "attached" });
  return page.evaluate(() => {
    const layout = document.querySelector(".route-surface .page-layout")!;
    const header = layout.querySelector(".page-header")!.getBoundingClientRect();
    const title = layout.querySelector("h1")!.getBoundingClientRect();
    const body = layout.querySelector(".page-body")!.getBoundingClientRect();
    const main = layout.closest("main")!.getBoundingClientRect();
    return {
      left: header.left,
      top: header.top - main.top,
      titleX: title.left,
      titleY: title.top - main.top,
      contentX: body.left,
      contentY: body.top - main.top,
      width: header.width,
    };
  });
}

test("day and night share spacing and page navigation fades only the route", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const origin = "http://127.0.0.1:42357";
  const setup = await page.request.get("/api/auth/setup");
  const init = (await setup.json()).required as boolean;
  const session = await page.request.post(init ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: origin },
    data: { username: "browser-admin", password: "browser-test-password" },
  });
  expect(session.ok()).toBeTruthy();
  const headers = { Origin: origin, "X-CSRF-Token": (await session.json()).csrf as string };
  const strategy = await page.request.post("/api/admin/strategies", {
    headers, data: { name: "布局样本", group: "布局测试", mode: "paper" },
  });
  expect(strategy.ok()).toBeTruthy();
  const { strategy: { id: strategyId }, credential } = await strategy.json();
  const agent = await page.request.post("/api/agent/session", {
    headers: { Authorization: "Bearer " + credential.token },
    data: { instanceId: "layout-test", bootId: "layout-test-boot" },
  });
  expect(agent.ok()).toBeTruthy();
  const agentHeaders = { Authorization: "Bearer " + (await agent.json()).session };
  const host = await page.request.post("/api/agent/performance", {
    headers: agentHeaders,
    data: { host_name: "布局主机", records: [{ record_id: "layout-reading",
      observed_at: new Date().toISOString(), sample_duration_ms: 10000,
      host: { cpu_usage_percent: 12 },
    }] },
  });
  expect(host.ok()).toBeTruthy();
  const { hostId } = await host.json();
  const now = Date.now();
  const alert = await page.request.post("/api/agent/events", {
    headers: agentHeaders,
    data: { records: [
      { id: "layout-alert", kind: "alert", observedAt: now, data: {
        code: "layout-warning", severity: "warning", message: "布局告警验证",
      } },
      { id: "layout-info", kind: "alert", observedAt: now, data: {
        code: "layout-info", severity: "info", message: "布局信息验证",
      } },
      { id: "layout-old-alert", kind: "alert", observedAt: now - 60 * 60_000, data: {
        code: "layout-old-alert", severity: "critical", message: "布局历史告警验证",
      } },
    ] },
  });
  expect(alert.ok()).toBeTruthy();
  const executor = await page.request.put("/api/admin/strategies/" + strategyId + "/executor", {
    headers, data: { instanceId: "layout-test" },
  });
  expect(executor.ok()).toBeTruthy();
  const capability = await page.request.put("/api/agent/capabilities", {
    headers: agentHeaders,
    data: { revision: 0, capabilities: [{
      id: "layout-review", kind: "action", value_type: "null", title: "布局确认测试", writable: true, confirm: true,
    }] },
  });
  expect(capability.ok()).toBeTruthy();
  const { revision } = await capability.json();
  const actual = await page.request.put("/api/agent/state", {
    headers: agentHeaders,
    data: { revision, states: [{ id: "layout-review", value: null, available: true, observedAt: Date.now() }] },
  });
  expect(actual.ok()).toBeTruthy();
  const proposal = await page.request.post("/api/strategies/" + strategyId + "/commands", {
    headers: { ...headers, "Idempotency-Key": "layout-review-command" },
    data: { controlId: "layout-review", revision, input: null },
  });
  expect(proposal.status()).toBe(201);
  const { id: proposalId, status: proposalStatus } = await proposal.json();
  expect(proposalStatus).toBe("confirmation_required");
  const offered = await page.request.get("/api/agent/commands?wait=0", { headers: agentHeaders });
  expect(await offered.json()).toEqual([]);

  await page.addInitScript(() => {
    localStorage.setItem("qb.appearance", "system");
    const update = document.startViewTransition?.bind(document);
    if (update) {
      document.startViewTransition = (callback?: ViewTransitionUpdateCallback | ViewTransitionOptions) => {
        document.documentElement.dataset.transitionCount = String(Number(document.documentElement.dataset.transitionCount ?? 0) + 1);
        return update(callback);
      };
    }
  });

  await page.goto("/");
  const equity = page.getByRole("region", { name: "账户权益", exact: true });
  const strategies = page.getByRole("region", { name: "策略状态", exact: true });
  const attention = page.getByRole("region", { name: "需要处理", exact: true });
  const widgets = page.locator(".widget-section");
  await expect(equity).toBeVisible();
  await expect(strategies).toBeVisible();
  await expect(attention).toBeVisible();
  await expect(widgets).toBeVisible();
  const [equityBox, strategiesBox, attentionBox, widgetsBox] = await Promise.all([
    equity.boundingBox(), strategies.boundingBox(), attention.boundingBox(), widgets.boundingBox(),
  ]);
  expect(equityBox!.y + equityBox!.height).toBeLessThanOrEqual(Math.min(strategiesBox!.y, attentionBox!.y));
  expect(widgetsBox!.y).toBeGreaterThanOrEqual(Math.max(
    strategiesBox!.y + strategiesBox!.height, attentionBox!.y + attentionBox!.height,
  ));
  const header = page.locator(".topbar");
  const primaryNav = header.getByRole("navigation", { name: "工作台" });
  const primaryPaths = ["/", "/strategies", "/controls"];
  const adminPaths = ["/admin/hosts", "/admin/activity", "/admin/alerts"];
  const adminPagePaths = ["dashboard", "strategies", "notifications", "storage", "audit", "security", "settings"]
    .map(path => "/admin/" + path).concat(adminPaths);
  const adminIcon = header.locator(".admin-link");
  const appearanceButton = page.getByRole("button", { name: /^外观:/ });
  const hostDetailPath = "/admin/hosts/" + hostId;
  const pendingPath = "/admin/activity?status=confirmation_required";
  const pendingLink = attention.locator(`a[href="${pendingPath}"]`);
  await expect(pendingLink.getByText("1", { exact: true })).toBeVisible();
  await expect(attention.locator('a[href="/admin/alerts"]').getByText("1", { exact: true })).toBeVisible();
  expect(await primaryNav.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("href")))).toEqual(primaryPaths);
  await expect(appearanceButton).toHaveCount(0);
  await expect(header.locator(".connection-dot")).toHaveCount(0);
  await expect(adminIcon).toHaveAccessibleName("管理后台");
  await expect(adminIcon).toHaveAccessibleDescription("近期告警: 1");
  await expect(adminIcon.locator(".admin-alert-badge")).toBeVisible();
  await expect(adminIcon.locator(".admin-alert-badge")).toHaveText("1");
  await expect(adminIcon).toHaveAttribute("href", "/admin/dashboard");

  await pendingLink.click();
  await expect(page).toHaveURL(origin + pendingPath);
  await expect(page.getByRole("combobox", { name: "状态", exact: true })).toHaveValue("confirmation_required");
  await expect(page.getByRole("button", { name: /layout-review/ })).toBeVisible();
  const cancelled = await page.request.post("/api/commands/" + proposalId + "/cancel", { headers });
  expect(cancelled.ok()).toBeTruthy();

  await page.goto("/");
  await adminIcon.click();
  await expect(page).toHaveURL(origin + "/admin/dashboard");
  await expect(page.locator(".admin-toolbar").getByRole("button", { name: /^外观:/ })).toBeVisible();
  const desktopAdminNav = page.locator(".admin-sidebar nav");
  for (const path of adminPaths) {
    await expect(desktopAdminNav.locator(`a[href="${path}"]`)).toBeVisible();
  }
  await desktopAdminNav.locator('a[href="/admin/alerts"]').click();
  await expect(page).toHaveURL(origin + "/admin/alerts");
  await expect(page.getByRole("link", { name: /布局告警验证/ })).toHaveAttribute("href", "/strategies/" + strategyId);
  await expect(page.getByRole("link", { name: /布局信息验证/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /布局历史告警验证/ })).toBeVisible();
  await desktopAdminNav.locator('a[href="/admin/hosts"]').click();
  await expect(page).toHaveURL(origin + "/admin/hosts");
  const hostLink = page.getByRole("link", { name: "布局主机", exact: true });
  await expect(hostLink).toHaveAttribute("href", hostDetailPath);
  await hostLink.click();
  await expect(page).toHaveURL(origin + hostDetailPath);
  await expect(page.getByRole("heading", { level: 1, name: "布局主机" })).toBeVisible();
  const backToHosts = page.getByRole("main").getByRole("link", { name: "主机", exact: true });
  await expect(backToHosts).toHaveAttribute("href", "/admin/hosts");
  await backToHosts.click();
  await expect(page).toHaveURL(origin + "/admin/hosts");

  for (const path of ["/hosts", "/hosts/" + hostId, "/activity", "/alerts"]) {
    const queryAndHash = "?status=confirmation_required#recent";
    await page.goto(path + queryAndHash);
    await expect(page).toHaveURL(origin + "/admin" + path + queryAndHash);
  }

  for (const width of [1280, 820, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
    const brand = header.getByRole("link", { name: "QuantBot", exact: true });
    const brandPosition = (await brand.boundingBox())!;
    const firstTab = (await primaryNav.getByRole("link", { name: "工作台", exact: true }).boundingBox())!;
    const brandGap = firstTab.x - brandPosition.x - brandPosition.width;
    expect(brandGap).toBeGreaterThanOrEqual(0);
    expect(brandGap).toBeLessThanOrEqual(24);
    if (width === 390) {
      await expect(adminIcon).toBeVisible();
      await expect(adminIcon).toHaveAccessibleDescription("近期告警: 1");
      await expect(adminIcon.locator(".admin-alert-badge")).toBeVisible();
      const adminBox = (await adminIcon.boundingBox())!;
      const sameRow = [brand];
      for (const name of ["工作台", "策略", "控制中心"]) {
        const link = primaryNav.getByRole("link", { name, exact: true });
        await expect(link).toBeVisible();
        await expect(link.locator(".nav-label")).toBeHidden();
        sameRow.push(link);
      }
      for (const link of sameRow) {
        const box = (await link.boundingBox())!;
        expect(Math.abs(box.y + box.height / 2 - adminBox.y - adminBox.height / 2)).toBeLessThan(2);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } else if (width === 1280) {
      for (const name of ["工作台", "策略", "控制中心"]) {
        await expect(primaryNav.getByRole("link", { name, exact: true }).locator(".nav-label")).toBeVisible();
      }
    }
    const box = await layoutBox(page);
    const spacing = await page.locator(".page-body").evaluate(body => ({
      gutter: getComputedStyle(body.closest("main")!).paddingInlineStart,
      sections: getComputedStyle(body).rowGap,
    }));
    const expected = width < 768 ? [16, 20] : width < 1100 ? [24, 24] : [32, 28];
    expect(spacing).toEqual({ gutter: expected[0] + "px", sections: expected[1] + "px" });
    for (const path of [...primaryPaths.slice(1), primaryPaths[0]]) {
      const destination = primaryNav.locator(`a[href="${path}"]`);
      await destination.click();
      await expect(page).toHaveURL(origin + path);
      await expect(destination).toHaveAttribute("aria-current", "page");
      expect(await layoutBox(page)).toEqual(box);
      expect(await page.locator("html").getAttribute("data-transition-count")).toBeNull();
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
      expect(await layoutBox(page)).toEqual(box);
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
    }
    await page.goto("/strategies/" + strategyId);
    const detail = await layoutBox(page);
    expect({ left: detail.left, top: detail.top, width: detail.width }).toEqual({ left: box.left, top: box.top, width: box.width });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
    expect(await layoutBox(page)).toEqual(detail);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/admin/settings");
    const admin = await layoutBox(page);
    for (const path of adminPagePaths) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
      expect(await layoutBox(page)).toEqual(admin);
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
      expect(await layoutBox(page)).toEqual(admin);
      await page.emulateMedia({ colorScheme: "light" });
    }
    await page.goto(hostDetailPath);
    await expect(page.getByRole("heading", { level: 1, name: "布局主机" })).toBeVisible();
    const hostDetail = await layoutBox(page);
    expect({ left: hostDetail.left, top: hostDetail.top, width: hostDetail.width }).toEqual({ left: admin.left, top: admin.top, width: admin.width });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
    expect(await layoutBox(page)).toEqual(hostDetail);
  }

  await page.goto("/admin/settings");

  const menuButton = page.getByRole("button", { name: "打开菜单", exact: true });
  const drawer = page.getByRole("dialog", { name: "管理后台", exact: true });
  for (const appearance of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: appearance });
    await expect(page.locator("html")).toHaveAttribute("data-appearance", appearance);
    await menuButton.focus();
    await menuButton.press("Enter");
    await expect(drawer).toBeVisible();
    for (const path of adminPaths) {
      await expect(drawer.locator(`a[href="${path}"]`)).toBeVisible();
    }
    await page.keyboard.press("Tab");
    await expect.poll(() => drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`admin-drawer-390-${appearance}.png`) });
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(menuButton).toBeFocused();
  }
  await menuButton.click();
  await drawer.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(drawer).toBeHidden();
  await menuButton.click();
  await drawer.getByRole("link", { name: "主机", exact: true }).click();
  await expect(page).toHaveURL(origin + "/admin/hosts");
  await expect(drawer).toBeHidden();
  await expect(hostLink).toBeVisible();
  await expect(appearanceButton).toHaveAccessibleName("外观: 跟随系统");
  await appearanceButton.click();
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
  await appearanceButton.click();
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
  await appearanceButton.click();
  await expect(appearanceButton).toHaveAccessibleName("外观: 跟随系统");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.goto("/");
  const supported = await page.evaluate(() => typeof document.startViewTransition === "function");
  const menu = page.locator(".topbar-inner");
  const position = await menu.boundingBox();
  await primaryNav.locator('a[href="/strategies"]').click();
  await expect(page).toHaveURL(origin + "/strategies");
  if (supported) {
    await expect(page.locator("html")).toHaveAttribute("data-transition-count", "1");
    const names = await page.evaluate(() => ({
      content: getComputedStyle(document.querySelector(".route-surface")!).viewTransitionName,
      rail: getComputedStyle(document.querySelector(".topbar-inner")!).viewTransitionName,
    }));
    expect(names).toEqual({ content: "quantbot-page", rail: "none" });
  } else {
    await expect(page.locator(".route-frame")).toHaveClass(/route-fade-fallback/);
  }
  expect(await menu.boundingBox()).toEqual(position);

  await page.setViewportSize({ width: 1280, height: 560 });
  await page.goto("/");
  await expect(widgets).toBeVisible();
  const brandBox = (await header.locator(".brand").boundingBox())!;
  const navigationBox = (await header.locator("nav").boundingBox())!;
  expect(navigationBox.x).toBeGreaterThanOrEqual(brandBox.x + brandBox.width);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect.poll(() => header.evaluate(element => Math.abs(element.getBoundingClientRect().top))).toBeLessThan(2);
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto("/strategies");
  const search = page.getByRole("searchbox", { name: "搜索策略", exact: true });
  await search.fill("not-a-strategy");
  await expect(page.getByRole("heading", { name: "没有符合筛选条件的策略" })).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(search).toHaveValue("");
  await page.getByRole("radio", { name: "表格", exact: true }).click();
  const directoryPanel = page.locator(".strategy-directory .panel-enter");
  await expect(directoryPanel.locator("table")).toBeVisible();
  await expect(directoryPanel).toHaveCSS("animation-name", "qb-panel-enter");

  await page.goto("/strategies/" + strategyId);
  await page.locator(".portfolio-records").getByRole("radio", { name: "主机", exact: true }).click();
  const records = page.locator(".portfolio-records .panel-enter");
  await expect(records).toHaveCSS("animation-name", "qb-panel-enter");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(records).toHaveCSS("animation-name", "none");
  expect(errors).toEqual([]);
});


test("strategy API dialog creates, reveals and replaces tokens and opens the shared test", async ({ page }, testInfo) => {
  const origin = "http://127.0.0.1:42357";
  const setup = await page.request.get("/api/auth/setup");
  const init = (await setup.json()).required as boolean;
  const session = await page.request.post(init ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: origin }, data: { username: "browser-admin", password: "browser-test-password" },
  });
  expect(session.ok()).toBeTruthy();

  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const copy = navigator.clipboard;
      Object.defineProperty(copy, "writeText", { value: async (value: string) => {
        // Keep test clipboard contents outside the app UI and out of the OS clipboard.
        (window as Window & { qbTestCopy?: string }).qbTestCopy = value;
      } });
    }, { once: true });
  });
  await page.goto("/admin/strategies");
  const testName = "一键接入样本";
  await page.getByRole("button", { name: "创建策略", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("策略名称").fill(testName);
  await dialog.getByRole("button", { name: "创建策略", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "策略已创建" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "沙盒测试", exact: true })).toBeChecked();
  await expect(dialog.getByRole("button", { name: "复制测试提示词" })).toBeVisible();
  const showProduction = () => dialog.getByRole("radio", { name: "正式接入", exact: true }).click();
  await showProduction();
  const endpoint = dialog.locator("[data-field=endpoint] code");
  const key = dialog.locator("[data-field=key] code");
  const secret = dialog.locator("[data-field=token] code");
  await expect(endpoint).toHaveText(origin + "/api/agent");
  await expect(key).not.toHaveText("—");
  const keyBefore = await key.innerText();
  const token = await secret.innerText();
  expect(token).toMatch(/^qbt_/);
  await dialog.getByRole("button", { name: "复制 AI 接入提示词" }).click();
  const prompt = await page.evaluate(() => (window as Window & { qbTestCopy?: string }).qbTestCopy);
  for (const path of ["docs/AGENT_PROTOCOL.md", "examples/v3/report.py", "examples/v3/report.mjs", "examples/v3/report.go", "examples/v3/report.sh", "examples/v3/quantbot.example.json"]) {
    expect(prompt).toContain("https://github.com/yaho7/QuantBot/blob/main/" + path);
  }
  expect(prompt).toContain(origin + "/api/agent");
  expect(prompt).toContain(testName);
  expect(prompt).not.toContain(token);
  for (const feature of ["高级控制", "暂停和恢复新开仓", "动态参数", "atomic_parameters", "alert_suggestion", "claim_reconciliation_required"]) {
    expect(prompt).toContain(feature);
  }
  const readConfig = (text: string | undefined) => JSON.parse(text?.match(/\n(\{\n[\s\S]+?\n\})\n/)?.[1] ?? "{}");
  expect(readConfig(prompt)).toMatchObject({
    endpoint: origin + "/api/agent", key: keyBefore, secret: "",
    heartbeat_seconds: 15, disconnect_policy: "continue",
  });
  await expect(page).toHaveURL(/\/admin\/strategies$/);
  await page.keyboard.press("Escape");
  const row = page.getByRole("row").filter({ hasText: testName });
  const openAPI = () => row.getByRole("button", { name: "API", exact: true }).click();
  await openAPI();
  await showProduction();
  await expect(secret).not.toContainText(token);
  await dialog.getByRole("button", { name: "查看 Token" }).click();
  await expect(secret).toHaveText(token);
  await dialog.getByRole("button", { name: "重新生成 Token" }).click();
  await expect(dialog.getByText(/旧 Token 和已连接的会话会立即失效/)).toBeVisible();
  await dialog.getByRole("button", { name: "重新生成 Token" }).click();
  await expect(key).not.toHaveText(keyBefore);
  await expect(secret).toContainText("qbt_");
  const replacement = await secret.innerText();
  expect(replacement).not.toBe(token);
  await dialog.getByRole("button", { name: "隐藏 Token" }).click();

  await expect(dialog.getByRole("button", { name: "复制 AI 接入提示词" })).toBeVisible();
  const isCentered = () => dialog.evaluate(el => {
    const box = el.getBoundingClientRect();
    return Math.abs(box.x + box.width / 2 - window.innerWidth / 2) < 2 &&
      Math.abs(box.y + box.height / 2 - window.innerHeight / 2) < 2;
  });
  await expect.poll(isCentered).toBeTruthy();
  await expect.poll(() => dialog.evaluate(el => {
    const title = el.querySelector("h2")!.getBoundingClientRect();
    const body = el.querySelector(".connection-caption")!.getBoundingClientRect();
    return Math.abs(title.left - body.left);
  })).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath("strategy-api-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(isCentered).toBeTruthy();
  await expect.poll(() => dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("strategy-api-mobile.png") });
  const mobileBox = await dialog.boundingBox();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
  expect(await dialog.boundingBox()).toEqual(mobileBox);

  await dialog.getByRole("radio", { name: "沙盒测试", exact: true }).click();
  await expect(dialog.getByText("测试中", { exact: true })).toBeVisible();
  const testEndpoint = dialog.locator("[data-field=test-endpoint] code");
  const firstEndpoint = await testEndpoint.innerText();
  await dialog.getByRole("button", { name: "复制测试提示词" }).click();
  await expect.poll(async () => readConfig(await page.evaluate(() =>
    (window as Window & { qbTestCopy?: string }).qbTestCopy,
  ))).toMatchObject({ endpoint: firstEndpoint, secret: expect.stringMatching(/^qbt_/), strategy_id: "" });
  await dialog.getByRole("button", { name: "结束测试", exact: true }).click();
  await dialog.getByRole("button", { name: "结束测试", exact: true }).click();
  await dialog.getByRole("button", { name: "开启测试" }).click();
  await expect(testEndpoint).toBeVisible();
  await expect(testEndpoint).not.toHaveText(firstEndpoint);
  await expect.poll(() => dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("strategy-sandbox-mobile.png") });
  await page.keyboard.press("Escape");

  await row.getByRole("button", { name: "删除策略" }).click();
  await dialog.getByRole("button", { name: "删除策略" }).click();
  await expect(row).toHaveCount(0);
  const agent = await page.request.post("/api/agent/session", {
    headers: { Authorization: "Bearer " + replacement },
    data: { instanceId: "removed", bootId: "new-boot" },
  });
  expect(agent.status()).toBe(401);
});

test("parameter controls preserve the command confirmation boundary", async ({ page }) => {
  const origin = "http://127.0.0.1:42357";
  const init = (await (await page.request.get("/api/auth/setup")).json()).required;
  const session = await page.request.post(init ? "/api/auth/setup" : "/api/auth/login", {
    headers: { Origin: origin }, data: { username: "browser-admin", password: "browser-test-password" },
  });
  expect(session.ok()).toBeTruthy();
  const headers = { Origin: origin, "X-CSRF-Token": (await session.json()).csrf as string };
  const created = await page.request.post("/api/admin/strategies", {
    headers, data: { name: "参数交互测试", group: "", mode: "paper" },
  });
  const { strategy, credential } = await created.json();
  const connected = await page.request.post("/api/agent/session", {
    headers: { Authorization: "Bearer " + credential.token },
    data: { instanceId: "parameter-ui", bootId: "parameter-ui-boot" },
  });
  const agent = { Authorization: "Bearer " + (await connected.json()).session };
  expect((await page.request.put("/api/admin/strategies/" + strategy.id + "/executor", {
    headers, data: { instanceId: "parameter-ui" },
  })).ok()).toBeTruthy();
  const registry = await page.request.put("/api/agent/capabilities", {
    headers: agent, data: { revision: 0, capabilities: [
      { id: "entry", title: "模拟开仓开关", kind: "parameter", value_type: "boolean", writable: true, confirm: true },
      { id: "size", title: "模拟仓位阈值", kind: "parameter", value_type: "decimal", writable: true,
        constraints: { min: "1", max: "8", step: "0.5" }, presentation: { preferred_renderer: "slider" } },
    ] },
  });
  expect(registry.ok()).toBeTruthy();
  const { revision } = await registry.json();
  expect((await page.request.put("/api/agent/state", {
    headers: agent, data: { revision, states: [
      { id: "entry", observedAt: Date.now(), value: false },
      { id: "size", observedAt: Date.now(), value: "4" },
    ] },
  })).ok()).toBeTruthy();
  await page.goto("/strategies/" + strategy.id);
  const slider = page.locator(".control-card").filter({ hasText: "模拟仓位阈值" });
  const toggle = page.locator(".control-card").filter({ hasText: "模拟开仓开关" });
  const dialog = page.getByRole("dialog");
  await slider.getByRole("button", { name: "下发指令" }).click();
  const thumb = dialog.getByRole("slider");
  await expect(thumb).toHaveAttribute("aria-valuenow", "4");
  await thumb.press("ArrowRight");
  await expect(thumb).toHaveAttribute("aria-valuenow", "4.5");
  await dialog.getByRole("button", { name: "取消" }).click();
  const offered = () => page.request.get("/api/agent/commands?wait=0", { headers: agent }).then(response => response.json());
  expect(await offered()).toEqual([]);
  await toggle.getByRole("button", { name: "下发指令" }).click();
  await dialog.getByRole("switch", { name: "模拟开仓开关" }).press("Space");
  await expect(dialog.getByRole("switch")).toBeChecked();
  await dialog.getByRole("button", { name: "下发指令" }).click();
  await expect(dialog).toContainText("此指令需要二次确认");
  expect(await offered()).toEqual([]);
  await dialog.getByRole("button", { name: "确认下发" }).click();
  await expect.poll(offered).toHaveLength(1);
});
