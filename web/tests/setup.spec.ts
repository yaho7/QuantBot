import { expect, test } from "@playwright/test";

test("keeps the first-time form stable and accepts an eight-character password", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "初始化 QuantBot" })).toBeVisible();
  let backgroundReads = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && /\/admin\/(setup|session)$/.test(request.url())) backgroundReads++;
  });
  await page.getByLabel("用户名").fill("setup-admin");
  const password = page.getByLabel("密码", { exact: false }).first();
  await password.fill("qb-pass8");
  await page.clock.runFor(26_000);
  await page.evaluate(() => { window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(password).toHaveValue("qb-pass8");
  expect(backgroundReads).toBe(0);
  await page.getByLabel("确认密码").fill("mismatch");
  await page.getByRole("button", { name: "创建管理员" }).click();
  await expect(page.getByRole("alert")).toContainText("两次输入的密码不一致");
  await page.getByLabel("确认密码").fill("qb-pass8");
  await page.getByRole("button", { name: "创建管理员" }).click();
  await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录 QuantBot" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建管理员" })).toHaveCount(0);
  await page.getByLabel("用户名").fill("setup-admin");
  await page.getByLabel("密码", { exact: true }).fill("qb-pass8");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
});
