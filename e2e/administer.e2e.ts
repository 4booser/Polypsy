import { expect, test } from "@playwright/test";
import { SEED_SURVEY, login } from "./helpers";

/**
 * Заполнение методики за пациента: прежние замеры человека грузятся по
 * выбору, на котором остановились, а не по каждому шагу выбора.
 *
 * Выбор пациента — родной <select>. В Windows и Linux стрелки на нём меняют
 * значение и шлют change на каждом шаге, и динамика (чтение клинических
 * данных со строкой журнала response.read) уходила по каждому, мимо кого
 * прошли стрелкой. Шаги здесь — подряд идущие selectOption: так их видит
 * экран, на какой бы системе ни шёл смоук.
 */
test("прежние замеры — по устоявшемуся выбору пациента, а не по каждому шагу", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/surveys");
  await page.locator('table tbody a[href^="/surveys/"]').filter({ hasText: SEED_SURVEY }).first().click();
  await page.waitForURL(/\/surveys\/[^/?]+/);
  const surveyId = new URL(page.url()).pathname.split("/surveys/")[1]!.split("/")[0]!;

  const dynamics: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith("/api/dynamics/")) dynamics.push(path);
  });

  await page.goto(`/surveys/${surveyId}/administer`);
  const pick = page.getByRole("combobox", { name: "Кого обследуем" });
  await expect(pick).toBeVisible();
  // ждём найденных: без поиска сервер отдаёт первую сотню по алфавиту
  await expect(pick.locator("option")).not.toHaveCount(1);
  const values = (await pick.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).filter(Boolean);
  expect(values.length, "в зоне психолога меньше двух пациентов — проверять нечего").toBeGreaterThanOrEqual(2);
  const steps = values.slice(0, 3);

  for (const v of steps) await pick.selectOption(v);
  await page.waitForTimeout(1500);

  const last = steps.at(-1)!;
  expect(dynamics, "динамика ушла по промежуточным шагам выбора").toEqual([expect.stringContaining(`/api/dynamics/respondents/${last}`)]);
});
