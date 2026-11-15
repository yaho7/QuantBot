import { expect, test, type Page } from "@playwright/test";

async function layoutBox(page: Page) {
  return page.locator(".route-surface .page-layout").evaluate(layout => {
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

test("day and night share spacing and page navigation fades only the route", async ({ page }) => {
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
  const host = await page.request.put("/api/agent/host", {
    headers: agentHeaders,
    data: { machine_id: crypto.randomUUID().replaceAll("-", ""), name: "布局主机", scope: "machine" },
  });
  expect(host.ok()).toBeTruthy();
  const { hostId } = await host.json();
  const alert = await page.request.post("/api/agent/events", {
    headers: agentHeaders,
    data: { records: [{ id: "layout-alert", kind: "alert", observedAt: Date.now(), data: {
      code: "layout-warning", severity: "warning", message: "布局告警验证",
    } }] },
  });
  expect(alert.ok()).toBeTruthy();

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
  await expect(page.locator("main .attention-section")).toHaveCount(0);
  const bell = page.locator('.topbar nav a[href="/alerts"]');
  await expect(bell.locator(".nav-alert-badge")).toBeVisible();
  await expect(bell).toHaveAccessibleDescription(/待关注事项/);
  await bell.click();
  await expect(page).toHaveURL(/\/alerts$/);
  await expect(page.getByRole("link", { name: /布局告警验证/ })).toHaveAttribute("href", "/strategies/" + strategyId);

  for (const width of [1280, 820, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
    const box = await layoutBox(page);
    const spacing = await page.locator(".page-body").evaluate(body => ({
      gutter: getComputedStyle(body.closest("main")!).paddingInlineStart,
      sections: getComputedStyle(body).rowGap,
    }));
    const expected = width < 768 ? [16, 20] : width < 1100 ? [24, 24] : [32, 28];
    expect(spacing).toEqual({ gutter: expected[0] + "px", sections: expected[1] + "px" });
    for (const path of ["/strategies", "/hosts", "/activity", "/controls", "/alerts", "/"]) {
      await page.locator(`.topbar nav a[href="${path}"]`).click();
      await expect(page).toHaveURL(new RegExp(path === "/" ? ":42357/$" : path + "$"));
      expect(await layoutBox(page)).toEqual(box);
      expect(await page.locator("html").getAttribute("data-transition-count")).toBeNull();
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
      expect(await layoutBox(page)).toEqual(box);
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
    }
    for (const path of ["/strategies/" + strategyId, "/hosts/" + hostId]) {
      await page.goto(path);
      const detail = await layoutBox(page);
      expect({ left: detail.left, top: detail.top, width: detail.width }).toEqual({ left: box.left, top: box.top, width: box.width });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
      expect(await layoutBox(page)).toEqual(detail);
      await page.emulateMedia({ colorScheme: "light" });
    }
    await page.goto("/admin/settings");
    const admin = await layoutBox(page);
    for (const path of ["dashboard", "strategies", "integration", "notifications", "storage", "audit", "security", "settings"]) {
      await page.goto("/admin/" + path);
      await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
      expect(await layoutBox(page)).toEqual(admin);
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
      expect(await layoutBox(page)).toEqual(admin);
      await page.emulateMedia({ colorScheme: "light" });
    }
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const supported = await page.evaluate(() => typeof document.startViewTransition === "function");
  const menu = page.locator(".topbar-inner");
  const position = await menu.boundingBox();
  await page.locator('.topbar nav a[href="/hosts"]').click();
  await expect(page).toHaveURL(/\/hosts$/);
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

  await page.goto("/strategies");
  await page.getByRole("button", { name: "表格", exact: true }).click();
  const directoryPanel = page.locator(".strategy-directory .panel-enter");
  await expect(directoryPanel.locator("table")).toBeVisible();
  await expect(directoryPanel).toHaveCSS("animation-name", "qb-panel-enter");

  await page.goto("/strategies/" + strategyId);
  await page.locator(".portfolio-records").getByRole("button", { name: "主机", exact: true }).click();
  const records = page.locator(".portfolio-records .panel-enter");
  await expect(records).toHaveCSS("animation-name", "qb-panel-enter");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(records).toHaveCSS("animation-name", "none");
  expect(errors).toEqual([]);
});
