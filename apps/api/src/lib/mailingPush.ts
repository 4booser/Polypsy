import { and, eq, gt, sql } from "drizzle-orm";
import { renderPush } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { mailingRecipients, mailings } from "../db/schema";
import { log } from "./log";
import { pushToUser } from "./push";
import { langsOfPatients } from "./remind";

/**
 * Пуши о рассылках.
 *
 * Идут ФОНОВЫМ проходом, а не из маршрута отправки, — по той же причине, по
 * которой напоминания о приёме отделены от записи на приём (см. remind.ts):
 * маршрут живёт в транзакции запроса, и двести сетевых вызовов к службе
 * уведомлений внутри неё держали бы соединение из пула на всё время
 * рассылки. Зависший поставщик уведомлений превращался бы в отказ API.
 *
 * Отправка идемпотентна: ключ события — «рассылка и человек», и второй тик
 * не потревожит того, кому уже ушло (pushToUser отсекает по push_deliveries).
 * Неудачная попытка заявку снимает — следующий тик попробует снова.
 *
 * Окно — сутки от отправки, как у напоминаний. Без окна человек без
 * зарегистрированного устройства (заявки у него нет — см. pushToUser)
 * перебирался бы каждую минуту вечно, и проход рос бы с каждой рассылкой.
 * Плата признана вслух: кто поставит приложение через два дня, пуша не
 * получит — но рассылка ждёт его в разделе «Повідомлення», и там она видна
 * как непрочитанная.
 */
const DAY_MS = 24 * 3600_000;

export async function pushMailings(now = new Date()): Promise<number> {
  /*
   * Снимок — одной транзакцией, отправка — вне её, по одному человеку на
   * короткую транзакцию: тот же порядок, что в remindAppointments, и по той
   * же причине (пул и сеть).
   */
  const { rows, langs } = await systemContext(baseDb, async () => {
    const rows = await db
      .select({ mailingId: mailingRecipients.mailingId, userId: mailingRecipients.userId })
      .from(mailingRecipients)
      .innerJoin(mailings, eq(mailings.id, mailingRecipients.mailingId))
      .where(
        and(
          eq(mailings.status, "sent"),
          gt(mailings.sentAt, new Date(now.getTime() - DAY_MS).toISOString()),
          // кому ещё не уходило — по той же таблице, по которой pushToUser отсекает повтор
          sql`not exists (select 1 from push_deliveries pd
            where pd.user_id = ${mailingRecipients.userId}
              and pd.event_key = 'mailing:' || ${mailingRecipients.mailingId})`,
        ),
      )
      .limit(500);
    const langs = await langsOfPatients([...new Set(rows.map((r) => r.userId))]);
    return { rows, langs };
  });

  let sent = 0;
  for (const r of rows) {
    // для устройств без своего языка (см. langsOfPatients); не проходил ничего — украинский
    const fallback = langs.get(r.userId) ?? "uk";
    const ok = await systemContext(baseDb, () =>
      pushToUser(
        r.userId,
        {
          eventKey: `mailing:${r.mailingId}`,
          kind: "mailing",
          // ни темы, ни текста: экран блокировки видят посторонние
          title: (lang) => renderPush("push.mailingTitle", lang),
          body: (lang) => renderPush("push.mailingBody", lang),
          path: "/messages",
        },
        fallback,
      ),
    );
    if (ok) sent += 1;
  }

  if (sent) log.info("mailings.pushed", { sent });
  return sent;
}
