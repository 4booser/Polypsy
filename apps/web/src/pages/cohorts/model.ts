import type { CohortCell, CohortPreview, CohortSpec, SampleFilters, Severity, UiKey } from "@quizzy/shared";

/**
 * Чистая часть «Добору людей»: правило отбора ⇄ адрес страницы, проверка
 * набора, метки активных условий, описание словами, строки разбивок,
 * выгрузка CSV и перенос условий в пресет статистики.
 *
 * Вынесено из экрана ради проверки без React и сервера
 * (apps/web/test/cohorts.test.ts). У этих решений есть граничные случаи —
 * пустое поле против отсутствующего, перевёрнутый диапазон, скрытая ячейка
 * в выгрузке, — которые на живом экране воспроизводятся только руками.
 */

type T = (key: UiKey) => string;

/* ─────────── правило ⇄ адрес ─────────── */

/*
 * Решение заказчика 2026-09-26: «адекватные фильтры» — состояние отбора
 * живёт в адресе, чтобы ссылку можно было переслать коллеге или положить в
 * закладки. Имена параметров — короткие и человеческие: адрес читают
 * глазами, когда пересылают, и «?sex=male&age_from=25» понятнее кода.
 *
 * Пишется через replace: каждое нажатие по фильтру не должно добавлять
 * запись в историю — «назад» обязан уводить со страницы, а не отменять
 * условия по одному (тот же довод, что у useUrlState).
 */
const P = {
  sex: "sex",
  ageMin: "age_from",
  ageMax: "age_to",
  unit: "unit",
  locality: "place",
  survey: "survey",
  from: "from",
  to: "to",
  severity: "severity",
  repeated: "repeated",
  risk: "risk",
  scale: "scale",
} as const;

/** Параметры адреса, которые несут правило; прочие (например, открытая сохранённая) не трогаются */
const SPEC_PARAMS: readonly string[] = Object.values(P);

export type ScaleCond = NonNullable<CohortSpec["scales"]>[number];
export const OPERATORS: readonly ScaleCond["op"][] = [">=", "<=", ">", "<"];

/** Ступени выраженности по возрастанию; «не нижче» имеет смысл только у трёх верхних */
export const SEVERITY_ORDER: readonly Severity[] = ["none", "mild", "moderate", "severe"];
export const MIN_SEVERITY: readonly Exclude<Severity, "none">[] = ["mild", "moderate", "severe"];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function intOrNull(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 120 ? n : null;
}

/*
 * Условие по шкале в адресе — «код~оператор~значение». Разделитель — тильда:
 * у кода шкалы бывают точки и подчёркивания, а тильды не бывает ни в одном
 * встроенном ключе. Разбирается справа, чтобы код с тильдой (если однажды
 * появится) не ломал оператор и значение.
 */
function scaleToParam(c: ScaleCond): string {
  return `${c.code}~${c.op}~${c.value}`;
}

function scaleFromParam(raw: string): ScaleCond | null {
  const parts = raw.split("~");
  if (parts.length < 3) return null;
  const value = Number(parts.pop());
  const op = parts.pop() as ScaleCond["op"];
  const code = parts.join("~");
  if (!code || !OPERATORS.includes(op) || !Number.isFinite(value)) return null;
  return { code, op, value };
}

/**
 * Правило из адреса. Мусор в адресе — не ошибка, а отсутствующее условие:
 * пересланная ссылка с опечаткой должна открыть подбор, а не пустой экран.
 */
export function specFromParams(p: URLSearchParams): CohortSpec {
  const spec: CohortSpec = {};
  const sex = p.get(P.sex);
  if (sex === "male" || sex === "female") spec.sex = sex;
  const ageMin = intOrNull(p.get(P.ageMin));
  const ageMax = intOrNull(p.get(P.ageMax));
  if (ageMin !== null) spec.ageMin = ageMin;
  if (ageMax !== null) spec.ageMax = ageMax;
  const units = p.getAll(P.unit).filter((u) => u.trim());
  if (units.length) spec.units = [...new Set(units)];
  const localities = p.getAll(P.locality).filter((u) => u.trim());
  if (localities.length) spec.localities = [...new Set(localities)];
  const survey = p.get(P.survey);
  if (survey) spec.surveyId = survey;
  const from = p.get(P.from);
  const to = p.get(P.to);
  if (from && DAY.test(from)) spec.from = from;
  if (to && DAY.test(to)) spec.to = to;
  const sev = p.get(P.severity);
  if (sev && (MIN_SEVERITY as readonly string[]).includes(sev)) spec.minSeverity = sev as CohortSpec["minSeverity"];
  if (p.get(P.repeated) === "1") spec.repeatedOnly = true;
  if (p.get(P.risk) === "1") spec.riskOnly = true;
  /* условия по шкалам без методики бессмысленны: коды шкал принадлежат ей */
  const scales = spec.surveyId ? p.getAll(P.scale).map(scaleFromParam).filter((c): c is ScaleCond => c !== null) : [];
  if (scales.length) spec.scales = scales;
  return spec;
}

/** Адрес из правила; чужие параметры адреса (не правило) сохраняются */
export function paramsFromSpec(spec: CohortSpec, base?: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  if (base) for (const [k, v] of base) if (!SPEC_PARAMS.includes(k)) out.append(k, v);
  if (spec.sex) out.set(P.sex, spec.sex);
  if (spec.ageMin != null) out.set(P.ageMin, String(spec.ageMin));
  if (spec.ageMax != null) out.set(P.ageMax, String(spec.ageMax));
  for (const u of spec.units ?? []) out.append(P.unit, u);
  for (const l of spec.localities ?? []) out.append(P.locality, l);
  if (spec.surveyId) out.set(P.survey, spec.surveyId);
  if (spec.from) out.set(P.from, spec.from);
  if (spec.to) out.set(P.to, spec.to);
  if (spec.minSeverity) out.set(P.severity, spec.minSeverity);
  if (spec.repeatedOnly) out.set(P.repeated, "1");
  if (spec.riskOnly) out.set(P.risk, "1");
  if (spec.surveyId) for (const c of spec.scales ?? []) out.append(P.scale, scaleToParam(c));
  return out;
}

/**
 * Правило без пустых условий — в том виде, в каком его сохраняют и сравнивают.
 *
 * Пустой список подразделений, null и отсутствующий ключ на сервере значат
 * одно и то же, но в сравнении отличались бы: «те же условия» читались бы
 * как изменённые, и экран предлагал бы пересохранить то, что не менялось.
 */
export function cleanSpec(spec: CohortSpec): CohortSpec {
  return specFromParams(paramsFromSpec(spec));
}

export function sameSpec(a: CohortSpec, b: CohortSpec): boolean {
  return paramsFromSpec(a).toString() === paramsFromSpec(b).toString();
}

export function isEmptySpec(spec: CohortSpec): boolean {
  return paramsFromSpec(spec).toString() === "";
}

/**
 * Что мешает отправить правило — ключи словаря.
 *
 * Перевёрнутый диапазон — ошибка набора, а не пустая когорта: «від 45 до
 * 25» честным нулём читалось бы как «таких людей нет». Сервер откажет тоже,
 * но отказ сервера пришёл бы после запроса и строкой разработчика; здесь
 * поле краснеет сразу, а предпросмотр ждёт исправления.
 */
export function specErrors(spec: CohortSpec): { age?: UiKey; period?: UiKey } {
  const out: { age?: UiKey; period?: UiKey } = {};
  if (spec.ageMin != null && spec.ageMax != null && spec.ageMin > spec.ageMax) out.age = "coh.errAge";
  if (spec.from && spec.to && spec.from > spec.to) out.period = "coh.errPeriod";
  return out;
}

/* ─────────── слова: метки и описание ─────────── */

/** «2026-09-01» → «01.09.2026» — день выборки, без времени и пояса */
export function dayText(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}.${m}.${y}` : iso;
}

export const SEVERITY_LABEL: Record<Severity, UiKey> = {
  none: "severity.none",
  mild: "severity.mild",
  moderate: "severity.moderate",
  severe: "severity.severe",
};

export const OPERATOR_LABEL: Record<ScaleCond["op"], UiKey> = {
  ">=": "coh.opGte",
  "<=": "coh.opLte",
  ">": "coh.opGt",
  "<": "coh.opLt",
};

/** Возраст словами: «25–45», «від 25», «до 45» */
export function ageText(spec: CohortSpec, t: T): string {
  const { ageMin: lo, ageMax: hi } = spec;
  if (lo != null && hi != null) return lo === hi ? `${lo}` : `${lo}–${hi}`;
  if (lo != null) return `${t("coh.fromWord")} ${lo}`;
  if (hi != null) return `${t("coh.ageTo")} ${hi}`;
  return "";
}

/** Период словами: оба конца, один или ни одного */
export function periodText(spec: CohortSpec, t: T): string {
  if (spec.from && spec.to) return `${dayText(spec.from)} – ${dayText(spec.to)}`;
  if (spec.from) return `${t("coh.fromWord")} ${dayText(spec.from)}`;
  if (spec.to) return `${t("coh.ageTo")} ${dayText(spec.to)}`;
  return "";
}

/**
 * Активное условие — метка над результатом с «×». Снятие метки — чистая
 * функция правила, а не обработчик на экране: так её можно проверить, и
 * снятие методики заодно снимает условия по её шкалам (без методики их
 * коды ничего не значат).
 */
export interface ActiveFilter {
  id: string;
  label: string;
  without: (spec: CohortSpec) => CohortSpec;
}

export function activeFilters(
  spec: CohortSpec,
  t: T,
  names: { survey?: (id: string) => string | undefined; scale?: (code: string) => string | undefined } = {},
): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  const drop = (patch: Partial<CohortSpec>) => (s: CohortSpec) => cleanSpec({ ...s, ...patch });
  if (spec.sex) {
    out.push({
      id: "sex",
      label: `${t("person.sex")}: ${t(spec.sex === "male" ? "nm.menCap" : "nm.womenCap")}`,
      without: drop({ sex: null }),
    });
  }
  if (spec.ageMin != null || spec.ageMax != null) {
    out.push({ id: "age", label: `${t("coh.age")}: ${ageText(spec, t)}`, without: drop({ ageMin: null, ageMax: null }) });
  }
  for (const u of spec.units ?? []) {
    out.push({
      id: `unit:${u}`,
      label: `${t("person.unit")}: ${u}`,
      without: (s) => cleanSpec({ ...s, units: (s.units ?? []).filter((x) => x !== u) }),
    });
  }
  for (const l of spec.localities ?? []) {
    out.push({
      id: `place:${l}`,
      label: `${t("st.locality")}: ${l}`,
      without: (s) => cleanSpec({ ...s, localities: (s.localities ?? []).filter((x) => x !== l) }),
    });
  }
  if (spec.surveyId) {
    out.push({
      id: "survey",
      label: `${t("coh.survey")}: ${names.survey?.(spec.surveyId) ?? "…"}`,
      without: drop({ surveyId: null, scales: [] }),
    });
  }
  if (spec.from || spec.to) {
    out.push({ id: "period", label: `${t("coh.period")}: ${periodText(spec, t)}`, without: drop({ from: null, to: null }) });
  }
  if (spec.minSeverity) {
    out.push({
      id: "severity",
      /* «помірна і вище»; у «вираженої» выше ступени нет, и хвост был бы неправдой */
      label: `${t("coh.severity")}: ${t(SEVERITY_LABEL[spec.minSeverity]).toLowerCase()}${
        spec.minSeverity === "severe" ? "" : ` ${t("coh.andAbove")}`
      }`,
      without: drop({ minSeverity: null }),
    });
  }
  (spec.scales ?? []).forEach((c, i) => {
    out.push({
      id: `scale:${i}`,
      label: `${names.scale?.(c.code) ?? c.code} ${c.op.replace(">=", "≥").replace("<=", "≤")} ${c.value}`,
      without: (s) => cleanSpec({ ...s, scales: (s.scales ?? []).filter((_, k) => k !== i) }),
    });
  });
  if (spec.repeatedOnly) out.push({ id: "repeated", label: t("coh.repeated"), without: drop({ repeatedOnly: false }) });
  if (spec.riskOnly) out.push({ id: "risk", label: t("coh.risk"), without: drop({ riskOnly: false }) });
  return out;
}

/** Правило одной строкой — подпись сохранённой вибірки */
export function describeSpec(
  spec: CohortSpec,
  t: T,
  names?: { survey?: (id: string) => string | undefined; scale?: (code: string) => string | undefined },
): string {
  const parts = activeFilters(spec, t, names).map((f) => f.label);
  return parts.length ? parts.join(" · ") : t("coh.everyone");
}

/* ─────────── разбивки ─────────── */

/** Возрастные полосы снимка в порядке возраста — сервер отдаёт их по убыванию числа */
export const AGE_BANDS = ["<25", "25-34", "35-44", "45+"] as const;

/**
 * Ячейки в заданном порядке: известные ключи — по порядку перечня,
 * незнакомые (и «—», «не указано») — в конце, как пришли.
 *
 * Для пола, возраста и выраженности порядок смысловой: «легка» перед
 * «помірною», «до 25» перед «25–34». Сервер сортирует по числу (так нужно
 * подразделениям), и ступени выраженности скакали бы по экрану от запроса
 * к запросу.
 */
export function orderCells(cells: readonly CohortCell[], order: readonly string[]): CohortCell[] {
  const known = order.flatMap((k) => cells.filter((c) => c.key === k));
  const rest = cells.filter((c) => !order.includes(c.key));
  return [...known, ...rest];
}

export interface BarRow {
  key: string;
  count: number | null;
  /** Доля от когорты в процентах; null — ячейка скрыта или когорта не названа */
  share: number | null;
  /** Длина полосы 0…1 от самой длинной показанной; null — полосы нет вовсе */
  width: number | null;
}

/**
 * Строки полосок разбивки.
 *
 * Длина — от самой длинной показанной строки, а не от всей когорты: у
 * разбивки по двадцати подразделениям полосы от целого были бы черточками
 * у левого края. Ноль остаётся на месте, пропорции между строками
 * сохраняются — то же правило, что у осей графиков (charts/scale.ts: верх
 * по данным, а не по теории). Доля при этом печатается от когорты — её и
 * спрашивают.
 *
 * У скрытой ячейки нет ни доли, ни полосы. Длина полосы — тоже число, и
 * полоса «примерно такой длины» выдавала бы то, что сервер спрятал.
 */
export function barRows(cells: readonly CohortCell[], size: number | null): BarRow[] {
  const top = Math.max(0, ...cells.map((c) => c.count ?? 0));
  return cells.map((c) => ({
    key: c.key,
    count: c.count,
    share: c.count === null || !size ? null : Math.round((c.count / size) * 100),
    width: c.count === null ? null : top > 0 ? c.count / top : 0,
  }));
}

/**
 * Разбивки одной таблицей CSV — ровно то, что на экране.
 *
 * Скрытая ячейка выгружается пустой, а не нулём и не прочерком-числом:
 * электронная таблица посчитала бы ноль в сумму, а файл, в отличие от
 * экрана, уходит дальше и читается без подписи «приховано». Колонка
 * «приховано» говорит это словами в самой строке.
 *
 * Разделитель — точка с запятой и BOM впереди: так же выгружают таблицы
 * консоли (tableToCsv), и Excel с украинской локалью открывает файл сразу
 * в колонках.
 */
export function breakdownCsv(
  preview: CohortPreview,
  t: T,
  label: (section: BreakdownKind, key: string) => string,
): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[";\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const head = [t("coh.csvSection"), t("coh.csvValue"), t("coh.csvCount"), t("coh.csvShare"), t("coh.csvHidden")];
  const lines = [head.map(cell).join(";")];
  lines.push([t("coh.size"), "", preview.size ?? "", "", preview.size === null ? t("coh.csvYes") : ""].map(cell).join(";"));
  for (const kind of BREAKDOWNS) {
    for (const row of barRows(breakdownCells(preview, kind), preview.size)) {
      lines.push(
        [
          t(BREAKDOWN_TITLE[kind]),
          label(kind, row.key),
          row.count ?? "",
          row.share ?? "",
          row.count === null ? t("coh.csvYes") : "",
        ]
          .map(cell)
          .join(";"),
      );
    }
  }
  /* BOM — escape-последовательностью: сам знак в исходнике невидим и не покрыт шрифтами (fontCoverage) */
  return `\u{feff}${lines.join("\r\n")}`;
}

export type BreakdownKind = "unit" | "sex" | "severity" | "age" | "locality";
export const BREAKDOWNS: readonly BreakdownKind[] = ["severity", "unit", "sex", "age", "locality"];

export const BREAKDOWN_TITLE: Record<BreakdownKind, UiKey> = {
  unit: "coh.byUnit",
  sex: "coh.bySex",
  severity: "coh.bySeverity",
  age: "coh.byAge",
  locality: "coh.byLocality",
};

/**
 * Подпись ключа разбивки. Из базы приходят значения перечислений —
 * «male», «moderate», «25-34»; показывать их человеку значит показывать
 * устройство таблицы, а не данные. Прочерк сервера — «не указано», у
 * выраженности — «без смуг»: у человека есть прохождения, но ни одна их
 * шкала полос не имеет, и это не «норма».
 */
export function breakdownLabel(kind: BreakdownKind, key: string, t: T): string {
  if (kind === "severity") return key in SEVERITY_LABEL ? t(SEVERITY_LABEL[key as Severity]) : t("coh.noBands");
  if (key === "—") return t("coh.unknown");
  if (kind === "sex") return key === "male" ? t("nm.menCap") : key === "female" ? t("nm.womenCap") : key;
  if (kind === "age") return key === "<25" ? t("coh.ageUnder25") : key.replace("-", "–");
  return key;
}

/** Ячейки разбивки в порядке экрана */
export function breakdownCells(preview: CohortPreview, kind: BreakdownKind): CohortCell[] {
  switch (kind) {
    case "unit":
      return preview.byUnit;
    case "locality":
      return preview.byLocality;
    case "sex":
      return orderCells(preview.bySex, ["male", "female"]);
    case "age":
      return orderCells(preview.byAge, AGE_BANDS);
    case "severity":
      return orderCells(preview.bySeverity, SEVERITY_ORDER);
  }
}

/* ─────────── в статистику ─────────── */

/**
 * Условия подбора → строки-критерии пресета статистики.
 *
 * Пресет знает пол, возраст, один населённый пункт и период — и больше
 * ничего: подразделения, методики, шкал, выраженности, повторного замера
 * и тревог в нём нет (SampleFilters). Методика в статистике задаётся самой
 * моделью, а не выборкой. Непереносимое возвращается списком, и экран
 * называет его ДО создания пресета: молча созданный пресет с половиной
 * условий читался бы как та же выборка, а это другая.
 *
 * Два и больше населённых пунктов — тоже непереносимо: у пресета пункт
 * один. Брать первый значило бы тихо сузить выборку.
 *
 * Возраст считается одинаково — полных лет на момент прохождения, — поэтому
 * переносится как есть.
 */
export function toSampleFilters(spec: CohortSpec): { filters: SampleFilters; dropped: UiKey[] } {
  const filters: SampleFilters = {};
  const dropped: UiKey[] = [];
  if (spec.sex) filters.sex = spec.sex;
  if (spec.ageMin != null) filters.ageMin = spec.ageMin;
  if (spec.ageMax != null) filters.ageMax = spec.ageMax;
  if (spec.from) filters.from = spec.from;
  if (spec.to) filters.to = spec.to;
  const places = spec.localities ?? [];
  if (places.length === 1) filters.locality = places[0]!;
  else if (places.length > 1) dropped.push("st.locality");
  if (spec.units?.length) dropped.push("person.unit");
  if (spec.surveyId) dropped.push("coh.survey");
  if (spec.scales?.length) dropped.push("coh.scaleConds");
  if (spec.minSeverity) dropped.push("coh.severity");
  if (spec.repeatedOnly) dropped.push("coh.repeated");
  if (spec.riskOnly) dropped.push("coh.risk");
  return { filters, dropped };
}
