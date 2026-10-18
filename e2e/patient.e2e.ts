import { expect, test } from "@playwright/test";
import { eventsBell, login } from "./helpers";

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
  // колокольчик полосы приложения, он есть у сотрудника на любой ширине экрана
  await expect(eventsBell(page)).toHaveCount(0);
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
  /*
   * Новый человек сначала видит согласие (волна 12, patient/ConsentGate.tsx):
   * без принятой редакции сервер ответов не примет. Проходим его кнопкой —
   * так, как пройдёт человек.
   */
  await page.getByRole("button", { name: /^(Погоджуюся|Соглашаюсь|I agree)$/ }).click();
  await expect(eventsBell(page)).toHaveCount(0);

  await page.getByRole("link", { name: "Тесты" }).click();
  // короткая методика: МЛО на двести пунктов уронило бы проверку по сроку
  const link = page
    .locator('a[href^="/me/tests/"]')
    .filter({ hasNotText: "Адаптивность" })
    .filter({ hasNotText: "Мини-мульт" })
    .first();
  const surveyId = (await link.getAttribute("href"))!.split("/").pop()!;
  await link.click();
  /*
   * Вариант ответа: один ответ — радио (плитки «Виразної», стрелки и цифры),
   * несколько ответов и деления шкалы — переключатели с aria-pressed.
   */
  const anyOption = () => page.getByRole("radio").or(page.locator("button[aria-pressed]")).first();
  /* у методики с инструкцией перед первым пунктом — её экран и «Почати» (#170), как в a11y.e2e.ts */
  const start = page.getByRole("button", { name: /^(Почати|Начать|Start)$/ });
  await Promise.race([start.waitFor(), anyOption().waitFor()]);
  if (await start.isVisible()) await start.click();

  for (let i = 0; i < 60; i++) {
    const option = anyOption();
    await option.click();
    await expect(page.locator('[aria-checked="true"], [aria-pressed="true"]').first()).toBeVisible();

    const finish = page.getByRole("button", { name: "Завершить" });
    if (await finish.count()) {
      await finish.click();
      break;
    }
    await page.getByRole("button", { name: "Дальше" }).click();
  }

  await expect(page.getByRole("heading", { name: "Спасибо" })).toBeVisible({ timeout: 15000 });
  /*
   * Баллы — только там, где методика их показывает (showResultsToPatient):
   * у PHQ-9, PCL-5 и прочих с выключенным показом истолковать цифру некому,
   * а тревожный человек с цифрой и без объяснения — худший исход, чем
   * человек без цифры. Панель «Ваш результат» есть ровно тогда, когда флаг
   * методики разрешает её показать.
   */
  const token = await page.evaluate(() => localStorage.getItem("quizzy.web.token"));
  const listed = (await (await page.request.get("/api/surveys", { headers: { Authorization: `Bearer ${token}` } })).json()) as {
    items: { id: string; showResultsToPatient: boolean }[];
  };
  const shows = listed.items.find((s) => s.id === surveyId)?.showResultsToPatient ?? false;
  const result = page.getByRole("heading", { level: 2, name: /^(Ваш результат|Your result)$/ });
  await expect(result).toHaveCount(shows ? 1 : 0);
});
