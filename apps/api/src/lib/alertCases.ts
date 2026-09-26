import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { asSystem } from "../db/context";
import { alertCases, surveys } from "../db/schema";

/**
 * Открытие и продление случая риска.
 *
 * Тревога поднимается на каждый отмеченный пункт — так и надо, важно знать,
 * что именно сработало. Но разбирают не пункты, а человека: пять отмеченных
 * пунктов одного обследуемого — один случай и одно клиническое решение.
 */

/** Сколько часов новые тревоги считаются тем же эпизодом, если методика не сказала иначе */
export const DEFAULT_CASE_WINDOW_HOURS = 72;

type Tx = {
  select: (typeof import("../db").db)["select"];
  insert: (typeof import("../db").db)["insert"];
  update: (typeof import("../db").db)["update"];
  execute: (typeof import("../db").db)["execute"];
  query: (typeof import("../db").db)["query"];
};

/**
 * Зона видимости методики: кто вправе видеть её сигналы.
 *
 * Правило то же, что у lib/scope.ts и у политик строк (rls_admin_sees_survey):
 * методика в группе видна администраторам группы, методика без группы —
 * только создателю. Отсюда и ключ: группа, а у методики без группы — её
 * создатель (у двух его личных методик зона одна: видит их один и тот же
 * человек).
 *
 * Строкой в SQL, а не функцией в приложении: тем же выражением пользуется
 * миграция 0098 (alert_cases_split_by_zone), и два написания одного правила
 * разошлись бы на первой же правке.
 */
export function caseZoneSql(groupId: AnyPgColumn | SQL, createdBy: AnyPgColumn | SQL): SQL<string> {
  return sql<string>`coalesce(${groupId}, 'u:' || ${createdBy})`;
}

/**
 * Находит открытый случай человека в зоне методики или заводит новый.
 *
 * Продлевается только **неразобранный** случай: если специалист уже принял
 * решение, новая тревога — это новый повод к нему вернуться, а не строка в
 * закрытой записи. Иначе разобранный случай тихо «оживал» бы, и было бы
 * непонятно, к чему относится записанный исход.
 *
 * Второе условие — окно времени. Повторное срабатывание через сутки у
 * скрининга суицидального риска и через месяц у адаптационного профиля —
 * разные вещи, поэтому окно настраивается на методике.
 *
 * Вызывать внутри транзакции: блокировка ниже держится до её конца. Все
 * боевые вызывающие (сдача, автосохранение, посев) так и делают; вне
 * транзакции блокировка отпускается сразу, и гонка остаётся открытой.
 */
export async function attachToCase(
  tx: Tx,
  params: {
    userId: string | null;
    surveyId: string;
    severity: "moderate" | "severe";
    at: string;
  },
): Promise<string | null> {
  // анонимное прохождение случая не заводит: разбирать некого
  if (!params.userId) return null;
  /*
   * Под системной ролью, а не под ролью того, кто сдал: случай — строка
   * очереди дежурного, пациенту она закрыта политикой, а рождает её именно
   * его отправка. Подробно — у asSystem (db/context.ts).
   */
  return asSystem(() => attachCaseRow(tx, params as typeof params & { userId: string }));
}

async function attachCaseRow(
  tx: Tx,
  params: {
    userId: string;
    surveyId: string;
    severity: "moderate" | "severe";
    at: string;
  },
): Promise<string> {
  const survey = await tx.query.surveys.findFirst({
    where: eq(surveys.id, params.surveyId),
    columns: { alertCaseWindowHours: true, groupId: true, createdBy: true },
  });
  const windowHours = survey?.alertCaseWindowHours ?? DEFAULT_CASE_WINDOW_HOURS;
  // то же выражение, что caseZoneSql: группа, а без неё — создатель
  const zone = survey ? (survey.groupId ?? `u:${survey.createdBy}`) : `s:${params.surveyId}`;

  /*
   * Поиск и вставка — под одной блокировкой на пару «человек + зона».
   *
   * Без неё это были два шага, между которыми проходил соседний запрос.
   * Автосохранение пишет тревогу на каждом шаге прохождения, и два шага
   * одного человека, пришедшие разом, оба не находили открытого случая и
   * заводили по своему: в очереди человек стоял дважды, и решение о нём
   * принималось дважды и по-разному.
   *
   * Блокировка советующая, на время транзакции, а не уникальный индекс
   * «один открытый случай на человека». Индекс запретил бы то, что правило
   * окна разрешает намеренно: сигнал через неделю после неразобранного
   * случая — новый эпизод, а не строка в старом (см. выше). Ключ — хэш
   * строки: блокировки PostgreSQL числовые, а коллизия хэша стоит лишь
   * лишнего ожидания чужой пары, но не ошибки.
   */
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`alert_case|${params.userId}|${zone}`}, 0))`,
  );

  /*
   * Случай ищется по ЧЕЛОВЕКУ внутри ЗОНЫ видимости, а не по паре «человек +
   * методика» и не по человеку поверх всех зон.
   *
   * По методике — было раньше: человек, у которого риск сработал по двум
   * опросникам, висел в очереди дважды и требовал двух решений. Поверх всех
   * зон — стало потом, и это оказалось хуже. Решение заказчика 2026-09-26
   * (внешний разбор, P1): тревога методики группы Б дописывалась в случай,
   * начатый методикой группы А, а политика строк и выборка очереди держат
   * случай за его первой методикой. Сотрудник Б своего сигнала не видел
   * вовсе, а сотрудник А закрывал его своим решением, не видя: разбор ставит
   * исход на все сигналы случая.
   *
   * Почему делим случаи, а не расширяем видимость «по любой тревоге случая».
   * Решение о случае одно — одна отметка «взял», один исход, одна запись в
   * калибровку порогов, — а видимость сигналов внутри у двух зон разная.
   * Расширив политику, мы отдали бы сотруднику А решение о сигнале, которого
   * он не может прочесть, а сотруднику Б — случай, который «уже взят» тем,
   * кто его сигналов не видит. Случай на человека внутри зоны сохраняет всё,
   * ради чего случаи заводились: в одной зоне человек по-прежнему один, а
   * тот, кто видит обе зоны, получает его одной строкой очереди с двумя
   * случаями (routes/alertCases.ts, группировка по человеку).
   *
   * Окно берётся от методики нового сигнала — она и определяет, через
   * сколько повтор считается новым обращением.
   */
  const [open] = await tx
    .select({ id: alertCases.id })
    .from(alertCases)
    .innerJoin(surveys, eq(surveys.id, alertCases.surveyId))
    .where(
      and(
        eq(alertCases.userId, params.userId),
        isNull(alertCases.acknowledgedAt),
        sql`${caseZoneSql(surveys.groupId, surveys.createdBy)} = ${zone}`,
        sql`${alertCases.lastAlertAt} > ${params.at}::timestamptz - make_interval(hours => ${windowHours})`,
      ),
    )
    .orderBy(desc(alertCases.lastAlertAt))
    .limit(1);

  if (open) {
    /*
     * Дополнение — одним условным оператором, а не «прочитали и записали».
     *
     * Разбор не берёт блокировку зоны: он держит строку случая. Если разбор
     * зафиксирован между поиском выше и этим оператором, условие
     * «acknowledged_at is null» перепроверяется по свежей версии строки, и
     * ноль обновлённых строк значит «случай закрыли» — сигнал уходит в новый
     * случай. Прежде условия не было, и сигнал ложился в разобранный случай:
     * закрытый в очереди не показывается, и сигнала не видел никто.
     *
     * Время и тяжесть — выражениями от текущей строки, а не значениями,
     * прочитанными раньше: время не откатывается назад, если сигналы пришли
     * не по порядку, а тяжёлый случай не становится умеренным.
     */
    const updated = await tx
      .update(alertCases)
      .set({
        lastAlertAt: sql`greatest(${alertCases.lastAlertAt}, ${params.at}::timestamptz)`,
        // случай не легче худшего своего сигнала
        severity: sql`case when ${params.severity} = 'severe' then 'severe' else ${alertCases.severity} end`,
      })
      .where(and(eq(alertCases.id, open.id), isNull(alertCases.acknowledgedAt)))
      .returning({ id: alertCases.id });
    if (updated.length) return open.id;
  }

  const id = crypto.randomUUID();
  await tx.insert(alertCases).values({
    id,
    userId: params.userId,
    surveyId: params.surveyId,
    openedAt: params.at,
    lastAlertAt: params.at,
    severity: params.severity,
  });
  return id;
}
