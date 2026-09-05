import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Кабинет пациента: вход, прохождение и запись.
 *
 * Проверяется путь целиком, потому что ломается он на стыках: пациент
 * входил и упирался в отказ, потом видел консоль специалиста, потом
 * получал отказ доступа на каждом её пункте.
 */
test("пациент входит в свой кабинет, а не в консоль", async ({ page }) => {
  await login(page, "patient");
  await page.waitForURL(/\/me/);
  // рельса специалиста не должна появиться ни на мгновение
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Тесты" })).toBeVisible();
});

test("человек заводит учётную запись и проходит методику", async ({ page }) => {
  /*
   * Регистрация и прохождение одним сценарием, потому что порознь они
   * ничего не доказывают: у посеянного пациента всё уже пройдено, а
   * методика без человека не сдаётся. Заодно это и есть путь, которым
   * приходит настоящий человек с телефона.
   */
  test.setTimeout(120_000);
  const email = `new-${crypto.randomUUID().slice(0, 8)}@example.org`;

  await page.goto("/");
  await page.getByRole("button", { name: "Создать аккаунт" }).click();
  await page.getByLabel("Фамилия").fill("Тестовый");
  await page.getByLabel("Имя").fill("Пациент");
  await page.getByLabel("Телефон").fill(`+38050${Math.floor(1000000 + Math.random() * 8999999)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Пароль").fill("secret12345");
  await page.getByRole("button", { name: "Создать аккаунт" }).click();

  await page.waitForURL(/\/me/);
  await expect(page.locator(".sidebar")).toHaveCount(0);

  await page.getByRole("link", { name: "Тесты" }).click();
  // короткая методика: МЛО на двести пунктов уронило бы проверку по сроку
  await page
    .locator('a[href^="/me/tests/"]')
    .filter({ hasNotText: "Адаптивность" })
    .filter({ hasNotText: "Мини-мульт" })
    .first()
    .click();

  for (let i = 0; i < 60; i++) {
    const option = page.locator("button[aria-pressed]").first();
    await option.click();
    await expect(option).toHaveAttribute("aria-pressed", "true");

    const finish = page.getByRole("button", { name: "Завершить" });
    if (await finish.count()) {
      await finish.click();
      break;
    }
    await page.getByRole("button", { name: "Дальше" }).click();
  }

  await expect(page.getByRole("heading", { name: "Спасибо" })).toBeVisible({ timeout: 15000 });
  /*
   * Баллов человеку не показываем: истолковать их некому, а тревожный
   * человек с цифрой и без объяснения — худший исход, чем человек без
   * цифры. Ищем не слово «балл» (оно есть в самом объяснении, почему их
   * тут нет), а числовую разметку, которой во всём приложении набраны
   * результаты.
   */
  await expect(page.locator("main .num, main [data-severity]")).toHaveCount(0);
});
