import { validateSurvey, type SurveyFull } from "@quizzy/shared";
import type { ExampleSet } from "./examples";
import { loc, num, ranges, type Loc } from "./format";
import type { DossierCard, InstalledInstrument } from "./index";
import type { InstrumentNotes } from "./notes";

/**
 * Замечания для проверки: что генератор нашёл сам, сверяя установленную
 * методику с движком, с досье первоисточника и с собственной структурой.
 *
 * Ничего здесь не чинится — сверка не место для правки подсчёта. Замечание
 * уходит в лист методики и в сводку README, где его увидит психолог; решение
 * о том, ошибка это или осознанный выбор, — его, а не генератора. Поэтому
 * замечание пишется и тогда, когда расхождение с досье объяснено в
 * комментарии методики: объяснение стоит в разделе «Відомі відмінності», а
 * проверить его должен человек.
 */

export interface Finding {
  text: Loc;
  /** Откуда: генератор сам нашёл или записано человеком в notes.ts */
  origin: "auto" | "notes";
  /** «Досье нет» — в сводке README идёт одной строкой на все методики, а не под каждой */
  tag?: "noDossier";
}

const auto = (uk: string, ru: string): Finding => ({ text: loc(uk, ru), origin: "auto" });

type Pair = [number, number];

/** Полосы досье плоским списком [от; до]; null — формат вложенный, сверять руками */
function dossierBands(card: DossierCard): Pair[] | null | "none" {
  if (card.bands === null || card.bands === undefined) return "none";
  if (!Array.isArray(card.bands)) return null;
  const out: Pair[] = [];
  for (const b of card.bands as Record<string, unknown>[]) {
    if ("bands" in b || "substance" in b || "scale" in b) return null;
    const lo = (b.min ?? b.from) as number | undefined;
    const hi = (b.max ?? b.to) as number | undefined;
    if (typeof lo === "number" && typeof hi === "number") out.push([lo, hi]);
  }
  return out;
}

/** Номера пунктов досье: [3, 5] или [{ n: 3 }] */
function dossierNumbers(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const v of value) {
    if (typeof v === "number") out.push(v);
    else if (v && typeof v === "object" && typeof (v as { n?: unknown }).n === "number" && !("scale" in v)) {
      out.push((v as { n: number }).n);
    } else return null;
  }
  return out;
}

const pairs = (list: Pair[]) => list.map(([a, b]) => `${num(a)}–${num(b)}`).join(" / ");

/** Шкала, с полосами которой сверяется досье: первая с полосами */
function primaryScale(survey: SurveyFull) {
  return survey.scales.find((s) => s.bands.length) ?? survey.scales[0] ?? null;
}

export function checkInstrument(
  inst: InstalledInstrument,
  examples: ExampleSet,
  dossier: DossierCard | null,
  notes: InstrumentNotes,
): Finding[] {
  const out: Finding[] = [];
  const survey = inst.uk;

  /* Проверка структуры самой системы (то же, что кнопка «Перевірити структуру» конструктора) */
  /*
   * Одинаковые проблемы сворачиваются в одну строку: у Brief COPE четырнадцать
   * шкал без норм, и четырнадцать одинаковых строк спрятали бы остальное.
   */
  const issuesUk = validateSurvey(inst.input, "uk");
  const issuesRu = validateSurvey(inst.input, "ru");
  const grouped = new Map<string, { level: string; uk: string; ru: string; where: Loc[] }>();
  issuesUk.forEach((issue, i) => {
    const ru = issuesRu[i] ?? issue;
    const key = `${issue.level}|${issue.message}`;
    const g = grouped.get(key) ?? { level: issue.level, uk: issue.message, ru: ru.message, where: [] };
    g.where.push(loc(issue.where, ru.where));
    grouped.set(key, g);
  });
  for (const g of grouped.values()) {
    const error = g.level === "error";
    out.push(
      auto(
        `Перевірка структури (${error ? "помилка" : "попередження"}): ${g.uk} — ${g.where.map((w) => w.uk).join(", ")}.`,
        `Проверка структуры (${error ? "ошибка" : "предупреждение"}): ${g.ru} — ${g.where.map((w) => w.ru).join(", ")}.`,
      ),
    );
  }

  /* Движок: полосы, которые не достигаются, и значения без полосы */
  for (const u of examples.unreachable) {
    const st = u.stratum ? ` (${u.stratum.uk})` : "";
    const stRu = u.stratum ? ` (${u.stratum.ru})` : "";
    out.push(
      auto(
        `Шкала ${u.code}${st}: смуги «${u.band.uk}» не дає жоден можливий набір відповідей.`,
        `Шкала ${u.code}${stRu}: полосу «${u.band.ru}» не даёт ни один возможный набор ответов.`,
      ),
    );
  }
  const gapByScale = new Map<string, { values: Set<number>; stratum: Loc | null }>();
  for (const g of examples.gaps) {
    const key = `${g.code}|${g.stratum?.uk ?? ""}`;
    const have = gapByScale.get(key) ?? { values: new Set<number>(), stratum: g.stratum };
    have.values.add(g.value);
    gapByScale.set(key, have);
  }
  for (const [key, g] of gapByScale) {
    const code = key.split("|")[0]!;
    const values = [...g.values].sort((a, b) => a - b).map(num).join("; ");
    out.push(
      auto(
        `Шкала ${code}${g.stratum ? ` (${g.stratum.uk})` : ""}: досяжні значення без смуги — ${values}. Смуги не покривають діапазон.`,
        `Шкала ${code}${g.stratum ? ` (${g.stratum.ru})` : ""}: достижимые значения без полосы — ${values}. Полосы не покрывают диапазон.`,
      ),
    );
  }
  for (const f of examples.findings) out.push({ text: f, origin: "auto" });

  /* Пункты вне всех шкал, не объявленные методикой */
  const inKey = new Set(survey.scales.flatMap((s) => s.items.map((i) => i.questionId)));
  const declared = new Set(inst.entry.notScored?.items ?? []);
  const loose = survey.questions
    .map((q, i) => ({ q, n: i + 1 }))
    .filter(({ q, n }) => !inKey.has(q.id) && !declared.has(n) && q.type !== "info" && q.type !== "text");
  const isGate = (id: string) => survey.questions.some((q) => (q.logic ?? []).some((r) => r.sourceQuestionId === id));
  const unexplained = loose.filter(({ q }) => !isGate(q.id));
  if (unexplained.length) {
    const list = ranges(unexplained.map((x) => x.n));
    const one = unexplained.length === 1;
    out.push(
      auto(
        one
          ? `Пункт ${list} не входить у жодну шкалу й не позначений як такий, що не рахується: відповідь на нього нічого не змінює.`
          : `Пункти ${list} не входять у жодну шкалу й не позначені як такі, що не рахуються: відповіді на них нічого не змінюють.`,
        one
          ? `Пункт ${list} не входит ни в одну шкалу и не отмечен как не считающийся: ответ на него ничего не меняет.`
          : `Пункты ${list} не входят ни в одну шкалу и не отмечены как не считающиеся: ответы на них ничего не меняют.`,
      ),
    );
  }

  /* Досье: проверочные примеры */
  for (const ex of examples.examples) {
    if (ex.kind !== "dossier" || !ex.expect) continue;
    for (const { code, value } of ex.expect) {
      const got = ex.result.uk.profile.scores.find((s) => s.scaleCode === code);
      if (!got || Math.abs(got.value - value) > 1e-6) {
        out.push(
          auto(
            `Приклад досьє «${ex.title.uk}»: за досьє ${code} = ${num(value)}, система рахує ${got ? num(got.value) : "«не обчислено»"}.`,
            `Пример досье «${ex.title.ru}»: по досье ${code} = ${num(value)}, система считает ${got ? num(got.value) : "«не вычислено»"}.`,
          ),
        );
      }
    }
  }

  if (!dossier) {
    out.push({
      ...auto(
        "Досьє першоджерела для методики немає: пункти, ключ і межі звіряються з публікацією напряму.",
        "Досье первоисточника для методики нет: пункты, ключ и границы сверяются с публикацией напрямую.",
      ),
      tag: "noDossier",
    });
  } else {
    /* Досье: число пунктов */
    if (Array.isArray(dossier.items) && inst.entry.key !== "assist") {
      const n = dossier.items.length;
      if (n !== survey.questions.length) {
        out.push(
          auto(
            `Досьє називає ${n} пунктів, у системі — ${survey.questions.length}.`,
            `Досье называет ${n} пунктов, в системе — ${survey.questions.length}.`,
          ),
        );
      }
    }
    /* Досье: полосы основной шкалы */
    const want = dossierBands(dossier);
    const scale = primaryScale(survey);
    const have: Pair[] = scale ? [...scale.bands].sort((a, b) => a.minScore - b.minScore).map((b) => [b.minScore, b.maxScore]) : [];
    if (want === "none") {
      if (survey.scales.some((s) => s.bands.length)) {
        out.push(
          auto(
            "У досьє смуг немає, а в системі вони є — перевірити, звідки взято межі.",
            "В досье полос нет, а в системе они есть — проверить, откуда взяты границы.",
          ),
        );
      }
    } else if (want === null) {
      out.push(
        auto(
          "Смуги досьє записано вкладеним форматом (окремо для шкал або речовин) — автоматично не звірялися, звірити вручну з розділом «Шкали».",
          "Полосы досье записаны вложенным форматом (отдельно для шкал или веществ) — автоматически не сверялись, сверить вручную с разделом «Шкалы».",
        ),
      );
    } else if (scale && pairs(want) !== pairs(have)) {
      out.push(
        auto(
          `Межі смуг ${scale.code} розходяться з досьє: досьє — ${pairs(want)}; система — ${pairs(have)}. Пояснення, якщо воно є в коді, — у розділі «Відомі відмінності».`,
          `Границы полос ${scale.code} расходятся с досье: досье — ${pairs(want)}; система — ${pairs(have)}. Объяснение, если оно есть в коде, — в разделе «Известные отличия».`,
        ),
      );
    }
    /* Досье: обратные пункты */
    const reverse = dossierNumbers(dossier.reverse);
    const sysReverse = survey.questions.map((q, i) => (q.reverseScored ? i + 1 : 0)).filter(Boolean);
    if (reverse && ranges(reverse) !== ranges(sysReverse)) {
      out.push(
        auto(
          `Обернені пункти розходяться з досьє: досьє — ${ranges(reverse) || "немає"}; система — ${ranges(sysReverse) || "немає"}.`,
          `Обратные пункты расходятся с досье: досье — ${ranges(reverse) || "нет"}; система — ${ranges(sysReverse) || "нет"}.`,
        ),
      );
    }
    /* Досье: пункты риска (у ASSIST номера досье — вопросы бланка, а не пункты системы) */
    const risk = inst.entry.key === "assist" ? null : dossierNumbers(dossier.risk_items ?? []);
    const sysRisk = survey.questions
      .map((q, i) => (q.options.some((o) => o.riskFlag) || q.riskThreshold !== null ? i + 1 : 0))
      .filter(Boolean);
    if (risk && ranges(risk) !== ranges(sysRisk)) {
      out.push(
        auto(
          `Критичні пункти розходяться з досьє: досьє — ${ranges(risk) || "немає"}; система — ${ranges(sysRisk) || "немає"}. Пояснення, якщо воно є в коді, — у розділі «Відомі відмінності».`,
          `Критические пункты расходятся с досье: досье — ${ranges(risk) || "нет"}; система — ${ranges(sysRisk) || "нет"}. Объяснение, если оно есть в коде, — в разделе «Известные отличия».`,
        ),
      );
    }
  }

  if (!inst.entry.catalog) {
    out.push(
      auto(
        "Джерело в системі не записано: його називають лише коментар у визначенні методики та паспорт docs/INSTRUMENTS.md; журнал установки джерела не містить, бо методику ставить лише демонстраційний посів (seed.ts), а не установник каталогу.",
        "Источник в системе не записан: его называют только комментарий в определении методики и паспорт docs/INSTRUMENTS.md; журнал установки источника не содержит, потому что методику ставит только демонстрационный посев (seed.ts), а не установщик каталога.",
      ),
    );
  }

  for (const r of notes.remarks) out.push({ text: r, origin: "notes" });
  return out;
}
