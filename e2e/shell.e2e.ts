import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, emailField, eventsBell, login, logout, passwordField } from "./helpers";

/**
 * Оболочка консоли на общем компьютере ординаторской.
 *
 * Один выходит, другой входит — в той же вкладке, без перезагрузки страницы.
 * Настройки рабочего места (тема, плотность, движение) лежат в профиле на
 * сервере и обязаны приходить для КАЖДОГО вошедшего: оболочка применяла их
 * один раз за жизнь вкладки, и второй получал тему первого.
 */

/**
 * Войти снова в той же вкладке: после выхода с «/» гость видит лендинг, и на
 * форму ведёт «Увійти» в шапке — ссылкой маршрутизатора, без перезагрузки.
 */
async function signInHere(page: Page, who: keyof typeof ACCOUNTS) {
  const acc = ACCOUNTS[who];
  if (!(await emailField(page).isVisible())) await page.getByRole("link", { name: /^(Войти|Увійти)$/ }).first().click();
  await emailField(page).fill(acc.email);
  await passwordField(page).fill(acc.password);
  await page.getByRole("button", { name: /^(Войти|Увійти)$/ }).click();
  await eventsBell(page).waitFor();
}

const theme = (page: Page) => page.locator("html");
const choose = (page: Page, name: RegExp) => page.getByRole("button", { name }).first().click();

test("тема второго вошедшего — из его профиля, а не тема ушедшего", async ({ page }) => {
  // psy2 выбирает светлую — она ложится в его профиль
  await login(page, "psy2");
  await choose(page, /^(Світла тема|Светлая тема)$/);
  await expect(theme(page)).toHaveAttribute("data-theme", "light");
  await logout(page);

  // psy в той же вкладке — тёмную
  await signInHere(page, "psy");
  await choose(page, /^(Темна тема|Тёмная тема)$/);
  await expect(theme(page)).toHaveAttribute("data-theme", "dark");
  await logout(page);

  // снова psy2, без перезагрузки: его светлая из профиля, а не тёмная psy
  await signInHere(page, "psy2");
  await expect(theme(page)).toHaveAttribute("data-theme", "light");
});

/**
 * Консоль прокручивает только область содержимого, а не весь документ.
 *
 * Подписи sr-only у строк списка — абсолютные; без позиционированного предка
 * они отсчитывались от окна, и их «место» уходило в прокрутку документа: на
 * каталоге документ вырастал до трёх тысяч пикселей, и колесо, дойдя до конца
 * списка, уводило вверх всю консоль вместе с рельсой, открывая под ней
 * пустоту. Проверка не зависит от данных стенда: в область содержимого
 * кладётся высокий блок с такой же подписью в самом низу — ровно то, что
 * делает длинный список, — и документ обязан остаться высотой в окно.
 */
test("абсолютная подпись внизу длинного списка не растит документ", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/surveys");
  await expect(page.locator("main [tabindex='0']").first()).toBeVisible();
  const sizes = await page.evaluate(() => {
    const area = document.querySelector<HTMLElement>("main [tabindex='0']")!;
    const tall = document.createElement("div");
    tall.style.height = "3000px";
    const label = document.createElement("span");
    label.className = "sr-only";
    label.textContent = "PHQ-9";
    tall.append(document.createElement("div"), label);
    (tall.firstElementChild as HTMLElement).style.height = "2990px";
    area.append(tall);
    area.scrollTop = area.scrollHeight;
    window.scrollTo(0, document.scrollingElement!.scrollHeight);
    const doc = document.scrollingElement!;
    const out = { doc: doc.scrollHeight, view: doc.clientHeight, top: doc.scrollTop };
    tall.remove();
    return out;
  });
  expect(sizes.doc, "документ вырос выше окна").toBe(sizes.view);
  expect(sizes.top, "документ прокрутился").toBe(0);
});
