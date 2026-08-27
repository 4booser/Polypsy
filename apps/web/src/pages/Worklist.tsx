import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Worklist as List, WorkItem } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { Avatar, Badge, Empty, Loading, PageHead } from "../ui";

const KIND_LABEL: Record<WorkItem["kind"], string> = {
  case: "случай риска",
  referral: "направление",
  assignment: "назначение",
};

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

  useEffect(() => {
    api.worklist().then(setData).catch((e) => setError(e.message));
  }, []);

  if (!data) return <Loading error={error} rows={6} />;

  const shown = kind ? data.items.filter((i) => i.kind === kind) : data.items;
  const overdue = data.items.filter((i) => i.overdue).length;

  return (
    <>
      <PageHead
        title="Очередь работы"
        sub={
          data.total
            ? `${data.total} на разбор${overdue ? ` · просрочено ${overdue}` : ""}`
            : "Ничего не ждёт"
        }
      />

      <div className="card filters">
        <div className="tabs">
          <button className={kind === "" ? "active" : ""} onClick={() => setKind("")}>
            Всё · {data.total}
          </button>
          <button className={kind === "case" ? "active" : ""} onClick={() => setKind("case")}>
            Случаи · {data.byKind.case}
          </button>
          <button className={kind === "referral" ? "active" : ""} onClick={() => setKind("referral")}>
            Направления · {data.byKind.referral}
          </button>
          <button
            className={kind === "assignment" ? "active" : ""}
            onClick={() => setKind("assignment")}
          >
            Просроченные назначения · {data.byKind.assignment}
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty
          title="Разобрано"
          hint="Новое появится здесь, как только придёт — этот экран собирает всё входящее в одном месте"
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
              <span className="muted work-kind">{KIND_LABEL[i.kind]}</span>
              {i.overdue ? <Badge tone="bad">просрочено</Badge> : null}
              <span className="muted work-since">{day(i.since)}</span>
            </Link>
          ))}
        </div>
      )}

      {data.truncated ? (
        <p className="hint" style={{ textAlign: "center" }}>
          Показаны первые 100. Разберите срочное — остальное подтянется.
        </p>
      ) : null}
    </>
  );
}
