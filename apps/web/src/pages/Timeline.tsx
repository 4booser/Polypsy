import { Link, useParams } from "react-router-dom";
import { api, type TimelineItem } from "../api";
import { dateTime, dayKey, severityColor, timeOfDay } from "../format";
import { Empty, Loading } from "../ui";
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
 *
 * Вкладка карты пациента: заголовок и имя стоят в шапке карты, здесь —
 * только лента.
 */

const KIND_KEY = {
  response: "tl.response",
  alert: "tl.alert",
  referral: "tl.referral",
  conclusion: "tl.conclusion",
  assignment: "tl.assignment",
} as const satisfies Record<TimelineItem["kind"], UiKey>;

/**
 * События по календарным дням — в поясе консоли, а не по UTC.
 *
 * День брался срезом строки ISO, то есть по Гринвичу: всё, что случилось в
 * Киеве после 21:00 летом (после 22:00 зимой), уезжало в следующий день —
 * тревога, сработавшая вечером, стояла под завтрашней датой рядом с
 * утренним замером того «завтра». Для хронологии, где смысл — порядок, это
 * ошибка по существу. Порядок внутри дня — как пришёл с сервера.
 */
export function groupByDay<T extends { at: string }>(items: readonly T[], timeZone?: string): Map<string, T[]> {
  const byDay = new Map<string, T[]>();
  for (const i of items) {
    const day = dayKey(i.at, timeZone);
    byDay.set(day, [...(byDay.get(day) ?? []), i]);
  }
  return byDay;
}

export default function Timeline() {
  const { userId } = useParams<{ userId: string }>();
  const { ut } = useLang();
  const res = useResource(() => api.timeline(userId!), [userId], { enabled: !!userId });
  const items = res.data;

  if (!items) return <Loading rows={6} error={res.error} />;

  // группировка по дню: лента из двухсот строк без неё читается как журнал
  const byDay = groupByDay(items);

  return (
    <>
      {/*
        Подпись остаётся: без неё вкладка не говорит, ЧТО именно на оси, а
        отсутствие события легко прочесть как «этого не было», хотя события
        такого рода лента может просто не собирать.
      */}
      <p className="hint mb-3">{ut("tl.sub")}</p>
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
                    {/*
                      Время — timeOfDay, а не хвост dateTime: полная дата
                      пишется словами («2 вересня 2026 р. о 14:05»), и срез с
                      одиннадцатого знака давал обрывок года вместо часа.
                    */}
                    <time className="tl-time" dateTime={e.at} title={dateTime(e.at)}>
                      {timeOfDay(e.at)}
                    </time>
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
    </>
  );
}
