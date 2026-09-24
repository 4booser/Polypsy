import { expect, test } from "@playwright/test";
import { ACCOUNTS, login, logout, menuButton, openMenu, topNav } from "./helpers";

test.describe("вход в консоль", () => {
  test("неверный пароль не пускает и не роняет страницу", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/^(Логин|Логін)$/).fill(ACCOUNTS.psy.email);
    await page.getByLabel("Пароль").fill("не-тот-пароль");
    await page.getByRole("button", { name: /^(Войти|Увійти)$/ }).click();

    // по роли, а не по классу: отказ должен быть объявлен диктору, и
    // проверять надо именно это, а не то, каким классом он покрашен
    await expect(page.getByRole("alert")).toBeVisible();
    // оболочка не поднялась: бургер — её признак на любой ширине экрана
    await expect(menuButton(page)).toHaveCount(0);
  });

  test("сотрудник входит и видит навигацию", async ({ page }) => {
    await login(page, "psy");
    const nav = topNav(page);
    await expect(nav).toBeVisible();

    /*
     * Проверяются все шесть пунктов полосы, а не «хоть какая-то ссылка».
     *
     * Полоса — согласованная с заказчиком постоянная часть экрана: её состав
     * задан макетом, а не настройкой рабочего места, и пропавший пункт — это
     * не «человек убрал с глаз», а дыра посреди шапки. У рельсы конкретную
     * ссылку требовать было нельзя — пункты закрытой группы не существовали
     * в разметке; у полосы групп нет, и все шесть на месте всегда.
     */
    for (const name of ["Пациенты", "Группы", "Тесты", "Аналитика", "Статистика", "Сообщения"]) {
      await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    }
    /*
     * Раздел, в котором человек находится, отмечен: с него начинается смена.
     * Цвет диктору ничего не сообщает — ему текущий пункт называет
     * aria-current, и проверяется именно он. Проверяется на «Пациентах», а не
     * на сводке после входа: у сводки своего пункта в полосе нет («Аналитика»
     * с волны 4 ведёт в перечень моделей, /analytics), и на ней ни один пункт
     * текущим быть не должен — это тоже проверяется, иначе полоса, отмечающая
     * «Аналитику» на любом адресе, прошла бы как исправная.
     */
    await expect(nav.getByRole("link", { name: "Аналитика" })).not.toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Пациенты", exact: true }).click();
    await page.waitForURL(/\/patients$/);
    await expect(nav.getByRole("link", { name: "Пациенты", exact: true })).toHaveAttribute("aria-current", "page");
  });

  test("сессия переживает перезагрузку страницы", async ({ page }) => {
    await login(page, "psy");
    await page.reload();
    await expect(topNav(page)).toBeVisible();
  });

  test("администрирование видно только суперадмину", async ({ page }) => {
    /*
     * Проверяется и группа, и её содержимое — внутри бургера: именно там
     * теперь лежат разделы, не вошедшие в шесть пунктов полосы. Группа —
     * потому что она несёт границу: у психолога «Администрирования» нет
     * вовсе. Содержимое — потому что пустой заголовок группы прошёл бы такую
     * проверку, ничего не открывая.
     *
     * Заголовок группы в бургере — надпись, а не кнопка: список плоский,
     * раскрывать в нём нечего. Ищется по тексту без учёта регистра: стилем
     * он набран прописными, и полагаться на то, как именно движок читает
     * текст с text-transform, здесь ни к чему.
     */
    await login(page, "psy");
    const asPsy = await openMenu(page);
    await expect(asPsy.getByText(/^Администрирование$/i)).toHaveCount(0);
    await expect(asPsy.getByRole("link", { name: "Журнал доступа" })).toHaveCount(0);

    await logout(page);
    await login(page, "superadmin");
    const asRoot = await openMenu(page);
    await expect(asRoot.getByText(/^Администрирование$/i)).toBeVisible();
    await expect(asRoot.getByRole("link", { name: "Журнал доступа" })).toBeVisible();
  });
});
