import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Worklist as List, WorkItem } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { Avatar, Badge, Empty, Loading, PageHead } from "../ui";
import { useLang } from "../lang";

const KIND_KEY = {
  case: "work.kindCase",
  followup: "work.kindFollowup",
  referral: "work.kindReferral",
  assignment: "work.kindAssignment",
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
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<WorkItem["kind"] | "">("");
  const { ut } = useLang();

  useEffect(() => {
    api.worklist().then(setData).catch((e) => setError(e.message));
  }, []);

  if (!data) return <Loading error={error} rows={6} />;

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
                  {i.title} · {i.detail}
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
}
