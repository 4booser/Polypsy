import type { Referral, UiKey } from "@quizzy/shared";

/**
 * Реестр направлений (Referrals.tsx): отбор из адреса и порядок колонок.
 * Проверяется без браузера (apps/web/test/referralsInvites.test.ts).
 *
 * Подписи значений живут здесь, а не в экране: по ним сортируются колонки,
 * и порядок проверяется тестом. Экран (и карта случая, CaseSummary.tsx)
 * берёт их отсюда через Referrals.tsx, как брал и раньше.
 */

export const DESTINATION_KEY = {
  psychiatrist: "dest.psychiatrist",
  inpatient: "dest.inpatient",
  outpatient: "dest.outpatient",
  commander: "dest.commander",
  other: "dest.other",
} as const satisfies Record<Referral["destination"], UiKey>;
export const URGENCY_KEY = {
  routine: "urg.routine",
  urgent: "urg.urgent",
  immediate: "urg.immediate",
} as const satisfies Record<Referral["urgency"], UiKey>;
export const STATUS_KEY = {
  created: "st.created",
  accepted: "st.accepted",
  completed: "st.completed",
  declined: "st.declined",
} as const satisfies Record<Referral["status"], UiKey>;

/**
 * «Показати закриті» — `?all=1`, и только так.
 *
 * Любое другое значение (`all=yes`, `all=true`, пустое) — открытые: реестр
 * открывается на незакрытых, и «незакрытое видно и через месяц» — смысл
 * экрана. Расширять выборку по опечатке в адресе нельзя: закрытые
 * направления заслонили бы открытые.
 */
export function showClosed(raw: string): boolean {
  return raw === "1";
}

/** Значение параметра от переключателя: открытые — умолчание, в адресе их нет */
export function closedParam(on: boolean): string {
  return on ? "1" : "";
}

/** Срочность ступенью: сортировка по возрастанию — от планового к немедленному */
export const URGENCY_RANK: Record<Referral["urgency"], number> = { routine: 0, urgent: 1, immediate: 2 };

/**
 * Статус по ходу направления: выписано → принято → завершено, отклонённые —
 * в конце. По возрастанию сперва идут незакрытые — ради них реестр и открывают.
 */
export const STATUS_RANK: Record<Referral["status"], number> = { created: 0, accepted: 1, completed: 2, declined: 3 };

/**
 * Значения сортировки колонок реестра — то, что получает DataTable (Column.sort).
 *
 * Колонки «Куди», «Терміновість», «Статус» показывают перевод, а
 * сортировались по коду значения. У срочности алфавит кодов давал
 * immediate → routine → urgent: «негайно, планово, терміново» — ни по
 * срочности, ни по алфавиту; у «Куди» порядок кодов расходился с порядком
 * подписей. Человек, нажавший заголовок, видел несортированный столбец.
 *
 * Теперь: у срочности и статуса — свой порядок по смыслу (ступень), а
 * «Куди» — по алфавиту того, что написано в колонке, на языке экрана.
 * Ступень — число, поэтому выгрузке CSV у этих колонок нужна своя подпись
 * (Column.csv в Referrals.tsx): иначе в файл ушёл бы номер ступени.
 */
export function referralSorts(ut: (key: UiKey) => string) {
  return {
    userName: (r: Referral) => r.userName,
    destination: (r: Referral) => ut(DESTINATION_KEY[r.destination]),
    urgency: (r: Referral) => URGENCY_RANK[r.urgency],
    status: (r: Referral) => STATUS_RANK[r.status],
    reason: (r: Referral) => r.reason ?? "",
    createdAt: (r: Referral) => r.createdAt,
  };
}
