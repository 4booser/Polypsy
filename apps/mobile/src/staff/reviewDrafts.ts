/**
 * Черновик разбора сигнала — решение и заметка «что вжито», пока лист закрыт.
 *
 * Живёт в памяти приложения, а не на диске: закрыли лист — решение и
 * заметка остаются, открыли снова — на месте (как ящик консоли по Esc).
 *
 * Черновик — того, кто его набирал. Лежал он под одним номером случая, без
 * хозяина, и переживал выход: на общем планшете второй специалист, открыв
 * тот же случай, находил в листе чужое решение и чужую заметку о пациенте —
 * и мог сохранить их под своим именем. Теперь ключ — владелец и случай, а
 * выход и стирание устройства уносят все черновики (offline/logout.ts,
 * api/client.ts).
 *
 * Модуль без react-native — проверяется тестом.
 */

export type ReviewOutcome = "confirmed" | "needs_followup" | "not_confirmed";

export interface ReviewDraft {
  outcome: ReviewOutcome | null;
  note: string;
}

const drafts = new Map<string, ReviewDraft>();

const keyOf = (owner: string, caseId: string) => `${owner}\u0000${caseId}`;

export const reviewDrafts = {
  /** Черновик этого владельца по случаю; без владельца — ничей, и его нет */
  get(owner: string | null | undefined, caseId: string): ReviewDraft | null {
    return owner ? (drafts.get(keyOf(owner, caseId)) ?? null) : null;
  },
  /** Пустой черновик не хранится: «ничего не выбрано» — то же, что его нет */
  set(owner: string | null | undefined, caseId: string, draft: ReviewDraft): void {
    if (!owner) return;
    if (!draft.outcome && !draft.note.trim()) drafts.delete(keyOf(owner, caseId));
    else drafts.set(keyOf(owner, caseId), draft);
  },
  /** Решение сохранено — черновик больше не нужен */
  drop(owner: string | null | undefined, caseId: string): void {
    if (owner) drafts.delete(keyOf(owner, caseId));
  },
  /** Выход или стирание устройства: черновики уходят все — их набирал тот, кто вышел */
  forgetAll(): void {
    drafts.clear();
  },
};
