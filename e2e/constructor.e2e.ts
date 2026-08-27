import { expect, test } from "@playwright/test";
import { fieldByLabel, login } from "./helpers";

const ITEMS = [
  "1. Я легко засыпаю после дежурства.",
  "2. Резкие звуки заставляют меня вздрагивать.",
  "3. Я могу спокойно говорить о том, что было.",
].join("\n");

test("методика создаётся из вставленного текста и публикуется", async ({ page }) => {
  await login(page, "psy");
  await page.getByRole("link", { name: "Методики" }).click();
  await page.getByRole("link", { name: "Создать методику" }).click();
  await expect(page.getByRole("heading", { name: "Новая методика" })).toBeVisible();

  const title = `Смоук ${Date.now()}`;
  await fieldByLabel(page, "Название", "ru").fill(title);
  await fieldByLabel(page, "Название", "uk").fill(title);

  // главный сценарий переноса методики из пособия — вставка пунктов текстом
  await page.getByRole("button", { name: /^Вопросы/ }).click();
  await page.getByRole("button", { name: "Вставить пункты из текста" }).click();
  await page.getByRole("textbox").filter({ hasText: "" }).last().fill(ITEMS);
  await page.getByRole("button", { name: /Добавить 3 пункт/ }).click();

  await expect(page.getByRole("button", { name: "Вопросы 3" })).toBeVisible();

  await page.getByRole("button", { name: "Проверить структуру" }).click();
  await page.getByRole("button", { name: "Сохранить и опубликовать" }).click();

  // публикация уводит на аналитику новой методики: версия 1, прохождений нет
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("версия 1")).toBeVisible();

  await page.getByRole("link", { name: "Методики" }).click();
  await expect(page.getByRole("link", { name: title })).toBeVisible();
});
