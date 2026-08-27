import type { CreateSurveyInput } from "./schemas";

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
  /** Где именно: «Шкала Sr», «Пункт 12» */
  where: string;
  message: string;
}

type Draft = Pick<CreateSurveyInput, "questions" | "scales">;

export function validateSurvey(draft: Draft): Issue[] {
  const issues: Issue[] = [];
  const add = (level: IssueLevel, where: string, message: string) =>
    issues.push({ level, where, message });

  const questions = draft.questions ?? [];
  const scales = draft.scales ?? [];
  const total = questions.length;

  /* ─── шкалы: коды ─── */
  const codeCount = new Map<string, number>();
  for (const s of scales) codeCount.set(s.code, (codeCount.get(s.code) ?? 0) + 1);
  for (const [code, n] of codeCount) {
    if (n > 1) add("error", `Шкала ${code}`, `Код шкалы повторяется ${n} раза — коды должны быть уникальны`);
    if (!code.trim()) add("error", "Шкала без кода", "У шкалы пустой код, на неё нельзя сослаться");
  }

  /* ─── вопросы: варианты ─── */
  const needsOptions = ["single", "multiple", "matrix", "ranking", "yesno"];
  questions.forEach((q, i) => {
    const choices = q.options.filter((o) => o.kind === "option");
    if (needsOptions.includes(q.type) && choices.length < 2) {
      add("error", `Пункт ${i + 1}`, `Тип «${q.type}» требует минимум двух вариантов, задано ${choices.length}`);
    }
    const codes = choices.map((o) => o.keyCode).filter(Boolean);
    if (new Set(codes).size !== codes.length) {
      add("error", `Пункт ${i + 1}`, "Коды вариантов повторяются — ключ не сможет отличить ответы");
    }
    for (const o of choices) {
      if (o.riskFlag && !o.riskLabel) {
        add("warning", `Пункт ${i + 1}`, "Критический вариант без текста тревоги — персонал увидит текст пункта");
      }
    }
  });

  /* ─── ключи шкал ─── */
  for (const s of scales) {
    const where = `Шкала ${s.code}`;
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
        add("warning", where, "У шкалы нет ни ключа, ни привязанных пунктов — она всегда даст ноль");
      }
    }

    const seen = new Map<number, string | null | undefined>();
    for (const entry of key) {
      if (entry.item < 1 || entry.item > total) {
        add("error", where, `В ключе пункт ${entry.item}, а в методике их ${total}`);
        continue;
      }
      if (seen.has(entry.item)) {
        const prev = seen.get(entry.item);
        if (prev === entry.matchKey) {
          add("error", where, `Пункт ${entry.item} указан в ключе дважды`);
        } else {
          add(
            "error",
            where,
            `Пункт ${entry.item} требует одновременно «${prev ?? "балл"}» и «${entry.matchKey ?? "балл"}» — противоречие в ключе`,
          );
        }
        continue;
      }
      seen.set(entry.item, entry.matchKey);

      // ключ ссылается на код варианта, которого у пункта нет
      if (entry.matchKey) {
        const q = questions[entry.item - 1]!;
        const codes = q.options.filter((o) => o.kind === "option").map((o) => o.keyCode);
        if (!codes.includes(entry.matchKey)) {
          add(
            "error",
            where,
            `Пункт ${entry.item}: ключ ждёт вариант «${entry.matchKey}», а у пункта такие коды: ${
              codes.filter(Boolean).join(", ") || "нет кодов"
            }`,
          );
        }
      }
    }
  }

  /* ─── поправки между шкалами ─── */
  const byCode = new Map(scales.map((s) => [s.code, s]));
  for (const s of scales) {
    for (const c of s.corrections ?? []) {
      if (!byCode.has(c.from)) {
        add("error", `Шкала ${s.code}`, `Поправка ссылается на шкалу «${c.from}», которой нет`);
      }
      if (c.from === s.code) {
        add("error", `Шкала ${s.code}`, "Шкала поправляет саму себя");
      }
    }
  }
  // взаимные поправки: A правит B, B правит A — результат зависел бы от порядка
  for (const a of scales) {
    for (const c of a.corrections ?? []) {
      const b = byCode.get(c.from);
      if (b?.corrections?.some((x) => x.from === a.code)) {
        add("error", `Шкала ${a.code}`, `Взаимная поправка со шкалой ${b.code} — так считать нельзя`);
      }
    }
  }

  /* ─── нормирование ─── */
  for (const s of scales) {
    const where = `Шкала ${s.code}`;
    if (s.normalization === "ratio" && !s.ratioDenominator) {
      add("warning", where, "Доля без знаменателя — будет взят максимум по ключу, а в методике он может быть другим");
    }
    if (s.normalization === "tscore" && (s.norms ?? []).length === 0) {
      add("error", where, "T-баллы без норм: перевести сырой балл не во что");
    }
    if (s.normalization === "sten" && (s.stenTable ?? []).length === 0) {
      add("error", where, "Стены без таблицы перевода");
    }
    if (s.normalization !== "sten" && (s.stenTable ?? []).length > 0) {
      add("warning", where, "Задана таблица стенов, но нормирование другое — таблица не применится");
    }
    if (s.normalization !== "tscore" && (s.norms ?? []).length > 0) {
      add("warning", where, "Заданы нормы, но нормирование не T-баллы — нормы не применятся");
    }
    for (const n of s.norms ?? []) {
      if (n.sd <= 0) add("error", where, "Стандартное отклонение в норме должно быть больше нуля");
    }

    if (s.kind === "validity" && s.validityThreshold == null) {
      add(
        "warning",
        where,
        "Шкала достоверности без порога — гейт не сработает. Это законно, если шкала нужна только для поправок",
      );
    }
    if (s.kind === "validity" && s.validityThreshold != null && !s.validityDirection) {
      add("error", where, "У порога достоверности не указано, с какой стороны он нарушается");
    }
  }

  /* ─── интерпретационные нормы ─── */
  for (const s of scales) {
    const where = `Шкала ${s.code}`;
    const bands = [...(s.bands ?? [])].sort((a, b) => a.minScore - b.minScore);
    for (const b of bands) {
      if (b.maxScore < b.minScore) {
        add("error", where, `Норма «${labelOf(b.label)}»: верхняя граница ниже нижней`);
      }
    }
    for (let i = 1; i < bands.length; i++) {
      const prev = bands[i - 1]!;
      const cur = bands[i]!;
      if (cur.minScore <= prev.maxScore) {
        add(
          "error",
          where,
          `Нормы «${labelOf(prev.label)}» и «${labelOf(cur.label)}» пересекаются: результат зависел бы от порядка`,
        );
      }
    }
    if (s.kind === "clinical" && bands.length === 0) {
      add("warning", where, "У содержательной шкалы нет норм — балл будет без интерпретации");
    }
  }

  /* ─── таблицы стенов ─── */
  for (const s of scales) {
    const rows = [...(s.stenTable ?? [])].sort((a, b) => a.rawMin - b.rawMin);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]!.rawMin <= rows[i - 1]!.rawMax) {
        add(
          "error",
          `Шкала ${s.code}`,
          `Строки стенов ${rows[i - 1]!.sten} и ${rows[i]!.sten} пересекаются по сырому баллу`,
        );
      }
    }
    if (rows.length && rows[0]!.rawMin > 0) {
      add("warning", `Шкала ${s.code}`, `Таблица стенов начинается с ${rows[0]!.rawMin}: нулевой балл никуда не попадёт`);
    }
  }

  return issues;
}

function labelOf(label: unknown): string {
  if (typeof label === "string") return label;
  if (label && typeof label === "object") {
    const v = Object.values(label as Record<string, string>)[0];
    return v ?? "—";
  }
  return "—";
}
