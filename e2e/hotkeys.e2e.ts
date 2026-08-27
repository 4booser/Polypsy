import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Горячие клавиши разбора.
 *
 * Разбор трёхсот случаев мышью — лишний час работы каждый день. Проверяется
 * не только то, что клавиши работают, но и то, что они НЕ работают в поле
 * ввода: иначе набор комментария «не подтверждён» ставил бы исходы на
 * каждой букве.
 */
test("j и k ведут по списку, / ставит курсор в поиск", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/alerts");
  await page.locator(".case").first().waitFor();

  const cards = page.locator(".case");
  await expect(cards.nth(0)).toHaveClass(/focused/);

  await page.keyboard.press("j");
  await expect(cards.nth(1)).toHaveClass(/focused/);
  await expect(cards.nth(0)).not.toHaveClass(/focused/);

  await page.keyboard.press("k");
  await expect(cards.nth(0)).toHaveClass(/focused/);

  await page.keyboard.press("/");
  await expect(page.locator(".page-head input")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator(".page-head input")).not.toBeFocused();
});

test("клавиши молчат, пока курсор в поле ввода", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/alerts");
  await page.locator(".case").first().waitFor();

  const note = page.locator(".case").first().locator("input").first();
  await note.click();
  await note.fill("");
  // «j» и «1» — обычные символы, пока человек печатает
  await page.keyboard.type("j1 наблюдение");
  await expect(note).toHaveValue("j1 наблюдение");

  // и фокус никуда не уехал
  await expect(note).toBeFocused();
});

test("подсказка по клавишам видна", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/alerts");
  await expect(page.locator(".hotkeys")).toBeVisible();
});
