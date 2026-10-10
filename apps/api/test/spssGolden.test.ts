import { beforeAll, describe, expect, test } from "bun:test";
import {
  appRequest,
  createSurveySchema,
  createVersion,
  db,
  encryptPersonFields,
  eq,
  groupAdmins,
  makeUser,
  root,
  surveyGroups,
  surveys,
  users,
  type Person,
} from "./fixtures";
import { answers, options, questions, responseScores, responses, scales, surveyVersions } from "../src/db/schema";

/**
 * Эталон SPSS-выгрузки на малом наборе — байт в байт.
 *
 * Снят до переделки склейки ответов (#182: квадратичный перебор ответов и
 * баллов на каждое прохождение, загрузка строк дважды за выгрузку). Переделка
 * обязана была ничего не поменять в самих файлах — ни строки, ни порядка,
 * ни кода пропуска, — и этот файл держит именно это: набор покрывает все
 * типы пунктов, две версии методики (сопоставление по позиции и порядковому
 * номеру варианта), пропуски, прохождение без человека и незавершённое.
 *
 * Идентификаторы — постоянные строки, а не случайные: в полном профиле они
 * и есть case_id и subject, в обезличенном — вход HMAC. Даты — в прошлом.
 */

const P = "w20pe-golden";
const surveyId = `${P}-survey`;
let admin: Person;

const draft = (v: 1 | 2) => ({
  title: { uk: `Еталон вивантаження v${v}` },
  administration: "self",
  scoringEnabled: true,
  allowRetake: true,
  visibility: "public",
  scales: [
    {
      code: "S",
      title: { uk: "Шкала S" },
      aggregation: "sum",
      normalization: "tscore",
      norms: [{ mean: 3, sd: 1, source: "еталон" }],
    },
  ],
  questions: [
    {
      type: "single",
      title: { uk: "Один, \"з лапками\", і комою" },
      scaleCode: "S",
      options: [
        { text: { uk: "A" }, score: 0 },
        { text: { uk: "B" }, score: 1 },
        { text: { uk: "C" }, score: 2 },
        ...(v === 2 ? [{ text: { uk: "D" }, score: 3 }] : []),
      ],
    },
    {
      type: "multiple",
      title: { uk: "Кілька" },
      options: [{ text: { uk: "X" } }, { text: { uk: "Y" } }, { text: { uk: "Z" } }],
    },
    { type: "info", title: { uk: "Пояснення" } },
    {
      type: "matrix",
      title: { uk: "Матриця" },
      options: [
        { text: { uk: "Рядок 1" }, kind: "row" },
        { text: { uk: "Рядок 2" }, kind: "row" },
        { text: { uk: "так" } },
        { text: { uk: "ні" } },
      ],
    },
    {
      type: "ranking",
      title: { uk: "Ранжування" },
      options: [{ text: { uk: "P" } }, { text: { uk: "Q" } }, { text: { uk: "R" } }],
    },
    { type: "scale", title: { uk: "Шкала 1–5" }, minValue: 1, maxValue: 5 },
    { type: "text", title: { uk: "Текст" } },
    { type: "date", title: { uk: "Дата" } },
  ],
});

interface Version {
  id: string;
  scaleId: string;
  /** по позиции пункта: id пункта и id его вариантов (строки матрицы — отдельно) */
  q: { id: string; choices: string[]; rows: string[] }[];
}

async function versionOf(no: number): Promise<Version> {
  const all = await db.select().from(surveyVersions).where(eq(surveyVersions.surveyId, surveyId));
  const version = all.find((x) => x.version === no)!;
  const [scale] = await db.select().from(scales).where(eq(scales.versionId, version.id));
  const qs = (await db.select().from(questions).where(eq(questions.versionId, version.id))).sort(
    (a, b) => a.position - b.position,
  );
  const q: Version["q"] = [];
  for (const question of qs) {
    const opts = (await db.select().from(options).where(eq(options.questionId, question.id))).sort(
      (a, b) => a.position - b.position,
    );
    q[question.position] = {
      id: question.id,
      choices: opts.filter((o) => o.kind !== "row").map((o) => o.id),
      rows: opts.filter((o) => o.kind === "row").map((o) => o.id),
    };
  }
  return { id: version.id, scaleId: scale!.id, q };
}

async function person(n: number, sex: "male" | "female" | null, birthDate: string | null): Promise<string> {
  const id = `${P}-u${n}`;
  await db.insert(users).values({
    id,
    email: `${id}@golden.test`,
    passwordHash: "посів-без-входу",
    ...encryptPersonFields({ firstName: "Еталон", lastName: `U${n}`, birthDate }),
    role: "user",
    sex,
    unit: n % 2 ? "Рота А" : null,
    rank: n === 1 ? "сержант" : null,
  } as never);
  return id;
}

type Answer = {
  optionIds?: string[];
  matrix?: Record<string, string>;
  ranking?: string[];
  number?: number;
  text?: string;
  date?: string;
  skipped?: boolean;
};

async function respond(
  n: number,
  o: {
    userId: string | null;
    version: Version;
    at: string;
    status?: "completed" | "in_progress";
    durationMs?: number;
    score?: { raw: number; value: number; normalized: boolean };
    answers: Record<number, Answer>;
  },
): Promise<void> {
  const id = `${P}-r${n}`;
  await db.insert(responses).values({
    id,
    surveyId,
    userId: o.userId,
    status: o.status ?? "completed",
    versionId: o.version.id,
    startedAt: o.at,
    submittedAt: o.status === "in_progress" ? null : o.at,
    durationMs: o.durationMs ?? 0,
  } as never);
  let k = 0;
  for (const [position, a] of Object.entries(o.answers)) {
    k += 1;
    await db.insert(answers).values({
      id: `${id}-a${position}`,
      responseId: id,
      questionId: o.version.q[Number(position)]!.id,
      optionIds: a.optionIds ?? null,
      matrix: a.matrix ?? null,
      ranking: a.ranking ?? null,
      number: a.number ?? null,
      text: a.text ?? null,
      date: a.date ?? null,
      skipped: a.skipped ?? false,
      durationMs: 1000 * k + n,
      changeCount: (n + k) % 3,
    } as never);
  }
  if (o.score) {
    await db.insert(responseScores).values({
      id: `${id}-s`,
      responseId: id,
      scaleId: o.version.scaleId,
      rawScore: o.score.raw,
      value: o.score.value,
      normalization: "tscore",
      maxScore: 10,
      percent: o.score.raw * 10,
      normalized: o.score.normalized,
    } as never);
  }
}

beforeAll(async () => {
  admin = await makeUser("admin", `${P}-admin-${crypto.randomUUID()}@golden.test`);
  const groupId = `${P}-group`;
  await db.insert(surveyGroups).values({ id: groupId, title: "Еталон", createdBy: root.id });
  await db.insert(groupAdmins).values({ groupId, userId: admin.id, addedBy: root.id });
  await db.insert(surveys).values({
    id: surveyId,
    groupId,
    title: { uk: "Еталон вивантаження" },
    administration: "self",
    status: "published",
    publishedAt: "2025-01-01T00:00:00.000Z",
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: admin.id,
  } as never);
  await createVersion(surveyId, createSurveySchema.parse(draft(1)), admin.id, "v1");
  const v1 = await versionOf(1);
  await createVersion(surveyId, createSurveySchema.parse(draft(2)), admin.id, "v2");
  const v2 = await versionOf(2);

  const u1 = await person(1, "male", "1990-05-01");
  const u2 = await person(2, "female", "1985-12-31");
  const u3 = await person(3, null, null);
  const u4 = await person(4, "male", "2001-01-01");
  const u5 = await person(5, "female", "1960-06-15");

  await respond(1, {
    userId: u1,
    version: v1,
    at: "2025-03-10T10:00:00.000Z",
    durationMs: 61_000,
    score: { raw: 3, value: 55.5, normalized: true },
    answers: {
      0: { optionIds: [v1.q[0]!.choices[1]!] },
      1: { optionIds: [v1.q[1]!.choices[0]!, v1.q[1]!.choices[2]!] },
      3: { matrix: { [v1.q[3]!.rows[0]!]: v1.q[3]!.choices[1]!, [v1.q[3]!.rows[1]!]: v1.q[3]!.choices[0]! } },
      4: { ranking: [v1.q[4]!.choices[2]!, v1.q[4]!.choices[0]!, v1.q[4]!.choices[1]!] },
      5: { number: 4 },
      6: { text: "привіт, \"світ\"\nдругий рядок" },
      7: { date: "2025-03-01" },
    },
  });
  await respond(2, {
    userId: u2,
    version: v2,
    at: "2025-04-02T21:30:00.000Z",
    durationMs: 125_500,
    score: { raw: 6, value: 6, normalized: false },
    answers: {
      0: { optionIds: [v2.q[0]!.choices[3]!] },
      1: { optionIds: [] },
      3: { skipped: true },
      4: { ranking: [v2.q[4]!.choices[1]!] },
      6: { skipped: true },
    },
  });
  await respond(3, {
    userId: u1,
    version: v2,
    at: "2025-05-15T08:00:00.000Z",
    durationMs: 30_000,
    score: { raw: 1, value: 41.25, normalized: true },
    answers: {
      0: { optionIds: [v2.q[0]!.choices[0]!] },
      1: { optionIds: [v2.q[1]!.choices[1]!] },
      3: { matrix: { [v2.q[3]!.rows[1]!]: v2.q[3]!.choices[1]! } },
      5: { number: 2.5 },
      6: { text: "коротко" },
      7: { date: "2025-05-14" },
    },
  });
  await respond(4, {
    userId: u3,
    version: v1,
    at: "2025-06-01T12:00:00.000Z",
    answers: { 0: { optionIds: [v1.q[0]!.choices[2]!] }, 5: { number: 5 } },
  });
  await respond(5, {
    userId: null,
    version: v1,
    at: "2025-06-20T12:00:00.000Z",
    durationMs: 10_000,
    score: { raw: 0, value: 30, normalized: true },
    answers: { 0: { optionIds: [v1.q[0]!.choices[0]!] } },
  });
  await respond(6, {
    userId: u4,
    version: v2,
    at: "2025-07-01T12:00:00.000Z",
    status: "in_progress",
    answers: { 0: { optionIds: [v2.q[0]!.choices[1]!] } },
  });
  for (const [n, userId, at] of [
    [7, u4, "2025-07-02T09:00:00.000Z"],
    [8, u5, "2025-07-03T23:59:00.000Z"],
    [9, u5, "2025-08-31T22:00:00.000Z"],
  ] as const) {
    await respond(n, {
      userId,
      version: v2,
      at,
      durationMs: 45_000 + n,
      score: { raw: n - 5, value: 40 + n, normalized: n !== 8 },
      answers: {
        0: { optionIds: [v2.q[0]!.choices[n % 4]!] },
        1: { optionIds: [v2.q[1]!.choices[n % 3]!] },
        4: { ranking: [v2.q[4]!.choices[n % 3]!, v2.q[4]!.choices[(n + 1) % 3]!] },
        5: { number: n % 5 },
      },
    });
  }
  /*
   * Ячейка «мужчина, 25–34» из шести прохождений: при k = 5 она остаётся
   * как есть, остальные сливаются и стираются — обобщение работает в обе
   * стороны, и эталон держит обе.
   */
  for (const n of [10, 11, 12]) {
    const userId = await person(n, "male", `199${n - 8}-02-1${n - 10}`);
    for (const k of [0, 1]) {
      await respond(n * 10 + k, {
        userId,
        version: v2,
        at: `2025-09-${10 + n + k}T0${k}:15:00.000Z`,
        durationMs: 20_000 * (k + 1) + n,
        score: { raw: n % 4, value: 50 + n + k, normalized: true },
        answers: {
          0: { optionIds: [v2.q[0]!.choices[(n + k) % 4]!] },
          4: { ranking: [v2.q[4]!.choices[k]!, v2.q[4]!.choices[2]!, v2.q[4]!.choices[1 - k]!] },
          5: { number: k + 1 },
        },
      });
    }
  }
}, 30_000);

/** Ответ как есть, байтами: text() снял бы BOM, а он — часть файла (Excel без него путает кодировку) */
async function file(name: string, profile: string): Promise<string> {
  const res = await appRequest(`/api/spss/surveys/${surveyId}/${name}?profile=${profile}&lang=uk`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  expect(res.status).toBe(200);
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
}

/**
 * Файл, разобранный для сравнения с эталоном: BOM и заголовок — как есть,
 * строки данных — каждая байт в байт, но без порядка между ними.
 *
 * Порядок строк — порядок, в котором база отдаёт прохождения: запрос
 * выгрузки сортировки не задаёт (и переделка склейки этот запрос не
 * трогала). На чистой базе он совпадает с порядком посева, но стоит
 * соседнему файлу сюиты переписать строки прохождений — и база отдаёт их
 * иначе. Сверять порядок значило бы сверять раскладку таблицы, а не
 * выгрузку; разделитель строк при этом проверяется — им файл и режется.
 */
function lines(text: string): { head: string; rows: string[] } {
  const [head = "", ...rows] = text.split("\r\n");
  return { head, rows: rows.sort() };
}

/** Манифест без момента выгрузки и дат создания версий — они от запуска к запуску свои */
function stable(manifest: string): unknown {
  const m = JSON.parse(manifest) as { exportedAt: string; versions: { createdAt: string }[] };
  expect(Number.isNaN(Date.parse(m.exportedAt))).toBe(false);
  return { ...m, exportedAt: "—", versions: m.versions.map((v) => ({ ...v, createdAt: "—" })) };
}

describe("SPSS-выгрузка: эталон до переделки склейки", () => {
  test("data.csv, полный профиль", async () => {
    expect(lines(await file("data.csv", "full"))).toEqual(lines(`\ufeff${FULL}`));
  });

  test("data.csv, обезличенный профиль", async () => {
    expect(lines(await file("data.csv", "deidentified"))).toEqual(lines(`\ufeff${DEIDENTIFIED}`));
  });

  test("data.csv, анонимный профиль: всё, кроме case_id, — он случайный на каждую выгрузку", async () => {
    const all = (await file("data.csv", "anonymous")).split("\r\n");
    expect(all[0]!.startsWith("\ufeffcase_id,")).toBe(true);
    expect(all.slice(1).every((l) => /^A[0-9A-F]{10},/.test(l))).toBe(true);
    expect(lines(all.map((l) => l.replace(/^\ufeff?[^,]*,/, "")).join("\r\n"))).toEqual(lines(ANONYMOUS));
  });

  test("manifest.json, обезличенный и полный", async () => {
    expect(stable(await file("manifest.json", "deidentified"))).toEqual(MANIFEST_DEIDENTIFIED);
    expect(stable(await file("manifest.json", "full"))).toEqual(MANIFEST_FULL);
  });
});

/* ─────────── эталон: снят с кода до #182 ─────────── */

/** data.csv, полный профиль */
const FULL = [
  "case_id,subject,sex,age,unit,mil_rank,sub_date,dur_min,version,q1,q1_ms,q1_chg,q2_1,q2_2,q2_3,q2_ms,q2_chg,q4_r1,q4_r2,q4_ms,q4_chg,q5_p1,q5_p2,q5_p3,q5_ms,q5_chg,q6,q6_ms,q6_chg,q7,q7_ms,q7_chg,q8,q8_ms,q8_chg,S,S_n,S_nf",
  "w20pe-golden-r1,w20pe-golden-u1,1,34,Рота А,сержант,2025-03-10T10:00:00.000Z,1.02,1,2,1001,2,1,0,1,2001,0,2,1,3001,1,3,1,2,4001,2,4,5001,0,\"привіт, \"\"світ\"\"\nдругий рядок\",6001,1,2025-03-01,7001,2,3,55.5,1",
  "w20pe-golden-r2,w20pe-golden-u2,2,39,,,2025-04-02T21:30:00.000Z,2.09,2,4,1002,0,0,0,0,2002,1,-99,-99,3002,2,2,-99,-99,4002,0,-99,-99,-99,,5002,1,,-99,-99,6,-99,0",
  "w20pe-golden-r3,w20pe-golden-u1,1,35,Рота А,сержант,2025-05-15T08:00:00.000Z,0.50,2,1,1003,1,0,1,0,2003,2,-99,2,3003,0,-99,-99,-99,-99,-99,2.5,4003,1,коротко,5003,2,2025-05-14,6003,0,1,41.25,1",
  "w20pe-golden-r4,w20pe-golden-u3,-99,-99,Рота А,,2025-06-01T12:00:00.000Z,-99,1,3,1004,2,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,5,2004,0,,-99,-99,,-99,-99,-99,-99,-99",
  "w20pe-golden-r5,,-99,-99,,,2025-06-20T12:00:00.000Z,0.17,1,1,1005,0,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,,-99,-99,,-99,-99,0,30,1",
  "w20pe-golden-r7,w20pe-golden-u4,1,24,,,2025-07-02T09:00:00.000Z,0.75,2,4,1007,2,0,1,0,2007,0,-99,-99,-99,-99,2,3,-99,3007,1,2,4007,2,,-99,-99,,-99,-99,2,47,1",
  "w20pe-golden-r8,w20pe-golden-u5,2,65,Рота А,,2025-07-03T23:59:00.000Z,0.75,2,1,1008,0,0,0,1,2008,1,-99,-99,-99,-99,3,1,-99,3008,2,3,4008,0,,-99,-99,,-99,-99,3,-99,0",
  "w20pe-golden-r9,w20pe-golden-u5,2,65,Рота А,,2025-08-31T22:00:00.000Z,0.75,2,2,1009,1,1,0,0,2009,2,-99,-99,-99,-99,1,2,-99,3009,0,4,4009,1,,-99,-99,,-99,-99,4,49,1",
  "w20pe-golden-r100,w20pe-golden-u10,1,33,,,2025-09-20T00:15:00.000Z,0.33,2,3,1100,2,-99,-99,-99,-99,-99,-99,-99,-99,-99,1,3,2,2100,0,1,3100,1,,-99,-99,,-99,-99,2,60,1",
  "w20pe-golden-r101,w20pe-golden-u10,1,33,,,2025-09-21T01:15:00.000Z,0.67,2,4,1101,0,-99,-99,-99,-99,-99,-99,-99,-99,-99,2,3,1,2101,1,2,3101,2,,-99,-99,,-99,-99,2,61,1",
  "w20pe-golden-r110,w20pe-golden-u11,1,32,Рота А,,2025-09-21T00:15:00.000Z,0.33,2,4,1110,0,-99,-99,-99,-99,-99,-99,-99,-99,-99,1,3,2,2110,1,1,3110,2,,-99,-99,,-99,-99,3,61,1",
  "w20pe-golden-r111,w20pe-golden-u11,1,32,Рота А,,2025-09-22T01:15:00.000Z,0.67,2,1,1111,1,-99,-99,-99,-99,-99,-99,-99,-99,-99,2,3,1,2111,2,2,3111,0,,-99,-99,,-99,-99,3,62,1",
  "w20pe-golden-r120,w20pe-golden-u12,1,31,,,2025-09-22T00:15:00.000Z,0.33,2,1,1120,1,-99,-99,-99,-99,-99,-99,-99,-99,-99,1,3,2,2120,2,1,3120,0,,-99,-99,,-99,-99,0,62,1",
  "w20pe-golden-r121,w20pe-golden-u12,1,31,,,2025-09-23T01:15:00.000Z,0.67,2,2,1121,2,-99,-99,-99,-99,-99,-99,-99,-99,-99,2,3,1,2121,0,2,3121,1,,-99,-99,,-99,-99,0,63,1",
].join("\r\n");

/** data.csv, обезличенный профиль */
const DEIDENTIFIED = [
  "case_id,subject,sex,age_band,sub_month,dur_min,version,q1,q1_ms,q1_chg,q2_1,q2_2,q2_3,q2_ms,q2_chg,q4_r1,q4_r2,q4_ms,q4_chg,q5_p1,q5_p2,q5_p3,q5_ms,q5_chg,q6,q6_ms,q6_chg,q7_ms,q7_chg,q8_ms,q8_chg,S,S_n,S_nf",
  "CC2A86FA957,R4FD5F4000A,1,2,2025-03,1.02,1,2,1001,2,1,0,1,2001,0,2,1,3001,1,3,1,2,4001,2,4,5001,0,6001,1,7001,2,3,55.5,1",
  "CABD598EF91,R779C75D26E,-99,-99,2025-04,2.09,2,4,1002,0,0,0,0,2002,1,-99,-99,3002,2,2,-99,-99,4002,0,-99,-99,-99,5002,1,-99,-99,6,-99,0",
  "C52F34F64DE,R4FD5F4000A,1,3,2025-05,0.50,2,1,1003,1,0,1,0,2003,2,-99,2,3003,0,-99,-99,-99,-99,-99,2.5,4003,1,5003,2,6003,0,1,41.25,1",
  "C6AD0591C26,R982EC7756A,-99,-99,2025-06,-99,1,3,1004,2,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,5,2004,0,-99,-99,-99,-99,-99,-99,-99",
  "C5EB5AC999B,,-99,-99,2025-06,0.17,1,1,1005,0,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,0,30,1",
  "CAEF1737F70,R3F0787D397,1,1,2025-07,0.75,2,4,1007,2,0,1,0,2007,0,-99,-99,-99,-99,2,3,-99,3007,1,2,4007,2,-99,-99,-99,-99,2,47,1",
  "C2EA60D9CDE,R5E835AD8B5,-99,-99,2025-07,0.75,2,1,1008,0,0,0,1,2008,1,-99,-99,-99,-99,3,1,-99,3008,2,3,4008,0,-99,-99,-99,-99,3,-99,0",
  "CF4849C4AC3,R5E835AD8B5,-99,-99,2025-08,0.75,2,2,1009,1,1,0,0,2009,2,-99,-99,-99,-99,1,2,-99,3009,0,4,4009,1,-99,-99,-99,-99,4,49,1",
  "C93FBB30C54,R5623A15872,1,2,2025-09,0.33,2,3,1100,2,-99,-99,-99,-99,-99,-99,-99,-99,-99,1,3,2,2100,0,1,3100,1,-99,-99,-99,-99,2,60,1",
  "CEC7CF42569,R5623A15872,1,2,2025-09,0.67,2,4,1101,0,-99,-99,-99,-99,-99,-99,-99,-99,-99,2,3,1,2101,1,2,3101,2,-99,-99,-99,-99,2,61,1",
  "CD56E140347,RE70C95F572,1,2,2025-09,0.33,2,4,1110,0,-99,-99,-99,-99,-99,-99,-99,-99,-99,1,3,2,2110,1,1,3110,2,-99,-99,-99,-99,3,61,1",
  "CE32424AB30,RE70C95F572,1,2,2025-09,0.67,2,1,1111,1,-99,-99,-99,-99,-99,-99,-99,-99,-99,2,3,1,2111,2,2,3111,0,-99,-99,-99,-99,3,62,1",
  "C2ACCBC32B3,RD925DF1629,1,2,2025-09,0.33,2,1,1120,1,-99,-99,-99,-99,-99,-99,-99,-99,-99,1,3,2,2120,2,1,3120,0,-99,-99,-99,-99,0,62,1",
  "C8CF14A5D43,RD925DF1629,1,2,2025-09,0.67,2,2,1121,2,-99,-99,-99,-99,-99,-99,-99,-99,-99,2,3,1,2121,0,2,3121,1,-99,-99,-99,-99,0,63,1",
].join("\r\n");

/** data.csv, анонимный профиль — без первой колонки (case_id) */
const ANONYMOUS = [
  "sex,age_band,sub_month,dur_min,version,q1,q1_ms,q1_chg,q2_1,q2_2,q2_3,q2_ms,q2_chg,q4_r1,q4_r2,q4_ms,q4_chg,q5_p1,q5_p2,q5_p3,q5_ms,q5_chg,q6,q6_ms,q6_chg,q7_ms,q7_chg,q8_ms,q8_chg,S,S_n,S_nf",
  "1,2,2025-03,1.02,1,2,1001,2,1,0,1,2001,0,2,1,3001,1,3,1,2,4001,2,4,5001,0,6001,1,7001,2,3,55.5,1",
  "2,3,2025-04,2.09,2,4,1002,0,0,0,0,2002,1,-99,-99,3002,2,2,-99,-99,4002,0,-99,-99,-99,5002,1,-99,-99,6,-99,0",
  "1,3,2025-05,0.50,2,1,1003,1,0,1,0,2003,2,-99,2,3003,0,-99,-99,-99,-99,-99,2.5,4003,1,5003,2,6003,0,1,41.25,1",
  "-99,-99,2025-06,-99,1,3,1004,2,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,5,2004,0,-99,-99,-99,-99,-99,-99,-99",
  "-99,-99,2025-06,0.17,1,1,1005,0,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,-99,0,30,1",
  "1,1,2025-07,0.75,2,4,1007,2,0,1,0,2007,0,-99,-99,-99,-99,2,3,-99,3007,1,2,4007,2,-99,-99,-99,-99,2,47,1",
  "2,4,2025-07,0.75,2,1,1008,0,0,0,1,2008,1,-99,-99,-99,-99,3,1,-99,3008,2,3,4008,0,-99,-99,-99,-99,3,-99,0",
  "2,4,2025-08,0.75,2,2,1009,1,1,0,0,2009,2,-99,-99,-99,-99,1,2,-99,3009,0,4,4009,1,-99,-99,-99,-99,4,49,1",
  "1,2,2025-09,0.33,2,3,1100,2,-99,-99,-99,-99,-99,-99,-99,-99,-99,1,3,2,2100,0,1,3100,1,-99,-99,-99,-99,2,60,1",
  "1,2,2025-09,0.67,2,4,1101,0,-99,-99,-99,-99,-99,-99,-99,-99,-99,2,3,1,2101,1,2,3101,2,-99,-99,-99,-99,2,61,1",
  "1,2,2025-09,0.33,2,4,1110,0,-99,-99,-99,-99,-99,-99,-99,-99,-99,1,3,2,2110,1,1,3110,2,-99,-99,-99,-99,3,61,1",
  "1,2,2025-09,0.67,2,1,1111,1,-99,-99,-99,-99,-99,-99,-99,-99,-99,2,3,1,2111,2,2,3111,0,-99,-99,-99,-99,3,62,1",
  "1,2,2025-09,0.33,2,1,1120,1,-99,-99,-99,-99,-99,-99,-99,-99,-99,1,3,2,2120,2,1,3120,0,-99,-99,-99,-99,0,62,1",
  "1,2,2025-09,0.67,2,2,1121,2,-99,-99,-99,-99,-99,-99,-99,-99,-99,2,3,1,2121,0,2,3121,1,-99,-99,-99,-99,0,63,1",
].join("\r\n");

/** manifest.json, обезличенный профиль — без exportedAt и дат версий */
const MANIFEST_DEIDENTIFIED = {
  "survey": {
    "id": "w20pe-golden-survey",
    "title": "Еталон вивантаження"
  },
  "exportedAt": "—",
  "profile": "deidentified",
  "lang": "uk",
  "labels": "uk",
  "purpose": null,
  "versions": [
    {
      "version": 1,
      "createdAt": "—",
      "note": "v1",
      "responses": 3
    },
    {
      "version": 2,
      "createdAt": "—",
      "note": "v2",
      "responses": 11
    }
  ],
  "variables": [
    "case_id",
    "subject",
    "sex",
    "age_band",
    "sub_month",
    "dur_min",
    "version",
    "q1",
    "q1_ms",
    "q1_chg",
    "q2_1",
    "q2_2",
    "q2_3",
    "q2_ms",
    "q2_chg",
    "q4_r1",
    "q4_r2",
    "q4_ms",
    "q4_chg",
    "q5_p1",
    "q5_p2",
    "q5_p3",
    "q5_ms",
    "q5_chg",
    "q6",
    "q6_ms",
    "q6_chg",
    "q7_ms",
    "q7_chg",
    "q8_ms",
    "q8_chg",
    "S",
    "S_n",
    "S_nf"
  ],
  "freeText": {
    "included": false,
    "excludedItems": [
      7,
      8
    ],
    "note": "Вільні відповіді й дати в знеособлених профілях не вивантажуються: вилучення ідентифікатора не знеособлює того, що людина написала сама."
  },
  "kanon": {
    "k": 5,
    "merges": 3,
    "bandMap": {
      "<25": "<25…45+",
      "25-34": "<25…45+",
      "35-44": "<25…45+",
      "45+": "<25…45+"
    },
    "blankedRows": 5,
    "note": "Вікові групи злито до наповнення k; у решти рідкісних поєднань стать і вік стерто. Пропуски в цих полях не випадкові."
  },
  "norms": [
    {
      "code": "S",
      "normalization": "tscore",
      "norms": [
        {
          "sex": null,
          "mean": 3,
          "sd": 1
        }
      ],
      "stenRows": 0
    }
  ]
};

/** manifest.json, полный профиль — без exportedAt и дат версий */
const MANIFEST_FULL = {
  "survey": {
    "id": "w20pe-golden-survey",
    "title": "Еталон вивантаження"
  },
  "exportedAt": "—",
  "profile": "full",
  "lang": "uk",
  "labels": "uk",
  "purpose": null,
  "versions": [
    {
      "version": 1,
      "createdAt": "—",
      "note": "v1",
      "responses": 3
    },
    {
      "version": 2,
      "createdAt": "—",
      "note": "v2",
      "responses": 11
    }
  ],
  "variables": [
    "case_id",
    "subject",
    "sex",
    "age",
    "unit",
    "mil_rank",
    "sub_date",
    "dur_min",
    "version",
    "q1",
    "q1_ms",
    "q1_chg",
    "q2_1",
    "q2_2",
    "q2_3",
    "q2_ms",
    "q2_chg",
    "q4_r1",
    "q4_r2",
    "q4_ms",
    "q4_chg",
    "q5_p1",
    "q5_p2",
    "q5_p3",
    "q5_ms",
    "q5_chg",
    "q6",
    "q6_ms",
    "q6_chg",
    "q7",
    "q7_ms",
    "q7_chg",
    "q8",
    "q8_ms",
    "q8_chg",
    "S",
    "S_n",
    "S_nf"
  ],
  "freeText": {
    "included": true,
    "excludedItems": []
  },
  "kanon": null,
  "norms": [
    {
      "code": "S",
      "normalization": "tscore",
      "norms": [
        {
          "sex": null,
          "mean": 3,
          "sd": 1
        }
      ],
      "stenRows": 0
    }
  ]
};
