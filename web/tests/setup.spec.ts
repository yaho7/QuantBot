import { expect, test } from "@playwright/test";

test("guides first-time setup and then uses normal login", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "初始化 QuantBot" })).toBeVisible();
  await page.getByLabel("用户名").fill("setup-admin");
  await page.getByLabel("密码", { exact: false }).first().fill("browser-setup-password");
  await page.getByLabel("确认密码").fill("browser-setup-different");
  await page.getByRole("button", { name: "创建管理员" }).click();
  await expect(page.getByRole("alert")).toContainText("两次输入的密码不一致");
  await page.getByLabel("确认密码").fill("browser-setup-password");
  await page.getByRole("button", { name: "创建管理员" }).click();
  await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "登录 QuantBot" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建管理员" })).toHaveCount(0);
});
