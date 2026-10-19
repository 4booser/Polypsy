import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI, type AlertCase, type AlertCasePage, type ResponseContextSignal, type SafetyPlan } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import {
  appendPhrase,
  draftOf,
  draftsDirty,
  NOTE_MAX,
  personCasesLoad,
  SafetyPlanSection,
  withDraft,
  withoutDraft,
} from "../src/components/RiskReview";
import { Strip } from "../src/pages/patientCard/Banner";
import { conclusionLock } from "../src/pages/patientCard/Panes";
import type { CardView } from "../src/pages/patientCard/types";

/**
 * Разбор риска в карточке пациента и в очереди (волна 26, клинический
 * разбор): открытый риск не пропадает с экрана на сбое, решение ложится на
 * тот случай, о котором его писали, а нотатка не теряет хвост.
 */

const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

/** Есть ли в разметке строка словаря — на любом из языков консоли */
const has = (html: string, key: keyof typeof UI) => {
  const e = UI[key] as { uk: string; ru: string; en: string };
  return html.includes(e.uk) || html.includes(e.ru) || html.includes(e.en);
};

function caseRow(over: Partial<AlertCase> = {}): AlertCase {
  return {
    id: "case-1",
    userId: "p1",
    userName: "Мельник Оксана",
    unit: "Рота 1",
    surveyId: "s1",
    surveyTitle: "Скринінг",
    severity: "severe",
    openedAt: "2026-10-19T08:00:00.000Z",
    lastAlertAt: "2026-10-19T09:00:00.000Z",
    signalCount: 1,
    signals: [],
    minutesOpen: 30,
    escalateMinutes: 240,
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

function view(over: Partial<CardView> = {}): CardView {
  return {
    id: "p1",
    card: { id: "p1", fullName: "Мельник Оксана", firstName: "Оксана", conclusions: [], responses: [] } as unknown as CardView["card"],
    now: Date.parse("2026-10-19T10:00:00.000Z"),
    dynamics: null,
    dynamicsError: null,
    reloadDynamics: () => {},
    timeline: [],
    visits: [],
    next: null,
    last: null,
    noShow: null,
    assignments: [],
    cases: [],
    casesError: null,
    reloadCases: () => {},
    thread: null,
    messages: null,
    notes: null,
    plan: null,
    planKnown: true,
    planError: null,
    reloadPlan: () => {},
    details: {},
    rows: [],
    nextIsMine: false,
    slotId: null,
    setSlotId: () => {},
    open: () => {},
    goTab: () => {},
    pane: null,
    can: () => true,
    reload: () => {},
    ...over,
  };
}

const NO_DRAFTS = { thread: false, concl: false, note: false, signal: false };

describe("случаи человека: сбой — ошибкой, а не «случаев нет»", () => {
  test("отказ сервера доходит до экрана, а не превращается в пустой список", async () => {
    const failing = (() => Promise.reject(new Error("500"))) as unknown as typeof import("../src/api").api.alertCases;
    await expect(personCasesLoad(true, "p1", failing)).rejects.toThrow("500");
  });

  test("ответ — строки случаев; запрос — открытые случаи человека, по одному", async () => {
    let asked: Record<string, string | undefined> | null = null;
    const list = ((q: Record<string, string | undefined>) => {
      asked = q;
      return Promise.resolve({ items: [caseRow()], nextCursor: null, grouping: "case" } as AlertCasePage);
    }) as unknown as typeof import("../src/api").api.alertCases;
    expect((await personCasesLoad(true, "p1", list)).map((c) => c.id)).toEqual(["case-1"]);
    expect(asked).toMatchObject({ status: "open", group: "case", patient: "p1" });
  });

  test("без права разбора — пусто и без запроса: сервер всё равно отказал бы", async () => {
    let called = false;
    const list = (() => {
      called = true;
      return Promise.reject(new Error("403"));
    }) as unknown as typeof import("../src/api").api.alertCases;
    expect(await personCasesLoad(false, "p1", list)).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("строка открытого карточки", () => {
  test("случаи не пришли — «не вдалося перевірити», а не «нічого відкритого»", () => {
    const html = draw(<Strip v={view({ cases: null, casesError: "Не вдалося завантажити" })} drafts={NO_DRAFTS} />);
    expect(has(html, "rr.casesFailed")).toBe(true);
    expect(has(html, "card.nothingOpen")).toBe(false);
  });

  test("случаи ещё в пути — строка молчит, а не обещает, что открытого нет", () => {
    const html = draw(<Strip v={view({ cases: null })} drafts={NO_DRAFTS} />);
    expect(has(html, "card.nothingOpen")).toBe(false);
    expect(has(html, "rr.casesFailed")).toBe(false);
  });

  test("случаев нет — «нічого відкритого»", () => {
    const html = draw(<Strip v={view({ cases: [] })} drafts={NO_DRAFTS} />);
    expect(has(html, "card.nothingOpen")).toBe(true);
  });

  test("открытый случай — красная пилюля сигнала с «Розібрати»", () => {
    const html = draw(<Strip v={view({ cases: [caseRow()] })} drafts={NO_DRAFTS} />);
    expect(has(html, "card.signal")).toBe(true);
    expect(has(html, "card.review")).toBe(true);
    expect(has(html, "card.nothingOpen")).toBe(false);
  });

  test("«плану безпеки немає» — только когда план пришёл и его нет", () => {
    const unknown = draw(<Strip v={view({ cases: [caseRow()], planKnown: false, planError: "Не вдалося завантажити" })} drafts={NO_DRAFTS} />);
    expect(has(unknown, "rr.noPlan")).toBe(false);
    const known = draw(<Strip v={view({ cases: [caseRow()], planKnown: true, plan: null })} drafts={NO_DRAFTS} />);
    expect(has(known, "rr.noPlan")).toBe(true);
  });
});

describe("план безпеки в ящике разбора", () => {
  const plan: SafetyPlan = {
    id: "sp1",
    userId: "p1",
    version: 3,
    active: true,
    content: {
      warningSigns: [],
      copingStrategies: [],
      distractions: [],
      people: [{ name: "Брат Олег", contact: "+380 67 315 40 22" }],
      professionals: [],
      meansRestriction: "",
      reasonsToLive: [],
    },
    createdAt: "2026-10-01T10:00:00.000Z",
    reviewedAt: null,
    authorName: "Іванова Анна",
  } as unknown as SafetyPlan;

  test("отказ — отказом с «Повторити», а не «плану немає»", () => {
    const html = draw(<SafetyPlanSection userId="p1" plans={null} loading={false} error="Не вдалося завантажити" onRetry={() => {}} />);
    expect(html).toContain("Не вдалося завантажити");
    expect(has(html, "common.retry")).toBe(true);
    expect(has(html, "rr.noPlan")).toBe(false);
  });

  test("план пришёл — кому звонить; плана нет — «плану немає»", () => {
    const shown = draw(<SafetyPlanSection userId="p1" plans={[plan]} loading={false} error={null} onRetry={() => {}} />);
    expect(shown).toContain("Брат Олег");
    expect(has(shown, "rr.noPlan")).toBe(false);
    const none = draw(<SafetyPlanSection userId="p1" plans={[]} loading={false} error={null} onRetry={() => {}} />);
    expect(has(none, "rr.noPlan")).toBe(true);
  });
});

describe("заключение в ящике карточки: замок подписи — как на странице заключения", () => {
  const signal = (over: Partial<ResponseContextSignal> = {}): ResponseContextSignal =>
    ({
      id: "sig-1",
      label: "Пункт 9: думки про смерть",
      severity: "severe",
      at: "2026-10-19T08:00:00.000Z",
      here: true,
      questionId: "q9",
      surveyTitle: "PHQ-9",
      minutesOpen: 95,
      escalateMinutes: 240,
      reviewedAt: null,
      ...over,
    }) as ResponseContextSignal;

  test("неразобранный сигнал этого прохождения — подпись закрыта, сигнал назван", () => {
    const lock = conclusionLock({ signals: [signal()] }, false, true);
    expect(lock.gate).toBe("locked");
    expect(lock.open.map((s) => s.label)).toEqual(["Пункт 9: думки про смерть"]);
  });

  test("сигнал другого замера или разобранный — подпись открыта", () => {
    expect(conclusionLock({ signals: [signal({ here: false })] }, false, true).gate).toBe("open");
    expect(conclusionLock({ signals: [signal({ reviewedAt: "2026-10-19T09:00:00.000Z" })] }, false, true).gate).toBe("open");
  });

  test("обстановка едет — подпись ждёт; не пришла — закрыта, а не открыта", () => {
    expect(conclusionLock(null, false, true).gate).toBe("pending");
    expect(conclusionLock(null, true, true).gate).toBe("unknown");
    // без права разбора сигналы не видны — судить не из чего, подпись по правилам сервера
    expect(conclusionLock(null, true, false).gate).toBe("open");
  });

  test("кнопка «Підписати» ящика заперта замком, как на полной странице", () => {
    const panes = readFileSync(resolve(import.meta.dir, "../src/pages/patientCard/Panes.tsx"), "utf8");
    expect(panes).toContain("disabled={busy || !plan.canSign || locked}");
    expect(panes).toContain("api.responseContext(rid!)");
  });
});

describe("редактор плана безпеки: поля с именем", () => {
  test("у каждого поля плана — имя для диктора, а не только подсказка-заглушка", () => {
    /*
     * Заглушка («Своїми словами», «Хто», «Контакт») исчезает с первой
     * буквой, и строки разделов становились безымянными полями подряд.
     */
    const source = readFileSync(resolve(import.meta.dir, "../src/components/SafetyPlanEditor.tsx"), "utf8");
    const fields = [...source.matchAll(/<(Input|Textarea)\b[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(fields.length).toBeGreaterThanOrEqual(4);
    for (const f of fields) expect(f, f).toContain("aria-label=");
  });
});

describe("черновик разбора — у своего случая", () => {
  test("набранное к одному случаю не встаёт на другой", () => {
    let drafts = withDraft({}, "case-a", (d) => ({ ...d, outcome: "confirmed", note: "Подзвонила брату" }));
    expect(draftOf(drafts, "case-a")).toEqual({ outcome: "confirmed", note: "Подзвонила брату" });
    /* случай «а» разобрал коллега, ящик встал на «б» — у «б» своё, пустое */
    expect(draftOf(drafts, "case-b")).toEqual({ outcome: "", note: "" });
    drafts = withDraft(drafts, "case-b", (d) => ({ ...d, note: "Другий випадок" }));
    expect(draftOf(drafts, "case-a").note).toBe("Подзвонила брату");
    expect(draftOf(drafts, "case-b")).toEqual({ outcome: "", note: "Другий випадок" });
  });

  test("сохранённый случай забывает своё, остальные — нет", () => {
    const drafts = withoutDraft(
      withDraft(withDraft({}, "case-a", (d) => ({ ...d, outcome: "confirmed" })), "case-b", (d) => ({ ...d, note: "x" })),
      "case-a",
    );
    expect(draftOf(drafts, "case-a")).toEqual({ outcome: "", note: "" });
    expect(draftOf(drafts, "case-b").note).toBe("x");
  });

  test("«чернетку збережено» — пока набранное лежит у открытого случая", () => {
    const drafts = withDraft({}, "case-a", (d) => ({ ...d, note: "  " }));
    expect(draftsDirty(drafts, ["case-a"])).toBe(false);
    const typed = withDraft(drafts, "case-a", (d) => ({ ...d, outcome: "needs_followup" }));
    expect(draftsDirty(typed, ["case-a"])).toBe(true);
    /* случай ушёл из открытых — его черновик закрытию не мешает */
    expect(draftsDirty(typed, ["case-b"])).toBe(false);
  });
});

describe("нотатка разбора", () => {
  test("«що вжито» дописывается через точку и не длиннее предела сервера", () => {
    expect(appendPhrase("", "Зателефоновано")).toBe("Зателефоновано");
    expect(appendPhrase("Говорили  ", "План переглянуто")).toBe("Говорили. План переглянуто");
    expect(appendPhrase("Говорили.", "План переглянуто")).toBe("Говорили. План переглянуто");
    expect(appendPhrase("я".repeat(NOTE_MAX), "Записано на прийом")).toHaveLength(NOTE_MAX);
  });

  test("поле нотатки не даёт набрать больше, чем сохранит сервер (2000)", () => {
    expect(NOTE_MAX).toBe(2000);
    const route = readFileSync(resolve(import.meta.dir, "../../api/src/routes/alertCases.ts"), "utf8");
    expect(route).toContain(`body.note.slice(0, ${NOTE_MAX})`);
    const source = readFileSync(resolve(import.meta.dir, "../src/components/RiskReview.tsx"), "utf8");
    expect(source).toContain("maxLength={NOTE_MAX}");
  });
});

describe("разбор читает своё, когда его открыли", () => {
  const read = (p: string) => readFileSync(resolve(import.meta.dir, "../src", p), "utf8");

  test("ящик очереди грузит план безпеки и случаи человека только открытым", () => {
    /*
     * Прежде ящик был «включён» при любом выбранном случае (`open || !!userId`):
     * каждый J/K по очереди читал план безпеки человека (журнал:
     * response.read safety_plan) и его случаи (alert.list), которых при
     * закрытом ящике не видно.
     */
    const source = read("components/RiskReview.tsx");
    expect(source).toContain("useRiskReview({ userId, caseId, known, enabled: open,");
    expect(source).not.toContain("enabled: open || !!userId");
  });

  test("карточка открывает разбор по R; основание и план читаются при открытом ящике; 1–3 — исход", () => {
    const card = read("pages/patientCard/PatientCard.tsx");
    expect(card).toContain('const reviewing = drawer.open && drawer.mode === "signal";');
    expect(card).toContain("enabled: reviewing,");
    expect(card).not.toContain("enabled: true,");
    for (const [code, outcome] of [
      ["Digit1", "confirmed"],
      ["Digit2", "needs_followup"],
      ["Digit3", "not_confirmed"],
    ]) {
      expect(card).toContain(`${code}: () => review.pick("${outcome}")`);
    }
  });
});
