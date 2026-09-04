import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Маршруты помощи.
 *
 * Экран отвечает на вопрос «где стоим», а не «что назначено»: смысл в том,
 * чтобы застрявший стал виден. Проверяется путь целиком — завести шаблон,
 * поставить человека, отметить шаг, закрыть с исходом.
 */
test("маршрут ведётся от шага до исхода", async ({ page }) => {
  await login(page, "psy");

  /*
   * Токен берётся из хранилища вкладки: page.request не несёт заголовок
   * Authorization сам — приложение держит токен в localStorage, а не в cookie.
   */
  const token = await page.evaluate(() => localStorage.getItem("quizzy.web.token"));
  const auth = { Authorization: `Bearer ${token}` };

  // шаблон заводится через API: экран его редактирования — отдельная работа
  const survey = await page.request.get("/api/surveys", { headers: auth });
  const list = (await survey.json()) as { items: { id: string; title: string }[] };
  const target = list.items[0]!;

  // заголовок уникален: у пациента могут быть маршруты от прошлых прогонов,
  // и «строка этого человека» указала бы на чужой
  const title = `Смоук ${Date.now()}`;
  const created = await page.request.post("/api/pathways", {
    headers: auth,
    data: {
      title: { uk: title, ru: title },
      steps: [
        { title: { uk: "Скринінг", ru: "Скрининг" }, kind: "survey", surveyId: target.id, dueDays: 0 },
        { title: { uk: "Бесіда", ru: "Беседа" }, kind: "action", dueDays: 7 },
      ],
    },
  });
  expect(created.ok()).toBe(true);
  const { id: pathwayId } = (await created.json()) as { id: string };

  // ставим на маршрут первого доступного пациента
  const patients = await page.request.get("/api/access/patients", { headers: auth });
  const people = (await patients.json()) as { items: { id: string; fullName: string }[] };
  const person = people.items[0];
  if (!person) test.skip(true, "в зоне ответственности нет пациентов");

  const started = await page.request.post(`/api/pathways/${pathwayId}/start`, {
    headers: auth,
    data: { userId: person!.id },
  });
  expect(started.ok()).toBe(true);

  await page.goto("/pathways");
  await expect(page.locator("h1")).toHaveText("Маршруты помощи");

  const row = page.locator(".pw-row").filter({ hasText: title }).first();
  await expect(row).toBeVisible();
  /*
   * Только что начатый маршрут не помечен просрочкой: срок «в тот же день»
   * истекает вечером того дня, а не в момент старта. Иначе каждый маршрут
   * рождался бы красным и метка перестала бы что-либо значить.
   */
  await expect(row).not.toHaveClass(/overdue/);
  await row.click();

  // шаги видны, первый закрывается отметкой
  const steps = page.locator(".pw-step-row");
  await expect(steps).toHaveCount(2);
  await steps.first().getByRole("button", { name: "Выполнено" }).click();
  await expect(steps.first()).toHaveClass(/s-done/);

  // закрытие требует исхода и делает маршрут историей
  await page.getByRole("button", { name: "Снят с наблюдения" }).click();
  await expect(page.getByText("закрыт").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Выполнено" })).toHaveCount(0);
});

test("шаблон маршрута собирается в редакторе", async ({ page }) => {
  /*
   * Раньше шаблон можно было завести только через API: функция была, а
   * пользоваться ею мог только тот, кто пишет запросы руками.
   */
  await login(page, "psy");
  await page.goto("/pathways");
  await page.getByRole("link", { name: "Новый маршрут" }).click();

  const name = `Смоук-маршрут ${Date.now()}`;
  const title = page.locator("[data-field], .field").filter({ hasText: "Название" }).first();
  await title.getByPlaceholder("по-русски").fill(name);

  const step = page.locator(".pwe-step").first();
  await step.getByPlaceholder("по-русски").first().fill("Скрининг");
  await step.locator("select").first().selectOption("survey");
  await step.getByLabel("Срок, дней от старта").fill("0");

  await page.getByRole("button", { name: "Добавить шаг" }).click();
  const second = page.locator(".pwe-step").nth(1);
  await second.getByPlaceholder("по-русски").first().fill("Беседа");
  await second.getByLabel("Срок, дней от старта").fill("7");

  await page.getByRole("button", { name: "Сохранить маршрут" }).click();
  await expect(page).toHaveURL(/\/pathways\?created=/);
});

test("человек ставится на маршрут из своей карты", async ({ page }) => {
  /*
   * Решение принимают в карте: там видно, что уже идёт. Раньше поставить на
   * маршрут можно было только запросом к API.
   */
  await login(page, "psy");
  await page.goto("/patients");
  await page.locator("table tbody tr td a").first().click();

  const card = page.locator("[data-panel], .card").filter({ hasText: "Маршруты помощи" }).first();
  await expect(card).toBeVisible();

  const select = card.getByLabel("Поставить на маршрут");
  const options = await select.locator("option:not([disabled])").count();
  if (options <= 1) test.skip(true, "все маршруты уже открыты у этого человека");

  await select.selectOption({ index: 1 });
  await card.getByRole("button", { name: "Поставить на маршрут" }).click();

  // маршрут появился в карте и ведёт на свой экран
  await expect(card.locator("a.duty-row").first()).toBeVisible();
});
