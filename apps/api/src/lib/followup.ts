import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";
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
 * по нему человек, возможно, как раз проходит. Пропущенные (missed_at) не
 * открывались и тоже уходят: новый замер и есть тот повтор, которого не
 * было, и в очереди работы пропуск больше не висит.
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
 * Разобрать наступившие окна: идущие открыть, пропущенные отметить.
 *
 * Это два разных события, и путь у каждого свой (внешний разбор
 * 2026-09-28, P2). Прежде тик выбирал окна по opens_at, не глядя на
 * closes_at, и выдавал доступ перевыдачей до закрытия окна:
 *   — окно идёт (opens_at ≤ сейчас < closes_at) — доступ до его закрытия.
 *     Срок — только вперёд (term "extend", lib/grantAccess.ts): окно поверх
 *     более долгого доступа — ручного, по набору — его не укорачивает, а
 *     истёкший продлевает. Счётчик попыток сдвигается и лимит сохраняется:
 *     повтор — новое разрешение пройти;
 *   — окно закрылось, так и не открывшись (тик стоял, учётка была
 *     выключена), — пропуск: отмечается missed_at, доступ не трогается.
 *     Выдача по такому окну давала срок, истёкший до выдачи, и перевыдачей
 *     переписывала им действующий доступ — ручной, ещё на месяц, —
 *     отзывая его задним числом. Пропуск виден в очереди работы
 *     (routes/worklist.ts) — там же, где просроченный повтор.
 * Выключенной учётке окно не открывается и пропуском не отмечается: её
 * окна ждут, а включат учётку — первый же тик разберёт их тем же правилом.
 *
 * Переход окна — условием самого UPDATE (opened_at и missed_at ещё пусты),
 * а не проверкой прочитанного: два тика одно окно дважды не откроют —
 * второй получит ноль строк и доступа не тронет. Захват окна и выдача —
 * одной короткой транзакцией на окно: сорвалась выдача — окно осталось
 * неоткрытым, а одно неудачное не отменяет остальные.
 */
export async function openFollowUps(now = new Date()): Promise<number> {
  const at = now.toISOString();
  const due = await systemContext(baseDb, () =>
    db
      .select({ f: surveyFollowups })
      .from(surveyFollowups)
      .innerJoin(users, eq(users.id, surveyFollowups.userId))
      .where(
        and(
          isNull(surveyFollowups.openedAt),
          isNull(surveyFollowups.missedAt),
          lte(surveyFollowups.opensAt, at),
          isNull(users.disabledAt),
        ),
      )
      .orderBy(asc(surveyFollowups.opensAt), asc(surveyFollowups.id))
      .limit(500),
  );
  const closed = (f: { closesAt: string }) => parseTs(f.closesAt) <= now.getTime();

  const missed = due.filter(({ f }) => closed(f)).map(({ f }) => f.id);
  if (missed.length) {
    const marked = await systemContext(baseDb, () =>
      db
        .update(surveyFollowups)
        .set({ missedAt: at })
        .where(
          and(
            inArray(surveyFollowups.id, missed),
            isNull(surveyFollowups.openedAt),
            isNull(surveyFollowups.missedAt),
            lte(surveyFollowups.closesAt, at),
          ),
        )
        .returning({ id: surveyFollowups.id }),
    );
    if (marked.length) log.warn("followup.missed", { missed: marked.length });
  }

  let opened = 0;
  for (const { f } of due) {
    if (closed(f)) continue;
    try {
      const claimed = await systemContext(baseDb, async () => {
        const [won] = await db
          .update(surveyFollowups)
          .set({ openedAt: at })
          .where(
            and(eq(surveyFollowups.id, f.id), isNull(surveyFollowups.openedAt), isNull(surveyFollowups.missedAt)),
          )
          .returning({ id: surveyFollowups.id });
        if (!won) return false;
        await grantAccess(
          db,
          [
            {
              surveyId: f.surveyId,
              userId: f.userId,
              grantedBy: f.userId,
              expiresAt: f.closesAt,
              note: followupNote(f.afterDays),
            },
          ],
          { term: "extend" },
        );
        return true;
      });
      if (claimed) opened++;
    } catch (error) {
      log.warn("followup.open_failed", { id: f.id, error: String(error) });
    }
  }
  if (opened) log.info("followup.opened", { opened });
  return opened;
}
