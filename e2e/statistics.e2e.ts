import { expect, test } from "@playwright/test";
import { SEED_SURVEY, apiToken, auth, goTop, login } from "./helpers";

/**
 * Раздел «Статистика» (кадры f08, f09, f18, f29, f24): смоук пути, которым
 * ходят.
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
 * Проверяется то, чего юнит-тесты не видят: пункт полосы ведёт в раздел,
 * «Фільтри» сворачиваются, «Порівняти» доходит до сервера и возвращает
 * строку итога, «+» ставит вторую выборку рядом, а диаграмма открывается из
 * перечня и считает выбранную модель.
 */
test("статистика: перечень → модель → свёрнутые фильтры → расчёт → вторая выборка → диаграмма", async ({ page }) => {
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

  /* f08: пункт полосы ведёт в перечень, модель находится поиском по своему названию */
  await goTop(page, /^Статистика$/);
  await expect(page).toHaveURL(/\/statistics$/);
  await expect(page.getByRole("heading", { name: /^(Перелік статистики|Перечень статистики)$/ })).toBeVisible();
  await page.getByRole("textbox", { name: /^(Пошук|Поиск) статисти/ }).fill(title);
  await page.getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`/statistics/${model.id}$`));

  /* f09 ↔ f18: «Фільтри» сворачиваются и разворачиваются */
  const filters = page.getByRole("button", { name: /^(Фільтри|Фильтры)$/ });
  await expect(filters).toHaveAttribute("aria-expanded", "true");
  await filters.click();
  await expect(filters).toHaveAttribute("aria-expanded", "false");
  await filters.click();
  await expect(filters).toHaveAttribute("aria-expanded", "true");

  /* «Порівняти» считает сохранённую модель и печатает строку итога */
  const run = page.waitForResponse((r) => r.url().includes(`/api/stat-models/${model.id}/run`));
  await page.getByRole("button", { name: /^(Порівняти|Сравнить)$/ }).click();
  expect((await run).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: /Респондент/ })).toBeVisible();

  /* f29: «+» ставит вторую выборку рядом, и правку можно сохранить */
  await page.getByRole("button", { name: /^(Додати вибірку|Добавить выборку)/ }).click();
  await expect(page.getByRole("region", { name: /^(Вибірка|Выборка) 2$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Зберегти|Сохранить)$/ })).toBeVisible();

  /* f24: иконка «діаграма» перечня, выбор модели считает её */
  await page.goto("/statistics");
  await page.getByRole("link", { name: /^(Діаграма|Диаграмма)$/ }).click();
  await expect(page).toHaveURL(/\/statistics\/chart/);
  const chartRun = page.waitForResponse((r) => r.url().includes(`/api/stat-models/${model.id}/run`));
  await page.getByRole("button", { name: new RegExp(title) }).click();
  expect((await chartRun).status()).toBe(200);
  await page.getByRole("button", { name: /^(Дії розділу статистики|Действия раздела статистики)$/ }).click();
  await expect(page.getByRole("menuitem", { name: /^(Керувати фільтрами|Управлять фильтрами)$/ })).toBeVisible();
});
