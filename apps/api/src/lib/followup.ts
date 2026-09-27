import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { noteCode, notePrefix } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { surveyFollowups, users } from "../db/schema";
import { endOfDayAfter } from "./day";
import { grantAccess } from "./grantAccess";
import { log } from "./log";
import { parseTs } from "./time";

/**
 * Метка повторного замера в примечании к доступу.
 *
 * Доступ к методике выдаётся по разным поводам, и очередь работы должна
 * отличать выданный по протоколу наблюдения — «повторить через неделю» — от
 * выданного разово. Признака в схеме под это нет, и повод опознаётся по
 * началу примечания.
 *
 * Строка вынесена сюда, потому что её пишет одно место, а читает другое, и
 * разошлись они молча: каскад ставил «Протокол наблюдения», наполнение
 * демонстрационными данными — «Призначено для спостереження», и очередь
 * работы не находила ни одного повтора. Ни один тест этого не видел: каждая
 * сторона была права по отдельности.
 *
 * Правильнее была бы колонка-повод, а не разбор текста: примечание видно
 * человеку, и однажды его перепишут. Колонка — это миграция и правка
 * каскада; общая константа держит две стороны вместе уже сейчас и не мешает
 * завести колонку потом.
 *
 * С волны 14 примечание пишется кодом (noteCode): его читают на любом языке
 * (список назначенных в «Доступі»), и русская фраза стояла там на
 * украинском и английском экранах. Узнаётся повтор по началу кода — и по
 * прежнему русскому началу у выданных до кодов: переписывать их незачем,
 * а потерять из очереди нельзя.
 */
export function followupNote(days: number): string {
  return noteCode("note.followup", { days });
}

/** Начала примечания, по которым очередь работы узнаёт повтор: код и запись до кодов */
export const FOLLOWUP_NOTE_PREFIXES: readonly string[] = [notePrefix("note.followup"), "Протокол наблюдения"];

/* ─── окна повторов (участок delivery, волна 12, миграция 0103) ─── */

/** Сколько дней открыто окно повтора, если следующее не открывается раньше */
const WINDOW_DAYS = 14;

export interface FollowUpWindow {
  afterDays: number;
  opensAt: string;
  closesAt: string;
}

/**
 * Окна повторов «через d₁, d₂, … дней» от момента замера.
 *
 * Окно открывается в начале своего дня по поясу учреждения и закрывается в
 * конце дня через две недели — или раньше, к открытию следующего окна: два
 * открытых окна одной методики сливались бы в одно, и замер «через месяц»
 * можно было бы пройти на десятый день. Чистая функция — ради проверки
 * границ без базы.
 */
export function followUpWindows(from: Date, days: number[]): FollowUpWindow[] {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const opens = sorted.map((d) => parseTs(endOfDayAfter(from, d - 1)) + 1);
  return sorted.map((d, i) => {
    const natural = parseTs(endOfDayAfter(from, d + WINDOW_DAYS - 1));
    const next = opens[i + 1];
    const closes = next !== undefined ? Math.min(natural, next - 1) : natural;
    return {
      afterDays: d,
      opensAt: new Date(opens[i]!).toISOString(),
      closesAt: new Date(closes).toISOString(),
    };
  });
}

/**
 * Поставить окна повторов вместо ещё не открытых.
 *
 * Новый замер в той же полосе начинает протокол заново — от себя: окна,
 * которые ещё не открылись, заменяются. Уже открытое окно не трогается —
 * по нему человек, возможно, как раз проходит.
 */
export async function planFollowUps(surveyId: string, userId: string, days: number[], from = new Date()): Promise<number> {
  const windows = followUpWindows(from, days);
  await db
    .delete(surveyFollowups)
    .where(
      and(
        eq(surveyFollowups.surveyId, surveyId),
        eq(surveyFollowups.userId, userId),
        isNull(surveyFollowups.openedAt),
      ),
    );
  if (windows.length) {
    await db.insert(surveyFollowups).values(
      windows.map((w) => ({ id: crypto.randomUUID(), surveyId, userId, ...w })),
    );
  }
  return windows.length;
}

/**
 * Открыть наступившие окна: выдать доступ до закрытия окна.
 *
 * Выдача — через grantAccess, то есть как перевыдача: срок, дата выдачи и
 * счётчик попыток сдвигаются вместе, лимит попыток сохраняется. Каждое окно —
 * своей короткой транзакцией: одно неудачное не отменяет остальные.
 * Выключенной учётке окно не открывается — выдавать доступ человеку,
 * которого нет, незачем; окно останется неоткрытым.
 */
export async function openFollowUps(now = new Date()): Promise<number> {
  const due = await systemContext(baseDb, () =>
    db
      .select({ f: surveyFollowups })
      .from(surveyFollowups)
      .innerJoin(users, eq(users.id, surveyFollowups.userId))
      .where(
        and(
          isNull(surveyFollowups.openedAt),
          lte(surveyFollowups.opensAt, now.toISOString()),
          isNull(users.disabledAt),
        ),
      )
      .orderBy(asc(surveyFollowups.opensAt))
      .limit(500),
  );
  let opened = 0;
  for (const { f } of due) {
    try {
      await systemContext(baseDb, async () => {
        await grantAccess(db, [
          {
            surveyId: f.surveyId,
            userId: f.userId,
            grantedBy: f.userId,
            expiresAt: f.closesAt,
            note: followupNote(f.afterDays),
          },
        ]);
        await db
          .update(surveyFollowups)
          .set({ openedAt: now.toISOString() })
          .where(and(eq(surveyFollowups.id, f.id), isNull(surveyFollowups.openedAt)));
      });
      opened++;
    } catch (error) {
      log.warn("followup.open_failed", { id: f.id, error: String(error) });
    }
  }
  if (opened) log.info("followup.opened", { opened });
  return opened;
}
