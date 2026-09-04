import { expect, test } from "@playwright/test";
import { ACCOUNTS, login } from "./helpers";

test.describe("вход в консоль", () => {
  test("неверный пароль не пускает и не роняет страницу", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Email").fill(ACCOUNTS.psy.email);
    await page.getByLabel("Пароль").fill("не-тот-пароль");
    await page.getByRole("button", { name: "Войти" }).click();

    // по роли, а не по классу: отказ должен быть объявлен диктору, и
    // проверять надо именно это, а не то, каким классом он покрашен
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator(".sidebar")).toHaveCount(0);
  });

  test("сотрудник входит и видит навигацию", async ({ page }) => {
    await login(page, "psy");
    await expect(page.locator(".sidebar")).toBeVisible();

    /*
     * Проверяется наличие навигации, а не конкретной ссылки в ней.
     *
     * Разделы рельсы раскрываются по нажатию, и закрытая группа не прячет
     * свои пункты, а не рисует их вовсе. Требовать здесь видимую ссылку
     * «Пациенты» значило бы требовать, чтобы раздел «Люди» был раскрыт при
     * входе, — а это уже решение об умолчании, и проверять его надо там,
     * где оно принимается, а не в проверке входа.
     */
    const rail = page.locator(".sidebar");
    await expect(rail.locator("button[aria-expanded]").first()).toBeVisible();
    // раздел, в котором человек находится, раскрыт: с него начинается смена
    await expect(rail.getByRole("link", { name: "Сводка" })).toBeVisible();
  });

  test("сессия переживает перезагрузку страницы", async ({ page }) => {
    await login(page, "psy");
    await page.reload();
    await expect(page.locator(".sidebar")).toBeVisible();
  });

  test("администрирование видно только суперадмину", async ({ page }) => {
    /*
     * Проверяется и раздел, и его содержимое. Раздел — потому что теперь
     * именно он несёт границу: у психолога группы «Администрирование» нет
     * вовсе. Содержимое — потому что пустой заголовок группы прошёл бы
     * такую проверку, ничего не открывая.
     */
    await login(page, "psy");
    await expect(page.getByRole("button", { name: /Администрирование/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Журнал доступа" })).toHaveCount(0);

    await page.getByRole("button", { name: /Выйти/i }).click();
    await login(page, "superadmin");
    const admin = page.getByRole("button", { name: /Администрирование/ });
    await expect(admin).toBeVisible();
    if ((await admin.getAttribute("aria-expanded")) === "false") await admin.click();
    await expect(page.getByRole("link", { name: "Журнал доступа" })).toBeVisible();
  });
});
