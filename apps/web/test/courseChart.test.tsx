import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UI, measurementError, type DynamicsPoint, type UiKey } from "@quizzy/shared";
import { CourseChart, CoursePointTip } from "../src/charts/course";
import {
  DAY_MS,
  betterOf,
  changeVerdict,
  courseEventsFromTimeline,
  courseFromDynamics,
  courseLayout,
  freeSpot,
  pointTip,
  reliableThreshold,
  type CourseEvent,
  type CoursePoint,
} from "../src/charts/courseModel";
import { LangProvider } from "../src/lang";

/**
 * График курса (charts/course.tsx) на настоящих данных приложения:
 * динамика шкалы, лестница полос методики, порог надёжной зміни из основы RCI
 * и события хронологии. Проверяется то, что видит специалист: полосы с
 * границами, межі похибки от старта, «краще ↓», события на оси, подсказка
 * замера — и что прогноза без основания нет.
 */

const draw = (node: ReactNode) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);
const says = (html: string, key: UiKey) => {
  const e = UI[key] as { uk: string; ru: string; en: string };
  return [e.uk, e.ru, e.en].some((s) => html.includes(s));
};

const PHQ = [
  { min: 0, max: 4, label: "мінімальна", severity: "none" as const },
  { min: 5, max: 9, label: "легка", severity: "mild" as const },
  { min: 10, max: 14, label: "помірна", severity: "moderate" as const },
  { min: 15, max: 19, label: "помірно тяжка", severity: "severe" as const },
  { min: 20, max: 27, label: "тяжка", severity: "severe" as const },
];
/* благополучие: чем выше, тем лучше — лестница повёрнута */
const WHO = [
  { min: 0, max: 28, label: "дуже низьке", severity: "severe" as const },
  { min: 29, max: 50, label: "знижене", severity: "moderate" as const },
  { min: 51, max: 100, label: "норма", severity: "none" as const },
];

const T0 = Date.parse("2026-08-24T10:00:00Z");
const at = (days: number) => T0 + days * DAY_MS;
const iso = (days: number) => new Date(at(days)).toISOString();
const fmt = (s: string) => s.slice(5, 10).split("-").reverse().join(".");

const dp = (days: number, rawScore: number, over: Partial<DynamicsPoint> = {}): DynamicsPoint => ({
  responseId: `r${days}`,
  submittedAt: iso(days),
  rawScore,
  maxScore: 27,
  percent: Math.round((rawScore / 27) * 100),
  bandLabel: null,
  severity: null,
  percentile: null,
  versionNo: 1,
  ...over,
});

const course = (over: Partial<Parameters<typeof courseFromDynamics>[0]> = {}) =>
  courseFromDynamics(
    {
      points: [dp(45, 14), dp(0, 19), dp(18, 16)],
      sem: 2.2,
      reliableChange: { rci: -1.6, significant: false, direction: "down", basis: { sd: 5.5, alpha: 0.84, sampleN: 120 } },
      ...over,
    },
    PHQ,
    fmt,
  );

describe("данные приложения → график", () => {
  test("замеры по времени, полоса по лестнице, «краще ↓» по полосам", () => {
    const c = course();
    expect(c.points.map((p) => p.value)).toEqual([19, 16, 14]);
    expect(c.points[2]!.band).toEqual({ label: "помірна", severity: "moderate" });
    expect(c.better).toBe("down");
    expect(betterOf(WHO)).toBe("up");
    expect(betterOf([])).toBeNull();
  });

  test("порог надёжной зміни — MDC95 из основы RCI, иначе из SEM, иначе нет", () => {
    expect(course().rc).toBe(measurementError(5.5, 0.84)!.mdc95);
    expect(reliableThreshold({ sem: 2, reliableChange: null })).toBe(5.54);
    expect(reliableThreshold({ sem: null, reliableChange: null })).toBeNull();
    // старт из недостоверного протокола — межі похибки от него не рисуются
    expect(course({ points: [dp(0, 19, { reliable: false }), dp(18, 16)] }).rc).toBeNull();
  });

  test("замер другой версии со стартом не сравнивается — и подсказка говорит почему", () => {
    const c = course({ points: [dp(0, 19, { versionNo: 1 }), dp(18, 16, { versionNo: 2 })] });
    expect(c.points[1]!.incomparable).toBe("version");
    const tip = pointTip(c.points, 1, c.rungs, c.rc, c.better)!;
    expect(tip.fromStart).toBeNull();
    expect(says(draw(<CoursePointTip title="PHQ-9" tip={tip} rc={c.rc} base={19} />), "rch.versions")).toBe(true);
  });

  test("хронология → события: сессии, неявка, запланированные, сигнал; прочее — мимо", () => {
    const ev = courseEventsFromTimeline(
      [
        { id: "v1", kind: "visit", at: iso(4), title: "Савчук", detail: "done" },
        { id: "v2", kind: "visit", at: iso(39), title: "Савчук", detail: "no_show" },
        { id: "v3", kind: "visit", at: iso(47), title: "Савчук", detail: "booked" },
        { id: "a1", kind: "alert", at: iso(45), title: "PHQ-9, пункт 9", detail: "PHQ-9" },
        { id: "r1", kind: "response", at: iso(45), title: "PHQ-9" },
        { id: "f1", kind: "referral", at: iso(10), title: "психіатр" },
      ],
      fmt,
    );
    expect(ev.map((e) => e.kind)).toEqual(["session", "noshow", "signal", "planned"]);
    expect(ev[2]!.detail).toBe("PHQ-9, пункт 9");
  });
});

describe("слово сдвига", () => {
  test("ровно на пороге — ещё в межах похибки, за порогом — надёжно; без порога — не оценено", () => {
    expect(changeVerdict(-6, 6, "down")).toBe("within");
    expect(changeVerdict(-7, 6, "down")).toBe("better");
    expect(changeVerdict(7, 6, "down")).toBe("worse");
    expect(changeVerdict(16, 14, "up")).toBe("better");
    expect(changeVerdict(-7, 6, null)).toBe("changed");
    expect(changeVerdict(-7, null, "down")).toBe("unknown");
  });
});

describe("подсказка замера", () => {
  const c = course();
  test("старт: база и межі похибки от неё", () => {
    const tip = pointTip(c.points, 0, c.rungs, c.rc, c.better)!;
    expect(tip.baseline).toBe(true);
    expect(tip.fromStart).toBeNull();
    expect(tip.range).toEqual({ min: 15, max: 19 });
    const html = draw(<CoursePointTip title="PHQ-9" tip={tip} rc={c.rc} base={19} />);
    expect(html).toContain("PHQ-9, 24.08");
    expect(says(html, "course.start")).toBe(true);
    expect(html).toMatch(/19 ± 6[,.]1/);
  });

  test("последний: значение, полоса словом с границами, сдвиг от старта и от предыдущего", () => {
    const tip = pointTip(c.points, 2, c.rungs, c.rc, c.better)!;
    expect(tip.last).toBe(true);
    expect(tip.fromStart).toEqual({ delta: -5, verdict: "within" });
    expect(tip.fromPrev).toEqual({ delta: -2, label: "11.09" });
    const html = draw(<CoursePointTip title="PHQ-9" tip={tip} rc={c.rc} base={19} />);
    expect(html).toContain(">14</b>");
    expect(html).toContain("помірна");
    expect(html).toMatch(/10(<!-- -->)?–(<!-- -->)?14/);
    expect(html).toContain("−5");
    expect(html).toContain('data-verdict="within"');
    expect(says(html, "sum.withinError")).toBe(true);
    expect(html).toContain("−2");
  });

  test("надёжное улучшение — словом и зелёным", () => {
    const pts: CoursePoint[] = [
      { key: "a", t: at(0), label: "24.08", value: 52 },
      { key: "b", t: at(45), label: "08.10", value: 38 },
    ];
    const tip = pointTip(pts, 1, [], 11, "down")!;
    const html = draw(<CoursePointTip title="PCL-5" tip={tip} rc={11} base={52} />);
    expect(html).toContain('data-verdict="better"');
    expect(html).toContain("text-good");
    expect(says(html, "course.v.better")).toBe(true);
  });
});

describe("раскладка", () => {
  const pts: CoursePoint[] = [
    { key: "a", t: at(0), label: "24.08", value: 19 },
    { key: "b", t: at(45), label: "08.10", value: 14 },
  ];
  test("«сьогодні» — только рядом с курсом; полгода без замеров ось не растягивают", () => {
    expect(courseLayout(pts, PHQ, [], at(46)).today).toBe(at(46));
    expect(courseLayout(pts, PHQ, [], at(45 + 200)).today).toBeNull();
    expect(courseLayout(pts, PHQ, [], null).today).toBeNull();
  });

  test("номера сессий: проведённые и будущие подряд, неявка и неотмеченная — без номера", () => {
    const ev: CourseEvent[] = [
      { key: "s1", t: at(4), kind: "session", label: "28.08" },
      { key: "s2", t: at(11), kind: "session", label: "04.09" },
      { key: "p0", t: at(20), kind: "planned", label: "13.09" },
      { key: "n1", t: at(39), kind: "noshow", label: "02.10" },
      { key: "p1", t: at(47), kind: "planned", label: "10.10" },
      { key: "old", t: at(-400), kind: "session", label: "давно" },
    ];
    const lay = courseLayout(pts, PHQ, ev, at(45));
    expect([...lay.sessionNo.entries()]).toEqual([
      ["s1", 1],
      ["s2", 2],
      ["p1", 3],
    ]);
    // приём больше года назад на ось курса не попадает
    expect(lay.events.some((e) => e.key === "old")).toBe(false);
    expect(lay.ticks).toEqual([0, 5, 10, 15, 20, 27]);
  });
});

describe("подписи межі похибки", () => {
  test("первое свободное место; занято всё — подписи нет", () => {
    const field = { x0: 0, y0: 0, x1: 100, y1: 100 };
    const a = { x0: 10, y0: 10, x1: 50, y1: 20 };
    const b = { x0: 10, y0: 40, x1: 50, y1: 50 };
    expect(freeSpot([a, b], [{ x0: 20, y0: 12, x1: 24, y1: 16 }], field)).toBe(b);
    expect(freeSpot([a, b], [{ x0: 0, y0: 0, x1: 100, y1: 100 }], field)).toBeNull();
    // за краем поля — не место
    expect(freeSpot([{ x0: 90, y0: 10, x1: 140, y1: 20 }], [], field)).toBeNull();
  });
});

describe("отрисовка", () => {
  const c = course();
  const events = courseEventsFromTimeline(
    [
      { id: "v1", kind: "visit", at: iso(4), title: "", detail: "done" },
      { id: "v2", kind: "visit", at: iso(11), title: "", detail: "done" },
      { id: "v3", kind: "visit", at: iso(39), title: "", detail: "no_show" },
      { id: "v4", kind: "visit", at: iso(47), title: "", detail: "booked" },
      { id: "a1", kind: "alert", at: iso(45), title: "PHQ-9, пункт 9" },
    ],
    fmt,
  );
  const html = draw(<CourseChart title="PHQ-9" {...c} events={events} now={at(45.2)} />);

  test("подписанные полосы тяжести с границами, текущая — темнее", () => {
    expect(html.match(/data-band=/g)?.length).toBe(5);
    expect(html).toContain('data-band="помірна" x="30"');
    // текущая полоса (последний замер — помірна) — своим тоном поля
    expect(html).toMatch(/data-band="помірна"[^>]*fill="var\(--plotc\)"/);
    expect(html).toContain("помірно тяжка");
    expect(html).toMatch(/15(<!-- -->)?–(<!-- -->)?19/);
  });

  test("«краще ↓» у оси и межі похибки от старта с границей надёжного улучшения", () => {
    expect(says(html, "course.betterDown")).toBe(true);
    expect(html).toContain('data-zone="rc"');
    expect(html).toMatch(/19 ± 6[,.]1/);
    // MDC95 = 1,96·√2·SEM = 6,1; 19 − 6,1 = 12,9: улучшение надёжно ниже этой черты
    expect(html).toMatch(/12[,.]9/);
  });

  test("числа у замеров, «сьогодні», события на оси", () => {
    expect(html.match(/data-value=/g)?.length).toBe(3);
    expect(says(html, "course.today")).toBe(true);
    expect(html.match(/data-event="session"/g)?.length).toBe(2);
    expect(html.match(/data-event="noshow"/g)?.length).toBe(1);
    expect(html.match(/data-event="planned"/g)?.length).toBe(1);
    expect(html.match(/data-event="signal"/g)?.length).toBe(1);
    expect(html).toContain("fill=\"var(--risk)\"");
    expect(says(html, "course.sessions")).toBe(true);
    expect(html).not.toContain("NaN");
  });

  test("прогноза без основания нет: ни веера, ни «тренду», ни даты за правым краем", () => {
    expect(html).not.toMatch(/тренд|тренд|trend/i);
    expect(html).not.toContain("var(--fan)");
    // справа от «сьогодні» — только запланированная сессия, точки за ним нет
    expect(html.match(/data-point=/g)?.length).toBe(3);
  });

  test("подпись для диктора — все замеры с датами; легенда и подсказка как пользоваться", () => {
    expect(html).toContain('aria-label="PHQ-9: 19 (24.08), 16 (11.09), 14 (08.10)"');
    expect(says(html, "course.lg.measures")).toBe(true);
    expect(says(html, "course.lg.rc")).toBe(true);
    expect(says(html, "course.lg.noshow")).toBe(true);
    expect(says(html, "course.hint")).toBe(true);
  });

  test("без оценки похибки — без зоны, и это сказано словами", () => {
    const none = draw(<CourseChart title="PHQ-9" {...course({ sem: null, reliableChange: null })} now={null} />);
    expect(none).not.toContain('data-zone="rc"');
    expect(says(none, "course.noRc")).toBe(true);
    expect(says(none, "course.today")).toBe(false);
    expect(none).not.toContain("NaN");
  });

  test("благополучие: «краще ↑», межа улучшения выше старта", () => {
    const who = courseFromDynamics(
      { points: [dp(0, 24, { maxScore: 100 }), dp(45, 40, { maxScore: 100 })], sem: 5, reliableChange: null },
      WHO,
      fmt,
    );
    const out = draw(<CourseChart title="WHO-5" {...who} now={at(45)} />);
    expect(says(out, "course.betterUp")).toBe(true);
    expect(out).toMatch(/37[,.]9/);
  });

  test("один замер и пустой курс не роняют график", () => {
    const one = draw(<CourseChart title="x" points={[{ key: "a", t: at(0), label: "24.08", value: 7 }]} rungs={PHQ} rc={null} better="down" now={null} />);
    expect(one).toContain("<svg");
    expect(one).not.toContain("NaN");
    expect(draw(<CourseChart title="x" points={[]} rungs={PHQ} rc={null} better={null} />)).not.toContain("<svg");
  });
});
