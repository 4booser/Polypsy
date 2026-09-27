import { serverText, type ServerTextKey } from "./serverStrings";
import type { Lang, Question, Scale, SurveyFull } from "./types";

/**
 * Что изменилось между двумя версиями методики.
 *
 * Зачем это нужно клинически: правка создаёт новую версию, а старые
 * прохождения остаются на прежней. Через полгода, глядя на две группы
 * результатов, надо уметь ответить — они сопоставимы или между ними
 * переписали ключ? Формулировка пункта, вес в ключе и границы полос меняют
 * смысл балла; порядок вопросов и опечатка в описании — нет.
 *
 * Поэтому изменения делятся на существенные (`scoring`) и косметические:
 * первые запрещают напрямую сравнивать баллы разных версий.
 */

export type ChangeKind = "added" | "removed" | "changed";

export interface FieldChange {
  /**
   * Что изменилось — устойчивым именем («wording», «key»). По нему поле
   * узнают программно: подпись ниже переводится и от языка зависит.
   */
  code: DiffField;
  /** Подпись поля на языке запроса */
  field: string;
  before: string | null;
  after: string | null;
  /** Меняет ли это интерпретацию уже собранных баллов */
  scoring: boolean;
}

export interface ItemDiff {
  kind: ChangeKind;
  /** Номер пункта в версии, где он есть; при переносе — номер «после» */
  position: number;
  title: string;
  changes: FieldChange[];
}

export interface ScaleDiff {
  kind: ChangeKind;
  code: string;
  title: string;
  changes: FieldChange[];
}

export interface VersionDiff {
  questions: ItemDiff[];
  scales: ScaleDiff[];
  /** Сопоставимы ли баллы двух версий напрямую */
  comparable: boolean;
  /** Короткое человеческое резюме: чем именно версии несопоставимы — на языке запроса */
  reasons: string[];
}

/** Поля, которые сравниваются, — хвосты ключей diff.field.* словаря сервера */
export type DiffField =
  | "wording"
  | "help"
  | "type"
  | "required"
  | "reverse"
  | "scale"
  | "options"
  | "order"
  | "title"
  | "description"
  | "aggregation"
  | "normalization"
  | "denominator"
  | "key"
  | "bands"
  | "validity"
  | "corrections";

function textOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

/*
 * Подпись поля собирается на языке запроса. Раньше здесь стояли русские
 * слова, и украинский специалист сравнивал версии, читая «формулировка» и
 * «полосы интерпретации» посреди украинского экрана.
 */
function fieldOf(lang: Lang) {
  return (code: DiffField, before: unknown, after: unknown, scoring: boolean): FieldChange | null => {
    const a = textOf(before);
    const b = textOf(after);
    if (a === b) return null;
    return { code, field: serverText(`diff.field.${code}` satisfies ServerTextKey, lang), before: a, after: b, scoring };
  };
}

/**
 * Ключ шкалы в сравнимом виде.
 *
 * Пункты берутся по id, а не по номеру. Номер — это то, как ключ выглядит в
 * пособии, но перестановка вопросов не меняет ни одного уже посчитанного
 * балла: засчитываются те же ответы тех же людей. Сравнение по номерам
 * объявляло бы простую перестановку правкой ключа и запрещало сопоставлять
 * вполне сопоставимые замеры.
 */
function keyOf(scale: Scale): string {
  return scale.items
    .map((i) => `${i.questionId}:${i.matchKey ?? "*"}:${i.weight}`)
    .sort()
    .join(",");
}

function bandsOf(scale: Scale): string {
  return scale.bands
    .map((b) => `${b.minScore}..${b.maxScore}:${b.severity}`)
    .join(",");
}

function questionChanges(a: Question, b: Question, lang: Lang): FieldChange[] {
  const field = fieldOf(lang);
  return [
    // формулировка меняет смысл ответа: человек отвечал на другой вопрос
    field("wording", a.title, b.title, true),
    field("help", a.help, b.help, false),
    field("type", a.type, b.type, true),
    field("required", a.required, b.required, false),
    field("reverse", a.reverseScored, b.reverseScored, true),
    field("scale", a.scaleId, b.scaleId, true),
    field(
      "options",
      // код и балл варианта важнее его текста: по ним считается шкала
      a.options.map((o) => `${o.text}[${o.keyCode ?? "-"}=${o.score}]`).join(" | "),
      b.options.map((o) => `${o.text}[${o.keyCode ?? "-"}=${o.score}]`).join(" | "),
      true,
    ),
    field("order", a.position, b.position, false),
  ].filter((x): x is FieldChange => x !== null);
}

function scaleChanges(a: Scale, b: Scale, lang: Lang): FieldChange[] {
  const field = fieldOf(lang);
  return [
    field("title", a.title, b.title, false),
    field("description", a.description, b.description, false),
    field("aggregation", a.aggregation, b.aggregation, true),
    field("normalization", a.normalization, b.normalization, true),
    field("denominator", a.ratioDenominator, b.ratioDenominator, true),
    field("key", keyOf(a), keyOf(b), true),
    field("bands", bandsOf(a), bandsOf(b), true),
    field("validity", a.validityThreshold, b.validityThreshold, true),
    field(
      "corrections",
      a.corrections.map((c) => `${c.sourceScaleCode}×${c.coefficient}`).sort().join(","),
      b.corrections.map((c) => `${c.sourceScaleCode}×${c.coefficient}`).sort().join(","),
      true,
    ),
  ].filter((x): x is FieldChange => x !== null);
}

/**
 * Пункты сопоставляются по id, а не по номеру: правка не пересоздаёт вопрос,
 * поэтому id переживает и переформулировку, и перестановку. Сравнение по
 * номеру объявляло бы вставку одного пункта в начало полной заменой методики.
 */
export function diffVersions(before: SurveyFull, after: SurveyFull, lang: Lang = "uk"): VersionDiff {
  const posA = new Map(before.questions.map((q, i) => [q.id, i + 1]));
  const posB = new Map(after.questions.map((q, i) => [q.id, i + 1]));
  const byIdA = new Map(before.questions.map((q) => [q.id, q]));
  const byIdB = new Map(after.questions.map((q) => [q.id, q]));

  const questions: ItemDiff[] = [];
  for (const q of before.questions) {
    if (!byIdB.has(q.id)) {
      questions.push({ kind: "removed", position: posA.get(q.id)!, title: q.title, changes: [] });
    }
  }
  for (const q of after.questions) {
    const old = byIdA.get(q.id);
    if (!old) {
      questions.push({ kind: "added", position: posB.get(q.id)!, title: q.title, changes: [] });
      continue;
    }
    const changes = questionChanges(old, q, lang);
    if (changes.length) {
      questions.push({ kind: "changed", position: posB.get(q.id)!, title: q.title, changes });
    }
  }
  questions.sort((x, y) => x.position - y.position);

  // шкалы сопоставляются по коду: он и есть их имя в пособии
  const scalesA = new Map(before.scales.map((s) => [s.code, s]));
  const scalesB = new Map(after.scales.map((s) => [s.code, s]));
  const scales: ScaleDiff[] = [];
  for (const [code, s] of scalesA) {
    if (!scalesB.has(code)) scales.push({ kind: "removed", code, title: s.title, changes: [] });
  }
  for (const [code, s] of scalesB) {
    const old = scalesA.get(code);
    if (!old) {
      scales.push({ kind: "added", code, title: s.title, changes: [] });
      continue;
    }
    const changes = scaleChanges(old, s, lang);
    if (changes.length) scales.push({ kind: "changed", code, title: s.title, changes });
  }
  scales.sort((x, y) => x.code.localeCompare(y.code));

  const reasons: string[] = [];
  const removedQ = questions.filter((q) => q.kind === "removed").length;
  const addedQ = questions.filter((q) => q.kind === "added").length;
  if (removedQ) reasons.push(serverText("diff.removedItems", lang, { n: removedQ }));
  if (addedQ) reasons.push(serverText("diff.addedItems", lang, { n: addedQ }));

  const scoringQ = questions.filter((q) => q.changes.some((c) => c.scoring)).length;
  if (scoringQ) reasons.push(serverText("diff.scoringItems", lang, { n: scoringQ }));

  const scoringS = scales.filter(
    (s) => s.kind !== "changed" || s.changes.some((c) => c.scoring),
  ).length;
  if (scoringS) reasons.push(serverText("diff.scoringScales", lang, { n: scoringS }));

  return { questions, scales, comparable: reasons.length === 0, reasons };
}
