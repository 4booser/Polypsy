import { formatDuration, type Severity, type UiKey } from "@quizzy/shared";

/**
 * Цвет заливки: метки на графиках, полоски, доли кольца.
 * Рядом с ними нет мелкого текста, и насыщенность важнее контраста с фоном.
 */
export const severityColor: Record<Severity, string> = {
  none: "var(--sev-none)",
  mild: "var(--sev-mild)",
  moderate: "var(--sev-moderate)",
  severe: "var(--sev-severe)",
};

/**
 * Цвет текста той же степени выраженности — другой и зависит от темы.
 *
 * Один цвет на обе задачи не годится: жёлтый #fab219 на белой карточке даёт
 * контраст 1.83 при пороге 4.5. Заливка кружка на графике и слово
 * «умеренная» в таблице — разные вещи.
 */
export const severityTextColor: Record<Severity, string> = {
  none: "var(--sev-none-text)",
  mild: "var(--sev-mild-text)",
  moderate: "var(--sev-moderate-text)",
  severe: "var(--sev-severe-text)",
};

/**
 * Ключи подписей степени выраженности.
 *
 * Сами подписи живут в общем словаре: они видны на каждом экране с
 * результатом и в мобильном приложении тоже, а два словаря однажды
 * разойдутся.
 */
export const severityKey = {
  none: "severity.none",
  mild: "severity.mild",
  moderate: "severity.moderate",
  severe: "severity.severe",
} as const satisfies Record<Severity, UiKey>;

export const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];

/** Длительность — из общего пакета: у мобилки была своя копия, и они бы разошлись */
export const duration = formatDuration;

/**
 * Язык форматирования дат — тот же, на котором написана страница.
 *
 * Берётся из атрибута документа, а не из параметра: иначе язык пришлось бы
 * протаскивать в семьдесят с лишним мест вызова, и хотя бы одно осталось бы
 * с прежним. Атрибут проставляет переключатель языка, и он же — то, что
 * читает браузер и программа чтения с экрана: второго источника истины не
 * появляется.
 */
function locale(): string {
  const lang = typeof document === "undefined" ? "ru" : document.documentElement.lang;
  return lang === "uk" ? "uk-UA" : lang === "en" ? "en-GB" : "ru-RU";
}

/**
 * Разбор даты без сдвига на сутки.
 *
 * `new Date("2026-09-02")` — это полночь UTC, а не полночь здесь. Западнее
 * Гринвича она приходится на первое сентября, и дата прикрепления к
 * отделению отображается днём раньше. Прежний код резал строку и потому был
 * к часовым поясам безразличен; новый обязан быть безразличен осознанно.
 *
 * Строка «YYYY-MM-DD» — это календарный день, а не момент времени, и
 * собирается он полночью по местному. Строка с временем — настоящий момент,
 * и разбирается как есть.
 */
function parse(iso: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!dateOnly) return new Date(iso);
  return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
}

/**
 * Дата и время целиком: «2 вересня 2026, 14:05».
 *
 * Раньше здесь резалась строка ISO — «2026-09-02 14:05». Машинный вид на
 * экране, который читает человек, стоит секунды на каждом взгляде: год
 * впереди мешает, а месяц числом требует счёта.
 */
export function dateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(locale(), {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Короткая дата в строке списка: «2 вер.».
 *
 * Раньше возвращалось «09-02» — обрезанная строка ISO без года и без
 * названия месяца. В хронологии пациента подряд шли «09-02», «08-14»,
 * «07-30», и порядок месяцев приходилось восстанавливать в уме.
 *
 * Год добавляется, когда он не текущий: в карте, которую ведут годами,
 * «14 серп.» без года — это ловушка.
 */
export function day(iso: string): string {
  const d = parse(iso);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(locale(), {
    day: "numeric",
    month: "short",
    ...(thisYear ? {} : { year: "numeric" }),
  });
}

/** День с днём недели: «ср, 2 вересня» — на экране дня важно, будни это или выходной */
export function dayFull(iso: string): string {
  return parse(iso).toLocaleDateString(locale(), {
    weekday: "short",
    day: "numeric",
    month: "long",
  });
}

/** Только часы и минуты: «проходит с 14:05» читается быстрее полной даты */
export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
}
