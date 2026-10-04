import { describe, expect, test } from "bun:test";
import { sheetEntries } from "../src/instrumentSheets";

/**
 * Тексты пунктов всех методик: ни один не содержит в себе другие пункты.
 *
 * Пакет сверки нашёл, что у БОО пункт 190 на украинском нёс в себе пункты
 * 191–200 целиком — хвост страницы пособия, вклеенный при переносе. Пациент
 * видел на одном экране одиннадцать утверждений и отвечал «так/ні» на все
 * разом, а ключ считал это ответом на 190-й. По одному баллу этого не
 * заметить; ловится только текстом.
 */
describe("тексты пунктов", () => {
  const entries = sheetEntries();
  const numbered = /(?:^|[\s(«"“])(\d{1,3})[.)]?\s+[А-ЯІЇЄҐA-Z«“"]/u;

  test("пункт не содержит другого нумерованного пункта и не длиннее 400 знаков", () => {
    const problems: string[] = [];
    for (const e of entries) {
      e.draft.questions.forEach((q, i) => {
        for (const [lang, text] of Object.entries(q.title) as [string, string][]) {
          if (!text) continue;
          const tail = text.slice(40); // первые слова могут начинаться с числа («10 раз…»)
          const m = numbered.exec(tail);
          if (m && Number(m[1]) > i + 1 && Number(m[1]) <= e.draft.questions.length) {
            problems.push(`${e.key} п. ${i + 1} (${lang}): внутри текста начинается п. ${m[1]}`);
          }
          if (text.length > 400) problems.push(`${e.key} п. ${i + 1} (${lang}): ${text.length} знаков`);
        }
      });
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
