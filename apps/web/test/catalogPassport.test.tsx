import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { RuleHit } from "@quizzy/shared";
import { ApiError } from "../src/api";
import { assignSuggested } from "../src/components/Suggestions";
import { LangProvider } from "../src/lang";
import { basisText, condText, cutoffText, fillsKey, linkCode, openSuggestions, stepText, whoKey } from "../src/pages/methods/passport";
import { DataTable, type Column } from "../src/ui/DataTable";

/**
 * Клинический паспорт словами экрана (pages/methods/passport.ts), строка
 * «Рекомендовано: PHQ-9 — PHQ-2 = 4 від 12.10» и её одно нажатие
 * (components/Suggestions.tsx, assignSuggested), заголовки направлений
 * таблицы каталога (ui/DataTable.tsx, groupOf).
 */

describe("порог и шаг скрининга словами", () => {
  test("порог — знаком и числом языка, со шкалой, если она не главная", () => {
    expect(condText({ scale: null, op: ">=", value: 10 }, "uk")).toBe("≥ 10");
    expect(condText({ scale: null, op: "<=", value: 2 }, "uk")).toBe("≤ 2");
    // дробный — с запятой в uk и ru, с точкой в en
    expect(condText({ scale: null, op: ">=", value: 2.54 }, "uk")).toBe("≥ 2,54");
    expect(condText({ scale: null, op: ">=", value: 2.54 }, "en")).toBe("≥ 2.54");
    expect(condText({ scale: "Депресія (PHQ-2)", op: ">=", value: 3 }, "uk")).toBe("Депресія (PHQ-2) ≥ 3");
    expect(cutoffText({ scale: null, op: ">=", value: 10, means: "клінічно значуща депресія" }, "uk")).toBe(
      "≥ 10 — клінічно значуща депресія",
    );
  });

  test("шаг — кодом полной методики, а не её длинным названием", () => {
    const next = { key: "phq9", surveyId: "s9", title: "Депресія (PHQ-9)" };
    expect(linkCode(next)).toBe("PHQ-9");
    expect(stepText({ scale: null, op: ">=", value: 3, next, citation: "Kroenke, 2003" }, "uk")).toBe("≥ 3 → PHQ-9");
    // без кода в названии — название целиком
    expect(linkCode({ title: "Самооцінка (шкала Розенберга)" })).toBe("Самооцінка (шкала Розенберга)");
  });

  test("кто заполняет — строкой каталога и значением паспорта", () => {
    expect(fillsKey("self")).toBe("dpc.fillsSelf");
    expect(fillsKey("clinician")).toBe("bt.byClinician");
    expect(fillsKey("informant")).toBe("dpc.fillsInformant");
    expect(whoKey("self")).toBe("mc.bySelf");
    expect(whoKey("clinician")).toBe("dpc.whoClinician");
  });
});

const hit = (over: Partial<RuleHit>): RuleHit => ({
  id: "h1",
  ruleTitle: "PHQ-2 ≥ 3 → PHQ-9",
  ruleVersion: 1,
  userId: "p1",
  userName: "Петренко П. П.",
  surveyId: "s2",
  responseId: "r1",
  status: "suggested",
  explanation: { title: "", because: [], actions: [{ kind: "suggest_survey", surveyId: "s9" }] },
  createdAt: "2026-10-12T09:00:00Z",
  surveyTitle: "Депресія, коротко (PHQ-2)",
  basis: [{ scale: null, value: 4 }],
  suggested: [{ surveyId: "s9", title: "Депресія (PHQ-9)", clinician: false, assigned: null, doneAt: null }],
  ...over,
});

describe("предложение правила: «Рекомендовано: PHQ-9 — PHQ-2 = 4 від 12.10»", () => {
  test("на чём сработало: код короткой формы и балл; не главная шкала — названием", () => {
    expect(basisText(hit({}), "uk")).toBe("PHQ-2 = 4");
    expect(
      basisText(hit({ surveyTitle: "Тривога і депресія, коротко (PHQ-4)", basis: [{ scale: "Депресія (PHQ-2)", value: 3 }] }), "uk"),
    ).toBe("PHQ-4, Депресія (PHQ-2) = 3");
    // правило по флагу риска — без балла
    expect(basisText(hit({ basis: [] }), "uk")).toBe("PHQ-2");
  });

  test("в ящике — одна строка на методику, по свежему срабатыванию; назначенное, пройденное и решённое — не предлагается", () => {
    const fresh = hit({ id: "new" });
    const old = hit({ id: "old" });
    const assigned = hit({
      id: "a",
      suggested: [{ surveyId: "s7", title: "Тривога (GAD-7)", clinician: false, assigned: { until: null }, doneAt: null }],
    });
    const done = hit({
      id: "d",
      suggested: [{ surveyId: "s10", title: "K10", clinician: false, assigned: null, doneAt: "2026-10-13T09:00:00Z" }],
    });
    const decided = hit({
      id: "x",
      status: "declined",
      suggested: [{ surveyId: "s11", title: "SCI", clinician: false, assigned: null, doneAt: null }],
    });
    expect(openSuggestions([fresh, old, assigned, done, decided]).map((x) => [x.hit.id, x.target.surveyId])).toEqual([["new", "s9"]]);
  });

  test("«Призначити PHQ-9»: сначала выдача, потом согласие; отказ выдачи согласия не пишет", async () => {
    const calls: string[] = [];
    await assignSuggested(
      hit({}),
      "s9",
      async (surveyId, userId) => calls.push(`grant ${surveyId} ${userId}`),
      async () => calls.push("accept"),
      () => calls.push("reload"),
    );
    expect(calls).toEqual(["grant s9 p1", "accept", "reload"]);

    const refused: string[] = [];
    await expect(
      assignSuggested(
        hit({}),
        "s9",
        async () => {
          throw new ApiError("Немає права призначати", 403);
        },
        async () => refused.push("accept"),
        () => refused.push("reload"),
      ),
    ).rejects.toThrow("Немає права призначати");
    expect(refused).toEqual([]);
  });

  test("согласие тем временем записал другой (409): выдача сделана, список перечитан, фраза — экрану", async () => {
    const calls: string[] = [];
    const outcome = await assignSuggested(
      hit({}),
      "s9",
      async () => calls.push("grant"),
      async () => {
        throw new ApiError("Пропозицію вже вирішено", 409);
      },
      () => calls.push("reload"),
    );
    expect(calls).toEqual(["grant", "reload"]);
    expect(outcome.meanwhile).toBe("Пропозицію вже вирішено");
  });
});

describe("таблица с группами: заголовок направления над строками", () => {
  type Row = { id: string; title: string; domain: string };
  const columns: Column<Row>[] = [{ key: "title", header: "Методика", render: (r) => r.title }];
  const draw = (rows: Row[]) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <LangProvider>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.id}
            selectable
            rowActions={() => <button type="button">…</button>}
            groupOf={(r) => ({ key: r.domain, label: `Напрям ${r.domain}` })}
          />
        </LangProvider>
      </MemoryRouter>,
    );

  test("заголовок — перед первой строкой группы, во всю ширину: отметка, колонки и действия", () => {
    const html = draw([
      { id: "1", title: "PHQ-9", domain: "distress" },
      { id: "2", title: "PHQ-2", domain: "distress" },
      { id: "3", title: "PCL-5", domain: "trauma" },
    ]);
    const headers = [...html.matchAll(/<tr data-group="([^"]+)"><th colSpan="(\d+)" scope="colgroup"[^>]*>([^<]+)</g)];
    expect(headers.map((m) => [m[1], m[2], m[3]])).toEqual([
      ["distress", "3", "Напрям distress"],
      ["trauma", "3", "Напрям trauma"],
    ]);
    // порядок: заголовок, его строки, следующий заголовок
    expect(html.indexOf("Напрям trauma")).toBeGreaterThan(html.indexOf(">PHQ-2<"));
    expect(html.indexOf("Напрям distress")).toBeLessThan(html.indexOf(">PHQ-9<"));
  });

  test("длинная страница с группами не виртуализуется: заголовок не строка данных", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i), title: `M${i}`, domain: i < 50 ? "a" : "b" }));
    const html = draw(rows);
    expect(html).not.toContain("data-virtual");
    expect([...html.matchAll(/data-group=/g)].length).toBe(2);
  });
});
