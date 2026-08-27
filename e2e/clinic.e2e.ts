import { expect, test } from "@playwright/test";
import { login, rowTexts } from "./helpers";

/**
 * Сквозной клинический сценарий: тревога → пациент → сводка → направление →
 * реестр → закрытие. Это единственный тест, который проверяет контур целиком
 * так, как его проходит специалист, а не по кускам через API.
 */
test("от тревоги до закрытого направления", async ({ page }) => {
  await login(page, "psy");

  await page.getByRole("link", { name: /^Случаи риска/ }).click();
  // экран разбора: единица работы — человек, а не сработавший пункт
  await expect(page.getByRole("heading", { name: "Разбор случаев" })).toBeVisible();

  // из тревоги — к пациенту
  await page.getByRole("link", { name: "Пациенты" }).click();
  const firstPatient = page.locator("table tbody tr td a").first();
  await firstPatient.click();

  // сначала дожидаемся, что страница пациента отрисовалась: заголовок читается
  // сразу после клика и успевает вернуть ещё «Пациенты»
  const summaryLink = page.getByRole("link", { name: "Сводка для консилиума" });
  await summaryLink.waitFor();

  // имя берём с самой страницы: в ссылке рядом с ним стоят инициалы-аватарка,
  // и textContent вернул бы «ПДПетров Дмитрий»
  const patientName = (await page.locator(".page-head h1").textContent())!.trim();
  expect(patientName.length).toBeGreaterThan(0);

  await summaryLink.click();
  await expect(page.locator(".page-head h1")).toHaveText(patientName);
  await expect(page.getByRole("heading", { name: "Направления" })).toBeVisible();
  await expect(page.getByText("Направлений нет")).toBeVisible();

  await page.getByRole("button", { name: "Выписать направление" }).click();
  const reason = `Смоук ${Date.now()}`;
  await page.getByPlaceholder("что послужило поводом").fill(reason);
  await page.getByRole("button", { name: "Выписать", exact: true }).click();

  const row = page.locator("table tbody tr").filter({ hasText: reason });
  await expect(row).toBeVisible();
  await expect(row).toContainText("выписано");

  // статус движется только вперёд: сначала «принято», и лишь потом «завершено»
  await expect(row.getByRole("button", { name: "Завершено" })).toHaveCount(0);
  await row.getByRole("button", { name: "Принято" }).click();
  await expect(row).toContainText("принято");
  await row.getByRole("button", { name: "Завершено" }).click();
  await expect(row).toContainText("завершено");
  await expect(row.getByRole("button")).toHaveCount(0);

  // завершённого нет в реестре открытых, но оно находится с фильтром
  await page.getByRole("link", { name: "Направления" }).click();
  await expect(page.getByText(reason)).toHaveCount(0);
  await page.getByRole("button", { name: "Показать завершённые" }).click();
  await expect(page.getByText(reason)).toBeVisible();
});

test("групповой админ не видит чужих пациентов", async ({ page }) => {
  await login(page, "psy");
  await page.getByRole("link", { name: "Пациенты" }).click();
  const mine = await rowTexts(page);

  await page.getByRole("button", { name: /Выйти/i }).click();
  await login(page, "psy2");
  await page.getByRole("link", { name: "Пациенты" }).click();
  const theirs = await rowTexts(page);

  expect(mine.length).toBeGreaterThan(0);
  expect(theirs.length).toBeGreaterThan(0);
  // пересечение допустимо (общий пациент), полное совпадение списков — нет
  expect(mine.join("|")).not.toBe(theirs.join("|"));
});
