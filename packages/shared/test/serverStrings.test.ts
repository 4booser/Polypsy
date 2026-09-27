import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSurveySchema } from "../src/schemas";
import { computeProfile } from "../src/scoring";
import {
  noteCode,
  notePrefix,
  readNotes,
  renderCoded,
  renderNote,
  SERVER_TEXTS,
  serverText,
  type CodedText,
} from "../src/serverStrings";
import { validateSurvey } from "../src/validate";
import { makeScale, makeSurvey, yesNoQuestion } from "./fixtures";

/**
 * Словарь текстов, которые собирает сервер или общий пакет (волна 13).
 *
 * Тип записи держит наличие трёх языков; здесь — то, чего тип не видит:
 * пустоту, разъехавшиеся подстановки, чужие буквы и ключи, которых никто
 * не зовёт. И главное — что хранимый текст собирается на языке смотрящего,
 * а старая запись без кода показывается как была.
 */

const ENTRIES = Object.entries(SERVER_TEXTS) as [string, { uk: string; ru: string; en: string }][];
const marks = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

describe("словарь сервера", () => {
  test("у каждой записи три непустых перевода с одними и теми же подстановками", () => {
    expect(ENTRIES.length).toBeGreaterThan(200);
    const bad: string[] = [];
    for (const [key, v] of ENTRIES) {
      if (!v.uk.trim() || !v.ru.trim() || !v.en.trim()) bad.push(`${key}: пустой перевод`);
      // иначе на одном из языков пропадёт число или название шкалы
      if (marks(v.uk) !== marks(v.ru)) bad.push(`${key}: разные подстановки uk/ru`);
      if (marks(v.uk) !== marks(v.en)) bad.push(`${key}: разные подстановки uk/en`);
    }
    expect(bad).toEqual([]);
  });

  test("каждый язык своими буквами", () => {
    // те же наборы, что у словаря оболочки (apps/web/test/langLetters.test.ts); «ё» спорна и не в счёт
    const wrong: string[] = [];
    for (const [key, v] of ENTRIES) {
      if (/[ыэъ]/i.test(v.uk)) wrong.push(`${key}: русские буквы в uk — «${v.uk}»`);
      if (/[іїєґ]/i.test(v.ru)) wrong.push(`${key}: украинские буквы в ru — «${v.ru}»`);
      if (/[Ѐ-ӿ]/.test(v.en)) wrong.push(`${key}: кириллица в en — «${v.en}»`);
    }
    expect(wrong).toEqual([]);
  });

  test("нет ключей, которых никто не зовёт", () => {
    /*
     * Ключи, собранные шаблоном, названы семействами: подпись поля сравнения
     * версий (`diff.field.${code}`), уровень риска в объяснении правила
     * (`rule.sev.${severity}`), форма возраста на печатном листе. Их
     * литералом в коде нет, и это не мёртвые записи.
     */
    const DYNAMIC = ["diff.field.", "rule.sev."];
    const ROOT = resolve(import.meta.dir, "../../..");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (name === "node_modules") return [];
        if (statSync(path).isDirectory()) return walk(path);
        return /\.tsx?$/.test(path) && !path.endsWith("serverStrings.ts") ? [path] : [];
      });
    const code = ["apps/api/src", "apps/web/src", "packages/shared/src"]
      .flatMap((d) => walk(join(ROOT, d)))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const unused = ENTRIES.map(([key]) => key).filter(
      (key) => !code.includes(`"${key}"`) && !DYNAMIC.some((p) => key.startsWith(p)),
    );
    expect(unused).toEqual([]);
  });

  test("неизвестный ключ показывается сам, а не пустотой", () => {
    expect(serverText("nope.missing", "en")).toBe("nope.missing");
  });
});

describe("предупреждения подсчёта: код хранится, текст — на языке смотрящего", () => {
  /*
   * Три необязательных пункта, пропущенные все: шкала не вычисляется, и
   * движок говорит почему. Прежде фраза собиралась здесь же по-русски и
   * приезжала русской в украинский конструктор.
   */
  const qs = [0, 1, 2].map((i) => ({ ...yesNoQuestion(i), required: false }));
  const survey = makeSurvey(qs, [
    makeScale({
      code: "S",
      title: "Сон",
      normalization: "raw",
      items: qs.map((q) => ({ questionId: q.id, matchKey: "yes", weight: 1 })),
    }),
  ]);

  test("одно и то же предупреждение — на трёх языках", () => {
    const [warning] = computeProfile(survey, []).warnings;
    // в результате — код и числа, а не фраза
    expect(warning).toEqual({
      code: "score.tooFewAnswers",
      params: { scale: "Сон", answered: 0, asked: 3, min: 80 },
    });
    expect(renderCoded(warning!, "uk")).toBe(
      "Шкала «Сон»: відповіді є на 0 з 3 пунктів, потрібно щонайменше 80 % — бал не обчислено",
    );
    expect(renderCoded(warning!, "ru")).toBe(
      "Шкала «Сон»: ответы есть на 0 из 3 пунктов, нужно не меньше 80 % — балл не вычислен",
    );
    expect(renderCoded(warning!, "en")).toBe("Scale “Сон”: 0 of 3 items answered, at least 80% needed — score not computed");
  });

  test("старая запись без кода показывается прежним текстом", () => {
    /*
     * Строкой предупреждение приезжало до волны 13 — так его могли сохранить
     * у себя клиенты. Перевести готовую фразу не из чего; показать её как
     * есть честнее, чем потерять.
     */
    const old = "Шкала «Сон»: ответы есть на 0 из 3 пунктов, нужно не меньше 80 % — балл не вычислен";
    for (const lang of ["uk", "ru", "en"] as const) expect(renderCoded(old, lang)).toBe(old);
    const legacy: CodedText = { text: old };
    expect(renderCoded(legacy, "en")).toBe(old);
  });

  test("своё сообщение шкалы достоверности — слова методики, как есть", () => {
    const qv = [yesNoQuestion(10), yesNoQuestion(11)];
    const lie = makeSurvey(qv, [
      makeScale({
        code: "L",
        kind: "validity",
        normalization: "ratio",
        ratioDenominator: 2,
        validityThreshold: 0.6,
        validityDirection: "above",
        validityMessage: "Обстежуваний прикрашає себе",
        items: qv.map((q) => ({ questionId: q.id, matchKey: "yes", weight: 1 })),
      }),
    ]);
    const answers = qv.map((q) => ({ questionId: q.id, optionIds: [q.options[0]!.id] }));
    const [warning] = computeProfile(lie, answers).warnings;
    expect(warning?.code).toBe("score.validityExceeded");
    // текст методики важнее перевода движка — на любом языке
    expect(renderCoded(warning!, "en")).toBe("Обстежуваний прикрашає себе");
    // без своего сообщения — фраза движка на языке смотрящего
    expect(renderCoded({ code: warning!.code, params: warning!.params }, "en")).toBe(
      `Validity scale “${warning!.params!.scale}” crossed the threshold of 0.6 — the result is unreliable`,
    );
  });
});

describe("проблемы методики — на языке того, кто проверяет", () => {
  const draft = createSurveySchema.parse({
    title: { uk: "Тест", ru: "Тест" },
    questions: [
      {
        type: "yesno",
        title: { uk: "Пункт", ru: "Пункт" },
        options: [
          { text: { uk: "Так", ru: "Да" }, keyCode: "yes" },
          { text: { uk: "Ні", ru: "Нет" }, keyCode: "no" },
        ],
      },
    ],
    scales: [
      {
        code: "S",
        title: { uk: "Шкала", ru: "Шкала" },
        key: [{ item: 7, matchKey: "yes" }],
        bands: [{ minScore: 0, maxScore: 1, label: { uk: "Норма", ru: "Норма" }, severity: "none" }],
      },
    ],
  });

  test("та же проблема — на трёх языках, с одним кодом", () => {
    const pick = (lang: "uk" | "ru" | "en") => validateSurvey(draft, lang).find((i) => i.code === "val.keyItemOutOfRange")!;
    expect(pick("uk")).toMatchObject({ where: "Шкала S", message: "У ключі пункт 7, а в методиці їх 1" });
    expect(pick("ru")).toMatchObject({ where: "Шкала S", message: "В ключе пункт 7, а в методике их 1" });
    expect(pick("en")).toMatchObject({ where: "Scale S", message: "The key refers to item 7, but the assessment has 1" });
    expect(pick("en").params).toEqual({ item: 7, total: 1 });
  });

  test("без языка — украинский, язык учреждения", () => {
    expect(validateSurvey(draft).map((i) => i.message)).toEqual(validateSurvey(draft, "uk").map((i) => i.message));
  });
});

describe("пометка сервера в текстовой колонке: код хранится, фраза — при показе (волна 14)", () => {
  /*
   * Заметки версий, примечания доступа и назначений, итоги прогонов
   * расписаний сервер писал русской фразой, и её читали на любом языке.
   * Теперь — встроенным кодом; в той же колонке лежат текст человека и
   * записи до кодов, и они показываются как лежат.
   */
  test("код без подстановок и с ними — на трёх языках", () => {
    expect(noteCode("note.firstVersion")).toBe("⟦note.firstVersion⟧");
    const first = noteCode("note.firstVersion");
    expect(renderNote(first, "uk")).toBe("Перша версія");
    expect(renderNote(first, "ru")).toBe("Первая версия");
    expect(renderNote(first, "en")).toBe("First version");

    const battery = noteCode("note.battery", { title: "Скринінг ПТСР" });
    expect(renderNote(battery, "uk")).toBe("Набір «Скринінг ПТСР»");
    expect(renderNote(battery, "ru")).toBe("Батарея «Скринінг ПТСР»");
    expect(renderNote(battery, "en")).toBe("Battery “Скринінг ПТСР”");
    expect(readNotes(battery)).toEqual([{ code: "note.battery", params: { title: "Скринінг ПТСР" } }]);
  });

  test("текст человека и запись до кодов — как лежат", () => {
    for (const lang of ["uk", "ru", "en"] as const) {
      expect(renderNote("на тиждень, після виписки", lang)).toBe("на тиждень, після виписки");
      expect(renderNote("Первая версия", lang)).toBe("Первая версия");
      expect(renderNote(null, lang)).toBeNull();
      expect(renderNote(undefined, lang)).toBeNull();
    }
    expect(readNotes("Первая версия")).toEqual([]);
  });

  test("склейка через « · » переводит каждую часть и не трогает остальное", () => {
    // так closeMissed дописывает отметку о пропуске к примечанию назначения
    const note = [noteCode("note.cascade"), noteCode("note.missed.cascade")].join(" · ");
    expect(renderNote(note, "ru")).toBe("Каскад по результату скрининга · пропущено: срок истёк, назначено заново по результату скрининга");
    expect(renderNote(`після наради · ${noteCode("note.missed.reassigned")}`, "en")).toBe(
      "після наради · missed: overdue, assigned again",
    );
  });

  test("«⟧» в названии не закрывает код раньше времени", () => {
    const title = "Набір ⟦А⟧ {б} «в» \"г\"";
    const note = noteCode("note.schedule", { title });
    expect(note.indexOf("⟧")).toBe(note.length - 1);
    expect(renderNote(note, "uk")).toBe(`Розклад «${title}»`);
    expect(readNotes(note)[0]?.params).toEqual({ title });
  });

  test("подстановка-ключ переводится тем же языком, испорченная — не роняет показ", () => {
    // как у объяснений правил: код внутри подстановки не остаётся английским словом в украинской фразе
    expect(renderNote(noteCode("note.localNorms", { scales: "note.firstVersion" }), "uk")).toBe("Локальні норми: Перша версія");
    const broken = "⟦note.battery{\"title\":}⟧";
    expect(renderNote(broken, "en")).toBe(broken);
    // неизвестный ключ показывается сам — его называют в заявке и находят поиском
    expect(renderNote("⟦note.nope⟧", "uk")).toBe("note.nope");
  });

  test("начало пометки для поиска LIKE: ключ не начало другого ключа", () => {
    expect(noteCode("note.followup", { days: 7 }).startsWith(notePrefix("note.followup"))).toBe(true);
    /*
     * Очередь работы ищет повтор протокола наблюдения по «⟦note.followup%».
     * Ключ, который начинался бы так же, попал бы в очередь чужим.
     */
    const keys = Object.keys(SERVER_TEXTS);
    expect(keys.filter((k) => k !== "note.followup" && k.startsWith("note.followup"))).toEqual([]);
  });

  test("любая пометка по коду показывается записью словаря на каждом языке", () => {
    for (const [key, v] of ENTRIES.filter(([k]) => k.startsWith("note."))) {
      for (const lang of ["uk", "ru", "en"] as const) {
        expect(renderNote(noteCode(key as never), lang), key).toBe(v[lang]);
      }
    }
  });
});
