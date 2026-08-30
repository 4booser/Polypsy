import { Link, useParams } from "react-router-dom";
import { api, type TimelineItem } from "../api";
import { dateTime, severityColor } from "../format";
import { Empty, Loading } from "../ui";
import { Page } from "../ui/layout";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import type { UiKey } from "@quizzy/shared";

/**
 * Хронология пациента.
 *
 * Раньше историю приходилось собирать с четырёх экранов и складывать порядок
 * в голове. Между тем именно порядок и есть клинический смысл: сработала
 * тревога до направления или после, был ли повторный замер после начала
 * терапии, сколько прошло между сигналом и разбором.
 *
 * События сгруппированы по дням: без группировки лента из двухсот строк
 * читается как журнал, а не как история.
 */

const KIND_KEY = {
  response: "tl.response",
  alert: "tl.alert",
  referral: "tl.referral",
  conclusion: "tl.conclusion",
  assignment: "tl.assignment",
} as const satisfies Record<TimelineItem["kind"], UiKey>;

export default function Timeline() {
  const { userId } = useParams<{ userId: string }>();
  const { ut } = useLang();
  const res = useResource(() => api.timeline(userId!), [userId], { enabled: !!userId });
  const items = res.data;

  if (!items) return <Loading rows={6} error={res.error} />;

  // группировка по дню: лента из двухсот строк без неё читается как журнал
  const byDay = new Map<string, TimelineItem[]>();
  for (const i of items) {
    const day = i.at.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), i]);
  }

  return (
    <Page
      title={ut("tl.title")}
      sub={ut("tl.sub")}
      count={items.length || null}
      crumbs={<Link to={`/patients/${userId}/summary`}>← {ut("nav.patients")}</Link>}
    >
      {items.length === 0 ? (
        <Empty title={ut("tl.empty")} hint={ut("tl.emptyHint")} />
      ) : (
        <div className="card timeline">
          {[...byDay.entries()].map(([day, events]) => (
            <section key={day} className="tl-day">
              <h3 className="tl-date">{day}</h3>
              <div className="tl-events">
                {events.map((e) => (
                  <article key={e.id} className={`tl-event k-${e.kind}`}>
                    <i
                      className="tl-dot"
                      style={e.severity ? { background: severityColor[e.severity] } : undefined}
                    />
                    <time className="tl-time">{dateTime(e.at).slice(11)}</time>
                    <div className="tl-body">
                      <span className="tl-kind">{ut(KIND_KEY[e.kind])}</span>
                      {e.href ? <Link to={e.href}>{e.title}</Link> : <span>{e.title}</span>}
                      {e.detail ? <span className="muted"> · {e.detail}</span> : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}
