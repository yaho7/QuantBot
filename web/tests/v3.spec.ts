import { expect, test } from "@playwright/test";

test("initialization, real reports, command receipt and responsive shells", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("browser-admin");
  await page.getByLabel("密码", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "初始化管理员", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "运行总览", exact: true }),
  ).toBeVisible();
  await page.goto("/admin/strategies");
  await page.getByRole("button", { name: "创建策略", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("策略名称").fill("动量 · BTC 趋势");
  await dialog.getByLabel("分组").fill("数字资产");
  await dialog.getByRole("button", { name: "创建策略", exact: true }).click();
  await expect(dialog.locator(".secret code")).toContainText("qbt_");
  const token = await dialog.locator(".secret code").innerText();
  const agent = await request.post("/api/v1/agent/session", {
    headers: { Authorization: "Bearer " + token },
    data: { instanceId: "browser-worker", bootId: "browser-boot" },
  });
  expect(agent.ok()).toBeTruthy();
  const identity = await agent.json();
  const id = identity.strategyId as string;
  const session = identity.session as string;
  const headers = { Authorization: "Bearer " + session };
  await dialog.getByRole("link", { name: "API 与接入", exact: true }).click();
  await page
    .getByRole("combobox", { name: "执行器实例", exact: true })
    .selectOption("browser-worker");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("当前会话 · browser-worker")).toBeVisible();
  expect(
    (
      await request.put("/api/v1/agent/controls", {
        headers,
        data: {
          version: 1,
          baseRevision: 0,
          controls: [
            {
              id: "allow-entry",
              kind: "toggle",
              title: "允许新开仓",
              description: "策略将保留本地风控检查。",
              risk: "high",
              confirm: true,
            },
            {
              id: "rsi",
              kind: "slider",
              title: "RSI 周期",
              min: "5",
              max: "50",
              step: "1",
            },
          ],
        },
      })
    ).ok(),
  ).toBeTruthy();
  const now = Date.now();
  const state = {
    version: 1,
    revision: 1,
    states: [
      { id: "allow-entry", value: false, available: true, observedAt: now },
      { id: "rsi", value: "14", available: true, observedAt: now },
    ],
  };
  expect(
    (
      await request.put("/api/v1/agent/controls/state", {
        headers,
        data: state,
      })
    ).ok(),
  ).toBeTruthy();
  const records: unknown[] = [
    {
      id: "status-1",
      kind: "status",
      observedAt: now,
      data: { state: "running", startedAt: now - 7200000 },
    },
    {
      id: "equity-now",
      kind: "equity",
      observedAt: now,
      data: {
        accountId: "paper",
        currency: "USD",
        value: "104825.37",
        drawdown: "-1.28",
      },
    },
    {
      id: "performance",
      kind: "performance",
      observedAt: now,
      data: { accountId: "paper", currency: "USD", dailyPnl: "1258.40" },
    },
    {
      id: "positions",
      kind: "position",
      observedAt: now,
      data: {
        positions: [
          {
            accountId: "paper",
            positionId: "BTC-L",
            symbol: "BTC/USDT",
            side: "long",
            quantity: "0.125",
            entryPrice: "80420.50",
          },
        ],
      },
    },
  ];
  for (let i = 0; i < 40; i++) {
    records.push({
      id: "eq-" + i,
      kind: "equity",
      observedAt: now - (40 - i) * 60000,
      data: {
        accountId: "paper",
        currency: "USD",
        value: String(103400 + i * 35),
      },
    });
    records.push({
      id: "candle-" + i,
      kind: "ohlcv",
      observedAt: Math.floor(now / 60000) * 60000 - (40 - i) * 60000,
      data: {
        symbol: "BTC/USDT",
        intervalSeconds: 60,
        open: String(80400 + i * 3),
        high: String(80430 + i * 3),
        low: String(80380 + i * 3),
        close: String(80410 + i * 3),
        volume: "0.102",
      },
    });
  }
  const upload = await request.post("/api/v1/agent/reports", {
    headers,
    data: { version: 1, records },
  });
  expect(upload.ok()).toBeTruthy();
  expect((await upload.json()).rejected).toBe(0);
  await page.goto("/strategies/" + id);
  await expect(
    page.getByRole("heading", { name: "允许新开仓", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".summary-card").first()).toContainText(
    "104,825.37",
  );
  await page
    .locator(".control-card")
    .filter({ hasText: "允许新开仓" })
    .getByRole("button", { name: "下发指令" })
    .click();
  await page.getByRole("switch").click();
  await dialog.getByRole("button", { name: "下发指令", exact: true }).click();
  await expect(dialog).toContainText("此指令需要二次确认");
  await dialog.getByRole("button", { name: "确认下发", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const commands = await (
    await request.get("/api/v1/agent/commands?wait=0", { headers })
  ).json();
  expect(commands).toHaveLength(1);
  const commandId = commands[0].id;
  expect(
    (
      await request.post("/api/v1/agent/commands/" + commandId + "/accept", {
        headers,
      })
    ).ok(),
  ).toBeTruthy();
  const permit = await (
    await request.post("/api/v1/agent/commands/" + commandId + "/claim", {
      headers,
    })
  ).json();
  expect(permit.permit).toBeTruthy();
  expect(
    (
      await request.post("/api/v1/agent/commands/" + commandId + "/result", {
        headers,
        data: {
          permit: permit.permit,
          status: "succeeded",
          message: "Paper executor receipt",
        },
      })
    ).ok(),
  ).toBeTruthy();
  await expect(page.locator(".control-card").first()).toContainText("成功");
  // The receipt alone does not update the independently reported actual state.
  await expect(
    page.locator(".control-card").first().locator("dd").first(),
  ).toHaveText("false");
  state.states[0]!.value = true;
  state.states.forEach((s) => (s.observedAt = Date.now()));
  expect(
    (
      await request.put("/api/v1/agent/controls/state", {
        headers,
        data: state,
      })
    ).ok(),
  ).toBeTruthy();
  await expect(
    page.locator(".control-card").first().locator("dd").first(),
  ).toHaveText("true");

  await page.goto("/admin/notifications");
  await page.getByRole("button", { name: "添加通知渠道", exact: true }).click();
  await dialog.getByLabel("渠道名称").fill("测试告警渠道");
  await dialog.getByLabel("Bot Token").fill("123456:local-browser-test-token");
  await dialog.getByLabel("Chat ID").fill("1234567");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".channel-card")).toContainText("测试告警渠道");
  await expect(page.locator(".channel-card")).toContainText("已停用");
  const channels = await page.evaluate(async () =>
    (await fetch("/api/v1/admin/notifications")).json(),
  );
  expect(JSON.stringify(channels)).not.toContain("local-browser-test-token");

  for (const appearance of ["light", "dark"]) {
    await page.evaluate((mode) => {
      localStorage.setItem("qb.appearance", mode);
    }, appearance);
    for (const width of [390, 430, 768, 1280, 1600]) {
      await request.put("/api/v1/agent/heartbeat", { headers });
      await page.setViewportSize({ width, height: 1000 });
      for (const [label, path] of [
        ["home", "/"],
        ["detail", "/strategies/" + id],
        ["admin", "/admin/dashboard"],
        ["audit", "/admin/audit"],
        ["notifications", "/admin/notifications"],
      ]) {
        await page.goto(path);
        await expect(page.locator("h1")).toBeVisible();
        if (label === "detail")
          await expect(page.locator(".chart canvas").first()).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBeTruthy();
        await page.screenshot({
          path: testInfo.outputPath(
            label + "-" + width + "-" + appearance + ".png",
          ),
          fullPage: true,
        });
      }
    }
  }
  expect(errors).toEqual([]);
});
