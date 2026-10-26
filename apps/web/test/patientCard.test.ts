import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PatientCard } from "@quizzy/shared";
import type { ConclusionVersion } from "../src/api";
import { conclusionName, leadAction, resultText, statsText, withConclusion, withLead } from "../src/pages/patientCard/model";

/**
 * Карточка пациента (Polypsy 2.0, «Дія без переходу»): то, что на живом
 * экране проверяется лишь случайно.
 *
 * Подпись «Відписатись / Підписатись» — это право: «Відписатись» на чужом
 * закреплении сервер отвергает, и пункт, который обещает отпустить чужого
 * пациента, — обман. Адреса — второе: на карточку ведут ссылки с десятка
 * экранов, клиническая карта живёт на /case, и её старые адреса обязаны
 * перенаправляться. Клиника карточки — в patientCardClinical.test.ts,
 * колонка «Мої пацієнти» — в patientCardList.test.ts.
 */

const SRC = resolve(import.meta.dir, "../src");
const iso = (s: string) => `d:${s}`;

describe("карточка пациента: вкладка «Заміри»", () => {
  const scales = [
    { code: "A", title: "Тривожність", value: 14, normalization: "raw" as const, percent: 70, bandLabel: "підвищена", severity: "moderate" as const },
    { code: "D", title: "Депресія", value: 3, normalization: "raw" as const, percent: 15, bandLabel: null, severity: null },
  ];

  test("«Результат» — балл и полоса каждой шкалы одной строкой", () => {
    expect(resultText(scales, { none: "Балів немає" })).toBe("Тривожність: 14 — підвищена; Депресія: 3");
    expect(resultText([], { none: "Балів немає" })).toBe("Балів немає");
  });

  test("«Статистика» — дата, доля от максимума по шкалам, недостоверность словом; без « · »", () => {
    expect(statsText({ submittedAt: "2026-03-01T10:00:00Z", reliable: true, scales }, { unreliable: "Протокол недостовірний" }, iso)).toBe(
      "d:2026-03-01T10:00:00Z, A 70%, D 15%",
    );
    expect(statsText({ submittedAt: null, reliable: false, scales: [] }, { unreliable: "Протокол недостовірний" }, iso)).toBe(
      "Протокол недостовірний",
    );
  });

  test("доля — процентом, дробь — запятой языка: «57%», а не «0.571»; «18,8%», а не «18.8%»", () => {
    const ratio = [
      { code: "Sr", title: "Схильність", value: 0.571, normalization: "ratio" as const, percent: 57.1, bandLabel: "середній", severity: "moderate" as const },
      { code: "Pa", title: "Параноя", value: 64.24, normalization: "tscore" as const, percent: 18.8, bandLabel: null, severity: null },
    ];
    // вне браузера язык консоли — русский: дробь пишется запятой
    expect(resultText(ratio, { none: "—" })).toBe("Схильність: 57% — середній; Параноя: 64,2");
    expect(statsText({ submittedAt: null, reliable: true, scales: ratio }, { unreliable: "—" }, iso)).toBe("Sr 57,1%, Pa 18,8%");
  });

  test("имя заключения — методика; черновик помечен словом", () => {
    expect(conclusionName({ surveyTitle: "PHQ-9", status: "signed" }, { draft: "чернетка" })).toBe("PHQ-9");
    expect(conclusionName({ surveyTitle: "PHQ-9", status: "draft" }, { draft: "чернетка" })).toBe("PHQ-9 (чернетка)");
  });
});

describe("карточка пациента: закрепление", () => {
  test("«Відписатись» только на своём закреплении; чужое и пустое — «Підписатись»", () => {
    expect(leadAction({ lead: null })).toBe("subscribe");
    expect(leadAction({ lead: { specialistId: "s2", name: "Інша", mine: false } })).toBe("subscribe");
    expect(leadAction({ lead: { specialistId: "s1", name: "Я", mine: true } })).toBe("unsubscribe");
  });
});

describe("карточка пациента: адреса", () => {
  const app = readFileSync(join(SRC, "App.tsx"), "utf8");
  const read = (f: string) => readFileSync(join(SRC, "pages/patientCard", f), "utf8");
  const card = read("PatientCard.tsx");
  const banner = read("Banner.tsx");
  const tabs = read("TabViews.tsx");

  test("карточка стоит на адресе человека, клиническая карта — под /case", () => {
    expect(app).toContain('<Route path="/patients/:userId" element={<PatientCard />} />');
    expect(app).toContain('<Route path="/patients/:userId/case" element={<CaseCard />}>');
  });

  test("прежние адреса клинической карты перенаправляются, а не проваливаются в «*»", () => {
    for (const tail of ["summary", "dynamics", "timeline"]) {
      expect(app, `/patients/:userId/${tail} без перенаправления`).toContain(`path="/patients/:userId/${tail}"`);
    }
  });

  test("ссылки карточки собраны по форме объявленных маршрутов", () => {
    // группа пациентов и заключение — свои экраны со своими адресами (App.tsx)
    expect(banner).toContain("`/patient-groups/${g.id}`");
    expect(app).toContain('path="/patient-groups/:id"');
    expect(tabs).toContain("`/responses/${c.responseId}/conclusion`");
    expect(app).toContain('path="/responses/:id/conclusion"');
    /*
     * Дверь к клинической карте — в самой карточке: колонка подразделов на
     * адресе человека спрятана (своя колонка «Мої пацієнти»), и без ссылки в
     * шапке карту в кризис было бы не открыть.
     */
    expect(banner).toContain("to={`/patients/${card.id}/case`}");
    expect(app).toContain('path="dynamics"');
    expect(app).toContain('path="timeline"');
  });

  test("открытие карточки — по-прежнему чтение GET /api/patients/:id/card (журнал сервера)", () => {
    expect(card).toContain("useResource(() => api.patientCard(id), [id], { keep: false })");
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
    const lead = card.slice(card.indexOf("const toggleLead"), card.indexOf("const [assigning"));
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
