import type { Referral, UiKey } from "@quizzy/shared";

/**
 * Реестр направлений (Referrals.tsx): вид из адреса, группы «чекають дії» /
 * «закриті за 30 днів», порядок, ожидание и отбор. Проверяется без браузера
 * (apps/web/test/referralsInvites.test.ts).
 *
 * Подписи значений живут здесь, а не в экране: экран (и карта случая,
 * CaseSummary.tsx) берёт их отсюда через Referrals.tsx, как брал и раньше.
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

/** Срочность ступенью: сортировка по возрастанию — от планового к немедленному */
export const URGENCY_RANK: Record<Referral["urgency"], number> = { routine: 0, urgent: 1, immediate: 2 };

/* ─────────── реестр «Виразної»: виды, группы, порядок, ожидание ─────────── */

/** Вид реестра — пилюли над таблицей. «Відкриті» — виписані и прийняті: то, что ждёт действия */
export type ReferralView = "open" | Referral["status"] | "all";
export const REFERRAL_VIEWS: readonly ReferralView[] = ["open", "created", "accepted", "completed", "declined", "all"];

export function viewFrom(raw: string): ReferralView {
  return (REFERRAL_VIEWS as readonly string[]).includes(raw) ? (raw as ReferralView) : "open";
}

export function isOpen(r: Pick<Referral, "status">): boolean {
  return r.status === "created" || r.status === "accepted";
}

export function inView(r: Pick<Referral, "status">, view: ReferralView): boolean {
  if (view === "all") return true;
  if (view === "open") return isOpen(r);
  return r.status === view;
}

/**
 * Не хватает ли загруженным строкам открытых направлений до числа сервера.
 *
 * Реестр приезжает по дате выписки вперемешку с закрытыми, по сотне, а
 * незакрытое направление — то, ради чего экран существует. Давнее непринятое
 * оказывалось за первой сотней: в «Чекають дії» его не было, хотя пилюля
 * «Відкриті» его считала, а «негайних» и «без відповіді» в шапке выходило
 * меньше, чем есть. Пока открытых загружено меньше, чем насчитал сервер,
 * экран добирает страницы сам (Referrals.tsx).
 */
export function openMissing(
  rows: readonly Pick<Referral, "status">[] | null,
  counts: Record<Referral["status"], number> | undefined,
): boolean {
  if (!rows || !counts) return false;
  return rows.filter(isOpen).length < counts.created + counts.accepted;
}

/** Число в пилюле вида — по числам сервера (ReferralPage.counts), а не по загруженным строкам */
export function viewCount(counts: Record<Referral["status"], number> | undefined, view: ReferralView): number | null {
  if (!counts) return null;
  if (view === "all") return counts.created + counts.accepted + counts.completed + counts.declined;
  if (view === "open") return counts.created + counts.accepted;
  return counts[view];
}

const DAY = 86_400_000;

/** Закрыто (завершено или отклонено) за последние `days` дней — по времени последнего перехода */
export function closedWithin(r: Pick<Referral, "status" | "createdAt" | "updatedAt">, now: number, days = 30): boolean {
  if (isOpen(r)) return false;
  return new Date(r.updatedAt ?? r.createdAt).getTime() >= now - days * DAY;
}

/**
 * Сколько направление ждёт — строка под статусом.
 *
 *  - выписано и не принято: сколько прошло; больше суток — «без відповіді»
 *    (янтарь: просрочено, не риск);
 *  - принято: за сколько приняли (от выписки до перехода);
 *  - закрыто: ничего — день закрытия стоит в «Виписано».
 */
export type Wait =
  | { kind: "issued"; minutes: number }
  | { kind: "late"; minutes: number }
  | { kind: "accepted"; minutes: number }
  | { kind: "none" };

export function waitOf(r: Pick<Referral, "status" | "createdAt" | "updatedAt">, now: number): Wait {
  const issued = new Date(r.createdAt).getTime();
  if (r.status === "created") {
    const minutes = Math.max(0, Math.round((now - issued) / 60_000));
    return minutes >= 24 * 60 ? { kind: "late", minutes } : { kind: "issued", minutes };
  }
  if (r.status === "accepted" && r.updatedAt) {
    return { kind: "accepted", minutes: Math.max(0, Math.round((new Date(r.updatedAt).getTime() - issued) / 60_000)) };
  }
  return { kind: "none" };
}

/** Длительность словами-числами: «40 хв», «3 год», «2 дн.» — единицы приходят из словаря */
export function spanText(minutes: number, unit: { min: string; hour: string; day: string }): string {
  if (minutes < 60) return `${minutes} ${unit.min}`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} ${unit.hour}`;
  return `${Math.round(minutes / (24 * 60))} ${unit.day}`;
}

export type ReferralSort = "urgent" | "newest" | "oldest";

/**
 * Порядок реестра. «Спершу термінові»: открытые выше закрытых, внутри —
 * негайно → терміново → планово, затем свежие сверху. Закрытые идут по дню
 * закрытия: «закриті за 30 днів» читают от последнего.
 */
export function sortReferrals<T extends Pick<Referral, "status" | "urgency" | "createdAt" | "updatedAt" | "id">>(rows: readonly T[], by: ReferralSort): T[] {
  const at = (r: T) => r.createdAt;
  const cmp: Record<ReferralSort, (a: T, b: T) => number> = {
    urgent: (a, b) =>
      Number(isOpen(b)) - Number(isOpen(a)) ||
      (isOpen(a) ? URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] : 0) ||
      (isOpen(a) ? at(b).localeCompare(at(a)) : (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)) ||
      a.id.localeCompare(b.id),
    newest: (a, b) => at(b).localeCompare(at(a)) || a.id.localeCompare(b.id),
    oldest: (a, b) => at(a).localeCompare(at(b)) || a.id.localeCompare(b.id),
  };
  return [...rows].sort(cmp[by]);
}

/** Отбор строки реестра: поиск по пациенту и подставе, «куди», терміновість, кто выписал */
export function matchesReferral(
  r: Pick<Referral, "userName" | "reason" | "destination" | "urgency" | "createdByName">,
  f: { q: string; dest: string; urg: string; by: string },
): boolean {
  const needle = f.q.trim().toLowerCase();
  if (needle && !`${r.userName} ${r.reason ?? ""}`.toLowerCase().includes(needle)) return false;
  if (f.dest && r.destination !== f.dest) return false;
  if (f.urg && r.urgency !== f.urg) return false;
  if (f.by && r.createdByName !== f.by) return false;
  return true;
}
