import { beforeAll, describe, expect, test } from "bun:test";
import {
  api,
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
import { alertCases, answers, responseScores, responses, scales, surveyVersions } from "../src/db/schema";
import { env } from "../src/env";

/**
 * Хвосты статистики после волны 12 (участок stats): кого считают и за какие
 * сутки — там, куда общие правила lib/population.ts ещё не дошли.
 *
 *   — период очереди тревог резался по поясу сессии базы, а не учреждения;
 *   — качество данных (доходимость, дрейф, тест-ретест) брало бланки
 *     сотрудников на себя и недостоверные протоколы;
 *   — условие когорты по коду шкалы без методики сравнивало разные величины;
 *   — статистика пунктов (время, доли вариантов) брала недостоверные бланки.
 *
 * Каждая проверка падала до правки и называет виновника числом, сверенным с
 * посевом. Посев — прямо в базу, в своей группе, со своими людьми; даты —
 * в прошлом (2025 год), чтобы сводки других файлов, смотрящие на «сейчас»,
 * наших строк не видели. Случай тревоги заводится уже разобранным: живого
 * в общей очереди после файла не остаётся.
 */

const uid = () => crypto.randomUUID();
const tag = uid().slice(0, 8);

let admin: Person;
let groupId: string;

/** Человек без пароля: argon2 на полсотни посевных людей стоил бы минуты */
async function quick(name: string, role: "user" | "admin" = "user"): Promise<string> {
  const id = uid();
  await db.insert(users).values({
    id,
    email: `${name}-${id}@tails.test`,
    passwordHash: "посів-без-входу",
    ...encryptPersonFields({ firstName: "Тест", lastName: name, birthDate: null }),
    role,
  } as never);
  return id;
}

/** Методика из одной содержательной шкалы «C» и одного пункта с двумя вариантами */
const draft = {
  title: { uk: "Хвости статистики" },
  administration: "self",
  scoringEnabled: true,
  allowRetake: true,
  visibility: "public",
  scales: [
    {
      code: "C",
      title: { uk: "Стан" },
      aggregation: "sum",
      bands: [
        { minScore: 0, maxScore: 4, label: { uk: "Норма" }, severity: "none" },
        { minScore: 5, maxScore: 99, label: { uk: "Тяжко" }, severity: "severe" },
      ],
    },
  ],
  questions: [
    {
      type: "single",
      title: { uk: "Як ви?" },
      scaleCode: "C",
      required: true,
      options: [
        { text: { uk: "Добре" }, score: 0 },
        { text: { uk: "Погано" }, score: 5 },
      ],
    },
  ],
};

interface Published {
  id: string;
  versionId: string;
  scaleId: string;
  questionId: string;
  optionIds: [string, string];
}

async function publish(title: string): Promise<Published> {
  const id = uid();
  await db.insert(surveys).values({
    id,
    groupId,
    title: { uk: `${title} ${tag}` },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: admin.id,
  } as never);
  await createVersion(id, createSurveySchema.parse(draft), admin.id, "v1");
  const [version] = await db.select().from(surveyVersions).where(eq(surveyVersions.surveyId, id));
  const [scale] = await db.select().from(scales).where(eq(scales.versionId, version!.id));
  const full = await api(`/api/surveys/${id}`, admin.token);
  const q = full.body.questions[0] as { id: string; options: { id: string }[] };
  return { id, versionId: version!.id, scaleId: scale!.id, questionId: q.id, optionIds: [q.options[0]!.id, q.options[1]!.id] };
}

/** Прохождение с баллом шкалы C и, если задан, ответом на пункт */
async function measure(
  s: Published,
  o: {
    userId: string;
    at: string;
    value: number;
    reliable?: boolean;
    sex?: "male" | "female";
    band?: string;
    answer?: { option: 0 | 1; durationMs: number };
  },
): Promise<string> {
  const responseId = uid();
  await db.insert(responses).values({
    id: responseId,
    surveyId: s.id,
    userId: o.userId,
    status: "completed",
    versionId: s.versionId,
    startedAt: o.at,
    submittedAt: o.at,
    durationMs: 60_000,
    respondentSex: o.sex ?? null,
    respondentAgeBand: o.band ?? null,
    reliable: o.reliable ?? true,
  } as never);
  await db.insert(responseScores).values({
    id: uid(),
    responseId,
    scaleId: s.scaleId,
    rawScore: o.value,
    value: o.value,
    normalization: "raw",
    maxScore: 100,
    percent: o.value,
    normalized: true,
  } as never);
  if (o.answer) {
    await db.insert(answers).values({
      id: uid(),
      responseId,
      questionId: s.questionId,
      optionIds: [s.optionIds[o.answer.option]],
      durationMs: o.answer.durationMs,
    } as never);
  }
  return responseId;
}

/** Смена пояса учреждения на время проверки: сутки должны резаться по нему, а не по базе */
async function inZone<T>(zoneName: string, body: () => Promise<T>): Promise<T> {
  const was = env.institutionTz;
  env.institutionTz = zoneName;
  try {
    return await body();
  } finally {
    env.institutionTz = was;
  }
}

beforeAll(async () => {
  admin = await makeUser("admin", `tails-${uid()}@tails.test`);
  groupId = uid();
  await db.insert(surveyGroups).values({ id: groupId, title: `Хвости ${tag}`, createdBy: root.id });
  await db.insert(groupAdmins).values({ groupId, userId: admin.id, addedBy: root.id });
});

/* ═══════════ очередь тревог: сутки учреждения ═══════════ */

describe("период очереди тревог", () => {
  /** Воскресенье прошлой недели, полдень по Гринвичу: на Кірітіматі (UTC+14) это уже понедельник */
  const sunday = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 7 - d.getUTCDay());
    d.setUTCHours(12, 0, 0, 0);
    return d;
  })();
  const sundayDay = sunday.toISOString().slice(0, 10);
  const mondayDay = new Date(sunday.getTime() + 86_400_000).toISOString().slice(0, 10);

  test("день открытия случая — по поясу учреждения, а не сессии базы", async () => {
    const s = await publish("Черга тривог");
    const patient = await quick("tails-case");
    const caseId = uid();
    await db.insert(alertCases).values({
      id: caseId,
      userId: patient,
      surveyId: s.id,
      openedAt: sunday.toISOString(),
      lastAlertAt: sunday.toISOString(),
      severity: "severe",
      // разобран: в открытой очереди соседних файлов его нет
      acknowledgedAt: sunday.toISOString(),
      acknowledgedBy: admin.id,
    } as never);

    const found = (day: string) =>
      api(`/api/alert-cases?status=resolved&patient=${patient}&from=${day}&to=${day}`, admin.token).then((r) => {
        expect(r.status).toBe(200);
        return (r.body.items as { id: string }[]).map((x) => x.id);
      });

    await inZone("Pacific/Kiritimati", async () => {
      // по учреждению случай открыт в понедельник — и «за понедельник» он есть
      expect(await found(mondayDay), "период режется по поясу сессии базы").toEqual([caseId]);
      // а «за воскресенье» его нет, хотя по Гринвичу (и по Киеву) это воскресенье
      expect(await found(sundayDay)).toEqual([]);
    });
  }, 30_000);
});

/* ═══════════ качество данных: кого считаем ═══════════ */

describe("качество данных", () => {
  test("доходимость по стратам — без бланков сотрудников на себя", async () => {
    const s = await publish("Страти");
    const at = "2025-03-10T10:00:00.000Z";
    for (let i = 0; i < 5; i++) {
      await measure(s, { userId: await quick("tails-strata"), at, value: 1, sex: "male", band: "25-34" });
    }
    // сотрудники, попробовавшие методику на себе, — той же страты
    for (let i = 0; i < 3; i++) {
      await measure(s, { userId: await quick("tails-strata-staff", "admin"), at, value: 1, sex: "male", band: "25-34" });
    }
    const res = await api(`/api/data-quality/surveys/${s.id}`, admin.token);
    expect(res.status).toBe(200);
    const cell = (res.body.strata as { sex: string; band: string; started?: number }[]).find(
      (x) => x.sex === "male" && x.band === "25-34",
    );
    expect(cell?.started, "бланки сотрудников в доходимости").toBe(5);
  }, 30_000);

  test("тест-ретест — пары только достоверных протоколов пациентов", async () => {
    const s = await publish("Ретест");
    const first = "2025-04-01T10:00:00.000Z";
    const second = "2025-04-11T10:00:00.000Z"; // десять дней — внутри окна 7–60
    for (let i = 0; i < 3; i++) {
      const p = await quick("tails-retest");
      await measure(s, { userId: p, at: first, value: i });
      await measure(s, { userId: p, at: second, value: i + 1 });
    }
    // сотрудник дважды попробовал методику — не пара
    const staff = await quick("tails-retest-staff", "admin");
    await measure(s, { userId: staff, at: first, value: 3 });
    await measure(s, { userId: staff, at: second, value: 3 });
    // второй бланк недостоверен — не пара
    const shaky = await quick("tails-retest-shaky");
    await measure(s, { userId: shaky, at: first, value: 2 });
    await measure(s, { userId: shaky, at: second, value: 9, reliable: false });

    const res = await api(`/api/data-quality/surveys/${s.id}`, admin.token);
    expect(res.status).toBe(200);
    const c = (res.body.retest as { code: string; pairs: number }[]).find((r) => r.code === "C");
    expect(c?.pairs, "в парах ретеста сотрудник или недостоверный протокол").toBe(3);
  }, 30_000);

  test("дрейф — без сотрудников и недостоверных; месяц — по поясу учреждения", async () => {
    const s = await publish("Дрейф");
    const people = await Promise.all(Array.from({ length: 8 }, () => quick("tails-drift")));
    const staff = await Promise.all(Array.from({ length: 2 }, () => quick("tails-drift-staff", "admin")));
    let k = 0;
    const next = () => people[k++ % people.length]!;

    // базовая линия: январь
    for (let i = 0; i < 25; i++) await measure(s, { userId: next(), at: "2025-01-15T12:00:00.000Z", value: i % 10 });
    // последний месяц: февраль
    for (let i = 0; i < 20; i++) await measure(s, { userId: next(), at: "2025-02-15T12:00:00.000Z", value: (i * 3) % 10 });
    // полдень 31 января по Гринвичу — на Кірітіматі это уже 1 февраля
    for (let i = 0; i < 5; i++) await measure(s, { userId: next(), at: "2025-01-31T12:00:00.000Z", value: 9 });
    // шум февраля: недостоверные бланки и пробы сотрудников
    for (let i = 0; i < 6; i++) {
      await measure(s, { userId: next(), at: "2025-02-15T12:00:00.000Z", value: 9, reliable: false });
      await measure(s, { userId: staff[i % 2]!, at: "2025-02-15T12:00:00.000Z", value: 9 });
    }

    const driftOf = async () => {
      const res = await api(`/api/data-quality/surveys/${s.id}`, admin.token);
      expect(res.status).toBe(200);
      return (res.body.drift as { code: string; month: string; n: number }[]).find((d) => d.code === "C");
    };

    const kyiv = await driftOf();
    expect(kyiv?.month).toBe("2025-02");
    expect(kyiv?.n, "в дрейф попали сотрудники или недостоверные протоколы").toBe(20);

    const east = await inZone("Pacific/Kiritimati", driftOf);
    expect(east?.n, "месяц режется по Гринвичу, а не по поясу учреждения").toBe(25);
  }, 60_000);
});

/* ═══════════ когорта: условие по шкале ═══════════ */

describe("условие когорты по коду шкалы", () => {
  test("без методики — понятный отказ, а не смесь единиц", async () => {
    const res = await api("/api/cohorts/preview", admin.token, {
      method: "POST",
      body: JSON.stringify({ scales: [{ code: "L", op: "<=", value: 50 }] }),
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("вибраної методики");
  });

  test("то же условие при выбранной методике принимается", async () => {
    const s = await publish("Когорта");
    const res = await api("/api/cohorts/preview", admin.token, {
      method: "POST",
      body: JSON.stringify({ surveyId: s.id, scales: [{ code: "C", op: "<=", value: 50 }] }),
    });
    expect(res.status).toBe(200);
  });

  test("сохранить такую когорту тоже нельзя", async () => {
    const res = await api("/api/cohorts", admin.token, {
      method: "POST",
      body: JSON.stringify({ title: `Когорта без методики ${tag}`, spec: { scales: [{ code: "L", op: "<=", value: 50 }] } }),
    });
    expect(res.status).toBe(400);
  });
});

/* ═══════════ аналитика методики: статистика пунктов ═══════════ */

describe("статистика пунктов", () => {
  test("время и доли вариантов — без недостоверных протоколов; воронка — по всем", async () => {
    const s = await publish("Пункти");
    const at = "2025-05-20T10:00:00.000Z";
    // трое честных: «Добре», по три секунды
    for (let i = 0; i < 3; i++) {
      await measure(s, { userId: await quick("tails-item"), at, value: 0, answer: { option: 0, durationMs: 3000 } });
    }
    // двое «всё — так», проваливших достоверность: «Погано», мгновенно
    for (let i = 0; i < 2; i++) {
      await measure(s, {
        userId: await quick("tails-item-shaky"),
        at,
        value: 5,
        reliable: false,
        answer: { option: 1, durationMs: 200 },
      });
    }

    const res = await api(`/api/analytics/surveys/${s.id}`, admin.token);
    expect(res.status).toBe(200);
    const q = (
      res.body.questions as {
        questionId: string;
        answered: number;
        avgDurationMs: number;
        options: { optionId: string; percent: number }[];
      }[]
    ).find((x) => x.questionId === s.questionId)!;
    expect(q.answered, "недостоверные бланки в статистике пункта").toBe(3);
    expect(q.avgDurationMs).toBe(3000);
    expect(q.options.find((o) => o.optionId === s.optionIds[0])!.percent).toBe(100);
    expect(q.options.find((o) => o.optionId === s.optionIds[1])!.percent).toBe(0);
    expect(res.body.unreliableCount).toBe(2);

    // сданный недостоверный бланк прошёл методику до конца: из воронки он не выпадает
    const step = (res.body.dropOff as { questionId: string; reached: number; lost: number }[]).find(
      (d) => d.questionId === s.questionId,
    )!;
    expect(step.reached).toBe(5);
    expect(step.lost).toBe(0);
  }, 30_000);
});
