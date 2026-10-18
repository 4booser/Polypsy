import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI, type Question, type ScoreResult, type SurveyListItem, type SurveyResponse, type UiKey, uiText } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { TouchArea } from "../src/ui/primitives";
import { ChoiceInput, pickChoice } from "../src/patient/answerInputs";
import { consentSections } from "../src/patient/ConsentGate";
import { freeCancelUntil } from "../src/patient/Home";
import { createDrafts, type OutboxItem, type OutboxStorage, type RunnerDraft } from "../src/patient/outbox";
import { instrumentCode, instrumentName } from "../src/patient/parts";
import { mainScore, scoreValue } from "../src/patient/results";
import { TestsBody } from "../src/patient/Tests";
import { dayOffset, dayPart, greetingKey, localDayKey, whenSaid } from "../src/patient/when";
import type { Resource } from "../src/useResource";
import { yesNoQuestion } from "../../../packages/shared/test/fixtures";

/**
 * Кабинет пациента 2.0 («Виразна», patient_web): то, что экраны добавили
 * сверх прежних — черновик прохождения на устройстве, код методики на
 * плитке, даты словами, клавиши ответа, абзацы согласия и порядок «Пройти».
 */

const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>
        <TouchArea>{node}</TouchArea>
      </LangProvider>
    </MemoryRouter>,
  );

const has = (html: string, key: UiKey) => {
  const e = UI[key] as { uk: string; ru: string; en?: string };
  return [e.uk, e.ru, e.en].some((t) => !!t && html.includes(t));
};

const ut = (key: UiKey) => uiText(key, "uk");

function memory(): OutboxStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const draft = (over: Partial<RunnerDraft> = {}): RunnerDraft => ({
  surveyId: "s1",
  versionId: "v1",
  title: "Тривога (GAD-7)",
  answers: { q1: { optionIds: ["o2"] } },
  times: { q1: 4200 },
  step: 1,
  total: 7,
  answered: 1,
  startedAt: "2026-10-18T09:00:00.000Z",
  savedAt: "2026-10-18T09:01:00.000Z",
  ...over,
});

describe("черновик прохождения на устройстве", () => {
  test("ответы, время и место ложатся и читаются как были", () => {
    const store = createDrafts(memory());
    expect(store.save("u1", draft())).toBe(true);
    expect(store.get("u1", "s1")).toEqual(draft());
    expect(store.get("u1", "s2")).toBeNull();
  });

  test("черновик одного человека другому не виден: за одним компьютером входят разные люди", () => {
    const store = createDrafts(memory());
    store.save("u1", draft());
    expect(store.get("u2", "s1")).toBeNull();
    expect(store.list("u2")).toEqual([]);
  });

  test("список — свежие первыми; сданный черновик удаляется, и пустая запись не остаётся", () => {
    const mem = memory();
    const store = createDrafts(mem);
    store.save("u1", draft({ surveyId: "a", savedAt: "2026-10-18T09:00:00.000Z" }));
    store.save("u1", draft({ surveyId: "b", savedAt: "2026-10-18T10:00:00.000Z" }));
    expect(store.list("u1").map((d) => d.surveyId)).toEqual(["b", "a"]);
    store.drop("u1", "a");
    store.drop("u1", "b");
    expect(store.list("u1")).toEqual([]);
    expect(mem.map.size).toBe(0);
  });

  test("хранилище недоступно — сохранение говорит «нет», а не роняет экран", () => {
    const broken: OutboxStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    expect(createDrafts(broken).save("u1", draft())).toBe(false);
  });

  test("испорченная запись читается как пустая", () => {
    const mem = memory();
    mem.setItem("quizzy.drafts.u1", "{не json");
    expect(createDrafts(mem).list("u1")).toEqual([]);
  });
});

describe("код методики на плитке — из её же названия", () => {
  test("код в скобках, первым из перечня или в начале названия", () => {
    expect(instrumentCode("Тривога (GAD-7)")).toBe("GAD-7");
    expect(instrumentCode("Поширені психічні розлади (SRQ-20, ВООЗ)")).toBe("SRQ-20");
    expect(instrumentCode("Відчуття самотності (UCLA, 3 пункти)")).toBe("UCLA");
    expect(instrumentCode("СР-45. Схильність до суїцидальних реакцій")).toBe("СР-45");
  });

  test("кода нет — нет и выдуманного сокращения", () => {
    expect(instrumentCode("Самооцінка (шкала Розенберга)")).toBeNull();
    expect(instrumentCode("БОО «Адаптивність-200»")).toBeNull();
    expect(instrumentCode("Способи подолання стресу (Brief COPE)")).toBeNull();
  });

  test("название без кода — только когда в скобках ничего, кроме кода", () => {
    expect(instrumentName("Тривога (GAD-7)")).toBe("Тривога");
    expect(instrumentName("Поширені психічні розлади (SRQ-20, ВООЗ)")).toBe("Поширені психічні розлади (SRQ-20, ВООЗ)");
    expect(instrumentName("Самооцінка (шкала Розенберга)")).toBe("Самооцінка (шкала Розенберга)");
  });
});

describe("даты словами", () => {
  const NOW = new Date(2026, 9, 18, 17, 0).getTime();
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, 18 + d, h, m).toISOString();

  test("сегодня, вчера, завтра — по календарю, а не по суткам от «сейчас»", () => {
    expect(dayOffset(at(0, 0, 30), NOW)).toBe(0);
    expect(dayOffset(at(-1, 23, 59), NOW)).toBe(-1);
    expect(dayOffset(at(1, 0, 1), NOW)).toBe(1);
    expect(whenSaid(at(0, 14, 12), ut, NOW)).toBe("сьогодні о 14:12");
    expect(whenSaid(at(-1, 19, 40), ut, NOW)).toBe("учора о 19:40");
    expect(whenSaid(at(-15, 21, 14), ut, NOW)).toBe("03.10 о 21:14");
  });

  test("приветствие и время суток слота — по часу", () => {
    expect(greetingKey(new Date(2026, 9, 18, 8))).toBe("ptw.helloMorning");
    expect(greetingKey(new Date(2026, 9, 18, 13))).toBe("ptw.helloDay");
    expect(greetingKey(new Date(2026, 9, 18, 21))).toBe("ptw.helloEvening");
    expect(greetingKey(new Date(2026, 9, 18, 2))).toBe("ptw.helloEvening");
    expect(dayPart(at(0, 10, 30))).toBe("morning");
    expect(dayPart(at(0, 14))).toBe("day");
    expect(dayPart(at(0, 18))).toBe("evening");
    expect(localDayKey(at(0, 0, 10))).toBe("2026-10-18");
  });

  test("отмена без последствий — до суток перед началом, как у сервера", () => {
    expect(freeCancelUntil("2026-10-20T08:00:00.000Z")).toBe("2026-10-19T08:00:00.000Z");
  });
});

describe("клавиши ответа", () => {
  const choiceQuestion = (type: Question["type"]): Question => ({ ...yesNoQuestion(0), type });

  test("один ответ — цифра заменяет выбор; несколько — переключает", () => {
    const single = choiceQuestion("single");
    expect(pickChoice(single, { optionIds: ["a"] }, "b")).toEqual({ optionIds: ["b"] });
    const multi = choiceQuestion("multiple");
    expect(pickChoice(multi, { optionIds: ["a"] }, "b")).toEqual({ optionIds: ["a", "b"] });
    expect(pickChoice(multi, { optionIds: ["a", "b"] }, "a")).toEqual({ optionIds: ["b"] });
  });

  test("один ответ — радиогруппа с одной остановкой Tab; клавиша подписана на плитке", () => {
    const q = choiceQuestion("single");
    const [first, second] = q.options.filter((o) => o.kind === "option");
    const html = draw(
      <>
        <h1 id="t">{q.title}</h1>
        <ChoiceInput question={q} answer={{ optionIds: [second!.id] }} onChange={() => {}} labelledBy="t" />
      </>,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)?.length).toBe(2);
    expect(html.match(/aria-checked="true"/g)?.length).toBe(1);
    // табуляция встаёт на выбранный, а не на первый
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
    expect(html).toMatch(new RegExp(`aria-checked="true"[^>]*tabindex="0"`));
    expect(html).toContain(first!.text);
    expect(html).toMatch(/<kbd[^>]*>1<\/kbd>/);
    expect(html).toMatch(/<kbd[^>]*>2<\/kbd>/);
  });

  test("несколько ответов — переключатели с aria-pressed, квадратной отметкой", () => {
    const q = choiceQuestion("multiple");
    const html = draw(
      <>
        <h1 id="t">{q.title}</h1>
        <ChoiceInput question={q} answer={{ optionIds: [] }} onChange={() => {}} labelledBy="t" />
      </>,
    );
    expect(html).toContain('role="group"');
    expect(html).not.toContain('role="radio"');
    expect(html.match(/aria-pressed="false"/g)?.length).toBe(2);
  });
});

describe("согласие абзацами", () => {
  test("короткая строка без точки над абзацем — его заголовок; иначе абзац как есть", () => {
    expect(
      consentSections("Навіщо ця згода\nВідділення проводить обстеження.\n\nЯ можу звернутися до психолога з питаннями."),
    ).toEqual([
      { title: "Навіщо ця згода", body: "Відділення проводить обстеження." },
      { title: null, body: "Я можу звернутися до психолога з питаннями." },
    ]);
    // одна строка — не заголовок, даже короткая
    expect(consentSections("Згоден.")).toEqual([{ title: null, body: "Згоден." }]);
  });
});

describe("результат глазами человека", () => {
  const score = (over: Partial<ScoreResult>): ScoreResult =>
    ({
      scaleId: "sc",
      scaleCode: "WHO5",
      scaleTitle: "Благополуччя",
      kind: "clinical",
      rawScore: 14,
      correctedScore: 14,
      value: 14,
      normalized: true,
      normalization: "raw",
      maxScore: 27,
      percent: 52,
      band: null,
      ...over,
    }) as ScoreResult;

  test("сырой балл — «14 з 27», доля — процентом", () => {
    expect(scoreValue(score({}), ut)).toEqual({ big: "14", of: "з 27" });
    expect(scoreValue(score({ normalization: "ratio", percent: 40 }), ut)).toEqual({ big: "40 %", of: null });
  });

  test("первой показывается содержательная шкала, а не шкала лжи", () => {
    expect(mainScore([score({ scaleId: "l", kind: "validity" }), score({ scaleId: "c" })])?.scaleId).toBe("c");
    expect(mainScore([])).toBeNull();
  });
});

describe("«Мої тести»: что пройти и в каком порядке", () => {
  const res = <T,>(data: T): Pick<Resource<T>, "data" | "error" | "loading" | "reload" | "updatedAt"> => ({
    data,
    error: null,
    loading: false,
    reload: () => {},
    updatedAt: 1,
  });
  const s = (over: Partial<SurveyListItem>): SurveyListItem =>
    ({ id: "x", title: "Методика", status: "published", completedByMe: false, questionCount: 5, ...over }) as SurveyListItem;
  const queued = (surveyId: string): OutboxItem => ({
    id: `q-${surveyId}`,
    surveyId,
    title: "Відчуття самотності (UCLA, 3 пункти)",
    payload: { clientRequestId: "r" },
    queuedAt: "2026-10-18T09:00:00.000Z",
    attempts: 0,
  });

  const body = (surveys: SurveyListItem[], extra: { drafts?: RunnerDraft[]; waiting?: OutboxItem[] } = {}) =>
    draw(
      <TestsBody
        surveys={res(surveys)}
        responses={res<{ items: SurveyResponse[] }>({ items: [] })}
        drafts={extra.drafts ?? []}
        outbox={{ waiting: extra.waiting ?? [], rejected: [], busy: false, flush: () => {}, retry: () => {}, discard: () => {} }}
      />,
    );

  test("почато — первым, затем назначенное по сроку, затем доступное", () => {
    const html = body(
      [
        s({ id: "free", title: "Вільна (AAA)" }),
        s({ id: "late", title: "Пізня (BBB)", assigned: true, dueAt: "2026-10-30T00:00:00.000Z" }),
        s({ id: "soon", title: "Рання (CCC)", assigned: true, dueAt: "2026-10-20T00:00:00.000Z" }),
        s({ id: "begun", title: "Почата (DDD)" }),
      ],
      { drafts: [draft({ surveyId: "begun" })] },
    );
    const at = (id: string) => html.indexOf(`href="/me/tests/${id}"`);
    expect(at("begun")).toBeGreaterThan(0);
    expect(at("begun")).toBeLessThan(at("soon"));
    expect(at("soon")).toBeLessThan(at("late"));
    expect(at("late")).toBeLessThan(at("free"));
    expect(has(html, "ptw.continue")).toBe(true);
  });

  test("пройденное не зовёт проходить, а ждущее отправки на устройстве — не зовёт ещё раз", () => {
    const html = body([s({ id: "done", completedByMe: true }), s({ id: "waits" }), s({ id: "open" })], {
      waiting: [queued("waits")],
    });
    expect(html).not.toContain('href="/me/tests/done"');
    expect(html).not.toContain('href="/me/tests/waits"');
    expect(html).toContain('href="/me/tests/open"');
    // ждущее — в панели очереди с «Відправити зараз»
    expect(has(html, "pt.outboxSend")).toBe(true);
  });

  test("пройденное, где повтор разрешён, — «Можна пройти ще раз»: открыто, когда нового нет, и свёрнуто, когда есть", () => {
    const repeatable = s({ id: "rep", title: "Повтор (EEE)", completedByMe: true, allowRetake: true });
    const once = s({ id: "once", completedByMe: true, allowRetake: false });
    const alone = body([repeatable, once]);
    expect(has(alone, "pt.noTests")).toBe(true);
    expect(has(alone, "ptw.againGroup")).toBe(true);
    expect(alone).toContain('href="/me/tests/rep"');
    expect(has(alone, "ptw.again")).toBe(true);
    // повтор не разрешён — не предлагается вовсе
    expect(alone).not.toContain('href="/me/tests/once"');
    const withNew = body([repeatable, s({ id: "new" })]);
    expect(withNew).toContain('href="/me/tests/new"');
    expect(withNew).not.toContain('href="/me/tests/rep"');
    expect(withNew).toMatch(/aria-expanded="false"/);
  });

  test("доступное всем — первые несколько, остальное по нажатию", () => {
    const many = Array.from({ length: 9 }, (_, i) => s({ id: `c${i}`, title: `Каталог ${i}` }));
    const html = body(many);
    expect(html.match(/href="\/me\/tests\/c\d"/g)?.length).toBe(4);
    expect(html).toContain(UI["ptw.showAll"].uk.replace("{n}", "5"));
  });
});
