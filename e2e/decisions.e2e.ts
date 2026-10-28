import { expect, test } from "@playwright/test";
import { createOwnPatient, login } from "./helpers";

/**
 * Поддержка решений.
 *
 * Проверяется главное свойство контура: система предлагает, человек решает.
 * Правило не выполняет действий — оно кладёт на экран объяснение и две
 * равноправные кнопки, а отклонение требует возражения.
 */
test("правило предлагает, человек решает", async ({ page }) => {
  await login(page, "superadmin");
  const token = await page.evaluate(() => localStorage.getItem("quizzy.web.token"));
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  /*
   * Берём первую методику со шкалами, а не просто первую: другие смоуки
   * создают черновики без шкал, и «первая» зависела бы от порядка тестов.
   */
  const surveys = await (await page.request.get("/api/surveys", { headers: auth })).json();
  let target: { id: string } | null = null;
  let full: { scales: { code: string }[]; questions: unknown[] } | null = null;
  for (const s of surveys.items as { id: string; status: string }[]) {
    if (s.status !== "published") continue;
    const detail = await (await page.request.get(`/api/surveys/${s.id}`, { headers: auth })).json();
    if (detail.scales?.length) {
      target = s;
      full = detail;
      break;
    }
  }
  expect(target).not.toBeNull();
  const scale = full!.scales[0]!.code;

  // порог заведомо низкий: проверяется контур решения, а не подбор порога
  const rule = await page.request.post("/api/decisions/rules", {
    headers: auth,
    data: {
      title: `Смоук ${Date.now()}`,
      conditions: [
        { kind: "scale", surveyId: target!.id, scaleCode: scale, metric: "raw", op: ">=", value: -1 },
      ],
      actions: [{ kind: "advise", text: "Обсудить на консилиуме" }],
    },
  });
  expect(rule.ok()).toBe(true);

  /*
   * Прохождение записывается СВОЕМУ человеку, а не первому в зоне видимости.
   *
   * Первый в списке — общий посевной пациент, и замер за него поднимает его
   * наверх во всех списках, упорядоченных по свежести: дальше по прогону это
   * ломало проверки, которые берут «первого в списке». Своему человеку
   * записать некому и нечего испортить.
   */
  const person = await createOwnPatient(page, "decisions");

  const questions = full!.questions.filter(
    (q: { type: string; options: unknown[] }) => q.type !== "info" && q.options.length,
  );
  await page.request.post(`/api/surveys/${target!.id}/responses`, {
    headers: auth,
    data: {
      onBehalfOf: person.id,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers: questions.map((q: { id: string; options: { id: string }[] }) => ({
        questionId: q.id,
        optionIds: [q.options[0]!.id],
        durationMs: 1500,
        changeCount: 0,
        visitCount: 1,
      })),
    },
  });

  await page.goto("/");
  // строка предложения — по признаку data-, а не по классу оформления (UI 3)
  const card = page.locator("[data-suggestion]").first();
  await expect(card).toBeVisible();
  // объяснение с числами, а не слово «сработало»
  await expect(card.locator("[data-because] li").first()).toContainText(scale);

  // отклонение без возражения невозможно
  await card.getByRole("button", { name: "Отклонить" }).click();
  await expect(card.getByRole("button", { name: "Отклонить" })).toBeDisabled();

  await card.getByPlaceholder("Почему отклоняете").fill("Уже обсуждали на прошлой неделе");
  await card.getByRole("button", { name: "Отклонить" }).click();
  await expect(page.getByText("Предложение отклонено")).toBeVisible();
});

/**
 * Ступенчатый скрининг: правило предлагает методику, и протокол прохождения
 * назначает её одним нажатием — «Рекомендовано: СР-45», «Назначить СР-45».
 *
 * Правило заводится здесь же (каталог на стенде смоука не ставится): то же
 * действие suggest_survey, которым установщик каталога заводит шаг «PHQ-2 ≥ 3 →
 * PHQ-9». Проверяется путь специалиста: предложение стоит на протоколе,
 * нажатие выдаёт методику человеку и записывает согласие — и то и другое видит
 * сервер, а не только всплывающее сообщение.
 */
test("предложенная методика назначается с протокола одним нажатием", async ({ page }) => {
  await login(page, "superadmin");
  const token = await page.evaluate(() => localStorage.getItem("quizzy.web.token"));
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const surveys = (await (await page.request.get("/api/surveys?status=published", { headers: auth })).json()) as {
    items: { id: string; title: string; administration: string }[];
  };
  // что предложить: СР-45 посева — самоотчёт, его назначают человеку
  const next = surveys.items.find((s) => s.title.startsWith("СР-45"));
  expect(next, "на стенде нет СР-45 — предложить нечего").toBeTruthy();
  // по чему сработать: другая самоотчётная методика со шкалами
  let source: { id: string } | null = null;
  let full: { scales: { code: string }[]; questions: { id: string; type: string; options: { id: string }[] }[] } | null = null;
  for (const s of surveys.items) {
    if (s.id === next!.id || s.administration !== "self") continue;
    const detail = await (await page.request.get(`/api/surveys/${s.id}`, { headers: auth })).json();
    if (detail.scales?.length) {
      source = s;
      full = detail;
      break;
    }
  }
  expect(source).not.toBeNull();

  const rule = await page.request.post("/api/decisions/rules", {
    headers: auth,
    data: {
      title: `Смоук шага ${Date.now()}`,
      conditions: [{ kind: "scale", surveyId: source!.id, scaleCode: full!.scales[0]!.code, metric: "raw", op: ">=", value: -1 }],
      actions: [{ kind: "suggest_survey", surveyId: next!.id }],
    },
  });
  expect(rule.ok()).toBe(true);
  const ruleId = ((await rule.json()) as { id: string }).id;

  try {
    const person = await createOwnPatient(page, "stepped");
    const sent = await page.request.post(`/api/surveys/${source!.id}/responses`, {
      headers: auth,
      data: {
        onBehalfOf: person.id,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        events: [],
        answers: full!.questions
          .filter((q) => q.type !== "info" && q.options.length)
          .map((q) => ({ questionId: q.id, optionIds: [q.options[0]!.id], durationMs: 1500, changeCount: 0, visitCount: 1 })),
      },
    });
    expect(sent.ok(), await sent.text()).toBe(true);
    const responseId = ((await sent.json()) as { id: string }).id;

    await page.goto(`/surveys/${source!.id}/responses/${responseId}`);
    await expect(page.getByText("Рекомендовано: СР-45")).toBeVisible();
    await page.getByRole("button", { name: "Назначить СР-45" }).click();
    await expect(page.getByText("СР-45 назначено")).toBeVisible();

    // выдача и согласие — на сервере, а не только во всплывающем сообщении
    const grants = (await (await page.request.get(`/api/access/surveys/${next!.id}/grants`, { headers: auth })).json()) as {
      items: { userId: string }[];
    };
    expect(grants.items.some((g) => g.userId === person.id)).toBe(true);
    const accepted = (await (
      await page.request.get(`/api/decisions/hits?status=accepted&userId=${person.id}`, { headers: auth })
    ).json()) as { items: { responseId: string }[] };
    expect(accepted.items.map((h) => h.responseId)).toContain(responseId);
    // назначенное второй раз не предлагается: кнопки больше нет
    await expect(page.getByRole("button", { name: "Назначить СР-45" })).toHaveCount(0);
  } finally {
    // правило действует на все прохождения методики — выключается, чтобы не предлагать в других сценариях
    await page.request.patch(`/api/decisions/rules/${ruleId}`, { headers: auth, data: { enabled: false } });
  }
});
