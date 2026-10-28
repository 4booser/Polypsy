import type { CardTab } from "./types";

/*
 * Вкладки рабочего места пациента и прежние адреса.
 *
 * Пациент жил на двух страницах — «Картка пацієнта» (/patients/:id с
 * вкладками Огляд/Заміри/Графіки/Заключення/Прийоми/Листування/Нотатки/Події)
 * и «Клінічна карта» (/patients/:id/case: Огляд справи/Динаміка/Хронологія).
 * Теперь страница одна, и каждый прежний адрес ведёт туда, где его сведения
 * живут сейчас: закладки, ссылки очереди работы и пересланные коллеге адреса
 * не ломаются. Чистые функции — ради проверки без браузера
 * (apps/web/test/patientCard.test.ts).
 */

export const CARD_TABS: readonly CardTab[] = ["overview", "dynamics", "measures", "records", "referrals", "messages", "timeline"];

/** Вид «Записів»: записи прийому, заключения или всё вместе */
export type RecordKind = "all" | "notes" | "concl";

/** Вкладка по адресу и отбор, который к ней нужно дописать (прежние значения ?tab=) */
export interface TabRoute {
  tab: CardTab;
  /** Параметры, которые прежнее значение ?tab= означало; null — адрес уже нынешний */
  rewrite: Record<string, string> | null;
}

/*
 * Прежние вкладки карточки → нынешние. «Графіки» (dynamics) и «Події»
 * (timeline) сохранили свои значения: «Динаміка» и «Хронологія» на их месте.
 */
const LEGACY: Readonly<Record<string, Record<string, string>>> = {
  conclusions: { tab: "records", kind: "concl" },
  notes: { tab: "records", kind: "notes" },
  /* список приёмов — вид «Прийоми» хронологии */
  visits: { tab: "timeline", kind: "visit" },
};

export function tabRoute(raw: string | null): TabRoute {
  if (!raw) return { tab: "overview", rewrite: null };
  if ((CARD_TABS as readonly string[]).includes(raw)) return { tab: raw as CardTab, rewrite: null };
  const legacy = LEGACY[raw];
  if (legacy) return { tab: legacy.tab as CardTab, rewrite: legacy };
  return { tab: "overview", rewrite: { tab: "" } };
}

/**
 * Адрес рабочего места для прежнего адреса клинической карты:
 * /patients/:id/case → «Огляд», /case/dynamics → «Динаміка»,
 * /case/timeline → «Хронологія»; /summary, /dynamics, /timeline — так же.
 * Хвост прежнего адреса (?…) сохраняется: в нём бывают отборы.
 */
export function workspacePath(userId: string, tab: "" | "dynamics" | "timeline", search = ""): string {
  const params = new URLSearchParams(search);
  if (tab) params.set("tab", tab);
  const q = params.toString();
  return `/patients/${userId}${q ? `?${q}` : ""}`;
}

export function recordKindOf(raw: string | null): RecordKind {
  return raw === "notes" || raw === "concl" ? raw : "all";
}
