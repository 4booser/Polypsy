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
test("j и k ведут по очереди, / ставит курсор в поиск", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/alerts");
  await page.locator(".queue-row").first().waitFor();

  const rows = page.locator(".queue-row");
  await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");

  await page.keyboard.press("j");
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(rows.nth(0)).not.toHaveAttribute("aria-current", "true");

  await page.keyboard.press("k");
  await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");

  await page.keyboard.press("/");
  await expect(page.locator(".triage-filters input")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator(".triage-filters input")).not.toBeFocused();
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
