import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import type { AlertCase, AlertCasePage } from "@quizzy/shared";
import {
  and,
  api,
  db,
  encryptPersonFields,
  groupAdmins,
  isNull,
  makeUser,
  root,
  surveyGroups,
  surveys,
  users,
} from "./fixtures";
import { alertCases, patientGroupMembers, patientGroups, responses, riskAlerts } from "../src/db/schema";

/**
 * Очередь случаев на сотнях открытых случаев.
 *
 * Внешний разбор: «экран тревог становился непригодным под нагрузкой —
 * сотни карточек без группировки, фильтрации и пагинации». Курсор и часть
 * фильтров к этому времени уже были; не было того, без чего на сотнях
 * случаев очередь всё равно врёт:
 *
 *   · счётчики консоль считала по загруженной странице («прострочено N» —
 *     из тридцати строк на экране);
 *   · поиск выбирал четыреста случаев и фильтровал их на месте — человек из
 *     хвоста очереди не находился;
 *   · битый курсор молча начинал список сначала, кривые значения фильтров и
 *     незнакомые параметры пропускались;
 *   · человек с двумя открытыми случаями стоял в очереди двумя строками;
 *   · фильтров по пациенту, группе и периоду не было.
 *
 * Набор генерируется здесь: 420 человек в своей группе и своей методике —
 * чужие проверки их не видят (кроме суперадмина, и поэтому всё открытое
 * закрывается в afterAll). Спецификация набора — массив ниже, и ожидаемые
 * числа считаются из неё же, а не выписаны руками.
 */

const tag = crypto.randomUUID().slice(0, 8);
const N = 420;
const DAY = 86_400_000;

const groupId = crypto.randomUUID();
const surveyId = crypto.randomUUID();
let staff: { id: string; token: string };
let other: { id: string; token: string };
let ownPatientGroup: string;
let foreignPatientGroup: string;

interface Spec {
  i: number;
  userId: string;
  lastName: string;
  unit: string;
  cases: {
    id: string;
    severity: "severe" | "moderate";
    assignedTo: string | null;
    openedAt: string;
    lastAlertAt: string;
    resolved: boolean;
  }[];
}
const spec: Spec[] = [];
const base = Date.now() - 60_000;

/** Полдень UTC того дня: при любом поясе базы дата открытия остаётся той же */
const noonDaysAgo = (d: number) => {
  const day = new Date(Date.now() - d * DAY);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12)).toISOString();
};

beforeAll(async () => {
  await db.insert(surveyGroups).values({ id: groupId, title: `Черга ${tag}`, createdBy: root.id });
  staff = await makeUser("admin", `queue-${crypto.randomUUID()}@test.dev`);
  other = await makeUser("admin", `queue-other-${crypto.randomUUID()}@test.dev`);
  await db.insert(groupAdmins).values([
    { groupId, userId: staff.id, addedBy: root.id },
    { groupId, userId: other.id, addedBy: root.id },
  ]);
  await db.insert(surveys).values({
    id: surveyId,
    groupId,
    title: { uk: `Скринінг черги ${tag}`, ru: `Скрининг очереди ${tag}` },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "private",
    // порог эскалации — час: всё, открытое раньше, просрочено
    alertEscalateMinutes: 60,
    createdBy: root.id,
  } as never);

  for (let i = 0; i < N; i++) {
    const userId = crypto.randomUUID();
    const d = i % 10;
    const cases: Spec["cases"] = [
      {
        id: crypto.randomUUID(),
        severity: i % 3 === 0 ? "severe" : "moderate",
        assignedTo: i % 5 === 0 ? staff.id : i % 5 === 1 ? other.id : null,
        // сегодняшние — пять минут назад (не просрочены), остальные — полдень d дней назад
        openedAt: d === 0 ? new Date(Date.now() - 5 * 60_000).toISOString() : noonDaysAgo(d),
        // по три случая на одну метку времени: курсор обязан различать их идентификатором
        lastAlertAt: new Date(base - Math.floor(i / 3) * 60_000).toISOString(),
        resolved: false,
      },
    ];
    // двенадцать человек со вторым открытым случаем — давним, за окном первого
    if (i < 12) {
      cases.push({
        id: crypto.randomUUID(),
        severity: "moderate",
        assignedTo: null,
        openedAt: noonDaysAgo(5),
        lastAlertAt: new Date(base - 5 * DAY).toISOString(),
        resolved: false,
      });
    }
    // тридцать человек с уже разобранным случаем
    if (i >= 100 && i < 130) {
      cases.push({
        id: crypto.randomUUID(),
        severity: "severe",
        assignedTo: null,
        openedAt: noonDaysAgo(20),
        lastAlertAt: new Date(base - 20 * DAY).toISOString(),
        resolved: true,
      });
    }
    spec.push({ i, userId, lastName: `Q${tag}-${i}`, unit: `Рота ${(i % 4) + 1}`, cases });
  }

  const hash = "x".repeat(60);
  for (let from = 0; from < spec.length; from += 200) {
    await db.insert(users).values(
      spec.slice(from, from + 200).map((p) => ({
        id: p.userId,
        email: `queue-${tag}-${p.i}@test.dev`,
        ...encryptPersonFields({ firstName: "Черга", lastName: p.lastName, birthDate: null }),
        passwordHash: hash,
        role: "user",
        unit: p.unit,
      })) as never,
    );
  }
  const rows = spec.flatMap((p) =>
    p.cases.map((c) => ({
      id: c.id,
      userId: p.userId,
      surveyId,
      severity: c.severity,
      openedAt: c.openedAt,
      lastAlertAt: c.lastAlertAt,
      assignedTo: c.assignedTo,
      assignedAt: c.assignedTo ? c.openedAt : null,
      acknowledgedAt: c.resolved ? c.lastAlertAt : null,
      acknowledgedBy: c.resolved ? root.id : null,
      outcome: c.resolved ? ("not_confirmed" as const) : null,
    })),
  );
  for (let from = 0; from < rows.length; from += 200) {
    await db.insert(alertCases).values(rows.slice(from, from + 200));
  }

  /* сигналы у первого человека: три в первом случае, два во втором */
  const p0 = spec[0]!;
  const responseId = crypto.randomUUID();
  await db.insert(responses).values({
    id: responseId,
    surveyId,
    userId: p0.userId,
    status: "completed",
    startedAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
  } as never);
  await db.insert(riskAlerts).values(
    [0, 0, 0, 1, 1].map((k, n) => ({
      id: crypto.randomUUID(),
      responseId,
      surveyId,
      userId: p0.userId,
      caseId: p0.cases[k]!.id,
      label: `Сигнал ${n}`,
      severity: p0.cases[k]!.severity,
      at: p0.cases[k]!.lastAlertAt,
    })),
  );

  /* своя группа пациентов — пятнадцать человек; чужая — у другого сотрудника */
  ownPatientGroup = crypto.randomUUID();
  foreignPatientGroup = crypto.randomUUID();
  await db.insert(patientGroups).values([
    { id: ownPatientGroup, title: `Група ризику ${tag}`, ownerId: staff.id },
    { id: foreignPatientGroup, title: `Чужа група ${tag}`, ownerId: other.id },
  ]);
  await db.insert(patientGroupMembers).values(
    spec.slice(200, 215).map((p) => ({ groupId: ownPatientGroup, patientId: p.userId, addedBy: staff.id })),
  );
}, 60_000);

afterAll(async () => {
  const ids = spec.map((p) => p.userId);
  if (!ids.length) return;
  /* всё открытое закрывается: суперадмин видит любую очередь, и чужой тест не должен наткнуться на наш посев */
  await db
    .update(alertCases)
    .set({ acknowledgedAt: new Date().toISOString(), acknowledgedBy: root.id, outcome: "not_confirmed" })
    .where(and(inArray(alertCases.userId, ids), isNull(alertCases.acknowledgedAt)));
  await db
    .update(riskAlerts)
    .set({ acknowledgedAt: new Date().toISOString(), acknowledgedBy: root.id, outcome: "not_confirmed" })
    .where(and(inArray(riskAlerts.userId, ids), isNull(riskAlerts.acknowledgedAt)));
}, 30_000);

const openCases = (p: Spec) => p.cases.filter((c) => !c.resolved);
const isOverdue = (c: Spec["cases"][number]) => !c.resolved && Date.now() - Date.parse(c.openedAt) >= 60 * 60_000;

async function page(query: string) {
  return api<AlertCasePage>(`/api/alert-cases?${query}`, staff.token);
}

/** Пройти выборку до конца; каждая страница — не длиннее limit */
async function walk(query: string, limit: number) {
  const items: AlertCase[] = [];
  let cursor: string | null = null;
  let first: AlertCasePage | null = null;
  for (let n = 0; n < 100; n++) {
    const res: { status: number; body: AlertCasePage } = await page(
      `${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(limit);
    // счётчики и общее число — только на первой странице: на остальных они те же
    if (first) {
      expect(res.body.facets).toBeUndefined();
      expect(res.body.total).toBeUndefined();
    }
    first ??= res.body;
    items.push(...res.body.items);
    cursor = res.body.nextCursor;
    if (!cursor) break;
  }
  return { items, first: first! };
}

/** Порядок очереди: выраженность, потом время последнего сигнала, потом идентификатор — по убыванию */
function assertOrdered(items: AlertCase[]) {
  const key = (c: AlertCase) => [c.severity === "severe" ? 1 : 0, Date.parse(c.lastAlertAt), c.id] as const;
  for (let k = 1; k < items.length; k++) {
    const [r1, t1, id1] = key(items[k - 1]!);
    const [r2, t2, id2] = key(items[k]!);
    const before = r1 > r2 || (r1 === r2 && (t1 > t2 || (t1 === t2 && id1 > id2)));
    expect(before, `строка ${k} стоит не на своём месте`).toBe(true);
  }
}

describe("очередь на сотнях случаев", () => {
  test("ответ ограничен страницей, курсор ведёт до конца без повторов и пропусков", async () => {
    const { items, first } = await walk("", 25);
    const people = items.map((c) => c.userId);
    expect(new Set(people).size, "человек повторился на другой странице").toBe(people.length);
    expect(people.length, "часть людей курсор пропустил").toBe(N);
    expect(first.total).toBe(N);
    expect(first.grouping).toBe("person");
    assertOrdered(items);

    // без группировки — каждый открытый случай ровно один раз
    const flat = await walk("group=case", 100);
    const expected = spec.flatMap(openCases).map((c) => c.id);
    expect(flat.items.map((c) => c.id).sort()).toEqual(expected.sort());
    expect(flat.first.total).toBe(expected.length);
    assertOrdered(flat.items);
  }, 60_000);

  test("несколько случаев одного человека — одна строка с числом случаев и сигналов", async () => {
    const p0 = spec[0]!;
    const res = await page(`patient=${p0.userId}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    const row = res.body.items[0]!;
    expect(row.group?.cases).toBe(2);
    expect(row.group?.signals).toBe(5);
    // строка стоит по самому срочному случаю, а ждёт человек с самого раннего
    expect(row.id).toBe(p0.cases[0]!.id);
    expect(row.group?.oldestOpenedAt).toBe(p0.cases.map((c) => c.openedAt).sort()[0]);
    expect(row.group?.overdue).toBe(true);

    // сами случаи — по отдельности, для разбора рядом
    const cases = await page(`patient=${p0.userId}&group=case`);
    expect(cases.body.items.map((c) => c.id).sort()).toEqual(p0.cases.map((c) => c.id).sort());
    expect(cases.body.items.every((c) => c.group === undefined)).toBe(true);
  });

  test("счётчики — по всей выборке из SQL, а не по загруженной странице", async () => {
    const res = await page("limit=1");
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    const f = res.body.facets!;

    const has = (p: Spec, pred: (c: Spec["cases"][number]) => boolean) => openCases(p).some(pred);
    const count = (pred: (p: Spec) => boolean) => spec.filter(pred).length;
    const severeSection = count((p) => has(p, (c) => c.severity === "severe"));

    expect(f.total).toBe(N);
    expect(f.severity).toEqual({
      severe: severeSection,
      moderate: count((p) => has(p, (c) => c.severity === "moderate")),
    });
    expect(f.sections).toEqual({ severe: severeSection, moderate: N - severeSection });
    expect(f.assigned).toEqual({
      me: count((p) => has(p, (c) => c.assignedTo === staff.id)),
      none: count((p) => has(p, (c) => c.assignedTo === null)),
      others: count((p) => has(p, (c) => c.assignedTo === other.id)),
    });
    expect(f.overdue).toBe(count((p) => has(p, isOverdue)));
    expect(f.oldestOpenedAt).toBe(spec.flatMap(openCases).map((c) => c.openedAt).sort()[0]!);
  });

  test("счётчик варианта фильтра равен тому, что покажет нажатие", async () => {
    const all = (await page("limit=1")).body.facets!;
    const severe = await page("severity=severe&limit=1");
    expect(severe.body.total).toBe(all.severity.severe);
    // вариант считается без своего фильтра — счётчики выраженности не меняются
    expect(severe.body.facets!.severity).toEqual(all.severity);
    expect(severe.body.facets!.sections).toEqual({ severe: all.severity.severe, moderate: 0 });

    const moderate = await walk("severity=moderate", 100);
    expect(moderate.items.length).toBe(all.severity.moderate);
    expect(moderate.items.every((c) => c.severity === "moderate")).toBe(true);

    const mine = await walk("assigned=me", 100);
    expect(mine.items.length).toBe(all.assigned.me);
    expect(mine.items.every((c) => c.assignedTo === staff.id)).toBe(true);
    expect((await page("assigned=others&limit=1")).body.total).toBe(all.assigned.others);
    expect((await page("assigned=none&limit=1")).body.total).toBe(all.assigned.none);
  }, 30_000);

  test("фильтры: подразделение, группа пациентов, период, статус", async () => {
    const unit = await page(`unit=${encodeURIComponent("Рота 1")}&limit=1`);
    expect(unit.body.total).toBe(spec.filter((p) => p.unit === "Рота 1").length);

    const grouped = await walk(`patientGroup=${ownPatientGroup}`, 100);
    expect(grouped.items.map((c) => c.userId).sort()).toEqual(spec.slice(200, 215).map((p) => p.userId).sort());
    // чужой список — «не найдено», а не пустая очередь: пустая подтверждала бы, что он есть
    expect((await page(`patientGroup=${foreignPatientGroup}`)).status).toBe(404);

    const day = noonDaysAgo(3).slice(0, 10);
    const period = await walk(`from=${day}&to=${day}&group=case`, 100);
    const opened = spec.flatMap(openCases).filter((c) => c.openedAt.slice(0, 10) === day);
    expect(period.items.map((c) => c.id).sort()).toEqual(opened.map((c) => c.id).sort());

    const resolved = await page("status=resolved&limit=1");
    expect(resolved.body.grouping).toBe("case");
    expect(resolved.body.total).toBe(30);
    const every = await page("status=all&limit=1");
    expect(every.body.total).toBe(spec.flatMap((p) => p.cases).length);
    // прежний вид «?all=1» — его шлёт мобильное приложение — значит то же самое
    expect((await page("all=1&limit=1")).body.total).toBe(every.body.total);
  }, 30_000);

  test("поиск находит человека из хвоста очереди и листается курсором", async () => {
    /*
     * Последний по порядку: самый давний сигнал среди умеренных. Прежний поиск
     * брал четыреста случаев и фильтровал их на месте — до него не доходил.
     */
    const tail = spec[N - 1]!;
    const one = await page(`search=${encodeURIComponent(tail.lastName.toLowerCase())}`);
    expect(one.status).toBe(200);
    expect(one.body.items.map((c) => c.userId), "человек из хвоста очереди не находится поиском").toEqual([
      tail.userId,
    ]);
    expect(one.body.total).toBe(1);

    // «…-4» — это 4, 40–49 и 400–419: тридцать один человек, листаем по десять
    const needle = `Q${tag}-4`;
    const expected = spec.filter((p) => p.lastName.startsWith(needle)).map((p) => p.userId);
    const found = await walk(`search=${encodeURIComponent(needle)}`, 10);
    expect(found.first.total).toBe(expected.length);
    expect(found.items.map((c) => c.userId).sort()).toEqual(expected.sort());
  }, 30_000);
});

describe("кривые параметры — отказ, а не молчаливое «как-нибудь»", () => {
  const bad = [
    ["status=bogus", "неизвестный статус"],
    ["all=yes", "прежний all — только 0 или 1"],
    ["status=open&all=1", "status и all противоречат"],
    ["severity=critical", "нет такой выраженности"],
    ["assigned=somebody", "не me/none/others и не идентификатор"],
    ["limit=0", "страница нулевой длины"],
    ["limit=101", "страница длиннее ста"],
    ["limit=abc", "не число"],
    ["cursor=garbage", "битый курсор"],
    ["from=2026-02-31", "несуществующая дата"],
    ["from=2026-09-10&to=2026-09-01", "конец периода раньше начала"],
    ["patient=not-a-uuid", "идентификатор пациента не той формы"],
    ["patientGroup=42", "идентификатор группы не той формы"],
    ["severty=severe", "опечатка в имени параметра"],
    ["status=all&group=person", "по человеку группируется только открытая очередь"],
  ] as const;
  for (const [query, why] of bad) {
    test(`${query} — 400 (${why})`, async () => {
      const res = await page(query);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    });
  }

  test("курсор чужой выборки не принимается", async () => {
    const people = await page("limit=2");
    expect(people.body.nextCursor).toBeTruthy();
    // курсор очереди по людям, поданный списку случаев, пропустил бы строки молча
    expect((await page(`group=case&cursor=${people.body.nextCursor}`)).status).toBe(400);
    // а своей выборке он годится
    expect((await page(`cursor=${people.body.nextCursor}`)).status).toBe(200);
  });

  test("курсор с негодной меткой времени — 400, а не 500", async () => {
    const forged = Buffer.from(`p|1|not-a-time|${crypto.randomUUID()}`).toString("base64url");
    expect((await page(`cursor=${forged}`)).status).toBe(400);
  });

  test("пустое значение — «фильтр не задан»", async () => {
    const res = await page("severity=&assigned=&unit=&limit=1");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(N);
  });
});

describe("плоский список тревог", () => {
  test("отдаётся страницами, курсор ведёт до конца без повторов", async () => {
    const p1 = spec[1]!;
    const responseId = crypto.randomUUID();
    await db.insert(responses).values({
      id: responseId,
      surveyId,
      userId: p1.userId,
      status: "completed",
      startedAt: new Date().toISOString(),
      submittedAt: new Date().toISOString(),
    } as never);
    // двести пятьдесят сигналов одного прохождения — у всех одно время, различает идентификатор
    const at = new Date().toISOString();
    await db.insert(riskAlerts).values(
      Array.from({ length: 250 }, (_, n) => ({
        id: crypto.randomUUID(),
        responseId,
        surveyId,
        userId: p1.userId,
        caseId: p1.cases[0]!.id,
        label: `Плоский ${n}`,
        severity: "moderate" as const,
        at,
      })),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 20; n++) {
      const res: { status: number; body: { items: { id: string }[]; nextCursor: string | null } } = await api(
        `/api/alerts?limit=100${cursor ? `&cursor=${cursor}` : ""}`,
        staff.token,
      );
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(100);
      seen.push(...res.body.items.map((i) => i.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    // 250 своих и 5 сигналов первого человека
    expect(seen.length).toBe(255);

    expect((await api("/api/alerts?limit=0", staff.token)).status).toBe(400);
    expect((await api("/api/alerts?cursor=garbage", staff.token)).status).toBe(400);
    expect((await api("/api/alerts?all=yes", staff.token)).status).toBe(400);
  }, 30_000);
});
