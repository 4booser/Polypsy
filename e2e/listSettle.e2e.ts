import { expect, test, type Page } from "@playwright/test";
import { apiToken, auth, login } from "./helpers";

/**
 * Список и запись (наборы, группы методик): запись грузит данные со строкой
 * журнала — назначения набора (battery.assignment_list), аналитику группы
 * (analytics.group). Шаг J/K — ещё не выбор: грузится строка, на которой
 * остановились (600 мс), а не каждая, мимо которой прошли. Щелчок по строке
 * — выбор: запись грузится сразу.
 *
 * Строки — свои (три набора, три группы с меткой прогона) и в конце
 * убираются: соседние сценарии считают наборы и группы посева.
 */

/** Пути запросов, совпавших с образцом, — с этого момента */
function watch(page: Page, re: RegExp): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (re.test(path)) seen.push(path);
  });
  return seen;
}

/** Три шага J подряд — быстрее, чем выбор успевает устояться */
async function stepThrice(page: Page): Promise<void> {
  // клавиши экрана не срабатывают в поле ввода — фокус снимается, а не ставится щелчком
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("j");
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(1500);
}

const selectedId = (page: Page) => new URL(page.url()).searchParams.get("id");

test("наборы: J/K грузят назначения строки, на которой остановились; щелчок — сразу", async ({ page }) => {
  const token = await apiToken(page, "superadmin");
  const surveys = (await (await page.request.get("/api/surveys", { headers: auth(token) })).json()) as {
    items: { id: string; status: string; archivedAt: string | null; groupId: string | null }[];
  };
  const survey = surveys.items.find((s) => s.status === "published" && !s.archivedAt)!;
  const tag = crypto.randomUUID().slice(0, 6);
  const ids: string[] = [];
  for (const n of [1, 2, 3]) {
    const res = await page.request.post("/api/batteries", {
      headers: auth(token),
      data: { title: `Крок ${tag} ${n}`, groupId: survey.groupId, strictOrder: false, items: [{ surveyId: survey.id, required: true }] },
    });
    expect(res.ok(), await res.text()).toBe(true);
    ids.push(((await res.json()) as { id: string }).id);
  }
  try {
    await login(page, "superadmin");
    // первый показ — выбор: назначения первой строки грузятся сразу
    const first = page.waitForResponse((r) => /^\/api\/batteries\/[^/]+\/assignments$/.test(new URL(r.url()).pathname));
    await page.goto("/batteries");
    await first;

    const loads = watch(page, /^\/api\/batteries\/[^/]+\/assignments$/);
    await stepThrice(page);
    const landed = selectedId(page);
    expect(landed, "J не сдвинул выбор").toBeTruthy();
    expect(loads, "назначения ушли по промежуточным строкам").toEqual([`/api/batteries/${landed}/assignments`]);

    // щелчок — выбор: запрос уходит, не дожидаясь паузы шага
    const target = ids.find((id) => id !== landed)!;
    const n = ids.indexOf(target) + 1;
    await Promise.all([
      page.waitForRequest((r) => new URL(r.url()).pathname === `/api/batteries/${target}/assignments`, { timeout: 450 }),
      page.getByRole("link", { name: new RegExp(`Крок ${tag} ${n}`) }).click(),
    ]);
  } finally {
    for (const id of ids) await page.request.delete(`/api/batteries/${id}`, { headers: auth(token) });
  }
});

test("группы методик: J/K грузят аналитику группы, на которой остановились; щелчок — сразу", async ({ page }) => {
  const token = await apiToken(page, "superadmin");
  const tag = crypto.randomUUID().slice(0, 6);
  const ids: string[] = [];
  for (const n of [1, 2, 3]) {
    const res = await page.request.post("/api/groups", { headers: auth(token), data: { title: `Крок ${tag} ${n}` } });
    expect(res.ok(), await res.text()).toBe(true);
    ids.push(((await res.json()) as { id: string }).id);
  }
  try {
    await login(page, "superadmin");
    const first = page.waitForResponse((r) => /^\/api\/analytics\/groups\/[^/]+$/.test(new URL(r.url()).pathname));
    await page.goto("/groups");
    await first;

    const loads = watch(page, /^\/api\/analytics\/groups\/[^/]+$/);
    await stepThrice(page);
    const landed = selectedId(page);
    expect(landed, "J не сдвинул выбор").toBeTruthy();
    expect(loads, "аналитика ушла по промежуточным строкам").toEqual([`/api/analytics/groups/${landed}`]);

    const target = ids.find((id) => id !== landed)!;
    const n = ids.indexOf(target) + 1;
    await Promise.all([
      page.waitForRequest((r) => new URL(r.url()).pathname === `/api/analytics/groups/${target}`, { timeout: 450 }),
      page.getByRole("link", { name: new RegExp(`Крок ${tag} ${n}`) }).click(),
    ]);
  } finally {
    for (const id of ids) await page.request.delete(`/api/groups/${id}`, { headers: auth(token) });
  }
});
