import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UI, measurementError, type DynamicsPoint, type UiKey } from "@quizzy/shared";
import { CourseChart, CourseLegend, CoursePointTip } from "../src/charts/course";
import { CourseGrid, CourseSpark } from "../src/charts/courseGrid";
import {
  DAY_MS,
  bandSpans,
  bandY,
  betterOf,
  changeVerdict,
  courseColumns,
  courseDomain,
  courseEventsFromTimeline,
  courseFromDynamics,
  courseLayout,
  courseNames,
  cutoffOf,
  dodge,
  freeSpot,
  gridSpans,
  labelColumn,
  ladderTicks,
  laneEvents,
  methodNames,
  pointLadder,
  pointTip,
  reliableThreshold,
  signalsOn,
  spacedTicks,
  stackBlocks,
  valueOrder,
  wrapWords,
  type CourseEvent,
  type CoursePoint,
} from "../src/charts/courseModel";
import { LangProvider } from "../src/lang";

/**
 * График курса (charts/course.tsx) на настоящих данных приложения:
 * динамика шкалы, лестница полос методики, порог значущої зміни из основы
 * RCI и события хронологии. Проверяется то, что видит врач: шапка словами
 * (значение, полоса, сдвиг от старта), полосы с границами и целыми
 * подписями, один клинический порог, сигнал на своём замере, дорожка
 * приёмов без номеров, подсказка замера — и что ни межі похибки поперёк
 * поля, ни «сьогодні», ни прогноза на графике нет.
 */

const draw = (node: ReactNode) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);
const says = (html: string, key: UiKey) => {
  const e = UI[key] as { uk: string; ru: string; en: string };
  return [e.uk, e.ru, e.en].some((s) => html.includes(s));
};
/* текст без разметки: React вставляет <!-- --> между соседними кусками текста */
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/[ \t\n]+/g, " ");

const PHQ = [
  { min: 0, max: 4, label: "мінімальна", severity: "none" as const },
  { min: 5, max: 9, label: "легка", severity: "mild" as const },
  { min: 10, max: 14, label: "помірна", severity: "moderate" as const },
  { min: 15, max: 19, label: "помірно тяжка", severity: "severe" as const },
  { min: 20, max: 27, label: "тяжка", severity: "severe" as const },
];
/* благополучие: чем выше, тем лучше — лестница повёрнута */
const WHO = [
  { min: 0, max: 7, label: "дуже низьке", severity: "severe" as const },
  { min: 8, max: 12, label: "знижене", severity: "moderate" as const },
  { min: 13, max: 25, label: "норма", severity: "none" as const },
];
/* Т-баллы Міні-мульта: открытые крайние полосы в десяток средних шириной */
const MMPI = [
  { min: -14, max: 44.9, label: "Низький", severity: "none" as const },
  { min: 45, max: 55.9, label: "У межах норми", severity: "none" as const },
  { min: 56, max: 69.9, label: "Підвищений", severity: "mild" as const },
  { min: 70, max: 79.9, label: "Виражений пік", severity: "moderate" as const },
  { min: 80, max: 200, label: "Різко виражений пік", severity: "severe" as const },
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
      points: [dp(45, 14), dp(0, 19, { source: "assigned" }), dp(18, 16)],
      sem: 2.2,
      reliableChange: { rci: -1.6, significant: false, direction: "down", basis: { sd: 5.5, alpha: 0.84, sampleN: 120 } },
      ...over,
    },
    PHQ,
    fmt,
    { surveyId: "phq9" },
  );

describe("данные приложения → график", () => {
  test("замеры по времени, полоса по лестнице, «менше — краще» по полосам, верх шкалы, адрес протокола и кто заполнял", () => {
    const c = course();
    expect(c.points.map((p) => p.value)).toEqual([19, 16, 14]);
    expect(c.points[2]!.band).toEqual({ label: "помірна", severity: "moderate" });
    expect(c.better).toBe("down");
    expect(c.max).toBe(27);
    expect(c.points[0]!.href).toBe("/surveys/phq9/responses/r0");
    expect(c.points[0]!.source).toBe("assigned");
    expect(c.points[1]!.source).toBeNull();
    expect(betterOf(WHO)).toBe("up");
    expect(betterOf([])).toBeNull();
    // без методики адреса прохождения нет — и ссылки тоже
    expect(courseFromDynamics({ points: [dp(0, 3)], sem: null, reliableChange: null }, PHQ, fmt).points[0]!.href).toBeNull();
    // у нормированной шкалы «з 27» не говорят
    expect(courseFromDynamics({ points: [dp(0, 64, { normalization: "tscore", maxScore: 120 })], sem: null, reliableChange: null }, MMPI, fmt).max).toBeNull();
  });

  test("порог значущої зміни — MDC95 из основы RCI, иначе из SEM, иначе нет", () => {
    expect(course().rc).toBe(measurementError(5.5, 0.84)!.mdc95);
    expect(reliableThreshold({ sem: 2, reliableChange: null })).toBe(5.54);
    expect(reliableThreshold({ sem: null, reliableChange: null })).toBeNull();
    // старт из недостоверного протокола — порога от него нет
    expect(course({ points: [dp(0, 19, { reliable: false }), dp(18, 16)] }).rc).toBeNull();
  });

  test("замер другой версии со стартом не сравнивается — и подсказка говорит почему", () => {
    const c = course({ points: [dp(0, 19, { versionNo: 1 }), dp(18, 16, { versionNo: 2 })] });
    expect(c.points[1]!.incomparable).toBe("version");
    const tip = pointTip(c.points, 1, c.rungs, c.rc, c.better)!;
    expect(tip.fromStart).toBeNull();
    expect(says(draw(<CoursePointTip tip={tip} rc={c.rc} />), "rch.versions")).toBe(true);
  });

  test("хронология → события: приём, неявка, запланированный, заключение, сигнал со своим прохождением; прочее — мимо", () => {
    const ev = courseEventsFromTimeline(
      [
        { id: "v1", kind: "visit", at: iso(4), title: "Савчук", detail: "done" },
        { id: "v2", kind: "visit", at: iso(39), title: "Савчук", detail: "no_show" },
        { id: "v3", kind: "visit", at: iso(47), title: "Савчук", detail: "booked" },
        { id: "a1", kind: "alert", at: iso(45), title: "PHQ-9, пункт 9", detail: "PHQ-9", responseId: "r45" },
        { id: "c1", kind: "conclusion", at: iso(46), title: "Стан стабільний", detail: "signed", responseId: "r45" },
        { id: "c2", kind: "conclusion", at: iso(47), title: "Чернетка", detail: "draft" },
        { id: "r1", kind: "response", at: iso(45), title: "PHQ-9" },
        { id: "f1", kind: "referral", at: iso(10), title: "психіатр" },
      ],
      fmt,
    );
    expect(ev.map((e) => e.kind)).toEqual(["session", "noshow", "signal", "conclusion", "planned", "conclusion"]);
    expect(ev[2]!.detail).toBe("PHQ-9, пункт 9");
    expect(ev[2]!.responseId).toBe("r45");
    expect(ev[3]!.signed).toBe(true);
    expect(ev[5]!.signed).toBe(false);
  });
});

describe("слово сдвига", () => {
  test("ровно на пороге — ещё в межах похибки, за порогом — значущий; без порога — не оценено", () => {
    expect(changeVerdict(-6, 6, "down")).toBe("within");
    expect(changeVerdict(-7, 6, "down")).toBe("better");
    expect(changeVerdict(7, 6, "down")).toBe("worse");
    expect(changeVerdict(16, 14, "up")).toBe("better");
    expect(changeVerdict(-7, 6, null)).toBe("changed");
    expect(changeVerdict(-7, null, "down")).toBe("unknown");
  });
});

describe("клинический порог", () => {
  test("граница, с которой полосы помірні або виражені: PHQ-9 ≥ 10, WHO-5 ≤ 12, PCL-5 ≥ 33", () => {
    expect(cutoffOf(PHQ)).toEqual({ at: 9.5, value: 10, side: "above" });
    expect(cutoffOf(WHO)).toEqual({ at: 12.5, value: 12, side: "below" });
    expect(
      cutoffOf([
        { min: 0, max: 32, label: "не досягнуто", severity: "none" },
        { min: 33, max: 80, label: "досягнуто", severity: "moderate" },
      ]),
    ).toEqual({ at: 32.5, value: 33, side: "above" });
    expect(cutoffOf(MMPI)!.value).toBe(70);
  });

  test("порога нет, где его не из чего взять: одни нормальные полосы, все клинические, клинические посередине", () => {
    expect(cutoffOf([])).toBeNull();
    expect(
      cutoffOf([
        { min: 0, max: 2, label: "низька", severity: "mild" },
        { min: 3, max: 7, label: "норма", severity: "none" },
      ]),
    ).toBeNull();
    expect(
      cutoffOf([
        { min: 0, max: 2, label: "a", severity: "moderate" },
        { min: 3, max: 7, label: "b", severity: "severe" },
      ]),
    ).toBeNull();
    expect(
      cutoffOf([
        { min: 0, max: 2, label: "a", severity: "none" },
        { min: 3, max: 5, label: "b", severity: "moderate" },
        { min: 6, max: 9, label: "c", severity: "none" },
      ]),
    ).toBeNull();
  });
});

describe("раскладка", () => {
  const pts: CoursePoint[] = [
    { key: "a", t: at(0), label: "24.08", value: 19 },
    { key: "b", t: at(45), label: "08.10", value: 14 },
  ];

  test("события дорожки — только около курса; сигнал — не на дорожке, а на своём замере", () => {
    const ev: CourseEvent[] = [
      { key: "s1", t: at(4), kind: "session", label: "28.08" },
      { key: "n1", t: at(39), kind: "noshow", label: "02.10" },
      { key: "p1", t: at(47), kind: "planned", label: "10.10" },
      { key: "old", t: at(-400), kind: "session", label: "давно" },
      { key: "far", t: at(200), kind: "planned", label: "потім" },
      { key: "sig", t: at(45), kind: "signal", label: "08.10", responseId: "b" },
      { key: "other", t: at(45), kind: "signal", label: "08.10", responseId: "gad7-response" },
      { key: "bare", t: at(45), kind: "signal", label: "08.10" },
    ];
    const lay = courseLayout(pts, PHQ, ev);
    expect(lay.lane.map((e) => e.key)).toEqual(["s1", "n1", "p1"]);
    expect(laneEvents(pts, ev).map((e) => e.key)).toEqual(["s1", "n1", "p1"]);
    // сигнал другой методики того же дня и сигнал без прохождения — не на этом графике
    expect([...lay.signals.keys()]).toEqual([1]);
    expect(lay.signals.get(1)!.map((e) => e.key)).toEqual(["sig"]);
    expect(lay.ticks).toEqual([0, 5, 10, 15, 20, 27]);
    expect(lay.cut).toEqual({ lo: false, hi: false });
  });

  test("сигнал по полосе — только на графике своей шкалы; сигнал по ответу — на всех шкалах замера", () => {
    const ev: CourseEvent[] = [
      { key: "band", t: at(45), kind: "signal", label: "08.10", responseId: "b", scaleCode: "SR" },
      { key: "item", t: at(45), kind: "signal", label: "08.10", responseId: "b", scaleCode: null },
    ];
    expect([...(signalsOn(pts, ev, "SR").get(1) ?? [])].map((e) => e.key)).toEqual(["band", "item"]);
    expect([...(signalsOn(pts, ev, "KP").get(1) ?? [])].map((e) => e.key)).toEqual(["item"]);
    // код шкалы неизвестен (пример на лендинге) — не отсекаем
    expect(signalsOn(pts, ev).get(1)?.length).toBe(2);
    expect(courseLayout(pts, PHQ, ev, null, "KP").signals.get(1)?.map((e) => e.key)).toEqual(["item"]);
  });

  test("верх шкалы выше края лестницы — ось до верха шкалы: «15 з 22» в шапке и «22» у оси сходятся", () => {
    /* демо-скрининг: полосы до 21, а максимум шкалы — 22 (пункт 0–10 поверх четырёх 0–3) */
    const ladder = [
      { min: 0, max: 4, label: "норма", severity: "none" as const },
      { min: 15, max: 21, label: "виражена", severity: "severe" as const },
    ];
    expect(courseLayout(pts, ladder, []).hi).toBe(21);
    const lay = courseLayout(pts, ladder, [], 22);
    expect(lay.hi).toBe(22);
    expect(lay.ticks.at(-1)).toBe(22);
    // ниже края лестницы верх ничего не сужает
    expect(courseLayout(pts, PHQ, [], 20).hi).toBe(27);
  });

  test("открытые крайние полосы Т-баллов срезаются до двух средних — и срез отмечен; обычные лестницы не тронуты", () => {
    const d = courseDomain(MMPI, [52, 61, 74]);
    expect(d.cut).toEqual({ lo: true, hi: true });
    expect(d.lo).toBeGreaterThanOrEqual(20);
    expect(d.lo).toBeLessThan(45);
    expect(d.hi).toBeGreaterThan(80);
    expect(d.hi).toBeLessThanOrEqual(105);
    // данные за срезом срез раздвигают: замер не уходит за край поля
    expect(courseDomain(MMPI, [52, 118]).hi).toBeGreaterThanOrEqual(118);
    expect(courseDomain(PHQ, [3, 21]).cut).toEqual({ lo: false, hi: false });
    const audit = [
      { min: 0, max: 7, label: "a", severity: "none" as const },
      { min: 8, max: 15, label: "b", severity: "mild" as const },
      { min: 16, max: 19, label: "c", severity: "moderate" as const },
      { min: 20, max: 40, label: "d", severity: "severe" as const },
    ];
    expect(courseDomain(audit, [12]).hi).toBe(40);
  });

  test("шкала без полос (BPRS): ось до верха шкалы, а не до круглого деления; без полос — ни порога, ни «менше — краще»", () => {
    const bprs: CoursePoint[] = [
      { key: "a", t: at(0), label: "01.07", value: 72 },
      { key: "b", t: at(90), label: "21.10", value: 47 },
    ];
    const lay = courseLayout(bprs, [], [], 126);
    expect(lay.hi).toBe(126);
    expect(lay.ticks.at(-1)).toBe(126);
    expect(lay.ticks).not.toContain(150);
    const out = draw(<CourseChart title="BPRS" points={bprs} rungs={[]} max={126} rc={null} better={null} now={null} />);
    expect(out).not.toContain("data-cutoff");
    expect(says(out, "course.betterDown") || says(out, "course.betterUp")).toBe(false);
    expect(out).not.toContain("NaN");
    // верх шкалы ниже данных (сырой балл за краем) — ось по данным, как прежде
    expect(courseLayout(bprs, [], [], 60).hi).toBeGreaterThanOrEqual(72);
  });

  test("полоса из одного значения среди обычных (SWLS «20») видна: не тоньше своей подписи, ось внутри полос линейна, порядок сохранён", () => {
    const swls = [
      { min: 5, max: 9, label: "Виражена незадоволеність", severity: "mild" as const },
      { min: 10, max: 14, label: "Незадоволеність", severity: "mild" as const },
      { min: 15, max: 19, label: "Незначна незадоволеність", severity: "none" as const },
      { min: 20, max: 20, label: "Нейтральна оцінка", severity: "none" as const },
      { min: 21, max: 25, label: "Незначна задоволеність", severity: "none" as const },
      { min: 26, max: 30, label: "Задоволеність", severity: "none" as const },
      { min: 31, max: 35, label: "Виражена задоволеність", severity: "none" as const },
    ];
    const spans = bandSpans(swls, 5, 35);
    const Y = bandY(spans, 5, 35, 0, 188, () => 18);
    // по линейной оси у «20» было бы 188 / 30 ≈ 6 px
    expect(Y(19.5) - Y(20.5)).toBeGreaterThanOrEqual(18 - 1e-6);
    // края поля на месте, ось монотонна
    expect(Y(5)).toBeCloseTo(188, 6);
    expect(Y(35)).toBeCloseTo(0, 6);
    const ys = [5, 9, 14.5, 19.5, 20, 20.5, 25, 30.5, 35].map(Y);
    expect([...ys].sort((a, b) => b - a)).toEqual(ys);
    // без полос-точек — обычная линейная ось
    const lin = bandY(bandSpans(PHQ, 0, 27), 0, 27, 10, 270, () => 18);
    expect(lin(13.5)).toBeCloseTo(10 + 270 / 2, 6);
    // подписи делений не налезают: «20» и «21» рядом — одно уходит
    const shown = spacedTicks([5, 10, 15, 20, 21, 26, 31, 35], Y);
    expect(shown).toContain(5);
    expect(shown).toContain(35);
    for (let i = 1; i < shown.length; i++) expect(Math.abs(Y(shown[i]!) - Y(shown[i - 1]!))).toBeGreaterThanOrEqual(12);

    const pts: CoursePoint[] = [
      { key: "a", t: at(0), label: "24.08", value: 17 },
      { key: "b", t: at(30), label: "23.09", value: 20 },
    ];
    const html = draw(<CourseChart title="SWLS" points={pts} rungs={swls} max={35} rc={null} better="up" now={null} />);
    const plain = text(html);
    expect(plain).toContain("20 Нейтральна оцінка");
    expect(plain).not.toContain("20–20");
    const band = /data-band="Нейтральна оцінка"[^>]*height="([\d.]+)"/.exec(html);
    expect(Number(band?.[1])).toBeGreaterThanOrEqual(14);
  });

  test("лестница из полос-точек (CGI-S 1–7): ось шире на полшага, крайние полосы не вдвое уже, деления — сами ступени", () => {
    const cgi = [1, 2, 3, 4, 5, 6, 7].map((v) => ({ min: v, max: v, label: `${v}`, severity: "none" as const }));
    expect(pointLadder(cgi)).toBe(true);
    expect(pointLadder(PHQ)).toBe(false);
    const d = courseDomain(cgi, [3, 5]);
    expect(d).toEqual({ lo: 0.5, hi: 7.5, cut: { lo: false, hi: false } });
    expect(ladderTicks(cgi, d.lo, d.hi)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // все полосы — одной высоты
    const heights = bandSpans(cgi, d.lo, d.hi).map((s) => s.to - s.from);
    expect(new Set(heights).size).toBe(1);
  });
});

describe("подсказка замера", () => {
  const c = course();
  test("старт: база, от которой меряется сдвиг; кто заполнял", () => {
    const tip = pointTip(c.points, 0, c.rungs, c.rc, c.better)!;
    expect(tip.baseline).toBe(true);
    expect(tip.fromStart).toBeNull();
    expect(tip.fromPrev).toBeNull();
    expect(tip.range).toEqual({ min: 15, max: 19 });
    const html = draw(<CoursePointTip tip={tip} rc={c.rc} />);
    expect(html).toContain("24.08");
    expect(says(html, "course.start")).toBe(true);
    expect(says(html, "course.baselineNote")).toBe(true);
    expect(says(html, "course.byPatient")).toBe(true);
    expect(says(html, "rp.src.assigned")).toBe(true);
    // межі похибки «19 ± 6,1» больше не печатаются
    expect(html).not.toMatch(/±/);
  });

  test("второй замер: сдвиг от старта есть, «от предыдущего» не повторяет его", () => {
    const tip = pointTip(c.points, 1, c.rungs, c.rc, c.better)!;
    expect(tip.fromStart).toEqual({ delta: -3, verdict: "within", since: "24.08" });
    expect(tip.fromPrev).toBeNull();
  });

  test("последний: значение, полоса словом с границами, сдвиг от старта со словом и способом, сдвиг от предыдущего", () => {
    const tip = pointTip(c.points, 2, c.rungs, c.rc, c.better)!;
    expect(tip.last).toBe(true);
    expect(tip.fromStart).toEqual({ delta: -5, verdict: "within", since: "24.08" });
    expect(tip.fromPrev).toEqual({ delta: -2, label: "11.09" });
    const html = draw(<CoursePointTip tip={tip} rc={c.rc} />);
    expect(html).toContain(">14</b>");
    expect(html).toContain("помірна");
    expect(text(html)).toContain("10–14");
    expect(text(html)).toContain("−5");
    expect(html).toContain('data-verdict="within"');
    expect(says(html, "kit.withinError")).toBe(true);
    // способ оценки — в подсказке, а не на поле: «понад 6,1 (RCI, 95 %)»
    expect(text(html)).toMatch(/6[,.]1/);
    expect(html).toContain("RCI");
    expect(text(html)).toContain("−2");
  });

  test("значуще покращення — словом и зелёным; сигнал этого замера — красным словом", () => {
    const pts: CoursePoint[] = [
      { key: "a", t: at(0), label: "24.08", value: 52 },
      { key: "b", t: at(45), label: "08.10", value: 38, source: "clinician" },
    ];
    const signal: CourseEvent = { key: "s", t: at(45), kind: "signal", label: "08.10", detail: "PCL-5, пункт 16", responseId: "b" };
    const tip = pointTip(pts, 1, [], 11, "down", [signal])!;
    const html = draw(<CoursePointTip tip={tip} rc={11} />);
    expect(html).toContain('data-verdict="better"');
    expect(html).toContain("text-good");
    expect(says(html, "course.v.better")).toBe(true);
    expect(says(html, "course.byClinician")).toBe(true);
    expect(html).toContain("PCL-5, пункт 16");
    expect(html).toContain("data-tip-signal");
  });

  test("доля — процентами, сдвиг — в процентных пунктах", () => {
    const pts: CoursePoint[] = [
      { key: "a", t: at(0), label: "24.08", value: 0.29 },
      { key: "b", t: at(45), label: "08.10", value: 0.49 },
    ];
    const tip = pointTip(pts, 1, [], 0.1, "down")!;
    const html = text(draw(<CoursePointTip tip={tip} rc={0.1} normalization="ratio" />));
    expect(html).toContain("49 %");
    expect(html).toMatch(/\+20 (в\. п\.|п\. п\.|pp)/);
  });
});

describe("подписи", () => {
  const measure = (s: string) => s.length * 7;

  test("перенос по словам: ничего не обрезается и не теряется, неразрывный пробел держит своё", () => {
    const lines = wrapWords("5–9 Легка («субклінічна») депресія", 120, measure);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe("5–9 Легка («субклінічна») депресія");
    expect(lines.join("")).not.toContain("…");
    expect(wrapWords("24–38 % Середній", 60, measure)[0]).toBe("24–38 %");
  });

  test("колонка подписей: строк столько, сколько даёт самая широкая, и не шире нужного", () => {
    const texts = ["20–27 Тяжка депресія", "5–9 Легка («субклінічна») депресія", "0–4 Депресія відсутня"];
    const w = labelColumn(texts, measure, 84, 400);
    expect(w).toBe(measure("5–9 Легка («субклінічна») депресія"));
    // узкая колонка — в две строки, но не уже самого длинного слова
    const narrow = labelColumn(texts, measure, 84, 150);
    expect(narrow).toBeGreaterThanOrEqual(measure("(«субклінічна»)"));
    expect(narrow).toBeLessThanOrEqual(150);
    for (const t of texts) expect(wrapWords(t, narrow, measure).join(" ")).toBe(t);
  });

  test("блоки подписей не налезают друг на друга и стоят по своим полосам, пока есть место", () => {
    const tops = stackBlocks(
      [
        { want: 30, h: 28 },
        { want: 40, h: 28 },
        { want: 120, h: 14 },
      ],
      0,
      200,
    );
    expect(tops[1]!).toBeGreaterThanOrEqual(tops[0]! + 28 + 2);
    expect(tops[2]).toBe(120 - 7);
    // не помещаются у нижнего края — уходят вверх, а не наезжают
    const bottom = stackBlocks(
      [
        { want: 190, h: 20 },
        { want: 195, h: 20 },
      ],
      0,
      200,
    );
    expect(bottom[1]! + 20).toBeLessThanOrEqual(200);
    expect(bottom[1]!).toBeGreaterThanOrEqual(bottom[0]! + 22);
  });

  test("числа у замеров: сначала последний, первый, крайние, потом переломы", () => {
    expect(valueOrder([19, 16, 14]).slice(0, 2)).toEqual([2, 0]);
    const order = valueOrder([10, 4, 12, 20, 9, 11, 3, 8, 15, 14]);
    expect(order.slice(0, 4)).toEqual([9, 0, 3, 6]);
    expect(new Set(order).size).toBe(10);
  });

  test("свободное место для подписи: первое, что ничего не закрывает; за полем — не место", () => {
    const field = { x0: 0, y0: 0, x1: 100, y1: 100 };
    const a = { x0: 10, y0: 10, x1: 50, y1: 20 };
    const b = { x0: 10, y0: 40, x1: 50, y1: 50 };
    expect(freeSpot([a, b], [{ x0: 20, y0: 12, x1: 24, y1: 16 }], field)).toBe(b);
    expect(freeSpot([a, b], [{ x0: 0, y0: 0, x1: 100, y1: 100 }], field)).toBeNull();
    expect(freeSpot([{ x0: 90, y0: 10, x1: 140, y1: 20 }], [], field)).toBeNull();
  });

  test("значки дорожки одного дня раздвигаются, порядок и края — на месте", () => {
    const xs = dodge([10, 10, 10, 300, 395], 11, 5, 400);
    expect(xs[1]! - xs[0]!).toBeGreaterThanOrEqual(11);
    expect(xs[2]! - xs[1]!).toBeGreaterThanOrEqual(11);
    expect(xs.at(-1)!).toBeLessThanOrEqual(400);
    expect([...xs].sort((p, q) => p - q)).toEqual(xs);
  });
});

describe("сетка графиков без пустых полурядов", () => {
  test("столбцов — по ширине и по числу графиков", () => {
    expect(courseColumns(820, 3)).toBe(1);
    expect(courseColumns(1180, 3)).toBe(2);
    expect(courseColumns(1500, 5)).toBe(3);
    expect(courseColumns(1500, 2)).toBe(2);
  });

  test("последний неполный ряд растягивается: одинокий — на всю ширину, пара в тройке — по половине", () => {
    expect(gridSpans(3, 2)).toEqual([3, 3, 6]);
    expect(gridSpans(3, 3)).toEqual([2, 2, 2]);
    expect(gridSpans(4, 3)).toEqual([2, 2, 2, 6]);
    expect(gridSpans(5, 3)).toEqual([2, 2, 2, 3, 3]);
    expect(gridSpans(1, 3)).toEqual([6]);
    for (const [n, c] of [
      [7, 3],
      [5, 2],
      [2, 3],
    ] as const) {
      const spans = gridSpans(n, c);
      // каждый ряд набирает ровно шесть долей
      let row = 0;
      for (const s of spans) row = (row + s) % 6;
      expect(row).toBe(0);
    }
  });

  test("сетка рисует детей с долями", () => {
    const html = draw(
      <CourseGrid>
        <p key="a">a</p>
        <p key="b">b</p>
        <p key="c">c</p>
      </CourseGrid>,
    );
    expect(html).toContain("grid-template-columns:repeat(6, minmax(0, 1fr))");
    expect(html.match(/grid-column:span/g)?.length).toBe(3);
  });
});

describe("имена", () => {
  test("что меряет и чем — из названия методики; служебный код шкалы не показывается", () => {
    expect(methodNames("Депресія (PHQ-9)")).toEqual({ measure: "Депресія", code: "PHQ-9" });
    expect(methodNames("СР-45. Схильність до суїцидальних реакцій")).toEqual({ measure: "Схильність до суїцидальних реакцій", code: "СР-45" });
    expect(methodNames("Якість сну (демо)")).toEqual({ measure: "Якість сну (демо)", code: null });
    // правило одно с консолью: код со строчными и длинный — тоже код
    expect(methodNames("Синдром відміни алкоголю (CIWA-Ar)")).toEqual({ measure: "Синдром відміни алкоголю", code: "CIWA-Ar" });
    expect(methodNames("Способи подолання стресу (Brief COPE)")).toEqual({ measure: "Способи подолання стресу", code: "Brief COPE" });
    expect(courseNames("Депресія (PHQ-9)", "Вираженість депресії", true)).toEqual({ measure: "Депресія", method: "PHQ-9" });
    expect(courseNames("Скринінг емоційного стану (демо)", "Тривога", false)).toEqual({
      measure: "Тривога",
      method: "Скринінг емоційного стану (демо)",
    });
  });
});

describe("отрисовка", () => {
  const c = course();
  const events = courseEventsFromTimeline(
    [
      { id: "v1", kind: "visit", at: iso(4), title: "Савчук", detail: "done" },
      { id: "v2", kind: "visit", at: iso(11), title: "Савчук", detail: "done" },
      { id: "v3", kind: "visit", at: iso(39), title: "Савчук", detail: "no_show" },
      { id: "v4", kind: "visit", at: iso(47), title: "Савчук", detail: "booked" },
      { id: "c1", kind: "conclusion", at: iso(46), title: "Стан стабільний", detail: "signed", responseId: "r45" },
      { id: "a1", kind: "alert", at: iso(45), title: "PHQ-9, пункт 9", responseId: "r45" },
      { id: "a2", kind: "alert", at: iso(45), title: "GAD-7: виражена", responseId: "gad7" },
    ],
    fmt,
  );
  const html = draw(<CourseChart title="PHQ-9" measure="Депресія" method="PHQ-9" {...c} events={events} now={at(45.2)} />);
  const plain = text(html);

  test("шапка словами: что и чем, сколько сейчас из скольких, полоса, сдвиг от старта со словом", () => {
    expect(plain).toContain("Депресія");
    expect(plain).toContain("· PHQ-9");
    expect(html).toMatch(/data-course-value[^>]*>14</);
    expect(plain).toMatch(/з 27|из 27|of 27/);
    expect(plain).toContain("помірна");
    expect(html).toContain('data-change="within"');
    expect(plain).toMatch(/(у межах похибки|в пределах погрешности|within error): −5 (з|с|since) 24\.08/);
  });

  test("полосы с целыми подписями и границами; текущая — темнее; многоточий нет", () => {
    expect(html.match(/data-band=/g)?.length).toBe(5);
    expect(html).toMatch(/data-band="помірна"[^>]*fill="var\(--plotc\)"/);
    for (const label of ["мінімальна", "легка", "помірна", "помірно тяжка", "тяжка"]) expect(plain).toContain(label);
    expect(plain).toContain("15–19");
    expect(plain).toContain("0–4");
    expect(html).not.toContain("…");
  });

  test("один клинический порог — пунктиром с подписью; межі похибки поперёк поля и «сьогодні» нет", () => {
    expect(html.match(/data-cutoff=/g)?.length).toBe(1);
    expect(html).toContain('data-cutoff="10"');
    expect(plain).toMatch(/(клінічний поріг|клинический порог|clinical cut-off) ≥ 10/);
    expect(html).not.toContain('data-zone="rc"');
    expect(plain).not.toMatch(/±/);
    expect(plain).not.toMatch(/сьогодні|сегодня|today/);
  });

  test("«менше — краще» у оси словами", () => {
    expect(says(html, "course.betterDown")).toBe(true);
  });

  test("сигнал — кольцом на том замере, который его поднял; сигнал другой методики — не здесь", () => {
    expect(html.match(/data-signal=/g)?.length).toBe(1);
    expect(html).toContain('data-signal="2"');
  });

  test("дорожка: приёмы, неявка, запланированный, заключение — без номеров; числа у замеров", () => {
    expect(html.match(/data-event="session"/g)?.length).toBe(2);
    expect(html.match(/data-event="noshow"/g)?.length).toBe(1);
    expect(html.match(/data-event="planned"/g)?.length).toBe(1);
    expect(html.match(/data-event="conclusion"/g)?.length).toBe(1);
    expect(html).not.toMatch(/>[①②③④⑤]</);
    expect(html.match(/data-value=/g)?.length).toBe(3);
    expect(html).not.toContain("NaN");
  });

  test("легенда — только того, что на графике; подпись для диктора — все замеры с датами", () => {
    expect(says(html, "course.lg.signal")).toBe(true);
    expect(says(html, "course.lg.session")).toBe(true);
    expect(says(html, "course.lg.noshow")).toBe(true);
    expect(says(html, "course.lg.planned")).toBe(true);
    expect(says(html, "course.lg.conclusion")).toBe(true);
    expect(says(html, "course.lg.unmarked")).toBe(false);
    expect(html).toContain('aria-label="PHQ-9: 19 (24.08), 16 (11.09), 14 (08.10)"');
    expect(says(html, "course.hint")).toBe(true);
    const id = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<p id="${id}" class="sr-only">`);
  });

  test("прогноза без основания нет: ни веера, ни «тренду», ни точки за последним замером", () => {
    expect(html).not.toMatch(/тренд|trend/i);
    expect(html).not.toContain("var(--fan)");
    expect(html.match(/data-point=/g)?.length).toBe(3);
  });

  test("без оценки похибки — «значущість не оцінено» словами, а не тишина", () => {
    const none = draw(<CourseChart title="PHQ-9" {...course({ sem: null, reliableChange: null })} now={null} />);
    expect(none).toContain('data-change="unknown"');
    expect(says(none, "course.changeUnknown") || /значущість не оцінено|значимость не оценена|significance not assessed/.test(text(none))).toBe(true);
    expect(none).not.toContain("NaN");
  });

  test("благополучие: «більше — краще», порог ≤ 12, значуще покращення — зелёным", () => {
    const who = courseFromDynamics(
      { points: [dp(0, 4, { maxScore: 25 }), dp(45, 18, { maxScore: 25 })], sem: 1.3, reliableChange: null },
      WHO,
      fmt,
    );
    const out = draw(<CourseChart title="WHO-5" measure="Благополуччя" method="WHO-5" {...who} now={at(45)} />);
    expect(says(out, "course.betterUp")).toBe(true);
    expect(text(out)).toMatch(/≤ 12/);
    expect(out).toContain('data-change="better"');
    expect(out).toContain("text-good");
  });

  test("Т-баллы: срезанная лестница отмечена изломом у оси, единица — у значения", () => {
    const mm = courseFromDynamics(
      {
        points: [dp(0, 58, { normalization: "tscore", maxScore: 120 }), dp(30, 72, { normalization: "tscore", maxScore: 120 })],
        sem: null,
        reliableChange: null,
      },
      MMPI,
      fmt,
    );
    const out = draw(<CourseChart title="D" {...mm} now={null} />);
    expect(out).toContain("<path aria-hidden");
    expect(says(out, "norm.tscore")).toBe(true);
    expect(out).not.toContain("NaN");
  });

  test("малый формат и легенда сетки рисуются; без шапки — без шапки", () => {
    const small = draw(<CourseChart title="PHQ-9" {...c} events={events} size="compact" legend={false} header={false} />);
    expect(small).not.toContain("data-course-head");
    expect(small).toContain("<svg");
    const legend = draw(<CourseLegend cutoff signal lane={events} now={at(45.2)} />);
    expect(says(legend, "course.lg.cutoff")).toBe(true);
    expect(says(legend, "course.lg.signal")).toBe(true);
  });

  test("один замер и пустой курс не роняют график; у одного — «перший замір»", () => {
    const one = draw(<CourseChart title="x" points={[{ key: "a", t: at(0), label: "24.08", value: 7 }]} rungs={PHQ} rc={null} better="down" now={null} />);
    expect(one).toContain("<svg");
    expect(says(one, "course.first")).toBe(true);
    expect(one).not.toContain("NaN");
    expect(draw(<CourseChart title="x" points={[]} rungs={PHQ} rc={null} better={null} />)).not.toContain("<svg");
  });

  test("полосы из одного значения (CGI-S 1–7) подписаны одним числом — в колонке и в подсказке", () => {
    const CGI = [1, 2, 3, 4, 5, 6, 7].map((v) => ({
      min: v,
      max: v,
      label: ["Норма", "Межовий стан", "Легкий", "Помірний", "Виражений", "Тяжкий", "Вкрай тяжкий"][v - 1]!,
      severity: (v <= 2 ? "none" : v === 3 ? "mild" : v === 4 ? "moderate" : "severe") as "none" | "mild" | "moderate" | "severe",
    }));
    const pts: CoursePoint[] = [
      { key: "a", t: at(0), label: "24.08", value: 5 },
      { key: "b", t: at(30), label: "23.09", value: 3 },
    ];
    const out = text(draw(<CourseChart title="CGI-S" points={pts} rungs={CGI} max={7} rc={null} better="down" now={null} />));
    expect(out).not.toMatch(/(\d)–\1(?!\d)/);
    expect(out).toContain("2 Межовий стан");
    expect(out).toContain("7 Вкрай тяжкий");
    const tip = text(draw(<CoursePointTip tip={pointTip(pts, 1, CGI, null, "down")!} rc={null} />));
    expect(tip).not.toContain("3–3");
    expect(tip).toMatch(/Легкий 3/);
  });

  test("курс в строке таблицы: полосы, порог, линия, без чисел", () => {
    const spark = draw(<CourseSpark points={c.points} rungs={c.rungs} max={27} label="PHQ-9: 19 → 16 → 14" />);
    expect(spark).toContain('aria-label="PHQ-9: 19 → 16 → 14"');
    expect(spark).toContain("<polyline");
    expect(spark).toContain('stroke-dasharray="3 2"');
    expect(spark).not.toContain("NaN");
  });
});
