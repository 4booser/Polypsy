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
  await expect.poll(async () => (await rows.allTextContents()).length).toBeGreaterThan(0);
  return rows.allTextContents();
}
