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
    ["/referrals", "Направлення"],
    ["/unit-report", "Стан підрозділу"],
  ] as const) {
    await page.goto(path);
    await expect(page.locator(".page-head h1")).toHaveText(marker);
  }
});

/**
 * Русские остатки в украинском режиме.
 *
 * Точечных проверок «этот заголовок переведён» мало: строка, забытая в
 * середине экрана, не ломает ни один тест и живёт годами. Здесь читается весь
 * видимый текст страницы и ищутся буквы, которых в украинском алфавите нет.
 *
 * ы, ъ, э, ё — надёжный признак: слово с ними по-украински не пишется.
 *
 * Отделить оболочку от данных нельзя по написанию: названия методик, ФИО и
 * подразделения в посеве русские, и это правильно — содержимое базы не
 * переводится переключателем. Поэтому страница читается дважды, на обоих
 * языках, и подозрительным считается лишь то, что не изменилось: данные
 * совпадут, а непереведённая подпись останется на месте.
 */
const RUSSIAN_ONLY = /[ыъэё]/i;

const SCREENS = [
  "/",
  "/worklist",
  "/alerts",
  "/patients",
  "/referrals",
  "/unit-report",
  "/surveys",
  "/batteries",
  "/schedules",
  "/invites",
  "/kiosk-sessions",
  "/audit",
  "/compare",
  "/surveillance",
];

test("в украинском режиме не остаётся русских слов", async ({ page }) => {
  await login(page, "psy");

  const wordsOf = async (path: string) => {
    await page.goto(path);
    await page.locator(".page-head h1").waitFor();
    /*
     * Заголовок появляется раньше содержимого: на «Сравнении» графики
     * приезжают отдельным запросом. Без ожидания один проход читает пустой
     * экран, второй — заполненный, и разница выглядит как непереведённые
     * строки.
     */
    await page.waitForLoadState("networkidle");
    const text = await page.locator("main").innerText();
    return new Set(text.split(/[\s,.:;()«»…—-]+/).filter((w) => RUSSIAN_ONLY.test(w)));
  };

  const found: string[] = [];
  for (const path of SCREENS) {
    await page.getByRole("button", { name: "РУС" }).click();
    const inRussian = await wordsOf(path);
    await page.getByRole("button", { name: "УКР" }).click();
    const inUkrainian = await wordsOf(path);

    // осталось в украинском ровно то же, что было в русском, — значит данные;
    // всё прочее — забытая строка оболочки
    for (const word of inUkrainian) {
      if (!inRussian.has(word)) found.push(`${path}: ${word}`);
    }
  }

  expect(found).toEqual([]);
});
