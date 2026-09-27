import {
  DEFAULT_MIN_ANSWERED_SHARE,
  bandFor,
  isQuestionVisible,
  itemContribution,
  renderCoded,
  t,
  type Answer,
  type Option,
  type Question,
  type Scale,
  type ScaleBand,
  type Severity,
  type SubmissionEvaluation,
  type SurveyFull,
} from "@quizzy/shared";
import type { Finding } from "./checks";
import { isKeyedYesNo, type Example, type ExampleSet } from "./examples";
import { cell, num, pick, ranges, table, type SheetLang } from "./format";
import type { DossierCard, InstalledInstrument } from "./index";
import type { InstrumentNotes } from "./notes";

/**
 * Лист сверки одной методики — markdown на языке листа.
 *
 * Порядок разделов — порядок, в котором психолог сверяет методику с
 * пособием: что это и откуда, какие пункты, как считается каждая шкала, что
 * поднимает тревогу, как это выглядит на ответах, что сверить, чем
 * отличается от первоисточника, что нашёл генератор.
 *
 * Блок «Перевірка психологом» — единственное, что в листе правят руками:
 * генератор переносит его из лежащего листа как есть (REVIEW_BEGIN …
 * REVIEW_END), а всё остальное пересобирает. Отвергнуто: отметки сверки в
 * отдельном файле — их бы не увидели рядом с тем, что сверяли, и лист
 * «проверен» жил бы отдельно от листа, который после этого поменялся.
 */

export const REVIEW_BEGIN = "<!-- review:begin";
export const REVIEW_END = "<!-- review:end -->";

export interface SheetInput {
  inst: InstalledInstrument;
  notes: InstrumentNotes;
  examples: ExampleSet;
  dossier: DossierCard | null;
  findings: Finding[];
  golden: { file: string; name: string } | null;
  /** Блок сверки из лежащего листа; null — новый лист, блок по шаблону */
  review: string | null;
}

/* ─────────────────────────── словарь листа ─────────────────────────── */

export function severityWord(lang: SheetLang, sev: Severity | "moderate" | "severe" | null): string {
  const s = pick(lang);
  switch (sev) {
    case "severe":
      return s("тяжка", "тяжёлая");
    case "moderate":
      return s("помірна", "умеренная");
    case "mild":
      return s("легка", "лёгкая");
    default:
      return s("немає", "нет");
  }
}

/** Поднимает ли полоса тревогу — ровно правило detectBandRisks движка */
export function bandAlarm(scale: Scale, band: ScaleBand): "moderate" | "severe" | null {
  if (scale.kind !== "clinical") return null;
  return band.severity === "moderate" || band.severity === "severe" ? band.severity : null;
}

const choices = (q: Question): Option[] => q.options.filter((o) => o.kind === "option");

/** Как система читает полосу: полуинтервал до следующей или отрезок — спрашиваем сам движок */
export function readingOf(lang: SheetLang, bands: ScaleBand[], band: ScaleBand): string {
  const s = pick(lang);
  const sorted = [...bands].sort((a, b) => a.minScore - b.minScore);
  const next = sorted[sorted.indexOf(band) + 1];
  const halfOpen = !!next && next.minScore > band.maxScore && bandFor(bands, (band.maxScore + next.minScore) / 2) === band;
  return halfOpen
    ? s(
        `від ${num(band.minScore)} включно до ${num(next.minScore)} не включно`,
        `от ${num(band.minScore)} включительно до ${num(next.minScore)} не включительно`,
      )
    : s(
        `від ${num(band.minScore)} до ${num(band.maxScore)} включно`,
        `от ${num(band.minScore)} до ${num(band.maxScore)} включительно`,
      );
}

/** Минимальное число ответов, при котором шкала считается */
export function minAnswered(share: number, asked: number): number {
  for (let a = 0; a <= asked; a++) if (a / asked >= share - 1e-9) return a;
  return asked;
}

type Notation = "yes" | "score" | "position";

/**
 * Как записывать ответы в примерах. «Да/Нет» — списком пунктов с «Так»;
 * иначе — баллом варианта, если он внутри пункта однозначен, а где у двух
 * вариантов одинаковый балл (SBQ-R, CES, ASSIST) — номером варианта.
 */
function notationOf(survey: SurveyFull): Notation {
  const scored = survey.questions.filter((q) => q.type === "single" || q.type === "yesno");
  if (scored.length && scored.every((q) => q.type === "yesno")) return "yes";
  const unique = scored.every((q) => {
    const scores = choices(q).map((o) => o.score);
    return new Set(scores).size === scores.length;
  });
  return unique ? "score" : "position";
}

/* ─────────────────────────── запись ответов и результата ─────────────────────────── */

function answersLine(lang: SheetLang, survey: SurveyFull, answers: Answer[], mode: Notation): string {
  const s = pick(lang);
  const byQ = new Map(answers.map((a) => [a.questionId, a]));
  const chosen = (q: Question) => {
    const id = byQ.get(q.id)?.optionIds?.[0];
    return id ? choices(q).find((o) => o.id === id) : undefined;
  };
  const visible = (q: Question) => isQuestionVisible(q, survey.questions, byQ);
  const hidden: number[] = [];
  const missing: number[] = [];
  survey.questions.forEach((q, i) => {
    if (q.type !== "single" && q.type !== "yesno") return;
    if (chosen(q)) return;
    if (visible(q)) missing.push(i + 1);
    else hidden.push(i + 1);
  });
  const tail = [
    hidden.length ? s(`не задавалися (умова показу): ${ranges(hidden)}`, `не задавались (условие показа): ${ranges(hidden)}`) : "",
    missing.length ? s(`без відповіді: ${ranges(missing)}`, `без ответа: ${ranges(missing)}`) : "",
  ].filter(Boolean);

  if (mode === "yes") {
    const first = survey.questions.find((q) => q.type === "yesno")!;
    const yes = choices(first).find((o) => o.keyCode === "yes")?.text ?? "";
    const no = choices(first).find((o) => o.keyCode === "no")?.text ?? "";
    const yesItems = survey.questions.flatMap((q, i) => (chosen(q)?.keyCode === "yes" ? [i + 1] : []));
    const head = yesItems.length
      ? s(`«${yes}» — ${ranges(yesItems)}; решта — «${no}»`, `«${yes}» — ${ranges(yesItems)}; остальные — «${no}»`)
      : s(`усі — «${no}»`, `все — «${no}»`);
    return [head, ...tail].join("; ");
  }

  const marks = survey.questions.map((q) => {
    if (q.type !== "single" && q.type !== "yesno") return visible(q) ? "т" : "—";
    const o = chosen(q);
    if (!o) return "—";
    return mode === "score" ? num(o.score) : String(choices(q).indexOf(o) + 1);
  });
  const rows: string[] = [];
  for (let i = 0; i < marks.length; i += 10) {
    const to = Math.min(i + 10, marks.length);
    rows.push(`${to - i === 1 ? i + 1 : `${i + 1}–${to}`}: ${marks.slice(i, to).join(" ")}`);
  }
  const line = rows.length === 1 ? `\`${rows[0]}\`` : rows.map((r) => `\`${r}\``).join(" · ");
  return [line, ...tail].join("; ");
}

function valueText(lang: SheetLang, sc: SubmissionEvaluation["profile"]["scores"][number]): string {
  const s = pick(lang);
  if (!sc.normalized) return s("не нормовано — показано сирий бал", "не нормировано — показан сырой балл");
  switch (sc.normalization) {
    case "ratio":
      return s(`частка ${num(sc.value)}`, `доля ${num(sc.value)}`);
    case "tscore":
      return `T ${num(sc.value)}`;
    case "sten":
      return s(`стен ${num(sc.value)}`, `стен ${num(sc.value)}`);
    default:
      return num(sc.value);
  }
}

function scaleResult(
  lang: SheetLang,
  survey: SurveyFull,
  ev: SubmissionEvaluation,
  code: string,
): { raw: string; corrected: string; value: string; band: string; alarm: string; line: string } {
  const s = pick(lang);
  const scale = survey.scales.find((x) => x.code === code)!;
  const sc = ev.profile.scores.find((x) => x.scaleCode === code);
  if (!sc) {
    const none = s("не обчислено", "не вычислено");
    return { raw: none, corrected: "", value: "", band: "", alarm: "", line: `${code}: ${none}` };
  }
  const risk = ev.risk.bands.find((b) => b.scaleId === sc.scaleId);
  const band = sc.band
    ? `«${sc.band.label}» (${severityWord(lang, sc.band.severity)})`
    : scale.bands.length
      ? s("без смуги", "без полосы")
      : s("смуг немає", "полос нет");
  const alarm = risk ? s(`тривога — ${severityWord(lang, risk.severity)}`, `тревога — ${severityWord(lang, risk.severity)}`) : s("без тривоги", "без тревоги");
  const validity =
    sc.validityFailed === undefined
      ? ""
      : sc.validityFailed
        ? s(" · поріг достовірності перевищено", " · порог достоверности превышен")
        : s(" · у межах порогу достовірності", " · в пределах порога достоверности");
  const corrected = scale.corrections.length ? num(sc.correctedScore) : "";
  // сырой балл без поправок и нормирования и есть итог — стрелка «4 → 4» только путала бы
  const plain = sc.normalization === "raw" && !corrected && sc.normalized;
  const line = plain
    ? `${code} = ${num(sc.value)} · ${band} · ${alarm}${validity}`
    : `${code}: ${s("сирий", "сырой")} ${num(sc.rawScore)}` +
      (corrected ? ` → ${s("з поправками", "с поправками")} ${corrected}` : "") +
      ` → ${valueText(lang, sc)} · ${band} · ${alarm}${validity}`;
  return { raw: num(sc.rawScore), corrected, value: valueText(lang, sc), band: band + validity, alarm, line };
}

function summaryLine(lang: SheetLang, survey: SurveyFull, ev: SubmissionEvaluation): string {
  const s = pick(lang);
  const qNumber = new Map(survey.questions.map((q, i) => [q.id, i + 1]));
  const signals = [
    ...ev.risk.answers.map((a) => `п. ${qNumber.get(a.questionId)} «${a.label}» — ${severityWord(lang, a.severity)}`),
    ...ev.risk.bands.map((b) => `«${b.label}» — ${severityWord(lang, b.severity)}`),
  ];
  const risk = ev.risk.severity
    ? s(
        `тривога ${severityWord(lang, ev.risk.severity)} (${signals.join("; ")})`,
        `тревога ${severityWord(lang, ev.risk.severity)} (${signals.join("; ")})`,
      )
    : s("тривог немає", "тревог нет");
  const reliable = ev.profile.reliable ? s("протокол достовірний", "протокол достоверен") : s("**протокол недостовірний**", "**протокол недостоверен**");
  const warnings = ev.profile.warnings.map((w) => renderCoded(w, lang));
  return `${risk} · ${reliable} · ${s("попередження", "предупреждения")}: ${warnings.length ? warnings.join("; ") : s("немає", "нет")}`;
}

function renderExample(lang: SheetLang, survey: SurveyFull, mode: Notation, ex: Example, n: number): string {
  const s = pick(lang);
  const ev = ex.result[lang];
  const out: string[] = [`**${s("П", "П")}${n}.** ${ex.title[lang]}`, ""];
  out.push(`- ${s("Відповіді", "Ответы")}: ${answersLine(lang, survey, ex.answers, mode)}`);
  const single = ex.focus ?? (survey.scales.length === 1 ? survey.scales[0]!.code : null);
  if (!survey.scales.length || !survey.scoringEnabled) {
    out.push(`- ${s("Результат", "Результат")}: ${s("підрахунок вимкнено", "подсчёт выключен")}`);
  } else if (single) {
    out.push(`- ${s("Результат", "Результат")}: ${scaleResult(lang, survey, ev, single).line}`);
  } else {
    const withCorr = survey.scales.some((x) => x.corrections.length);
    const head = [
      s("Шкала", "Шкала"),
      s("Сирий", "Сырой"),
      ...(withCorr ? [s("З поправками", "С поправками")] : []),
      s("Значення", "Значение"),
      s("Смуга", "Полоса"),
      s("Тривога", "Тревога"),
    ];
    const rows = survey.scales.map((scale) => {
      const r = scaleResult(lang, survey, ev, scale.code);
      return [scale.code, r.raw, ...(withCorr ? [r.corrected] : []), r.value, cell(r.band), r.alarm];
    });
    out.push(`- ${s("Результат", "Результат")}:`, "", table(head, rows), "");
  }
  out.push(`- ${s("Підсумок", "Итог")}: ${summaryLine(lang, survey, ev)}`);
  if (ex.expect) {
    const checks = ex.expect.map(({ code, value }) => {
      const got = ev.profile.scores.find((x) => x.scaleCode === code);
      const ok = got && Math.abs(got.value - value) < 1e-6;
      return `${code} = ${num(value)} → ${s("система", "система")}: ${got ? num(got.value) : s("не обчислено", "не вычислено")} ${ok ? "✓" : "✗"}`;
    });
    out.push(`- ${s("Очікується за досьє", "Ожидается по досье")}: ${checks.join("; ")}`);
  }
  return out.join("\n");
}

/* ─────────────────────────── разделы листа ─────────────────────────── */

function defaultReview(lang: SheetLang): string {
  const s = pick(lang);
  return [
    `${REVIEW_BEGIN} — ${s("блок заповнює психолог; генератор його не перезаписує", "блок заполняет психолог; генератор его не перезаписывает")} -->`,
    table(
      [
        s("Хто перевірив (ПІБ, посада)", "Кто проверил (ФИО, должность)"),
        s("Дата", "Дата"),
        s("Висновок (звірено / є розбіжності)", "Вывод (сверено / есть расхождения)"),
        s("Зауваження", "Замечания"),
      ],
      [["", "", "", ""]],
    ),
    "",
    `- [ ] ${s("Пункти, їх порядок і варіанти відповідей збігаються з бланком (розділ 3)", "Пункты, их порядок и варианты ответов совпадают с бланком (раздел 3)")}`,
    `- [ ] ${s("Ключ кожної шкали й обернені пункти (розділ 4)", "Ключ каждой шкалы и обратные пункты (раздел 4)")}`,
    `- [ ] ${s("Формула підсумку, нормування й норми (розділ 4)", "Формула итога, нормирование и нормы (раздел 4)")}`,
    `- [ ] ${s("Межі смуг і їх підписи (розділ 4)", "Границы полос и их подписи (раздел 4)")}`,
    `- [ ] ${s("Які відповіді й смуги піднімають тривогу та з якою тяжкістю (розділ 5)", "Какие ответы и полосы поднимают тревогу и с какой тяжестью (раздел 5)")}`,
    `- [ ] ${s("Кілька прикладів (розділ 6) перераховано вручну за посібником", "Несколько примеров (раздел 6) пересчитаны вручную по пособию")}`,
    `- [ ] ${s("Відомі відмінності від першоджерела прийнятні (розділ 8)", "Известные отличия от первоисточника приемлемы (раздел 8)")}`,
    `- [ ] ${s("Зауваження (розділ 9) розглянуто", "Замечания (раздел 9) рассмотрены")}`,
    REVIEW_END,
  ].join("\n");
}

function passport(lang: SheetLang, input: SheetInput): string {
  const s = pick(lang);
  const { inst, golden, dossier } = input;
  const sv = inst.uk;
  const required = sv.questions.filter((q) => q.required).length;
  const rows: [string, string][] = [
    [s("Код у системі", "Код в системе"), `\`${inst.entry.key}\``],
    [s("Визначення", "Определение"), `\`apps/api/src/instruments/${inst.entry.module}\``],
    [
      s("Як ставиться", "Как ставится"),
      inst.entry.catalog
        ? s(
            `установник загального каталогу (\`installCatalog\`), ключ каталогу \`${inst.entry.key}\``,
            `установщик общего каталога (\`installCatalog\`), ключ каталога \`${inst.entry.key}\``,
          )
        : s(
            "лише демонстраційний посів `apps/api/src/seed.ts`; в установнику каталогу її немає",
            "только демонстрационный посев `apps/api/src/seed.ts`; в установщике каталога её нет",
          ),
    ],
    [
      s("Хто заповнює", "Кто заполняет"),
      sv.administration === "clinician" ? s("фахівець", "специалист") : s("обстежуваний сам", "обследуемый сам"),
    ],
    [
      s("Доступ", "Доступ"),
      sv.visibility === "public"
        ? s("видима всім; самозвіт можна пройти без призначення", "видна всем; самоотчёт можно пройти без назначения")
        : s("лише за персональним призначенням", "только по персональному назначению"),
    ],
    [
      s("Результат обстежуваному", "Результат обследуемому"),
      sv.showResultsToPatient ? s("показується", "показывается") : s("не показується", "не показывается"),
    ],
    [
      s("Підрахунок", "Подсчёт"),
      sv.scoringEnabled
        ? s("увімкнено", "включён")
        : s("вимкнено (критичні відповіді перевіряються все одно)", "выключен (критические ответы проверяются всё равно)"),
    ],
    [s("Повторне проходження", "Повторное прохождение"), sv.allowRetake ? s("дозволено", "разрешено") : s("ні", "нет")],
    [
      s("Ліміт часу", "Лимит времени"),
      sv.timeLimitSec ? s(`${Math.round(sv.timeLimitSec / 60)} хв`, `${Math.round(sv.timeLimitSec / 60)} мин`) : s("немає", "нет"),
    ],
    [
      s("Ескалація неопрацьованої тривоги", "Эскалация неразобранной тревоги"),
      sv.alertEscalateMinutes ? s(`через ${sv.alertEscalateMinutes} хв`, `через ${sv.alertEscalateMinutes} мин`) : s("не задано", "не задана"),
    ],
    [s("Пунктів", "Пунктов"), s(`${sv.questions.length} (обов’язкових — ${required})`, `${sv.questions.length} (обязательных — ${required})`)],
    [s("Шкали", "Шкалы"), sv.scales.map((x) => `\`${x.code}\``).join(", ") || s("немає", "нет")],
    [
      s("Еталонний тест", "Эталонный тест"),
      golden
        ? s(
            `є: \`apps/api/src/instruments/__tests__/${golden.file}\`, «золотой протокол: ${golden.name}»`,
            `есть: \`apps/api/src/instruments/__tests__/${golden.file}\`, «золотой протокол: ${golden.name}»`,
          )
        : s("немає", "нет"),
    ],
    [
      s("Досьє першоджерела", "Досье первоисточника"),
      dossier ? s(`\`${dossier.file}\`, картка \`${dossier.key}\``, `\`${dossier.file}\`, карточка \`${dossier.key}\``) : s("немає", "нет"),
    ],
  ];
  return table([s("Поле", "Поле"), s("Значення", "Значение")], rows.map(([a, b]) => [a, cell(b)]));
}

function sourceSection(lang: SheetLang, input: SheetInput): string {
  const s = pick(lang);
  const { inst, notes, dossier } = input;
  const out: string[] = [];
  if (inst.entry.source) {
    out.push(
      `- ${s("**Записано в системі** (журнал установки каталогу, мовою запису)", "**Записано в системе** (журнал установки каталога, на языке записи)")}: ${inst.entry.source}`,
    );
  } else {
    out.push(`- **${s("Джерело в системі не вказано.", "Источник в системе не указан.")}**`);
  }
  if (notes.passportSource) {
    out.push(`- ${s("**Коментар визначення й паспорт методик**", "**Комментарий определения и паспорт методик**")}: ${notes.passportSource[lang]}`);
  }
  if (dossier) {
    const lang2 = s("мовою досьє", "на языке досье");
    if (dossier.citation) out.push(`- ${s("**Публікація за досьє**", "**Публикация по досье**")}: ${dossier.citation}`);
    const bandsSource = dossier.bands_source || dossier.bands_note;
    if (bandsSource) out.push(`- ${s("**Смуги за досьє**", "**Полосы по досье**")} (${lang2}): ${cell(bandsSource)}`);
    if (dossier.license?.verdict) {
      out.push(
        `- ${s("**Ліцензія за досьє**", "**Лицензия по досье**")}: ${dossier.license.verdict}${dossier.license.conditions ? ` — ${cell(dossier.license.conditions)}` : ""}`,
      );
    }
    if (dossier.verdict) out.push(`- ${s("**Рішення досьє**", "**Решение досье**")} (${lang2}): ${dossier.verdict}`);
  }
  return out.join("\n");
}

function questionScales(lang: SheetLang, survey: SurveyFull, q: Question): string {
  const parts: string[] = [];
  for (const scale of survey.scales) {
    const item = scale.items.find((i) => i.questionId === q.id);
    if (!item) continue;
    let text = scale.code;
    if (item.matchKey !== null) {
      const o = choices(q).find((x) => x.keyCode === item.matchKey);
      text += ` («${o?.text ?? item.matchKey}»)`;
    }
    if (item.weight !== 1) text += ` ×${num(item.weight)}`;
    parts.push(text);
  }
  return parts.join(", ") || (lang === "uk" ? "—" : "—");
}

function logicText(lang: SheetLang, survey: SurveyFull, q: Question): string {
  const s = pick(lang);
  const number = new Map(survey.questions.map((x, i) => [x.id, i + 1]));
  const ops: Record<string, string> = { gte: "≥", gt: ">", lte: "≤", lt: "<", eq: "=", neq: "≠" };
  return (q.logic ?? [])
    .map((r) => {
      const n = number.get(r.sourceQuestionId);
      const src = survey.questions.find((x) => x.id === r.sourceQuestionId);
      let cond: string;
      if (r.operator === "answered") cond = s(`є відповідь на п. ${n}`, `есть ответ на п. ${n}`);
      else if (r.operator === "not_answered") cond = s(`немає відповіді на п. ${n}`, `нет ответа на п. ${n}`);
      else {
        const opt = src?.options.find((o) => o.id === r.value);
        const value = opt ? `«${opt.text}»` : typeof r.value === "number" ? num(r.value) : String(r.value);
        const op = r.operator === "contains" ? s("містить", "содержит") : (ops[r.operator] ?? r.operator);
        cond = s(`бал п. ${n} ${op} ${value}`, `балл п. ${n} ${op} ${value}`);
      }
      return r.action === "show" ? s(`якщо ${cond}`, `если ${cond}`) : s(`приховати, якщо ${cond}`, `скрыть, если ${cond}`);
    })
    .join(s(" і ", " и "));
}

function optionsText(q: Question, mode: Notation): string {
  return choices(q)
    .map((o, i) => (mode === "position" ? `${i + 1}) ${o.text} — ${num(o.score)}` : `${o.text} — ${num(o.score)}`))
    .join("; ");
}

function itemsSection(lang: SheetLang, input: SheetInput, survey: SurveyFull, mode: Notation): string {
  const s = pick(lang);
  const keyed = isKeyedYesNo(survey);
  const scored = survey.questions.filter((q) => q.type === "single" || q.type === "yesno");
  const signature = (q: Question) => choices(q).map((o) => `${o.text}\u0000${o.score}`).join("\u0001");
  const common = scored.length > 1 && scored.every((q) => signature(q) === signature(scored[0]!)) ? scored[0]! : null;
  const notScored = new Map((input.inst.entry.notScored?.items ?? []).map((n) => [n, input.inst.entry.notScored!.reason]));
  const out: string[] = [];

  if (keyed && common) {
    const opts = choices(common).map((o) => `«${o.text}»`).join(" / ");
    out.push(
      s(
        `Варіанти відповіді однакові для всіх пунктів: ${opts}. Бал варіанта не використовується: у шкалу йде збіг відповіді з ключем шкали (стовпчик «Шкали»: у дужках — відповідь, за яку нараховується бал).`,
        `Варианты ответа одинаковы для всех пунктов: ${opts}. Балл варианта не используется: в шкалу идёт совпадение ответа с ключом шкалы (столбец «Шкалы»: в скобках — ответ, за который начисляется балл).`,
      ),
    );
  } else if (common) {
    out.push(
      s(
        `Варіанти відповіді однакові для всіх пунктів (текст — бал): ${optionsText(common, mode)}.`,
        `Варианты ответа одинаковы для всех пунктов (текст — балл): ${optionsText(common, mode)}.`,
      ),
    );
  } else {
    out.push(
      s(
        `Варіанти відповіді в кожного пункту свої (текст — бал${mode === "position" ? "; номер варіанта використовується в прикладах" : ""}).`,
        `Варианты ответа у каждого пункта свои (текст — балл${mode === "position" ? "; номер варианта используется в примерах" : ""}).`,
      ),
    );
  }
  out.push(
    "",
    s(
      "Обернений пункт рахується як «мінімум + максимум − бал варіанта» у межах балів цього пункту.",
      "Обратный пункт считается как «минимум + максимум − балл варианта» в пределах баллов этого пункта.",
    ),
    "",
  );

  const head = [
    "№",
    s("Пункт", "Пункт"),
    ...(common ? [] : [s("Варіанти (бал)", "Варианты (балл)")]),
    s("Обернений", "Обратный"),
    s("Шкали", "Шкалы"),
    s("Ризик", "Риск"),
    s("Показ", "Показ"),
  ];
  const rows = survey.questions.map((q, i) => {
    const n = i + 1;
    let text = q.title;
    if (q.help) text += ` _${s("Підказка", "Подсказка")}: ${q.help}_`;
    if (!q.required) text += ` _(${s("необов’язковий", "необязательный")})_`;
    if (q.type === "text" || q.type === "longtext") text += ` _(${s("вільний текст, у підрахунок не йде", "свободный текст, в подсчёт не идёт")})_`;
    const risk = choices(q)
      .filter((o) => o.riskFlag)
      .map((o) => `«${o.text}» — ${severityWord(lang, o.riskSeverity ?? "severe")}`)
      .join("; ");
    const thr =
      q.riskThreshold !== null && q.riskThreshold !== undefined
        ? s(`число ≥ ${num(q.riskThreshold)} — ${severityWord(lang, q.riskSeverity ?? "severe")}`, `число ≥ ${num(q.riskThreshold)} — ${severityWord(lang, q.riskSeverity ?? "severe")}`)
        : "";
    let scales = questionScales(lang, survey, q);
    if (scales === "—" && notScored.has(n)) scales = s("не рахується (так задано методикою)", "не считается (так задано методикой)");
    return [
      String(n),
      cell(text),
      ...(common ? [] : [cell(q.type === "single" || q.type === "yesno" ? optionsText(q, mode) : "")]),
      q.reverseScored ? s("так", "да") : "",
      cell(scales),
      cell([risk, thr].filter(Boolean).join("; ")),
      cell(logicText(lang, survey, q)),
    ];
  });
  out.push(table(head, rows));
  if (input.inst.entry.notScored) {
    out.push(
      "",
      s(
        `Пункти ${ranges(input.inst.entry.notScored.items)} методика прямо виключає з балів: ${input.inst.entry.notScored.reason}.`,
        `Пункты ${ranges(input.inst.entry.notScored.items)} методика прямо исключает из баллов: ${input.inst.entry.notScored.reason}.`,
      ),
    );
  }
  return out.join("\n");
}

/** Диапазон собственного сырого балла шкалы по вариантам её пунктов */
function rawRange(survey: SurveyFull, scale: Scale): [number, number] | null {
  const byId = new Map(survey.questions.map((q) => [q.id, q]));
  let lo = 0;
  let hi = 0;
  let n = 0;
  for (const item of scale.items) {
    const q = byId.get(item.questionId);
    if (!q || (q.type !== "single" && q.type !== "yesno")) continue;
    const values = choices(q).map((o) => itemContribution(q, item, { questionId: q.id, optionIds: [o.id] }) ?? 0);
    if (scale.aggregation === "count") {
      lo += values.every((v) => v > 0) ? 1 : 0;
      hi += values.some((v) => v > 0) ? 1 : 0;
    } else {
      // пункт, скрываемый условием, может не дать ничего — сумма от нуля
      lo += q.logic?.length ? Math.min(0, ...values) : Math.min(...values);
      hi += Math.max(...values);
    }
    n++;
  }
  if (!n) return null;
  if (scale.aggregation === "average") return [lo / n, hi / n];
  return [lo, hi];
}

function scaleSection(lang: SheetLang, survey: SurveyFull, scale: Scale): string {
  const s = pick(lang);
  const number = new Map(survey.questions.map((q, i) => [q.id, i + 1]));
  const byId = new Map(survey.questions.map((q) => [q.id, q]));
  const out: string[] = [`### ${scale.code} — ${scale.title}`, ""];
  const bullets: string[] = [];

  bullets.push(
    `**${s("Тип", "Тип")}:** ${
      scale.kind === "validity"
        ? s("шкала достовірності — говорить про якість бланка, а не про стан людини; тривоги не піднімає", "шкала достоверности — говорит о качестве бланка, а не о состоянии человека; тревогу не поднимает")
        : s("клінічна (змістова)", "клиническая (содержательная)")
    }`,
  );

  // ключ
  const items = scale.items.map((i) => ({ i, n: number.get(i.questionId)!, q: byId.get(i.questionId)! }));
  if (!items.length) {
    bullets.push(`**${s("Ключ", "Ключ")}:** ${s("власних пунктів немає — значення складається з поправок (нижче)", "собственных пунктов нет — значение складывается из поправок (ниже)")}`);
  } else if (items.some((x) => x.i.matchKey !== null)) {
    const groups = new Map<string, number[]>();
    for (const x of items) {
      const o = choices(x.q).find((c) => c.keyCode === x.i.matchKey);
      const label = o?.text ?? String(x.i.matchKey);
      groups.set(label, [...(groups.get(label) ?? []), x.n]);
    }
    const parts = [...groups].map(([label, ns]) => s(`за відповідь «${label}» — пункти ${ranges(ns)} (${ns.length})`, `за ответ «${label}» — пункты ${ranges(ns)} (${ns.length})`));
    const weights = [...new Set(items.map((x) => x.i.weight))];
    const w = weights.length === 1 ? num(weights[0]!) : s("різний (див. таблицю пунктів)", "разный (см. таблицу пунктов)");
    bullets.push(`**${s("Ключ", "Ключ")}:** ${s(`бал ${w}`, `балл ${w}`)} ${parts.join("; ")}; ${s(`усього ${items.length} пунктів`, `всего ${items.length} пунктов`)}`);
  } else {
    const heavy = items.filter((x) => x.i.weight !== 1).map((x) => `${x.n} ×${num(x.i.weight)}`);
    bullets.push(
      `**${s("Ключ", "Ключ")}:** ${s(`пункти ${ranges(items.map((x) => x.n))} (${items.length}), бал обраного варіанта`, `пункты ${ranges(items.map((x) => x.n))} (${items.length}), балл выбранного варианта`)}${heavy.length ? s(`; вага: ${heavy.join(", ")}`, `; вес: ${heavy.join(", ")}`) : ""}`,
    );
  }
  const reversed = items.filter((x) => x.q.reverseScored).map((x) => x.n);
  if (items.length && items.every((x) => x.i.matchKey === null)) {
    bullets.push(`**${s("Обернені пункти", "Обратные пункты")}:** ${reversed.length ? ranges(reversed) : s("немає", "нет")}`);
  }

  const agg =
    scale.aggregation === "average"
      ? s("середнє внесків пунктів, на які є відповідь (сума ÷ кількість відповідей)", "среднее вкладов пунктов, на которые есть ответ (сумма ÷ количество ответов)")
      : scale.aggregation === "count"
        ? s("кількість пунктів із ненульовим внеском", "количество пунктов с ненулевым вкладом")
        : s("сума внесків пунктів", "сумма вкладов пунктов");
  bullets.push(`**${s("Сирий бал", "Сырой балл")}:** ${agg}; ${s("округлення до 0,001", "округление до 0,001")}`);

  if (scale.corrections.length) {
    const parts = scale.corrections.map((c) => s(`+ ${num(c.coefficient)} × сирий бал ${c.sourceScaleCode}`, `+ ${num(c.coefficient)} × сырой балл ${c.sourceScaleCode}`));
    bullets.push(
      `**${s("Поправки", "Поправки")}:** ${s("до сирого балу", "к сырому баллу")} ${parts.join(" ")}. ${s(
        "Поправки рахуються від сирих балів джерел після підрахунку всіх шкал і до нормування; якщо джерело не обчислено, шкала теж не обчислюється.",
        "Поправки считаются от сырых баллов источников после подсчёта всех шкал и до нормирования; если источник не вычислен, шкала тоже не вычисляется.",
      )}`,
    );
  }

  let normText = "";
  switch (scale.normalization) {
    case "ratio": {
      const denom = scale.ratioDenominator;
      normText = denom
        ? s(`частка: бал ÷ ${num(denom)}, округлення до 0,001`, `доля: балл ÷ ${num(denom)}, округление до 0,001`)
        : s("частка: бал ÷ максимум шкали, округлення до 0,001", "доля: балл ÷ максимум шкалы, округление до 0,001");
      break;
    }
    case "tscore":
      normText = s(
        "T-бал: T = 50 + 10 × (бал − M) ÷ SD, округлення до 0,1. M і SD — за статтю й віком обстежуваного (спершу норма для його статі, потім загальна). Немає норми — T не обчислюється, смуга не призначається, у попередженнях — причина.",
        "T-балл: T = 50 + 10 × (балл − M) ÷ SD, округление до 0,1. M и SD — по полу и возрасту обследуемого (сначала норма для его пола, потом общая). Нет нормы — T не вычисляется, полоса не назначается, в предупреждениях — причина.",
      );
      break;
    case "sten":
      normText = s(
        "стен за таблицею нижче: сирий бал (з поправками) → стен, рядок — за статтю й віком. Бал поза таблицею — стен не обчислюється, смуга не призначається.",
        "стен по таблице ниже: сырой балл (с поправками) → стен, строка — по полу и возрасту. Балл вне таблицы — стен не вычисляется, полоса не назначается.",
      );
      break;
    default:
      normText = s(
        scale.corrections.length ? "немає: підсумок — сирий бал із поправками" : "немає: підсумок — сирий бал",
        scale.corrections.length ? "нет: итог — сырой балл с поправками" : "нет: итог — сырой балл",
      );
  }
  bullets.push(`**${s("Нормування", "Нормирование")}:** ${normText}`);

  const range = rawRange(survey, scale);
  if (range) {
    bullets.push(`**${s("Діапазон сирого балу", "Диапазон сырого балла")}:** ${s(`від ${num(range[0])} до ${num(range[1])}`, `от ${num(range[0])} до ${num(range[1])}`)}`);
  }

  const share = scale.minAnsweredShare ?? DEFAULT_MIN_ANSWERED_SHARE;
  const own = scale.minAnsweredShare !== null && scale.minAnsweredShare !== undefined;
  if (items.length) {
    const a = minAnswered(share, items.length);
    bullets.push(
      `**${s("Мінімальна частка відповідей", "Минимальная доля ответов")}:** ${num(share)} (${own ? s("власне правило шкали", "собственное правило шкалы") : s("загальне правило системи", "общее правило системы")}) — ${s(
        `щонайменше ${a} з ${items.length} заданих пунктів; менше — шкалу не обчислено (не 0). Пункти, приховані умовою показу, у знаменник не йдуть.`,
        `не меньше ${a} из ${items.length} заданных пунктов; меньше — шкала не вычислена (не 0). Пункты, скрытые условием показа, в знаменатель не идут.`,
      )}`,
    );
  } else {
    bullets.push(
      `**${s("Мінімальна частка відповідей", "Минимальная доля ответов")}:** ${s("не застосовується — шкала обчислюється, якщо обчислено всі джерела поправок", "не применяется — шкала вычисляется, если вычислены все источники поправок")}`,
    );
  }
  if (scale.description) bullets.push(`**${s("Опис у системі", "Описание в системе")}:** ${cell(scale.description)}`);

  out.push(...bullets.map((b) => `- ${b}`), "");

  if (scale.normalization === "tscore" && scale.norms.length) {
    out.push(
      table(
        [s("Стать", "Пол"), s("Вік", "Возраст"), "M", "SD", s("Джерело норми", "Источник нормы")],
        scale.norms.map((n) => [
          n.sex === "male" ? s("чоловіча", "мужской") : n.sex === "female" ? s("жіноча", "женский") : s("будь-яка", "любой"),
          n.ageMin !== null || n.ageMax !== null ? `${n.ageMin ?? ""}–${n.ageMax ?? ""}` : s("будь-який", "любой"),
          num(n.mean),
          num(n.sd),
          cell(n.source ?? s("не вказано", "не указан")),
        ]),
      ),
      "",
    );
  } else if (scale.normalization === "tscore") {
    out.push(s("_Норм немає — T-бал не обчислюється ніколи._", "_Норм нет — T-балл не вычисляется никогда._"), "");
  }
  if (scale.normalization === "sten" && scale.stenTable.length) {
    const withSex = scale.stenTable.some((r) => r.sex !== null || r.ageMin !== null || r.ageMax !== null);
    const rows = [...scale.stenTable]
      .sort((a, b) => a.sten - b.sten)
      .map((r) => [
        num(r.sten),
        r.rawMax >= 999 ? s(`${num(r.rawMin)} і більше`, `${num(r.rawMin)} и больше`) : r.rawMin === r.rawMax ? num(r.rawMin) : `${num(r.rawMin)}–${num(r.rawMax)}`,
        ...(withSex ? [`${r.sex ?? ""} ${r.ageMin ?? ""}–${r.ageMax ?? ""}`.trim()] : []),
      ]);
    out.push(table([s("Стен", "Стен"), s("Сирий бал", "Сырой балл"), ...(withSex ? [s("Стать, вік", "Пол, возраст")] : [])], rows), "");
  }

  if (scale.bands.length) {
    const sorted = [...scale.bands].sort((a, b) => a.minScore - b.minScore);
    out.push(
      table(
        [
          s("Смуга", "Полоса"),
          s("Межі в методиці", "Границы в методике"),
          s("Як читає система", "Как читает система"),
          s("Тяжкість", "Тяжесть"),
          s("Оцінка", "Оценка"),
          s("Тривога", "Тревога"),
          s("Рекомендація, опис", "Рекомендация, описание"),
        ],
        sorted.map((b) => {
          const alarm = bandAlarm(scale, b);
          return [
            cell(`«${b.label}»`),
            `${num(b.minScore)} – ${num(b.maxScore)}`,
            readingOf(lang, scale.bands, b),
            severityWord(lang, b.severity),
            b.grade === null ? "" : num(b.grade),
            scale.kind === "validity"
              ? s("ні (шкала достовірності)", "нет (шкала достоверности)")
              : alarm
                ? s(`так — ${severityWord(lang, alarm)}`, `да — ${severityWord(lang, alarm)}`)
                : s("ні", "нет"),
            cell([b.recommendation, b.description].filter(Boolean).join(" · ")),
          ];
        }),
      ),
      "",
    );
  } else {
    out.push(
      s(
        "_Смуг немає — система показує лише бал, без інтерпретації й без тривоги за балом._",
        "_Полос нет — система показывает только балл, без интерпретации и без тревоги по баллу._",
      ),
      "",
    );
  }

  if (scale.kind === "validity" && scale.validityThreshold !== null) {
    const dir = scale.validityDirection === "below" ? "<" : ">";
    out.push(
      `**${s("Поріг достовірності", "Порог достоверности")}:** ${s(
        `значення ${dir} ${num(scale.validityThreshold)} (в одиницях нормування шкали) — протокол недостовірний.`,
        `значение ${dir} ${num(scale.validityThreshold)} (в единицах нормирования шкалы) — протокол недостоверен.`,
      )}${scale.validityMessage ? ` ${s("Повідомлення", "Сообщение")}: «${cell(scale.validityMessage)}».` : ""} ${s(
        "Протокол позначається недостовірним, але бали й тривоги інших шкал рахуються як завжди: рішення про виключення — за фахівцем. Якщо шкалу достовірності не вдалося обчислити або нормувати (немає норми для статі), протокол теж вважається недостовірним.",
        "Протокол помечается недостоверным, но баллы и тревоги других шкал считаются как обычно: решение об исключении — за специалистом. Если шкалу достоверности не удалось вычислить или нормировать (нет нормы для пола), протокол тоже считается недостоверным.",
      )}`,
      "",
    );
  }
  return out.join("\n");
}

function riskSection(lang: SheetLang, survey: SurveyFull): string {
  const s = pick(lang);
  const out: string[] = [];
  const answerRows: string[][] = [];
  survey.questions.forEach((q, i) => {
    for (const o of choices(q).filter((x) => x.riskFlag)) {
      answerRows.push([
        String(i + 1),
        cell(q.title.length > 90 ? `${q.title.slice(0, 88)}…` : q.title),
        cell(`«${o.text}»`),
        severityWord(lang, o.riskSeverity ?? "severe"),
        cell(o.riskLabel ?? ""),
      ]);
    }
    if (q.riskThreshold !== null && q.riskThreshold !== undefined) {
      answerRows.push([String(i + 1), cell(q.title), `≥ ${num(q.riskThreshold)}`, severityWord(lang, q.riskSeverity ?? "severe"), cell(q.riskLabel ?? "")]);
    }
  });
  const bandRows: string[][] = [];
  for (const scale of survey.scales) {
    for (const b of [...scale.bands].sort((x, y) => x.minScore - y.minScore)) {
      const alarm = bandAlarm(scale, b);
      if (alarm) bandRows.push([scale.code, cell(`«${b.label}»`), readingOf(lang, scale.bands, b), severityWord(lang, alarm)]);
    }
  }
  if (!answerRows.length && !bandRows.length) {
    out.push(
      s(
        "Методика тривог не піднімає: жодна відповідь і жодна смуга не позначені як сигнал ризику.",
        "Методика тревог не поднимает: ни один ответ и ни одна полоса не отмечены как сигнал риска.",
      ),
    );
  }
  if (answerRows.length) {
    out.push(
      `**${s("Критичні відповіді", "Критические ответы")}** — ${s("тривога піднімається одразу, за самою відповіддю, навіть якщо підрахунок вимкнено:", "тревога поднимается сразу, по самому ответу, даже если подсчёт выключен:")}`,
      "",
      table(["№", s("Пункт", "Пункт"), s("Відповідь", "Ответ"), s("Тяжкість", "Тяжесть"), s("Підпис тривоги", "Подпись тревоги")], answerRows),
      "",
    );
  } else {
    out.push(s("Критичних відповідей немає.", "Критических ответов нет."), "");
  }
  if (bandRows.length) {
    out.push(
      `**${s("Смуги, що піднімають тривогу", "Полосы, поднимающие тревогу")}** — ${s("лише клінічних шкал і лише за нормованим значенням:", "только клинических шкал и только по нормированному значению:")}`,
      "",
      table([s("Шкала", "Шкала"), s("Смуга", "Полоса"), s("Як читає система", "Как читает система"), s("Тяжкість", "Тяжесть")], bandRows),
      "",
    );
  } else {
    out.push(s("Жодна смуга тривоги не піднімає.", "Ни одна полоса тревогу не поднимает."), "");
  }
  out.push(
    s(
      "Підсумкова тяжкість проходження — найгірша з усіх сигналів. Тривоги за пунктами, прихованими умовою показу, не піднімаються. Недостовірний протокол тривог не скасовує.",
      "Итоговая тяжесть прохождения — худшая из всех сигналов. Тревоги по пунктам, скрытым условием показа, не поднимаются. Недостоверный протокол тревог не отменяет.",
    ),
  );
  if (survey.alertEscalateMinutes) {
    out.push(
      "",
      s(
        `Неопрацьована тривога вважається простроченою через ${survey.alertEscalateMinutes} хв.`,
        `Неразобранная тревога считается просроченной через ${survey.alertEscalateMinutes} мин.`,
      ),
    );
  }
  return out.join("\n");
}

function examplesSection(lang: SheetLang, survey: SurveyFull, examples: ExampleSet, mode: Notation): string {
  const s = pick(lang);
  const legend =
    mode === "yes"
      ? s(
          "Відповіді записано переліком пунктів зі ствердною відповіддю (її назва — у рядку прикладу); на решту дано заперечну.",
          "Ответы записаны перечнем пунктов с утвердительным ответом (его название — в строке примера); на остальные дан отрицательный.",
        )
      : mode === "score"
        ? s(
            "Відповіді записано балом обраного варіанта — як на бланку, до обернення, — по десять пунктів у рядку; «—» — пункт не задавався або лишився без відповіді, «т» — вільний текст.",
            "Ответы записаны баллом выбранного варианта — как на бланке, до обращения, — по десять пунктов в строке; «—» — пункт не задавался или остался без ответа, «т» — свободный текст.",
          )
        : s(
            "Відповіді записано номером обраного варіанта (номери — у розділі 3), по десять пунктів у рядку; «—» — пункт не задавався або лишився без відповіді, «т» — вільний текст.",
            "Ответы записаны номером выбранного варианта (номера — в разделе 3), по десять пунктов в строке; «—» — пункт не задавался или остался без ответа, «т» — свободный текст.",
          );
  const intro = [
    s(
      "Кожен результат нижче порахував рушій підрахунку системи (`evaluateSubmission` — той самий, що при здачі на сервері й без мережі на пристрої) під час генерації листа. Підібрано: крайні відповіді; для кожної шкали — найменше й найбільше значення та обидва боки кожної межі смуг (найближчі досяжні значення); поріг достовірності; кожен критичний варіант; пропуски біля мінімальної частки відповідей; для норм за статтю — кожна стать і невказана стать; перевірні приклади досьє. Відповіді, що не стосуються шкали прикладу, — «найтихіші»: без тривоги й із найменшим внеском, насамперед у шкали достовірності.",
      "Каждый результат ниже посчитал движок подсчёта системы (`evaluateSubmission` — тот же, что при сдаче на сервере и без сети на устройстве) во время генерации листа. Подобраны: крайние ответы; для каждой шкалы — наименьшее и наибольшее значение и обе стороны каждой границы полос (ближайшие достижимые значения); порог достоверности; каждый критический вариант; пропуски у минимальной доли ответов; для норм по полу — каждый пол и неуказанный пол; проверочные примеры досье. Ответы, не относящиеся к шкале примера, — «самые тихие»: без тревоги и с наименьшим вкладом, прежде всего в шкалы достоверности.",
    ),
    "",
    legend,
    "",
  ];
  const rendered = examples.examples.map((ex, i) => renderExample(lang, survey, mode, ex, i + 1));
  return [...intro, rendered.join("\n\n")].join("\n");
}

function verifySection(lang: SheetLang, input: SheetInput, survey: SurveyFull): string {
  const s = pick(lang);
  const out: string[] = [];
  const n = survey.questions.length;
  const dupes = survey.questions.flatMap((q, i) => {
    const scores = choices(q).map((o) => o.score);
    return new Set(scores).size < scores.length && q.type !== "yesno" ? [i + 1] : [];
  });
  out.push(
    s(
      `Текст і порядок пунктів 1–${n}; варіанти відповідей і їх бали (розділ 3)${dupes.length ? `; однаковий бал у кількох варіантів — пункти ${ranges(dupes)}` : ""}.`,
      `Текст и порядок пунктов 1–${n}; варианты ответов и их баллы (раздел 3)${dupes.length ? `; одинаковый балл у нескольких вариантов — пункты ${ranges(dupes)}` : ""}.`,
    ),
  );
  const reversed = survey.questions.flatMap((q, i) => (q.reverseScored ? [i + 1] : []));
  out.push(s(`Обернені пункти: ${reversed.length ? ranges(reversed) : "немає"}.`, `Обратные пункты: ${reversed.length ? ranges(reversed) : "нет"}.`));
  for (const scale of survey.scales) {
    const count = scale.items.length;
    const norm =
      scale.normalization === "tscore"
        ? s("T-бали за нормами", "T-баллы по нормам")
        : scale.normalization === "sten"
          ? s("стени за таблицею", "стены по таблице")
          : scale.normalization === "ratio"
            ? s("частка", "доля")
            : s("сирий бал", "сырой балл");
    out.push(
      s(
        `Ключ ${scale.code} (${count} пунктів${scale.corrections.length ? ", з поправками" : ""}) і підсумок: ${scale.aggregation === "average" ? "середнє" : scale.aggregation === "count" ? "кількість" : "сума"}, ${norm}${scale.bands.length ? `, ${scale.bands.length} смуг` : ", смуг немає"}.`,
        `Ключ ${scale.code} (${count} пунктов${scale.corrections.length ? ", с поправками" : ""}) и итог: ${scale.aggregation === "average" ? "среднее" : scale.aggregation === "count" ? "количество" : "сумма"}, ${norm}${scale.bands.length ? `, ${scale.bands.length} полос` : ", полос нет"}.`,
      ),
    );
  }
  if (survey.scales.some((x) => x.bands.length)) {
    out.push(
      s(
        "Межі й підписи смуг; окремо — тяжкість смуг і те, які з них піднімають тривогу: у першоджерелах зазвичай є лише межі й підписи, тяжкість задала система.",
        "Границы и подписи полос; отдельно — тяжесть полос и то, какие из них поднимают тревогу: в первоисточниках обычно есть только границы и подписи, тяжесть задала система.",
      ),
    );
  }
  const riskItems = survey.questions.flatMap((q, i) => (q.options.some((o) => o.riskFlag) ? [i + 1] : []));
  out.push(
    s(
      `Критичні пункти: ${riskItems.length ? ranges(riskItems) : "немає"} — чи є для них підстава в першоджерелі або рішення відділення.`,
      `Критические пункты: ${riskItems.length ? ranges(riskItems) : "нет"} — есть ли для них основание в первоисточнике или решение отделения.`,
    ),
  );
  if (survey.scales.some((x) => x.kind === "validity" && x.validityThreshold !== null)) {
    out.push(s("Поріг достовірності й напрям його порушення.", "Порог достоверности и направление его нарушения."));
  }
  for (const v of input.notes.verify) out.push(v[lang]);
  return out.map((x) => `- ${x}`).join("\n");
}

/* ─────────────────────────── лист целиком ─────────────────────────── */

export function renderSheet(lang: SheetLang, input: SheetInput): string {
  const s = pick(lang);
  const survey = lang === "uk" ? input.inst.uk : input.inst.ru;
  const mode = notationOf(survey);
  const title = t(input.inst.input.title as never, lang);
  const other = lang === "uk" ? "ru" : "uk";
  const out: string[] = [
    `# ${title} — ${s("лист звірки", "лист сверки")}`,
    "",
    `> ${s(
      "Лист згенеровано з визначення методики тим самим шляхом, яким її ставить система: визначення → схема → запис версії в базу → читання версії, як при проходженні. Приклади порахував живий рушій підрахунку. Руками лист не правлять — лише блок «Перевірка психологом»; перегенерація: `bun run --cwd apps/api docs:instruments`. Тест `apps/api/test/instrumentSheets.test.ts` падає, якщо лист розійшовся з тим, що рахує система.",
      "Лист сгенерирован из определения методики тем же путём, каким её ставит система: определение → схема → запись версии в базу → чтение версии, как при прохождении. Примеры посчитал живой движок подсчёта. Руками лист не правят — только блок «Проверка психологом»; перегенерация: `bun run --cwd apps/api docs:instruments`. Тест `apps/api/test/instrumentSheets.test.ts` падает, если лист разошёлся с тем, что считает система.",
    )}`,
    ">",
    `> ${s("[Російська версія]", "[Украинская версия]")}(../${other}/${input.inst.entry.key}.md) · [${s("Зведення всіх методик", "Сводка всех методик")}](../${lang === "uk" ? "README.md" : "README.ru.md"}) · [${s("Як система рахує", "Как система считает")}](scoring-rules.md)`,
    "",
    passport(lang, input),
    "",
    `## ${s("Перевірка психологом", "Проверка психологом")}`,
    "",
    input.review ?? defaultReview(lang),
    "",
    `## 1. ${s("Призначення", "Назначение")}`,
    "",
    survey.description ? cell(survey.description) : s("_Опису в системі немає._", "_Описания в системе нет._"),
    "",
  ];
  if (survey.instructions) out.push(`**${s("Інструкція обстежуваному", "Инструкция обследуемому")}:** ${cell(survey.instructions)}`, "");
  if (survey.safetyPlan) out.push(`**${s("План безпеки", "План безопасности")}:** ${cell(survey.safetyPlan)}`, "");
  out.push(
    `## 2. ${s("Джерело", "Источник")}`,
    "",
    sourceSection(lang, input),
    "",
    `## 3. ${s("Пункти", "Пункты")}`,
    "",
    itemsSection(lang, input, survey, mode),
    "",
    `## 4. ${s("Шкали", "Шкалы")}`,
    "",
  );
  if (!survey.scales.length) out.push(s("_Шкал немає._", "_Шкал нет._"), "");
  for (const scale of survey.scales) out.push(scaleSection(lang, survey, scale));
  out.push(
    `## 5. ${s("Сигнали ризику", "Сигналы риска")}`,
    "",
    riskSection(lang, survey),
    "",
    `## 6. ${s("Приклади «відповіді → результат»", "Примеры «ответы → результат»")}`,
    "",
    examplesSection(lang, survey, input.examples, mode),
    "",
    `## 7. ${s("Що звірити з першоджерелом", "Что сверить с первоисточником")}`,
    "",
    verifySection(lang, input, survey),
    "",
    `## 8. ${s("Відомі відмінності від першоджерела", "Известные отличия от первоисточника")}`,
    "",
    input.notes.differences.length
      ? input.notes.differences.map((d) => `- ${d[lang]}`).join("\n")
      : s("У коді та досьє відмінностей від першоджерела не зафіксовано.", "В коде и досье отличий от первоисточника не зафиксировано."),
    "",
    `## 9. ${s("Зауваження для перевірки", "Замечания для проверки")}`,
    "",
    input.findings.length
      ? input.findings
          .map((f) => `- ${f.text[lang]} _(${f.origin === "auto" ? s("знайшов генератор", "нашёл генератор") : s("записано в коді або паспорті", "записано в коде или паспорте")})_`)
          .join("\n")
      : s("Генератор зауважень не знайшов.", "Генератор замечаний не нашёл."),
    "",
  );
  return out.join("\n");
}
