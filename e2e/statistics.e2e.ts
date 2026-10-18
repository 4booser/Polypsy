import { expect, test } from "@playwright/test";
import { SEED_SURVEY, apiToken, auth, goSection, login } from "./helpers";

/**
 * Раздел «Статистика» (Polypsy 2.0): смоук пути, которым ходят.
 *
 * Модель сценарий заводит себе сам через API, с уникальным названием: общий
 * посев с моделями психолога он не трогает, а перечень ищет по своему
 * названию, а не «первую строку» — перечень упорядочен свежестью, и первой
 * встала бы модель соседнего сценария.
 *
 * Суперадмин, а не психолог: право statistics.read выдаётся заведующему и
 * главному врачу, и какая ступень у психолога посева, сценарию знать не
 * нужно — суперадмину открыт весь справочник прав.
 *
 * Проверяется то, чего юнит-тесты не видят: пункт подразделов ведёт в
 * перечень, фильтры выборки открываются ящиком и закрываются Esc,
 * «Порівняти» доходит до сервера и печатает итог в шапке колонки, «Додати
 * вибірку» ставит вторую выборку рядом и открывает её фильтры, а график
 * открывается из подразделов и считает выбранную модель.
 */
test("статистика: перечень → модель → ящик фильтров → расчёт → вторая выборка → график", async ({ page }) => {
  const token = await apiToken(page, "superadmin");
  const headers = { ...auth(token), "Content-Type": "application/json" };

  const list = (await (await page.request.get("/api/surveys?status=published", { headers })).json()) as {
    items: { id: string; title: string }[];
  };
  const survey = list.items.find((s) => s.title.includes(SEED_SURVEY));
  expect(survey, `на стенде нет методики «${SEED_SURVEY}»`).toBeTruthy();
  const full = (await (await page.request.get(`/api/surveys/${survey!.id}`, { headers })).json()) as {
    scales: { id: string; bands: { id: string }[] }[];
    questions: { id: string; type: string; options: { id: string; kind: string }[] }[];
  };
  const scale = full.scales.find((s) => s.bands.length);
  const question = full.questions.find((q) => q.type === "single" && q.options.some((o) => o.kind === "option"));
  expect(scale ?? question, "у методики нет ни полос, ни вопроса с вариантами — строить нечего").toBeTruthy();

  const title = `Смоук статистики ${Date.now()}`;
  const created = await page.request.post("/api/stat-models", {
    headers,
    data: {
      title,
      description: "Своя модель смоука",
      columns: [
        {
          title: null,
          presetId: null,
          filters: {},
          surveyId: survey!.id,
          bands: scale ? scale.bands.slice(0, 2).map((b) => ({ scaleId: scale.id, bandId: b.id })) : [],
          questions: question
            ? [
                {
                  questionId: question.id,
                  options: question.options.filter((o) => o.kind === "option").slice(0, 2).map((o) => ({ optionId: o.id })),
                },
              ]
            : [],
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const model = (await created.json()) as { id: string };

  await login(page, "superadmin");

  /* «Статистические модели» в колонке аналитики ведут в перечень, модель находится поиском по своему названию */
  await goSection(page, /^Аналитика/, "Статистические модели");
  await expect(page).toHaveURL(/\/statistics$/);
  await expect(page.getByRole("heading", { level: 1, name: /^(Статистичні моделі|Статистические модели)$/ })).toBeVisible();
  await page.getByRole("searchbox", { name: /^(Пошук|Поиск) статисти/ }).fill(title);
  await page.getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`/statistics/${model.id}$`));

  /* фильтры выборки — в ящике справа: открываются кнопкой в шапке колонки, Esc закрывает */
  await page.getByRole("button", { name: /^(Фільтри вибірки|Фильтры выборки) 1$/ }).click();
  const pane = page.getByRole("dialog", { name: /^(Фільтри вибірки|Фильтры выборки) 1$/ });
  await expect(pane).toBeVisible();
  await expect(pane.getByRole("group", { name: /^(Стать|Пол)$/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pane).toBeHidden();

  /* «Порівняти» считает сохранённую модель: время расчёта в полосе состояния, основание — в шапке колонки */
  const run = page.waitForResponse((r) => r.url().includes(`/api/stat-models/${model.id}/run`));
  await page.getByRole("button", { name: /^(Порівняти|Сравнить)$/ }).click();
  expect((await run).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: /Порівняно|Сравнено/ })).toBeVisible();
  await expect(page.getByRole("columnheader").filter({ hasText: /Респондент/ }).first()).toBeVisible();

  /* «Додати вибірку» ставит вторую выборку рядом и открывает её фильтры; правку можно сохранить */
  await page.getByRole("button", { name: /^(Додати вибірку|Добавить выборку)/ }).click();
  await expect(page.getByRole("dialog", { name: /^(Фільтри вибірки|Фильтры выборки) 2$/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("columnheader", { name: /(Вибірка|Выборка) 2/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Зберегти|Сохранить)$/ })).toBeVisible();

  /* график — из подразделов; выбор модели считает её */
  await goSection(page, /^Аналитика/, /^(Графік|График)$/);
  await expect(page).toHaveURL(/\/statistics\/chart/);
  const chartRun = page.waitForResponse((r) => r.url().includes(`/api/stat-models/${model.id}/run`));
  await page.getByRole("button", { name: new RegExp(title) }).click();
  expect((await chartRun).status()).toBe(200);
  await expect(page.getByRole("region", { name: /^(Частки за показниками|Доли по показателям)$/ })).toBeVisible();

  /* пресет — к выбранным выборкам окном; правка выборок делает «Зберегти» доступным */
  const save = page.getByRole("button", { name: /^(Зберегти|Сохранить)$/ });
  await expect(save).toBeDisabled();
  await page.getByRole("region", { name: /^(Пресети фільтрів|Пресеты фильтров)$/ }).getByRole("button").first().click();
  const apply = page.getByRole("dialog", { name: /^(До яких вибірок застосувати пресет|К каким выборкам применить пресет)$/ });
  await expect(apply).toBeVisible();
  await apply.getByRole("button", { name: /^(Обрати всі|Выбрать все)$/ }).click();
  await apply.getByRole("button", { name: /^(Застосувати до вибірок|Применить к выборкам): 1$/ }).click();
  await expect(apply).toBeHidden();
  await expect(save).toBeEnabled();

  await page.getByRole("button", { name: /^(Дії розділу статистики|Действия раздела статистики)$/ }).click();
  await expect(page.getByRole("menuitem", { name: /^(Керувати фільтрами|Управлять фильтрами)$/ })).toBeVisible();
});
