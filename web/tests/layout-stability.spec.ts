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
  const { strategy: { id: strategyId } } = await strategy.json();
  const host = await page.request.post("/api/admin/hosts", {
    headers, data: { name: "布局主机", scope: "machine", reporterStrategyId: strategyId, reporterInstanceId: "layout-test" },
  });
  expect(host.ok()).toBeTruthy();
  const { id: hostId } = await host.json();

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

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
    const box = await layoutBox(page);
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
  expect(errors).toEqual([]);
});
