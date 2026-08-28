import { expect, test } from "@playwright/test";
import { login } from "./helpers";

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

  const patients = await (await page.request.get("/api/access/patients", { headers: auth })).json();
  const person = patients.items[0];
  test.skip(!person, "в зоне ответственности нет пациентов");

  const questions = full!.questions.filter(
    (q: { type: string; options: unknown[] }) => q.type !== "info" && q.options.length,
  );
  await page.request.post(`/api/surveys/${target!.id}/responses`, {
    headers: auth,
    data: {
      onBehalfOf: person!.id,
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
  const card = page.locator(".suggestion").first();
  await expect(card).toBeVisible();
  // объяснение с числами, а не слово «сработало»
  await expect(card.locator(".because li").first()).toContainText(scale);

  // отклонение без возражения невозможно
  await card.getByRole("button", { name: "Отклонить" }).click();
  await expect(card.getByRole("button", { name: "Отклонить" })).toBeDisabled();

  await card.getByPlaceholder("Почему отклоняете").fill("Уже обсуждали на прошлой неделе");
  await card.getByRole("button", { name: "Отклонить" }).click();
  await expect(page.getByText("Предложение отклонено")).toBeVisible();
});
