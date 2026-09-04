import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Доступность проверяется автоматически там, где это возможно: контраст,
 * подписи полей, роли, порядок заголовков. Автопроверка ловит примерно
 * половину реальных проблем — остальное только руками, но эта половина
 * возвращается при каждой правке вёрстки, и ловить её должен CI.
 */
async function scan(page: Page) {
  return new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
}

/** Нарушения в читаемом виде: id правила и селекторы, а не «ожидалось []» */
function digest(violations: Awaited<ReturnType<typeof scan>>["violations"]) {
  return violations.flatMap((v) => v.nodes.map((n) => `${v.id} → ${n.target.join(" ")}`));
}

test("экран входа доступен", async ({ page }) => {
  await page.goto("/");
  expect(digest((await scan(page)).violations)).toEqual([]);
});

// обе темы: тёмная по умолчанию, светлая — та, в которой работают при дневном
// свете, и контраст в ней проваливается независимо
for (const theme of ["dark", "light"] as const) {
  for (const [name, path] of [
    ["сводка", "/"],
    ["пациенты", "/patients"],
    ["случаи риска", "/alerts"],
    // витрина: все компоненты во всех состояниях сразу — самая плотная
    // проверка доступности, какая у нас есть
    ["библиотека", "/ui"],
    ["направления", "/referrals"],
    /*
     * Экраны, появившиеся с расписанием и приёмом. Их шесть, и ни один не
     * проверялся: доступность ловится автоматически ровно наполовину, но эта
     * половина возвращается при каждой правке вёрстки — а вёрстки за
     * последние волны написано больше, чем за всё до них.
     */
    ["сегодня", "/today"],
    ["расписание приёма", "/my-schedule"],
    ["переписка", "/messages"],
    ["права", "/permissions"],
  ] as const) {
    test(`экран «${name}» доступен, тема ${theme}`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("quizzy.theme", t), theme);
      await login(page, "psy");
      await page.goto(path);
      await page.locator("h1, .card, [data-panel]").first().waitFor();
      expect(digest((await scan(page)).violations)).toEqual([]);
    });
  }
}

/*
 * Экран приёма — с параметром, поэтому отдельно. Именно на нём больше всего
 * новой вёрстки: три панели, запись приёма, обращения, диспансерный учёт,
 * вставка из библиотеки. Пропустить его значило бы проверить всё, кроме
 * самого плотного места.
 */
for (const theme of ["dark", "light"] as const) {
  test(`экран приёма доступен, тема ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("quizzy.theme", t), theme);
    await login(page, "psy");
    await page.goto("/today");
    await page.locator('a[href^="/visit/"]').first().click();
    await page.getByRole("heading", { name: "Приём", exact: true }).waitFor();
    await page.waitForTimeout(600);
    expect(digest((await scan(page)).violations)).toEqual([]);
  });
}


test("день отмечается с клавиатуры, без мыши", async ({ page }) => {
  /*
   * Автопроверка ловит подписи и контраст, но не отвечает на вопрос
   * «можно ли этим пользоваться без мыши». А за стойкой мышь — не всегда
   * самое быстрое: явку отмечают между двумя людьми, не глядя на экран.
   *
   * Проверяется путь целиком: дойти до кнопки табуляцией и нажать её
   * пробелом. Клик мышью по той же кнопке этого бы не доказал.
   */
  await login(page, "psy");
  await page.goto("/today");
  /*
   * Заголовком экрана стоит дата, а «Сегодня» — вкладка: сводка и приём
   * слиты в один экран.
   */
  await page.getByRole("link", { name: "Сегодня" }).waitFor();

  const came = page.getByRole("button", { name: "Пришёл" }).first();
  await expect(came).toBeVisible();

  // до кнопки добираемся табуляцией, а не фокусируем её напрямую:
  // focus() доказал бы, что кнопка принимает фокус, но не что до неё дойти
  let reached = false;
  for (let i = 0; i < 60 && !reached; i += 1) {
    await page.keyboard.press("Tab");
    reached = await came.evaluate((el) => el === document.activeElement);
  }
  expect(reached, "до кнопки «Пришёл» нельзя добраться табуляцией").toBe(true);

  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Начать" }).first()).toBeVisible();
});
