import { beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  ERRORS,
  type ErrorKey,
  type StatCell,
  type StatRunColumn,
  type StatRunResult,
} from "@quizzy/shared";
import { pinnedAreas, type PinnedArea, type Reported } from "../src/lib/privacy";
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
  /** Вторая шкала — только ради потолка печатаемых чисел: с ней колонка перерастает шестнадцать */
  loadId: string;
  load: Record<"low" | "mid" | "high", string>;
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
      {
        code: "load",
        title: { uk: "Навантаження" },
        aggregation: "sum",
        bands: [
          { minScore: 0, maxScore: 0, label: { uk: "Немає" }, severity: "none" },
          { minScore: 1, maxScore: 1, label: { uk: "Помірне" }, severity: "mild" },
          { minScore: 2, maxScore: 9, label: { uk: "Сильне" }, severity: "severe" },
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
        scaleCode: "load",
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
  const load = full.scales[1];
  const byLabel = (labels: string[]) => labels.map((l) => scale.bands.find((b: { label: string }) => b.label === l).id);
  const loadBy = (labels: string[]) => labels.map((l) => load.bands.find((b: { label: string }) => b.label === l).id);
  const [low, mid, high] = byLabel(["Низький", "Середній", "Високий"]);
  const [none, some, much] = loadBy(["Немає", "Помірне", "Сильне"]);
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
    loadId: load.id,
    load: { low: none, mid: some, high: much },
    sleepQ: sleepQ.id,
    sleep: { good: opt(sleepQ, "Добре"), soso: opt(sleepQ, "Так собі"), bad: opt(sleepQ, "Погано") },
    whyQ: whyQ.id,
    why: { noise: opt(whyQ, "Шум"), thoughts: opt(whyQ, "Думки"), pain: opt(whyQ, "Біль") },
    textQ: q("Коментар").id,
  };
}

/** Восемь вариантов одного выбора: на них показались обе утечки второго круга */
interface Wide {
  id: string;
  pickQ: string;
  /** идентификаторы «А»…«З» по порядку */
  pick: string[];
  whyQ: string;
  why: Record<"noise" | "thoughts" | "pain", string>;
}

const PICKS = ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З"];

/**
 * Методика второго круга: вопрос с ОДНИМ выбором на восемь вариантов и
 * вопрос с несколькими на три.
 *
 * Восемь, а не три: обе утечки второго круга живут в том, что разбиение
 * длинное. «Вынужденные значения» требуют пяти прочерков в одном разбиении
 * (пять слагаемых, каждое ≥ 1, сумма 5), а «почти полный отчёт» — чтобы
 * рядом со скрытой ячейкой печаталось двенадцать чисел из тринадцати.
 * На трёх вариантах ни то ни другое не собирается: класс под прочерками
 * выходит меньше порога и его находит даже прежняя проверка.
 */
async function makeWide(groupId: string, owner: Person): Promise<Wide> {
  const id = crypto.randomUUID();
  const draft = createSurveySchema.parse({
    title: { uk: "Методика восьми варіантів" },
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
        bands: [{ minScore: 0, maxScore: 9, label: { uk: "Рівний" }, severity: "none" }],
      },
    ],
    questions: [
      {
        type: "single",
        title: { uk: "Що турбує найбільше?" },
        scaleCode: "risk",
        required: true,
        options: PICKS.map((text) => ({ text: { uk: text }, score: 0 })),
      },
      {
        type: "multiple",
        title: { uk: "Що заважає?" },
        scaleCode: "risk",
        options: [
          { text: { uk: "Шум" }, score: 0 },
          { text: { uk: "Думки" }, score: 0 },
          { text: { uk: "Біль" }, score: 0 },
        ],
      },
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
  const q = (title: string) => full.questions.find((x: { title: string }) => x.title === title);
  const opt = (question: { options: { id: string; text: string }[] }, text: string) =>
    question.options.find((o) => o.text === text)!.id;
  const pickQ = q("Що турбує найбільше?");
  const whyQ = q("Що заважає?");
  return {
    id,
    pickQ: pickQ.id,
    pick: PICKS.map((t) => opt(pickQ, t)),
    whyQ: whyQ.id,
    why: { noise: opt(whyQ, "Шум"), thoughts: opt(whyQ, "Думки"), pain: opt(whyQ, "Біль") },
  };
}

/** Прохождение методики восьми вариантов: один выбор по номеру, галочки — по ключам */
async function submitWide(person: Person, pick: number, why: (keyof Wide["why"])[] = []): Promise<void> {
  const answers = [
    { questionId: wide.pickQ, optionIds: [wide.pick[pick]!], durationMs: 1000, changeCount: 0, visitCount: 1 },
    ...(why.length
      ? [{ questionId: wide.whyQ, optionIds: why.map((k) => wide.why[k]), durationMs: 1000, changeCount: 0, visitCount: 1 }]
      : []),
  ];
  const res = await api(`/api/surveys/${wide.id}/responses`, person.token, {
    method: "POST",
    body: JSON.stringify({ startedAt: new Date(Date.now() - 60_000).toISOString(), durationMs: 60_000, events: [], answers }),
  });
  expect(res.status, `сдача прохождения: ${JSON.stringify(res.body)}`).toBe(201);
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
/**
 * Методика третьей колонки: в ней живут ТОЛЬКО два непересекающихся города,
 * поэтому колонка без фильтров — в точности их объединение. Это и есть
 * посевная «Київ проти Львова» с добавленной колонкой «Усі»: разбиение
 * выборки надвое стоит в собственном посеве автора (src/seed/statModels.ts),
 * и достаточно поставить рядом колонку без фильтра.
 */
let split: Content;
/**
 * Методика вложенных колонок: в ней живут ТОЛЬКО три возрастные группы, и
 * колонки «до 40» и «до 30» вкладываются одна в другую. Своя, потому что
 * возрастные фильтры не сужаются по городу — они выбирают всех, кто сдал
 * методику.
 */
let nested: Content;
/** Методика восьми вариантов: обе утечки второго круга */
let wide: Wide;
/** Населённые пункты сценариев: колонка набирается фильтром по городу */
const CITY21 = "Скепсис-21";
const CITY14 = "Скепсис-14";
const CITY20 = "Скепсис-20";
const CITY12 = "Скепсис-12";
const CITY16 = "Скепсис-16";
const BIG = "Скепсис-Велике";
const SMALL = "Скепсис-Мале";
const FORCED = "Скепсис-Вимушені";
const LOOSE = "Скепсис-Невимушені";
const PAIR = "Скепсис-Пара";
const SLICE = "Скепсис-Зріз";

/** Все семь непустых масок «Що заважає?» — по ним размазываются классы Венна */
const MASKS: (keyof Wide["why"])[][] = [
  ["noise"],
  ["thoughts"],
  ["pain"],
  ["noise", "thoughts"],
  ["noise", "pain"],
  ["thoughts", "pain"],
  ["noise", "thoughts", "pain"],
];

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
  for (let i = 0; i < 16; i++) {
    const p = await person(`s16-${i}`, { sex: "male", birthDate: "1990-01-01", locality: CITY16 });
    /*
     * Второй сценарий доклада, число в число: «Шум» 10, «Біль» 6, «решта» 5.
     * Все проверки прежнего правила проходили, группа печаталась целиком —
     * и |Біль ∖ Шум| = 6 − 5 читалось как один названный человек.
     */
    const why = [...(i < 10 ? [skeptic.why.noise] : []), ...(i >= 5 && i < 11 ? [skeptic.why.pain] : [])];
    await submit(skeptic, p, { sleep: skeptic.sleep.good, why });
  }

  /*
   * Первый сценарий доклада: «Усі» = «Велике» ⊎ «Мале». Двадцать в большом
   * городе (Добре 5, Так собі 5, Погано 10) и шестеро в малом (Добре 5,
   * Погано 1) — все шесть попарных разностей велики или пусты, а скрытая
   * ячейка малой колонки читается вычитанием двух показанных соседок.
   */
  split = await makeSurvey(groupA, adminA);
  for (let i = 0; i < 20; i++) {
    const p = await person(`big-${i}`, { sex: "male", birthDate: "1990-01-01", locality: BIG });
    await submit(split, p, { sleep: i < 5 ? split.sleep.good : i < 10 ? split.sleep.soso : split.sleep.bad });
  }
  for (let i = 0; i < 6; i++) {
    const p = await person(`small-${i}`, { sex: "male", birthDate: "1990-01-01", locality: SMALL });
    await submit(split, p, { sleep: i < 5 ? split.sleep.good : split.sleep.bad });
  }

  /*
   * Первый сценарий второго круга: три колонки, из которых две вложены
   * одна в другую. Восемь двадцатипятилетних и восемь шестидесятилетних
   * разложены по ВСЕМ восьми маскам Венна — это приманки, шестнадцать
   * областей по одному человеку, — а четверо тридцатипятилетних выбирают
   * всё сразу и образуют единственный класс разности «до 40» ∖ «до 30».
   */
  nested = await makeSurvey(groupA, adminA);
  const byMask = (i: number) => (MASKS[i - 1] ?? []).map((k) => nested.why[k]);
  for (let i = 0; i < 8; i++) {
    const p = await person(`n25-${i}`, { sex: "male", birthDate: "2001-06-01", locality: "Вкладене" });
    await submit(nested, p, { sleep: nested.sleep.good, why: byMask(i) });
  }
  for (let i = 0; i < 4; i++) {
    const p = await person(`n35-${i}`, { sex: "male", birthDate: "1991-06-01", locality: "Вкладене" });
    await submit(nested, p, { sleep: nested.sleep.good, why: MASKS[6]!.map((k) => nested.why[k]) });
  }
  for (let i = 0; i < 8; i++) {
    const p = await person(`n60-${i}`, { sex: "male", birthDate: "1966-06-01", locality: "Вкладене" });
    await submit(nested, p, { sleep: nested.sleep.good, why: byMask(i) });
  }

  wide = await makeWide(groupA, adminA);
  /*
   * Второй сценарий: «А» 15 из 20, по одному на «Б»…«Е», «Ж» и «З» пусты.
   * Пять прочерков в одном разбиении, их сумма 5 — каждый равен единице.
   */
  for (let i = 0; i < 20; i++) {
    const p = await person(`w-forced-${i}`, { sex: "male", birthDate: "1990-01-01", locality: FORCED });
    await submitWide(p, i < 15 ? 0 : i - 14);
  }
  /*
   * Тот же разбор, но сумма прочерков на единицу больше их числа: «А» 14,
   * «Б» 2, «В»…«Е» по одному. Скрытых столько же и стоят они на тех же
   * местах, а набор их не фиксирует — и отчёт обязан остаться полнее.
   */
  for (let i = 0; i < 20; i++) {
    const p = await person(`w-loose-${i}`, { sex: "male", birthDate: "1990-01-01", locality: LOOSE });
    await submitWide(p, i < 14 ? 0 : i < 16 ? 1 : i - 14);
  }
  /*
   * Верхний край прочерка: 5/5/4/4 на восемнадцати. Порог прячет обе
   * четвёрки, их сумма 8, и если каждая меньше пяти — обе равны четырём.
   */
  for (let i = 0; i < 18; i++) {
    const p = await person(`w-pair-${i}`, { sex: "male", birthDate: "1990-01-01", locality: PAIR });
    await submitWide(p, i < 5 ? 0 : i < 10 ? 1 : i < 14 ? 2 : 3);
  }
  /*
   * Третий сценарий: почти полный отчёт. «А», «Б», «В» по семеро — каждый
   * размазан по всем семи непустым маскам Венна, то есть двадцать один
   * класс по ОДНОМУ человеку; четверо «Г» сидят всего в двух классах по
   * два. Прежняя проверка брала в перебор шестнадцать самых мелких
   * областей, одиночки занимали весь срез, и «Г» не проверялась вовсе.
   */
  for (let i = 0; i < 21; i++) {
    const p = await person(`w-slice-${i}`, { sex: "male", birthDate: "1990-01-01", locality: SLICE });
    await submitWide(p, Math.floor(i / 7), MASKS[i % 7]!);
  }
  for (let i = 0; i < 4; i++) {
    const p = await person(`w-slice-g${i}`, { sex: "male", birthDate: "1990-01-01", locality: SLICE });
    await submitWide(p, 3, [i < 2 ? "noise" : "thoughts"]);
  }
  /*
   * Двести с лишним прохождений через API не укладываются в пять секунд по
   * умолчанию, когда отправка ещё и переключает роль под автоматику (asSystem)
   * и сюита идёт целиком. Потолок поднят, а не посев урезан: каждое
   * прохождение здесь — чей-то сценарий разбора, и убрать его значит снять
   * проверку утечки.
   */
}, 120_000);

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
 * Колонки одного ответа проверяются вместе (своя проверка ниже), и
 * посчитанные рядом они прячут числа друг за друга. Здесь проверяется
 * другое: колонка не должна называть человека САМА ПО СЕБЕ, даже когда
 * рядом нет ни одной соседней.
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
   * «Чоловіки 25–45» различаются четырьмя людьми, и в одном расчёте одна
   * из них закрывается — этому своя проверка ниже. Здесь сверяются числа, а
   * не защита, поэтому каждая колонка едет отдельно.
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
   * Мутация: снять и порог из draft, и проверку из keepSafe — «Думки: 3»
   * печатается, и трое названы прямо. Порога одного для этого мало:
   * проверка прячет тройку и без него, просто на несколько шагов позже.
   */
  test("ответы: один выбор — разбиение с остатком, несколько — областями Венна", async () => {
    expect(option(all, "Як ви спите?", "Добре")).toEqual({ suppressed: false, count: 5, percent: 31 });
    expect(option(all, "Як ви спите?", "Погано")).toEqual({ suppressed: false, count: 6, percent: 38 });
    expect(all.questions[0]!.rest).toEqual({ suppressed: false, count: 0, percent: 0 });

    /*
     * «Що заважає?»: шум слышат десять из 16, думают трое, боли нет ни у
     * кого, никого из показанных не выбрали шестеро. Скрыты «Думки» — и
     * только они: соседние числа их не называют. Область «думають без
     * шуму» при этом равна нулю (все думающие слышат шум), а ноль никого
     * не выдаёт — прежнее правило прятало здесь всю группу зря.
     */
    expect(option(all, "Що заважає?", "Шум")).toEqual({ suppressed: false, count: 10, percent: 63 });
    expect(option(all, "Що заважає?", "Думки"), "трое напечатаны").toEqual({ suppressed: true });
    expect(option(all, "Що заважає?", "Біль")).toEqual({ suppressed: false, count: 0, percent: 0 });
    expect(all.questions[1]!.rest).toEqual({ suppressed: false, count: 6, percent: 38 });
    expect(named([all], baseSeed()), "показанного хватает, чтобы назвать троих").toEqual([]);
  });

  /**
   * Мутация: убрать возрастной фильтр из sampleOf — юноша и женщины
   * попадают в «Чоловіки 25–45»… женщин держит пол, а юноша делает 13,
   * проверка называет число. Мутация: снять проверку из keepSafe —
   * «Низький: 5» печатается рядом со скрытой двойкой, и та названа
   * вычитанием, 12 − 5 − 5.
   */
  test("фильтры по полу и возрасту на момент прохождения", async () => {
    expect(menCol.respondents).toEqual({ suppressed: false, count: 12, percent: 100 });
    expect(menCol.filters).toEqual({ sex: "male", ageMin: 25, ageMax: 45 });
    /*
     * 5 «Добре», 2 «Так собі», 5 «Погано». Двое под порогом — и прячется не
     * только они: печатать «Низький: 5» рядом означало бы назвать двоих
     * вычитанием, 12 − 5 − 5. Остаются «Високий: 5» и честный ноль
     * остатка, а «Низький» с «Середній» уходят парой: 7 на двоих, и ни одно
     * из двух чисел система не называет.
     */
    expect(band(menCol, "Низький"), "«5» рядом со скрытой двойкой").toEqual({ suppressed: true });
    expect(band(menCol, "Середній")).toEqual({ suppressed: true });
    expect(band(menCol, "Високий")).toEqual({ suppressed: false, count: 5, percent: 42 });
    expect(menCol.scales[0]!.rest).toEqual({ suppressed: false, count: 0, percent: 0 });
    // второй край порога: шум слышат десять из двенадцати, и «10 з 12» назвало бы двоих
    expect(option(menCol, "Що заважає?", "Шум"), "«Шум: 10 з 12» называет двоих").toEqual({ suppressed: true });
    // основание при этом на месте: закрыта не колонка, а отдельные показатели
    expect(menCol.suppressedReason).toBeNull();
    expect(named([menCol], baseSeed())).toEqual([]);
  });

  /**
   * Мутация: считать «ВШР» по одному краю (`suppress(n) === null` без
   * дополнения) — у «Чоловіки 25–45» ничего не меняется, а у группы из
   * семи с пятью попаданиями показалось бы «5 из 7», называя двоих.
   */
  test("«ВШР» — люди хотя бы с одним попаданием в помеченный показатель, с обоих краёв порога", async () => {
    // помечены «Високий» и «Погано» — одни и те же шестеро из 16, обе ячейки показаны
    expect(all.highRisk).toEqual({ suppressed: false, count: 6, percent: 38 });
    // у «Чоловіки 25–45» помеченные «Високий» и «Погано» — одни и те же пятеро, и «ВШР» их же
    expect(menCol.highRisk).toEqual({ suppressed: false, count: 5, percent: 42 });
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
     * ноль. Обе тройки под порогом и уходят; ноль остаётся — он никого не
     * называет, а по нему обе тройки читаются только вместе: 6 на двоих.
     */
    expect(group!.respondents).toEqual({ suppressed: false, count: 6, percent: 100 });
    expect(band(group!, "Низький")).toEqual({ suppressed: true });
    expect(band(group!, "Високий")).toEqual({ suppressed: true });
    expect(band(group!, "Середній"), "честный ноль спрятан без нужды").toEqual({ suppressed: false, count: 0, percent: 0 });

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
 * Проверка здесь — ТОТ ЖЕ решатель, что стоит на сервере (pinnedAreas из
 * src/lib/privacy.ts), и в этом вся её ценность: если сервер что-то
 * пропустит, тест пропустит ровно то же. Поэтому тест даёт решателю
 * БОЛЬШЕ, чем сервер: сервер режет ответ на системы по показателям, а тест
 * подаёт все показанные числа ответа одной системой — области в ней самые
 * мелкие, и восстановимость видна там, где разрезанные системы её теряют.
 *
 * Состав каждого числа тест берёт не из ответа (в ответе чисел и нет, там
 * подавление), а из посева: он и так знает, кто в каком городе, в какой
 * полосе и что выбрал. Сходится ли это с тем, что посчитал сервер,
 * проверяют числовые проверки выше.
 *
 * Прежняя редакция перебирала значения скрытых ячеек своим кодом и
 * пропустила обе утечки, найденные проверяющими: и ту, что собирается из
 * трёх колонок одного ответа, и |Біль ∖ Шум| = 1 внутри показанной группы.
 * Свой перебор в тесте — вторая реализация той же мысли, и ошибается она
 * не там же, где первая, а где придётся.
 */

/** Житель посева глазами отчёта: в каких он колонках и куда в них попадает */
interface Dweller {
  id: string;
  /** Заголовки колонок, в выборку которых он попал */
  columns: string[];
  band: string;
  sleep: string;
  why: string[];
}

/**
 * Все показанные числа ответа одной системой — и области, которые она
 * называет точно.
 */
function namedAreas(cols: StatRunColumn[], people: Dweller[]): PinnedArea[] {
  const system: Reported[] = [];
  const add = (key: string, cell: StatCell, members: Dweller[]) => {
    system.push({ key, members: new Set(members.map((p) => p.id)), shown: !cell.suppressed });
  };
  for (const col of cols) {
    /* закрытая колонка не печатает ничего, и её прочерк не значит «хотя бы один» */
    if (col.suppressedReason) continue;
    const at = `«${col.title}»`;
    const inside = people.filter((p) => p.columns.includes(col.title!));
    add(`${at} основа`, col.respondents, inside);
    const marks: ((p: Dweller) => boolean)[] = [];
    for (const s of col.scales) {
      const labels = s.bands.map((b) => b.label);
      for (const b of s.bands) {
        add(`${at} ${b.label}`, b.cell, inside.filter((p) => p.band === b.label));
        if (b.highRisk) marks.push((p) => p.band === b.label);
      }
      add(`${at} решта «${s.scaleTitle}»`, s.rest, inside.filter((p) => !labels.includes(p.band)));
    }
    for (const q of col.questions) {
      const hit = (o: string) => (p: Dweller) => (q.type === "multiple" ? p.why.includes(o) : p.sleep === o);
      const texts = q.options.map((o) => o.text);
      for (const o of q.options) {
        add(`${at} ${q.title}: ${o.text}`, o.cell, inside.filter(hit(o.text)));
        if (o.highRisk) marks.push(hit(o.text));
      }
      add(`${at} ${q.title}: решта`, q.rest, inside.filter((p) => !texts.some((t) => hit(t)(p))));
    }
    if (col.highRisk) add(`${at} ВШР`, col.highRisk, inside.filter((p) => marks.some((m) => m(p))));
  }
  return pinnedAreas(system);
}

/** Названные области — строками, чтобы падение теста сразу говорило, кого назвали */
const named = (cols: StatRunColumn[], people: Dweller[]): string[] =>
  namedAreas(cols, people).map((a) => `${a.n} чол.: ${a.inside.join(" ∧ ")}`);

/** Житель: полоса и ответ про сон идут парой — полосы посева ровно по ответу */
function dweller(id: string, columns: string[], sleep: "good" | "soso" | "bad", why: string[] = []): Dweller {
  const band = sleep === "good" ? "Низький" : sleep === "soso" ? "Середній" : "Високий";
  const label = sleep === "good" ? "Добре" : sleep === "soso" ? "Так собі" : "Погано";
  return { id, columns, band, sleep: label, why };
}

/**
 * Посев основной методики глазами отчёта: двенадцать мужчин, три женщины и
 * юноша, с теми же полосами и вариантами, что засеяны выше.
 */
function baseSeed(): Dweller[] {
  const out: Dweller[] = [];
  for (let i = 0; i < 12; i++) {
    const columns = ["Усі", "Чоловіки 25–45", "місто", "Перша", "Друга"];
    if ([0, 1, 2, 7, 8, 9].includes(i)) columns.push("Група", "група");
    if ([0, 1, 7, 8, 9, 10, 11].includes(i)) columns.push("ВШР-група");
    const why = [...(i < 10 ? ["Шум"] : []), ...(i < 3 ? ["Думки"] : [])];
    out.push(dweller(`m${i}`, columns, i < 5 ? "good" : i < 7 ? "soso" : "bad", why));
  }
  for (let i = 0; i < 3; i++) out.push(dweller(`f${i}`, ["Усі", "Перша", "Друга"], "soso"));
  out.push(dweller("y", ["Усі", "місто", "Перша", "Друга"], "bad"));
  return out;
}

/** Жители города доклада: «Шум» у десяти, «Біль» у шести, пятеро — ни того ни другого */
const seed16 = (columns: string[]): Dweller[] =>
  Array.from({ length: 16 }, (_, i) =>
    dweller(`c16-${i}`, columns, "good", [...(i < 10 ? ["Шум"] : []), ...(i >= 5 && i < 11 ? ["Біль"] : [])]));

/** Двадцать один: «Шум» №0–9, «Біль» №7–11, «Думки» №12–15, пятеро — никого */
const seed21 = (columns: string[]): Dweller[] =>
  Array.from({ length: 21 }, (_, i) =>
    dweller(`c21-${i}`, columns, "good", [
      ...(i < 10 ? ["Шум"] : []),
      ...(i >= 12 && i < 16 ? ["Думки"] : []),
      ...(i >= 7 && i < 12 ? ["Біль"] : []),
    ]));

/** Четырнадцать: «Шум» и «Думки» — одни и те же пятеро, «Біль» — четверо */
const seed14 = (columns: string[]): Dweller[] =>
  Array.from({ length: 14 }, (_, i) => dweller(`c14-${i}`, columns, "good", i < 5 ? ["Шум", "Думки"] : i < 9 ? ["Біль"] : []));

/** Двенадцать: «Шум» у десяти, «Біль» у семерых — шума не слышат двое */
const seed12 = (columns: string[]): Dweller[] =>
  Array.from({ length: 12 }, (_, i) =>
    dweller(`c12-${i}`, columns, "good", [...(i < 10 ? ["Шум"] : []), ...(i >= 5 ? ["Біль"] : [])]));

/** Двадцать: шестеро спят плохо, «Шум» у семерых спящих хорошо и одного из шести */
const seed20 = (columns: string[]): Dweller[] =>
  Array.from({ length: 20 }, (_, i) => dweller(`c20-${i}`, columns, i < 14 ? "good" : "bad", i < 7 || i === 14 ? ["Шум"] : []));

/** Двадцать шесть методики разбиения: «Усі» — в точности «Велике» ⊎ «Мале» */
function splitSeed(): Dweller[] {
  const out: Dweller[] = [];
  for (let i = 0; i < 20; i++) out.push(dweller(`big-${i}`, ["Усі", "Велике"], i < 5 ? "good" : i < 10 ? "soso" : "bad"));
  for (let i = 0; i < 6; i++) out.push(dweller(`small-${i}`, ["Усі", "Мале"], i < 5 ? "good" : "bad"));
  return out;
}

/** Тексты галочек «Що заважає?» — посев знает людей по тем же словам, что печатает отчёт */
const MASK_TEXT: Record<keyof Wide["why"], string> = { noise: "Шум", thoughts: "Думки", pain: "Біль" };
const textsOf = (keys: (keyof Wide["why"])[]) => keys.map((k) => MASK_TEXT[k]);

/** Колонка методики вложенных колонок: показатели только у той, что без фильтра */
function nestedColumn(title: string, filters: object, why = false) {
  return {
    title,
    presetId: null,
    filters,
    surveyId: nested.id,
    bands: [],
    questions: why
      ? [
          {
            questionId: nested.whyQ,
            options: [nested.why.noise, nested.why.thoughts, nested.why.pain].map((optionId) => ({ optionId })),
          },
        ]
      : [],
  };
}

/** Колонка методики восьми вариантов: все восемь, помеченные — по номерам */
function wideColumn(title: string, locality: string, marks: number[] = [], why = false) {
  return {
    title,
    presetId: null,
    filters: { locality },
    surveyId: wide.id,
    bands: [],
    questions: [
      { questionId: wide.pickQ, options: wide.pick.map((optionId, i) => ({ optionId, highRisk: marks.includes(i) })) },
      ...(why
        ? [
            {
              questionId: wide.whyQ,
              options: [wide.why.noise, wide.why.thoughts, wide.why.pain].map((optionId) => ({ optionId })),
            },
          ]
        : []),
    ],
  };
}

/** Жители методики вложенных колонок: восемь масок дважды и четверо, выбравших всё */
function nestedSeed(): Dweller[] {
  const at = (id: string, columns: string[], why: string[]): Dweller => ({ id, columns, band: "Низький", sleep: "Добре", why });
  const mask = (i: number) => textsOf(MASKS[i - 1] ?? []);
  const out: Dweller[] = [];
  for (let i = 0; i < 8; i++) out.push(at(`n25-${i}`, ["Усі", "до 40", "до 30"], mask(i)));
  for (let i = 0; i < 4; i++) out.push(at(`n35-${i}`, ["Усі", "до 40"], textsOf(MASKS[6]!)));
  for (let i = 0; i < 8; i++) out.push(at(`n60-${i}`, ["Усі"], mask(i)));
  return out;
}

/** Двадцать «вынужденных»: «А» пятнадцать, по одному на «Б»…«Е» */
const forcedSeed = (): Dweller[] =>
  Array.from({ length: 20 }, (_, i) => ({
    id: `w-forced-${i}`,
    columns: ["Вимушені"],
    band: "Рівний",
    sleep: PICKS[i < 15 ? 0 : i - 14]!,
    why: [],
  }));

/** Двадцать «невынужденных»: «А» четырнадцать, «Б» двое, «В»…«Е» по одному */
const looseSeed = (): Dweller[] =>
  Array.from({ length: 20 }, (_, i) => ({
    id: `w-loose-${i}`,
    columns: ["Невимушені"],
    band: "Рівний",
    sleep: PICKS[i < 14 ? 0 : i < 16 ? 1 : i - 14]!,
    why: [],
  }));

/** Восемнадцать «пары»: «А» и «Б» по пятеро, «В» и «Г» по четверо */
const pairSeed = (): Dweller[] =>
  Array.from({ length: 18 }, (_, i) => ({
    id: `w-pair-${i}`,
    columns: ["Пара"],
    band: "Рівний",
    sleep: PICKS[i < 5 ? 0 : i < 10 ? 1 : i < 14 ? 2 : 3]!,
    why: [],
  }));

/** Двадцать пять «почти полного отчёта»: 7/7/7 по всем маскам Венна и четверо «Г» */
function sliceSeed(): Dweller[] {
  const out: Dweller[] = [];
  for (let i = 0; i < 21; i++) {
    out.push({
      id: `w-slice-${i}`,
      columns: ["Зріз"],
      band: "Рівний",
      sleep: PICKS[Math.floor(i / 7)]!,
      why: textsOf(MASKS[i % 7]!),
    });
  }
  for (let i = 0; i < 4; i++) {
    out.push({ id: `w-slice-g${i}`, columns: ["Зріз"], band: "Рівний", sleep: PICKS[3]!, why: [i < 2 ? "Шум" : "Думки"] });
  }
  return out;
}

/**
 * Арифметика читателя без всякого решателя: разбиение одного выбора плюс
 * основание.
 *
 * Скрытых ячеек k, их сумма S = основание − показанные, и каждая не меньше
 * единицы, потому что нули печатаются. При k = 1 скрытая равна S, при
 * S = k каждая равна единице — в обоих случаях названы конкретные люди.
 * Проверка нарочно написана руками, а не через pinnedAreas: сторож, который
 * ошибается там же, где сторожимое, не сторож.
 */
function forcedByPartition(col: StatRunColumn): string[] {
  const out: string[] = [];
  if (col.respondents.suppressed) return out;
  const total = col.respondents.count;
  for (const q of col.questions) {
    if (q.type === "multiple") continue;
    const cells = [...q.options.map((o) => o.cell), q.rest];
    const hidden = cells.filter((c) => c.suppressed).length;
    if (!hidden) continue;
    const left = total - cells.reduce((n, c) => n + (c.suppressed ? 0 : c.count), 0);
    if (hidden === 1) out.push(`«${q.title}»: единственная скрытая = ${left}`);
    else if (left === hidden) out.push(`«${q.title}»: ${hidden} скрытых, и каждая равна единице`);
    else if (left === hidden * (FLOOR - 1)) out.push(`«${q.title}»: ${hidden} скрытых, и каждая равна ${FLOOR - 1}`);
  }
  return out;
}

/** Колонка методики разбиения: полосы шкалы, «Високий» помечен «ВШР» */
function splitColumn(title: string, locality?: string) {
  return {
    title,
    presetId: null,
    filters: locality ? { locality } : {},
    surveyId: split.id,
    bands: [
      { scaleId: split.scaleId, bandId: split.band.low },
      { scaleId: split.scaleId, bandId: split.band.mid },
      { scaleId: split.scaleId, bandId: split.band.high, highRisk: true },
    ],
    questions: [],
  };
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
   * Мутация: отдать колонке под порогом основание и нули вместо подавления
   * (не заводить причину «small») — «жінки» показывает 3, и проверка
   * называет число и полосу «Середній: 3».
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
    // цена подавления названа словами, а не прочерками: экран обязан её показать
    expect(col.note, "колонка молча пуста").toContain("Замало респондентів");
    // структура на месте: экран рисует те же строки с подписью «менше 5»
    expect(col.scales[0]!.bands.map((b) => b.label)).toEqual(["Низький", "Середній", "Високий"]);
  });

  /**
   * Сторож самой проверки: решатель обязан называть обе утечки доклада.
   *
   * Числа ниже — вывод API ДО правки, слово в слово из разбора: три
   * колонки одного ответа с «Усі» = «Велике» ⊎ «Мале» и показанная группа
   * множественного выбора на шестнадцати. Молчание проверок ниже стоит
   * ровно столько, сколько стоит эта.
   */
  test("решатель называет обе утечки доклада", () => {
    /* (1) три колонки: «Мале».«Високий» = 11 − 10 = 1 */
    const big = Array.from({ length: 20 }, (_, i) => `b${i}`);
    const small = Array.from({ length: 6 }, (_, i) => `s${i}`);
    const bandOf = (id: string, i: number) =>
      id.startsWith("b") ? (i < 5 ? "Низький" : i < 10 ? "Середній" : "Високий") : i < 5 ? "Низький" : "Високий";
    const all = [...big, ...small];
    const pick = (ids: string[], label: string) =>
      new Set(ids.filter((id) => bandOf(id, Number(id.slice(1))) === label));
    const three: Reported[] = [
      { key: "Усі основа", members: new Set(all), shown: true },
      { key: "Усі Низький", members: pick(all, "Низький"), shown: true },
      { key: "Усі Середній", members: pick(all, "Середній"), shown: true },
      { key: "Усі Високий", members: pick(all, "Високий"), shown: true },
      { key: "Велике основа", members: new Set(big), shown: true },
      { key: "Велике Низький", members: pick(big, "Низький"), shown: true },
      { key: "Велике Середній", members: pick(big, "Середній"), shown: true },
      { key: "Велике Високий", members: pick(big, "Високий"), shown: true },
      { key: "Мале основа", members: new Set(small), shown: true },
    ];
    const first = pinnedAreas(three);
    expect(first.map((a) => a.n).sort(), "вычитание соседок не названо: «Мале».«Високий» = 11 − 10").toContain(1);

    /* (2) множественный выбор: |Біль ∖ Шум| = 6 − 5 = 1 */
    const people = Array.from({ length: 16 }, (_, i) => `p${i}`);
    const many: Reported[] = [
      { key: "основа", members: new Set(people), shown: true },
      { key: "Шум", members: new Set(people.slice(0, 10)), shown: true },
      { key: "Біль", members: new Set(people.slice(5, 11)), shown: true },
      { key: "решта", members: new Set(people.slice(11)), shown: true },
    ];
    expect(pinnedAreas(many).map((a) => a.n), "|Біль ∖ Шум| = 1 не названо").toContain(1);
  });

  /**
   * Весь ответ решается одной системой, и она не называет никого.
   *
   * Проверка строже серверной: сервер режет ответ на системы по
   * показателям, а здесь все показанные числа подаются разом — области
   * мельче, восстановимость виднее. Колонки едут порознь, потому что
   * каждая из них — свой ответ; ответы из нескольких колонок проверяются
   * ниже, своими сценариями.
   *
   * Мутация: снять проверку из keepSafe (печатать первый набросок) —
   * проверка называет двоих «з болем без шуму» у 21 респондента, четверых
   * «з думками» там же и двоих, что не слышат шума, у двенадцати.
   */
  test("весь ответ решается одной системой — и не называет ни одной горстки", async () => {
    const men25 = { filters: { sex: "male", ageMin: 25, ageMax: 45 } };
    const base = await columnsApart([
      column({ title: "Чоловіки 25–45", ...men25 }),
      column({ title: "Усі" }),
      column({ title: "Група", filters: { patientGroupId: groupId } }),
      markedColumn({ ...men25, title: "Чоловіки 25–45" }, { band: ["low", "mid"] }),
      markedColumn({ ...men25, title: "Чоловіки 25–45" }, { sleep: ["good", "soso"] }),
      markedColumn({ title: "Усі" }, { why: ["noise", "thoughts"] }),
      markedColumn({ ...men25, title: "Чоловіки 25–45" }, { band: ["low"] }),
    ]);
    for (const col of base) expect(named([col], baseSeed()), `«${col.title}»`).toEqual([]);

    /* сценарии доклада: у каждого свой посев, и все — на одном городе */
    const cases: [object, Dweller[]][] = [
      [skepticColumn("21", CITY21, ["noise", "pain"]), seed21(["21"])],
      [skepticColumn("21", CITY21, [], ["noise", "thoughts"]), seed21(["21"])],
      [skepticColumn("21", CITY21, [], ["noise", "pain"]), seed21(["21"])],
      [skepticColumn("14", CITY14, ["noise", "thoughts"]), seed14(["14"])],
      [skepticColumn("12", CITY12, [], ["noise", "pain"]), seed12(["12"])],
      [skepticColumn("16", CITY16, [], ["noise", "pain"]), seed16(["16"])],
    ];
    for (const [spec, people] of cases) {
      const [col] = await columnsApart([spec]);
      expect(named([col!], people), `«${col!.title}» ${JSON.stringify(col!.questions[0]!.options)}`).toEqual([]);
    }
  });

  /**
   * Сценарий (1) доклада на живом расчёте: три колонки одного ответа, где
   * «Усі» = «Велике» ⊎ «Мале». Прежняя защита мерила РАЗМЕР разности
   * составов, все шесть разностей были велики или пусты, ни одна колонка не
   * закрывалась — и «Мале».«Високий» = 1 читалось вычитанием.
   *
   * Мутация: решать систему по колонке, а не по всему ответу — проверка
   * называет единственного жителя малого города в полосе «Високий».
   * Мутация: снять проверку целиком — то же самое.
   */
  test("сценарий доклада: «Усі» = «Велике» ⊎ «Мале» — три колонки одного ответа", async () => {
    const res = await preview([splitColumn("Усі"), splitColumn("Велике", BIG), splitColumn("Мале", SMALL)]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const cols = res.body.columns as StatRunColumn[];
    expect(cols.map((c) => c.title)).toEqual(["Усі", "Велике", "Мале"]);
    expect(named(cols, splitSeed()), "разность двух показанных соседок называет скрытую ячейку третьей").toEqual([]);

    /* что-то отчёт всё же печатает: защита не сводится к пустому экрану */
    expect(cols.some((c) => !c.respondents.suppressed), "закрылись все три колонки").toBe(true);
    /* и о каждой потере сказано словами */
    for (const col of cols) {
      if (col.suppressedReason) expect(col.note, `«${col.title}» закрыта молча`).toContain("відновлюють");
      else if (col.hiddenFigures) expect(col.note, `«${col.title}» прячет молча`).toContain("Приховано");
      else expect(col.note).toBeNull();
    }
  });

  /**
   * Сценарий (2) доклада на живом расчёте: 16 человек, «Шум» 10, «Біль» 6,
   * «решта» 5. Прежнее правило проверяло каждую ячейку, её дополнение и
   * пересчёт — всё проходило, группа печаталась целиком, а читатель решал
   * систему из четырёх областей и получал |Біль ∖ Шум| = 1.
   *
   * Мутация: снять проверку из keepSafe — группа печатается целиком, и
   * проверка называет того самого человека: |Біль ∖ Шум| = 6 − 5.
   */
  test("сценарий доклада: множественный выбор на шестнадцати не называет одного", async () => {
    const [col] = await columnsApart([skepticColumn("16 осіб", CITY16, [], ["noise", "pain"])]);
    expect(col!.respondents).toEqual({ suppressed: false, count: 16, percent: 100 });
    const cells = col!.questions[0]!.options.map((o) => `${o.text}: ${cellOf(o.cell)}`);
    expect([...cells, `решта: ${cellOf(col!.questions[0]!.rest)}`], "группа напечатана целиком").not.toEqual([
      "Шум: 10/63%",
      "Біль: 6/38%",
      "решта: 5/31%",
    ]);
    expect(named([col!], seed16(["16 осіб"]))).toEqual([]);
    expect(col!.hiddenFigures, "из группы ничего не убрано").toBeGreaterThan(0);
  });

  /**
   * Второй круг, сценарий вложенных колонок: «до 40» ⊇ «до 30», разность —
   * четверо, и это настоящий класс неразличимости.
   *
   * Приманки в нём важнее самой разности: шестнадцать клеток Венна по
   * одному человеку. Прежняя проверка брала в перебор шестнадцать САМЫХ
   * МЕЛКИХ областей — и одиночки занимали весь срез, а четвёрка «31–40» из
   * перебора выпадала. Защита вела себя наоборот здравому смыслу: чем
   * подробнее отчёт, тем слабее проверка.
   *
   * Мутация: вернуть прежний перебор — области вместо связок, срез в
   * шестнадцать самых мелких и без проверки строк отчёта целиком: оба
   * основания печатаются, и 12 − 8 называет четверых.
   */
  test("вложенные колонки: разность «до 40» и «до 30» не называет четверых", async () => {
    const res = await preview([
      nestedColumn("Усі", {}, true),
      nestedColumn("до 40", { ageMax: 40 }),
      nestedColumn("до 30", { ageMax: 30 }),
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const cols = res.body.columns as StatRunColumn[];
    expect(cols.map((c) => c.title)).toEqual(["Усі", "до 40", "до 30"]);
    const baseShown = (title: string) => !cols.find((c) => c.title === title)!.respondents.suppressed;
    expect(baseShown("до 40") && baseShown("до 30"), "оба вложенных основания напечатаны: 12 − 8 называет четверых").toBe(false);
    expect(named(cols, nestedSeed()), "приманки вытеснили искомую область из перебора").toEqual([]);
    /* закрывается вложенная колонка, а не та, ради которой отчёт открывали */
    expect(cols[0]!.respondents, "закрыта колонка без фильтра — самая полная из трёх").toEqual({
      suppressed: false,
      count: 20,
      percent: 100,
    });
    expect(cols.filter((c) => c.suppressedReason === "recoverable"), "закрылось больше одной колонки").toHaveLength(1);
    for (const col of cols) {
      if (col.suppressedReason) expect(col.note, `«${col.title}» закрыта молча`).toContain("відновлюють");
      else if (col.hiddenFigures) expect(col.note, `«${col.title}» прячет молча`).toContain("Приховано");
    }
  });

  /**
   * Второй круг, сценарий вынужденных значений: пятеро названы поимённо из
   * ОДНОГО ответа, без всякого знания кода.
   *
   * «А» 15 из 20, «Ж» и «З» — честные нули, «Б»…«Е» — прочерки, «ВШР» 5.
   * Читатель считает так: нули печатаются, значит за каждым прочерком хотя
   * бы один; выбор один, значит сумма прочерков 20 − 15 − 0 = 5; пять
   * слагаемых, каждое ≥ 1, сумма 5 — каждое равно единице.
   *
   * Прежняя проверка рассуждала только о линейной оболочке ПОКАЗАННЫХ
   * чисел: классов у неё было два — «А» на пятнадцать и «ВШР» на пять, оба
   * над порогом, и она молчала. Вся утечка жила в том, что класс из пяти
   * поделён прочерками.
   *
   * Мутация: выбросить из системы скрытые числа (systemOf по kept) —
   * колонка печатает «ВШР 5/25%» поверх пятнадцати, и проверка называет
   * пятерых. Мутация: оставить прочерку нижнюю границу 0 вместо 1 —
   * то же самое: без «за прочерком кто-то есть» система ничего не держит.
   */
  test("вынужденные значения: пять прочерков не складываются в пять единиц", async () => {
    const [col] = await columnsApart([wideColumn("Вимушені", FORCED, [1, 2, 3, 4, 5])]);
    expect(forcedByPartition(col!), "разбиение само называет своих скрытых").toEqual([]);
    expect(named([col!], forcedSeed())).toEqual([]);
    expect(col!.hiddenFigures, "из колонки ничего не убрано").toBeGreaterThan(0);
    expect(col!.note ?? "", "цена не названа словами").toContain("Приховано");

    /*
     * Контроль, и он тут не для красоты: та же форма, но «А» 14 и «Б» 2 —
     * сумма прочерков 6 на пять ячеек, и набор их не фиксирует. Отчёт
     * обязан остаться полнее, иначе «защита» свелась бы к «прячем всё, где
     * есть хоть один прочерк», и проверять в ней было бы нечего.
     */
    const [loose] = await columnsApart([wideColumn("Невимушені", LOOSE, [1, 2, 3, 4, 5])]);
    expect(forcedByPartition(loose!)).toEqual([]);
    expect(named([loose!], looseSeed())).toEqual([]);
    expect(loose!.hiddenFigures, "у свободного набора спрятано столько же, сколько у вынужденного")
      .toBeLessThan(col!.hiddenFigures);
  });

  /**
   * Верхний край прочерка: два прочерка, сумма которых делится только
   * одним способом.
   *
   * 5/5/4/4 на восемнадцати — порог прячет обе четвёрки, отчёт печатает
   * «18 | 5 | 5 | × | × | решта 0», сумма прочерков 8. Правило публикации
   * известно вместе с отчётом, и читатель, проиграв его на всех мыслимых
   * раскладах, оставляет единственный: 4 и 4. Нижнего края («за прочерком
   * хотя бы один») здесь мало — восьмёрку он делит семью способами.
   *
   * Мутация: снять верхний край у прочерка (оставить hi = всей выборке) —
   * колонка печатает «18 | 5 | 5 | × | ×», и проверка называет обе
   * четвёрки.
   */
  test("два прочерка не складываются в единственную пару", async () => {
    const [col] = await columnsApart([wideColumn("Пара", PAIR)]);
    expect(forcedByPartition(col!), "сумма прочерков делится единственным способом").toEqual([]);
    expect(named([col!], pairSeed())).toEqual([]);
  });

  /**
   * Второй круг, сценарий почти полного отчёта: двенадцать чисел из
   * тринадцати напечатаны, а тринадцатое читается вычитанием.
   *
   * «А» 7, «Б» 7, «В» 7, «Г» 4, «Д»…«З» нули, остаток 0 — и 25 − 21 = 4.
   * Прежняя проверка эту ячейку ВИДЕЛА бы (её индикатор лежит в оболочке),
   * но добиралась до неё только через перебор объединений, а тот брал
   * шестнадцать самых мелких областей: двадцать один класс по одному
   * человеку занимал весь срез, и две области «Г» по два в перебор не
   * попадали никогда. Авторское обоснование потолка («отчёт с таким числом
   * горсток и без того почти пуст») здесь неверно буквально.
   *
   * Мутация: вернуть прежний перебор (см. выше) — «Г» печатается прочерком
   * при показанных «А», «Б», «В» и основании, и вычитание называет
   * четверых.
   */
  test("почти полный отчёт: единственная скрытая ячейка не читается вычитанием", async () => {
    const [col] = await columnsApart([wideColumn("Зріз", SLICE, [], true)]);
    expect(col!.respondents.suppressed ? "×" : col!.respondents.count).not.toBe(0);
    expect(forcedByPartition(col!), "одна скрытая ячейка в разбиении — чистое вычитание").toEqual([]);
    expect(named([col!], sliceSeed())).toEqual([]);
  });

  /**
   * «ВШР» — объединение помеченных множеств из разных групп, и поверх
   * показанных ячеек он сообщает, насколько они пересекаются.
   *
   * Мутация: снять проверку из keepSafe — «ВШР: 13» печатается при
   * «Високий: 6» и «Шум: 8», и проверка называет того единственного, кто
   * попал в оба показателя: 6 + 8 − 13 = 1.
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
    expect(col.scales[0]!.bands.find((b) => b.label === "Високий")!.cell).toEqual({ suppressed: false, count: 6, percent: 30 });
    expect(col.questions[0]!.options[0]!.cell).toEqual({ suppressed: false, count: 8, percent: 40 });
    expect(col.highRisk, "«ВШР: 13» поверх 6 и 8 называет единственного, кто попал в оба").toEqual({ suppressed: true });
    expect(named([col], seed20(["перетин помічених"]))).toEqual([]);
  });

  /**
   * Колонки одного ответа проверяются вместе: разность их составов — такая
   * же область отчёта, как ячейка.
   *
   * Мутация: решать систему по колонке (выбросить чужие числа из systemOf) —
   * «Усі» и «Чоловіки 25–45» печатаются обе, и четверо (три женщины и
   * юноша) читаются разностью. Мутация: перебирать в pinnedAreas только
   * одиночные области без объединений — падает та же проверка: горстка
   * разности размазана по нескольким областям и поодиночке не видна.
   */
  test("колонки, различающиеся горсткой людей, не считаются рядом", async () => {
    const pair = await preview([
      column({ title: "Усі" }),
      column({ title: "Чоловіки 25–45", filters: { sex: "male", ageMin: 25, ageMax: 45 } }),
    ]);
    expect(pair.status, JSON.stringify(pair.body)).toBe(200);
    const both = pair.body.columns as StatRunColumn[];
    expect(named(both, baseSeed()), "разность составов называет четверых").toEqual([]);
    /* закрылась ровно одна: отчёт не опустел целиком */
    expect(both.filter((c) => c.suppressedReason === "recoverable")).toHaveLength(1);
    const alive = both.find((c) => !c.suppressedReason)!;
    expect(alive.respondents.suppressed, `«${alive.title}» закрыта вместе с соседкой`).toBe(false);

    // равные составы — дубль, а не утечка: разность пуста с обеих сторон
    const twins = await preview([column({ title: "Перша" }), column({ title: "Друга" })]);
    for (const col of twins.body.columns) {
      const same = { suppressed: false, count: 16, percent: 100 };
      expect(col.respondents, `«${col.title}»: одинаковые колонки закрыли друг друга`).toEqual(same);
    }
    expect(named(twins.body.columns, baseSeed())).toEqual([]);

    // разность в десять человек — не горстка: обе колонки остаются открытыми
    const far = await preview([column({ title: "Усі" }), column({ title: "Група", filters: { patientGroupId: groupId } })]);
    for (const col of far.body.columns) expect(col.respondents.suppressed, `«${col.title}» закрыта без нужды`).toBe(false);
    expect(named(far.body.columns, baseSeed())).toEqual([]);
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
   * Цена проверки названа вслух: экран обязан сказать, чего не хватает.
   *
   * Мутация: не заполнять note при частичном подавлении — проверка падает:
   * колонка молча рисует прочерки там, где данные есть, и читатель решает,
   * что методику никто не проходил.
   */
  test("каждая потерянная строка объяснена фразой, а не прочерком", async () => {
    const [col] = await columnsApart([column({ title: "Чоловіки 25–45", filters: { sex: "male", ageMin: 25, ageMax: 45 } })]);
    expect(col!.respondents).toEqual({ suppressed: false, count: 12, percent: 100 });
    expect(col!.suppressedReason, "основание показано — колонка не закрыта").toBeNull();
    expect(col!.hiddenFigures, "у колонки из двенадцати показано всё").toBeGreaterThan(0);
    expect(col!.note).toContain(String(col!.hiddenFigures));
    expect(named([col!], baseSeed())).toEqual([]);

    // а там, где прятать нечего, фразы нет вовсе: она не украшение
    const [full] = await columnsApart([{ ...column({ title: "Усі" }), questions: [] }]);
    expect(full!.hiddenFigures).toBe(0);
    expect(full!.note).toBeNull();
  });

  /**
   * Потолок печатаемых чисел на колонку: шестнадцать чисел С ЛЮДЬМИ. Он не
   * про приватность, а про время: проверка решает систему на каждый расчёт,
   * и её цена растёт с числом уравнений. Колонка с двумя шкалами и двумя
   * вопросами просит восемнадцать чисел — печатается шестнадцать с людьми
   * плюс нули, и о недостающих сказано той же фразой, что и обо всём
   * скрытом.
   *
   * Нули считаются отдельно нарочно: число без людей не даёт системе ни
   * одного уравнения, а спрятанный ноль сломал бы «прочерк — значит хотя бы
   * один», на котором стоит вся проверка.
   *
   * Мутация: снять потолок — проверка падает: чисел с людьми становится
   * семнадцать.
   */
  test("на колонку печатается не больше шестнадцати чисел", async () => {
    const wide = {
      ...column({ title: "Дві шкали" }),
      bands: [
        { scaleId: content.scaleId, bandId: content.band.low },
        { scaleId: content.scaleId, bandId: content.band.mid },
        { scaleId: content.scaleId, bandId: content.band.high, highRisk: true },
        { scaleId: content.loadId, bandId: content.load.low },
        { scaleId: content.loadId, bandId: content.load.mid },
        { scaleId: content.loadId, bandId: content.load.high },
      ],
    };
    const [col] = await columnsApart([wide]);
    const cells: StatCell[] = [
      col!.respondents,
      ...col!.scales.flatMap((s) => [...s.bands.map((b) => b.cell), s.rest]),
      ...col!.questions.flatMap((q) => [...q.options.map((o) => o.cell), q.rest]),
      ...(col!.highRisk ? [col!.highRisk] : []),
    ];
    expect(cells.length, "колонка просит меньше восемнадцати чисел — потолок не проверяется").toBe(18);
    const withPeople = cells.filter((c) => !c.suppressed && c.count > 0);
    expect(withPeople.length, "колонка печатает больше шестнадцати чисел с людьми").toBeLessThanOrEqual(16);
    expect(cells.some((c) => !c.suppressed && c.count === 0), "ноль спрятан — прочерк перестал значить «хотя бы один»").toBe(true);
    expect(col!.note, "о недостающих строках не сказано").toContain("Приховано");
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


