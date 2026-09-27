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
