import { useState } from "react";
import { Link } from "react-router-dom";
import type { UiKey, WorkItem, WorkKind } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { Avatar, Badge, Empty, Screen } from "../ui";
import { Page, Panel } from "../ui/layout";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { useLiveReload } from "../events";

/*
 * Полный перебор видов, а не частичный словарь.
 *
 * Record<WorkKind, …> означает, что новый вид работы не соберётся, пока ему
 * не дадут названия. До этого словарь был просто объектом, и неявка приехала
 * с сервера видом, которого консоль не знала, — строка нарисовалась без
 * названия и никто бы не заметил.
 */
const KIND_KEY: Record<WorkKind, UiKey> = {
  noshow: "work.kindNoshow",
  message: "work.kindMessage",
  dispensary: "work.kindDispensary",
  followup: "work.kindFollowup",
  referral: "work.kindReferral",
  assignment: "work.kindAssignment",
} as const;

/*
 * Название вкладки фильтра — не то же самое, что метка в столбце.
 *
 * В столбце стоит «сообщение» — одно слово в родительном разряде, по нему
 * глаз ищет строку. На вкладке нужно «Непрочитанные»: она отвечает не «что
 * это за строка», а «что я сейчас увижу, если нажму». Одна строка на оба
 * места дала бы вкладку «СООБЩЕНИЕ · 1», читающуюся как заголовок раздела.
 *
 * Перебор снова полный: вид без названия вкладки не соберётся.
 */
const FILTER_KEY: Record<WorkKind, UiKey> = {
  noshow: "work.filterNoshows",
  message: "work.filterMessages",
  dispensary: "work.filterDispensary",
  followup: "work.filterFollowups",
  referral: "work.filterReferrals",
  assignment: "work.filterAssignments",
} as const;

/**
 * Что от меня ждут сегодня.
 *
 * Входящее было рассыпано по трём экранам: случаи риска, незакрытые
 * назначения, открытые направления. Дежурный обходил их по очереди и держал
 * объём работы в голове — а держать его в голове он не обязан.
 *
 * Экран не подменяет те три: там разбирают, здесь видят, за что взяться.
 * Поэтому каждая строка — ссылка туда, где с ней работают.
 */
export default function WorklistPage() {
  const [kind, setKind] = useState<WorkItem["kind"] | "">("");
  const { ut } = useLang();
  const res = useResource(() => api.worklist(), []);
  useLiveReload(["alert.created", "case.changed", "response.submitted", "schedule.run"], res.reload);

  return (
    <Screen res={res} rows={6}>
      {(data) => {
        const shown = kind ? data.items.filter((i) => i.kind === kind) : data.items;
        const overdue = data.items.filter((i) => i.overdue).length;
        return (
    <Page
      title={ut("work.title")}
      count={data.total || null}
      sub={
        data.total
          ? `${ut("work.onReview")}${overdue ? ` · ${ut("cases.overdue")} ${overdue}` : ""}`
          : ut("work.nothing")
      }
      toolbar={
        /*
         * Вкладки строятся по тому, что в очереди есть, а не по списку,
         * набранному руками.
         *
         * Набранный руками отставал: над строкой с непрочитанным письмом
         * висели три вкладки с нулями, сумма не сходилась с «Всё · 1», и
         * до самой строки нельзя было отфильтроваться. Пустые виды не
         * показываются: вкладка с нулём — это место, куда нажимают и
         * попадают в пустоту.
         */
        <div className="tabs !mb-0 !border-0">
          <button className={kind === "" ? "active" : ""} onClick={() => setKind("")}>
            {ut("work.all")} · {data.total}
          </button>
          {(Object.keys(FILTER_KEY) as WorkKind[])
            .filter((k) => (data.byKind[k] ?? 0) > 0)
            .map((k) => (
              <button key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
                {ut(FILTER_KEY[k])} · {data.byKind[k]}
              </button>
            ))}
        </div>
      }
    >
      {shown.length === 0 ? (
        <Empty
          title={ut("work.done")}
          hint={ut("work.doneHint")}
        />
      ) : (
        <Panel flush>
          {shown.map((i) => (
            <Link
              key={`${i.kind}-${i.id}`}
              to={i.href}
              className="flex items-center gap-3 border-b border-hairline px-5 py-2.5 no-underline last:border-0 hover:bg-surface-2"
            >
              <Avatar name={i.userName} size={26} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <strong className="truncate text-small font-medium text-text">{i.userName}</strong>
                  {i.unit ? <span className="shrink-0 text-caption text-muted">· {i.unit}</span> : null}
                </div>
                <div className="truncate text-caption text-muted">{describe(i, ut)}</div>
              </div>
              {/*
                Вид работы набран моноширинно и прописными: это не текст, а
                метка одного из шести значений, и по ней глаз ищет нужный
                разряд в столбце, а не читает слово.
              */}
              <span className="w-[104px] shrink-0 font-mono text-micro uppercase tracking-[var(--tracking-label)] text-faint max-[900px]:hidden">
                {ut(KIND_KEY[i.kind])}
              </span>
              {i.overdue ? <Badge tone="bad">{ut("cases.overdue")}</Badge> : null}
              <span className="w-[86px] shrink-0 text-right text-caption text-muted">{day(i.since)}</span>
            </Link>
          ))}
        </Panel>
      )}

      {data.truncated ? (
        <p className="mt-4 text-center text-caption text-muted">{ut("work.truncated")}</p>
      ) : null}
    </Page>
        );
      }}
    </Screen>
  );
}


/**
 * Подробности строки собираются здесь, а не на сервере.
 *
 * Сервер отдавал их готовой строкой — «Срочно · сигналов 3», — и такую строку
 * клиент не может ни перевести, ни переформатировать. Отображение
 * принадлежит клиенту; сервер отдаёт факты.
 */
function describe(i: WorkItem, ut: (k: never) => string): string {
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
