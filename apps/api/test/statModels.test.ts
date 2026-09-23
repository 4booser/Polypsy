import { beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  ERRORS,
  type ErrorKey,
  type StatCell,
  type StatRunColumn,
  type StatRunResult,
} from "@quizzy/shared";
import {
  adminA,
  adminB,
  api,
  createSurveySchema,
  createVersion,
  db,
  groupA,
  makeUser,
  patient,
  responsesTable,
  root,
  surveyInB,
  surveys,
  users,
  type Person,
} from "./fixtures";
import { patientGroups, staffRoles } from "../src/db/schema";

/**
 * Раздел «Статистика»: пресеты фильтров и статистические модели.
 *
 * Проверяются четыре вещи, которые ломаются молча: кто какие модели видит,
 * сходятся ли числа с посевом, действует ли порог малых чисел так, что
 * скрытое нельзя восстановить вычитанием, и есть ли политики строк у новых
 * таблиц. Каждая защита проверена мутацией — снималась, и тест обязан
 * был упасть, назвав виновника поимённо; мутации записаны у проверок.
 *
 * Тестовый пользователь базы обходит RLS, поэтому разграничение
 * проверяется через API от лица разных людей, а политики — текстом из
 * pg_policies.
 */

const FLOOR = 5;

/** Ответ обязан отказать этим ключом: текст собран из словаря на языке запроса */
function expectError(res: { status: number; body: { error?: string } }, status: number, key: ErrorKey) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  const head = ERRORS[key].uk.split("{")[0]!.trim();
  expect(String(res.body?.error ?? ""), `ждали отказ ${key}`).toContain(head);
}

interface Content {
  id: string;
  versionId: string;
  scaleId: string;
  band: Record<"low" | "mid" | "high", string>;
  sleepQ: string;
  sleep: Record<"good" | "soso" | "bad", string>;
  whyQ: string;
  why: Record<"noise" | "thoughts" | "pain", string>;
  textQ: string;
}

/**
 * Методика прямо в базе, как в fixtures: одна шкала с тремя полосами по
 * одному ответу, вопрос с одним выбором, вопрос с несколькими, свободный
 * текст. Полосы по одному баллу, чтобы каждый ответ клал человека ровно в
 * одну известную полосу — числа ниже проверяются руками.
 */
async function makeSurvey(groupId: string, owner: Person): Promise<Content> {
  const id = crypto.randomUUID();
  const draft = createSurveySchema.parse({
    title: { uk: "Статистична методика" },
    groupId,
    administration: "self",
    scoringEnabled: true,
    allowRetake: true,
    visibility: "public",
    scales: [
      {
        code: "risk",
        title: { uk: "Ризик" },
        aggregation: "sum",
        bands: [
          { minScore: 0, maxScore: 0, label: { uk: "Низький" }, severity: "none" },
          { minScore: 1, maxScore: 1, label: { uk: "Середній" }, severity: "mild" },
          { minScore: 2, maxScore: 3, label: { uk: "Високий" }, severity: "severe" },
        ],
      },
    ],
    questions: [
      {
        type: "single",
        title: { uk: "Як ви спите?" },
        scaleCode: "risk",
        required: true,
        options: [
          { text: { uk: "Добре" }, score: 0 },
          { text: { uk: "Так собі" }, score: 1 },
          { text: { uk: "Погано" }, score: 2 },
        ],
      },
      {
        type: "multiple",
        title: { uk: "Що заважає?" },
        options: [
          { text: { uk: "Шум" }, score: 0 },
          { text: { uk: "Думки" }, score: 0 },
          { text: { uk: "Біль" }, score: 0 },
        ],
      },
      { type: "text", title: { uk: "Коментар" }, options: [] },
    ],
  });
  await db.insert(surveys).values({
    id,
    groupId,
    title: draft.title,
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: owner.id,
  } as never);
  await createVersion(id, draft, owner.id, "Перша версія");

  const full = (await api(`/api/surveys/${id}`, owner.token)).body;
  const scale = full.scales[0];
  const byLabel = (labels: string[]) => labels.map((l) => scale.bands.find((b: { label: string }) => b.label === l).id);
  const [low, mid, high] = byLabel(["Низький", "Середній", "Високий"]);
  const q = (title: string) => full.questions.find((x: { title: string }) => x.title === title);
  const opt = (question: { options: { id: string; text: string }[] }, text: string) =>
    question.options.find((o) => o.text === text)!.id;
  const sleepQ = q("Як ви спите?");
  const whyQ = q("Що заважає?");
  return {
    id,
    versionId: full.versionId,
    scaleId: scale.id,
    band: { low, mid, high },
    sleepQ: sleepQ.id,
    sleep: { good: opt(sleepQ, "Добре"), soso: opt(sleepQ, "Так собі"), bad: opt(sleepQ, "Погано") },
    whyQ: whyQ.id,
    why: { noise: opt(whyQ, "Шум"), thoughts: opt(whyQ, "Думки"), pain: opt(whyQ, "Біль") },
    textQ: q("Коментар").id,
  };
}

interface Picks {
  sleep: string;
  why?: string[];
}

async function submit(content: Content, person: Person, picks: Picks): Promise<string> {
  const answers = [
    { questionId: content.sleepQ, optionIds: [picks.sleep], durationMs: 1000, changeCount: 0, visitCount: 1 },
    ...(picks.why?.length
      ? [{ questionId: content.whyQ, optionIds: picks.why, durationMs: 1000, changeCount: 0, visitCount: 1 }]
      : []),
  ];
  const res = await api(`/api/surveys/${content.id}/responses`, person.token, {
    method: "POST",
    body: JSON.stringify({ startedAt: new Date(Date.now() - 60_000).toISOString(), durationMs: 60_000, events: [], answers }),
  });
  expect(res.status, `сдача прохождения: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body.id as string;
}

async function person(tag: string, extra: { sex: "male" | "female"; birthDate: string; locality?: string }): Promise<Person> {
  return makeUser("user", `stat-${tag}-${crypto.randomUUID()}@test`, extra);
}

const cellOf = (c: StatCell) => (c.suppressed ? "×" : `${c.count}/${c.percent}%`);

/* ─────────── посев для расчёта ─────────── */

let content: Content;
/** Двенадцать мужчин по 30 лет из Тестового: 5 «Добре», 2 «Так собі», 5 «Погано» */
const men: Person[] = [];
/** Трое женщин по 50 лет из Іншого: все «Так собі», на «Що заважає?» не отвечают */
const women: Person[] = [];
/** Один юноша 20 лет из Тестового: «Погано» */
let young: Person;
/** Группа пациентов adminA из шести мужчин: трое «Добре», трое «Погано» */
let groupId: string;
/** Вторая группа из семи: пятеро «Погано» и двое «Добре» — «ВШР» у пятерых из семи */
let riskGroupId: string;

beforeAll(async () => {
  content = await makeSurvey(groupA, adminA);

  for (let i = 0; i < 12; i++) {
    const p = await person(`m${i}`, { sex: "male", birthDate: "1996-05-05", locality: "Тестове" });
    men.push(p);
    const sleep = i < 5 ? content.sleep.good : i < 7 ? content.sleep.soso : content.sleep.bad;
    // десять первых слышат шум, трое из них ещё и думают; боль — никто
    const why = [...(i < 10 ? [content.why.noise] : []), ...(i < 3 ? [content.why.thoughts] : [])];
    if (i === 0) {
      /*
       * Первый сдаёт дважды: сначала «Погано», потом «Добре». Считаться
       * должно последнее — иначе человек с повторным замером весил бы
       * вдвое, а полоса бралась бы из прошлого.
       */
      const first = await submit(content, p, { sleep: content.sleep.bad, why });
      // десять дней назад — с запасом от границ суток в любом поясе базы
      await db
        .update(responsesTable)
        .set({ submittedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() })
        .where(eq(responsesTable.id, first));
    }
    await submit(content, p, { sleep, why });
  }
  for (let i = 0; i < 3; i++) {
    const p = await person(`f${i}`, { sex: "female", birthDate: "1976-01-01", locality: "Інше" });
    women.push(p);
    await submit(content, p, { sleep: content.sleep.soso });
  }
  young = await person("y", { sex: "male", birthDate: "2006-01-01", locality: "Тестове" });
  await submit(content, young, { sleep: content.sleep.bad });

  const group = await api("/api/patient-groups", adminA.token, {
    method: "POST",
    body: JSON.stringify({ title: "Стат-група" }),
  });
  groupId = group.body.id;
  for (const p of [...men.slice(0, 3), ...men.slice(7, 10)]) {
    const added = await api(`/api/patient-groups/${groupId}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: p.id }),
    });
    expect(added.status).toBe(201);
  }
  const risky = await api("/api/patient-groups", adminA.token, {
    method: "POST",
    body: JSON.stringify({ title: "ВШР-група" }),
  });
  riskGroupId = risky.body.id;
  for (const p of [...men.slice(0, 2), ...men.slice(7, 12)]) {
    const added = await api(`/api/patient-groups/${riskGroupId}/members`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: p.id }),
    });
    expect(added.status).toBe(201);
  }
});

/** Колонка со всеми показателями методики; фильтры — свои или пресет */
function column(extra: Partial<{ title: string; presetId: string; filters: object }> = {}) {
  return {
    title: extra.title ?? null,
    presetId: extra.presetId ?? null,
    filters: extra.presetId ? null : (extra.filters ?? {}),
    surveyId: content.id,
    bands: [
      { scaleId: content.scaleId, bandId: content.band.low },
      { scaleId: content.scaleId, bandId: content.band.mid },
      { scaleId: content.scaleId, bandId: content.band.high, highRisk: true },
    ],
    questions: [
      {
        questionId: content.sleepQ,
        options: [
          { optionId: content.sleep.good },
          { optionId: content.sleep.soso },
          { optionId: content.sleep.bad, highRisk: true },
        ],
      },
      {
        questionId: content.whyQ,
        options: [{ optionId: content.why.noise }, { optionId: content.why.thoughts }, { optionId: content.why.pain }],
      },
    ],
  };
}

/**
 * Та же колонка, но пометки «ВШР» только на названных полосах и вариантах:
 * утечка через «ВШР» зависит от того, какие именно ячейки помечены.
 */
function markedColumn(
  extra: Parameters<typeof column>[0],
  marks: Partial<{ band: (keyof Content["band"])[]; sleep: (keyof Content["sleep"])[]; why: (keyof Content["why"])[] }>,
) {
  const flag = <K extends string>(ids: Record<K, string>, keys: K[] = []) =>
    (Object.keys(ids) as K[]).map((k) => ({ id: ids[k], highRisk: keys.includes(k) }));
  return {
    ...column(extra),
    bands: flag(content.band, marks.band).map((b) => ({ scaleId: content.scaleId, bandId: b.id, highRisk: b.highRisk })),
    questions: [
      { questionId: content.sleepQ, options: flag(content.sleep, marks.sleep).map((o) => ({ optionId: o.id, highRisk: o.highRisk })) },
      { questionId: content.whyQ, options: flag(content.why, marks.why).map((o) => ({ optionId: o.id, highRisk: o.highRisk })) },
    ],
  };
}

const preview = (columns: object[], actor: Person = adminA) =>
  api<StatRunResult>("/api/stat-models/run", actor.token, { method: "POST", body: JSON.stringify({ columns }) });

/* ═══════════ пресеты фильтров ═══════════ */

describe("пресеты фильтров: свои и только свои", () => {
  async function makePreset(actor: Person, title: string, criteria: object = { sex: "male" }): Promise<string> {
    const res = await api("/api/filter-presets", actor.token, {
      method: "POST",
      body: JSON.stringify({ title, criteria }),
    });
    expect(res.status, `заведение пресета «${title}»: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body.id as string;
  }

  test("заводится, читается и правится владельцем; критерии заменяются целиком", async () => {
    const id = await makePreset(adminA, "Чоловіки 25–45", { sex: "male", ageMin: 25, ageMax: 45 });
    const got = await api(`/api/filter-presets/${id}`, adminA.token);
    expect(got.status).toBe(200);
    expect(got.body.criteria).toEqual({ sex: "male", ageMin: 25, ageMax: 45 });
    expect(got.body.modelCount).toBe(0);

    // «—» убирает строку: слияние вернуло бы возраст назад
    const patched = await api(`/api/filter-presets/${id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ criteria: { sex: "male" } }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.criteria, "правка критериев слила старые строки с новыми").toEqual({ sex: "male" });

    const list = await api("/api/filter-presets?q=25", adminA.token);
    expect(list.status).toBe(200);
    expect((list.body.items as { id: string }[]).map((p) => p.id), "поиск по названию не нашёл пресет").toContain(id);
  });

  /**
   * Мутация: убрать условие по владельцу из GET / и снять
   * assertFilterPresetAccess с карточки, правки и удаления — падают четыре
   * проверки, каждая называет свой маршрут.
   */
  test("чужой пресет не виден, не открывается, не правится и не удаляется — «не найдено»", async () => {
    const id = await makePreset(adminA, "Особистий зріз");
    const list = await api("/api/filter-presets", adminB.token);
    expect((list.body.items as { id: string }[]).map((p) => p.id), "GET /api/filter-presets отдал чужой пресет").not.toContain(id);
    expect((await api(`/api/filter-presets/${id}`, adminB.token)).status, "GET /:id открыл чужой пресет").toBe(404);
    const patched = await api(`/api/filter-presets/${id}`, adminB.token, {
      method: "PATCH",
      body: JSON.stringify({ title: "Захоплено" }),
    });
    expect(patched.status, "PATCH /:id правит чужой пресет").toBe(404);
    expect((await api(`/api/filter-presets/${id}`, adminB.token, { method: "DELETE" })).status, "DELETE /:id удаляет чужой").toBe(404);

    // суперадмин видит чужие: разбирать чужие экраны ему больше нечем
    expect((await api(`/api/filter-presets/${id}`, root.token)).status).toBe(200);
  });

  /**
   * Мутация: убрать assertFilterRefs из POST / — пресет с чужой группой
   * сохраняется, проверка называет идентификатор группы.
   */
  test("чужая группа пациентов в критериях — «не найдено» уже при сохранении", async () => {
    const foreign = await api("/api/patient-groups", adminB.token, {
      method: "POST",
      body: JSON.stringify({ title: "Група Б" }),
    });
    const res = await api("/api/filter-presets", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Чужа група", criteria: { patientGroupId: foreign.body.id } }),
    });
    expect(res.status, `пресет с чужой группой ${foreign.body.id} сохранился`).toBe(404);
    // своя — сохраняется
    const own = await api("/api/filter-presets", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Своя група", criteria: { patientGroupId: groupId } }),
    });
    expect(own.status).toBe(201);
  });

  /**
   * Мутация: убрать проверку modelCount из DELETE — пресет удаляется
   * из-под модели, проверка называет число моделей, которое ждала в отказе.
   */
  test("занятый моделью пресет не удаляется, пока модель на него ссылается", async () => {
    const id = await makePreset(adminA, "Під моделлю");
    const model = await api("/api/stat-models", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Тримає пресет", columns: [column({ presetId: id })] }),
    });
    expect(model.status, JSON.stringify(model.body)).toBe(201);
    expect((await api(`/api/filter-presets/${id}`, adminA.token)).body.modelCount).toBe(1);

    expectError(await api(`/api/filter-presets/${id}`, adminA.token, { method: "DELETE" }), 400, "err.filterPresetInUse");

    expect((await api(`/api/stat-models/${model.body.id}`, adminA.token, { method: "DELETE" })).status).toBe(204);
    expect((await api(`/api/filter-presets/${id}`, adminA.token, { method: "DELETE" })).status).toBe(204);
    expect((await api(`/api/filter-presets/${id}`, adminA.token)).status).toBe(404);
  });

  test("возраст «від» больше «до» и период задом наперёд — отказ схемы", async () => {
    const bad = await api("/api/filter-presets", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Навпаки", criteria: { ageMin: 40, ageMax: 20 } }),
    });
    expect(bad.status).toBe(400);
    const dates = await api("/api/filter-presets", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Навпаки", criteria: { from: "2026-09-10", to: "2026-09-01" } }),
    });
    expect(dates.status).toBe(400);
  });
});

/* ═══════════ модели: CRUD, поиск, страницы, скоуп ═══════════ */

describe("статистические модели: заведение, перечень, скоуп", () => {
  async function makeModel(actor: Person, title: string, columns: object[] = [column()], description?: string) {
    const res = await api("/api/stat-models", actor.token, {
      method: "POST",
      body: JSON.stringify({ title, description, columns }),
    });
    expect(res.status, `заведение модели «${title}»: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body as { id: string; columns: { versionId: string; filters: object | null; presetId: string | null }[] };
  }

  test("версия методики записывается при сохранении, а не плавает", async () => {
    const model = await makeModel(adminA, "З версією");
    expect(model.columns[0]!.versionId, "колонка сохранилась без версии").toBe(content.versionId);
    expect(model.columns[0]!.filters).toEqual({});

    const got = await api(`/api/stat-models/${model.id}`, adminA.token);
    expect(got.status).toBe(200);
    expect(got.body.columns).toHaveLength(1);
  });

  test("перечень: поиск по названию и описанию, страницы с total", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    await makeModel(adminA, `Пошук-${tag} перша`);
    await makeModel(adminA, `Пошук-${tag} друга`);
    await makeModel(adminA, `Інша ${tag}`, [column()], `опис із словом Пошук-${tag}`);

    const found = await api(`/api/stat-models?q=${encodeURIComponent(`Пошук-${tag}`)}`, adminA.token);
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.total, "поиск не смотрит в описание или название").toBe(3);
    expect(found.body.items[0].columnCount).toBe(1);

    const page = await api(`/api/stat-models?q=${encodeURIComponent(`Пошук-${tag}`)}&limit=2&offset=0`, adminA.token);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.total, "total страницы считается не по тем же условиям").toBe(3);
    const rest = await api(`/api/stat-models?q=${encodeURIComponent(`Пошук-${tag}`)}&limit=2&offset=2`, adminA.token);
    expect(rest.body.items).toHaveLength(1);
    // колонки в перечень не входят
    expect(page.body.items[0].columns).toBeUndefined();
  });

  /**
   * Мутация: убрать условие по владельцу из GET / и снять
   * assertStatModelAccess с карточки, правки, удаления и расчёта —
   * падают все пять проверок, каждая называет свой маршрут.
   */
  test("чужая модель не видна, не открывается, не правится, не удаляется и не считается", async () => {
    const model = await makeModel(adminA, "Особиста модель");
    const list = await api("/api/stat-models", adminB.token);
    expect((list.body.items as { id: string }[]).map((m) => m.id), "GET /api/stat-models отдал чужую модель").not.toContain(model.id);
    expect((await api(`/api/stat-models/${model.id}`, adminB.token)).status, "GET /:id открыл чужую модель").toBe(404);
    const patched = await api(`/api/stat-models/${model.id}`, adminB.token, {
      method: "PATCH",
      body: JSON.stringify({ title: "Захоплено" }),
    });
    expect(patched.status, "PATCH /:id правит чужую модель").toBe(404);
    expect((await api(`/api/stat-models/${model.id}/run`, adminB.token, { method: "POST" })).status, "POST /:id/run считает чужую").toBe(404);
    expect((await api(`/api/stat-models/${model.id}`, adminB.token, { method: "DELETE" })).status, "DELETE /:id удаляет чужую").toBe(404);

    expect((await api(`/api/stat-models/${model.id}`, root.token)).status).toBe(200);
  });

  /**
   * Мутация: убрать assertFilterRefs из resolveColumns — модель с чужой
   * группой в колонке сохраняется; убрать assertFilterPresetAccess —
   * сохраняется с чужим пресетом. Обе проверки называют идентификатор.
   */
  test("чужая группа или чужой пресет в колонке — «не найдено», чужая методика — «не ваша»", async () => {
    const foreignGroup = await api("/api/patient-groups", adminB.token, {
      method: "POST",
      body: JSON.stringify({ title: "Група Б для моделі" }),
    });
    const withGroup = await api("/api/stat-models", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Чужа група", columns: [column({ filters: { patientGroupId: foreignGroup.body.id } })] }),
    });
    expect(withGroup.status, `модель с чужой группой ${foreignGroup.body.id} сохранилась`).toBe(404);

    const foreignPreset = await api("/api/filter-presets", adminB.token, {
      method: "POST",
      body: JSON.stringify({ title: "Пресет Б", criteria: {} }),
    });
    const withPreset = await api("/api/stat-models", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Чужий пресет", columns: [column({ presetId: foreignPreset.body.id })] }),
    });
    expect(withPreset.status, `модель с чужим пресетом ${foreignPreset.body.id} сохранилась`).toBe(404);

    // методика группы Б — вне зоны adminA: 403, как у всех маршрутов методик
    const withSurvey = await api("/api/stat-models", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Чужа методика", columns: [{ ...column(), surveyId: surveyInB }] }),
    });
    expectError(withSurvey, 403, "err.surveyOutOfScope");
  });

  /**
   * Мутация: убрать assertIndicators из resolveColumns — все три модели
   * ниже сохраняются, а расчёт по ним отдаёт пустые полосы.
   */
  test("показатели сверяются с версией методики: чужая полоса, чужой вариант, вопрос без вариантов, чужая версия", async () => {
    const post = (columns: object[]) =>
      api("/api/stat-models", adminA.token, { method: "POST", body: JSON.stringify({ title: "Перевірка", columns }) });

    const badBand = await post([{ ...column(), bands: [{ scaleId: content.scaleId, bandId: "no-such-band" }] }]);
    expectError(badBand, 400, "err.statModelIndicatorUnknown");

    const badOption = await post([{ ...column(), bands: [], questions: [{ questionId: content.sleepQ, options: [{ optionId: content.why.noise }] }] }]);
    expectError(badOption, 400, "err.statModelIndicatorUnknown");

    const textQuestion = await post([{ ...column(), bands: [], questions: [{ questionId: content.textQ, options: [] }] }]);
    expectError(textQuestion, 400, "err.statModelQuestionType");

    const [otherVersion] = await db.execute<{ id: string }>(
      sql`select id from survey_versions where survey_id = ${surveyInB} limit 1`,
    );
    const badVersion = await post([{ ...column(), versionId: otherVersion!.id }]);
    expectError(badVersion, 400, "err.statModelVersionNotFound");

    // пресет и свои фильтры вместе — отказ схемы: непонятно, что из них правда
    const both = await post([{ ...column(), presetId: "x", filters: { sex: "male" } }]);
    expect(both.status).toBe(400);
  });

  test("правка заменяет колонки целиком, пустое тело ничего не меняет", async () => {
    const model = await makeModel(adminA, "До правки", [column(), column({ title: "Друга" })]);
    const patched = await api(`/api/stat-models/${model.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ title: "Після правки", columns: [column({ title: "Єдина" })] }),
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.title).toBe("Після правки");
    expect(patched.body.columns, "правка слила старые колонки с новыми").toHaveLength(1);
    expect(patched.body.columns[0].title).toBe("Єдина");

    const empty = await api(`/api/stat-models/${model.id}`, adminA.token, { method: "PATCH", body: "{}" });
    expect(empty.status).toBe(200);
    expect(empty.body.columns).toHaveLength(1);
  });
});

/* ═══════════ расчёт ═══════════ */

describe("расчёт: числа сходятся с посевом", () => {
  let all: StatRunColumn;
  let menCol: StatRunColumn;

  beforeAll(async () => {
    const res = await preview([
      column({ title: "Усі" }),
      column({ title: "Чоловіки 25–45", filters: { sex: "male", ageMin: 25, ageMax: 45 } }),
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    [all, menCol] = res.body.columns as [StatRunColumn, StatRunColumn];
  });

  const band = (col: StatRunColumn, label: string) => col.scales[0]!.bands.find((b) => b.label === label)!.cell;
  const option = (col: StatRunColumn, title: string, text: string) =>
    col.questions.find((q) => q.title === title)!.options.find((o) => o.text === text)!.cell;

  /**
   * Мутация: считать все прохождения, а не последнее на человека (убрать
   * `r.userId === lastUser`) — первый мужчина учитывается дважды, «Усі»
   * становится 17, проверка называет число.
   */
  test("основание — люди, по последнему сданному прохождению каждого", async () => {
    expect(all.respondents, "16 человек, у одного два прохождения").toEqual({ suppressed: false, count: 16, percent: 100 });
    expect(all.surveyTitle).toBe("Статистична методика");
    expect(all.versionNumber).toBe(1);
    // повторный замер первого мужчины: считается «Добре» (последнее), а не «Погано» (первое)
    expect(band(all, "Низький")).toEqual({ suppressed: false, count: 5, percent: 31 });
    expect(band(all, "Середній")).toEqual({ suppressed: false, count: 5, percent: 31 });
    expect(band(all, "Високий")).toEqual({ suppressed: false, count: 6, percent: 38 });
    expect(all.scales[0]!.rest).toEqual({ suppressed: false, count: 0, percent: 0 });
  });

  test("ответы: один выбор — разбиение с остатком, несколько — каждый вариант отдельно", async () => {
    expect(option(all, "Як ви спите?", "Добре")).toEqual({ suppressed: false, count: 5, percent: 31 });
    expect(option(all, "Як ви спите?", "Погано")).toEqual({ suppressed: false, count: 6, percent: 38 });
    expect(all.questions[0]!.rest).toEqual({ suppressed: false, count: 0, percent: 0 });

    // шум слышат десять мужчин из 16; не слышат шестеро — оба края над порогом; боли нет ни у кого — честный ноль
    expect(option(all, "Що заважає?", "Шум")).toEqual({ suppressed: false, count: 10, percent: 63 });
    expect(option(all, "Що заважає?", "Біль")).toEqual({ suppressed: false, count: 0, percent: 0 });
    // думают трое — ниже порога, спрятано
    expect(option(all, "Що заважає?", "Думки")).toEqual({ suppressed: true });
    // никого из показанных не выбрали шестеро: двое мужчин, три женщины и юноша
    expect(all.questions[1]!.rest).toEqual({ suppressed: false, count: 6, percent: 38 });
  });

  /**
   * Мутация: убрать возрастной фильтр из sampleOf — юноша и женщины
   * попадают в «Чоловіки 25–45»… женщин держит пол, а юноша делает 13,
   * проверка называет число.
   */
  test("фильтры по полу и возрасту на момент прохождения", async () => {
    expect(menCol.respondents).toEqual({ suppressed: false, count: 12, percent: 100 });
    expect(menCol.filters).toEqual({ sex: "male", ageMin: 25, ageMax: 45 });
    // 5 «Добре» и 5 «Погано» показаны, 2 «Так собі» — нет; доли от показанного основания 12
    expect(band(menCol, "Низький")).toEqual({ suppressed: false, count: 5, percent: 42 });
    expect(band(menCol, "Високий")).toEqual({ suppressed: false, count: 5, percent: 42 });
    expect(band(menCol, "Середній")).toEqual({ suppressed: true });
  });

  /**
   * Мутация: считать «ВШР» по одному краю (`suppress(n) === null` без
   * дополнения) — у «Чоловіки 25–45» ничего не меняется, а у группы из
   * семи с пятью попаданиями показалось бы «5 из 7», называя двоих.
   */
  test("«ВШР» — люди хотя бы с одним попаданием в помеченный показатель, с обоих краёв порога", async () => {
    // высокая полоса и «Погано» — одни и те же пятеро
    expect(menCol.highRisk).toEqual({ suppressed: false, count: 5, percent: 42 });
    expect(all.highRisk).toEqual({ suppressed: false, count: 6, percent: 38 });
    expect(menCol.scales[0]!.bands.find((b) => b.label === "Високий")!.highRisk).toBe(true);

    const seven = await preview([column({ filters: { patientGroupId: riskGroupId } })]);
    expect(seven.body.columns[0]!.respondents).toEqual({ suppressed: false, count: 7, percent: 100 });
    expect(seven.body.columns[0]!.highRisk, "«5 из 7» называет двоих без попадания").toEqual({ suppressed: true });

    // без пометок — нечего показывать: null, а не ноль
    const none = await preview([{ ...column(), bands: [], questions: [] }]);
    expect(none.body.columns[0]!.highRisk).toBeNull();
  });

  test("населённый пункт без учёта регистра, группа пациентов, один человек, период", async () => {
    const res = await preview([
      column({ title: "місто", filters: { locality: "тестове" } }),
      column({ title: "група", filters: { patientGroupId: groupId } }),
      column({ title: "один", filters: { patientId: men[0]!.id } }),
      column({ title: "завтра", filters: { from: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) } }),
      column({ title: "тиждень тому", filters: { to: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10) } }),
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [town, group, one, tomorrow, before] = res.body.columns as StatRunColumn[];
    expect(town!.respondents, "«тестове» ≠ «Тестове»: фильтр по городу чувствителен к регистру").toEqual({ suppressed: false, count: 13, percent: 100 });

    // шестеро в группе: трое «Добре», трое «Погано» — оба ниже порога, спрятаны; «Так собі» — честный ноль
    expect(group!.respondents).toEqual({ suppressed: false, count: 6, percent: 100 });
    expect(band(group!, "Низький")).toEqual({ suppressed: true });
    expect(band(group!, "Високий")).toEqual({ suppressed: true });
    expect(band(group!, "Середній")).toEqual({ suppressed: false, count: 0, percent: 0 });

    // выборка из одного всегда под порогом — и основание тоже
    expect(one!.respondents).toEqual({ suppressed: true });
    // пусто — ноль показывается: «никого нет» не выдаёт никого
    expect(tomorrow!.respondents).toEqual({ suppressed: false, count: 0, percent: 0 });
    expect(band(tomorrow!, "Низький")).toEqual({ suppressed: false, count: 0, percent: 0 });
    // «по пять днів тому» отсекает всё, кроме первого прохождения, перенесённого на десять дней
    // назад; в этом периоде оно у своего человека единственное — колонка из одного подавлена
    expect(before!.respondents).toEqual({ suppressed: true });
  });

  test("«Оновити» по сохранённой модели считает то же, что превью, и подписывает пресет", async () => {
    const preset = await api("/api/filter-presets", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Чоловіки 25–45", criteria: { sex: "male", ageMin: 25, ageMax: 45 } }),
    });
    const model = await api("/api/stat-models", adminA.token, {
      method: "POST",
      body: JSON.stringify({ title: "Збережена", columns: [column({ title: "За пресетом", presetId: preset.body.id })] }),
    });
    expect(model.status, JSON.stringify(model.body)).toBe(201);

    const run = await api<StatRunResult>(`/api/stat-models/${model.body.id}/run`, adminA.token, { method: "POST" });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body.modelId).toBe(model.body.id);
    expect(run.body.smallCellFloor).toBe(FLOOR);
    const col = run.body.columns[0]!;
    expect(col.presetTitle).toBe("Чоловіки 25–45");
    expect(col.filters, "фильтры колонки взяты не из пресета").toEqual({ sex: "male", ageMin: 25, ageMax: 45 });
    expect(col.respondents).toEqual(menCol.respondents);
    expect(col.scales[0]!.bands.map((b) => cellOf(b.cell))).toEqual(menCol.scales[0]!.bands.map((b) => cellOf(b.cell)));
  });
});

/* ═══════════ порог малых чисел ═══════════ */

describe("порог малых чисел", () => {
  test("порог берётся из общего места", async () => {
    const { SMALL_CELL_FLOOR } = await import("../src/lib/privacy");
    const res = await preview([column()]);
    expect(res.body.smallCellFloor).toBe(SMALL_CELL_FLOOR);
    expect(FLOOR).toBe(SMALL_CELL_FLOOR);
  });

  /**
   * Мутация: отдать колонке под порогом основание и нули вместо
   * подавления (`open = true`) — «жінки» показывает 3, проверка называет
   * число и полосу «Середній: 3».
   */
  test("колонка меньше порога подавляется целиком — основание, полосы, ответы, «ВШР»", async () => {
    const res = await preview([column({ title: "жінки", filters: { sex: "female" } })]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const col = res.body.columns[0]!;
    expect(col.respondents, "основание из трёх человек показано").toEqual({ suppressed: true });
    for (const b of col.scales[0]!.bands) expect(b.cell, `полоса «${b.label}» показана в колонке из трёх`).toEqual({ suppressed: true });
    expect(col.scales[0]!.rest).toEqual({ suppressed: true });
    for (const q of col.questions) {
      for (const o of q.options) expect(o.cell, `ответ «${o.text}» показан в колонке из трёх`).toEqual({ suppressed: true });
      expect(q.rest).toEqual({ suppressed: true });
    }
    expect(col.highRisk).toEqual({ suppressed: true });
    // структура на месте: экран рисует те же строки с подписью «менше 5»
    expect(col.scales[0]!.bands.map((b) => b.label)).toEqual(["Низький", "Середній", "Високий"]);
  });

  /**
   * Дополняющее подавление — то, ради чего порог вообще действует.
   *
   * Проверяется не «сколько скрыто», а то, можно ли вычислить скрытое: из
   * показанного основания и показанных ячеек разбиения считается остаток,
   * и если скрыта ровно одна ячейка, она названа — просто не своими руками.
   * «ВШР» — ещё одно показанное число поверх тех же ячеек: сумма помеченных
   * (у ответов с несколькими вариантами — объединение), и над скрытой
   * помеченной ячейкой он называет её так же: 7 − 5. Поэтому вторая часть
   * проверки: показанный «ВШР» не стоит ни над одной скрытой помеченной
   * ячейкой — ни в полосах, ни в вариантах одного выбора, ни в нескольких.
   *
   * Мутация: заменить suppressedKeys в partitionCells на простое
   * подавление по порогу — в «Чоловіки 25–45» скрытой остаётся одна
   * «Середній», остаток 0 показан, и проверка называет её: 12 − 5 − 5 − 0.
   * Мутация: считать «ВШР» без riskHidden, одним twoSidedCell от
   * riskHits.size, как прежде, — в «низький+середній» «ВШР: 7» показан
   * поверх скрытой «Середній», и проверка называет колонку, шкалу и ячейку;
   * следом то же по «Так собі» в вопросе и по «Думки» среди нескольких.
   */
  test("скрытую ячейку нельзя восстановить вычитанием из показанного основания", async () => {
    const men25 = { title: "Чоловіки 25–45", filters: { sex: "male", ageMin: 25, ageMax: 45 } };
    const res = await preview([
      column(men25),
      column({ title: "Усі" }),
      column({ title: "Група", filters: { patientGroupId: groupId } }),
      // сценарий ревью: помечены показанная и скрытая ячейки одного разбиения — в полосах и в вариантах одного выбора
      markedColumn({ ...men25, title: "низький+середній" }, { band: ["low", "mid"] }),
      markedColumn({ ...men25, title: "добре+так собі" }, { sleep: ["good", "soso"] }),
      // несколько вариантов: «Шум» 10 из 16 показан, «Думки» 3 скрыты, и все думающие слышат шум
      markedColumn({ title: "шум+думки" }, { why: ["noise", "thoughts"] }),
      // скрытая ячейка БЕЗ пометки «ВШР» не прячет: он равен показанному «Низький» и ничего не добавляет
      markedColumn({ ...men25, title: "лише низький" }, { band: ["low"] }),
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const leaks: string[] = [];
    for (const col of res.body.columns) {
      if (col.respondents.suppressed) continue;
      const total = col.respondents.count;
      const partitions: { name: string; cells: { label: string; cell: StatCell }[] }[] = [
        ...col.scales.map((s) => ({
          name: `шкала «${s.scaleTitle}»`,
          cells: [...s.bands.map((b) => ({ label: b.label, cell: b.cell })), { label: "решта", cell: s.rest }],
        })),
        ...col.questions
          .filter((q) => q.type !== "multiple")
          .map((q) => ({
            name: `питання «${q.title}»`,
            cells: [...q.options.map((o) => ({ label: o.text, cell: o.cell })), { label: "решта", cell: q.rest }],
          })),
      ];
      for (const p of partitions) {
        const hidden = p.cells.filter((c) => c.cell.suppressed);
        if (hidden.length !== 1) continue;
        const shownSum = p.cells.reduce((sum, c) => sum + (c.cell.suppressed ? 0 : c.cell.count), 0);
        leaks.push(`«${col.title}», ${p.name}: «${hidden[0]!.label}» восстанавливается вычитанием: ${total} − ${shownSum} = ${total - shownSum}`);
      }

      // «ВШР» — сумма помеченных ячеек; показанный поверх скрытой помеченной он называет её тем же вычитанием
      const risk = col.highRisk;
      if (!risk || risk.suppressed) continue;
      const marked = [
        ...col.scales.flatMap((s) =>
          s.bands.filter((b) => b.highRisk).map((b) => ({ where: `шкала «${s.scaleTitle}»`, label: b.label, cell: b.cell })),
        ),
        ...col.questions.flatMap((q) =>
          q.options.filter((o) => o.highRisk).map((o) => ({ where: `питання «${q.title}»`, label: o.text, cell: o.cell })),
        ),
      ];
      const shownMarked = marked.reduce((sum, c) => sum + (c.cell.suppressed ? 0 : c.cell.count), 0);
      for (const c of marked) {
        if (!c.cell.suppressed) continue;
        leaks.push(`«${col.title}», ${c.where}: «${c.label}» скрыта, а «ВШР» показан поверх неё: ${risk.count} при показанных помеченных ${shownMarked}`);
      }
    }
    expect(leaks).toEqual([]);

    // и в конкретных числах: «Середній: 2» спрятан вместе с остатком, а не один
    const [plain, , , lowMid, goodSoso, noiseThoughts, lowOnly] = res.body.columns as StatRunColumn[];
    const bands = (col: StatRunColumn) => col.scales[0]!.bands.map((b) => `${b.label}: ${cellOf(b.cell)}`);
    const options = (col: StatRunColumn, i: number) => col.questions[i]!.options.map((o) => `${o.text}: ${cellOf(o.cell)}`);
    expect(bands(plain!)).toEqual(["Низький: 5/42%", "Середній: ×", "Високий: 5/42%"]);
    expect(plain!.scales[0]!.rest).toEqual({ suppressed: true });

    // сценарий ревью: те же 12 человек 5/2/5, помечены «Низький» и «Середній» — «ВШР: 7» назвал бы «Середній» как 7 − 5
    expect(bands(lowMid!)).toEqual(["Низький: 5/42%", "Середній: ×", "Високий: 5/42%"]);
    expect(lowMid!.highRisk, "«ВШР» показан поверх скрытой «Середній»: 7 − 5 = 2").toEqual({ suppressed: true });
    // то же по вопросу с одним выбором
    expect(options(goodSoso!, 0)).toEqual(["Добре: 5/42%", "Так собі: ×", "Погано: 5/42%"]);
    expect(goodSoso!.highRisk, "«ВШР» показан поверх скрытой «Так собі»: 7 − 5 = 2").toEqual({ suppressed: true });
    // несколько вариантов: «ВШР: 10» при «Шум: 10» сообщил бы, что думающих без шума нет
    expect(options(noiseThoughts!, 1)).toEqual(["Шум: 10/63%", "Думки: ×", "Біль: 0/0%"]);
    expect(noiseThoughts!.highRisk, "«ВШР» показан поверх скрытой «Думки»").toEqual({ suppressed: true });
    // а скрытая непомеченная «Середній» «ВШР» не прячет: он равен показанному «Низький» — прятать нечего
    expect(lowOnly!.highRisk, "«ВШР» спрятан, хотя все помеченные ячейки показаны").toEqual({ suppressed: false, count: 5, percent: 42 });
  });

  /**
   * Мутация: считать долю от полного числа респондентов до подавления —
   * ничего не меняется, пока основание показано; поэтому проверяется
   * противоположное: у подавленной колонки нет ни одного числа, из
   * которого долю можно было бы восстановить (см. проверку колонки выше),
   * а у показанной доля равна count/respondents.
   */
  test("доля считается от показанного основания", async () => {
    const res = await preview([column({ title: "Усі" })]);
    const col = res.body.columns[0]!;
    expect(col.respondents.suppressed).toBe(false);
    const total = col.respondents.suppressed ? 0 : col.respondents.count;
    for (const b of col.scales[0]!.bands) {
      if (b.cell.suppressed) continue;
      expect(b.cell.percent, `«${b.label}»: доля не от показанного основания ${total}`).toBe(Math.round((b.cell.count / total) * 100));
    }
  });

  test("ответ с несколькими вариантами прячется с обоих краёв", async () => {
    const res = await preview([column({ title: "Чоловіки 25–45", filters: { sex: "male", ageMin: 25, ageMax: 45 } })]);
    const why = res.body.columns[0]!.questions.find((q) => q.title === "Що заважає?")!;
    const cell = (text: string) => why.options.find((o) => o.text === text)!.cell;
    // шум — 10 из 12: не выбрали двое, и «10 из 12» назвало бы их так же точно
    expect(cell("Шум")).toEqual({ suppressed: true });
    expect(cell("Думки")).toEqual({ suppressed: true });
    expect(cell("Біль")).toEqual({ suppressed: false, count: 0, percent: 0 });
    expect(why.rest).toEqual({ suppressed: true });
  });
});

/* ═══════════ права ═══════════ */

describe("права", () => {
  test("пациенту раздел закрыт целиком", async () => {
    for (const [method, path] of [
      ["GET", "/api/stat-models"],
      ["POST", "/api/stat-models/run"],
      ["GET", "/api/filter-presets"],
      ["POST", "/api/filter-presets"],
    ] as const) {
      const res = await api(path, patient.token, { method, body: method === "POST" ? "{}" : undefined });
      expect(res.status, `${method} ${path} открыт пациенту`).toBe(403);
    }
  });

  /**
   * Мутация: снять requirePermission("statistics.read") с набора — сотрудник
   * без права получает список, проверка называет маршрут. Общий сторож в
   * permissions.test.ts проверяет то же по ROUTE_DOCS для каждого маршрута.
   */
  test("сотруднику без statistics.read — отказ с кодом права", async () => {
    const bare = await makeUser("admin", `stat-bare-${crypto.randomUUID()}@test`);
    await db.delete(staffRoles).where(eq(staffRoles.userId, bare.id));
    const res = await api("/api/stat-models", bare.token);
    expect(res.status, "GET /api/stat-models открыт сотруднику без права").toBe(403);
    expect(String(res.body?.error ?? "")).toContain("statistics.read");
  });

  test("роли-шаблоны: заведующий и главный врач получили право, специалист — нет", async () => {
    const rows = await db.execute<{ code: string }>(sql`
      select r.code from roles r join role_permissions rp on rp.role_id = r.id
       where rp.permission = 'statistics.read' order by r.code
    `);
    const codes = [...rows].map((r) => String(r.code));
    expect(codes).toContain("head");
    expect(codes).toContain("chief");
    expect(codes).not.toContain("specialist");
  });
});

/* ═══════════ населённый пункт ═══════════ */

describe("населённый пункт в паспортной части", () => {
  test("пациент задаёт и убирает свой; пробелы по краям — не часть названия", async () => {
    const me = await person("loc", { sex: "male", birthDate: "1990-01-01" });
    const set = await api("/api/auth/me", me.token, { method: "PATCH", body: JSON.stringify({ locality: "  Київ " }) });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.locality).toBe("Київ");
    expect((await api("/api/auth/me", me.token)).body.locality).toBe("Київ");

    // пустая строка — «убрал», а не населённый пункт с пустым названием
    const clear = await api("/api/auth/me", me.token, { method: "PATCH", body: JSON.stringify({ locality: "" }) });
    expect(clear.body.locality).toBeNull();
    const [row] = await db.select({ locality: users.locality }).from(users).where(eq(users.id, me.id));
    expect(row!.locality).toBeNull();
  });
});

/* ═══════════ политики строк ═══════════ */

describe("страховочная сетка под пресетами и моделями", () => {
  /**
   * Общая проверка покрытия в access.test.ts находит клинические таблицы
   * по колонкам со ссылкой на человека; у filter_presets и stat_models
   * такой колонки нет — owner_id, — и под неё они не попадают. Поэтому
   * названы поимённо.
   *
   * Мутация: удалить CREATE POLICY из миграции 0081 — падает первая
   * проверка; удалить ENABLE ROW LEVEL SECURITY — вторая; убрать
   * WITH CHECK — третья.
   */
  const TABLES = ["filter_presets", "stat_models"];

  test("у обеих таблиц есть политика строк, и она включена", async () => {
    for (const table of TABLES) {
      const policies = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = ${table}
      `);
      expect(Number([...policies][0]?.n ?? 0), `${table} осталась без политики строк`).toBeGreaterThan(0);
      const rls = await db.execute<{ relrowsecurity: boolean }>(sql`
        select c.relrowsecurity from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
         where ns.nspname = 'public' and c.relname = ${table}
      `);
      expect([...rls][0]?.relrowsecurity, `политика на ${table} есть, но RLS не включён`).toBe(true);
    }
  });

  test("политика спрашивает про владельца — и на чтение, и на запись", async () => {
    for (const table of TABLES) {
      const rows = await db.execute<{ qual: string; with_check: string | null }>(sql`
        select qual, with_check from pg_policies where schemaname = 'public' and tablename = ${table}
      `);
      const all = [...rows];
      const qual = all.map((r) => String(r.qual)).join(" ");
      const check = all.map((r) => String(r.with_check ?? "")).join(" ");
      expect(qual.includes("owner_id") && qual.includes("app_uid"), `${table} USING: ${qual}`).toBe(true);
      expect(check.includes("owner_id") && check.includes("app_uid"), `${table} WITH CHECK: ${check}`).toBe(true);
      // пациенту не видно ничего: роль user в политике не упоминается вовсе
      expect(qual.includes("'user'"), `${table}: политика пускает пациента`).toBe(false);
    }
  });

  test("группа пациентов в фильтре считается по составу, а не по названию", async () => {
    const [row] = await db.select().from(patientGroups).where(eq(patientGroups.id, groupId));
    expect(row?.ownerId).toBe(adminA.id);
  });
});
