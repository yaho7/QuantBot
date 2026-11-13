import { expect, test } from "@playwright/test";

test("aligns workbench controls and keeps the grid inside each supported viewport", async ({ page }) => {
  const http = page.request;
  expect((await http.post("/api/admin/login", { data: { username: "admin", password: "browser-test-password" } })).ok()).toBeTruthy();
  const created = await http.post("/api/admin/strategies", {
    data: { name: "需要截断的非常长的策略名称 · Alpha Pacific Global Portfolio", mode: "paper" },
  });
  const { strategy } = await created.json();
  await page.goto("/ui/#workbench");
  await expect(page.getByLabel("当前策略")).toHaveValue(strategy.id);
  const grid = page.locator(".workbench-grid");
  const entry = grid.locator('[data-widget="builtin-entry"]');
  const program = grid.locator('[data-widget="builtin-program"]');
  const risk = grid.locator('[data-widget="builtin-risk"]');
  for (const [width, height] of [[1280, 800], [768, 1024], [390, 844], [430, 932]] as const) {
    await page.setViewportSize({ width, height });
    await expect(entry).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await expect.poll(async () => {
      const select = (await page.getByLabel("当前策略").boundingBox())!;
      const add = (await page.getByRole("button", { name: "添加策略" }).boundingBox())!;
      return Math.abs(select.y + select.height - add.y - add.height);
    }).toBeLessThan(1);
    await expect.poll(async () => {
      const panel = (await grid.boundingBox())!;
      const control = (await entry.boundingBox())!;
      return Math.abs(control.width / panel.width - (width > 640 ? 0.5 : 1));
    }).toBeLessThan(0.03);
    await expect.poll(async () => Math.abs((await program.boundingBox())!.y - (await risk.boundingBox())!.y)).toBeLessThan(1);
  }
  await page.getByRole("button", { name: "编辑布局" }).click();
  await expect(entry.getByText("有效开仓权限")).toBeVisible();
  await expect(program.getByText("离线", { exact: true })).toBeVisible();
  await expect(entry.getByRole("button", { name: "暂停新开仓" })).toHaveCount(0);
  await page.getByRole("button", { name: "放弃修改" }).click();
  await page.getByLabel("当前策略").selectOption("");
  await expect(page).toHaveURL(/#workbench\/all$/);
  await page.goto("/ui/#workbench");
  await expect(page.getByLabel("当前策略")).toHaveValue("");
});
