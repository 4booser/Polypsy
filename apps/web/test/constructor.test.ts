import { describe, expect, test } from "bun:test";
import { numberingProblems, parseBulk } from "../src/pages/constructor/BulkPaste";
import {
  addRowItem,
  applyAnswers,
  createTarget,
  deriveMode,
  keyRows,
  nextKeyCode,
  normalizeDraft,
  parseItems,
  questionsWithOwnAnswers,
  removeRowItem,
  setRowWeight,
  switchMode,
  toPayload,
  withUids,
  type Draft,
  type DraftScale,
} from "../src/pages/constructor/model";

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

/*
 * Конструктор по макету: вид теста, общий набор ответов, таблица баллов.
 *
 * Всё это — интерфейс к существующей модели (scale_items { matchKey, weight },
 * scale_corrections, options.score), и ошибка здесь не падает, а молча меняет
 * ключ: ряд «Так» получил чужой вес, итоговая шкала не увидела новый вопрос,
 * тест завёлся не в той папке. Поэтому проверяются переходы, а не вид.
 */
describe("конструктор по макету", () => {
  const scale = (over: Partial<DraftScale> = {}): DraftScale => ({
    uid: "s",
    code: "S",
    title: { uk: "Ш" },
    kind: "clinical",
    normalization: "raw",
    key: [],
    corrections: [],
    norms: [],
    stenTable: [],
    bands: [],
    ...over,
  });
  const q = (uid: string, type = "yesno"): Draft["questions"][number] => ({
    uid,
    type,
    title: { uk: uid },
    required: true,
    options: [],
  });
  const base = (): Draft => ({
    title: { uk: "Т" },
    administration: "self",
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    showProgress: true,
    allowBack: true,
    anonymous: false,
    randomizeQuestions: false,
    sections: [],
    questions: [q("q1"), q("q2"), q("i", "info"), q("q3")],
    scales: [],
    answers: [
      { text: { uk: "Так" }, keyCode: "yes" },
      { text: { uk: "Ні" }, keyCode: "no" },
    ],
  });

  test("папка и группа берутся из адреса, папка без группы — нет", () => {
    /*
     * Каталог ведёт на /constructor?folder=<id>&group=<groupId>. Папка без
     * группы на сервере невозможна — такое сохранение он отверг бы, и лучше
     * завести тест в корне, чем не завести вовсе.
     */
    expect(createTarget("?folder=f1&group=g1")).toEqual({ folderId: "f1", groupId: "g1" });
    expect(createTarget("?folder=f1")).toEqual({ folderId: null, groupId: null });
    expect(createTarget("?group=g1")).toEqual({ folderId: null, groupId: "g1" });
    expect(createTarget("?folder=f1&group=null")).toEqual({ folderId: null, groupId: null });
    expect(createTarget("")).toEqual({ folderId: null, groupId: null });
  });

  test("вид теста читается по ключу, а не по числу шкал", () => {
    expect(deriveMode([])).toBe("complex");
    expect(deriveMode([scale({ key: [{ item: 1 }] })])).toBe("complex");
    expect(deriveMode([scale({ key: [{ item: 1, matchKey: "yes" }] })])).toBe("specific");
    // пять факторов с баллом варианта — в плоские «Результати» не помещаются
    expect(deriveMode([scale(), scale({ uid: "t", code: "T" })])).toBe("specific");
  });

  test("коды ответов: yes, no, потом k3, k4 — и никогда занятые", () => {
    expect(nextKeyCode([])).toBe("yes");
    expect(nextKeyCode(["yes"])).toBe("no");
    expect(nextKeyCode(["yes", "no"])).toBe("k3");
    expect(nextKeyCode(["yes", "no", "k3"])).toBe("k4");
    // удалили «no» — код освобождается, а не пропускается
    expect(nextKeyCode(["yes", "k3"])).toBe("no");
  });

  test("общий набор ответов копируется во все вопросы, кроме информационных", () => {
    const next = applyAnswers(base(), [{ text: { uk: "Так" }, keyCode: "yes" }]);
    expect(next.questions[0]!.options.map((o) => o.keyCode)).toEqual(["yes"]);
    expect(next.questions[3]!.options.map((o) => o.keyCode)).toEqual(["yes"]);
    expect(next.questions[2]!.options).toEqual([]);
    // копия, а не ссылка: правка одного вопроса не должна менять соседний
    expect(next.questions[0]!.options[0]).not.toBe(next.questions[1]!.options[0]);
    expect(questionsWithOwnAnswers(next)).toBe(0);
  });

  test("ряды таблицы баллов: по ответам, плюс чужой ключ и балл варианта, если они есть", () => {
    const s = scale({
      key: [
        { item: 3, matchKey: "yes", weight: 10 },
        { item: 1, matchKey: "yes", weight: 10 },
        { item: 2, matchKey: "dk", weight: 4 },
        { item: 5, matchKey: null, weight: 2 },
      ],
    });
    const rows = keyRows(s, base().answers!);
    expect(rows.map((r) => r.matchKey)).toEqual(["yes", "no", "dk", null]);
    expect(rows[0]).toEqual({ matchKey: "yes", items: [1, 3], weight: 10 });
    expect(rows[1]).toEqual({ matchKey: "no", items: [], weight: 1 });
    expect(rows[3]!.items).toEqual([5]);
  });

  test("ответы без кодов: у новой шкалы есть ряд «бал відповіді», иначе ключ не собрать", () => {
    /*
     * Методики с баллом варианта (PHQ-9, «большая пятёрка») кодов ответов не
     * несут, их шкалы — только такие ряды. Без ряда «+» для номеров стоять
     * негде, и ключ пришлось бы набирать через «Тест як JSON».
     */
    const scored = [
      { text: { uk: "Часто" }, keyCode: null },
      { text: { uk: "Рідко" }, keyCode: null },
    ];
    expect(keyRows(scale(), scored)).toEqual([{ matchKey: null, items: [], weight: 1 }]);
    // а при кодах ряды — по кодам, и лишнего ряда нет
    expect(keyRows(scale(), base().answers!).map((r) => r.matchKey)).toEqual(["yes", "no"]);
  });

  test("правка ряда: номер без дублей, вес ряда — всем его пунктам и только им", () => {
    let s = scale({ key: [{ item: 1, matchKey: "yes", weight: 10 }, { item: 4, matchKey: "no", weight: 6 }] });
    s = addRowItem(s, "yes", 3);
    s = addRowItem(s, "yes", 3);
    s = addRowItem(s, "yes", 0);
    expect(s.key.filter((k) => k.matchKey === "yes").map((k) => k.item)).toEqual([1, 3]);
    // новый пункт ряда наследует вес ряда, а не единицу
    expect(s.key.find((k) => k.item === 3)!.weight).toBe(10);
    s = setRowWeight(s, "yes", 7);
    expect(s.key.map((k) => k.weight)).toEqual([7, 6, 7]);
    s = removeRowItem(s, "yes", 1);
    expect(s.key.map((k) => k.item)).toEqual([4, 3]);
  });

  test("комплексный тест: итоговая шкала получает ключ на все вопросы при отправке", () => {
    const draft: Draft = { ...base(), mode: "complex", scales: [scale({ key: [{ item: 2, weight: 3 }] })] };
    const payload = toPayload(draft);
    // информационный пункт баллов не даёт и в ключ не попадает; вес пункта 2 сохранён
    expect(payload.scales[0]!.key).toEqual([
      { item: 1, matchKey: null, weight: 1 },
      { item: 2, matchKey: null, weight: 3 },
      { item: 4, matchKey: null, weight: 1 },
    ]);
    // поля редактора на сервер не уходят
    expect("mode" in payload).toBe(false);
    expect("answers" in payload).toBe(false);
    expect("folderId" in payload).toBe(false);
    // в конкретном тесте ключ не трогается
    expect(toPayload({ ...draft, mode: "specific" }).scales[0]!.key).toEqual([{ item: 2, weight: 3 }]);
  });

  test("переключение вкладки перестраивает черновик, не теряя вопросы и диапазоны", () => {
    const band = { minScore: 0, maxScore: 10, label: { uk: "норма" }, severity: "none" as const };
    const specific: Draft = {
      ...base(),
      mode: "specific",
      scales: [scale({ key: [{ item: 1, matchKey: "yes" }], corrections: [{ from: "K", coefficient: 0.5 }], bands: [band] }), scale({ uid: "k", code: "K" })],
    };
    const complex = switchMode(specific, "complex");
    expect(complex.mode).toBe("complex");
    expect(complex.scales).toHaveLength(1);
    expect(complex.scales[0]!.bands).toEqual([band]);
    expect(complex.scales[0]!.key.every((k) => k.matchKey === null)).toBe(true);
    expect(complex.scales[0]!.corrections).toEqual([]);
    expect(complex.questions).toHaveLength(4);

    const back = switchMode(complex, "specific");
    expect(back.mode).toBe("specific");
    expect(back.questions[0]!.options.map((o) => o.keyCode)).toEqual(["yes", "no"]);
    expect(switchMode(back, "specific")).toBe(back);
  });

  test("старый автосейв без полей редактора получает вид и набор ответов", () => {
    const raw = { ...base(), answers: undefined, questions: [{ ...q("q1"), options: [{ text: { uk: "Часто" }, keyCode: "k3" }] }] };
    const fixed = normalizeDraft(raw);
    expect(fixed.mode).toBe("complex");
    expect(fixed.answers?.map((a) => a.keyCode)).toEqual(["k3"]);
    // а без вопросов — «Так / Ні» по умолчанию
    expect(normalizeDraft({ ...raw, questions: [] }).answers?.map((a) => a.keyCode)).toEqual(["yes", "no"]);
  });
});
