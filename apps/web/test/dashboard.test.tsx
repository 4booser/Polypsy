import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { AlertCase, BandSpread, ConditionSummary, ConditionsResult, OverviewAnalytics, Page, Worklist } from "@quizzy/shared";
import { UI } from "@quizzy/shared";
import { ApiError } from "../src/api";
import { LangProvider } from "../src/lang";
import { ConditionsBody, DomainRow } from "../src/pages/dashboard/parts";
import { PassesWidget } from "../src/pages/dashboard/passes";
import { CasesWidget, WorkWidget } from "../src/pages/dashboard/widgets";
import { ActNow, unlessForbidden } from "../src/pages/today/ActNow";
import { byCount, withCount } from "../src/ui/plural";
import {
  addDays,
  dailyColumns,
  dropWidget,
  fill,
  mondayOf,
  moveWidget,
  passColumns,
  passSummary,
  periodTotals,
  saveQueue,
  shareState,
  sparkValues,
  spreadParts,
  weekdayOf,
  weeklyColumns,
  widgetLayout,
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
/* классом целиком: «shadow-tile» и «band-card» — токены набора, а не наследие */
const LEGACY = [/class="(?:[^"]*\s)?(?:card|tile|badge|btn)(?:\s[^"]*)?"/, /\buppercase\b/];

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

describe("віджети: порядок и выключенные", () => {
  test("порядок из профиля, незнакомые ключи пропущены, новые — в конце своим порядком", () => {
    const l = widgetLayout({ order: ["work", "нет такого", "cases"], hidden: ["collect", "cases", "чужой"] });
    expect(l.order).toEqual(["work", "cases", "day", "missed", "passes", "collect", "conditions"]);
    // случаи риска не выключаются, что бы ни пришло в профиле
    expect([...l.hidden]).toEqual(["collect"]);
    expect(widgetLayout(null).order[0]).toBe("cases");
  });

  test("Alt ↑ / Alt ↓ двигает на одно место, у края — никуда", () => {
    const order = widgetLayout(null).order;
    expect(moveWidget(order, "day", -1).slice(0, 2)).toEqual(["day", "cases"]);
    expect(moveWidget(order, "cases", -1)).toEqual(order);
    expect(moveWidget(order, "conditions", 1)).toEqual(order);
  });

  test("перетаскивание ставит віджет на место другого", () => {
    const order = widgetLayout(null).order;
    expect(dropWidget(order, "passes", "cases").slice(0, 2)).toEqual(["passes", "cases"]);
    expect(dropWidget(order, "cases", "day").slice(0, 2)).toEqual(["day", "cases"]);
  });
});

describe("проходження: окна и сводка", () => {
  const tl = [
    { date: "2026-09-07", count: 6 }, // предыдущее окно
    { date: "2026-10-03", count: 2 }, // суббота
    { date: "2026-10-05", count: 4 }, // понедельник
    { date: "2026-10-01", count: 3 }, // четверг — тот же день неделей раньше
    { date: "2026-10-08", count: 5 }, // четверг — сегодня
  ];

  test("будни и выходные различаются, последний столбец — сегодня, средняя линия — предыдущее окно", () => {
    expect(weekdayOf("2026-10-03")).toBe(5);
    expect(weekdayOf("2026-10-05")).toBe(0);
    const { columns, mean } = passColumns(tl, "30d", "2026-10-08", (d) => d);
    expect(columns).toHaveLength(30);
    expect(columns.at(-1)).toMatchObject({ key: "2026-10-08", value: 5, current: true, weekend: false });
    expect(columns.find((c) => c.key === "2026-10-03")!.weekend).toBe(true);
    expect(mean).toBeCloseTo(6 / 30);
  });

  test("по неделям: двенадцать, текущая ещё идёт", () => {
    const { columns } = passColumns(tl, "12w", "2026-10-08", (d) => d);
    expect(columns).toHaveLength(12);
    expect(columns.at(-1)).toMatchObject({ key: "2026-10-05", value: 9, partial: true });
  });

  test("сводка: итог рядом с прошлым окном, средний будний, сегодня и неделю назад", () => {
    const s = passSummary(tl, 30, "2026-10-08");
    expect(s).toMatchObject({ current: 14, previous: 6, changePct: 133, today: 5, weekAgo: 3 });
    // будних дней в окне 22, сдано в трёх из них: 3 + 4 + 5
    expect(s.weekdayMean).toBeCloseTo(12 / 22, 1);
    expect(passSummary([], 30, "2026-10-08").changePct).toBeNull();
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
    expect(html).toContain("27 %");
    expect(either(html, "dash.shareHidden")).toBe(true);
    expect(either(html, "dash.noBands")).toBe(true);
    expect(either(html, "dash.tooFew")).toBe(true);
  });

  test("направления без замеров — строками со словами, а не пустыми полосами", () => {
    expect(either(html, "dash.noMeasures")).toBe(true);
    expect(either(html, "dash.dom.burnout")).toBe(true);
  });

  test("у благополучия среднее подписано «вище — краще»", () => {
    const well = draw(<DomainRow d={summary({ domain: "wellbeing", higherIsWorse: false })} />);
    expect(either(well, "dash.higherBetter")).toBe(true);
    expect(either(well, "dash.higherWorse")).toBe(false);
  });

  test("«замало даних» не печатает ни среднего, ни людей", () => {
    const few = draw(<DomainRow d={conditions.domains[3]!} />);
    expect(either(few, "dashA.ofMaxShort")).toBe(false);
    expect(either(few, "dash.tooFew")).toBe(true);
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
  unreliableCount: 0,
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
      const html = draw(<PassesWidget overview={overview(tl)} />);
      expect(html).not.toContain("NaN");
      expect(html).not.toContain("undefined");
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

/** Разметка строки віджета очереди — по её ссылке в отобранную очередь */
const rowOf = (html: string, kind: string) => {
  const at = html.indexOf(`href="/worklist?kind=${kind}"`);
  return at === -1 ? "" : html.slice(at, html.indexOf("</a>", at));
};

describe("очередь и случаи: рисование", () => {
  test("віджет очереди: виды с именами, ссылка в отобранную очередь, код состояния не торчит", () => {
    const html = draw(<WorkWidget work={work} />);
    expect(html).toContain("Коваленко Андрій");
    expect(html).toContain("71");
    expect(either(html, "work.filterFollowups")).toBe(true);
    expect(html).not.toMatch(/>[^<]*\bcreated\b/);
    for (const re of LEGACY) expect(html).not.toMatch(re);
  });

  test("янтарь у числа — только у просроченных видов, не у направлений", () => {
    const html = draw(<WorkWidget work={work} />);
    const amberCount = /text-\[17px\][^"]*text-warn/;
    for (const kind of ["dispensary", "followup", "assignment"]) expect(rowOf(html, kind)).toMatch(amberCount);
    expect(rowOf(html, "referral")).not.toBe("");
    expect(rowOf(html, "referral")).not.toMatch(amberCount);
  });

  test("разбор не положен — віджета случаев нет вовсе", () => {
    expect(draw(<CasesWidget alerts={null} meId={null} />)).toBe("");
  });

  test("случаев нет — спокойная строка, а не пустая панель", () => {
    const empty: Page<AlertCase> = { items: [], nextCursor: null, total: 0 };
    const html = draw(<CasesWidget alerts={empty} meId={null} />);
    expect(either(html, "dashA.noCases")).toBe(true);
    for (const re of LEGACY) expect(html).not.toMatch(re);
  });

  /*
   * Віджет случаев риска не выключается — и сбой загрузки не вправе убрать
   * его тише настройки: прежде любой отказ выглядел как «разбор не
   * положен», віджет исчезал, а шапка писала «Відкритих випадків 0».
   */
  test("случаи не загрузились — віджет на месте, говорит об отказе и даёт «повторити», а не «немає»", () => {
    const html = draw(<CasesWidget alerts={null} meId={null} error="Сервер не відповідає" onRetry={() => {}} />);
    expect(html).not.toBe("");
    expect(either(html, "dayA.casesFailed")).toBe(true);
    expect(html).toContain("Сервер не відповідає");
    expect(either(html, "common.retry")).toBe(true);
    expect(html).toContain('role="alert"');
    expect(either(html, "dashA.noCases")).toBe(false);
  });

  test("случаи ещё в пути — скелет, а не «немає»", () => {
    const html = draw(<CasesWidget alerts={null} meId={null} loading />);
    expect(html).not.toBe("");
    expect(html).toContain('role="status"');
    expect(either(html, "dashA.noCases")).toBe(false);
  });

  test("перечитывание не удалось — прежнее «немає» больше не утверждается", () => {
    const empty: Page<AlertCase> = { items: [], nextCursor: null, total: 0 };
    const html = draw(<CasesWidget alerts={empty} meId={null} error="Сервер не відповідає" />);
    expect(either(html, "dayA.casesFailed")).toBe(true);
    expect(either(html, "dashA.noCases")).toBe(false);
  });
});

describe("числа со словами — по правилу языка", () => {
  /*
   * «1 сесій», «3 швидких дій», «0 з 1 входів», «За 84 днів» — строки дня
   * подставляли число в одну форму слова. Форма — по Intl.PluralRules.
   */
  const t = (key: keyof typeof UI, lang: "uk" | "ru" | "en") => (UI[key] as Record<string, string>)[lang]!;

  test("сесії, люди, віджети, швидкі дії — одна, кілька, багато", () => {
    expect([1, 3, 5, 21, 22, 25].map((n) => withCount(t("dayA.sessionsN", "uk"), n, "uk"))).toEqual([
      "1 сесія",
      "3 сесії",
      "5 сесій",
      "21 сесія",
      "22 сесії",
      "25 сесій",
    ]);
    expect([1, 3, 5].map((n) => withCount(t("dayA.sessionsN", "ru"), n, "ru"))).toEqual(["1 сессия", "3 сессии", "5 сессий"]);
    expect([1, 3].map((n) => withCount(t("dayA.sessionsN", "en"), n, "en"))).toEqual(["1 session", "3 sessions"]);
    expect([1, 2, 7].map((n) => withCount(t("dashA.peopleN", "uk"), n, "uk"))).toEqual(["1 людина", "2 людини", "7 людей"]);
    expect([1, 2, 7].map((n) => withCount(t("dashA.peopleN", "ru"), n, "ru"))).toEqual(["1 человек", "2 человека", "7 человек"]);
    expect([1, 4, 7].map((n) => withCount(t("dashA.nWidgets", "uk"), n, "uk"))).toEqual(["1 віджет", "4 віджети", "7 віджетів"]);
    expect([1, 2, 6].map((n) => withCount(t("dayA.nActions", "uk"), n, "uk"))).toEqual(["1 швидка дія", "2 швидкі дії", "6 швидких дій"]);
    expect([1, 2, 5].map((n) => withCount(t("dashA.casesSub", "uk"), n, "uk"))).toEqual(["1 відкритий", "2 відкриті", "5 відкритих"]);
  });

  test("форма — по числу, о котором речь: «0 з 1 входу», «За 84 дні»", () => {
    expect(fill(byCount(t("invA.entriesOf", "uk"), 1, "uk"), { n: 0, of: 1 })).toBe("0 з 1 входу");
    expect(fill(byCount(t("invA.entriesOf", "uk"), 5, "uk"), { n: 0, of: 5 })).toBe("0 з 5 входів");
    expect(fill(byCount(t("invA.entriesOf", "ru"), 1, "ru"), { n: 0, of: 1 })).toBe("0 из 1 входа");
    expect(withCount(t("dashA.sumWindow", "uk"), 84, "uk")).toBe("За 84 дні");
    expect(withCount(t("dashA.sumWindow", "uk"), 30, "uk")).toBe("За 30 днів");
    expect(withCount(t("dashA.sumWindow", "ru"), 84, "ru")).toBe("За 84 дня");
    // строка без форм — как есть
    expect(withCount(t("dashA.casesSub", "en"), 2, "en")).toBe("2 open");
  });

  test("віджет «Прийом сьогодні» и случаи — формой, а не «1 сесій» и «1 відкриті»", () => {
    const one: Page<AlertCase> = { items: [], nextCursor: null, total: 1 };
    const html = draw(<CasesWidget alerts={one} meId={null} />);
    expect(html).toMatch(/1 (відкритий|открытый)/);
    expect(html).not.toMatch(/1 (відкриті|открыто)\b/);
  });
});

describe("«Налаштувати зведення»: сохранение по очереди", () => {
  /*
   * Через useAction второе сохранение, пришедшее в полёте первого,
   * отбрасывалось молча: два щелчка по переключателям — и на экране одно,
   * а в профиле прежнее.
   */
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("пришедшее в полёте не теряется: уходит следом одним запросом, последним словом", async () => {
    const sent: object[] = [];
    const gates: (() => void)[] = [];
    let idle = 0;
    const push = saveQueue<{ order?: string[]; hidden?: string[] }>(
      (p) => {
        sent.push(p);
        return new Promise<void>((r) => gates.push(r));
      },
      { idle: () => idle++ },
    );
    const all = push({ order: ["a", "b"] });
    void push({ order: ["b", "a"] });
    void push({ hidden: ["work"] });
    expect(sent).toEqual([{ order: ["a", "b"] }]);
    gates.shift()!();
    await tick();
    expect(sent).toEqual([{ order: ["a", "b"] }, { order: ["b", "a"], hidden: ["work"] }]);
    expect(idle).toBe(0);
    gates.shift()!();
    await all;
    expect(idle).toBe(1);
  });

  test("отказ одного сохранения не останавливает следующие", async () => {
    const sent: object[] = [];
    const failed: unknown[] = [];
    let first = true;
    const push = saveQueue<{ density?: string }>(
      async (p) => {
        sent.push(p);
        if (first) {
          first = false;
          await tick();
          throw new Error("сервер не відповідає");
        }
      },
      { failed: (e) => failed.push(e) },
    );
    const all = push({ density: "compact" });
    void push({ density: "cozy" });
    await all;
    expect(sent).toEqual([{ density: "compact" }, { density: "cozy" }]);
    expect(failed).toHaveLength(1);
  });
});

describe("«Дія зараз»: случаи не загрузились", () => {
  const act = (over: Partial<Parameters<typeof ActNow>[0]> = {}) =>
    draw(<ActNow cases={null} work={[]} appointments={[]} meId={null} onReply={() => {}} {...over} />);

  test("отказ загрузки — словами с «повторити», а не зелёное «нічого термінового»", () => {
    const html = act({ casesError: "Сервер не відповідає", onRetryCases: () => {} });
    expect(either(html, "dayA.casesFailed")).toBe(true);
    expect(either(html, "common.retry")).toBe(true);
    expect(either(html, "dayA.nothingUrgent")).toBe(false);
  });

  test("разбор не положен, а в очереди срочного нет — «нічого термінового», как и прежде", () => {
    expect(either(act(), "dayA.nothingUrgent")).toBe(true);
  });

  test("без героя просроченное встаёт плитками в сетку, а не столбцом во всю ширину", () => {
    const overdue = work.items.filter((i) => i.overdue && i.kind !== "message");
    expect(overdue.length).toBeGreaterThan(0);
    const html = act({ cases: [], work: work.items });
    // «contents» вместе с «flex» решала очерёдность стилей — побеждал столбец
    expect(html).toContain('class="contents"');
    expect(html).not.toMatch(/class="[^"]*\bflex\b[^"]*\bcontents\b[^"]*"/);
  });

  test("отказ в праве (403) — «разбор не положен», прочие отказы идут дальше", async () => {
    expect(await unlessForbidden(Promise.reject(new ApiError("заборонено", 403)))).toBeNull();
    await expect(unlessForbidden(Promise.reject(new ApiError("сервер не відповідає", 503)))).rejects.toThrow("сервер не відповідає");
    await expect(unlessForbidden(Promise.reject(new ApiError("немає зв'язку", 0)))).rejects.toThrow();
    expect(await unlessForbidden(Promise.resolve(5))).toBe(5);
  });
});
