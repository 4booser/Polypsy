import { expect, test } from "@playwright/test";
import { ACCOUNTS, emailField, eventsBell, goRail, login, logout, passwordField, railNav, subNav } from "./helpers";

test.describe("вход в консоль", () => {
  test("неверный пароль не пускает и не роняет страницу", async ({ page }) => {
    await page.goto("/login");
    await emailField(page).fill(ACCOUNTS.psy.email);
    await passwordField(page).fill("не-тот-пароль");
    await page.getByRole("button", { name: /^(Войти|Увійти)$/ }).click();

    // по роли, а не по классу: отказ должен быть объявлен диктору, и
    // проверять надо именно это, а не то, каким классом он покрашен
    await expect(page.getByRole("alert")).toBeVisible();
    // оболочка не поднялась: колокольчик полосы приложения — её признак на любой ширине экрана
    await expect(eventsBell(page)).toHaveCount(0);
  });

  test("сотрудник входит и видит навигацию", async ({ page }) => {
    await login(page, "psy");
    const nav = railNav(page);
    await expect(nav).toBeVisible();

    /*
     * Проверяются все разделы рельсы, а не «хоть какая-то ссылка».
     *
     * Рельса — постоянная часть экрана (набор «Виразної», RAIL): её состав
     * задан набором и правами, а пропавший раздел — это не «человек убрал с
     * глаз», а дыра посреди навигации. Имя пункта — полное (подсказка и имя
     * для диктора), с числом через запятую, если оно есть: сравнивается
     * началом.
     */
    for (const name of [
      /^Сегодня$/,
      /^Очередь работы/,
      /^Случаи риска/,
      /^Пациенты$/,
      /^Расписание приёма$/,
      /^Переписка/,
      /^Методики$/,
      /^Аналитика и статистика$/,
    ]) {
      await expect(nav.getByRole("link", { name })).toBeVisible();
    }
    /*
     * Раздел, в котором человек находится, отмечен aria-current: цвет
     * диктору ничего не сообщает. Проверяется на «Пациентах», а не на
     * сводке после входа: на сводке текущий — «Сегодня», и «Аналитика»
     * текущей быть не должна — иначе рельса, отмечающая её на любом
     * адресе, прошла бы как исправная.
     */
    await expect(nav.getByRole("link", { name: /^Аналитика/ })).not.toHaveAttribute("aria-current", "page");
    await nav.getByRole("link", { name: "Пациенты", exact: true }).click();
    await page.waitForURL(/\/patients$/);
    await expect(nav.getByRole("link", { name: "Пациенты", exact: true })).toHaveAttribute("aria-current", "page");
    /* и у раздела — своя колонка подразделов, с текущим пунктом */
    await expect(subNav(page).getByRole("link", { name: "Все пациенты" })).toHaveAttribute("aria-current", "page");
  });

  test("сессия переживает перезагрузку страницы", async ({ page }) => {
    await login(page, "psy");
    await page.reload();
    await expect(railNav(page)).toBeVisible();
  });

  test("администрирование видно только суперадмину", async ({ page }) => {
    /*
     * Граница — сам раздел рельсы: у психолога «Администрирования» нет
     * вовсе, а у суперадмина в нём есть техпанель. Содержимое проверяется
     * потому, что пустой раздел прошёл бы проверку, ничего не открывая.
     */
    await login(page, "psy");
    await expect(railNav(page).getByRole("link", { name: /^Администрирование/ })).toHaveCount(0);
    /* журнал доступа живёт вкладкой техпанели (волна 10): граница — её пункт */
    await expect(page.getByRole("link", { name: "Техпанель" })).toHaveCount(0);

    await logout(page);
    await login(page, "superadmin");
    await goRail(page, /^Администрирование/);
    await expect(subNav(page).getByRole("link", { name: "Техпанель" })).toBeVisible();
  });
});
