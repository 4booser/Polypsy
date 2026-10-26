import { Link } from "react-router-dom";
import type { UiKey } from "@quizzy/shared";
import { CourseChart } from "../../charts/course";
import { courseEventsFromTimeline, courseFromDynamics } from "../../charts/courseModel";
import { dateTime, day, timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { ActivityList, Empty, Ic, Loading, TextAction } from "../../ui";
import { Panel } from "../../ui/layout";
import { Button, Tag } from "../../ui/primitives";
import { shortTitle } from "./Banner";
import { dm } from "./format";
import { Pi } from "./icons";
import { conclusionName, resultRows } from "./model";
import { eventOf } from "./Overview";
import type { CardView } from "./types";

/*
 * Остальные вкладки карточки. Каждая — то, что приложение уже знает о
 * человеке, в одном месте и тем же языком, что «Огляд»: замеры с
 * результатом, курс по каждой шкале («Графіки»), заключения целиком, приёмы,
 * переписка, нотатки и все события («Події»). Глубже — клиническая карта
 * (/patients/:id/case): её «Динаміка» (числа, достоверность, методики
 * вместе) и «Хронологія» (по дням, с отбором) — другие экраны, поэтому
 * вкладки карточки названы иначе; ссылка на карту стоит в шапке и в каждой
 * вкладке, где карта знает больше.
 */

/**
 * «Заміри»: дата, методика, результат — по шкале в строке. Колонки
 * «Статистика» нет: она повторяла дату и печатала служебные коды шкал с
 * долей от максимума («anxiety 68,2%»), не говоря, что это за процент.
 */
export function MeasuresTab({ v }: { v: CardView }) {
  const { ut } = useLang();
  const list = v.card.responses;
  return (
    <Panel title={ut("card.tMeasures")} icon={<Ic.clipboard />} count={list.length} flush>
      {!list.length ? (
        <Empty compact title={ut("pcard.noTests")} />
      ) : (
        <table className="w-full border-collapse text-body">
          <thead>
            <tr className="[&>th]:h-[34px] [&>th]:border-y [&>th]:border-divider [&>th]:bg-panel-2 [&>th]:px-3 [&>th]:text-left [&>th]:text-caption [&>th]:font-bold [&>th]:text-muted">
              <th className="w-[90px] !pl-4">{ut("card.colDate")}</th>
              <th className="w-[32%]">{ut("card.colInstrument")}</th>
              <th className="!pr-4">{ut("pcard.result")}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const rows = resultRows(r.scales);
              return (
                <tr key={r.responseId} className="[&>td]:border-b [&>td]:border-divider [&>td]:px-3 [&>td]:py-2.5 [&>td]:align-top hover:[&>td]:bg-panel-2">
                  <td className="!pl-4 whitespace-nowrap text-text-2">{r.submittedAt ? dm(r.submittedAt) : "—"}</td>
                  <td>
                    <Link
                      to={
                        r.scales.length
                          ? `/surveys/${r.surveyId}/responses/${r.responseId}/charts`
                          : `/surveys/${r.surveyId}/responses/${r.responseId}`
                      }
                      className="font-bold text-violet-ink"
                    >
                      {r.surveyTitle}
                    </Link>
                  </td>
                  <td className="!pr-4 text-small text-text-2">
                    {rows.length ? (
                      <ul className="m-0 list-none p-0">
                        {rows.map((s) => (
                          <li key={s.title} className="py-px">
                            <span className="text-muted">{s.title}:</span> <b className="font-extrabold text-text">{s.value}</b>
                            {s.band ? ` — ${s.band}` : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-muted">{ut("pcard.noScores")}</span>
                    )}
                    {/* недостоверный протокол — словом при результате: читать его балл как обычный нельзя */}
                    {r.reliable ? null : <span className="mt-1 block font-bold text-warn">{ut("pcard.unreliable")}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function DynamicsTab({ v }: { v: CardView }) {
  const { ut } = useLang();
  if (!v.dynamics) return <Loading rows={4} error={v.dynamicsError} onRetry={v.reloadDynamics} />;
  const rows = v.rows.filter((r) => r.points.length > 0);
  const events = courseEventsFromTimeline(v.timeline ?? []);
  if (!rows.length) return <Empty title={ut("pcard.noTests")} />;
  return (
    <div className="@container">
      <div className="grid gap-4 @min-[1000px]:grid-cols-2">
        {rows.map((r) => (
          <Panel
            key={r.key}
            title={r.code}
            icon={<Pi.chartSpline />}
            sub={shortTitle(r.surveyTitle)}
            actions={<TextAction to={`/patients/${v.id}/case/dynamics`}>{ut("card.fullDynamics")}</TextAction>}
          >
            <CourseChart title={r.code} {...courseFromDynamics(r.scale, r.rungs)} events={events} legend={false} />
          </Panel>
        ))}
      </div>
    </div>
  );
}

export function ConclusionsTab({ v }: { v: CardView }) {
  const { ut } = useLang();
  const list = v.card.conclusions;
  return (
    <Panel
      title={ut("pcard.conclusions")}
      icon={<Ic.file />}
      count={list.length}
      actions={
        v.can("conclusions.write") && v.card.responses.length ? (
          <Button variant="ghost" size="xs" icon={<Ic.plus />} onClick={() => v.open("concl")}>
            {ut("pcard.newConclusion")}
          </Button>
        ) : undefined
      }
    >
      {!list.length ? (
        <p className="m-0 text-small text-muted">{ut("pcard.noConclusions")}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {list.map((c) => (
            <li key={c.id} className="border-t border-divider py-3.5 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-2">
                <b className="font-extrabold text-text">{conclusionName(c, { draft: ut("pcard.draft") })}</b>
                <span className="text-small text-muted">{dm(c.createdAt)}</span>
                {c.status === "signed" ? (
                  <Tag tone="good" icon={<Ic.check />}>
                    {ut("card.signed")}
                  </Tag>
                ) : (
                  <Tag icon={<Pi.filePen />}>{ut("card.draft")}</Tag>
                )}
                <span className="ml-auto flex items-center gap-2">
                  {c.status === "draft" && v.can("conclusions.write") ? (
                    <Button size="xs" onClick={() => v.open("concl", { responseId: c.responseId })}>
                      {ut("card.continue")}
                    </Button>
                  ) : null}
                  <Link to={`/responses/${c.responseId}/conclusion`} className="text-small font-bold text-violet-ink">
                    {ut("card.openDoc")}
                  </Link>
                </span>
              </div>
              {c.text ? <p className="m-0 mt-2 whitespace-pre-wrap text-[13px] leading-5 text-text-2">{c.text}</p> : null}
              <p className="m-0 mt-1.5 text-caption text-muted">
                {c.authorName}
                {c.signedAt ? `, ${dateTime(c.signedAt)}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const VISIT_KEY: Record<string, UiKey> = {
  booked: "card.vBooked",
  confirmed: "card.vConfirmed",
  arrived: "card.vArrived",
  in_progress: "card.vInProgress",
  done: "card.vDone",
  no_show: "card.vNoShow",
};

export function VisitsTab({ v }: { v: CardView }) {
  const { ut } = useLang();
  if (!v.timeline) return <Loading rows={4} />;
  const visits = [...v.visits].reverse();
  return (
    <Panel
      title={ut("card.tVisits")}
      icon={<Ic.calendar />}
      count={visits.length}
      flush
      actions={
        v.can("appointments.manage") ? (
          <Button variant="ghost" size="xs" icon={<Pi.calendarPlus />} onClick={() => v.open("book")}>
            {ut("card.bookTip")}
          </Button>
        ) : undefined
      }
    >
      {!visits.length ? (
        <p className="m-0 border-t border-divider px-4 py-3.5 text-small text-muted">{ut("card.noVisits")}</p>
      ) : (
        <ActivityList
          events={visits.map((x) => ({
            date: dm(x.at),
            time: timeOfDay(x.at),
            icon: x.status === "no_show" ? <Pi.calendarX /> : <Ic.calendar />,
            tone: x.status === "no_show" ? "warn" : x.status === "done" ? "good" : "neutral",
            text: (
              <>
                <b>{VISIT_KEY[x.status] ? ut(VISIT_KEY[x.status]!) : x.status}</b> <span className="text-muted">{x.specialist}</span>
              </>
            ),
            action: (
              <Link to={`/visit/${x.id}`} className="px-2 text-small font-bold text-violet-ink">
                {ut("card.open")}
              </Link>
            ),
          }))}
        />
      )}
    </Panel>
  );
}

export function MessagesTab({ v }: { v: CardView }) {
  const { ut } = useLang();
  const list = v.messages ?? [];
  return (
    <Panel
      title={ut("card.tMessages")}
      icon={<Pi.messageSquare />}
      count={list.length || null}
      actions={
        <>
          {v.thread ? <TextAction to={`/messages/${v.thread.id}`}>{ut("card.toMessages")}</TextAction> : null}
          {v.can("messages.write") ? (
            <Button variant="primary" size="xs" icon={<Ic.reply />} onClick={() => v.open("thread")}>
              {ut("card.write")}
            </Button>
          ) : null}
        </>
      }
    >
      {!v.messages && v.thread ? (
        <Loading rows={3} bare />
      ) : !list.length ? (
        <p className="m-0 text-small text-muted">{ut("card.noMessages")}</p>
      ) : (
        <div className="flex max-w-[720px] flex-col gap-2">
          {list.map((m) => (
            <div
              key={m.id}
              className={
                m.mine
                  ? "max-w-[84%] self-end rounded-[16px] rounded-br-[6px] bg-violet-tint px-[13px] py-[9px] text-[13px] leading-[19px] text-text"
                  : "max-w-[84%] self-start rounded-[16px] rounded-bl-[6px] bg-sunk px-[13px] py-[9px] text-[13px] leading-[19px] text-text"
              }
            >
              <span className="whitespace-pre-wrap">{m.text}</span>
              <small className="mt-[3px] block text-[11.5px] leading-[15px] text-muted">{dateTime(m.sentAt)}</small>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

const NOTE_KIND = { intake: "note.intake", session: "note.session", observation: "note.observation", consult: "note.consult" } as const;

export function NotesTab({ v }: { v: CardView }) {
  const { ut } = useLang();
  if (!v.notes) return <Loading rows={4} />;
  const list = v.notes.versions;
  return (
    <Panel
      title={ut("card.tNotes")}
      icon={<Pi.notebookText />}
      count={list.length}
      actions={
        v.can("notes.write") ? (
          <Button variant="primary" size="xs" icon={<Pi.notebookPen />} onClick={() => v.open("note")}>
            {ut("card.newNote")}
          </Button>
        ) : undefined
      }
    >
      {!list.length ? (
        <p className="m-0 text-small text-muted">{ut("card.noNotes")}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {list.map((n) => (
            <li key={n.id} className="border-t border-divider py-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <b className="font-extrabold text-text">{ut(NOTE_KIND[n.kind])}</b>
                <span className="text-small text-muted">
                  {ut("card.version").replace("{v}", String(n.version))}, {n.authorName}, {day(n.signedAt ?? n.createdAt)}
                </span>
                {n.status === "draft" ? <Tag>{ut("card.draft")}</Tag> : <Tag tone="good">{ut("card.signed")}</Tag>}
              </div>
              <p className="m-0 mt-1.5 whitespace-pre-wrap text-[13px] leading-5 text-text-2">{n.text}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function TimelineTab({ v }: { v: CardView }) {
  const { ut } = useLang();
  if (!v.timeline) return <Loading rows={6} />;
  const items = [...v.timeline].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return (
    <Panel
      title={ut("card.tTimeline")}
      icon={<Ic.history />}
      count={items.length}
      flush
      actions={<TextAction to={`/patients/${v.id}/case/timeline`}>{ut("qv.allTimeline")}</TextAction>}
    >
      {!items.length ? (
        <p className="m-0 border-t border-divider px-4 py-3.5 text-small text-muted">{ut("tl.empty")}</p>
      ) : (
        <ActivityList events={items.map((it) => eventOf(it, v, ut))} />
      )}
    </Panel>
  );
}
