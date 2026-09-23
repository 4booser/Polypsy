import { expect, test } from "@playwright/test";
import { login, menuButton } from "./helpers";

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
  // оболочка специалиста не должна появиться ни на мгновение: её признак —
  // бургер, он есть у сотрудника на любой ширине экрана
  await expect(menuButton(page)).toHaveCount(0);
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
  const password = "secret12345";

  /*
   * Учётная запись заводится запросом, а не формой на экране входа: формы
   * регистрации там больше нет. Кадр f01 рисует вход двумя полями и ничем
   * больше, и вместе с кадром с экрана ушли и «Создать аккаунт», и поля
   * фамилии с телефоном. Путь настоящего человека остался один — приглашение
   * (/join/:token), но токен выдаёт сотрудник изнутри, и ради него проверка
   * тянула бы за собой второй вход и экран приглашений.
   *
   * Маршрут тот же самый, которым пользуется экран приглашения, так что
   * проверяется по-прежнему живой путь, а не выдуманный. Проверка от этого не
   * теряет смысла: доказывает она не форму регистрации (её проверяет
   * auth.e2e), а то, что человек с нуля проходит методику и не видит баллов.
   */
  const created = await page.request.post("/api/auth/register", {
    data: {
      email,
      password,
      phone: `+38050${Math.floor(1000000 + Math.random() * 8999999)}`,
      anonymous: false,
      firstName: "Пациент",
      lastName: "Тестовый",
    },
  });
  expect(created.ok(), `регистрация не прошла: ${created.status()}`).toBeTruthy();

  await page.goto("/login");
  await page.getByLabel(/^(Логин|Логін)$/).fill(email);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: /^(Войти|Увійти)$/ }).click();

  await page.waitForURL(/\/me/);
  await expect(menuButton(page)).toHaveCount(0);

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
