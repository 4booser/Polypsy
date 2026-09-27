import type { CreateSurveyInput } from "./schemas";
import { serverText, type ServerTextKey, type TextParams } from "./serverStrings";
import { t, type Lang, type LocalizedText } from "./types";

/**
 * Структурная проверка методики.
 *
 * Зачем: ключи, нормы и коэффициенты переносятся из пособий вручную, а ошибка
 * в одном номере пункта тихо портит каждый посчитанный балл — результат просто
 * окажется неправильным, и заметить это по самому результату нельзя.
 * Здесь ловится то, что можно поймать формально, не зная содержания методики.
 *
 * error   — методика посчитается неверно или не посчитается вовсе;
 * warning — скорее всего ошибка переноса, но бывают законные исключения.
 */
export type IssueLevel = "error" | "warning";

export interface Issue {
  level: IssueLevel;
  /**
   * Что за проблема — ключ словаря сервера (serverStrings.ts). По нему
   * проблему узнают программно, не разбирая фразу: фраза теперь на языке
   * того, кто спросил, и одно и то же слово искать в трёх языках нельзя.
   */
  code: ServerTextKey;
  /** Подстановки фразы: номер пункта, код шкалы, название полосы */
  params: TextParams;
  /** Где именно: «Шкала Sr», «Пункт 12» — на языке проверки */
  where: string;
  /** Фраза целиком — на языке проверки */
  message: string;
}

type Draft = Pick<CreateSurveyInput, "questions" | "scales">;

/**
 * Проверка черновика.
 *
 * Язык — язык того, кто будет читать: маршрут передаёт langOf(c), и
 * конструктор на украинском экране получает украинские проблемы. Прежде
 * они были русскими на любом языке — строки собирались здесь же, по-русски.
 * Без языка — украинский, как у t(): язык учреждения.
 */
export function validateSurvey(draft: Draft, lang: Lang = "uk"): Issue[] {
  const issues: Issue[] = [];
  const say = (key: ServerTextKey, params?: TextParams) => serverText(key, lang, params);
  const add = (level: IssueLevel, where: string, code: ServerTextKey, params: TextParams = {}) =>
    issues.push({ level, code, params, where, message: say(code, params) });
  const scaleAt = (code: string) => say("val.where.scale", { code });
  const itemAt = (n: number) => say("val.where.item", { n });

  const questions = draft.questions ?? [];
  const scales = draft.scales ?? [];
  const total = questions.length;

  /* ─── шкалы: коды ─── */
  const codeCount = new Map<string, number>();
  for (const s of scales) codeCount.set(s.code, (codeCount.get(s.code) ?? 0) + 1);
  for (const [code, n] of codeCount) {
    if (n > 1) add("error", scaleAt(code), "val.scaleCodeRepeated", { n });
    if (!code.trim()) add("error", say("val.where.scaleNoCode"), "val.scaleCodeEmpty");
  }

  /* ─── вопросы: варианты ─── */
  const needsOptions = ["single", "multiple", "matrix", "ranking", "yesno"];
  questions.forEach((q, i) => {
    const choices = q.options.filter((o) => o.kind === "option");
    if (needsOptions.includes(q.type) && choices.length < 2) {
      add("error", itemAt(i + 1), "val.tooFewOptions", { type: q.type, n: choices.length });
    }
    const codes = choices.map((o) => o.keyCode).filter(Boolean);
    if (new Set(codes).size !== codes.length) {
      add("error", itemAt(i + 1), "val.optionCodesRepeated");
    }
    for (const o of choices) {
      if (o.riskFlag && !o.riskLabel) {
        add("warning", itemAt(i + 1), "val.riskWithoutLabel");
      }
    }
  });

  /* ─── ключи шкал ─── */
  for (const s of scales) {
    const where = scaleAt(s.code);
    const key = s.key ?? [];

    if (key.length === 0 && s.kind === "clinical") {
      const linked = questions.some((q) => q.scaleCode === s.code);
      /*
       * Композит считается из других шкал поправками, а не из своих пунктов:
       * так устроен ЛАП в МЛО — сумма ПР, КП и МН. Ругаться на него значило
       * бы держать вечное ложное предупреждение, а вечное ложное
       * предупреждение приучает не читать предупреждения вовсе.
       */
      const composite = (s.corrections ?? []).length > 0;
      if (!linked && !composite) {
        add("warning", where, "val.scaleUnlinked");
      }
    }

    const seen = new Map<number, string | null | undefined>();
    for (const entry of key) {
      if (entry.item < 1 || entry.item > total) {
        add("error", where, "val.keyItemOutOfRange", { item: entry.item, total });
        continue;
      }
      if (seen.has(entry.item)) {
        const prev = seen.get(entry.item);
        if (prev === entry.matchKey) {
          add("error", where, "val.keyItemTwice", { item: entry.item });
        } else {
          add("error", where, "val.keyContradiction", {
            item: entry.item,
            a: prev ?? say("val.scoreMode"),
            b: entry.matchKey ?? say("val.scoreMode"),
          });
        }
        continue;
      }
      seen.set(entry.item, entry.matchKey);

      // ключ ссылается на код варианта, которого у пункта нет
      if (entry.matchKey) {
        const q = questions[entry.item - 1]!;
        const codes = q.options.filter((o) => o.kind === "option").map((o) => o.keyCode);
        if (!codes.includes(entry.matchKey)) {
          add("error", where, "val.keyUnknownOption", {
            item: entry.item,
            code: entry.matchKey,
            codes: codes.filter(Boolean).join(", ") || say("val.noCodes"),
          });
        }
      }
    }
  }

  /* ─── поправки между шкалами ─── */
  const byCode = new Map(scales.map((s) => [s.code, s]));
  for (const s of scales) {
    for (const c of s.corrections ?? []) {
      if (!byCode.has(c.from)) {
        add("error", scaleAt(s.code), "val.correctionUnknown", { from: c.from });
      }
      if (c.from === s.code) {
        add("error", scaleAt(s.code), "val.correctionSelf");
      }
    }
  }
  // взаимные поправки: A правит B, B правит A — результат зависел бы от порядка
  for (const a of scales) {
    for (const c of a.corrections ?? []) {
      const b = byCode.get(c.from);
      if (b?.corrections?.some((x) => x.from === a.code)) {
        add("error", scaleAt(a.code), "val.correctionMutual", { other: b.code });
      }
    }
  }

  /* ─── нормирование ─── */
  for (const s of scales) {
    const where = scaleAt(s.code);
    if (s.normalization === "ratio" && !s.ratioDenominator) {
      add("warning", where, "val.ratioNoDenominator");
    }
    if (s.normalization === "tscore" && (s.norms ?? []).length === 0) {
      add("error", where, "val.tscoreNoNorms");
    }
    if (s.normalization === "sten" && (s.stenTable ?? []).length === 0) {
      add("error", where, "val.stenNoTable");
    }
    if (s.normalization !== "sten" && (s.stenTable ?? []).length > 0) {
      add("warning", where, "val.stenTableUnused");
    }
    if (s.normalization !== "tscore" && (s.norms ?? []).length > 0) {
      add("warning", where, "val.normsUnused");
    }
    for (const n of s.norms ?? []) {
      if (n.sd <= 0) add("error", where, "val.normSdNotPositive");
    }

    if (s.kind === "validity" && s.validityThreshold == null) {
      add("warning", where, "val.validityNoThreshold");
    }
    if (s.kind === "validity" && s.validityThreshold != null && !s.validityDirection) {
      add("error", where, "val.validityNoDirection");
    }
  }

  /* ─── интерпретационные нормы ─── */
  for (const s of scales) {
    const where = scaleAt(s.code);
    const bands = [...(s.bands ?? [])].sort((a, b) => a.minScore - b.minScore);
    for (const b of bands) {
      if (b.maxScore < b.minScore) {
        add("error", where, "val.bandInverted", { label: labelOf(b.label, lang) });
      }
    }
    for (let i = 1; i < bands.length; i++) {
      const prev = bands[i - 1]!;
      const cur = bands[i]!;
      if (cur.minScore <= prev.maxScore) {
        add("error", where, "val.bandsOverlap", { a: labelOf(prev.label, lang), b: labelOf(cur.label, lang) });
      }
    }
    if (s.kind === "clinical" && bands.length === 0) {
      add("warning", where, "val.clinicalNoBands");
    }
  }

  /* ─── таблицы стенов ─── */
  for (const s of scales) {
    const rows = [...(s.stenTable ?? [])].sort((a, b) => a.rawMin - b.rawMin);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]!.rawMin <= rows[i - 1]!.rawMax) {
        add("error", scaleAt(s.code), "val.stenRowsOverlap", { a: rows[i - 1]!.sten, b: rows[i]!.sten });
      }
    }
    if (rows.length && rows[0]!.rawMin > 0) {
      add("warning", scaleAt(s.code), "val.stenGapAtZero", { min: rows[0]!.rawMin });
    }
  }

  return issues;
}

/**
 * Название полосы на языке проверки.
 *
 * Прежде бралось первое попавшееся значение объекта языков — у полосы,
 * заведённой по-русски первой, украинский конструктор видел русское
 * название. Теперь — тем же порядком запасных языков, что и везде (t()).
 */
function labelOf(label: unknown, lang: Lang): string {
  if (typeof label === "string") return label;
  if (label && typeof label === "object") return t(label as LocalizedText, lang) || "—";
  return "—";
}
