import { describe, expect, test } from "bun:test";
import type { RespondentDynamics, ResponseDetail } from "@quizzy/shared";
import {
  ageOf,
  heldCount,
  instrumentCode,
  instrumentRows,
  itemHistory,
  itemMax,
  itemsGrid,
  lastSession,
  nextVisit,
  openAssignments,
  openNoShow,
  sinceEvents,
  visitsOf,
  type TimelineRow,
} from "../src/pages/patientCard/clinical";

/**
 * Клиника карточки пациента без отрисовки: что встаёт в таблицу методик,
 * какие пункты попадают в таблицу пунктов, какой приём «следующий», какая
 * неявка «открыта» и что случилось «после сессии». Всё — из ответов
 * приложения; ничего не выдумывается, когда данных нет.
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-08T14:00:00.000Z");
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

/* ─────────── методики ─────────── */

function detail(id: string, submittedAt: string, over: Partial<ResponseDetail> = {}): ResponseDetail {
  return {
    id,
    userId: "u1",
    survey: { id: "s1", title: "Депресія (PHQ-9)", scoringEnabled: true, versionNumber: 1 },
    status: "completed",
    startedAt: submittedAt,
    submittedAt,
    durationMs: 1000,
    scores: [
      {
        scaleId: "sc1",
        scaleCode: "PHQ",
        scaleTitle: "Вираженість депресії",
        kind: "clinical",
        rawScore: 14,
        correctedScore: 14,
        value: 14,
        normalized: true,
        normalization: "raw",
        maxScore: 27,
        percent: 52,
        band: null,
        bands: [
          { id: "b1", minScore: 0, maxScore: 4, label: "мінімальна", severity: "none", description: null, grade: null, recommendation: null, hit: false },
          { id: "b2", minScore: 5, maxScore: 9, label: "легка", severity: "mild", description: null, grade: null, recommendation: null, hit: false },
          { id: "b3", minScore: 10, maxScore: 14, label: "помірна", severity: "moderate", description: null, grade: null, recommendation: null, hit: true },
          { id: "b4", minScore: 15, maxScore: 27, label: "тяжка", severity: "severe", description: null, grade: null, recommendation: null, hit: false },
        ],
      },
      {
        scaleId: "lie",
        scaleCode: "L",
        scaleTitle: "Достовірність",
        kind: "validity",
        rawScore: 1,
        correctedScore: 1,
        value: 1,
        normalized: true,
        normalization: "raw",
        maxScore: 5,
        percent: 20,
        band: null,
        bands: [],
      },
    ] as unknown as ResponseDetail["scores"],
    answers: [],
    ...over,
  } as ResponseDetail;
}

function dynamics(points: [string, number][]): RespondentDynamics {
  const mk = (scaleId: string, code: string, title: string) => ({
    scaleId,
    code,
    title,
    points: points.map(([iso, v], i) => ({
      responseId: `r${i}`,
      submittedAt: iso,
      rawScore: v,
      maxScore: 27,
      percent: Math.round((v / 27) * 100),
      bandLabel: null,
      severity: null,
      percentile: null,
      reliable: true,
    })),
    delta: null,
    direction: null,
    sem: 1.5,
    equated: null,
    reliableChange: { rci: -2.1, significant: true, direction: "down" as const, basis: { sd: 5, alpha: 0.86, sampleN: 120 } },
  });
  return {
    userId: "u1",
    fullName: "Мельник Андрій",
    email: "a@example.org",
    sex: "male",
    age: 38,
    surveys: [
      {
        surveyId: "s1",
        title: "Депресія (PHQ-9)",
        responseCount: points.length,
        firstAt: points[0]![0],
        lastAt: points[points.length - 1]![0],
        scales: [mk("sc1", "PHQ", "Вираженість депресії"), mk("lie", "L", "Достовірність")],
      },
    ],
  } as RespondentDynamics;
}

describe("методики: строки таблицы", () => {
  const dyn = dynamics([
    [at(-45), 19],
    [at(-27), 16],
    [at(0), 14],
  ]);
  const rows = instrumentRows(dyn, { r2: detail("r2", at(0)) });

  test("шкала достоверности в таблицу не идёт — она о бланке, а не о человеке", () => {
    expect(rows.map((r) => r.scaleId)).toEqual(["sc1"]);
  });

  test("одношкальная методика подписана кодом методики, а не служебным кодом шкалы", () => {
    expect(rows[0]!.code).toBe("PHQ-9");
    expect(rows[0]!.title).toBe("Вираженість депресії");
  });

  test("сдвиг от старта, порог MDC95 из основы RCI и «краще ↓» по полосам", () => {
    const r = rows[0]!;
    expect(r.delta).toBe(-5);
    // MDC95 = 1,96·√2·SEM, SEM = SD·√(1−α) = 5·√0,14
    expect(r.threshold).toBeCloseTo(1.96 * Math.SQRT2 * 5 * Math.sqrt(1 - 0.86), 1);
    expect(r.better).toBe("down");
    expect(r.rungs.map((x) => x.label)).toEqual(["мінімальна", "легка", "помірна", "тяжка"]);
  });

  test("один замер — сдвига нет; несравнимые концы — сдвига нет, причина названа", () => {
    const one = instrumentRows(dynamics([[at(0), 14]]), {});
    expect(one[0]!.delta).toBeNull();
    const versions = dynamics([
      [at(-10), 19],
      [at(0), 14],
    ]);
    versions.surveys[0]!.scales[0]!.incomparable = "version";
    const r = instrumentRows(versions, {})[0]!;
    expect(r.delta).toBeNull();
    expect(r.incomparable).toBe("version");
  });

  test("без полос (прохождение ещё не пришло) — направления «краще» нет, а не догадка", () => {
    expect(instrumentRows(dyn, {})[0]!.better).toBeNull();
  });
});

describe("код методики из названия", () => {
  test("код в скобках — с цифрой или прописными; пометка «(демо)» — не код", () => {
    expect(instrumentCode("Депресія (PHQ-9)")).toBe("PHQ-9");
    expect(instrumentCode("Індекс тяжкості безсоння (ISI)")).toBe("ISI");
    expect(instrumentCode("СР-45. Схильність до суїцидальних реакцій")).toBe("СР-45");
    expect(instrumentCode("Якість сну (демо)")).toBe("Якість сну (демо)");
  });
});

/* ─────────── пункты ─────────── */

const OPTIONS = [
  { id: "o0", text: "зовсім ні", score: 0, riskFlag: false, riskSeverity: null },
  { id: "o1", text: "кілька днів", score: 1, riskFlag: false, riskSeverity: null },
  { id: "o2", text: "більше половини днів", score: 2, riskFlag: false, riskSeverity: null },
  { id: "o3", text: "майже щодня", score: 3, riskFlag: false, riskSeverity: null },
];
const ITEM9 = OPTIONS.map((o) => (o.score > 0 ? { ...o, riskFlag: true, riskSeverity: "severe" as const } : o));

function answers(sleep: string, nine: string): ResponseDetail["answers"] {
  return [
    { questionId: "q3", title: "Сон", type: "single", position: 3, answered: true, optionIds: [sleep], options: OPTIONS, text: null, number: null },
    { questionId: "q9", title: "Думки про смерть", type: "single", position: 9, answered: true, optionIds: [nine], options: ITEM9, text: null, number: null },
  ] as unknown as ResponseDetail["answers"];
}

describe("пункты: таблица по замерам", () => {
  const dets = [
    detail("r3", at(0), { answers: answers("o3", "o1") }),
    detail("r1", at(-45), { answers: answers("o3", "o0") }),
    detail("r2", at(-27), { answers: answers("o3", "o0") }),
  ];
  const grid = itemsGrid(dets)!;

  test("замеры — по времени, старые слева; пункт — по порядку бланка", () => {
    expect(grid.columns.map((c) => c.responseId)).toEqual(["r1", "r2", "r3"]);
    expect(grid.rows.map((r) => r.title)).toEqual(["Сон", "Думки про смерть"]);
  });

  test("в клетке — вес выбранного варианта; суммы — по замеру; верх лестницы — наибольший вес", () => {
    expect(grid.rows[0]!.cells).toEqual([3, 3, 3]);
    expect(grid.rows[1]!.cells).toEqual([0, 0, 1]);
    expect(grid.sums).toEqual([3, 3, 4]);
    expect(grid.max).toBe(3);
    expect(grid.categorical).toBe(false);
  });

  test("критический пункт помечен, отмеченный критический вариант — флагом", () => {
    expect(grid.rows[1]!.critical).toBe(true);
    expect(grid.rows[1]!.flags).toEqual([false, false, true]);
    expect(grid.rows[0]!.critical).toBe(false);
  });

  test("подписи весов — из вариантов пункта", () => {
    expect(grid.legend.map((l) => `${l.value} ${l.label}`)).toEqual(["0 зовсім ні", "1 кілька днів", "2 більше половини днів", "3 майже щодня"]);
  });

  test("«так / ні» без весов — таблица слов, без сумм", () => {
    const yes = { id: "y", text: "Так", score: 0, riskFlag: true, riskSeverity: "severe" as const };
    const no = { id: "n", text: "Ні", score: 0, riskFlag: false, riskSeverity: null };
    const yn = (pick: string) =>
      [{ questionId: "q31", title: "Спроба", type: "single", position: 31, answered: true, optionIds: [pick], options: [yes, no], text: null, number: null }] as unknown as ResponseDetail["answers"];
    const g = itemsGrid([detail("a", at(-10), { answers: yn("n") }), detail("b", at(0), { answers: yn("y") })])!;
    expect(g.categorical).toBe(true);
    expect(g.rows[0]!.words).toEqual(["Ні", "Так"]);
    expect(g.rows[0]!.flags).toEqual([false, true]);
    expect(g.sums).toEqual([null, null]);
  });

  test("история пункта и наибольший вес — для «1 бал з 3» и плиток разбора", () => {
    expect(itemHistory(dets, "q9").map((h) => [h.score, h.text])).toEqual([
      [0, "зовсім ні"],
      [0, "зовсім ні"],
      [1, "кілька днів"],
    ]);
    expect(itemMax(dets[0], "q9")).toBe(3);
    expect(itemMax(dets[0], "nope")).toBeNull();
  });
});

/* ─────────── приёмы ─────────── */

const visit = (id: string, days: number, status: string, who = "Савчук Ірина Олегівна"): TimelineRow => ({
  id: `visit:${id}`,
  kind: "visit",
  at: at(days),
  title: who,
  detail: status,
});

describe("приёмы, неявки и назначения из хронологии", () => {
  const items: TimelineRow[] = [
    visit("v1", -40, "done"),
    visit("v2", -13, "done"),
    visit("v3", -6, "no_show"),
    visit("v4", 2, "booked"),
    visit("v5", 9, "confirmed"),
    { id: "alert:a1", kind: "alert", at: at(-0.1), title: "PHQ-9, пункт 9", severity: "severe" },
    { id: "assignment:x", kind: "assignment", at: at(-0.08), title: "Безсоння", detail: "open", dueAt: at(7) },
    { id: "assignment:y", kind: "assignment", at: at(-20), title: "Старий набір", detail: "completed" },
  ];
  const visits = visitsOf(items);

  test("следующий — ближайший запланированный после «сейчас»", () => {
    expect(nextVisit(visits, NOW)?.id).toBe("v4");
  });

  test("последний проведённый и его номер среди проведённых", () => {
    const last = lastSession(visits, NOW)!;
    expect(last.visit.id).toBe("v2");
    expect(last.n).toBe(2);
    expect(heldCount(visits)).toBe(2);
  });

  test("неявка после последней сессии — открыта; после неё пришёл — уже история", () => {
    expect(openNoShow(visits, NOW)?.id).toBe("v3");
    const after = visitsOf([...items, visit("v6", -1, "done")]);
    expect(openNoShow(after, NOW)).toBeNull();
  });

  test("открытые назначения — только не пройденные, со сроком", () => {
    expect(openAssignments(items).map((a) => [a.title, a.dueAt])).toEqual([["Безсоння", at(7)]]);
  });

  test("«після сесії» — всё после последнего проведённого, без будущих записей", () => {
    const since = sinceEvents(items, Date.parse(at(-13)), NOW).map((i) => i.id);
    expect(since).toEqual(["visit:v3", "alert:a1", "assignment:x"]);
  });
});

describe("возраст", () => {
  test("полных лет по дате рождения; день рождения ещё не наступил — на год меньше", () => {
    expect(ageOf("1988-05-12", NOW)).toBe(38);
    expect(ageOf("1988-12-01", NOW)).toBe(37);
    expect(ageOf(null, NOW)).toBeNull();
    expect(ageOf("кривое", NOW)).toBeNull();
  });
});
