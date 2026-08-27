import { expect, test } from "@playwright/test";
import { ACCOUNTS, login } from "./helpers";

test.describe("вход в консоль", () => {
  test("неверный пароль не пускает и не роняет страницу", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Email").fill(ACCOUNTS.psy.email);
    await page.getByLabel("Пароль").fill("не-тот-пароль");
    await page.getByRole("button", { name: "Войти" }).click();

    await expect(page.locator(".error")).toBeVisible();
    await expect(page.locator(".sidebar")).toHaveCount(0);
  });

  test("сотрудник входит и видит навигацию", async ({ page }) => {
    await login(page, "psy");
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.getByRole("link", { name: "Пациенты" })).toBeVisible();
  });

  test("сессия переживает перезагрузку страницы", async ({ page }) => {
    await login(page, "psy");
    await page.reload();
    await expect(page.locator(".sidebar")).toBeVisible();
  });

  test("администрирование видно только суперадмину", async ({ page }) => {
    await login(page, "psy");
    await expect(page.getByRole("link", { name: "Журнал доступа" })).toHaveCount(0);

    await page.getByRole("button", { name: /Выйти/i }).click();
    await login(page, "superadmin");
    await expect(page.getByRole("link", { name: "Журнал доступа" })).toBeVisible();
  });
});
