import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PatientCard, Referral } from "@quizzy/shared";
import type { ConclusionVersion } from "../src/api";
import { leadAction, resultRows, withConclusion, withEpisode, withLead, withReferral } from "../src/pages/patientCard/model";
import { recordKindOf, tabRoute, workspacePath } from "../src/pages/patientCard/tabs";

/**
 * Рабочее место пациента (Polypsy 2.0, «Дія без переходу»): то, что на живом
 * экране проверяется лишь случайно.
 *
 * Подпись «Зняти закріплення / Закріпити за собою» — это право: «Зняти» на чужом
 * закреплении сервер отвергает, и пункт, который обещает отпустить чужого
 * пациента, — обман. Адреса — второе: на рабочее место ведут ссылки с десятка
 * экранов, прежняя клиническая карта (/case) стала его вкладками, и её
 * адреса, как и прежние ?tab=, обязаны вести туда же. Клиника — в
 * patientCardClinical.test.ts, колонка «Мої пацієнти» — в patientCardList.test.ts.
 */

const SRC = resolve(import.meta.dir, "../src");

describe("карточка пациента: вкладка «Заміри»", () => {
  const scales = [
    { code: "A", title: "Тривожність", value: 14, normalization: "raw" as const, percent: 70, bandLabel: "підвищена", severity: "moderate" as const },
    { code: "D", title: "Депресія", value: 3, normalization: "raw" as const, percent: 15, bandLabel: null, severity: null },
  ];

  test("«Результат» — каждая шкала своей строкой: название, балл и полоса", () => {
    expect(resultRows(scales)).toEqual([
      { title: "Тривожність", value: "14", band: "підвищена" },
      { title: "Депресія", value: "3", band: null },
    ]);
    expect(resultRows([])).toEqual([]);
  });

  test("доля — процентом, дробь — запятой языка: «57%», а не «0.571»; «64,2», а не «64.24»", () => {
    const ratio = [
      { code: "Sr", title: "Схильність", value: 0.571, normalization: "ratio" as const, percent: 57.1, bandLabel: "середній", severity: "moderate" as const },
      { code: "Pa", title: "Параноя", value: 64.24, normalization: "tscore" as const, percent: 18.8, bandLabel: null, severity: null },
    ];
    // вне браузера язык консоли — русский: дробь пишется запятой
    expect(resultRows(ratio).map((r) => r.value)).toEqual(["57%", "64,2"]);
  });

  test("колонки «Статистика» нет: служебные коды шкал и доля от максимума на экран не идут", () => {
    const tabs = readFileSync(join(SRC, "pages/patientCard/TabViews.tsx"), "utf8");
    const measures = tabs.slice(tabs.indexOf("export function MeasuresTab"), tabs.indexOf("export function MessagesTab"));
    expect(measures).not.toContain("top.statistics");
    expect(measures).not.toMatch(/\.code\b|\.percent\b/);
    expect(measures).toContain('ut("card.tMeasures")');
  });

});

describe("карточка пациента: закрепление", () => {
  test("«Зняти закріплення» только на своём закреплении; чужое и пустое — «Закріпити за собою»", () => {
    expect(leadAction({ lead: null })).toBe("subscribe");
    expect(leadAction({ lead: { specialistId: "s2", name: "Інша", mine: false } })).toBe("subscribe");
    expect(leadAction({ lead: { specialistId: "s1", name: "Я", mine: true } })).toBe("unsubscribe");
  });
});

describe("рабочее место пациента: адреса", () => {
  const app = readFileSync(join(SRC, "App.tsx"), "utf8");
  const read = (f: string) => readFileSync(join(SRC, "pages/patientCard", f), "utf8");
  const card = read("PatientCard.tsx");
  const banner = read("Banner.tsx");
  const records = read("Records.tsx");

  test("страница о человеке одна — /patients/:userId; клинической карты отдельным экраном нет", () => {
    expect(app).toContain('<Route path="/patients/:userId" element={<PatientCard />} />');
    expect(app).not.toContain("CaseCard");
    expect(app).not.toContain("CaseSummary");
  });

  test("прежние адреса клинической карты и сводки перенаправляются на вкладки, а не проваливаются в «*»", () => {
    for (const [tail, tab] of [
      ["case", ""],
      ["case/dynamics", "dynamics"],
      ["case/timeline", "timeline"],
      ["summary", ""],
      ["dynamics", "dynamics"],
      ["timeline", "timeline"],
    ]) {
      expect(app, `/patients/:userId/${tail} без перенаправления`).toContain(
        `<Route path="/patients/:userId/${tail}" element={<RedirectToPatient${tab ? ` tab="${tab}"` : ""} />} />`,
      );
    }
    expect(workspacePath("u1", "")).toBe("/patients/u1");
    expect(workspacePath("u1", "dynamics")).toBe("/patients/u1?tab=dynamics");
    // хвост прежнего адреса не теряется
    expect(workspacePath("u1", "timeline", "?from=queue")).toBe("/patients/u1?from=queue&tab=timeline");
  });

  test("прежние ?tab= карточки ведут туда, где их сведения теперь", () => {
    expect(tabRoute(null)).toEqual({ tab: "overview", rewrite: null });
    expect(tabRoute("dynamics")).toEqual({ tab: "dynamics", rewrite: null });
    expect(tabRoute("timeline")).toEqual({ tab: "timeline", rewrite: null });
    expect(tabRoute("conclusions")).toEqual({ tab: "records", rewrite: { tab: "records", kind: "concl" } });
    expect(tabRoute("notes")).toEqual({ tab: "records", rewrite: { tab: "records", kind: "notes" } });
    expect(tabRoute("visits")).toEqual({ tab: "timeline", rewrite: { tab: "timeline", kind: "visit" } });
    // незнакомое — «Огляд», и адрес говорит то же
    expect(tabRoute("nonsense")).toEqual({ tab: "overview", rewrite: { tab: "" } });
    expect(recordKindOf("concl")).toBe("concl");
    expect(recordKindOf("visit")).toBe("all");
  });

  test("ссылки рабочего места собраны по форме объявленных маршрутов", () => {
    // группа пациентов и заключение — свои экраны со своими адресами (App.tsx)
    expect(banner).toContain("`/patient-groups/${g.id}`");
    expect(app).toContain('path="/patient-groups/:id"');
    expect(records).toContain("`/responses/${c.responseId}/conclusion`");
    expect(app).toContain('path="/responses/:id/conclusion"');
  });

  test("открытие — по-прежнему чтение GET /api/patients/:id/card (журнал сервера)", () => {
    expect(card).toContain("useResource(() => api.patientCard(id), [id], { keep: false })");
  });

  test("журнал читает то, что показано: ни сводки консилиума, ни карточки приёма ради «Огляду»", () => {
    /*
     * Сводка консилиума (/referrals/summary) читала баллы и RCI по всем
     * методикам и писала «прочитана вся карта» ради списка направлений;
     * карточка приёма (/clinic/appointments/:id/context) писала «открыл
     * приём» (clinic.visit_open) ради вида и формата ближайшего приёма. Оба
     * теперь приходят с карточкой и из GET /api/referrals?patient=.
     */
    const all = ["PatientCard.tsx", "Overview.tsx", "Banner.tsx", "ReferralsTab.tsx", "Panes.tsx"].map(read).join("\n");
    expect(all).not.toContain("api.caseSummary(");
    expect(all).not.toContain("api.visitContext(");
    expect(card).toContain("api.referrals(true, null, { patient: id })");
  });
});

describe("карточка пациента: после действия — только то, что оно меняет (волна 27)", () => {
  const read = (f: string) => readFileSync(join(SRC, "pages/patientCard", f), "utf8");
  const card = read("PatientCard.tsx");
  const panes = read("Panes.tsx");

  /*
   * Каждое чтение здесь пишет журнал: карточка — patient.card_read,
   * хронология, нотатки и план — response.read, случаи — alert.list. Прежде
   * любое действие в ящике перечитывало их все, подпись после сохранения —
   * дважды.
   */
  test("ни одно действие ящика не перечитывает карточку, случаи и план безпеки", () => {
    expect(panes).not.toContain("v.reload()");
    expect(card).not.toContain("reloadCard");
    const refresh = card.slice(card.indexOf("const refresh = useMemo<CardRefresh>"), card.indexOf("const v: CardView"));
    for (const read of ["cases.reload", "plans.reload", "res.reload", "dynamics.reload", "messages.reload"]) {
      expect(refresh, read).not.toContain(read);
    }
  });

  test("выдача методики и закрепление ничего не перечитывают", () => {
    const assign = card.slice(card.indexOf("onAssign={async (surveyId"), card.indexOf("sets={{"));
    expect(assign).toContain("api.grant(");
    expect(assign).not.toMatch(/reload|refresh/);
    const lead = card.slice(card.indexOf("const toggleLead"), card.indexOf("/* ── ящик встаёт под полосу"));
    expect(lead).toContain("withLead(");
    expect(lead).not.toMatch(/reload|refresh/);
  });

  test("назначение набора перечитывает только хронологию: назначение — её событие и пилюля шапки", () => {
    const sets = card.slice(card.indexOf("sets={{"), card.indexOf("function ButtonLike"));
    expect(sets).toContain("api.assignBattery(");
    expect(sets).toContain("refresh.timeline()");
    expect(sets).not.toMatch(/\.reload\(|refresh\.(messages|notes|conclusion)/);
  });

  const base = (over: Partial<PatientCard> = {}): PatientCard =>
    ({
      id: "p1",
      responses: [
        { responseId: "r1", surveyId: "s1", surveyTitle: "PHQ-9", submittedAt: "2026-10-01", reliable: true, scales: [] },
        { responseId: "r2", surveyId: "s2", surveyTitle: "GAD-7", submittedAt: "2026-10-02", reliable: true, scales: [] },
      ],
      conclusions: [
        {
          id: "c2",
          responseId: "r2",
          surveyId: "s2",
          surveyTitle: "GAD-7",
          version: 1,
          status: "signed",
          text: "Інше",
          createdAt: "2026-10-05 10:00:00+03",
          signedAt: "2026-10-05 10:05:00+03",
          authorName: "Колега",
        },
      ],
      lead: null,
      ...over,
    }) as unknown as PatientCard;
  const version = (over: Partial<ConclusionVersion>): ConclusionVersion => ({
    id: "v",
    version: 1,
    revision: 1,
    text: "",
    status: "draft",
    createdAt: "2026-10-10 09:00:00+03",
    authorName: "Я",
    signedAt: null,
    ...over,
  });

  test("сохранили черновик поверх подписанного — на карточке подписанная и свой черновик, как отдаёт сервер", () => {
    const signed = version({ id: "c1v1", version: 1, status: "signed", text: "Було", createdAt: "2026-10-03 09:00:00+03", signedAt: "2026-10-03 09:30:00+03", authorName: "Колега" });
    const draft = version({ id: "c1v2", version: 2, text: "Стало", createdAt: "2026-10-10 09:00:00+03" });
    const before = base();
    const next = withConclusion(before, "r1", { current: draft, versions: [draft, signed] });
    expect(next.conclusions.map((c) => [c.id, c.status, c.surveyTitle, c.text])).toEqual([
      ["c1v2", "draft", "PHQ-9", "Стало"],
      ["c2", "signed", "GAD-7", "Інше"],
      ["c1v1", "signed", "PHQ-9", "Було"],
    ]);
    // остальное карточки — то же, что пришло с её чтением
    expect(next.responses).toBe(before.responses);
    expect(next.lead).toBe(before.lead);
  });

  test("подписали — черновика нет, одна подписанная последняя; чужие строки не тронуты", () => {
    const old = version({ id: "c1v1", version: 1, status: "signed", createdAt: "2026-10-03 09:00:00+03" });
    const signed = version({ id: "c1v2", version: 2, status: "signed", text: "Підписано", signedAt: "2026-10-10 09:10:00+03" });
    const before = base({
      conclusions: [...base().conclusions, { ...base().conclusions[0]!, id: "c1v2", responseId: "r1", surveyId: "s1", surveyTitle: "PHQ-9", status: "draft", version: 2 }],
    });
    const next = withConclusion(before, "r1", { current: signed, versions: [signed, old] });
    expect(next.conclusions.filter((c) => c.responseId === "r1").map((c) => [c.id, c.status, c.text])).toEqual([
      ["c1v2", "signed", "Підписано"],
    ]);
    expect(next.conclusions.find((c) => c.responseId === "r2")).toEqual(base().conclusions[0]!);
  });

  test("первый черновик по прохождению — одна строка-черновик", () => {
    const draft = version({ id: "n1", text: "Перший" });
    const next = withConclusion(base(), "r1", { current: draft, versions: [draft] });
    expect(next.conclusions.filter((c) => c.responseId === "r1").map((c) => [c.id, c.status])).toEqual([["n1", "draft"]]);
  });

  test("закрепление: взял — ведущий я, отпустил — никого", () => {
    const me = { id: "s1", fullName: "Іваненко Ірина" };
    expect(withLead(base(), true, me).lead).toEqual({ specialistId: "s1", name: "Іваненко Ірина", mine: true });
    expect(withLead(base({ lead: { specialistId: "s1", name: "Іваненко Ірина", mine: true } }), false, me).lead).toBeNull();
  });
});

describe("рабочее место: правки без нового чтения карточки", () => {
  const card = { id: "p1", openReferrals: [], episode: null } as unknown as PatientCard;
  const referral = (over: Partial<Referral>): Referral =>
    ({
      id: "rf1",
      userId: "p1",
      userName: "Мельник",
      responseId: null,
      alertId: null,
      destination: "psychiatrist",
      urgency: "urgent",
      status: "created",
      reason: "Повід",
      outcomeNote: null,
      createdByName: "Я",
      createdAt: "2026-10-20T09:00:00.000Z",
      updatedAt: null,
      ...over,
    }) as Referral;

  test("направление выписали — в «Плані»; завершили — ушло оттуда; повод в карточку не идёт", () => {
    const issued = withReferral(card, referral({}));
    expect(issued.openReferrals).toEqual([
      { id: "rf1", destination: "psychiatrist", urgency: "urgent", status: "created", createdAt: "2026-10-20T09:00:00.000Z" },
    ]);
    const accepted = withReferral(issued, referral({ status: "accepted" }));
    expect(accepted.openReferrals?.map((r) => r.status)).toEqual(["accepted"]);
    expect(withReferral(accepted, referral({ status: "completed" })).openReferrals).toEqual([]);
  });

  test("обращение открыли или закрыли — шапка правится тем, что сказал ящик", () => {
    const ep = { id: "e1", openedAt: "2026-10-12T08:00:00.000Z", reason: "Гостра реакція на стрес", leadName: "Я" };
    expect(withEpisode(card, ep).episode).toEqual(ep);
    expect(withEpisode(withEpisode(card, ep), null).episode).toBeNull();
  });
});
