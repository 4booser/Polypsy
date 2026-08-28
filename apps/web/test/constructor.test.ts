import { describe, expect, test } from "bun:test";
import { numberingProblems, parseBulk } from "../src/pages/constructor/BulkPaste";
import { parseItems, toPayload, withUids, type Draft } from "../src/pages/constructor/model";

/**
 * Разбор текста из пособия — главный путь переноса методики.
 *
 * Ошибка здесь не роняет ничего: она молча меняет содержание методики.
 * Склеенные пункты, потерянный хвост, съеденный номер — всё это выглядит как
 * нормальный опросник, и обнаруживается только сверкой с бумагой.
 */
describe("массовая вставка пунктов", () => {
  test("нумерация в разных начертаниях срезается", () => {
    const text = ["1. Первый", "2) Второй", "3 — Третий", "4] Четвёртый", "5: Пятый", "6 Шестой"].join("\n");
    expect(parseBulk(text).map((i) => i.text)).toEqual([
      "Первый",
      "Второй",
      "Третий",
      "Четвёртый",
      "Пятый",
      "Шестой",
    ]);
    expect(parseBulk(text).map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("перенос строки внутри пункта склеивается", () => {
    /*
     * Из PDF длинный пункт приезжает разорванным. Если не склеить, хвост
     * станет отдельным вопросом — и в методике окажется на один пункт больше,
     * чем в пособии, со сдвигом всех ключей после него.
     */
    const parsed = parseBulk("1. Я часто чувствую\nсебя усталым\n2. Сплю хорошо");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.text).toBe("Я часто чувствую себя усталым");
  });

  test("пустые строки не порождают пунктов", () => {
    expect(parseBulk("\n\n1. Раз\n\n\n2. Два\n\n")).toHaveLength(2);
  });

  test("текст без нумерации разбирается построчно только с первой строки", () => {
    // без номеров склеивать нечего: каждая строка — отдельный пункт лишь
    // тогда, когда до неё не было ни одного номера
    expect(parseBulk("Просто строка").map((i) => i.n)).toEqual([null]);
  });

  test("число внутри текста не принимается за номер", () => {
    const parsed = parseBulk("1. Я просыпаюсь в 5 утра");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.text).toBe("Я просыпаюсь в 5 утра");
  });
});

describe("проверка нумерации", () => {
  test("дыра в нумерации названа", () => {
    // пропущенный пункт — почти всегда потерянная при распознавании строка
    const problems = numberingProblems(parseBulk("1. Раз\n2. Два\n4. Четыре"));
    expect(problems).toContain("Пропущен номер 3");
  });

  test("повтор номера назван", () => {
    const problems = numberingProblems(parseBulk("1. Раз\n2. Два\n2. Ещё два"));
    expect(problems).toContain("Номер 2 встречается дважды");
  });

  test("ровная нумерация не порождает замечаний", () => {
    expect(numberingProblems(parseBulk("1. Раз\n2. Два\n3. Три"))).toEqual([]);
  });

  test("список замечаний обрезается, а не заваливает экран", () => {
    // вставили один пункт с номером 50 — дыр сорок девять
    const problems = numberingProblems(parseBulk("50. Полтинник"));
    expect(problems.length).toBeLessThanOrEqual(8);
  });
});

describe("разбор номеров пунктов шкалы", () => {
  test("диапазоны разворачиваются", () => {
    expect(parseItems("1-5")).toEqual([1, 2, 3, 4, 5]);
  });

  test("перечисление и диапазоны вперемешку", () => {
    expect(parseItems("1, 3, 7-9")).toEqual([1, 3, 7, 8, 9]);
    expect(parseItems("1 3 7-9")).toEqual([1, 3, 7, 8, 9]);
  });

  test("повторы схлопываются и порядок восстанавливается", () => {
    // ключ шкалы, где пункт указан дважды, дал бы двойной вес
    expect(parseItems("5, 1, 5, 3")).toEqual([1, 3, 5]);
  });

  test("мусор игнорируется, а не превращается в NaN", () => {
    expect(parseItems("1, ерунда, 3")).toEqual([1, 3]);
    expect(parseItems("")).toEqual([]);
  });
});

describe("черновик конструктора", () => {
  const draft = (): Draft =>
    ({
      title: { ru: "Т" },
      administration: "self",
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      showProgress: true,
      allowBack: true,
      anonymous: false,
      randomizeQuestions: false,
      sections: [],
      questions: [
        { uid: "q1", type: "yesno", title: { ru: "А" }, required: true, options: [] },
        { uid: "q2", type: "yesno", title: { ru: "Б" }, required: true, options: [] },
      ],
      scales: [{ uid: "s1", code: "S", title: { ru: "Ш" }, kind: "clinical", normalization: "raw", key: [], corrections: [], norms: [], stenTable: [], bands: [] }],
    }) as Draft;

  test("uid не уходит на сервер", () => {
    /*
     * Это поле редактора: идентификаторы на сервере выдаются заново при каждой
     * новой версии, и присылать туда свои значит делать вид, что клиент ими
     * распоряжается.
     */
    const payload = toPayload(draft());
    expect(payload.questions.every((q) => !("uid" in q))).toBe(true);
    expect(payload.scales.every((s) => !("uid" in s))).toBe(true);
    expect(payload.questions).toHaveLength(2);
  });

  test("восстановленный черновик получает недостающие uid", () => {
    // сохранённый до появления uid — иначе список снова поедет по индексам
    const raw = draft();
    raw.questions = raw.questions.map(({ uid: _drop, ...q }) => q) as Draft["questions"];
    const fixed = withUids(raw);
    expect(fixed.questions.every((q) => !!q.uid)).toBe(true);
    expect(new Set(fixed.questions.map((q) => q.uid)).size).toBe(2);
  });

  test("существующие uid не переписываются", () => {
    // иначе после каждого автосейва все поля теряли бы фокус
    const fixed = withUids(draft());
    expect(fixed.questions.map((q) => q.uid)).toEqual(["q1", "q2"]);
  });
});
