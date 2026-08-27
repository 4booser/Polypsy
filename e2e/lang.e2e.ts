import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Двуязычная оболочка.
 *
 * Госпиталь украинский, и держать консоль только на русском — не мелочь:
 * специалист читает эти экраны каждый день. Проверяется, что переключатель
 * действительно меняет оболочку, а выбор переживает перезагрузку.
 */
test("переключение языка меняет оболочку и запоминается", async ({ page }) => {
  await login(page, "psy");

  // конфигурация смоука ходит с русской локалью — стартуем с неё
  await expect(page.getByRole("link", { name: "Пациенты" })).toBeVisible();

  await page.getByRole("button", { name: "УКР" }).click();
  await expect(page.getByRole("link", { name: "Пацієнти" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Випадки ризику" })).toBeVisible();

  // язык страницы меняется тоже: от него зависят диктор и переносы слов
  await expect(page.locator("html")).toHaveAttribute("lang", "uk");

  await page.reload();
  await expect(page.getByRole("link", { name: "Пацієнти" })).toBeVisible();

  await page.getByRole("button", { name: "РУС" }).click();
  await expect(page.getByRole("link", { name: "Пациенты" })).toBeVisible();
});

test("экраны ежедневного пути переведены целиком", async ({ page }) => {
  await login(page, "psy");
  await page.getByRole("button", { name: "УКР" }).click();

  for (const [path, marker] of [
    ["/", "Зведення"],
    ["/worklist", "Черга роботи"],
    ["/alerts", "Розбір випадків"],
    ["/patients", "Пацієнти"],
  ] as const) {
    await page.goto(path);
    await expect(page.locator(".page-head h1")).toHaveText(marker);
  }
});
