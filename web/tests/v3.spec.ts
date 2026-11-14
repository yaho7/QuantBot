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
  const agent = await request.post("/api/agent/session", {
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
  const declarations = [
    {
      id: "allow-entry",
      kind: "parameter",
      value_type: "boolean",
      writable: true,
      title: "允许新开仓",
      description: "策略将保留本地风控检查。",
      risk: "high",
      confirm: true,
    },
    {
      id: "rsi",
      kind: "parameter",
      value_type: "decimal",
      writable: true,
      title: "RSI 周期",
      constraints: { min: "5", max: "50", step: "1" },
    },
    {
      id: "feed",
      kind: "metric",
      value_type: "decimal",
      title: "声明式行情延迟",
      unit: "ms",
      precision: 2,
      history: true,
      presentation: {
        suggested: true,
        surface: ["overview", "strategy"],
        default_size: "large",
        order: 2,
      },
    },
    {
      id: "broker",
      kind: "state",
      value_type: "boolean",
      title: "券商连接健康",
      group: "health",
      history: true,
      stale_after_seconds: 30,
      alert_suggestion: { type: "stale" },
      presentation: {
        suggested: true,
        surface: ["overview", "strategy"],
        default_size: "medium",
        order: 1,
      },
    },
    {
      id: "signal",
      kind: "event",
      value_type: "object",
      title: "策略原始信号",
      history: true,
      value_schema: {
        type: "object",
        properties: { signal: { type: "string" } },
        required: ["signal"],
      },
      presentation: {
        suggested: true,
        surface: ["strategy"],
        default_size: "medium",
      },
    },
    {
      id: "candles",
      kind: "resource",
      value_type: "object",
      title: "声明式 K 线",
      history: true,
      value_schema: {
        type: "object",
        properties: Object.fromEntries(
          ["open", "high", "low", "close", "volume"].map((key) => [
            key,
            { type: "decimal" },
          ]),
        ),
        required: ["open", "high", "low", "close", "volume"],
      },
      presentation: {
        suggested: true,
        surface: ["strategy"],
        preferred_renderer: "candlestick",
      },
    },
  ];
  const register = async (revision: number, capabilities: unknown[]) => {
    const result = await request.put("/api/agent/capabilities", {
      headers,
      data: { revision, capabilities },
    });
    expect(result.ok(), await result.text()).toBeTruthy();
  };
  await register(0, declarations);
  const now = Date.now();
  const state = {
    revision: 1,
    states: [
      { id: "allow-entry", value: false, available: true, observedAt: now },
      { id: "rsi", value: "14", available: true, observedAt: now },
      { id: "broker", value: false, available: true, observedAt: now },
    ],
  };
  expect(
    (
      await request.put("/api/agent/state", {
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
  const upload = await request.post("/api/agent/reports", {
    headers,
    data: { records },
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
    await request.get("/api/agent/commands?wait=0", { headers })
  ).json();
  expect(commands).toHaveLength(1);
  const commandId = commands[0].id;
  const permit = await (
    await request.post("/api/agent/commands/" + commandId + "/claim", {
      headers: { ...headers, "Idempotency-Key": "browser-" + commandId },
    })
  ).json();
  expect(permit.permit).toBeTruthy();
  expect(
    (
      await request.post("/api/agent/commands/" + commandId + "/result", {
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
      await request.put("/api/agent/state", {
        headers,
        data: state,
      })
    ).ok(),
  ).toBeTruthy();
  await expect(
    page.locator(".control-card").first().locator("dd").first(),
  ).toHaveText("true");

  const metric = await request.post("/api/agent/reports", {
    headers,
    data: {
      revision: 1,
      records: [
        {
          id: "feed-1",
          capabilityId: "feed",
          observedAt: now - 1000,
          value: "2.25",
        },
        { id: "feed-2", capabilityId: "feed", observedAt: now, value: "2.40" },
      ],
    },
  });
  expect(metric.ok(), await metric.text()).toBeTruthy();
  const signal = await request.post("/api/agent/events", {
    headers,
    data: {
      revision: 1,
      records: [
        {
          id: "signal-1",
          capabilityId: "signal",
          observedAt: now,
          value: { signal: "真实信号" },
          associations: { order_id: "order-paper-42" },
        },
      ],
    },
  });
  expect(signal.ok(), await signal.text()).toBeTruthy();
  const candles = await request.put("/api/agent/resources/candles", {
    headers: { ...headers, "Idempotency-Key": "candles-snapshot" },
    data: {
      revision: 1,
      mode: "snapshot",
      resourceRevision: 0,
      observedAt: now,
      items: [
        {
          id: "bar-1",
          observedAt: now - 60000,
          value: {
            open: "10",
            high: "15",
            low: "8",
            close: "12",
            volume: "10",
          },
        },
        {
          id: "bar-2",
          observedAt: now,
          value: {
            open: "12",
            high: "20",
            low: "11",
            close: "17",
            volume: "6",
          },
        },
      ],
    },
  });
  expect(candles.ok(), await candles.text()).toBeTruthy();

  const widgets = page.locator(".widget-grid .widget");
  const widget = (title: string) =>
    widgets.filter({
      has: page.getByRole("heading", { name: title, exact: true }),
    });
  await expect(widget("声明式行情延迟").locator(".chart canvas")).toBeVisible();
  await expect(
    widget("声明式 K 线").locator(".chart canvas").first(),
  ).toBeVisible();
  await expect(widget("策略原始信号")).toContainText("真实信号");
  await expect(widget("策略原始信号")).toContainText("order-paper-42");
  await widget("策略原始信号")
    .getByRole("button", { name: "order_id order-paper-42" })
    .click();
  await expect(dialog.getByRole("heading", { name: "关联记录" })).toBeVisible();
  await expect(dialog).toContainText("真实信号");
  await expect(dialog).not.toContainText("声明式行情延迟");
  await page.keyboard.press("Escape");

  await expect(
    page.getByRole("status").filter({ hasText: "策略健康" }),
  ).toContainText("健康检查异常");
  await expect(widget("券商连接健康")).toContainText("未启用");

  await page.goto("/");
  await expect(widgets).toHaveCount(2);
  await expect(widgets.first()).toHaveAttribute(
    "data-widget",
    "cap:" + id + ":broker",
  );
  await expect(widget("声明式行情延迟")).toHaveClass(/size-large/);
  await page.getByRole("button", { name: "编辑布局", exact: true }).click();
  await widget("声明式行情延迟")
    .getByRole("button", { name: "组件设置", exact: true })
    .click();
  await dialog.getByLabel("显示名称").fill("自定义延迟");
  await dialog
    .getByRole("combobox", { name: "组件尺寸", exact: true })
    .selectOption("small");
  await dialog
    .getByRole("button", { name: "关闭", exact: true })
    .last()
    .click();
  await widget("券商连接健康")
    .getByRole("button", { name: "移除组件", exact: true })
    .click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑布局", exact: true }),
  ).toBeVisible();

  await register(
    1,
    declarations
      .filter((entry) => entry.id !== "feed")
      .map((entry) =>
        entry.id === "broker"
          ? {
              ...entry,
              presentation: {
                ...entry.presentation,
                order: -10,
                default_size: "full",
              },
            }
          : entry,
      )
      .concat({
        id: "late",
        title: "后注册建议组件",
        kind: "metric",
        value_type: "decimal",
        presentation: { suggested: true, surface: ["overview"], order: -200 },
      }),
  );
  await expect(widget("自定义延迟")).toContainText("能力当前未注册");
  await expect(widget("自定义延迟")).toHaveClass(/size-small/);
  await expect(widgets).toHaveCount(1);
  await page.reload();
  await expect(widget("自定义延迟")).toContainText("能力当前未注册");
  await expect(widgets).toHaveCount(1);

  await register(
    2,
    declarations.map((entry) =>
      entry.id === "feed"
        ? {
            ...entry,
            title: "Agent 改名",
            presentation: { ...entry.presentation, default_size: "full" },
          }
        : entry,
    ),
  );
  await expect(widget("自定义延迟")).toHaveClass(/size-small/);
  await expect(widget("自定义延迟").getByText("能力当前未注册")).toHaveCount(0);
  await expect(widgets).toHaveCount(1);
  await page.goto("/strategies/" + id);
  await expect(widget("Agent 改名")).toHaveClass(/size-full/);
  await expect(widget("券商连接健康")).toBeVisible();

  await page.goto("/admin/integration?strategy=" + id);
  await page
    .getByRole("button", { name: "复制 AI 接入提示词", exact: true })
    .click();
  await page.getByText("显示 Sandbox 密钥", { exact: true }).click();
  const sandboxToken = await page
    .locator("details")
    .filter({ hasText: "显示 Sandbox 密钥" })
    .locator("code")
    .innerText();
  const sandboxPath = "/api/admin/strategies/" + id + "/sandbox";
  const sandboxInfo = await page.evaluate(
    async (path) => (await fetch(path)).json(),
    sandboxPath,
  );
  const sandboxEndpoint = "/api/agent/sandbox/" + sandboxInfo.id;
  const sandboxIdentity = await request.post(sandboxEndpoint + "/session", {
    headers: { Authorization: "Bearer " + sandboxToken },
    data: { instanceId: "sandbox-worker", bootId: "sandbox-boot" },
  });
  expect(sandboxIdentity.status()).toBe(201);
  const sandboxBearer = {
    Authorization: "Bearer " + (await sandboxIdentity.json()).session,
  };
  const trial = await request.put(sandboxEndpoint + "/capabilities", {
    headers: sandboxBearer,
    data: {
      revision: 0,
      capabilities: [
        {
          id: "simulated",
          kind: "action",
          value_type: "null",
          writable: true,
          title: "测试刷新",
        },
      ],
    },
  });
  expect(trial.status()).toBe(200);
  const ready = await request.put(sandboxEndpoint + "/state", {
    headers: sandboxBearer,
    data: {
      revision: 1,
      states: [{ id: "simulated", value: null, observedAt: Date.now() }],
    },
  });
  expect(ready.status()).toBe(200);
  const panel = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Sandbox", exact: true }),
    });
  await panel
    .getByRole("button", { name: "下发模拟命令", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(sandboxEndpoint + "/commands?wait=0", {
              headers: sandboxBearer,
            })
          ).json()
        ).length,
    )
    .toBe(1);
  await panel.getByText("Sandbox 请求记录").click();
  await expect(
    panel.getByRole("cell", { name: "capabilities", exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Sandbox 密钥已失效");
  expect(
    (
      await request.put(sandboxEndpoint + "/heartbeat", {
        headers: sandboxBearer,
      })
    ).status(),
  ).toBe(401);

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
    (await fetch("/api/admin/notifications")).json(),
  );
  expect(JSON.stringify(channels)).not.toContain("local-browser-test-token");

  for (const appearance of ["light", "dark"]) {
    await page.evaluate((mode) => {
      localStorage.setItem("qb.appearance", mode);
    }, appearance);
    for (const width of [390, 430, 768, 1280, 1600]) {
      await request.put("/api/agent/heartbeat", { headers });
      await page.setViewportSize({ width, height: 1000 });
      for (const [label, path] of [
        ["home", "/"],
        ["detail", "/strategies/" + id],
        ["admin", "/admin/dashboard"],
        ["audit", "/admin/audit"],
        ["notifications", "/admin/notifications"],
        ["sandbox", "/admin/integration?strategy=" + id],
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
