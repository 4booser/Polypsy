import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "../src/lang";
import { EMPTY, type Draft } from "../src/pages/constructor/model";
import { Structure } from "../src/pages/constructor/Structure";

/**
 * Колонка «Структура» конструктора: строка пункта — его текст и пометки.
 *
 * Строка подписывалась пояснением под вопросом, если оно было: у ASSIST
 * восьмой пункт стоял в списке абзацем указаний психологу, а не своим
 * вопросом. Мутация: вернуть `q.help || q.title` — проверка текста падает.
 */
const draft: Draft = {
  ...EMPTY,
  questions: [
    {
      uid: "q1",
      type: "single",
      title: { uk: "Чи вживали ви наркотики ін’єкційно?", ru: "Употребляли ли вы наркотики инъекционно?" },
      help: { uk: "Якщо так — розпитайте про частоту ін’єкцій", ru: "Если да — расспросите о частоте инъекций" },
      required: true,
      options: [
        { uid: "o1", text: { uk: "Ні" }, score: 0 },
        { uid: "o2", text: { uk: "Так, за останні 3 місяці" }, score: 0, riskFlag: true, riskSeverity: "moderate" },
      ],
    },
    { uid: "q2", type: "single", title: { uk: "Другий пункт" }, required: true, options: [] },
  ],
};

const html = renderToStaticMarkup(
  <LangProvider>
    <Structure
      draft={draft}
      section="questions"
      onSection={() => {}}
      open={null}
      onOpen={() => {}}
      onReorder={() => {}}
      onMove={() => {}}
      warnSections={new Set()}
      warnItems={new Set([2])}
      onAdd={() => {}}
      onPaste={() => {}}
    />
  </LangProvider>,
);

/** Имена кнопок-строк пунктов (data-item) */
const rows = [...html.matchAll(/<button[^>]*data-item[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]!.replace(/&#x27;|&#39;/g, "'"));

describe("строка пункта в колонке структуры", () => {
  test("подписана текстом вопроса, а не пояснением под ним", () => {
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Чи вживали ви наркотики ін’єкційно?");
    expect(html).not.toContain("розпитайте про частоту");
  });

  test("критичний пункт и замечание проверки названы словами, а не только значком", () => {
    expect(rows[0]).toMatch(/критичн|критическ|critical/);
    expect(rows[1]).toMatch(/зауваження|замечания|issues/);
    expect(rows[1]).not.toMatch(/критичн|критическ|critical/);
  });
});
