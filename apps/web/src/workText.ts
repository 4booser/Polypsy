import type { WorkItem } from "@quizzy/shared";

/*
 * Общая для очереди работы (pages/Worklist.tsx) и сводки (pages/Dashboard.tsx):
 * сводка показывала вместо подробностей голое поле `title`, и у направления
 * это был код состояния — «created» латиницей посреди украинской строки.
 * Одна функция на оба экрана — одна строка на один вид работы.
 */
/**
 * Подробности строки очереди собираются здесь, а не на сервере.
 *
 * Сервер отдавал их готовой строкой — «Срочно · сигналов 3», — и такую строку
 * клиент не может ни перевести, ни переформатировать. Отображение
 * принадлежит клиенту; сервер отдаёт факты.
 */
export function describeWork(i: WorkItem, ut: (k: never) => string): string {
  const t = (k: string) => ut(k as never);
  switch (i.kind) {
    case "referral":
      return [
        i.title === "created" ? t("work.refNotAccepted") : t("work.refNotDone"),
        i.destination ? t(`dest.${i.destination}`) : null,
        `${i.days ?? 0} ${t("work.daysNoMove")}`,
      ]
        .filter(Boolean)
        .join(" · ");
    case "assignment":
      /* единица обязательна: «Срок вышел 3 назад» — это число ни о чём */
      return `${i.title} · ${t("work.dueExpired")} ${i.days ?? 0} ${t("work.daysOverdue")}`;
    case "followup":
      return `${i.title} · ${t("work.followupMissed")} · ${i.days ?? 0} ${t("work.daysOverdue")}`;
    case "message":
      /*
       * Число непрочитанных важнее давности: одно письмо — обычная работа,
       * три подряд без ответа — уже другая история.
       */
      return [
        `${t("work.msgUnread")} ${i.signals ?? 1}`,
        (i.days ?? 0) > 0 ? `${t("work.msgWaiting")} ${i.days}` : t("work.msgToday"),
      ].join(" · ");
    case "dispensary":
      /*
       * Название группы учёта плюс число дней: «просрочено на три дня» и
       * «просрочено на полгода» — разный разговор, и одинаковой пометкой их
       * делать нельзя.
       */
      return `${i.title} · ${t("work.dispOverdue")} ${i.days ?? 0}`;
    case "noshow":
      /*
       * «Второй раз подряд» — другой разговор, чем «не пришёл один раз», и
       * счётчик здесь важнее давности: по нему видно, разовая это история
       * или человек уходит.
       */
      return [
        (i.signals ?? 0) > 1 ? `${t("work.noshowTimes")} ${i.signals}` : t("work.noshowOnce"),
        `${i.days ?? 0} ${t("work.daysAgo")}`,
        i.overdue ? t("work.noshowAfterAlert") : null,
      ]
        .filter(Boolean)
        .join(" · ");
  }
}
