import { expect, type Page } from "@playwright/test";

/** Учётки посева — те же, что печатает `db:seed` */
export const ACCOUNTS = {
  superadmin: { email: "root@quizzy.dev", password: "root12345" },
  psy: { email: "psy@quizzy.dev", password: "psy12345" },
  psy2: { email: "psy2@quizzy.dev", password: "psy212345" },
};

export async function login(page: Page, who: keyof typeof ACCOUNTS) {
  const acc = ACCOUNTS[who];
  await page.goto("/");
  await page.getByLabel("Email").fill(acc.email);
  await page.getByLabel("Пароль").fill(acc.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.getByRole("navigation").or(page.locator(".sidebar")).first().waitFor();
}

export async function logout(page: Page) {
  await page.getByRole("button", { name: /Выйти/i }).click();
}

/**
 * Поле конструктора по подписи.
 *
 * Обычный getByLabel не годится: у двуязычного поля два ввода — украинский и
 * русский, — а подпись у них одна на двоих, и getByLabel вернул бы оба.
 * Нужный выбирается по подсказке внутри поля: она и есть то, что отличает их
 * друг от друга, а не подпорка ради теста.
 *
 * Подпись ищется по вложенному span, а не по самому label: `:text-is`
 * сравнивает собственный текст элемента, а label теперь оборачивает и
 * подпись, и само поле — его прямых текстовых узлов нет.
 */
export function fieldByLabel(page: Page, label: string, lang: "uk" | "ru" = "ru") {
  return page
    .locator(`[data-field]:has(> label > span:text-is("${label}"))`)
    .first()
    .locator(`[placeholder="${lang === "uk" ? "українською" : "по-русски"}"]`);
}

/**
 * Строки таблицы текстом. Через expect.poll, а не waitFor: после смены
 * пользователя старая таблица какое-то время ещё в DOM, и одиночное ожидание
 * успевает совпасть с ней, а читается уже пустой экран загрузки.
 */
export async function rowTexts(page: Page): Promise<string[]> {
  const rows = page.locator("table tbody tr");
  /*
   * Возвращается ровно тот список, который удовлетворил проверке, а не
   * прочитанный заново.
   *
   * Между «строки появились» и «прочитать строки» таблица успевает
   * перерисоваться — и вторым чтением приходил пустой массив. Тест падал не
   * на утверждении о правах, а на пустом списке, то есть выглядел как
   * нарушение разграничения там, где просто не повезло со временем. Дырку в
   * правах такой тест, наоборот, пропустил бы: пустой список сравнивать не с
   * чем.
   */
  let texts: string[] = [];
  await expect
    .poll(async () => {
      texts = await rows.allTextContents();
      return texts.length;
    })
    .toBeGreaterThan(0);
  return texts;
}

/**
 * Перейти по разделу рельсы.
 *
 * Группы раскрываются по нажатию, и пунктов закрытой группы нет в разметке
 * вовсе — не «не видно», а не существует. Сценарий, который просто кликает
 * по ссылке, повисает на семь секунд и падает по таймауту, и падает так,
 * что причина не названа: «locator not found» ничего не говорит о том, что
 * раздел закрыт.
 *
 * Поэтому переход через рельсу идёт одним помощником: сперва раскрывается
 * группа, потом нажимается пункт. Свёрнутая до значков рельса групп не
 * имеет — там пункт уже на месте, и раскрывать нечего.
 */
export async function goVia(page: Page, group: RegExp | string, link: RegExp | string) {
  const header = page.locator(".sidebar button[aria-expanded]").filter({ hasText: group }).first();
  if (await header.count()) {
    if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
  }
  await page.getByRole("link", { name: link }).first().click();
}
