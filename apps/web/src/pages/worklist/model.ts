import type { UiKey, WorkItem, WorkKind } from "@quizzy/shared";

/**
 * Черга роботи (Polypsy 2.0) без React: почему пункт здесь, группы списка,
 * отбор. Проверяется без браузера (apps/web/test/worklistModel.test.ts).
 */

/**
 * Почему пункт в очереди — одной фразой из фактов сервера.
 *
 * Сервер отдаёт факты, а не строку: подписи принадлежат клиенту с его
 * языком. Части соединяются запятой, а не « · » — точка-разделитель в
 * консоли «Виразної» запрещена (KIT § 2).
 */
export function workWhy(i: WorkItem, ut: (k: never) => string): string {
  const t = (k: string) => ut(k as never);
  switch (i.kind) {
    case "referral":
      return [
        i.title === "created" ? t("work.refNotAccepted") : t("work.refNotDone"),
        i.destination ? t(`dest.${i.destination}`) : null,
        `${i.days ?? 0} ${t("work.daysNoMove")}`,
      ]
        .filter(Boolean)
        .join(", ");
    /*
     * Без названия методики: оно уже стоит пилюлей строки (chipLabel) и
     * заголовком записи, и строка очереди повторяла его трижды. Единица
     * обязательна: «Строк вийшов 3 тому» — это число ни о чём.
     */
    case "assignment":
      return t("home.whyAssignment").replace("{n}", String(i.days ?? 0));
    case "followup":
      return t("home.whyFollowup").replace("{n}", String(i.days ?? 0));
    case "message":
      /* число непрочитанных важнее давности: три письма подряд без ответа — уже другая история */
      return [
        `${t("work.msgUnread")} ${i.signals ?? 1}`,
        (i.days ?? 0) > 0 ? `${t("work.msgWaiting")} ${i.days}` : t("work.msgToday"),
      ].join(", ");
    case "dispensary":
      return `${i.title}: ${t("work.dispOverdue")} ${i.days ?? 0}`;
    case "noshow":
      /* «вдруге поспіль» — інша розмова, ніж «не прийшов один раз» */
      return [
        (i.signals ?? 0) > 1 ? `${t("work.noshowTimes")} ${i.signals}` : t("work.noshowOnce"),
        `${i.days ?? 0} ${t("work.daysAgo")}`,
        i.overdue ? t("work.noshowAfterAlert") : null,
      ]
        .filter(Boolean)
        .join(", ");
  }
}

/*
 * Название вида для пилюли отбора — «что я увижу, если нажму», а не метка
 * строки. Перебор полный: новый вид работы не соберётся без названия.
 */
export const FILTER_KEY: Record<WorkKind, UiKey> = {
  noshow: "work.filterNoshows",
  message: "work.filterMessages",
  dispensary: "work.filterDispensary",
  followup: "work.filterFollowups",
  referral: "work.filterReferrals",
  assignment: "work.filterAssignments",
};

/** Вид отбора: всё, просроченное или один вид работы */
export type WorkView = "" | "overdue" | WorkKind;

export function isWorkView(v: string): v is WorkView {
  return v === "" || v === "overdue" || v in FILTER_KEY;
}

/** Строки вида и поиска: имя, подразделение или описание */
export function shownWork(items: readonly WorkItem[], view: WorkView, q: string, why: (i: WorkItem) => string): WorkItem[] {
  const needle = q.trim().toLowerCase();
  return items.filter((i) => {
    if (view === "overdue" && !i.overdue) return false;
    if (view && view !== "overdue" && i.kind !== view) return false;
    if (!needle) return true;
    return [i.userName, i.unit ?? "", why(i)].some((s) => s.toLowerCase().includes(needle));
  });
}

/**
 * Группы списка: «Прострочено» сверху, потом «Нове й вхідне» — спершу
 * давніше. Внутри просроченного — тоже давнее раньше: дольше всех ждёт тот,
 * кто ждёт дольше всех.
 */
export function workGroups(items: readonly WorkItem[]): { key: "overdue" | "new"; items: WorkItem[] }[] {
  const bySince = (a: WorkItem, b: WorkItem) => Date.parse(a.since) - Date.parse(b.since);
  const over = items.filter((i) => i.overdue).sort(bySince);
  const fresh = items.filter((i) => !i.overdue).sort(bySince);
  return [
    { key: "overdue" as const, items: over },
    { key: "new" as const, items: fresh },
  ].filter((g) => g.items.length > 0);
}

/** Ключ строки: один человек бывает в очереди несколькими пунктами */
export const workKey = (i: Pick<WorkItem, "kind" | "id">) => `${i.kind}-${i.id}`;

/** Соседняя строка для J/K: по кругу не ходим — конец списка значит конец */
export function stepWork(keys: readonly string[], current: string | null, dir: 1 | -1): string | null {
  if (!keys.length) return null;
  const at = current ? keys.indexOf(current) : -1;
  if (at === -1) return keys[dir === 1 ? 0 : keys.length - 1] ?? null;
  return keys[Math.max(0, Math.min(keys.length - 1, at + dir))] ?? null;
}
