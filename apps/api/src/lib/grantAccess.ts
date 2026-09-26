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
  /**
   * Назначение пришло через группу пациентов. Не задано — адресное.
   *
   * Перевыдача переписывает эту пометку так же, как срок и попытки, и по той
   * же причине: новое назначение — это новое решение, а не воспоминание о
   * старом. Поэтому адресная выдача поверх групповой СНИМАЕТ пометку, и
   * снимает намеренно — специалист назначил методику лично, и в карте должно
   * стоять именно это. Сохранять старую пометку значило бы вечно отвечать на
   * вопрос «откуда методика» тем, как она появилась в первый раз.
   */
  viaPatientGroupId?: string | null;
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
export interface GrantOptions {
  /**
   * Не укорачивать уже выданный доступ: срок становится поздним из двух, а
   * бессрочный остаётся бессрочным.
   *
   * Для назначения набора поверх методики, доступ к которой у человека уже
   * есть. Ручное назначение набора писало доступ через onConflictDoNothing
   * («назначение поверх существующего доступа не должно его отзывать») — и
   * тем самым не продлевало ИСТЁКШИЙ доступ: набор назначен, а методика из
   * него пациенту не открывается (404). Здесь — оба требования сразу:
   * истёкший продлевается, более долгий не укорачивается.
   */
  extendOnly?: boolean;
}

export async function grantAccess(tx: typeof Db, grants: Grant[], options: GrantOptions = {}): Promise<void> {
  /*
   * Две вставки, а не одна: с лимитом и без.
   *
   * «Не указан» и «не ограничивать» — разные вещи (см. attemptsAllowed в
   * Grant), а в одной вставке их не различить. Колонку, которой нет в
   * VALUES, PostgreSQL заполняет умолчанием, и `excluded.attempts_allowed`
   * у выдачи без лимита — это null, то есть «не ограничивать». Так и было:
   * планировщик, каскад и протокол наблюдения лимита не знают и не
   * указывают, и методика, назначенная на одну попытку, после планового
   * повтора становилась проходимой сколько угодно раз — ровно то, от чего
   * лимит защищает (вторая попытка портит измерение: человек помнит
   * вопросы).
   *
   * Поэтому выдачи без лимита перевыдаются без колонки в SET: старый лимит
   * остаётся на месте. Новая выдача без лимита по-прежнему получает
   * умолчание — ей нечего сохранять.
   */
  const withLimit = grants.filter((g) => g.attemptsAllowed !== undefined);
  const keepLimit = grants.filter((g) => g.attemptsAllowed === undefined);
  if (withLimit.length) await upsertGrants(tx, withLimit, true, options);
  if (keepLimit.length) await upsertGrants(tx, keepLimit, false, options);
}

async function upsertGrants(tx: typeof Db, grants: Grant[], setLimit: boolean, options: GrantOptions): Promise<void> {
  const expiresAt = options.extendOnly
    ? sql`case when ${surveyAccess.expiresAt} is null or excluded.expires_at is null then null
               else greatest(${surveyAccess.expiresAt}, excluded.expires_at) end`
    : sql`excluded.expires_at`;
  await tx
    .insert(surveyAccess)
    .values(
      grants.map((g) => ({
        surveyId: g.surveyId,
        userId: g.userId,
        grantedBy: g.grantedBy,
        expiresAt: g.expiresAt,
        note: g.note,
        viaPatientGroupId: g.viaPatientGroupId ?? null,
        ...(setLimit ? { attemptsAllowed: g.attemptsAllowed ?? null } : {}),
      })),
    )
    .onConflictDoUpdate({
      target: [surveyAccess.surveyId, surveyAccess.userId],
      set: {
        grantedBy: sql`excluded.granted_by`,
        expiresAt,
        note: sql`excluded.note`,
        ...(setLimit ? { attemptsAllowed: sql`excluded.attempts_allowed` } : {}),
        /* пометка «через группу» переписывается вместе со всем остальным —
           см. поле viaPatientGroupId в интерфейсе выше */
        viaPatientGroupId: sql`excluded.via_patient_group_id`,
        /* обе точки отсчёта попыток сдвигаются вместе — см. докблок выше */
        grantedAt: sql`now()`,
        attemptsUsed: 0,
      },
    });
}
