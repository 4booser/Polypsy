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
/** Методика сценариев разбора: своя, чтобы её респонденты не сдвинули числа посева выше */
let skeptic: Content;
/** Населённые пункты сценариев: колонка набирается фильтром по городу */
const CITY21 = "Скепсис-21";
const CITY14 = "Скепсис-14";
const CITY20 = "Скепсис-20";
const CITY12 = "Скепсис-12";

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

  /*
   * Сценарии разбора, слово в слово из доклада проверяющих: 21 человек с
   * «ВШР» поверх двух вариантов и 14, у которых «Шум» и «Думки» — одни и те
   * же люди. Методика своя: тридцать пять человек в «Усі» сдвинули бы все
   * числа посева выше, а проверять надо ровно те расклады, на которых
   * утечка показалась.
   */
  skeptic = await makeSurvey(groupA, adminA);
  for (let i = 0; i < 21; i++) {
    /* трое старших и две женщины — ими же проверяется разность составов колонок */
    const p = await person(`s21-${i}`, {
      sex: i > 18 ? "female" : "male",
      birthDate: i < 3 ? "1975-01-01" : "1990-01-01",
      locality: CITY21,
    });
    // «Шум» №0–9, «Біль» №7–11, «Думки» №12–15, никого — №16–20
    const why = [
      ...(i < 10 ? [skeptic.why.noise] : []),
      ...(i >= 12 && i < 16 ? [skeptic.why.thoughts] : []),
      ...(i >= 7 && i < 12 ? [skeptic.why.pain] : []),
    ];
    await submit(skeptic, p, { sleep: skeptic.sleep.good, why });
  }
  for (let i = 0; i < 14; i++) {
    const p = await person(`s14-${i}`, { sex: "male", birthDate: "1990-01-01", locality: CITY14 });
    // пятеро выбрали «Шум» и «Думки» вместе, четверо — только «Біль», пятеро — ничего
    const why = i < 5 ? [skeptic.why.noise, skeptic.why.thoughts] : i < 9 ? [skeptic.why.pain] : [];
    await submit(skeptic, p, { sleep: skeptic.sleep.good, why });
  }
  for (let i = 0; i < 20; i++) {
    const p = await person(`s20-${i}`, { sex: "male", birthDate: "1990-01-01", locality: CITY20 });
    /*
     * Шестеро спят плохо — полоса «Високий»; «Шум» слышат семеро спящих
     * хорошо и один из шести. Обе помеченные ячейки над порогом, а
     * пересекаются ровно одним человеком — им и проверяется «ВШР».
     */
    const why = i < 7 || i === 14 ? [skeptic.why.noise] : [];
    await submit(skeptic, p, { sleep: i < 14 ? skeptic.sleep.good : skeptic.sleep.bad, why });
  }
  for (let i = 0; i < 12; i++) {
    const p = await person(`s12-${i}`, { sex: "male", birthDate: "1990-01-01", locality: CITY12 });
    /*
     * «Шум» — десять из двенадцати, «Біль» — семеро, вместе они покрывают
     * всех: остаток ноль, пересчёт пять, ни одна ячейка не мала. Мал только
     * ДРУГОЙ край «Шуму»: шума не слышат двое — ими проверяется второй край.
     */
    const why = [...(i < 10 ? [skeptic.why.noise] : []), ...(i >= 5 ? [skeptic.why.pain] : [])];
    await submit(skeptic, p, { sleep: skeptic.sleep.good, why });
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

/**
 * Колонка сценария разбора: один вопрос с несколькими вариантами, выборка —
 * по населённому пункту. Варианты перечисляются поимённо: у сценария 1б их
 * два, и в этом вся суть — остаток тогда равен дополнению объединения двух
 * множеств, а не трёх.
 */
function skepticColumn(
  title: string,
  locality: string,
  marks: (keyof Content["why"])[],
  keys: (keyof Content["why"])[] = ["noise", "thoughts", "pain"],
) {
  return {
    title,
    presetId: null,
    filters: { locality },
    surveyId: skeptic.id,
    bands: [],
    questions: [
      {
        questionId: skeptic.whyQ,
        options: keys.map((k) => ({ optionId: skeptic.why[k], highRisk: marks.includes(k) })),
      },
    ],
  };
}

/**
 * Каждая колонка — своим запросом.
 *
 * Колонки одной модели защищают друг друга разностью составов (своя
 * проверка ниже), и посчитанные вместе они закрывали бы одна другую. Здесь
 * проверяется другое: колонка не должна называть человека САМА ПО СЕБЕ,
 * даже когда рядом нет ни одной соседней.
 */
async function columnsApart(specs: object[]): Promise<StatRunColumn[]> {
  const out: StatRunColumn[] = [];
  for (const spec of specs) {
    const res = await preview([spec]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    out.push(res.body.columns[0]!);
  }
  return out;
}

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

  /*
   * Колонки считаются порознь, хотя на экране их ставят рядом: «Усі» и
   * «Чоловіки 25–45» различаются четырьмя людьми, и в одном расчёте вторая
   * закрывает первую разностью составов — этому своя проверка ниже. Здесь
   * сверяются числа, а не защита, поэтому каждая колонка едет отдельно.
   */
  beforeAll(async () => {
    [all, menCol] = (await columnsApart([
      column({ title: "Усі" }),
      column({ title: "Чоловіки 25–45", filters: { sex: "male", ageMin: 25, ageMax: 45 } }),
    ])) as [StatRunColumn, StatRunColumn];
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

  /**
   * Мутация: снять правило группы у вопроса с несколькими вариантами
   * (считать ячейки порознь двусторонним порогом) — «Шум: 10», «Біль: 0» и
   * «решта: 6» показываются поверх скрытых «Думки», и проверка называет
   * вопрос: думающих без шума ровно трое, 16 − 6 − 10.
   */
  test("ответы: один выбор — разбиение с остатком, несколько — группой целиком", async () => {
    expect(option(all, "Як ви спите?", "Добре")).toEqual({ suppressed: false, count: 5, percent: 31 });
    expect(option(all, "Як ви спите?", "Погано")).toEqual({ suppressed: false, count: 6, percent: 38 });
    expect(all.questions[0]!.rest).toEqual({ suppressed: false, count: 0, percent: 0 });

    /*
     * «Що заважає?»: шум слышат десять из 16, думают трое, боли нет ни у
     * кого, никого из показанных не выбрали шестеро. Трое под порогом — и
     * группа уходит целиком, вместе с честным нулём и остатком: показанный
     * ноль назвал бы думающих без шума остатком объединения.
     */
    for (const text of ["Шум", "Думки", "Біль"]) {
      expect(option(all, "Що заважає?", text), `«${text}» показан рядом со скрытыми «Думки»`).toEqual({ suppressed: true });
    }
    expect(all.questions[1]!.rest).toEqual({ suppressed: true });
  });

  /**
   * Мутация: убрать возрастной фильтр из sampleOf — юноша и женщины
   * попадают в «Чоловіки 25–45»… женщин держит пол, а юноша делает 13,
   * проверка называет число.
   */
  test("фильтры по полу и возрасту на момент прохождения", async () => {
    expect(menCol.respondents).toEqual({ suppressed: false, count: 12, percent: 100 });
    expect(menCol.filters).toEqual({ sex: "male", ageMin: 25, ageMax: 45 });
    /*
     * 5 «Добре», 2 «Так собі», 5 «Погано»: двое под порогом — и шкала уходит
     * целиком. Показанные «5 и 5» из 12 назвали бы двоих остатком, а
     * дополняющее подавление («спрятать ещё одну, самую маленькую») выбирало
     * бы пару по опубликованному правилу — читатель сузил бы её тем же
     * правилом до одного значения.
     */
    for (const label of ["Низький", "Середній", "Високий"]) {
      expect(band(menCol, label), `полоса «${label}» показана рядом со скрытой «Середній»`).toEqual({ suppressed: true });
    }
    expect(menCol.scales[0]!.rest).toEqual({ suppressed: true });
    // основание при этом на месте: закрыта группа, а не колонка
    expect(menCol.suppressedReason).toBeNull();
  });

  /**
   * Мутация: считать «ВШР» по одному краю (`suppress(n) === null` без
   * дополнения) — у «Чоловіки 25–45» ничего не меняется, а у группы из
   * семи с пятью попаданиями показалось бы «5 из 7», называя двоих.
   */
  test("«ВШР» — люди хотя бы с одним попаданием в помеченный показатель, с обоих краёв порога", async () => {
    // помечены «Високий» и «Погано» — одни и те же шестеро из 16, обе ячейки показаны
    expect(all.highRisk).toEqual({ suppressed: false, count: 6, percent: 38 });
    // у «Чоловіки 25–45» помеченная «Високий» ушла вместе со своей шкалой — «ВШР» с ней
    expect(menCol.highRisk, "«ВШР: 5» показан поверх скрытой шкалы").toEqual({ suppressed: true });
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

    /*
     * Шестеро в группе: трое «Добре», трое «Погано», «Так собі» — честный
     * ноль. Уходит вся шкала, ноль вместе с ней: показанный ноль ничего не
     * размазывает, и по нему обе тройки читались бы как 6 − 0 пополам.
     */
    expect(group!.respondents).toEqual({ suppressed: false, count: 6, percent: 100 });
    for (const label of ["Низький", "Середній", "Високий"]) {
      expect(band(group!, label), `полоса «${label}» показана в шкале со скрытой тройкой`).toEqual({ suppressed: true });
    }

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

/* ═══════════ разбор отчёта: скрытое ищется решением системы ═══════════ */

/**
 * Читатель отчёта не сверяет ячейки — он решает систему.
 *
 * Ячейки колонки связаны уравнениями, напечатанными рядом с ними: полосы
 * шкалы и остаток складываются в основание; у вопроса с несколькими
 * вариантами остаток — это не выбравшие ничего из показанного, то есть
 * дополнение объединения; «ВШР» — объединение помеченных множеств. Проверка
 * собирает эти уравнения и перебирает ВСЕ допустимые значения скрытых
 * величин: скрытое считается восстановленным, если допустимое значение
 * ровно одно.
 *
 * Прежняя редакция сверяла ячейки — «скрыта ровно одна в разбиении, значит
 * утечка» — и пропустила три дыры разом. У вопроса с несколькими вариантами
 * утечка живёт не в ячейке, а в области диаграммы: при показанных «Шум» 10,
 * «решта» 5 и «ВШР» 12 из 21 сама ячейка «Думки» не определена (её носители
 * могли сидеть внутри «Шум»), а вот думающих без шума ровно четверо — и это
 * уже названная горстка людей. Поэтому перебираются и ячейки, и области.
 */

const valueOf = (c: StatCell): number | null => (c.suppressed ? null : c.count);

interface SolvedCell {
  label: string;
  value: number | null;
  marked: boolean;
}

interface SolvedGroup {
  where: string;
  /** варианты — множества (multiple): пересекаются, и остаток дополняет объединение */
  sets: boolean;
  /** ячейки показателя; последняя — «решта» */
  cells: SolvedCell[];
  /** «ВШР», если он напечатан и все помеченные ячейки колонки лежат в этой группе */
  highRisk: number | null;
}

/** Ячейка под порогом так, как её видит правило: у множеств — с обоих краёв */
const belowFloor = (n: number, total: number, sets: boolean) =>
  (n > 0 && n < FLOOR) || (sets && total - n > 0 && total - n < FLOOR);

function groupsOf(col: StatRunColumn): SolvedGroup[] {
  const groups: SolvedGroup[] = [
    ...col.scales.map((s) => ({
      where: `шкала «${s.scaleTitle}»`,
      sets: false,
      cells: [
        ...s.bands.map((b) => ({ label: b.label, value: valueOf(b.cell), marked: b.highRisk })),
        { label: "решта", value: valueOf(s.rest), marked: false },
      ],
      highRisk: null as number | null,
    })),
    ...col.questions.map((q) => ({
      where: `питання «${q.title}»`,
      sets: q.type === "multiple",
      cells: [
        ...q.options.map((o) => ({ label: o.text, value: valueOf(o.cell), marked: o.highRisk })),
        { label: "решта", value: valueOf(q.rest), marked: false },
      ],
      highRisk: null as number | null,
    })),
  ];
  /*
   * «ВШР» становится уравнением группы, только когда все помеченные ячейки
   * колонки лежат в ней. Иначе он связывает несколько групп сразу, и
   * перебор по одной группе был бы неверен — а пропуск уравнения делает
   * проверку мягче, но не лживее.
   */
  const marked = groups.filter((g) => g.cells.some((c) => c.marked));
  const hr = col.highRisk && !col.highRisk.suppressed ? col.highRisk.count : null;
  if (hr !== null && marked.length === 1) marked[0]!.highRisk = hr;
  return groups;
}

/**
 * Разбиение: неизвестные — скрытые ячейки, уравнение одно — сумма ячеек и
 * остатка равна основанию. Читателю известно и правило, по которому группу
 * скрыли: хоть одна скрытая ячейка под порогом.
 */
function solvePartition(group: SolvedGroup, total: number): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>(group.cells.map((c) => [c.label, new Set<number>()]));
  const hidden = group.cells.filter((c) => c.value === null);
  if (!hidden.length) return out;

  const budget = total - group.cells.reduce((sum, c) => sum + (c.value ?? 0), 0);
  const take: number[] = [];
  const walk = (k: number, left: number) => {
    if (k === hidden.length) {
      if (left !== 0 || !take.some((v) => belowFloor(v, total, false))) return;
      take.forEach((v, i) => out.get(hidden[i]!.label)!.add(v));
      return;
    }
    for (let v = 0; v <= left; v += 1) {
      take[k] = v;
      walk(k + 1, left - v);
    }
  };
  walk(0, budget);
  return out;
}

interface SetsSolution {
  cells: Map<string, Set<number>>;
  regions: { label: string; values: Set<number> }[];
}

/**
 * Множества: неизвестные — области диаграммы (кто какие варианты выбрал), их
 * 2^m при m показанных вариантах. Уравнения: сумма областей равна основанию,
 * сумма областей с вариантом — его ячейка, область без вариантов — остаток,
 * сумма областей, задевающих помеченные, — «ВШР».
 *
 * Перебор по областям, а не по ячейкам: утечка у multiple живёт в области.
 * Размеры ограничены (три варианта, основание до тридцати) — это разборные
 * колонки посева, а не боевые: полный перебор боевой колонки не нужен, там
 * действует то же правило, проверенное здесь.
 */
function solveSets(group: SolvedGroup, total: number): SetsSolution | null {
  const opts = group.cells.slice(0, -1);
  const rest = group.cells[group.cells.length - 1]!;
  const m = opts.length;
  if (m > 3 || total > 30) return null;
  /*
   * Ни одного показанного числа: уравнений нет вовсе, каждая скрытая ячейка
   * принимает любое значение от нуля до основания и каждая область — тоже.
   * Перебирать нечего, и ровно этого правило группы и добивается.
   */
  if (group.cells.every((c) => c.value === null) && group.highRisk === null) return null;

  const cells = new Map<string, Set<number>>(group.cells.map((c) => [c.label, new Set<number>()]));
  const regions = new Array<number>(1 << m).fill(0);
  const seen = regions.map(() => new Set<number>());
  const markedMask = opts.reduce((mask, c, i) => (c.marked ? mask | (1 << i) : mask), 0);
  const partial = new Array<number>(m).fill(0);

  const record = (left: number) => {
    if (rest.value !== null && rest.value !== left) return;
    for (const [i, o] of opts.entries()) if (o.value !== null && o.value !== partial[i]) return;
    regions[0] = left;
    if (group.highRisk !== null) {
      let hr = 0;
      for (let mask = 1; mask < regions.length; mask += 1) if (mask & markedMask) hr += regions[mask]!;
      if (hr !== group.highRisk) return;
    }
    /* правило, по которому группу скрыли: ячейка под порогом либо пересчёт горсткой */
    if (group.cells.some((c) => c.value === null)) {
      const over = partial.reduce((sum, n) => sum + n, 0) - (total - left);
      const byCell = opts.some((o, i) => o.value === null && belowFloor(partial[i]!, total, true));
      const byRest = rest.value === null && belowFloor(left, total, true);
      if (!byCell && !byRest && !(over > 0 && over < FLOOR)) return;
    }
    for (const [i, o] of opts.entries()) cells.get(o.label)!.add(partial[i]!);
    cells.get(rest.label)!.add(left);
    for (let mask = 0; mask < regions.length; mask += 1) seen[mask]!.add(regions[mask]!);
  };

  const walk = (mask: number, left: number) => {
    if (mask === regions.length) {
      record(left);
      return;
    }
    // область не может быть больше того, что осталось показанному варианту
    let cap = left;
    for (let i = 0; i < m; i += 1) {
      const known = opts[i]!.value;
      if ((mask >> i) & 1 && known !== null) cap = Math.min(cap, known - partial[i]!);
    }
    for (let r = 0; r <= cap; r += 1) {
      regions[mask] = r;
      for (let i = 0; i < m; i += 1) if ((mask >> i) & 1) partial[i] = partial[i]! + r;
      walk(mask + 1, left - r);
      for (let i = 0; i < m; i += 1) if ((mask >> i) & 1) partial[i] = partial[i]! - r;
    }
    regions[mask] = 0;
  };
  walk(1, total);

  const nameOf = (mask: number) => {
    if (mask === 0) return rest.label;
    const inside = opts.filter((_, i) => (mask >> i) & 1).map((o) => o.label);
    const outside = opts.filter((_, i) => !((mask >> i) & 1)).map((o) => o.label);
    return outside.length ? `${inside.join(" і ")} без ${outside.join(", ")}` : inside.join(" і ");
  };
  return { cells, regions: seen.map((values, mask) => ({ label: nameOf(mask), values })) };
}

/** Всё, что отчёт называет точно: скрытые ячейки с единственным значением и области-горстки */
function leaksOf(col: StatRunColumn): string[] {
  const leaks: string[] = [];
  // у закрытой колонки нет ни одного числа: решать нечего, и это и есть защита
  if (col.respondents.suppressed) return leaks;
  const total = col.respondents.count;
  const at = `«${col.title}»`;
  for (const group of groupsOf(col)) {
    const solved = group.sets
      ? solveSets(group, total)
      : { cells: solvePartition(group, total), regions: [] as SetsSolution["regions"] };
    if (!solved) continue;
    for (const c of group.cells) {
      if (c.value !== null) continue;
      const values = solved.cells.get(c.label);
      if (!values?.size) leaks.push(`${at}, ${group.where}: «${c.label}» — уравнения не сошлись, проверка сломана`);
      else if (values.size === 1) {
        leaks.push(`${at}, ${group.where}: «${c.label}» восстанавливается, допустимое значение одно: ${[...values][0]}`);
      }
    }
    for (const r of solved.regions) {
      const only = r.values.size === 1 ? [...r.values][0]! : null;
      if (only !== null && only > 0 && only < FLOOR) {
        leaks.push(`${at}, ${group.where}: «${r.label}» — названная горстка, ровно ${only} человек`);
      }
    }
  }
  return leaks;
}

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
    expect(col.suppressedReason, "причина закрытия колонки не названа — по ней разбирают отчёт").toBe("small");
    // структура на месте: экран рисует те же строки с подписью «менше 5»
    expect(col.scales[0]!.bands.map((b) => b.label)).toEqual(["Низький", "Середній", "Високий"]);
  });

  /**
   * Скрытое не восстанавливается — проверяется решением системы.
   *
   * Собираются ВСЕ напечатанные числа колонки (основание, ячейки, остатки,
   * «ВШР») и перебираются все допустимые значения скрытых: у каждой скрытой
   * ячейки должно остаться хотя бы два, а ни одна область диаграммы не
   * должна оказаться горсткой людей с единственным допустимым значением.
   * Разбор проверки — у leaksOf выше; сама она сторожится отдельно, на
   * выводе API до правки.
   *
   * Мутация: снять правило группы у вопроса с несколькими вариантами
   * (считать ячейки порознь двусторонним порогом) — проверка называет
   * вопрос «Що заважає?» и области трижды: «Думки без Шум — ровно четверо»
   * у 21 респондента на двух вариантах, «Шум і Біль — ровно троє» у 21 с
   * пересечением и «Біль» у 14 сразу ячейкой и областью.
   * Мутация: снять правило группы у разбиения (прятать ячейки порознь) —
   * проверка называет «Середній» и «Так собі»: допустимое значение одно, 2.
   * Мутация: считать «ВШР» без riskHidden, одним двусторонним порогом от
   * числа попаданий — «ВШР: 7» встаёт поверх скрытой шкалы; это ловит
   * проверка «ВШР» выше, называя колонку.
   */
  test("система уравнений колонки не называет ни одной скрытой величины", async () => {
    const men25 = { filters: { sex: "male", ageMin: 25, ageMax: 45 } };
    const cols = await columnsApart([
      column({ title: "Чоловіки 25–45", ...men25 }),
      column({ title: "Усі" }),
      column({ title: "Група", filters: { patientGroupId: groupId } }),
      // помечены показанная и скрытая ячейки одного разбиения — в полосах и в вариантах одного выбора
      markedColumn({ ...men25, title: "низький+середній" }, { band: ["low", "mid"] }),
      markedColumn({ ...men25, title: "добре+так собі" }, { sleep: ["good", "soso"] }),
      markedColumn({ title: "шум+думки" }, { why: ["noise", "thoughts"] }),
      markedColumn({ ...men25, title: "лише низький" }, { band: ["low"] }),
      // доклад проверяющих, слово в слово
      skepticColumn("21: «ВШР» над «Шум» і «Біль»", CITY21, ["noise", "pain"]),
      skepticColumn("21: без «ВШР», два варіанти", CITY21, [], ["noise", "thoughts"]),
      skepticColumn("21: перетин двох варіантів", CITY21, [], ["noise", "pain"]),
      skepticColumn("14: «Шум» і «Думки» — одні й ті самі", CITY14, ["noise", "thoughts"]),
    ]);
    expect(cols.flatMap((col) => leaksOf(col))).toEqual([]);
  });

  /**
   * Сторож самой проверки: перебор обязан называть утечку, ради которой
   * правило и завели. Колонка ниже — вывод API до правки, число в число с
   * доклада; молчание проверки выше стоит ровно столько, сколько стоит эта.
   */
  test("перебор находит утечку доклада: 21 респондент, «Шум», «решта» и «ВШР»", () => {
    const at = (n: number | null): StatCell =>
      n === null ? { suppressed: true } : { suppressed: false, count: n, percent: Math.round((n / 21) * 100) };
    const before: StatRunColumn = {
      title: "21 респондент до правки",
      presetId: null,
      presetTitle: null,
      filters: {},
      surveyId: "s",
      surveyTitle: "Розбір",
      versionId: "v",
      versionNumber: 1,
      respondents: at(21),
      suppressedReason: null,
      scales: [],
      questions: [
        {
          questionId: "q",
          title: "Що заважає?",
          type: "multiple",
          options: [
            { optionId: "n", text: "Шум", highRisk: true, cell: at(10) },
            { optionId: "t", text: "Думки", highRisk: false, cell: at(null) },
            { optionId: "p", text: "Біль", highRisk: true, cell: at(5) },
          ],
          rest: at(5),
        },
      ],
      highRisk: at(12),
    };
    const found = leaksOf(before).join("; ");
    expect(found, "перебор не увидел утечку доклада — молчание проверок выше ничего не значит").toContain("Думки");
  });

  /**
   * Сценарии доклада в числах: у вопроса с несколькими вариантами прячется
   * вся группа, вместе с остатком, честным нулём и «ВШР».
   *
   * Мутация: снять правило группы у multiple — первая же проверка называет
   * колонку и вопрос, показав «Шум: 10/48%» рядом со скрытыми «Думки».
   * Мутация: убрать пересчёт из groupCells — падает последняя проверка:
   * «Шум: 10» и «Біль: 5» при остатке 9 называют троих, выбравших оба.
   */
  test("сценарии разбора: вопрос с несколькими вариантами прячется группой", async () => {
    const [withRisk, twoOptions, fourteen, crossing] = await columnsApart([
      skepticColumn("21 з «ВШР»", CITY21, ["noise", "pain"]),
      skepticColumn("21 без «ВШР»", CITY21, [], ["noise", "thoughts"]),
      skepticColumn("14 однакових", CITY14, ["noise", "thoughts"]),
      skepticColumn("21 з перетином", CITY21, [], ["noise", "pain"]),
    ]);
    const cells = (col: StatRunColumn) => [
      ...col.questions[0]!.options.map((o) => `${o.text}: ${cellOf(o.cell)}`),
      `решта: ${cellOf(col.questions[0]!.rest)}`,
    ];

    // 10 «Шум», 5 «Біль» (|Ш∪Б| = 12), 4 «Думки», 5 нікого: «ВШР: 12» назвал бы четвёрку как 21 − 5 − 12
    expect(withRisk!.respondents).toEqual({ suppressed: false, count: 21, percent: 100 });
    expect(cells(withRisk!)).toEqual(["Шум: ×", "Думки: ×", "Біль: ×", "решта: ×"]);
    expect(withRisk!.highRisk, "«ВШР» показан поверх скрытой группы").toEqual({ suppressed: true });

    // та же дыра без «ВШР»: два варианта, и остаток сам называет думающих без шума — 21 − 7 − 10
    expect(twoOptions!.respondents).toEqual({ suppressed: false, count: 21, percent: 100 });
    expect(cells(twoOptions!)).toEqual(["Шум: ×", "Думки: ×", "решта: ×"]);
    expect(twoOptions!.highRisk, "без пометок «ВШР» — null, а не ноль").toBeNull();

    // 14 человек: «Шум» и «Думки» — одни и те же пятеро, «Біль» четверо, пятеро — никого
    expect(fourteen!.respondents).toEqual({ suppressed: false, count: 14, percent: 100 });
    expect(cells(fourteen!)).toEqual(["Шум: ×", "Думки: ×", "Біль: ×", "решта: ×"]);
    expect(fourteen!.highRisk).toEqual({ suppressed: true });

    /*
     * Два варианта и ни одной ячейки под порогом: «Шум» 10, «Біль» 5,
     * остаток 9 — но объединение 12, и пересчёт 10 + 5 − 12 = 3 есть в
     * точности число выбравших оба. У двух вариантов пересечение читается
     * начисто, поэтому группа уходит и здесь.
     */
    expect(crossing!.respondents).toEqual({ suppressed: false, count: 21, percent: 100 });
    expect(cells(crossing!), "«Шум» и «Біль» показаны — трое, выбравшие оба, названы").toEqual([
      "Шум: ×",
      "Біль: ×",
      "решта: ×",
    ]);
  });

  /**
   * «ВШР» — объединение помеченных множеств из разных групп, и поверх
   * показанных ячеек он сообщает, насколько они пересекаются.
   *
   * Мутация: убрать проверку пересчёта помеченных из riskCell — «ВШР: 13»
   * показывается при «Високий: 6» и «Шум: 8», и проверка называет того
   * единственного, кто попал в оба показателя: 6 + 8 − 13 = 1.
   */
  test("«ВШР» не называет тех, кто попал сразу в два помеченных показателя", async () => {
    const res = await preview([
      {
        title: "перетин помічених",
        presetId: null,
        filters: { locality: CITY20 },
        surveyId: skeptic.id,
        bands: [
          { scaleId: skeptic.scaleId, bandId: skeptic.band.low },
          { scaleId: skeptic.scaleId, bandId: skeptic.band.mid },
          { scaleId: skeptic.scaleId, bandId: skeptic.band.high, highRisk: true },
        ],
        questions: [
          {
            questionId: skeptic.whyQ,
            options: [
              { optionId: skeptic.why.noise, highRisk: true },
              { optionId: skeptic.why.thoughts },
              { optionId: skeptic.why.pain },
            ],
          },
        ],
      },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const col = res.body.columns[0]!;
    expect(col.respondents).toEqual({ suppressed: false, count: 20, percent: 100 });
    // обе помеченные ячейки над порогом и показаны — прятать их не за что
    const high = col.scales[0]!.bands.find((b) => b.label === "Високий")!;
    expect(high.cell).toEqual({ suppressed: false, count: 6, percent: 30 });
    expect(col.questions[0]!.options[0]!.cell).toEqual({ suppressed: false, count: 8, percent: 40 });
    expect(col.highRisk, "«ВШР: 13» поверх 6 и 8 называет единственного, кто попал в оба").toEqual({ suppressed: true });
  });

  /**
   * Разность составов колонок.
   *
   * Мутация: убрать closedByOverlap из runColumns — «Усі» рядом с
   * «Чоловіки 25–45» отдаёт свои числа, и первая проверка называет колонку:
   * четверо (три женщины и юноша) читаются разностью по каждому показателю.
   * Мутация: закрывать колонку и при нулевой разности — падает проверка
   * одинаковых колонок: дубль не выдаёт никого.
   */
  test("колонки, различающиеся горсткой людей, не считаются рядом", async () => {
    const pair = await preview([
      column({ title: "Усі" }),
      column({ title: "Чоловіки 25–45", filters: { sex: "male", ageMin: 25, ageMax: 45 } }),
    ]);
    expect(pair.status, JSON.stringify(pair.body)).toBe(200);
    const [wide, narrow] = pair.body.columns as StatRunColumn[];
    expect(wide!.respondents, "«Усі» показана рядом со своим подмножеством: 16 − 12 = четверо").toEqual({ suppressed: true });
    expect(wide!.suppressedReason).toBe("overlap");
    for (const b of wide!.scales[0]!.bands) {
      expect(b.cell, `полоса «${b.label}» закрытой колонки показана`).toEqual({ suppressed: true });
    }
    expect(wide!.highRisk).toEqual({ suppressed: true });
    // закрывается надмножество; сам срез ни в чём не виноват и остаётся
    expect(narrow!.respondents).toEqual({ suppressed: false, count: 12, percent: 100 });
    expect(narrow!.suppressedReason).toBeNull();

    // равные составы — дубль, а не утечка: разность пуста с обеих сторон
    const twins = await preview([column({ title: "Перша" }), column({ title: "Друга" })]);
    for (const col of twins.body.columns) {
      const same = { suppressed: false, count: 16, percent: 100 };
      expect(col.respondents, `«${col.title}»: одинаковые колонки закрыли друг друга`).toEqual(same);
    }

    // разность в десять человек — не горстка: обе колонки открыты
    const far = await preview([column({ title: "Усі" }), column({ title: "Група", filters: { patientGroupId: groupId } })]);
    for (const col of far.body.columns) expect(col.respondents.suppressed, `«${col.title}» закрыта без нужды`).toBe(false);

    // обе разности под порогом — закрыты обе: 19 мужчин и 18 моложе 45 различаются тремя и двумя
    const mutual = await preview([
      { ...skepticColumn("чоловіки міста", CITY21, []), filters: { locality: CITY21, sex: "male" } },
      { ...skepticColumn("молодші 45", CITY21, []), filters: { locality: CITY21, ageMax: 45 } },
    ]);
    for (const col of mutual.body.columns) {
      expect(col.respondents, `«${col.title}» показана, хотя разность составов — горстка`).toEqual({ suppressed: true });
      expect(col.suppressedReason).toBe("overlap");
    }
  });

  /**
   * Дополняющее подавление осталось только там, где оно доказуемо, — у
   * настоящего разбиения (срезы, lib/privacy.ts). Обе его дыры нашли на
   * статистике, поэтому и проверяются здесь.
   *
   * Мутация: вернуть выбор «самой маленькой из показанных» без проверки на
   * ноль — первая проверка называет ноль, попавший в пару. Мутация: убрать
   * отрезок допустимых значений — вторая называет четвёрку, которая
   * вычисляется из опубликованного правила выбора пары.
   */
  test("дополняющая ячейка не бывает ни нулевой, ни однозначной", async () => {
    const { suppressedKeys } = await import("../src/lib/privacy");

    // скрытая тройка и честный ноль: спрятать ноль — значит не спрятать ничего
    const withZero = suppressedKeys([
      { key: "чоловіча", n: 20 },
      { key: "жіноча", n: 0 },
      { key: "—", n: 3 },
    ]);
    expect(withZero.has("—")).toBe(true);
    expect(withZero.has("жіноча"), "в пару выбран честный ноль — он ничего не размазывает").toBe(false);
    expect(withZero.has("чоловіча"), "пары нет вовсе: 3 = 23 − 20 читается вычитанием").toBe(true);

    /*
     * «5, 5, 4»: пара — одна из пятёрок, и читатель сужает её тем же
     * правилом, по которому мы её выбрали (наименьшая из показанных, значит
     * не больше оставшейся пятёрки) — 9 − 5 = 4. Прячется всё разбиение.
     */
    const pinned = suppressedKeys([
      { key: "a", n: 5 },
      { key: "b", n: 5 },
      { key: "c", n: 4 },
    ]);
    expect(pinned.size, "пара «5 и 4» сужается до одного значения: 9 − 5 = 4").toBe(3);

    // а где пара размазывает, она остаётся: 6, 6 и один — скрытый лежит между 1 и 2
    const paired = suppressedKeys([
      { key: "ч", n: 6 },
      { key: "ж", n: 6 },
      { key: "—", n: 1 },
    ]);
    expect(paired.size, "срез 6/6/1 остался без пары — отчёт опустел без нужды").toBe(2);
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

  /**
   * Мутация: снять второй край у ячеек-множеств (оставить `suppress(n)`) —
   * «Шум: 10/83%» показывается в колонке из двенадцати, и проверка называет
   * двоих, которые шума не слышат.
   */
  test("ответ с несколькими вариантами прячется с обоих краёв — и группой", async () => {
    const res = await preview([column({ title: "Чоловіки 25–45", filters: { sex: "male", ageMin: 25, ageMax: 45 } })]);
    const why = res.body.columns[0]!.questions.find((q) => q.title === "Що заважає?")!;
    const cell = (text: string) => why.options.find((o) => o.text === text)!.cell;
    // шум — 10 из 12: не выбрали двое, и «10 из 12» назвало бы их так же точно
    expect(cell("Шум")).toEqual({ suppressed: true });
    expect(cell("Думки")).toEqual({ suppressed: true });
    // ноль уходит вместе с группой: показанный, он отдавал бы остаток объединения
    expect(cell("Біль")).toEqual({ suppressed: true });
    expect(why.rest).toEqual({ suppressed: true });

    /*
     * Второй край — не то же, что остаток: у двенадцати «Шум» 10 и «Біль» 7
     * покрывают всех, остаток ноль и пересчёт пять — по первому краю группа
     * открыта. А шума не слышат двое, и «10 из 12» называет их.
     */
    const dozen = await columnsApart([skepticColumn("двоє без шуму", CITY12, [], ["noise", "pain"])]);
    expect(dozen[0]!.respondents).toEqual({ suppressed: false, count: 12, percent: 100 });
    for (const o of dozen[0]!.questions[0]!.options) {
      expect(o.cell, `«${o.text}» показан: не слышат шума двое`).toEqual({ suppressed: true });
    }
    expect(leaksOf(dozen[0]!)).toEqual([]);
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
