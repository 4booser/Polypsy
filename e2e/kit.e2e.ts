import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Набор «Виразна» в браузере: то, что статической разметкой не проверить.
 *
 *  - ящик: Esc закрывает и сохраняет черновик, сообщение даёт «Повернутися»,
 *    фокус заперт внутри и возвращается открывшему;
 *  - поповер: открывается фокусом, Tab уходит в его кнопки, Esc закрывает и
 *    возвращает фокус на триггер;
 *  - таблица: «выбрать все» и полоса действий, сортировка по заголовку,
 *    J/K по строкам, Enter открывает строку;
 *  - окно, которое надо закончить: Esc его не закрывает.
 *
 * Всё — на витрине /ui: там каждый компонент стоит в настоящем виде.
 * Подписи витрины — украинские; подписи самих компонентов идут через
 * словарь, поэтому ищутся на обоих языках.
 */

async function openKit(page: Page) {
  await login(page, "psy");
  await page.goto("/ui");
  await page.getByRole("heading", { level: 1 }).waitFor();
}

/** Фокус сейчас внутри элемента */
async function focusInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const box = document.querySelector(sel);
    return !!box && box.contains(document.activeElement);
  }, selector);
}

test("ящик: Esc закрывает и сохраняет черновик, «Повернутися» возвращает его с набранным", async ({ page }) => {
  await openKit(page);
  const opener = page.getByRole("button", { name: "Панель дії", exact: true });
  await opener.click();

  const drawer = page.getByRole("dialog", { name: "Розбір сигналу № 214" });
  await expect(drawer).toBeVisible();
  const note = drawer.getByRole("textbox", { name: "Нотатка до розбору" });
  // вид ставит курсор в своё поле (data-autofocus) — работать можно сразу
  await expect(note).toBeFocused();
  await note.fill("Розмова телефоном о 16:52");

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  // фокус вернулся туда, откуда ящик открыли
  await expect(opener).toBeFocused();

  const toast = page.locator(".toasts .toast").filter({ hasText: /розбору сигналу № 214/ });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: /^(Повернутися|Вернуться)/ }).click();

  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("textbox", { name: "Нотатка до розбору" })).toHaveValue("Розмова телефоном о 16:52");
});

test("ящик: Tab и Shift+Tab не выводят фокус наружу", async ({ page }) => {
  await openKit(page);
  await page.getByRole("button", { name: "Панель дії", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Розбір сигналу № 214" })).toBeVisible();

  for (const key of ["Tab", "Shift+Tab"]) {
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press(key);
      expect(await focusInside(page, "[data-drawer][data-open='true']"), `${key} №${i + 1} вывел фокус из ящика`).toBe(true);
    }
  }
});

test("ящик: подложка закрывает так же, как Esc, — черновик остаётся", async ({ page }) => {
  await openKit(page);
  await page.getByRole("button", { name: "Відповідь у панелі", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Відповідь Андрію" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("textbox", { name: "Текст відповіді" }).fill("Так, перенесемо на 18:00");
  // подложка — слева от ящика
  await page.mouse.click(40, 400);
  await expect(drawer).toBeHidden();
  await expect(page.locator(".toasts .toast").filter({ hasText: /відповіді Андрію/ })).toBeVisible();

  await page.getByRole("button", { name: "Відповідь у панелі", exact: true }).click();
  await expect(drawer.getByRole("textbox", { name: "Текст відповіді" })).toHaveValue("Так, перенесемо на 18:00");
});

test("поповер: фокус открывает, Tab уходит в его кнопки, Esc закрывает и возвращает фокус", async ({ page }) => {
  await openKit(page);
  const trigger = page.getByRole("button", { name: "Поповер на фокусі" });
  await trigger.focus();

  const pop = page.getByRole("dialog", { name: "Сигнал ризику № 214" });
  await expect(pop).toBeVisible();
  // триггер описан поповером: диктор читает его содержимое
  const id = await pop.getAttribute("id");
  await expect(trigger).toHaveAttribute("aria-describedby", id!);

  await page.keyboard.press("Tab");
  await expect(pop.getByRole("button", { name: "Розібрати" })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("поповер: Tab мимо — закрывается, сам по себе на экране не висит", async ({ page }) => {
  await openKit(page);
  const trigger = page.getByRole("button", { name: "Поповер на фокусі" });
  await trigger.focus();
  const pop = page.getByRole("dialog", { name: "Сигнал ризику № 214" });
  await expect(pop).toBeVisible();
  await page.keyboard.press("Tab"); // в поповер
  await page.keyboard.press("Tab"); // за поповер
  await expect(pop).toBeHidden();
});

test("таблица: «выбрать все» отмечает видимые, полоса действий считает, второе нажатие снимает", async ({ page }) => {
  await openKit(page);
  const table = page.getByRole("table", { name: "Пацієнти" });
  await table.scrollIntoViewIfNeeded();
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(5);

  const bulk = page
    .getByRole("region", { name: /^(Вибрано|Выбрано)$/ })
    .filter({ has: page.getByRole("button", { name: "Призначити методику" }) });
  // на витрине двое отмечены заранее: «выбрать все» — в неполном состоянии
  await expect(bulk).toContainText("2");

  const all = table.getByRole("checkbox", { name: /^(Вибрати всі рядки|Выбрать все строки)$/ });
  await all.click();
  await expect(all).toBeChecked();
  await expect(bulk).toContainText("5");
  await expect(table.getByRole("checkbox", { name: /^(Вибрати рядок|Выбрать строку)$/ }).first()).toBeChecked();

  await all.click();
  await expect(all).not.toBeChecked();
  await expect(bulk).toHaveCount(0);
});

test("таблица: заголовок сортирует и говорит направление; J/K ведут по строкам, Enter открывает", async ({ page }) => {
  await openKit(page);
  const table = page.getByRole("table", { name: "Пацієнти" });
  await table.scrollIntoViewIfNeeded();
  const header = table.getByRole("columnheader", { name: /Останній замір/ });
  const firstName = () => table.locator("tbody tr").first().locator("td").nth(1);

  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");
  await expect(firstName()).toContainText("Ткаченко");
  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "descending");
  await expect(firstName()).toContainText("Бойко");

  // одна остановка Tab на таблицу: строка «в руке»
  const stop = table.locator('tbody tr[tabindex="0"]');
  await expect(stop).toHaveCount(1);
  await stop.focus();
  const first = await stop.getAttribute("data-key");
  await page.keyboard.press("j");
  const second = await page.evaluate(() => document.activeElement?.getAttribute("data-key"));
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  await page.keyboard.press("k");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-key"))).toBe(first);

  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Розбір сигналу № 214" })).toBeVisible();
});

test("клавиши экрана: «/» — по месту клавиши и на кириллице; под открытым окном молчат", async ({ page }) => {
  await openKit(page);
  const search = page.getByRole("searchbox", { name: "ПІБ, картка або телефон" });

  await page.keyboard.press("/");
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(search).not.toBeFocused();

  /*
   * Украинская раскладка: клавиша, на которой нарисован «/», печатает «.».
   * Playwright раскладок не знает — событие собирается таким, каким его
   * отдаёт браузер на кириллице: знак «.», место Slash.
   */
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: ".", code: "Slash", bubbles: true, cancelable: true })),
  );
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");

  // окно поверх экрана: «/» экрана молчит, курсор в поиск не уезжает
  await page.getByRole("button", { name: "Вікно без Esc", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Коди відновлення" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("/");
  await expect(search).not.toBeFocused();
  await dialog.getByRole("button", { name: "Я зберіг коди" }).click();
  await expect(dialog).toBeHidden();
});

test("подсказка крестика ящика: не всплывает при открытии мышью, видна с клавиатуры, без обещания черновика", async ({ page }) => {
  await openKit(page);
  await page.getByRole("button", { name: /^(Довідка і клавіші|Справка и клавиши)$/ }).click();
  const drawer = page.getByRole("dialog", { name: /^(Довідка і клавіші|Справка и клавиши)$/ });
  await expect(drawer).toBeVisible();
  const close = drawer.getByRole("button", { name: /^(Закрити панель|Закрыть панель)$/ });
  // фокус на крестике поставил сам ящик — подсказки нет
  await expect(close).toBeFocused();
  await page.waitForTimeout(400);
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  // с клавиатуры — есть, и у ящика без черновика она не обещает черновик
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(/^(Закрити|Закрыть)/);
  await expect(tip).not.toContainText(/чернетка|черновик/);
});

test("таблица: выбор колонок закрывается Esc, и фокус возвращается кнопке", async ({ page }) => {
  await openKit(page);
  const table = page.getByRole("table", { name: "Пацієнти" });
  await table.scrollIntoViewIfNeeded();
  const toggle = page.getByRole("button", { name: /^Колонки/ }).first();
  await toggle.click();
  const picker = page.getByRole("group", { name: "Колонки" });
  await expect(picker).toBeVisible();
  await picker.getByRole("checkbox").first().focus();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(toggle).toBeFocused();
});

test("окно, которое надо закончить: Esc и подложка его не закрывают, кнопка — закрывает", async ({ page }) => {
  await openKit(page);
  await page.getByRole("button", { name: "Вікно без Esc", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Коди відновлення" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.mouse.click(20, 20);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Я зберіг коди" }).click();
  await expect(dialog).toBeHidden();
});
