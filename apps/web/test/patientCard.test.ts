import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { conclusionName, leadAction, resultText, statsText } from "../src/pages/patientCard/model";

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
