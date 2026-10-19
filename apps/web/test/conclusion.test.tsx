import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI, type DecisionRule, type ResponseContextSignal, type RuleHit } from "@quizzy/shared";
import { api, type ConclusionState, type ConclusionVersion } from "../src/api";
import { ConclusionEditor } from "../src/components/ConclusionEditor";
import { LangProvider } from "../src/lang";
import { applicableModels, resultLines } from "../src/pages/Conclusion";
import { signGate, signLockedBySignal } from "../src/pages/response/context";
import { dynamics, series } from "./responseFixtures";

/**
 * Лист заключения (Polypsy 2.0).
 *
 * Здесь проверяется то, что глазом не видно: подпись закрыта, пока не
 * разобран сигнал, поднятый этим самым прохождением, — а черновик писать и
 * сохранять можно; вердикт аналитической модели — по срабатыванию именно
 * этого прохождения; результаты человека для вывода — последний замер каждой
 * методики, и «це проходження» — то, по которому пишут.
 */

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

const signal = (over: Partial<ResponseContextSignal> = {}): ResponseContextSignal => ({
  id: "a1",
  label: "PHQ-9: пункт 9",
  severity: "severe",
  at: "2026-10-08T11:12:00.000Z",
  here: true,
  questionId: "q9",
  surveyTitle: "PHQ-9",
  minutesOpen: 168,
  escalateMinutes: 240,
  overdue: false,
  reviewedAt: null,
  reviewedByName: null,
  outcome: null,
  ...over,
});

describe("подпись после разбора сигнала", () => {
  test("закрыта неразобранным сигналом этого прохождения — и только им", () => {
    expect(signLockedBySignal([signal()])).toBe(true);
    // разобранный сигнал подпись не держит
    expect(signLockedBySignal([signal({ reviewedAt: "2026-10-08T13:00:00.000Z", outcome: "not_confirmed" })])).toBe(false);
    // открытый сигнал другого замера ждёт своей очереди, этот документ — о другом протоколе
    expect(signLockedBySignal([signal({ here: false })])).toBe(false);
    // без права разбирать сигналы экрану не из чего судить
    expect(signLockedBySignal(null)).toBe(false);
  });

  const v = (over: Partial<ConclusionVersion> = {}): ConclusionVersion => ({
    id: "c1",
    version: 1,
    revision: 3,
    text: "Симптоми зменшуються",
    status: "draft",
    createdAt: "2026-10-08T13:40:00.000Z",
    authorName: "Ірина Савчук",
    signedAt: null,
    ...over,
  });
  const state = (current: ConclusionVersion | null): ConclusionState => ({ current, versions: current ? [current] : [] });
  const draw = (lock: boolean, text = "Симптоми зменшуються") =>
    render(
      <ConclusionEditor
        responseId="r1"
        state={state(v())}
        error={null}
        onState={() => {}}
        onReload={() => {}}
        text={text}
        setText={() => {}}
        areaRef={{ current: null }}
        lock={lock ? { title: "Підписати можна після розбору сигналу", body: "Пункт 9", action: null } : null}
      />,
    );
  const button = (html: string, key: "cn3.form" | "cnc.saveDraft") => {
    const e = UI[key] as { uk: string; ru: string; en?: string };
    const found = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find((m) =>
      [e.uk, e.ru, e.en].includes(m[2]!.replace(/<[^>]*>/g, "")),
    );
    expect(found, `кнопки ${key} нет в разметке`).toBeDefined();
    return { disabled: /\sdisabled=""/.test(found![1]!) };
  };

  test("сигнал не разобран — подпись выключена, черновик сохраняется, причина названа", () => {
    const html = draw(true);
    expect(button(html, "cn3.form").disabled).toBe(true);
    expect(button(html, "cnc.saveDraft").disabled).toBe(false);
    expect(html).toContain("Підписати можна після розбору сигналу");
  });

  test("сигнала нет — подпись по правилам сервера: текст есть, кнопка живая", () => {
    const html = draw(false);
    expect(button(html, "cn3.form").disabled).toBe(false);
    expect(button(draw(false, "  "), "cn3.form").disabled).toBe(true);
  });

  /**
   * Замок считался только по пришедшей обстановке: пока шёл запрос — и
   * навсегда при его отказе — кнопка подписи была живой при неразобранном
   * сигнале. Мутация: вернуть «нет обстановки — открыто» для того, кто
   * разбирает сигналы, — проверки pending и unknown падают.
   */
  test("обстановка ещё едет или не пришла — подпись закрыта для того, кто разбирает сигналы", () => {
    expect(signGate(null, false, true)).toBe("pending");
    expect(signGate(null, true, true)).toBe("unknown");
    expect(signGate({ signals: [signal()] }, false, true)).toBe("locked");
    expect(signGate({ signals: [signal({ reviewedAt: "2026-10-08T13:00:00.000Z" })] }, false, true)).toBe("open");
    // без права разбирать сигналы сервер их не отдаёт — правило экрана не действует ни до, ни после ответа
    expect(signGate(null, false, false)).toBe("open");
    expect(signGate({ signals: null }, false, false)).toBe("open");
  });

  /**
   * Поле «Назва заключення» было на листе, а сервер название не хранит
   * (столбца нет) и отбрасывал его молча: набрал, сохранил, открыл — пусто.
   * Поле, которое не сохраняется, хуже его отсутствия. Мутация: вернуть
   * поле — в разметке появляется поле ввода; вернуть title в тело — тело
   * сохранения его несёт.
   */
  test("названия заключения нет: ни поля на листе, ни поля в теле сохранения", async () => {
    const html = draw(false);
    expect(html).not.toMatch(/<input\b/);
    expect(html).not.toContain("Назва заключення");

    const sent: unknown[] = [];
    const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
    const saved = { fetch: globalThis.fetch, localStorage: g.localStorage, sessionStorage: g.sessionStorage };
    const memory = (): Storage => {
      const data = new Map<string, string>();
      return {
        get length() {
          return data.size;
        },
        clear: () => data.clear(),
        getItem: (k) => data.get(k) ?? null,
        key: (i) => [...data.keys()][i] ?? null,
        removeItem: (k) => void data.delete(k),
        setItem: (k, val) => void data.set(k, String(val)),
      };
    };
    g.localStorage = memory();
    g.sessionStorage = memory();
    globalThis.fetch = (async (_: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(state(v())), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      await api.saveConclusion("r1", "Висновок", { version: 1, revision: 3 });
    } finally {
      globalThis.fetch = saved.fetch;
      g.localStorage = saved.localStorage;
      g.sessionStorage = saved.sessionStorage;
    }
    expect(sent).toEqual([{ text: "Висновок", baseVersion: 1, baseRevision: 3 }]);
  });

  test("подпись ждёт обстановку молча, а при отказе называет причину; черновик сохраняется в обоих случаях", () => {
    const base = {
      responseId: "r1",
      state: state(v()),
      error: null,
      onState: () => {},
      onReload: () => {},
      text: "Симптоми зменшуються",
      setText: () => {},
      areaRef: { current: null },
    };
    const pending = render(<ConclusionEditor {...base} signPending />);
    expect(button(pending, "cn3.form").disabled).toBe(true);
    expect(button(pending, "cnc.saveDraft").disabled).toBe(false);
    expect(pending).not.toContain(UI["cnx.lockTitle"].uk);

    const unknown = render(
      <ConclusionEditor
        {...base}
        lock={{ title: UI["cnx.lockUnknownTitle"].uk, body: UI["cnx.lockUnknownBody"].uk, action: null, tone: "warn", note: UI["cnx.lockUnknownBody"].uk }}
      />,
    );
    expect(button(unknown, "cn3.form").disabled).toBe(true);
    expect(button(unknown, "cnc.saveDraft").disabled).toBe(false);
    expect(unknown).toContain(UI["cnx.lockUnknownTitle"].uk);
    // это не сигнал, а отказ загрузки: строка у кнопки — не «після розбору сигналу»
    expect(unknown).not.toContain(UI["rp.signLocked"].uk);
  });
});

describe("результаты человека для вывода", () => {
  test("последний замер каждой методики; замер этого прохождения — свой, даже если был не последним", () => {
    const d = dynamics([
      series([
        { responseId: "r1", rawScore: 19, bandLabel: "Помірно тяжка", severity: "moderate" },
        { responseId: "r2", rawScore: 16, bandLabel: "Помірна", severity: "moderate" },
        { responseId: "r3", rawScore: 14, bandLabel: "Помірна", severity: "moderate" },
      ]),
    ]);
    d.surveys.push({
      surveyId: "s2",
      title: "GAD-7",
      responseCount: 1,
      firstAt: null,
      lastAt: null,
      scales: [series([{ responseId: "g1", rawScore: 11, bandLabel: "Помірна", severity: "moderate" }], { code: "G", title: "Тривога" })],
    });
    const now = resultLines(d, "r3");
    expect(now.map((l) => [l.survey, l.value, l.delta, l.here])).toEqual([
      ["PHQ-9", 14, -5, true],
      ["GAD-7", 11, null, false],
    ]);
    // заключение по второму замеру: в строке — он, а не последний, и сдвиг — от старта до него
    const second = resultLines(d, "r2").find((l) => l.survey === "PHQ-9")!;
    expect([second.value, second.delta, second.here]).toEqual([16, -3, true]);
  });
});

type Rule = DecisionRule & { note: string | null };
const rule = (id: string, title: string, over: Partial<Rule> = {}): Rule => ({
  id,
  title,
  version: 1,
  enabled: true,
  conditions: [{ kind: "risk", severity: "severe" }],
  actions: [{ kind: "notify_duty" }],
  note: null,
  ...over,
});

const hit = (responseId: string, ruleTitle: string): RuleHit => ({
  id: `h-${responseId}-${ruleTitle}`,
  ruleTitle,
  ruleVersion: 1,
  userId: "u1",
  userName: "—",
  surveyId: "sv",
  responseId,
  status: "suggested",
  explanation: { title: ruleTitle, because: [{ met: true, text: "тяжкий ризик" }], actions: [] },
  createdAt: "2026-09-19T00:00:00.000Z",
});

describe("аналитические модели заключения", () => {
  test("вердикт — по срабатыванию именно этого прохождения; чужие модели и выключенные не в списке", () => {
    const rules = [
      rule("r1", "Тяжкий ризик"),
      rule("r2", "Інша методика", {
        conditions: [{ kind: "scale", surveyId: "other", scaleCode: "B", metric: "raw", op: ">=", value: 1 }],
      }),
      rule("r3", "Вимкнене", { enabled: false }),
      rule("r4", "Своя шкала", {
        conditions: [{ kind: "scale", surveyId: "sv", scaleCode: "A", metric: "raw", op: ">=", value: 1 }],
        note: "пояснення до правила",
      }),
    ];
    const hits = [hit("resp-1", "Тяжкий ризик"), hit("resp-2", "Своя шкала")];

    const models = applicableModels(rules, hits, "resp-1", "sv");
    expect(models.map((m) => `${m.title}: ${m.matched ? "так" : "ні"}`)).toEqual(["Тяжкий ризик: так", "Своя шкала: ні"]);
    /* описание: пояснение правила, а без него — объяснение движка у сработавшего */
    expect(models[0]!.description).toBe("тяжкий ризик");
    expect(models[1]!.description).toBe("пояснення до правила");
  });
});
