import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Разбор случаев риска — экран, ради которого система и существует.
 *
 * Проверяется поведение, а не разметка: что фильтры действительно сужают
 * выборку, что взятый случай виден как взятый, что подгрузка дописывает
 * страницу, а не заменяет её, и что разобранный уходит из очереди.
 */

const cases = (page: import("@playwright/test").Page) => page.locator(".card.case");

test.beforeEach(async ({ page }) => {
  await login(page, "psy");
  await page.getByRole("link", { name: /^Случаи риска/ }).click();
  await expect(page.getByRole("heading", { name: "Разбор случаев" })).toBeVisible();
  await expect(cases(page).first()).toBeVisible();
});

test("фильтр по выраженности сужает выборку, а не перекрашивает её", async ({ page }) => {
  const before = await cases(page).count();

  await page.getByRole("button", { name: "Только тяжёлые", exact: true }).click();
  await expect.poll(async () => cases(page).count()).toBeLessThanOrEqual(before);

  // и фильтр держится в адресе: ссылку на отобранное можно передать
  expect(page.url()).toContain("severity=severe");

  await page.reload();
  await expect(page.getByRole("button", { name: "Только тяжёлые", exact: true })).toHaveClass(/active/);
});

test("подгрузка дописывает страницу, а не заменяет показанное", async ({ page }) => {
  const more = page.getByRole("button", { name: /Показать ещё|Загрузить ещё/ });
  if ((await more.count()) === 0) test.skip(true, "случаев меньше страницы");

  const first = await cases(page).first().textContent();
  const before = await cases(page).count();

  await more.first().click();
  await expect.poll(async () => cases(page).count()).toBeGreaterThan(before);

  // первый остался первым: дописали, а не перезагрузили
  expect(await cases(page).first().textContent()).toBe(first);
});

test("взятый случай помечен и отпускается обратно", async ({ page }) => {
  const free = cases(page)
    .filter({ has: page.getByRole("button", { name: "Взять на себя" }) })
    .first();
  await expect(free).toBeVisible();
  // после действия список перечитывается и порядок может измениться —
  // держимся за человека, а не за позицию карточки
  const who = (await free.locator("strong").first().textContent())!.trim();
  const card = cases(page).filter({ hasText: who }).first();

  await card.getByRole("button", { name: "Взять на себя" }).click();
  await expect(card.getByRole("button", { name: "Отпустить" })).toBeVisible();
  await expect(card).toContainText("на мне");

  await card.getByRole("button", { name: "Отпустить" }).click();
  await expect(card.getByRole("button", { name: "Взять на себя" })).toBeVisible();
});

test("разобранный случай уходит из очереди и находится по фильтру", async ({ page }) => {
  /*
   * Случай опознаётся парой «человек + методика»: у одного человека их бывает
   * несколько, а считать карточки бесполезно — очередь длиннее страницы, и на
   * место разобранного тут же подтягивается следующий.
   */
  const target = cases(page).first();
  const who = (await target.locator("strong").first().textContent())!.trim();
  const title = (await target.locator(".hint").first().textContent())!.split("·")[0]!.trim();
  const sameCase = () => cases(page).filter({ hasText: who }).filter({ hasText: title });

  // у одного человека по одной методике бывает несколько случаев подряд
  // (окно случая закрывается по времени), поэтому считаем убыль, а не ноль
  const openBefore = await sameCase().count();

  await target.getByPlaceholder("Что предпринято").fill("Смоук разбора");
  await target.getByRole("button", { name: "Риск подтверждён", exact: true }).click();

  await expect.poll(async () => sameCase().count()).toBe(openBefore - 1);

  // и находится, если попросить показать разобранные
  await page.getByRole("button", { name: "Все", exact: true }).first().click();
  const resolved = sameCase().first();
  await expect(resolved).toBeVisible();
  await expect(resolved).toContainText("Риск подтверждён");
  await expect(resolved).toContainText("Смоук разбора");
});
