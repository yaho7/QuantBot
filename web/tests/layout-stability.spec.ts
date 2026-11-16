import { expect, test, type Page } from "@playwright/test";

async function layoutBox(page: Page) {
  await page
    .locator(".route-surface .page-layout > .page-body")
    .waitFor({ state: "attached" });
  return page.evaluate(() => {
    const layout = document.querySelector(".route-surface .page-layout")!;
    const header = layout
      .querySelector(".page-header")!
      .getBoundingClientRect();
    const title = layout.querySelector("h1")!.getBoundingClientRect();
    const body = layout.querySelector(".page-body")!.getBoundingClientRect();
    const main = layout.closest("main, [role=main]")!.getBoundingClientRect();
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

test("Astryx shells preserve alignment across palettes and five responsive widths", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = "http://127.0.0.1:42357";
  const setup = await page.request.get("/api/auth/setup");
  const init = (await setup.json()).required as boolean;
  const session = await page.request.post(
    init ? "/api/auth/setup" : "/api/auth/login",
    {
      headers: { Origin: origin },
      data: { username: "browser-admin", password: "browser-test-password" },
    },
  );
  expect(session.ok()).toBeTruthy();
  const headers = {
    Origin: origin,
    "X-CSRF-Token": (await session.json()).csrf as string,
  };
  const strategy = await page.request.post("/api/admin/strategies", {
    headers,
    data: { name: "布局样本", group: "布局测试", mode: "paper" },
  });
  expect(strategy.ok()).toBeTruthy();
  const {
    strategy: { id: strategyId },
    credential,
  } = await strategy.json();
  const agent = await page.request.post("/api/agent/session", {
    headers: { Authorization: "Bearer " + credential.token },
    data: { instanceId: "layout-test", bootId: "layout-test-boot" },
  });
  expect(agent.ok()).toBeTruthy();
  const agentHeaders = {
    Authorization: "Bearer " + (await agent.json()).session,
  };
  const host = await page.request.post("/api/agent/performance", {
    headers: agentHeaders,
    data: {
      host_name: "布局主机",
      records: [
        {
          record_id: "layout-reading",
          observed_at: new Date().toISOString(),
          sample_duration_ms: 10000,
          host: { cpu_usage_percent: 12 },
        },
      ],
    },
  });
  expect(host.ok()).toBeTruthy();
  const { hostId } = await host.json();
  const alert = await page.request.post("/api/agent/events", {
    headers: agentHeaders,
    data: {
      records: [
        {
          id: "layout-alert",
          kind: "alert",
          observedAt: Date.now(),
          data: {
            code: "layout-warning",
            severity: "warning",
            message: "布局告警验证",
          },
        },
      ],
    },
  });
  expect(alert.ok()).toBeTruthy();

  await page.addInitScript(() =>
    localStorage.setItem("qb.appearance", "system"),
  );
  await page.goto("/");
  const bell = page.locator('.astryx-top-nav a[href="/alerts"]');
  await expect(bell.locator(".astryx-badge")).toBeVisible();
  await bell.click();
  await expect(page).toHaveURL(/\/alerts$/);
  await expect(
    page.getByRole("link", { name: /布局告警验证/ }),
  ).toHaveAttribute("href", "/strategies/" + strategyId);

  for (const width of [390, 430, 768, 1280, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    for (const path of [
      "/",
      "/strategies",
      "/hosts",
      "/activity",
      "/controls",
      "/alerts",
      "/strategies/" + strategyId,
      "/hosts/" + hostId,
      ...[
        "dashboard",
        "strategies",
        "notifications",
        "storage",
        "audit",
        "security",
        "settings",
      ].map((value) => "/admin/" + value),
    ]) {
      await page.goto(path);
      const light = await layoutBox(page);
      expect(Math.abs(light.titleX - light.contentX)).toBeLessThan(1);
      expect(light.width).toBeGreaterThan(250);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBeTruthy();
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute(
        "data-appearance",
        "dark",
      );
      expect(await layoutBox(page)).toEqual(light);
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).toHaveAttribute(
        "data-appearance",
        "light",
      );
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/strategies");
  for (const [name, saved] of [
    ["大卡片", "large"],
    ["紧凑", "compact"],
    ["迷你", "mini"],
    ["列表", "list"],
  ]) {
    await page.getByRole("radio", { name, exact: true }).click();
    expect(
      await page.evaluate(() => localStorage.getItem("qb.strategyView")),
    ).toBe(saved);
    if (saved === "list") await expect(page.getByRole("table")).toBeVisible();
    else await expect(page.locator(".strategy-card")).toHaveCount(1);
  }
  const search = page.getByRole("searchbox", { name: "搜索策略", exact: true });
  await search.fill("not-a-strategy");
  await expect(
    page.getByRole("heading", { name: "没有符合筛选条件的策略" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(search).toHaveValue("");
  for (const mode of ["大卡片", "紧凑", "迷你", "列表"]) {
    await page.getByRole("radio", { name: mode, exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  }
  await page.reload();
  await expect(
    page.getByRole("radio", { name: "列表", exact: true }),
  ).toBeChecked();
  await page.goto("/strategies/" + strategyId);
  await page
    .locator(".portfolio-records")
    .getByRole("radio", { name: "主机", exact: true })
    .click();
  await expect(page.locator(".portfolio-records .panel-enter")).toContainText(
    "布局主机",
  );
  await page.route("**/api/theme", (route) =>
    route.fulfill({
      json: {
        id: "ui-boundary-check",
        revision: "1",
        builtin: false,
        available: true,
        manifest: { name: "Boundary check", type: "declarative" },
        settings: {},
        presentation: {
          light: { foreground: "#731c4b", surface: "#ffffff" },
          dark: { foreground: "#efb9d4", surface: "#201820" },
        },
      },
    }),
  );
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator(".workbench-shell")).toHaveAttribute(
    "data-theme",
    "ui-boundary-check",
  );
  await expect(page.locator("h1")).toHaveCSS("color", "rgb(115, 28, 75)");
  await page.goto("/admin/settings");
  await expect(page.locator("h1")).not.toHaveCSS("color", "rgb(115, 28, 75)");
  expect(errors).toEqual([]);
});

test("strategy API dialog creates, reveals and replaces tokens and opens the shared test", async ({
  page,
}, testInfo) => {
  const origin = "http://127.0.0.1:42357";
  const setup = await page.request.get("/api/auth/setup");
  const init = (await setup.json()).required as boolean;
  const session = await page.request.post(
    init ? "/api/auth/setup" : "/api/auth/login",
    {
      headers: { Origin: origin },
      data: { username: "browser-admin", password: "browser-test-password" },
    },
  );
  expect(session.ok()).toBeTruthy();

  await page.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        const copy = navigator.clipboard;
        Object.defineProperty(copy, "writeText", {
          value: async (value: string) => {
            // Keep test clipboard contents outside the app UI and out of the OS clipboard.
            (window as Window & { qbTestCopy?: string }).qbTestCopy = value;
          },
        });
      },
      { once: true },
    );
  });
  await page.goto("/admin/strategies");
  const testName = "一键接入样本";
  await page.getByRole("button", { name: "创建策略", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("策略名称").fill(testName);
  await dialog.getByRole("button", { name: "创建策略", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "策略已创建" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: "沙盒测试", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "复制测试提示词" }),
  ).toBeVisible();
  const showProduction = () =>
    dialog.getByRole("radio", { name: "正式接入", exact: true }).click();
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
  const prompt = await page.evaluate(
    () => (window as Window & { qbTestCopy?: string }).qbTestCopy,
  );
  for (const path of [
    "docs/AGENT_PROTOCOL.md",
    "examples/v3/report.py",
    "examples/v3/report.mjs",
    "examples/v3/report.go",
    "examples/v3/report.sh",
    "examples/v3/quantbot.example.json",
  ]) {
    expect(prompt).toContain(
      "https://github.com/yaho7/QuantBot/blob/main/" + path,
    );
  }
  expect(prompt).toContain(origin + "/api/agent");
  expect(prompt).toContain(testName);
  expect(prompt).not.toContain(token);
  for (const feature of [
    "高级控制",
    "暂停和恢复新开仓",
    "动态参数",
    "atomic_parameters",
    "alert_suggestion",
    "claim_reconciliation_required",
  ]) {
    expect(prompt).toContain(feature);
  }
  const readConfig = (text: string | undefined) =>
    JSON.parse(text?.match(/\n(\{\n[\s\S]+?\n\})\n/)?.[1] ?? "{}");
  expect(readConfig(prompt)).toMatchObject({
    endpoint: origin + "/api/agent",
    key: keyBefore,
    secret: "",
    heartbeat_seconds: 15,
    disconnect_policy: "continue",
  });
  await expect(page).toHaveURL(/\/admin\/strategies$/);
  await page.keyboard.press("Escape");
  const row = page.getByRole("row").filter({ hasText: testName });
  const openAPI = () =>
    row.getByRole("button", { name: "API", exact: true }).click();
  await openAPI();
  await showProduction();
  await expect(secret).not.toContainText(token);
  await dialog.getByRole("button", { name: "查看 Token" }).click();
  await expect(secret).toHaveText(token);
  await dialog.getByRole("button", { name: "重新生成 Token" }).click();
  await expect(
    dialog.getByText(/旧 Token 和已连接的会话会立即失效/),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "重新生成 Token" }).click();
  await expect(key).not.toHaveText(keyBefore);
  await expect(secret).toContainText("qbt_");
  const replacement = await secret.innerText();
  expect(replacement).not.toBe(token);
  await dialog.getByRole("button", { name: "隐藏 Token" }).click();

  await expect(
    dialog.getByRole("button", { name: "复制 AI 接入提示词" }),
  ).toBeVisible();
  const isCentered = () =>
    dialog.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return (
        Math.abs(
          box.x + box.width / 2 - document.documentElement.clientWidth / 2,
        ) < 2 && Math.abs(box.y + box.height / 2 - window.innerHeight / 2) < 2
      );
    });
  await expect.poll(isCentered).toBeTruthy();
  await expect
    .poll(() =>
      dialog.evaluate((el) => {
        const title = el.querySelector("h2")!.getBoundingClientRect();
        const body = el
          .querySelector(".connection-caption")!
          .getBoundingClientRect();
        return Math.abs(title.left - body.left);
      }),
    )
    .toBeLessThan(2);
  await page.screenshot({
    path: testInfo.outputPath("strategy-api-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(isCentered).toBeTruthy();
  await expect
    .poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth))
    .toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("strategy-api-mobile.png"),
  });
  const mobileBox = await dialog.boundingBox();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-appearance", "dark");
  expect(await dialog.boundingBox()).toEqual(mobileBox);

  await dialog.getByRole("radio", { name: "沙盒测试", exact: true }).click();
  await expect(dialog.getByText("测试中", { exact: true })).toBeVisible();
  const testEndpoint = dialog.locator("[data-field=test-endpoint] code");
  const firstEndpoint = await testEndpoint.innerText();
  await dialog.getByRole("button", { name: "复制测试提示词" }).click();
  await expect
    .poll(async () =>
      readConfig(
        await page.evaluate(
          () => (window as Window & { qbTestCopy?: string }).qbTestCopy,
        ),
      ),
    )
    .toMatchObject({
      endpoint: firstEndpoint,
      secret: expect.stringMatching(/^qbt_/),
      strategy_id: "",
    });
  await dialog.getByRole("button", { name: "结束测试", exact: true }).click();
  await dialog.getByRole("button", { name: "结束测试", exact: true }).click();
  await dialog.getByRole("button", { name: "开启测试" }).click();
  await expect(testEndpoint).toBeVisible();
  await expect(testEndpoint).not.toHaveText(firstEndpoint);
  await expect
    .poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth))
    .toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("strategy-sandbox-mobile.png"),
  });
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

test("Astryx parameter controls preserve the command confirmation boundary", async ({
  page,
}) => {
  const origin = "http://127.0.0.1:42357";
  const init = (await (await page.request.get("/api/auth/setup")).json())
    .required;
  const session = await page.request.post(
    init ? "/api/auth/setup" : "/api/auth/login",
    {
      headers: { Origin: origin },
      data: { username: "browser-admin", password: "browser-test-password" },
    },
  );
  expect(session.ok()).toBeTruthy();
  const headers = {
    Origin: origin,
    "X-CSRF-Token": (await session.json()).csrf as string,
  };
  const created = await page.request.post("/api/admin/strategies", {
    headers,
    data: { name: "参数交互测试", group: "", mode: "paper" },
  });
  const { strategy, credential } = await created.json();
  const connected = await page.request.post("/api/agent/session", {
    headers: { Authorization: "Bearer " + credential.token },
    data: { instanceId: "parameter-ui", bootId: "parameter-ui-boot" },
  });
  const agent = { Authorization: "Bearer " + (await connected.json()).session };
  expect(
    (
      await page.request.put(
        "/api/admin/strategies/" + strategy.id + "/executor",
        {
          headers,
          data: { instanceId: "parameter-ui" },
        },
      )
    ).ok(),
  ).toBeTruthy();
  const registry = await page.request.put("/api/agent/capabilities", {
    headers: agent,
    data: {
      revision: 0,
      capabilities: [
        {
          id: "entry",
          title: "模拟开仓开关",
          kind: "parameter",
          value_type: "boolean",
          writable: true,
          confirm: true,
        },
        {
          id: "size",
          title: "模拟仓位阈值",
          kind: "parameter",
          value_type: "decimal",
          writable: true,
          constraints: { min: "1", max: "8", step: "0.5" },
          presentation: { preferred_renderer: "slider" },
        },
      ],
    },
  });
  expect(registry.ok()).toBeTruthy();
  const { revision } = await registry.json();
  expect(
    (
      await page.request.put("/api/agent/state", {
        headers: agent,
        data: {
          revision,
          states: [
            { id: "entry", observedAt: Date.now(), value: false },
            { id: "size", observedAt: Date.now(), value: "4" },
          ],
        },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto("/strategies/" + strategy.id);
  const slider = page
    .locator(".control-card")
    .filter({ hasText: "模拟仓位阈值" });
  const toggle = page
    .locator(".control-card")
    .filter({ hasText: "模拟开仓开关" });
  const dialog = page.getByRole("dialog");
  await slider.getByRole("button", { name: "下发指令" }).click();
  const thumb = dialog.getByRole("slider");
  await expect(thumb).toHaveAttribute("aria-valuenow", "4");
  await thumb.press("ArrowRight");
  await expect(thumb).toHaveAttribute("aria-valuenow", "4.5");
  await dialog.getByRole("button", { name: "取消" }).click();
  const offered = () =>
    page.request
      .get("/api/agent/commands?wait=0", { headers: agent })
      .then((response) => response.json());
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
