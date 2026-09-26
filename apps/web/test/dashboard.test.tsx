import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { AlertCase, BandSpread, ConditionSummary, ConditionsResult, OverviewAnalytics, Page, Worklist } from "@quizzy/shared";
import { UI } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { Attention, Passes, WorkQueue } from "../src/pages/Dashboard";
import { ConditionsBody, DomainCard } from "../src/pages/dashboard/parts";
import {
  addDays,
  dailyColumns,
  mondayOf,
  periodTotals,
  shareState,
  sparkValues,
  spreadParts,
  weeklyColumns,
  workTiles,
  type BandLabels,
} from "../src/pages/dashboard/model";

/**
 * Стартовый экран «Зведення»: арифметика рядов и долей и рисование на краях.
 *
 * Ряды считаются от переданного «сегодня», а не от часов машины: проверка
 * «30 столбцов, последний — сегодня» иначе зависела бы от дня запуска и от
 * часового пояса, в котором стоит машина сборки.
 */

const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

/** Строка словаря на любом из языков: язык в тестовом процессе не назначается */
const either = (html: string, key: keyof typeof UI) => {
  const e = UI[key] as { uk: string; ru: string };
  return html.includes(e.uk) || html.includes(e.ru);
};

/* наследие «Пульта», которого в переделанном экране быть не должно */
const LEGACY = [/class="[^"]*\bcard\b/, /class="[^"]*\btile\b/, /class="[^"]*\bbadge\b/, /class="[^"]*\bbtn\b/, /\buppercase\b/];

describe("даты рядов", () => {
  test("понедельник недели режется как date_trunc('week')", () => {
    expect(mondayOf("2026-09-26")).toBe("2026-09-21"); // суббота
    expect(mondayOf("2026-09-27")).toBe("2026-09-21"); // воскресенье — ещё та же неделя
    expect(mondayOf("2026-09-21")).toBe("2026-09-21");
    expect(mondayOf("2026-03-01")).toBe("2026-02-23"); // через границу месяца
  });

  test("сложение дней не спотыкается о переход на летнее время", () => {
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-10-24", 3)).toBe("2026-10-27");
  });
});

describe("проходження: ряды", () => {
  const timeline = [
    { date: "2026-08-10", count: 4 }, // за пределами 30 дней, но в предыдущем окне
    { date: "2026-09-01", count: 3 },
    { date: "2026-09-20", count: 2 }, // воскресенье
    { date: "2026-09-21", count: 5 }, // понедельник
    { date: "2026-09-26", count: 1 },
  ];

  test("по дням: 30 столбцов подряд, последний — сегодня, пустые дни — нулём", () => {
    const cols = dailyColumns(timeline, 30, "2026-09-26", (d) => d);
    expect(cols.length).toBe(30);
    expect(cols.at(-1)!.key).toBe("2026-09-26");
    expect(cols[0]!.key).toBe("2026-08-28");
    expect(cols.find((c) => c.key === "2026-09-25")!.value).toBe(0);
    expect(cols.reduce((s, c) => s + c.value, 0)).toBe(3 + 2 + 5 + 1);
  });

  test("по неделям: 12 недель, последняя — текущая, неделя с понедельника", () => {
    const cols = weeklyColumns(timeline, 12, "2026-09-26", (d) => d);
    expect(cols.length).toBe(12);
    expect(cols.at(-1)!.key).toBe("2026-09-21");
    expect(cols.at(-1)!.value).toBe(5 + 1);
    // воскресенье 20-го — ещё прошлая неделя
    expect(cols.at(-2)!.key).toBe("2026-09-14");
    expect(cols.at(-2)!.value).toBe(2);
  });

  test("итог окна рядом с таким же окном перед ним", () => {
    expect(periodTotals(timeline, 30, "2026-09-26")).toEqual({ current: 11, previous: 4 });
  });
});

describe("очередь: плитки", () => {
  test("пустые виды не показываются, янтарь — только у просроченных", () => {
    const tiles = workTiles({ noshow: 0, message: 2, dispensary: 17, followup: 88, referral: 9, assignment: 0 });
    expect(tiles.map((t) => t.kind)).toEqual(["message", "dispensary", "followup", "referral"]);
    expect(tiles.filter((t) => t.attention).map((t) => t.kind)).toEqual(["dispensary", "followup"]);
  });
});

const labels: BandLabels = {
  severity: { none: "Норма", mild: "Легка", moderate: "Помірна", severe: "Виражена" },
  low: "Норма або легка",
  high: "Помірна або виражена",
};

const spread = (s: Partial<BandSpread> & Pick<BandSpread, "bands">): BandSpread => ({
  banded: 0,
  clinical: { count: null, percent: null },
  ...s,
});

describe("стан: доли по ступеням", () => {
  test("все ступени видны — четыре части", () => {
    const parts = spreadParts(
      spread({ banded: 21, clinical: { count: 10, percent: 48 }, bands: { none: 6, mild: 5, moderate: 5, severe: 5 } }),
      labels,
    );
    expect(parts.map((p) => p.value)).toEqual([6, 5, 5, 5]);
  });

  test("скрытая пара — одна часть с суммой половины, полоса остаётся целой", () => {
    const parts = spreadParts(
      spread({ banded: 48, clinical: { count: 13, percent: 27 }, bands: { none: null, mild: null, moderate: 6, severe: 7 } }),
      labels,
    );
    expect(parts.map((p) => [p.label, p.value])).toEqual([
      ["Норма або легка", 35],
      ["Помірна", 6],
      ["Виражена", 7],
    ]);
    expect(parts.reduce((s, p) => s + (p.value ?? 0), 0)).toBe(48);
  });

  test("скрытая доля — полосы нет вовсе", () => {
    const s = spread({ banded: 16, bands: { none: null, mild: null, moderate: null, severe: null } });
    expect(spreadParts(s, labels)).toEqual([]);
    expect(shareState(s, 16)).toBe("hidden");
  });

  test("состояния доли различаются словами, а не одним прочерком", () => {
    expect(shareState(spread({ banded: 0, bands: { none: 0, mild: 0, moderate: 0, severe: 0 } }), 6)).toBe("noBands");
    expect(shareState(spread({ banded: null, bands: { none: null, mild: null, moderate: null, severe: null } }), null)).toBe("few");
    expect(
      shareState(spread({ banded: 10, clinical: { count: 5, percent: 50 }, bands: { none: 5, mild: 0, moderate: 0, severe: 5 } }), 10),
    ).toBe("shown");
  });

  test("ход по неделям без недель под порогом", () => {
    expect(
      sparkValues([
        { week: "2026-09-07", meanPercent: null },
        { week: "2026-09-14", meanPercent: 31 },
        { week: "2026-09-21", meanPercent: 28 },
      ]),
    ).toEqual([31, 28]);
  });
});

/* ─────────── рисование ─────────── */

const summary = (over: Partial<ConditionSummary> & Pick<ConditionSummary, "domain">): ConditionSummary => ({
  higherIsWorse: true,
  people: 48,
  spread: { banded: 48, clinical: { count: 13, percent: 27 }, bands: { none: null, mild: null, moderate: 6, severe: 7 } },
  primary: { surveyId: "s-phq9", title: "Депресія (PHQ-9)", people: 48, meanPercent: 24 },
  weeks: [
    { week: "2026-09-07", meanPercent: 26 },
    { week: "2026-09-14", meanPercent: null },
    { week: "2026-09-21", meanPercent: 22 },
  ],
  sources: [{ surveyId: "s-phq9", title: "Депресія (PHQ-9)" }],
  ...over,
});

const conditions: ConditionsResult = {
  days: 90,
  since: "2026-06-28T00:00:00.000Z",
  domains: [
    summary({ domain: "depression" }),
    summary({
      domain: "anxiety",
      people: 48,
      spread: { banded: 48, clinical: { count: null, percent: null }, bands: { none: null, mild: null, moderate: null, severe: null } },
    }),
    summary({
      domain: "stress",
      people: 23,
      spread: { banded: 0, clinical: { count: null, percent: null }, bands: { none: 0, mild: 0, moderate: 0, severe: 0 } },
    }),
    summary({
      domain: "ptsd",
      people: null,
      spread: { banded: null, clinical: { count: null, percent: null }, bands: { none: null, mild: null, moderate: null, severe: null } },
      primary: { surveyId: "s-pcl5", title: "ПТСР (PCL-5)", people: null, meanPercent: null },
      weeks: [],
    }),
    summary({ domain: "wellbeing", higherIsWorse: false }),
  ],
  empty: ["burnout", "alcohol"],
  overall: {
    people: 61,
    spread: { banded: 58, clinical: { count: 24, percent: 41 }, bands: { none: 20, mild: 14, moderate: 12, severe: 12 } },
  },
};

describe("стан: рисование", () => {
  const html = draw(<ConditionsBody data={conditions} />);

  test("ни одного NaN и ни одного undefined в разметке", () => {
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });

  test("доля показана, скрытое и отсутствующее — словами", () => {
    expect(html).toContain("27");
    expect(either(html, "dash.shareHidden")).toBe(true);
    expect(either(html, "dash.noBands")).toBe(true);
    expect(either(html, "dash.tooFew")).toBe(true);
  });

  test("направления без замеров — одной строкой", () => {
    expect(either(html, "dash.noMeasures")).toBe(true);
    expect(either(html, "dash.dom.burnout")).toBe(true);
  });

  test("у благополучия среднее подписано «вище — краще»", () => {
    const well = draw(<DomainCard d={summary({ domain: "wellbeing", higherIsWorse: false })} />);
    expect(either(well, "dash.higherBetter")).toBe(true);
    expect(either(well, "dash.higherWorse")).toBe(false);
  });

  test("«замало даних» не печатает ни среднего, ни людей", () => {
    const few = draw(<DomainCard d={conditions.domains[3]!} />);
    expect(either(few, "dash.mean")).toBe(false);
    expect(either(few, "dash.people")).toBe(false);
  });

  test("без замеров вовсе — фраза, а не пустой раздел", () => {
    const none = draw(<ConditionsBody data={{ ...conditions, domains: [], empty: ["depression"] }} />);
    expect(either(none, "dash.nothingMeasured")).toBe(true);
    expect(none).not.toContain("NaN");
  });

  test("без наследия «Пульта»", () => {
    for (const re of LEGACY) expect(html).not.toMatch(re);
  });
});

const overview = (timeline: OverviewAnalytics["timeline"]): OverviewAnalytics => ({
  surveyCount: 27,
  publishedCount: 20,
  responseCount: 1641,
  respondentCount: 122,
  avgDurationMs: 48_600,
  completionRate: 100,
  topSurveys: [],
  severityBreakdown: [],
  timeline,
  inProgress: [],
});

describe("проходження: рисование", () => {
  test("пустой ряд и ряд с данными рисуются без NaN", () => {
    for (const tl of [[], [{ date: "2026-09-20", count: 7 }]]) {
      const html = draw(<Passes overview={overview(tl)} />);
      expect(html).not.toContain("NaN");
      expect(html).toContain("1641");
      for (const re of LEGACY) expect(html).not.toMatch(re);
    }
  });
});

const work: Worklist = {
  items: [
    {
      kind: "followup",
      id: "w1",
      userId: "u1",
      userName: "Коваленко Андрій",
      unit: "Рота А",
      title: "PHQ-9",
      days: 4,
      overdue: true,
      assignedTo: null,
      since: "2026-09-20T10:00:00.000Z",
      href: "/patients/u1",
    },
    {
      kind: "referral",
      id: "w2",
      userId: "u2",
      userName: "Шевчук Олена",
      unit: null,
      title: "created",
      days: 2,
      overdue: false,
      assignedTo: null,
      since: "2026-09-24T10:00:00.000Z",
      href: "/referrals",
    },
  ],
  total: 71,
  truncated: false,
  byKind: { noshow: 0, message: 0, dispensary: 17, followup: 88, referral: 9, assignment: 12 },
  mine: 0,
};

describe("очередь и внимание: рисование", () => {
  test("строка очереди: имя ссылкой, «Прострочено» меткой обычным регистром, код состояния не торчит", () => {
    const html = draw(<WorkQueue work={work} inProgress={[]} />);
    expect(html).toContain("Коваленко Андрій");
    expect(html).toContain("text-[17px]");
    expect(either(html, "dash.overdueTag")).toBe(true);
    // направление описано словами, а не кодом «created»
    expect(html).not.toMatch(/>[^<]*\bcreated\b/);
    expect(html).toContain("71");
    for (const re of LEGACY) expect(html).not.toMatch(re);
  });

  test("янтарь — у случаев на разбор и просроченных плиток, не у направлений", () => {
    const alerts: Page<AlertCase> = { items: [], nextCursor: null, total: 3 };
    const html = draw(<Attention alerts={alerts} work={work} />);
    expect(either(html, "dash.casesOpen")).toBe(true);
    const amber = html.split("text-accent").length - 1;
    // число случаев + три просроченных вида (облік, повтори, призначення); «Направлення» — без янтаря
    expect(amber).toBe(1 + 3);
    for (const re of LEGACY) expect(html).not.toMatch(re);
  });

  test("нечего разбирать и очередь пуста — блока нет вовсе", () => {
    const html = draw(
      <Attention alerts={null} work={{ ...work, byKind: { noshow: 0, message: 0, dispensary: 0, followup: 0, referral: 0, assignment: 0 } }} />,
    );
    expect(html).toBe("");
  });
});
