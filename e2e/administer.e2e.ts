import { expect, test } from "@playwright/test";
import { SEED_SURVEY, login } from "./helpers";

/**
 * Заполнение методики за пациента: человек выбирается одним полем с поиском,
 * и прежние замеры грузятся по выбранному, а не по каждому шагу стрелкой.
 *
 * Прежде выбор был родным <select> рядом с полем поиска: в Windows и Linux
 * стрелки на нём меняют значение на каждом шаге, и динамика (чтение
 * клинических данных со строкой журнала response.read) уходила по каждому,
 * мимо кого прошли стрелкой. Теперь это комбобокс: стрелки ходят по
 * найденным, выбор — Enter, а фокус после выбора уходит в быстрый ввод —
 * следующий шаг.
 */
test("пациент выбирается полем с поиском; замеры — по выбранному, а не по каждому шагу стрелкой", async ({ page }) => {
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
  // без выбранного пациента первым набирают его: фокус — в поле поиска, а не в быстром вводе
  await expect(pick).toBeFocused();

  await pick.press("ArrowDown");
  const options = page.getByRole("listbox", { name: "Кого обследуем" }).getByRole("option");
  // ждём найденных: без набранного сервер отдаёт первую сотню по алфавиту
  await expect(options.first()).toBeVisible();
  expect(await options.count(), "в зоне психолога меньше трёх пациентов — проверять нечего").toBeGreaterThanOrEqual(3);

  await pick.press("ArrowDown");
  await pick.press("ArrowDown");
  await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(1500);
  expect(dynamics, "шаг стрелкой — ещё не выбор, а замеры уже читались").toEqual([]);

  const chosen = (await options.nth(2).getAttribute("data-patient"))!;
  await pick.press("Enter");
  const change = page.getByRole("button", { name: "Изменить пациента" });
  await expect(change).toBeVisible();
  // следующий шаг — ответы: фокус в быстром вводе
  await expect(page.getByLabel("Быстрый ввод")).toBeFocused();
  await page.waitForTimeout(1500);
  expect(dynamics).toEqual([expect.stringContaining(`/api/dynamics/respondents/${chosen}`)]);

  // «Изменить» снимает выбор целиком: сохранить, пока новый человек не выбран, нельзя
  await change.click();
  await expect(pick).toBeFocused();
  await expect(page.getByRole("button", { name: "Сохранить обследование" })).toBeDisabled();
});
