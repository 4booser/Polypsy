import { describe, expect, test } from "bun:test";
import type { AlertCase, PatientCardDomain, RespondentDynamics, ResponseDetail } from "@quizzy/shared";
import {
  ageOf,
  chartNames,
  clinicalPicture,
  itemHistory,
  itemMax,
  itemsGrid,
  lastSession,
  nextVisit,
  openAssignments,
  openNoShow,
  signalGroups,
  visitsOf,
  type TimelineRow,
} from "../src/pages/patientCard/clinical";

/**
 * Клиника рабочего места пациента без отрисовки: что встаёт в «Клінічну
 * картину» и в каком порядке, как сдвиг называется словом, что подняло
 * открытый случай, какие пункты попадают в таблицу пунктов, какой приём
 * «следующий» и какая неявка «открыта». Всё — из ответов приложения; ничего
 * не выдумывается, когда данных нет.
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
        /* вид шкалы — как отдаёт сервер (ScaleDynamics.kind): «L» — шкала достоверности */
        scales: [{ ...mk("sc1", "PHQ", "Вираженість депресії"), kind: "clinical" as const }, { ...mk("lie", "L", "Достовірність"), kind: "validity" as const }],
      },
    ],
  } as RespondentDynamics;
}

const PHQ_BANDS = [
  { min: 0, max: 4, label: "мінімальна", severity: "none" as const },
  { min: 5, max: 9, label: "легка", severity: "mild" as const },
  { min: 10, max: 14, label: "помірна", severity: "moderate" as const },
  { min: 15, max: 27, label: "тяжка", severity: "severe" as const },
];
const DEPRESSION: PatientCardDomain[] = [{ surveyId: "s1", code: "PHQ", domain: "depression" }];

/** Динамика с полосами у содержательной шкалы — как отдаёт сервер */
function banded(points: [string, number][]): RespondentDynamics {
  const d = dynamics(points);
  d.surveys[0]!.scales[0]!.bands = PHQ_BANDS;
  return d;
}

describe("клиническая картина: строки по доменам", () => {
  test("код методики — от сервера (по ключу каталога), без него — из названия", () => {
    const d = banded([[at(0), 14]]);
    const sv = d.surveys[0]!;
    const own = { ...d, surveys: [{ ...sv, title: "Опитувальник Міні-мульт", shortName: "Міні-мульт" }] };
    expect(clinicalPicture(own, DEPRESSION)[0]!.rows[0]!.code).toBe("Міні-мульт");
    // старый ответ без короткого имени: последняя скобка, регистр не важен
    const old = { ...d, surveys: [{ ...sv, title: "Синдром відміни алкоголю (CIWA-Ar)" }] };
    expect(clinicalPicture(old, DEPRESSION)[0]!.rows[0]!.code).toBe("CIWA-Ar");
  });

  test("шапка графика курса: что меряли и чем; код из названия второй раз не повторяется", () => {
    expect(chartNames({ surveyTitle: "Депресія (PHQ-9)", code: "PHQ-9", scaleTitle: "Вираженість депресії" }, true)).toEqual({
      measure: "Депресія",
      method: "PHQ-9",
    });
    // многошкальная — шкала и код методики
    expect(chartNames({ surveyTitle: "Депресія, тривога, стрес (DASS-42)", code: "DASS-42", scaleTitle: "Тривога" }, false)).toEqual({
      measure: "Тривога",
      method: "DASS-42",
    });
    expect(chartNames({ surveyTitle: "Опитувальник Міні-мульт", code: "Міні-мульт", scaleTitle: "Іпохондрія" }, true)).toEqual({
      measure: "Опитувальник Міні-мульт",
      method: null,
    });
  });

  test("строка картины несёт лестницу полос снизу вверх — для графика курса и малого курса", () => {
    const row = clinicalPicture(banded([[at(-1), 9], [at(0), 14]]), DEPRESSION)[0]!.rows[0]!;
    expect(row.rungs.length).toBeGreaterThan(1);
    expect(row.rungs.map((r) => r.min)).toEqual([...row.rungs.map((r) => r.min)].sort((a, b) => a - b));
  });

  test("шкала достоверности в картину не идёт — она о бланке, а не о человеке", () => {
    const rows = clinicalPicture(banded([[at(0), 14]]), DEPRESSION).flatMap((g) => g.rows);
    expect(rows.map((r) => r.scale.code)).toEqual(["PHQ"]);
  });

  test("строка подписана кодом методики, что меряет — названием шкалы; домен — с сервера", () => {
    const [group] = clinicalPicture(banded([[at(0), 14]]), DEPRESSION);
    expect(group!.domain).toBe("depression");
    expect(group!.rows[0]!.code).toBe("PHQ-9");
    expect(group!.rows[0]!.scaleTitle).toBe("Вираженість депресії");
  });

  test("домена нет в ответе (старый сервер, самодельная шкала) — «інше», а не догадка по названию", () => {
    expect(clinicalPicture(banded([[at(0), 14]]), []).map((g) => g.domain)).toEqual(["other"]);
  });

  test("сдвиг от первого замера: число, порог MDC95 из основы RCI и слово — по полярности полос", () => {
    /*
     * MDC95 = 1,96·√2·SEM, SEM = SD·√(1−α) = 5·√0,14 ≈ 5,19. У сырого
     * балла (целые суммы) — вверх до целого: сдвиг на 6 значущий, на 5 — нет,
     * и «поріг 6» говорит ровно это.
     */
    const threshold = Math.ceil(1.96 * Math.SQRT2 * 5 * Math.sqrt(1 - 0.86));
    const within = clinicalPicture(banded([[at(-45), 19], [at(-27), 16], [at(0), 14]]), DEPRESSION)[0]!.rows[0]!;
    expect(within.delta).toBe(-5);
    expect(within.threshold).toBe(threshold);
    expect(within.better).toBe("down");
    expect(within.verdict).toBe("within");

    const better = clinicalPicture(banded([[at(-45), 22], [at(0), 14]]), DEPRESSION)[0]!.rows[0]!;
    expect(better.delta).toBe(-8);
    expect(better.verdict).toBe("better");

    const worse = clinicalPicture(banded([[at(-45), 6], [at(0), 14]]), DEPRESSION)[0]!.rows[0]!;
    expect(worse.verdict).toBe("worse");
  });

  test("без полос — направления нет: значущий сдвиг — «значуща зміна», а не «покращення»", () => {
    const r = clinicalPicture(dynamics([[at(-45), 22], [at(0), 14]]), DEPRESSION)[0]!.rows[0]!;
    expect(r.better).toBeNull();
    expect(r.verdict).toBe("changed");
  });

  test("без основы похибки — «значущість не оцінено», а не «без змін»", () => {
    const d = banded([[at(-45), 22], [at(0), 14]]);
    for (const sc of d.surveys[0]!.scales) {
      sc.reliableChange = null;
      sc.sem = null;
    }
    const r = clinicalPicture(d, DEPRESSION)[0]!.rows[0]!;
    expect(r.threshold).toBeNull();
    expect(r.verdict).toBe("unknown");
  });

  test("доля — сдвиг и порог в процентных пунктах, а не долей рядом с «49%»", () => {
    /*
     * У шкалы в долях (СР-45) точка — 0,29 и 0,49. Прежде сдвиг вычитался
     * как есть и округлялся до десятых: «+0,2 в. п.» рядом с «49%».
     */
    const ratio = dynamics([
      [at(-10), 0.29],
      [at(0), 0.49],
    ]);
    for (const sc of ratio.surveys[0]!.scales) {
      for (const p of sc.points) p.normalization = "ratio";
      sc.reliableChange = { rci: 1.7, significant: false, direction: "up", basis: { sd: 0.15, alpha: 0.86, sampleN: 120 } };
    }
    const r = clinicalPicture(ratio, DEPRESSION)[0]!.rows[0]!;
    expect(r.delta).toBe(20);
    // MDC95 = 1,96·√2·0,15·√0,14 ≈ 0,16 (общее правило, до сотых) → 16 в. п.
    expect(r.threshold).toBe(16);
  });

  test("один замер — «перший замір»; несравнимые концы — сдвига нет, причина названа", () => {
    const one = clinicalPicture(banded([[at(0), 14]]), DEPRESSION)[0]!.rows[0]!;
    expect(one.delta).toBeNull();
    expect(one.verdict).toBe("single");
    const versions = banded([
      [at(-10), 19],
      [at(0), 14],
    ]);
    versions.surveys[0]!.scales[0]!.incomparable = "version";
    const r = clinicalPicture(versions, DEPRESSION)[0]!.rows[0]!;
    expect(r.delta).toBeNull();
    expect(r.verdict).toBe("incomparable");
    expect(r.incomparable).toBe("version");
  });

  test("профиль из многих шкал одного домена — одной строкой самой тяжёлой; другие методики не вытесняются", () => {
    /*
     * «Адаптивність-200» — восемь шкал. Прежде они занимали все строки
     * таблицы, и СР-45 того же дня в неё не попадал. Теперь — одна строка
     * (самая тяжёлая шкала, прочие — в «Динаміці»), и СР-45 рядом.
     */
    const many = dynamics([[at(0), 5]]);
    const sv = many.surveys[0]!;
    const template = sv.scales[0]!;
    sv.title = "БОО «Адаптивність-200»";
    sv.scales = Array.from({ length: 8 }, (_, i) => ({
      ...template,
      scaleId: `a${i}`,
      code: `A${i}`,
      title: `Шкала ${i + 1}`,
      points: template.points.map((p) => ({ ...p, severity: i === 5 ? ("severe" as const) : ("none" as const) })),
    }));
    const sr = dynamics([[at(-1), 9]]).surveys[0]!;
    many.surveys.push({ ...sr, surveyId: "s2", title: "СР-45. Схильність до суїцидальних реакцій", lastAt: at(-1) });
    const domains: PatientCardDomain[] = [
      ...sv.scales.map((sc) => ({ surveyId: "s1", code: sc.code, domain: "personality" as const })),
      { surveyId: "s2", code: "PHQ", domain: "suicide" },
    ];
    const groups = clinicalPicture(many, domains);
    // тяжёлое первым: «виражена» полоса личностной шкалы — выше СР-45 без полосы
    expect(groups.map((g) => g.domain)).toEqual(["personality", "suicide"]);
    const folded = groups[0]!.rows[0]!;
    expect(folded.scale.scaleId).toBe("a5");
    // сокращение перед названием в кавычках — код (instrumentCode в shared/format.ts)
    expect(folded.code).toBe("БОО");
    expect(folded.scaleTitle).toBe("Шкала 6");
    expect(folded.folded).toBe(7);
    expect(groups[1]!.rows).toHaveLength(1);
  });

  test("методика о разном (DASS-21, PHQ-4) — строками в своих доменах", () => {
    const two = dynamics([[at(0), 5]]);
    const sv = two.surveys[0]!;
    sv.title = "Депресія, тривога, стрес (DASS-21)";
    sv.scales = [
      { ...sv.scales[0]!, scaleId: "d", code: "D", title: "Депресія" },
      { ...sv.scales[0]!, scaleId: "a", code: "A", title: "Тривога" },
    ];
    const groups = clinicalPicture(two, [
      { surveyId: "s1", code: "D", domain: "depression" },
      { surveyId: "s1", code: "A", domain: "anxiety" },
    ]);
    expect(groups.map((g) => [g.domain, g.rows.map((r) => r.scaleTitle)])).toEqual([
      ["depression", ["Депресія"]],
      ["anxiety", ["Тривога"]],
    ]);
    expect(groups.every((g) => g.rows.every((r) => r.folded === 0))).toBe(true);
  });

  test("порядок: открытый сигнал первым, потом тяжесть, при равенстве — клинический порядок доменов", () => {
    const d = banded([[at(0), 6]]);
    const sleep = { ...d.surveys[0]!, surveyId: "s2", title: "Безсоння (SCI)" };
    const anxiety = { ...d.surveys[0]!, surveyId: "s3", title: "Тривога (GAD-7)" };
    d.surveys.push(sleep, anxiety);
    const domains: PatientCardDomain[] = [
      { surveyId: "s1", code: "PHQ", domain: "depression" },
      { surveyId: "s2", code: "PHQ", domain: "sleep" },
      { surveyId: "s3", code: "PHQ", domain: "anxiety" },
    ];
    // тяжесть одна (ни у кого нет полосы в точке) — домены в клиническом порядке
    expect(clinicalPicture(d, domains).map((g) => g.domain)).toEqual(["depression", "anxiety", "sleep"]);
    // сигнал по сну — сон первым, и строка помечена
    const withSignal = clinicalPicture(d, domains, new Set(["r0"]));
    expect(withSignal.every((g) => g.signal)).toBe(true);
    const onlySleep = clinicalPicture(
      { ...d, surveys: d.surveys.map((s) => (s.surveyId === "s2" ? { ...s, scales: s.scales.map((sc) => ({ ...sc, points: sc.points.map((p) => ({ ...p, responseId: "sig" })) })) } : s)) },
      domains,
      new Set(["sig"]),
    );
    expect(onlySleep[0]!.domain).toBe("sleep");
    expect(onlySleep[0]!.rows[0]!.signal).toBe(true);
  });
});

describe("сигналы случая — по пункту или шкале, а не строкой на сигнал", () => {
  const sig = (id: string, kind: "option" | "band", key: string, label: string, severity: "moderate" | "severe", at: string) => ({
    id,
    responseId: `r-${id}`,
    kind,
    questionId: kind === "option" ? key : null,
    questionTitle: key,
    label,
    severity,
    at,
  });
  const cases = [
    {
      signals: [
        sig("1", "option", "q9", "PHQ-9: думки про смерть (кілька днів)", "moderate", at(-30)),
        sig("2", "option", "q9", "PHQ-9: думки про смерть (більше половини днів)", "severe", at(-1)),
        sig("3", "band", "Вираженість депресії", "Вираженість депресії: помірна", "moderate", at(-1)),
        sig("4", "band", "Індекс благополуччя", "Індекс благополуччя: дуже низьке", "severe", at(-2)),
        sig("5", "band", "Вираженість депресії", "Вираженість депресії: помірна", "moderate", at(-30)),
      ],
    },
  ] as unknown as AlertCase[];

  test("один пункт — одна строка со счётом и подписью самого тяжёлого сигнала", () => {
    const groups = signalGroups(cases);
    expect(groups.map((g) => [g.label, g.count])).toEqual([
      ["PHQ-9: думки про смерть (більше половини днів)", 2],
      ["Індекс благополуччя: дуже низьке", 1],
      ["Вираженість депресії: помірна", 2],
    ]);
  });

  test("тяжёлые первыми, при равенстве — ответ на пункт раньше полосы шкалы", () => {
    const groups = signalGroups(cases);
    expect(groups.map((g) => [g.severity, g.item])).toEqual([
      ["severe", true],
      ["severe", false],
      ["moderate", false],
    ]);
    expect(groups[0]!.lastAt).toBe(at(-1));
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
  });

  test("неявка после последней сессии — открыта; после неё пришёл — уже история", () => {
    expect(openNoShow(visits, NOW)?.id).toBe("v3");
    const after = visitsOf([...items, visit("v6", -1, "done")]);
    expect(openNoShow(after, NOW)).toBeNull();
  });

  test("открытые назначения — только не пройденные, со сроком", () => {
    expect(openAssignments(items).map((a) => [a.title, a.dueAt])).toEqual([["Безсоння", at(7)]]);
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
