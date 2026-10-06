import { beforeAll, describe, expect, test } from "bun:test";
import { ERRORS, createSurveySchema, type CreateSurveyDraft, type SurveyFull } from "@quizzy/shared";
import { api, createVersion, db, root, surveys } from "./fixtures";
import { surveyGroups } from "../src/db/schema";
import { getSurvey, versionContent } from "../src/lib/surveys";
import { CATALOG } from "../src/instruments/catalog";
import { minimult } from "../src/instruments/minimult";
import { mlo } from "../src/instruments/mlo";
import { sadPersons } from "../src/instruments/sadPersons";
import { sr45 } from "../src/instruments/sr45";
import { toDraft, toPayload } from "../../web/src/pages/constructor/model";

/**
 * Конструктор сохраняет методику без потерь (волна 12, находка участка
 * engine).
 *
 * Веб-конструктор читал версию в черновик и отправлял обратно не всё:
 * обратный ключ, порог риска числового пункта, шкалу пункта, условия
 * показа, границы шкалы, секции, возраст и источник норм, пол и возраст
 * строк стенов, описание полосы, minAnsweredShare. Открыть встроенную
 * методику и нажать «Зберегти» значило сломать ей подсчёт и риск — без
 * единой правки и без единого предупреждения.
 *
 * Образец «без потерь» — versionContent сервера: он переносит из
 * действующей версии всё, что принимает запись. Проверяется каждая
 * встроенная методика и весь каталог, установленные настоящим путём
 * (createVersion → getSurvey raw, как читает конструктор):
 *
 *  1. черновик конструктора → payload совпадает с содержимым версии по всем
 *     полям схемы записи;
 *  2. тот же payload, отправленный настоящим PATCH (с baseVersionId), даёт
 *     новую версию с тем же содержимым;
 *  3. устаревший baseVersionId — 409 с понятным текстом, а не запись поверх.
 */

const tag = crypto.randomUUID().slice(0, 8);
const group = crypto.randomUUID();

const INSTRUMENTS: [string, CreateSurveyDraft][] = [
  ["sr45", sr45],
  ["sad-persons", sadPersons],
  ["minimult", minimult],
  ["mlo", mlo],
  ...CATALOG.map((e): [string, CreateSurveyDraft] => [e.key, e.draft]),
];

const installed = new Map<string, SurveyFull>();

beforeAll(async () => {
  await db.insert(surveyGroups).values({ id: group, title: `Конструктор без втрат ${tag}`, createdBy: root.id });
  for (const [key, draft] of INSTRUMENTS) {
    const input = createSurveySchema.parse(draft);
    const id = crypto.randomUUID();
    await db.insert(surveys).values({
      id,
      groupId: group,
      title: { uk: `Без втрат ${key} ${tag}` },
      administration: input.administration ?? "self",
      status: "draft",
      scoringEnabled: true,
      createdBy: root.id,
    } as never);
    await createVersion(id, input, root.id, "конструктор без втрат");
    installed.set(key, (await getSurvey(id, null, "uk", true))!);
  }
}, 120_000);

type Content = { sections: unknown[]; scales: unknown[]; questions: unknown[] };

/**
 * Содержимое в сравнимом виде.
 *
 * Схема записи расставляет умолчания (обе стороны проходят её одинаково),
 * null и отсутствие поля для записи — одно и то же, а идентификаторы версии
 * (ключ секции = её id, значение условия = id варианта) у двух версий
 * заведомо разные: они заменяются местом — «секция 2», «вопрос 4, вариант 1».
 */
function comparable(content: Content, version: SurveyFull) {
  const parsed = createSurveySchema.parse({ title: { uk: "x" }, ...content });
  const sectionAt = new Map(parsed.sections.map((s, i) => [s.key, `sec${i}`]));
  const optionAt = new Map(version.questions.flatMap((q, qi) => q.options.map((o, oi) => [o.id, `q${qi}o${oi}`] as const)));
  const ref = (v: unknown): unknown =>
    typeof v === "string" ? (optionAt.get(v) ?? v) : Array.isArray(v) ? v.map(ref) : v;
  const shaped = {
    sections: parsed.sections.map((s) => ({ ...s, key: sectionAt.get(s.key) })),
    scales: parsed.scales,
    questions: parsed.questions.map((q) => ({
      ...q,
      sectionKey: q.sectionKey ? (sectionAt.get(q.sectionKey) ?? `?${q.sectionKey}`) : null,
      logic: q.logic.map((r) => ({ ...r, value: ref(r.value) })),
    })),
  };
  return strip(shaped);
}

/** null и undefined — вон, чтобы «нет» и «пусто» не различались там, где запись их не различает */
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== null && x !== undefined)
        .map(([k, x]) => [k, strip(x)]),
    );
  }
  return v;
}

const contentOf = (p: { sections: unknown[]; scales: unknown[]; questions: unknown[] }): Content => ({
  sections: p.sections,
  scales: p.scales,
  questions: p.questions,
});

describe("черновик конструктора → payload совпадает с версией", () => {
  for (const [key] of INSTRUMENTS) {
    test(key, () => {
      const raw = installed.get(key)!;
      const payload = toPayload(toDraft(raw, []));
      expect(comparable(contentOf(payload), raw)).toEqual(comparable(versionContent(raw), raw));
    });
  }

  test("проверка не пустая: у методик есть что терять", () => {
    /*
     * Без этого совпадение могло бы держаться на том, что у всех методик
     * перечисленных полей просто нет. Поля, которые конструктор терял,
     * обязаны встретиться хотя бы у одной методики набора.
     */
    const all = [...installed.values()];
    const questions = all.flatMap((s) => s.questions);
    expect(questions.some((q) => q.reverseScored)).toBe(true);
    expect(questions.some((q) => q.scaleId)).toBe(true);
    expect(questions.some((q) => q.riskThreshold !== null || q.options.some((o) => o.riskFlag))).toBe(true);
    const scales = all.flatMap((s) => s.scales);
    expect(scales.some((s) => s.norms.length > 0 || s.stenTable.length > 0)).toBe(true);
  });
});

describe("сохранение через PATCH не меняет методику", () => {
  test("каждая методика: новая версия с тем же содержимым", async () => {
    for (const [key] of INSTRUMENTS) {
      const before = installed.get(key)!;
      const { baseVersionId, ...payload } = toPayload(toDraft(before, []));
      expect(baseVersionId, key).toBe(before.versionId);
      const res = await api(`/api/surveys/${before.id}`, root.token, {
        method: "PATCH",
        body: JSON.stringify({ ...payload, baseVersionId, versionNote: "конструктор без втрат" }),
      });
      expect(res.status, `${key}: ${JSON.stringify(res.body)}`).toBe(200);
      const after = (await getSurvey(before.id, null, "uk", true))!;
      expect(after.versionId, key).not.toBe(before.versionId);
      expect(comparable(versionContent(after), after), key).toEqual(comparable(versionContent(before), before));
      installed.set(key, after);
    }
  }, 120_000);

  test("устаревшая версия — 409 с текстом «перечитайте», а не запись поверх", async () => {
    const stale = installed.get("sr45")!;
    // кто-то сохранил методику после того, как её открыли
    const first = toPayload(toDraft(stale, []));
    expect((await api(`/api/surveys/${stale.id}`, root.token, { method: "PATCH", body: JSON.stringify(first) })).status).toBe(200);
    // второе окно сохраняет черновик, начатый от прежней версии
    const second = await api<{ error: string }>(`/api/surveys/${stale.id}`, root.token, {
      method: "PATCH",
      headers: { "Accept-Language": "uk" },
      body: JSON.stringify(first),
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe(ERRORS["err.surveyVersionConflict"].uk);
  }, 30_000);
});

/**
 * Выгрузка → импорт без потерь (волна 18, внешний разбор CR-049).
 *
 * surveyToDraft был отдельным конвертером и отдавал sections: [] и вопросы
 * без sectionKey, scaleCode, reverseScored и logic: файл, импортированный в
 * другом учреждении, считался иначе. Теперь он собран поверх versionContent
 * и снимает только то, чему нельзя уезжать (локальные нормы, ссылки
 * каскадов). Проверка — тем же сравнением, что у конструктора, на всём
 * каталоге и на методике, где есть всё, что терялось.
 */
describe("выгрузка → импорт не меняет методику", () => {
  async function roundtrip(source: SurveyFull): Promise<SurveyFull> {
    const exported = await api(`/api/surveys/${source.id}/export`, root.token);
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    const imported = await api(`/api/surveys/import`, root.token, {
      method: "POST",
      body: JSON.stringify({ ...exported.body, groupId: group }),
    });
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    return (await getSurvey(imported.body.id, null, "uk", true))!;
  }

  test("каждая методика каталога: импорт файла даёт то же содержимое", async () => {
    for (const [key] of INSTRUMENTS) {
      const before = installed.get(key)!;
      const after = await roundtrip(before);
      expect(comparable(versionContent(after), after), key).toEqual(comparable(versionContent(before), before));
    }
  }, 120_000);

  test("секции, шкала пункта, обратный ключ, условие на вариант и настройки доезжают", async () => {
    const L = (uk: string) => ({ uk, ru: uk });
    const yesNo = (title: string, over: Record<string, unknown> = {}) => ({
      type: "yesno",
      title: L(title),
      required: true,
      sectionKey: "a",
      scaleCode: "S",
      options: [
        { text: L("Так"), score: 1, keyCode: "yes" },
        { text: L("Ні"), score: 0, keyCode: "no" },
      ],
      ...over,
    });
    const created = await api("/api/surveys", root.token, {
      method: "POST",
      body: JSON.stringify({
        title: L(`Повний цикл ${tag}`),
        groupId: group,
        administration: "clinician",
        visibility: "restricted",
        scoringEnabled: true,
        allowRetake: true,
        showResultsToPatient: true,
        timeLimitSec: 777,
        tooFastMs: 12345,
        instructions: L("Інструкція для файлу"),
        safetyPlan: L("План безпеки"),
        sections: [
          { key: "a", title: L("Перший розділ") },
          { key: "b", title: L("Другий розділ"), description: L("Опис розділу") },
        ],
        questions: [
          yesNo("Перший"),
          yesNo("Другий, обернений", { reverseScored: true }),
          yesNo("Третій, умовний", { sectionKey: "b" }),
          { type: "info", title: L("Завершення"), options: [], sectionKey: "b" },
        ],
        scales: [{ code: "S", title: L("Сума"), kind: "clinical", normalization: "raw", bands: [] }],
      }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // условие «показать третий при «Так» в первом» ссылается на вариант этой версии — его id известен только после записи
    const draft = (await getSurvey(created.body.id, null, "uk", true))!;
    const yesId = draft.questions[0]!.options[0]!.id;
    const content = versionContent(draft);
    content.questions[2]!.logic = [{ sourceIndex: 0, operator: "eq", value: yesId, action: "show" }];
    await createVersion(draft.id, content, root.id, "умова на варіант", draft);
    const before = (await getSurvey(draft.id, null, "uk", true))!;
    expect(before.questions[2]!.logic[0]!.value).toBe(before.questions[0]!.options[0]!.id);

    const after = await roundtrip(before);
    expect(comparable(versionContent(after), after)).toEqual(comparable(versionContent(before), before));
    // всё, что терялось, — на месте
    // raw-представление: тексты на всех языках
    expect(after.sections.map((s) => s.title as unknown)).toEqual([L("Перший розділ"), L("Другий розділ")]);
    expect(after.questions[1]!.reverseScored).toBe(true);
    expect(after.questions[2]!.sectionId).toBe(after.sections[1]!.id);
    expect(after.questions[0]!.scaleId).toBe(after.scales[0]!.id);
    expect(after.questions[2]!.logic[0]!.value, "условие ссылается не на вариант новой версии").toBe(
      after.questions[0]!.options[0]!.id,
    );
    // настройки строки
    expect(after).toMatchObject({
      administration: "clinician",
      visibility: "restricted",
      allowRetake: true,
      showResultsToPatient: true,
      timeLimitSec: 777,
      tooFastMs: 12345,
    });
    expect(after.instructions as unknown).toEqual(L("Інструкція для файлу"));
  }, 30_000);
});
