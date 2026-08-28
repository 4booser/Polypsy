import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Разбор случаев — экран, ради которого система и существует.
 *
 * После перехода на три панели очередь и случай живут рядом: выбор строки не
 * уводит со списка. Проверяется поведение, а не разметка: что фильтр
 * действительно сужает выборку, что подгрузка дописывает страницу, что взятый
 * случай помечен и что разобранный уходит из очереди.
 */

const rows = (page: import("@playwright/test").Page) => page.locator(".queue-row");
const detail = (page: import("@playwright/test").Page) => page.locator(".triage-case .card.case");

test.beforeEach(async ({ page }) => {
  await login(page, "psy");
  await page.getByRole("link", { name: /^Случаи риска/ }).click();
  await expect(rows(page).first()).toBeVisible();
});

test("выбор строки меняет случай, не уводя со списка", async ({ page }) => {
  const second = rows(page).nth(1);
  const who = (await second.locator(".queue-name").textContent())!.trim();
  const before = await rows(page).count();

  await second.click();

  await expect(detail(page)).toContainText(who);
  // очередь осталась на месте — в этом весь смысл трёх панелей
  expect(await rows(page).count()).toBe(before);
  await expect(second).toHaveAttribute("aria-current", "true");
});

test("фильтр по выраженности сужает выборку и держится в адресе", async ({ page }) => {
  const before = await rows(page).count();

  await page.getByRole("button", { name: "Только тяжёлые", exact: true }).click();
  await expect.poll(async () => rows(page).count()).toBeLessThanOrEqual(before);
  expect(page.url()).toContain("severity=severe");

  await page.reload();
  await expect(page.getByRole("button", { name: "Только тяжёлые", exact: true })).toHaveClass(/active/);
});

test("подгрузка дописывает страницу, а не заменяет показанное", async ({ page }) => {
  const more = page.getByRole("button", { name: /Показать ещё|Загрузить ещё/ });
  if ((await more.count()) === 0) test.skip(true, "случаев меньше страницы");

  const first = (await rows(page).first().locator(".queue-name").textContent())!.trim();
  const before = await rows(page).count();

  await more.first().click();
  await expect.poll(async () => rows(page).count()).toBeGreaterThan(before);

  // первый остался первым: дописали, а не перезагрузили
  expect((await rows(page).first().locator(".queue-name").textContent())!.trim()).toBe(first);
});

test("взятый случай помечен и отпускается обратно", async ({ page }) => {
  /*
   * Фильтр «никем не взяты» здесь не годится: взятый случай перестаёт ему
   * соответствовать и исчезает из очереди — это правильное поведение, но
   * проверять на нём пометку нельзя. Ищем свободный случай перебором.
   */
  const take = () => detail(page).getByRole("button", { name: "Взять на себя" });
  const count = Math.min(await rows(page).count(), 8);
  for (let i = 0; i < count; i++) {
    await rows(page).nth(i).click();
    if (await take().isVisible()) break;
  }
  await expect(take()).toBeVisible();

  await take().click();
  await expect(detail(page).getByRole("button", { name: "Отпустить" })).toBeVisible();
  await expect(detail(page)).toContainText("на мне");

  await detail(page).getByRole("button", { name: "Отпустить" }).click();
  await expect(take()).toBeVisible();
});

test("разобранный случай уходит из очереди и находится по фильтру", async ({ page }) => {
  const who = (await rows(page).first().locator(".queue-name").textContent())!.trim();
  const title = (await rows(page).first().locator(".queue-meta").textContent())!.trim();
  /*
   * Случай опознаётся парой «человек + методика»: у одного человека их бывает
   * несколько, а считать строки бесполезно — очередь длиннее страницы, и на
   * место разобранного подтягивается следующий.
   */
  const same = () => rows(page).filter({ hasText: who }).filter({ hasText: title.split("·").pop()!.trim() });
  const before = await same().count();

  await rows(page).first().click();
  await detail(page).getByPlaceholder("Что предпринято").fill("Смоук разбора");
  await detail(page).getByRole("button", { name: "Риск подтверждён", exact: true }).click();

  await expect.poll(async () => same().count()).toBe(before - 1);

  await page.getByRole("button", { name: "Все", exact: true }).first().click();
  await expect(page.locator(".queue-row.done").first()).toBeVisible();
});
