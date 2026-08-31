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
    await expect(page.locator("h1")).toHaveText(marker);
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

/*
 * Все экраны, которые открываются без параметра в адресе.
 *
 * Было четырнадцать из тридцати трёх — и забытая строка обычно сидела как раз
 * на пропущенном. Экраны с параметром (карта пациента, аналитика методики)
 * сюда не входят: им нужен идентификатор из посева, и они проверяются
 * отдельным сценарием в screens.e2e.ts. Статическую проверку исходников это
 * не заменяет и не дублирует: та ловит строку в момент написания, эта — то,
 * что строка действительно доехала до экрана переведённой.
 */
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
  "/groups",
  "/pathways",
  "/cohorts",
  "/search",
  "/conclusion-batch",
  "/constructor",
  "/users",
  "/consent-text",
  "/permissions",
];

test("в украинском режиме не остаётся русских слов", async ({ page }) => {
  /*
   * Бюджет считается от числа экранов, а не берётся общий.
   *
   * Проверка открывает каждый экран дважды — по разу на язык, — и растёт
   * вместе со списком. С общим тридцатисекундным бюджетом она однажды
   * упирается в него не потому, что что-то сломалось, а потому что экранов
   * стало на два больше; так и вышло. Падение по времени в проверке полноты
   * перевода — худший вид ложной тревоги: смотреть в ней надо на слова, а не
   * на секундомер.
   */
  test.setTimeout(SCREENS.length * 3_000);
  await login(page, "psy");

  const wordsOf = async (path: string) => {
    await page.goto(path);
    await page.locator("h1").waitFor();
    /*
     * Заголовок появляется раньше содержимого: на «Сравнении» графики
     * приезжают отдельным запросом. Ждать «тишины в сети» нельзя — консоль
     * держит открытым поток событий, и она не наступает никогда. Ждём, пока
     * исчезнут скелеты: это и есть признак, что данные приехали.
     */
    await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    await page.waitForTimeout(150);
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
