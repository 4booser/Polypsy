import { sql } from "drizzle-orm";
import type { db as Db } from "../db";
import { surveyAccess } from "../db/schema";

/** Одна выдача доступа к методике */
export interface Grant {
  surveyId: string;
  userId: string;
  grantedBy: string | null;
  /** Срок действия; null — бессрочно */
  expiresAt: string | null;
  note: string | null;
  /** Сколько раз можно пройти; undefined — не менять, null — не ограничивать */
  attemptsAllowed?: number | null;
}

/**
 * Выдать доступ к методике — и ПЕРЕвыдать, если он уже был.
 *
 * Одна операция на все четыре места, которые назначают методики: ручная
 * выдача, планировщик, каскад по результату скрининга и протокол наблюдения.
 * Раньше каждое писало свою вставку, и три из четырёх заканчивались
 * `onConflictDoNothing` — то есть повторное назначение той же методики тому
 * же человеку не делало ничего.
 *
 * Чем это оборачивалось. Ключ таблицы — пара «методика и человек», поэтому
 * второе назначение молча терялось: срок оставался прошлогодним, и у
 * методики с ограниченной видимостью пациент получал 404. Плановый повторный
 * замер сдать было нельзя, а в консоли при этом висело открытое назначение —
 * выглядело как «пациент не проходит», а не как отказ системы. Протокол
 * наблюдения — «повторить через 7 и 30 дней» — не работал ни разу ни у кого,
 * кому методику когда-либо выдавали раньше.
 *
 * Четвёртое место, ручная выдача, срок обновляло, но не трогало счётчик
 * попыток. А попытки считаются ДВУМЯ способами сразу: `assertAttemptsLeft`
 * считает прохождения после `granted_at`, `consumeAttempt` смотрит на
 * счётчик `attempts_used`. Пока обе точки отсчёта не сдвинуть вместе,
 * назначение выдаётся уже израсходованным: специалист видит выданное, а
 * пациент — «попытки закончились».
 *
 * Поэтому перевыдача сдвигает всё сразу: срок, дату выдачи и счётчик. Новое
 * назначение — это новое разрешение пройти, а не воспоминание о старом.
 */
export async function grantAccess(tx: typeof Db, grants: Grant[]): Promise<void> {
  if (!grants.length) return;
  await tx
    .insert(surveyAccess)
    .values(
      grants.map((g) => ({
        surveyId: g.surveyId,
        userId: g.userId,
        grantedBy: g.grantedBy,
        expiresAt: g.expiresAt,
        note: g.note,
        ...(g.attemptsAllowed === undefined ? {} : { attemptsAllowed: g.attemptsAllowed }),
      })),
    )
    .onConflictDoUpdate({
      target: [surveyAccess.surveyId, surveyAccess.userId],
      set: {
        grantedBy: sql`excluded.granted_by`,
        expiresAt: sql`excluded.expires_at`,
        note: sql`excluded.note`,
        attemptsAllowed: sql`excluded.attempts_allowed`,
        /* обе точки отсчёта попыток сдвигаются вместе — см. докблок выше */
        grantedAt: sql`now()`,
        attemptsUsed: 0,
      },
    });
}
