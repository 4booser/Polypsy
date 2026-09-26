import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { AlertCase, AlertCaseFacets, AlertCasePage, Worklist } from "@quizzy/shared";
import { UI } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { PersonCases, QueueRow } from "../src/pages/Alerts";
import { Attention } from "../src/pages/Dashboard";
import {
  hasNarrowing,
  isDay,
  queueQuery,
  queueSections,
  readFilters,
  subtitleParts,
  uniqueRows,
  waitingMinutes,
  withCount,
} from "../src/pages/alerts/model";

/**
 * Очередь случаев: что уходит в запрос, как строки делятся на разделы и
 * откуда берутся числа (w12:alerts).
 *
 * Главное, что здесь закреплено: числа экрана — подзаголовок, разделы,
 * варианты фильтров — берутся из счётчиков сервера, а не из загруженных
 * строк. Проверки нарочно подают страницу, в которой строк меньше, чем
 * говорят счётчики: на сотнях случаев так и есть всегда.
 */

const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

const either = (html: string, key: keyof typeof UI) => {
  const e = UI[key] as { uk: string; ru: string };
  return html.includes(e.uk) || html.includes(e.ru);
};

/* класс наследия — отдельным словом в списке классов, а не частью утилиты (`text-muted` — не `muted`) */
const LEGACY = [/class="(?:[^"]* )?(card|tile|row|chip|btn|hint|muted|queue-[\w-]+|segmented)(?: |")/];

let n = 0;
function row(over: Partial<AlertCase> = {}): AlertCase {
  n += 1;
  return {
    id: `case-${n}`,
    userId: `user-${n}`,
    userName: `Людина ${n}`,
    unit: "Рота 1",
    surveyId: "s1",
    surveyTitle: "Скринінг",
    severity: "severe",
    openedAt: "2026-09-26T08:00:00.000Z",
    lastAlertAt: "2026-09-26T09:00:00.000Z",
    signalCount: 1,
    signals: [],
    minutesOpen: 30,
    overdue: false,
    assignedTo: null,
    assignedToName: null,
    acknowledgedBy: null,
    acknowledgedByName: null,
    acknowledgedAt: null,
    note: null,
    outcome: null,
    mergedFromLegacy: false,
    ...over,
  };
}

const facets: AlertCaseFacets = {
  total: 420,
  severity: { severe: 140, moderate: 284 },
  sections: { severe: 140, moderate: 280 },
  assigned: { me: 84, none: 258, others: 84 },
  overdue: 380,
  oldestOpenedAt: "2026-09-17T12:00:00.000Z",
};

const params = (q: Record<string, string>) => (name: string) => q[name] ?? "";

describe("отбор из адреса", () => {
  test("прежний all=1 из сохранённых видов читается как «усі»; статус из адреса главнее", () => {
    expect(readFilters(params({ all: "1" })).status).toBe("all");
    expect(readFilters(params({ all: "1", status: "open" })).status).toBe("open");
    expect(readFilters(params({ status: "resolved" })).status).toBe("resolved");
    expect(readFilters(params({})).status).toBe("open");
  });

  test("незнакомое значение не применяется, а не роняет экран в 400", () => {
    const f = readFilters(
      params({
        severity: "critical",
        assigned: "somebody",
        patient: "not-a-uuid",
        patientGroup: "42",
        from: "2026-02-31",
        status: "bogus",
      }),
    );
    expect(f).toMatchObject({ severity: "", assigned: "", patient: "", patientGroup: "", from: "", status: "open" });
    expect(isDay("2026-02-28")).toBe(true);
    expect(isDay("2026-02-31")).toBe(false);
  });

  test("перевёрнутый период не применяется целиком", () => {
    const f = readFilters(params({ from: "2026-09-10", to: "2026-09-01" }));
    expect(f.from).toBe("2026-09-10");
    expect(f.to).toBe("");
  });

  test("в запрос уходит только заданное; отбор по человеку — списком его случаев", () => {
    const base = readFilters(params({}));
    const q = queueQuery(base, 30);
    expect(q).toMatchObject({ status: "open", limit: "30" });
    expect(q.group).toBeUndefined();
    expect(q.severity).toBeUndefined();
    expect(hasNarrowing(base)).toBe(false);

    const person = readFilters(params({ patient: "0b8f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", q: "  Коваль " }));
    const pq = queueQuery(person, 30, "CURSOR");
    expect(pq.group).toBe("case");
    expect(pq.search).toBe("Коваль");
    expect(pq.cursor).toBe("CURSOR");
    expect(hasNarrowing(person)).toBe(true);
  });
});

describe("строки и разделы", () => {
  test("человек, пришедший второй страницей ещё раз, показывается один раз", () => {
    const a = row({ userId: "u-a" });
    const again = row({ userId: "u-a" });
    const b = row({ userId: "u-b" });
    expect(uniqueRows([a, b, again], "person").map((c) => c.id)).toEqual([a.id, b.id]);
    // без группировки строка — случай, и два случая одного человека — две строки
    expect(uniqueRows([a, b, again], "case").length).toBe(3);
  });

  test("разделы подписывают порядок сервера, а числа у них — по всей выборке", () => {
    const items = [row({ severity: "severe" }), row({ severity: "severe" }), row({ severity: "moderate" })];
    const sections = queueSections(items, facets);
    expect(sections.map((s) => [s.severity, s.items.length, s.total])).toEqual([
      ["severe", 2, 140],
      ["moderate", 1, 280],
    ]);
    // без счётчиков числа нет вовсе, а не «сколько загрузилось»
    expect(queueSections(items, undefined).map((s) => s.total)).toEqual([null, null]);
  });

  test("подзаголовок — из счётчиков, а не из загруженной страницы", () => {
    const words = { people: "Людей на розбір {n}", overdue: "прострочено", mine: "на мені", resolved: "R", all: "A" };
    expect(subtitleParts(facets, "open", words)).toBe("Людей на розбір 420 · прострочено 380 · на мені 84");
    expect(subtitleParts({ ...facets, overdue: 0, assigned: { ...facets.assigned, me: 0 } }, "open", words)).toBe(
      "Людей на розбір 420",
    );
    expect(subtitleParts(undefined, "open", words)).toBe("");
    expect(subtitleParts(facets, "resolved", words)).toBe("R");
    expect(withCount("Лише важкі", 140)).toBe("Лише важкі · 140");
    expect(withCount("Лише важкі", undefined)).toBe("Лише важкі");
  });

  test("строка человека ждёт с самого раннего его случая", () => {
    const now = Date.parse("2026-09-26T12:00:00.000Z");
    const grouped = row({
      minutesOpen: 10,
      group: { cases: 2, signals: 5, overdue: true, oldestOpenedAt: "2026-09-26T10:00:00.000Z" },
    });
    expect(waitingMinutes(grouped, now)).toBe(120);
    expect(waitingMinutes(row({ minutesOpen: 10 }), now)).toBe(10);
  });
});

describe("строка очереди: рисование", () => {
  test("янтарь — только у просроченных; «взяв» — фиолетовым; выраженность подписана для диктора", () => {
    const overdue = draw(
      <QueueRow
        c={row({ group: { cases: 2, signals: 4, overdue: true, oldestOpenedAt: "2026-09-26T08:00:00.000Z" } })}
        active={false}
        me="me"
        now={Date.parse("2026-09-26T12:00:00.000Z")}
        onPick={() => {}}
      />,
    );
    expect(overdue).toContain("text-accent");
    expect(overdue).toContain("data-queue-row");
    expect(either(overdue, "cases.overdue")).toBe(true);
    // число случаев человека — на строке
    expect(overdue).toMatch(/(випадків|случаев): 2/);
    // выраженность не одним цветом: форма точки и подпись для диктора
    expect(overdue).toContain("rotate-45");
    expect(either(overdue, "severity.severe")).toBe(true);

    const mine = draw(
      <QueueRow c={row({ assignedTo: "me", severity: "moderate" })} active me="me" now={Date.now()} onPick={() => {}} />,
    );
    expect(mine).not.toContain("text-accent");
    expect(mine).toContain('aria-current="true"');
    expect(mine).toContain("bg-primary-soft");
    for (const re of LEGACY) {
      expect(overdue).not.toMatch(re);
      expect(mine).not.toMatch(re);
    }
  });

  test("разобранная строка помечена и не просрочена", () => {
    const html = draw(
      <QueueRow
        c={row({ acknowledgedAt: "2026-09-26T10:00:00.000Z", outcome: "confirmed", overdue: true })}
        active={false}
        me="me"
        now={Date.now()}
        onPick={() => {}}
      />,
    );
    expect(html).toContain('data-done="true"');
    expect(html).not.toContain("text-accent");
    expect(either(html, "cases.confirmed")).toBe(true);
  });
});

describe("случаи человека в панели разбора", () => {
  test("перечислены по одному, выбранный отмечен не цветом одним, а aria-pressed; раздел — с линией 2px", () => {
    const a = row({ severity: "severe", surveyTitle: "Скринінг зони А" });
    const b = row({ severity: "moderate", surveyTitle: "Скринінг зони Б", overdue: true });
    const html = draw(
      <PersonCases total={2} cases={[a, b]} pickedId={a.id} onPick={() => {}} onShowPerson={() => {}} />,
    );
    expect(html).toContain("border-primary-rule");
    expect(html).toContain("Скринінг зони А");
    expect(html).toContain("Скринінг зони Б");
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    // выраженность каждого — меткой с формой точки
    expect(html).toContain("rotate-45");
    expect(either(html, "cases.showPersonCases")).toBe(true);
    for (const re of LEGACY) expect(html).not.toMatch(re);
  });
});

describe("сводка: случаи на разбор", () => {
  const work: Worklist = {
    items: [],
    total: 0,
    truncated: false,
    byKind: { noshow: 0, message: 0, dispensary: 0, followup: 0, referral: 0, assignment: 0 },
    mine: 0,
  };

  test("«термінових» и «найдовший чекає» — из счётчиков, а не из шести строк", () => {
    // шесть строк на странице, все тяжёлые и свежие; по всей очереди — 140 тяжёлых, самый давний — неделю
    const alerts: AlertCasePage = {
      items: Array.from({ length: 6 }, () => row({ openedAt: new Date().toISOString() })),
      nextCursor: "x",
      total: 420,
      grouping: "person",
      facets: { ...facets, oldestOpenedAt: new Date(Date.now() - 7 * 86_400_000 - 60_000).toISOString() },
    };
    const html = draw(<Attention alerts={alerts} work={work} />);
    expect(html).toContain("420");
    expect(html).toMatch(/: 140/);
    expect(html).not.toMatch(/: 6\b/);
    expect(html).toMatch(/\b7\b/);
  });
});
