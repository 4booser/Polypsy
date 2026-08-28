import { useState } from "react";
import { Link } from "react-router-dom";
import type { WorkItem } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { Avatar, Badge, Empty, PageHead, Screen } from "../ui";
import { useLang } from "../lang";
import { useResource } from "../useResource";

const KIND_KEY = {
  case: "work.kindCase",
  followup: "work.kindFollowup",
  referral: "work.kindReferral",
  assignment: "work.kindAssignment",
  pathway: "work.kindPathway",
  goal: "work.kindGoal",
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

  return (
    <Screen res={res} rows={6}>
      {(data) => {
        const shown = kind ? data.items.filter((i) => i.kind === kind) : data.items;
        const overdue = data.items.filter((i) => i.overdue).length;
        return (
    <>
      <PageHead
        title={ut("work.title")}
        sub={
          data.total
            ? `${data.total} ${ut("work.onReview")}${overdue ? ` · ${ut("cases.overdue")} ${overdue}` : ""}`
            : ut("work.nothing")
        }
      />

      <div className="card filters">
        <div className="tabs">
          <button className={kind === "" ? "active" : ""} onClick={() => setKind("")}>
            {ut("work.all")} · {data.total}
          </button>
          <button className={kind === "case" ? "active" : ""} onClick={() => setKind("case")}>
            {ut("work.filterCases")} · {data.byKind.case}
          </button>
          <button className={kind === "followup" ? "active" : ""} onClick={() => setKind("followup")}>
            {ut("work.filterFollowups")} · {data.byKind.followup}
          </button>
          <button className={kind === "referral" ? "active" : ""} onClick={() => setKind("referral")}>
            {ut("work.filterReferrals")} · {data.byKind.referral}
          </button>
          <button
            className={kind === "assignment" ? "active" : ""}
            onClick={() => setKind("assignment")}
          >
            {ut("work.filterAssignments")} · {data.byKind.assignment}
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty
          title={ut("work.done")}
          hint={ut("work.doneHint")}
        />
      ) : (
        <div className="card flush">
          {shown.map((i) => (
            <Link key={`${i.kind}-${i.id}`} to={i.href} className="work-row">
              <Avatar name={i.userName} size={28} />
              <div className="grow">
                <div className="row tight">
                  <strong>{i.userName}</strong>
                  {i.unit ? <span className="muted">· {i.unit}</span> : null}
                </div>
                <div className="hint" style={{ margin: 0 }}>
                  {describe(i, ut)}
                </div>
              </div>
              <span className="muted work-kind">{ut(KIND_KEY[i.kind])}</span>
              {i.overdue ? <Badge tone="bad">{ut("cases.overdue")}</Badge> : null}
              <span className="muted work-since">{day(i.since)}</span>
            </Link>
          ))}
        </div>
      )}

      {data.truncated ? (
        <p className="hint" style={{ textAlign: "center" }}>
          {ut("work.truncated")}
        </p>
      ) : null}
    </>
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
    case "case":
      return [
        i.title,
        i.severity === "severe" ? t("work.urgent") : t("work.attention"),
        `${t("cases.signals")} ${i.signals ?? 0}`,
      ].join(" · ");
    case "referral":
      return [
        i.title === "created" ? t("work.refNotAccepted") : t("work.refNotDone"),
        i.destination ? t(`dest.${i.destination}`) : null,
        `${i.days ?? 0} ${t("work.daysNoMove")}`,
      ]
        .filter(Boolean)
        .join(" · ");
    case "assignment":
      return `${i.title} · ${t("work.dueExpired")} ${i.days ?? 0} ${t("cases.ago")}`;
    case "followup":
      return `${i.title} · ${t("work.followupMissed")} · ${i.days ?? 0} ${t("work.daysOverdue")}`;
    case "pathway":
      // у шага маршрута заголовок уже несёт «маршрут: шаг» — остаётся просрочка
      return `${i.title} · ${t("work.dueExpired")} ${i.days ?? 0} ${t("cases.ago")}`;
    case "goal":
      return `${i.title} · ${t("work.goalOverdue")} ${i.days ?? 0} ${t("cases.ago")}`;
  }
}
