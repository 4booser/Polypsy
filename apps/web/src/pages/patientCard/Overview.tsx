import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { DynamicsPoint, UiKey } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { CourseChart, CourseLegend } from "../../charts/course";
import { courseEventsFromTimeline, courseFromDynamics, courseNames, cutoffOf, laneEvents } from "../../charts/courseModel";
import { dateTime, day, locale, severityKey, timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { useResource, useResourceMap } from "../../useResource";
import { ActivityList, Ic, Loading, Popover, TextAction, type ActivityEvent } from "../../ui";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { ChangeCell, signed } from "../../ui/numbers";
import { Button, SeverityTag, Tag } from "../../ui/primitives";
import { shortTitle } from "./Banner";
import { itemsGrid, sinceEvents, type InstrumentRow, type ItemsGrid, type TimelineRow } from "./clinical";
import { daysBetween, dm, wdm } from "./format";
import { Pi } from "./icons";
import { fmtNum, shownNumber, shownStep, shownValue, signedShown } from "../patients/model";
import type { CardView } from "./types";

/*
 * Вкладка «Огляд» карточки — две колонки макета:
 *
 *   слева  — что случилось после последнего приёма, методики с большими
 *            числами, сдвигом и надёжностью, курс по шкале, ответы по пунктам;
 *   справа — ближайший приём с письмом и переносом, заключения, назначенное
 *            и план безпеки, последняя нотатка. Ящик действий ложится поверх
 *            этой колонки, а левая остаётся на виду.
 *
 * Чего нет, потому что приложение этого не хранит: плана сессии (пунктов
 * «обговорити на сесії 6»), цели курса и тренда-прогноза.
 */

export function Overview({ v }: { v: CardView }) {
  /*
   * Две колонки, пока в ширине есть место правой: 540 + остаток на 1440, а на
   * 1280 со списком (820 под запись) — гибкая левая и правая 300. Уже — одна
   * колонка, правые панели уходят вниз сеткой.
   */
  return (
    <div className="@container">
      <div className="grid items-start gap-5 @min-[780px]:grid-cols-[minmax(0,1fr)_300px] @min-[940px]:grid-cols-[minmax(0,540px)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <SincePanel v={v} />
          <InstrumentsPanel v={v} />
          <CoursePanel v={v} />
          <ItemsPanel v={v} />
        </div>
        <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] items-start gap-4">
          <NextVisitPanel v={v} />
          <ConclusionsPanel v={v} />
          <AssignedPanel v={v} />
          <LastNotePanel v={v} />
        </div>
      </div>
    </div>
  );
}

/* ─────────── після сесії ─────────── */

const KIND_ICON: Record<string, ReactNode> = {
  visit: <Ic.calendar />,
  response: <Pi.clipboardCheck />,
  alert: <Ic.alert />,
  referral: <Ic.arrowRight />,
  conclusion: <Pi.filePen />,
  assignment: <Pi.clipboardClock />,
};

export function eventOf(it: TimelineRow, v: CardView, ut: (k: UiKey) => string): ActivityEvent {
  const base = { date: dm(it.at), time: timeOfDay(it.at), icon: KIND_ICON[it.kind] ?? <Ic.info /> };
  switch (it.kind) {
    case "alert":
      return {
        ...base,
        tone: "risk",
        text: (
          <>
            <b>{ut("card.evSignal")}</b>: {it.title}
          </>
        ),
        action:
          v.cases?.length && v.can("alerts.review") ? (
            <Button variant="ghost" size="xs" onClick={() => v.open("signal")}>
              {ut("card.review")}
            </Button>
          ) : undefined,
      };
    case "visit": {
      const status = it.detail ?? "";
      const noshow = status === "no_show";
      return {
        ...base,
        tone: noshow ? "warn" : status === "done" ? "good" : "neutral",
        icon: noshow ? <Pi.calendarX /> : <Ic.calendar />,
        text: (
          <>
            <b>{ut(noshow ? "card.evNoShow" : status === "done" ? "card.evVisitDone" : "card.evVisit")}</b>{" "}
            <span className="text-muted">{it.title}</span>
          </>
        ),
        action: noshow && v.can("appointments.manage") ? (
          <Button variant="ghost" size="xs" onClick={() => v.open("book")}>
            {ut("card.bookAgain")}
          </Button>
        ) : undefined,
      };
    }
    case "response":
      return {
        ...base,
        text: (
          <>
            {ut("card.evResponse")} <b>{it.title}</b>
          </>
        ),
      };
    case "conclusion":
      return {
        ...base,
        tone: it.detail === "signed" ? "good" : "neutral",
        text: (
          <>
            <b>{ut(it.detail === "signed" ? "card.evConclSigned" : "card.evConclDraft")}</b>{" "}
            <span className="text-muted">{it.title}</span>
          </>
        ),
      };
    case "assignment":
      return {
        ...base,
        text: (
          <>
            {ut("card.evAssigned")} <b>{it.title}</b>
            {it.dueAt ? <span className="text-muted"> {ut("card.dueOn").replace("{d}", dm(it.dueAt))}</span> : null}
          </>
        ),
      };
    case "referral":
      return {
        ...base,
        text: (
          <>
            {ut("card.evReferral")} <span className="text-muted">{it.detail}</span>
          </>
        ),
      };
    default:
      return { ...base, text: it.title };
  }
}

function SincePanel({ v }: { v: CardView }) {
  const { ut } = useLang();
  if (!v.timeline) {
    return (
      <Panel title={ut("card.lastDays")} icon={<Ic.history />}>
        <Loading rows={3} bare />
      </Panel>
    );
  }
  const since = v.last ? Date.parse(v.last.visit.at) : null;
  const items = sinceEvents(v.timeline, since, v.now).slice(-8);
  const events = items.map((it) => eventOf(it, v, ut));
  /* письмо без ответа — тоже событие «после сессии», хотя в хронологии его нет */
  const lastIn = [...(v.messages ?? [])].reverse().find((m) => !m.mine);
  if (v.thread && v.thread.unread > 0 && lastIn && (since === null || Date.parse(lastIn.sentAt) > since)) {
    events.push({
      date: dm(lastIn.sentAt),
      time: timeOfDay(lastIn.sentAt),
      icon: <Ic.message />,
      text: (
        <>
          <span className="line-clamp-2">«{lastIn.text}»</span> <span className="text-muted">{ut("card.noReply")}</span>
        </>
      ),
      action: v.can("messages.write") ? (
        <Button variant="ghost" size="xs" onClick={() => v.open("thread")}>
          {ut("card.reply")}
        </Button>
      ) : undefined,
    });
  }
  return (
    <Panel
      title={v.last ? ut("card.afterSession").replace("{n}", String(v.last.n)) : ut("card.lastDays")}
      icon={<Ic.history />}
      sub={v.last ? `${dm(v.last.visit.at)}, ${agoText(daysBetween(v.last.visit.at, v.now), ut)}` : undefined}
      actions={<TextAction onClick={() => v.goTab("timeline")}>{ut("card.tTimeline")}</TextAction>}
      flush
    >
      {events.length ? (
        <ActivityList events={events} />
      ) : (
        <p className="m-0 border-t border-divider px-4 py-3.5 text-small text-muted">{ut("card.quiet")}</p>
      )}
    </Panel>
  );
}

/** «сьогодні», «учора», «13 дн. тому» */
function agoText(days: number, ut: (k: UiKey) => string): string {
  if (days <= 0) return ut("card.today");
  if (days === 1) return ut("card.yesterday");
  return ut("card.daysAgo").replace("{n}", String(days));
}

/* ─────────── методики ─────────── */

/** Значение замера так, как его читают: доля — процентом («49%», а не «0,49»), дробь — с запятой языка */
const valueOf = (p: DynamicsPoint) => shownValue(p.rawScore, p.normalization);

/** Сдвиг от замера `from` до `p` словом: у доли — процентные пункты */
function stepOf(p: DynamicsPoint, from: DynamicsPoint, pp: string): string {
  const d = shownStep(p.rawScore - from.rawScore, p.normalization);
  return `${signedShown(d)}${d && p.normalization === "ratio" ? ` ${pp}` : ""}`;
}

function sevOf(p: DynamicsPoint, ut: (k: UiKey) => string) {
  if (!p.severity) return null;
  return { word: p.bandLabel ?? ut(severityKey[p.severity]), level: p.severity };
}

function InstrumentsPanel({ v }: { v: CardView }) {
  const { ut } = useLang();
  const [open, setOpen] = useState<string | null>(null);
  if (!v.dynamics) {
    return (
      <Panel title={ut("card.instruments")} icon={<Ic.clipboard />}>
        <Loading rows={4} bare error={v.dynamicsError} onRetry={v.reloadDynamics} />
      </Panel>
    );
  }
  const rows = v.rows;
  return (
    <Panel
      title={ut("card.instruments")}
      icon={<Ic.clipboard />}
      sub={rows.length ? ut("card.instrSub").replace("{n}", String(v.card.responses.length)) : undefined}
      flush
      footer={
        rows.length ? (
          <span className="flex items-start gap-1.5 text-caption text-muted">
            <Ic.info size={13} className="mt-px" />
            {ut("card.instrFoot")}
          </span>
        ) : undefined
      }
    >
      {!rows.length ? (
        <p className="m-0 border-t border-divider px-4 py-3.5 text-small text-muted">{ut("pcard.noTests")}</p>
      ) : (
        <div className="@container">
          <table className="w-full table-fixed border-collapse text-body">
            {/*
              Числа — узкими колонками постоянной ширины, имя — всем, что
              осталось, и в две строки: на 1280 со списком (500 px) шесть
              колонок по-старому оставляли имени 110 px, и «Поведінкова
              регуляція» читалась как «Поведінк…».
            */}
            <colgroup>
              <col />
              <col className="w-[38px]" />
              <col className="w-[38px]" />
              <col className="w-[60px]" />
              <col className="w-[88px]" />
              <col className="w-[104px] @max-[530px]:w-[96px]" />
            </colgroup>
            <thead>
              <tr className="[&>th]:h-[34px] [&>th]:border-y [&>th]:border-divider [&>th]:bg-panel-2 [&>th]:px-1 [&>th]:text-left [&>th]:text-caption [&>th]:font-bold [&>th]:leading-[14px] [&>th]:text-muted">
                <th className="!pl-3">{ut("card.colInstrument")}</th>
                <th className="!text-right" colSpan={2}>
                  {ut("card.colBefore")}
                </th>
                <th className="!pr-1.5 !text-right !text-text">{ut("card.colNow")}</th>
                <th className="!pl-2">{ut("card.colSeverity")}</th>
                <th className="!pl-2 !pr-2.5 !whitespace-normal">{ut("card.colChange")}</th>
              </tr>
            </thead>
            {/* шкалы одной методики — группой строк под её названием, а не обрезком названия под каждой */}
            {groupsOf(rows).map((g) => (
              <tbody key={g[0]!.key}>
                {g.length > 1 ? (
                  <tr>
                    <th colSpan={6} scope="rowgroup" className="border-b border-divider px-3 pb-1 pt-2.5 text-left text-caption font-bold text-text-2">
                      {g[0]!.surveyTitle}
                    </th>
                  </tr>
                ) : null}
                {g.map((r) => (
                  <InstrumentLine key={r.key} r={r} grouped={g.length > 1} open={open === r.key} onToggle={() => setOpen(open === r.key ? null : r.key)} />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </Panel>
  );
}

/** Строки таблицы методик по методикам подряд: шкалы одной методики идут вместе (clinical.ts, instrumentRows) */
function groupsOf(rows: readonly InstrumentRow[]): InstrumentRow[][] {
  const out: InstrumentRow[][] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last && last[0]!.surveyId === r.surveyId) last.push(r);
    else out.push([r]);
  }
  return out;
}

function InstrumentLine({
  r,
  grouped,
  open,
  onToggle,
}: {
  r: InstrumentRow;
  /** Методика названа строкой над группой — под именем шкалы её не повторять */
  grouped: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { ut } = useLang();
  const pts = r.points.slice(-3);
  const last = pts[pts.length - 1]!;
  const before = pts.slice(0, -1);
  const sev = sevOf(last, ut);
  const xid = `xr-${r.key.replace(/[^a-z0-9]/gi, "")}`;
  const basis = r.scale.reliableChange?.basis ?? null;
  return (
    <>
      <tr className={cx("group [&>td]:h-[66px] [&>td]:border-b [&>td]:border-divider [&>td]:px-1 [&>td]:py-2 [&>td]:align-middle", open ? "[&>td]:bg-panel-2 [&>td]:border-b-transparent" : "hover:[&>td]:bg-panel-2")}>
        <td className="!pl-1.5">
          <div className="flex items-start gap-1">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={xid}
              aria-label={ut("card.expandRow").replace("{s}", r.code)}
              onClick={onToggle}
              className={cx(
                "inline-grid size-6 shrink-0 cursor-pointer place-items-center rounded-[7px] border-0 text-muted",
                open ? "bg-violet-tint text-violet-ink" : "bg-transparent hover:bg-sunk hover:text-text",
              )}
            >
              <Ic.chevronRight size={14} className={cx("transition-transform", open && "rotate-90")} />
            </button>
            <span className="min-w-0 pt-px">
              {/* имя — в две строки; что не влезло — в подсказке и в раскрытии строки */}
              <b className="line-clamp-2 break-words font-extrabold leading-[17px] text-text" title={r.code}>
                {r.code}
              </b>
              <span className="mt-0.5 flex min-w-0 items-baseline gap-x-1.5 text-caption text-muted">
                {r.better ? (
                  <span className="shrink-0 whitespace-nowrap text-[11.5px] font-bold">
                    {ut(r.better === "down" ? "kit.betterDown" : "kit.betterUp")}
                  </span>
                ) : null}
                {grouped ? null : (
                  <span className="min-w-0 truncate" title={r.title}>
                    {r.title}
                  </span>
                )}
              </span>
            </span>
          </div>
        </td>
        {[0, 1].map((i) => {
          const p = before[before.length - 2 + i];
          return (
            <td key={i} className="text-right">
              {p ? <ValuePop r={r} p={p} small /> : null}
            </td>
          );
        })}
        <td className="!pr-1.5 text-right">
          <ValuePop r={r} p={last} />
        </td>
        <td className="!pl-2">
          {sev ? (
            <SeverityTag level={sev.level} small className="!h-auto min-h-[22px] !whitespace-normal py-[3px] leading-[14px]">
              {sev.word}
            </SeverityTag>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
        <td className="!pl-2 !pr-2.5">
          <ChangeOf r={r} />
        </td>
      </tr>
      {open ? (
        <tr id={xid}>
          <td colSpan={6} className="border-b border-divider bg-panel-2 px-3.5 pb-3.5 pl-9 text-small text-text-2">
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              {r.code !== r.surveyTitle && r.title !== r.surveyTitle ? (
                <>
                  <dt className="font-bold text-muted">{ut("card.xSurvey")}</dt>
                  <dd className="m-0">{r.surveyTitle}</dd>
                </>
              ) : null}
              {r.folded.length ? (
                <>
                  <dt className="font-bold text-muted">{ut("card.xScales")}</dt>
                  <dd className="m-0">
                    <ul className="m-0 list-none p-0">
                      {r.folded.map((sc) => {
                        const p = [...sc.points].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt)).at(-1)!;
                        const s = valueOf(p);
                        return (
                          <li key={sc.scaleId} className="py-px">
                            {sc.title}: <b className="font-extrabold text-text">{`${s.text}${s.unit}`}</b>
                            {p.bandLabel ? <span className="text-muted">, {p.bandLabel}</span> : null}
                          </li>
                        );
                      })}
                    </ul>
                  </dd>
                </>
              ) : null}
              <dt className="font-bold text-muted">{ut("card.xCount")}</dt>
              <dd className="m-0">
                {r.points.length}
                {r.points.length > 1
                  ? `: ${r.points
                      .map((p) => {
                        const s = valueOf(p);
                        return `${s.text}${s.unit}`;
                      })
                      .join(" → ")}`
                  : ""}
              </dd>
              <dt className="font-bold text-muted">{ut("card.xFirst")}</dt>
              <dd className="m-0">{dateTime(r.points[0]!.submittedAt)}</dd>
              {basis ? (
                <>
                  <dt className="font-bold text-muted">{ut("card.xBasis")}</dt>
                  <dd className="m-0">
                    {ut("card.xBasisLine")
                      .replace("{sd}", shownNumber(basis.sd))
                      .replace("{a}", fmtNum(Math.round(basis.alpha * 100) / 100, locale()))
                      .replace("{n}", String(basis.sampleN))}
                  </dd>
                </>
              ) : null}
              {r.incomparable ? (
                <>
                  <dt className="font-bold text-muted">{ut("card.xIncomparable")}</dt>
                  <dd className="m-0">{ut(INCOMPARABLE[r.incomparable])}</dd>
                </>
              ) : null}
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}

const INCOMPARABLE = { version: "rch.versions", units: "rch.units", unreliable: "rch.unreliable" } as const;

function ChangeOf({ r }: { r: InstrumentRow }) {
  const { ut } = useLang();
  const unit = r.points[r.points.length - 1]!.normalization === "ratio" ? ` ${ut("card.pp")}` : "";
  if (r.points.length < 2) return <span className="text-small text-text-2">{ut("kit.courseStart")}</span>;
  if (r.delta === null) return <span className="text-small text-muted">{r.incomparable ? ut(INCOMPARABLE[r.incomparable]) : "—"}</span>;
  if (r.threshold !== null && r.better) return <ChangeCell delta={r.delta} threshold={r.threshold} better={r.better} unit={unit} />;
  return (
    <span className="flex flex-col gap-px text-small text-text-2">
      <span className="text-[15px] font-extrabold leading-[18px] text-text">
        {signedShown(r.delta)}
        {r.delta ? unit : ""}
      </span>
      {r.threshold === null ? ut("course.v.unknown") : ut("course.v.changed")}
    </span>
  );
}

/** Число замера с поповером: дата, балл, полоса словом, сдвиг от старта и от предыдущего */
function ValuePop({ r, p, small }: { r: InstrumentRow; p: DynamicsPoint; small?: boolean }) {
  const { ut } = useLang();
  const i = r.points.indexOf(p);
  const first = r.points[0]!;
  const prev = i > 0 ? r.points[i - 1] : null;
  const value = valueOf(p);
  const pp = ut("card.pp");
  const sev = sevOf(p, ut);
  /* «39,8» (Т-бал) в колонку «Зараз» крупным не встаёт — длинное число на ступень мельче */
  const long = value.text.length + value.unit.length > 3;
  const num = (
    <span
      tabIndex={0}
      className={cx(
        "inline-flex cursor-default flex-col items-end rounded-[6px] py-0.5 outline-none hover:bg-violet-tint hover:text-violet-ink focus-visible:shadow-[0_0_0_2px_var(--vring)]",
        small ? "px-0.5 text-text-2" : "px-1 text-text",
      )}
    >
      <span
        className={cx(
          "tabular-nums",
          small ? "text-body font-semibold" : cx("font-extrabold leading-none tracking-[-0.03em]", long ? "text-[24px]" : "text-[30px]"),
        )}
      >
        {value.text}
        {value.unit ? <small className="ml-px text-[14px] font-bold tracking-normal text-muted">{value.unit}</small> : null}
      </span>
      <span className="text-[11px] font-semibold leading-4 text-muted">{dm(p.submittedAt)}</span>
    </span>
  );
  return (
    <Popover
      title={`${r.code}, ${dm(p.submittedAt)}`}
      note={i === 0 ? ut("course.start") : i === r.points.length - 1 ? ut("course.last") : undefined}
      content={
        <div className="flex flex-col gap-1.5">
          <p className="m-0 flex flex-wrap items-center gap-1.5">
            <b className="font-extrabold text-text">
              {value.text}
              {value.unit}
            </b>
            {sev ? (
              <SeverityTag level={sev.level} small>
                {sev.word}
              </SeverityTag>
            ) : null}
          </p>
          {i > 0 && r.delta !== null ? (
            <p className="m-0">
              {ut("course.fromStart")}: <b className="font-extrabold text-text">{stepOf(p, first, pp)}</b>
              {r.threshold !== null
                ? `, ${ut("course.threshold").replace("{n}", `${shownNumber(r.threshold)}${p.normalization === "ratio" ? ` ${pp}` : ""}`)}`
                : ""}
            </p>
          ) : (
            <p className="m-0 text-muted">{i === 0 ? ut("course.baseline") : null}</p>
          )}
          {prev ? (
            <p className="m-0 text-muted">
              {ut("course.fromPrev").replace("{d}", dm(prev.submittedAt))}: {stepOf(p, prev, pp)}
            </p>
          ) : null}
        </div>
      }
    >
      {num}
    </Popover>
  );
}

/* ─────────── курс ─────────── */

/**
 * «Курс»: малые графики методик с повторными замерами — один под другим, а
 * не переключателем: прежде врач видел одну методику и не знал, что по
 * соседней человеку стало хуже, пока не нажимал по очереди. Не больше трёх,
 * свежие первыми (порядок таблицы «Методики»); все шкалы — во вкладке
 * «Графіки». Легенда значков — одна на панель.
 */
const COURSE_MAX = 3;

function CoursePanel({ v }: { v: CardView }) {
  const { ut } = useLang();
  const events = useMemo(() => courseEventsFromTimeline(v.timeline ?? []), [v.timeline]);
  if (!v.dynamics) return null;
  const rows = v.rows.filter((r) => r.points.length > 1).slice(0, COURSE_MAX);
  if (!rows.length) return null;
  const charts = rows.map((r) => ({
    r,
    data: courseFromDynamics(r.scale, r.rungs, undefined, { surveyId: r.surveyId }),
    /* у свёрнутой методики график — её самой тяжёлой шкалы, и шапка называет шкалу */
    names: courseNames(r.surveyTitle, r.scale.title, !r.folded.length && v.rows.filter((x) => x.surveyId === r.surveyId).length === 1),
  }));
  const signals = new Set(events.filter((e) => e.kind === "signal").map((e) => e.responseId));
  return (
    <Panel
      title={ut("card.course")}
      icon={<Pi.chartSpline />}
      actions={<TextAction onClick={() => v.goTab("dynamics")}>{ut("card.tDynamics")}</TextAction>}
    >
      <div className="flex flex-col gap-4">
        {charts.map(({ r, data, names }, i) => (
          <div key={r.key} className={cx(i > 0 && "border-t border-divider pt-4")}>
            <CourseChart title={r.code} measure={names.measure} method={names.method} {...data} events={events} size="compact" legend={false} />
          </div>
        ))}
      </div>
      <CourseLegend
        cutoff={charts.some((c) => cutoffOf(c.data.rungs)) || null}
        signal={charts.some((c) => c.data.points.some((p) => signals.has(p.key)))}
        lane={charts.flatMap((c) => laneEvents(c.data.points, events)).filter((e, i, all) => all.indexOf(e) === i)}
      />
    </Panel>
  );
}

/* ─────────── пункти ─────────── */

/** Методика таблицы пунктов: та, по которой открыт сигнал; иначе — самая свежая с повторами */
function focusSurvey(v: CardView): string | null {
  const signal = v.cases?.[0]?.surveyId;
  if (signal && v.dynamics?.surveys.some((s) => s.surveyId === signal)) return signal;
  const withRepeat = v.rows.find((r) => r.points.length > 1);
  return withRepeat?.surveyId ?? v.rows[0]?.surveyId ?? null;
}

function ItemsPanel({ v }: { v: CardView }) {
  const surveyId = focusSurvey(v);
  const ids = useMemo(() => {
    const sv = v.dynamics?.surveys.find((s) => s.surveyId === surveyId);
    if (!sv) return [] as string[];
    const at = new Map<string, number>();
    for (const sc of sv.scales) for (const p of sc.points) at.set(p.responseId, Date.parse(p.submittedAt));
    return [...at.keys()].sort((a, b) => at.get(a)! - at.get(b)!).slice(-4);
  }, [v.dynamics, surveyId]);
  const details = useResourceMap("rd", ids, api.responseDetail);
  const ready = ids.length > 0 && ids.every((id) => id in details);
  const grid = useMemo(
    () => (ready ? itemsGrid(ids.map((id) => details[id]).filter((d): d is NonNullable<typeof d> => !!d)) : null),
    [ready, ids, details],
  );
  if (!surveyId || !ids.length) return null;
  const sv = v.dynamics?.surveys.find((s) => s.surveyId === surveyId);
  const code = shortTitle(sv?.title ?? "");
  return <ItemsTable v={v} code={code} grid={grid} loading={!ready} surveyId={surveyId} />;
}

const LONG = 12;

type ItemRowT = ItemsGrid["rows"][number];

/** Слово ответа в клетке — коротко: «Так», «Ні», первые буквы длинного */
const shortWord = (w: string | null) => (w === null ? "—" : w.length > 5 ? `${w.slice(0, 4)}…` : w);

function ItemsTable({ v, code, grid, loading, surveyId }: { v: CardView; code: string; grid: ItemsGrid | null; loading: boolean; surveyId: string }) {
  const { ut } = useLang();
  const [all, setAll] = useState(false);
  const { can } = useAuth();
  const caseHere = v.cases?.some((c) => c.surveyId === surveyId);
  if (loading) {
    return (
      <Panel title={ut("card.itemsOf").replace("{s}", code)} icon={<Pi.listOrdered />}>
        <Loading rows={4} bare />
      </Panel>
    );
  }
  if (!grid) return null;
  const n = grid.columns.length;
  const cat = grid.categorical;
  const at = (r: ItemRowT, j: number) => (cat ? r.words[j] : r.cells[j]) ?? null;
  const changed = (r: ItemRowT) => n > 1 && at(r, n - 1) !== at(r, n - 2);
  const hot = (r: ItemRowT) => (cat ? !!r.flags[n - 1] : r.critical && (r.cells[n - 1] ?? 0) > 0);
  const long = grid.rows.length > LONG;
  const shown = all || !long ? grid.rows : grid.rows.filter((r) => hot(r) || changed(r));
  const level = (val: number) => (val <= 0 ? 0 : Math.min(5, Math.max(1, Math.round((val / Math.max(grid.max, 1)) * 5 + 0.49))));
  const cell = (r: ItemRowT | null, j: number, val: number | null) => {
    const flagged = r ? (cat ? !!r.flags[j] : r.critical && val !== null && val > 0) : false;
    if ((cat ? r?.words[j] : val) === null || (cat ? r?.words[j] : val) === undefined)
      return { cls: "bg-transparent text-muted shadow-[inset_0_0_0_1px_var(--border)]", style: undefined };
    if (flagged) return { cls: "bg-risk text-onfill", style: undefined };
    if (cat) return { cls: "bg-sunk text-text-2", style: undefined };
    const k = level(val ?? 0);
    return k === 0 ? { cls: "bg-sunk text-muted", style: undefined } : { cls: "", style: { background: `var(--h${k})`, color: `var(--h${k}i)` } };
  };
  const delta = (r: ItemRowT) => {
    const a = r.cells[0];
    const b = r.cells[n - 1];
    return a === null || a === undefined || b === null || b === undefined || n < 2 ? null : b - a;
  };
  const sumDelta = !cat && n > 1 && grid.sums[0] !== null && grid.sums[n - 1] !== null ? grid.sums[n - 1]! - grid.sums[0]! : null;
  return (
    <Panel
      title={ut("card.itemsOf").replace("{s}", code)}
      icon={<Pi.listOrdered />}
      flush
      footer={
        <div className="flex w-full flex-wrap items-center gap-x-3.5 gap-y-1.5 text-caption font-semibold text-text-2">
          {cat ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="grid h-5 min-w-6 place-items-center rounded-[6px] bg-risk px-1 text-[11px] font-bold text-onfill" aria-hidden>
                !
              </span>
              {ut("card.criticalAnswer")}
            </span>
          ) : (
            grid.legend.map((l, i) => {
              const c = cell(null, 0, l.value);
              return (
                <span key={`${l.value}-${i}`} className="inline-flex items-center gap-1.5">
                  <span className={cx("grid h-5 min-w-6 place-items-center rounded-[6px] px-1 text-[11px] font-bold", c.cls)} style={c.style}>
                    {l.value}
                  </span>
                  {l.label}
                </span>
              );
            })
          )}
          {long ? (
            <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setAll((x) => !x)}>
              {all ? ut("card.itemsChanged") : ut("card.itemsAll").replace("{n}", String(grid.rows.length))}
            </Button>
          ) : null}
        </div>
      }
    >
      <table className="w-full table-fixed border-collapse text-[13px]">
        <colgroup>
          <col />
          {grid.columns.map((c) => (
            <col key={c.responseId} className="w-[52px]" />
          ))}
          {/* «Изменение» по-русски в 58 px не помещалось и резалось краем панели */}
          {cat ? null : <col className="w-[80px]" />}
        </colgroup>
        <thead>
          <tr className="[&>th]:h-[34px] [&>th]:border-y [&>th]:border-divider [&>th]:bg-panel-2 [&>th]:px-1 [&>th]:text-center [&>th]:text-[11.5px] [&>th]:font-bold [&>th]:text-muted">
            <th className="!pl-4 !text-left">{ut("cases.item")}</th>
            {grid.columns.map((c, j) => (
              <th key={c.responseId} className={j === n - 1 ? "!text-text" : undefined}>
                {dm(c.at)}
              </th>
            ))}
            {cat ? null : <th className="!pr-3.5">{ut("card.colDelta")}</th>}
          </tr>
        </thead>
        <tbody>
          {!shown.length ? (
            <tr>
              <td colSpan={n + 2} className="border-b border-divider px-4 py-3 text-small text-muted">
                {ut("card.itemsQuiet")}
              </td>
            </tr>
          ) : null}
          {shown.map((r) => {
            const d = delta(r);
            const critNow = hot(r);
            return (
              <tr
                key={r.questionId}
                className={cx("[&>td]:h-9 [&>td]:border-b [&>td]:px-1 [&>td]:text-center", critNow ? "[&>td]:border-risk-line [&>td]:bg-risk-tint" : "[&>td]:border-divider")}
              >
                <td className={cx("!pl-4 !text-left font-semibold", critNow ? "font-extrabold text-risk-ink" : "text-text-2")}>
                  <span className="flex min-w-0 items-center">
                    <i className={cx("inline-block w-6 shrink-0 font-bold not-italic", critNow ? "text-risk-ink" : "text-muted")}>{r.n}</i>
                    <Popover
                      title={ut("card.itemN").replace("{n}", String(r.n))}
                      note={r.critical ? ut("card.critical") : undefined}
                      content={<ItemPeek r={r} grid={grid} />}
                    >
                      <span tabIndex={0} className="min-w-0 cursor-default truncate border-b border-dotted border-ctl outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]">
                        {r.title}
                      </span>
                    </Popover>
                    {critNow && caseHere && can("alerts.review") && r === shown.find(hot) ? (
                      <Button variant="ghost" size="xs" className="ml-auto h-7 shrink-0 !text-risk-ink" onClick={() => v.open("signal")}>
                        {ut("card.review")}
                      </Button>
                    ) : null}
                  </span>
                </td>
                {r.cells.map((val, j) => {
                  const c = cell(r, j, val);
                  const word = r.words[j];
                  return (
                    <td key={grid.columns[j]!.responseId}>
                      <Popover
                        title={r.title}
                        note={dm(grid.columns[j]!.at)}
                        content={<p className="m-0">{cat ? (word ?? "—") : val === null ? "—" : `${val}${word ? `, ${word}` : ""}`}</p>}
                      >
                        <span
                          tabIndex={0}
                          className={cx(
                            "inline-grid h-6 min-w-8 cursor-default place-items-center rounded-[8px] px-1 text-caption font-bold outline-none hover:shadow-[0_0_0_2px_var(--panel),0_0_0_3.5px_var(--vring)] focus-visible:shadow-[0_0_0_2px_var(--panel),0_0_0_3.5px_var(--vring)]",
                            c.cls,
                          )}
                          style={c.style}
                        >
                          {cat ? shortWord(word) : val === null ? "—" : val}
                        </span>
                      </Popover>
                    </td>
                  );
                })}
                {cat ? null : (
                  <td className="!pr-3.5">
                    <span
                      className={cx(
                        "text-small font-bold",
                        d === null || d === 0 ? "text-muted" : r.critical && d > 0 ? "text-risk-ink" : d < 0 ? "text-good" : "text-muted",
                      )}
                    >
                      {d === null ? "—" : d === 0 ? "0" : signed(d)}
                    </span>
                  </td>
                )}
              </tr>
            );
          })}
          {cat ? null : (
            <tr className="[&>td]:h-10 [&>td]:px-1 [&>td]:text-center [&>td]:font-extrabold [&>td]:text-text">
              <td className="!pl-4 !text-left">{ut("card.sum")}</td>
              {grid.sums.map((s, j) => (
                <td key={grid.columns[j]!.responseId} className="tabular-nums">
                  {s ?? "—"}
                </td>
              ))}
              <td className="!pr-3.5">
                <span className="text-small font-bold text-muted">{sumDelta === null ? "—" : sumDelta === 0 ? "0" : signed(sumDelta)}</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function ItemPeek({ r, grid }: { r: ItemsGrid["rows"][number]; grid: ItemsGrid }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 text-text">{r.title}</p>
      <ul className="m-0 list-none p-0">
        {grid.columns.map((c, j) => (
          <li key={c.responseId} className="py-0.5">
            {dm(c.at)}:{" "}
            {grid.categorical ? (
              <b className="font-extrabold text-text">{r.words[j] ?? "—"}</b>
            ) : (
              <>
                <b className="font-extrabold text-text">{r.cells[j] ?? "—"}</b> {r.words[j] ? <span className="text-muted">{r.words[j]}</span> : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─────────── наступний прийом ─────────── */

function NextVisitPanel({ v }: { v: CardView }) {
  const { ut } = useLang();
  const { user } = useAuth();
  const next = v.next;
  const ctx = useResource(() => (next ? api.visitContext(next.id).catch(() => null) : Promise.resolve(null)), [next?.id], {
    enabled: !!next,
  });
  const slots = useResource(
    () => (user ? api.freeSlots({ specialistId: user.id }).then((r) => r.items).catch(() => []) : Promise.resolve([])),
    [user?.id],
    { enabled: !!next && v.nextIsMine && v.can("appointments.manage") },
  );
  const lastIn = [...(v.messages ?? [])].reverse().find((m) => !m.mine);
  const unread = !!v.thread && v.thread.unread > 0 && !!lastIn;
  const near = useMemo(() => nearSlots(slots.data ?? [], next?.at ?? null), [slots.data, next?.at]);

  if (!next) {
    return (
      <Panel title={ut("card.nextVisit")} icon={<Pi.calendarClock />}>
        <p className="m-0 text-small text-text-2">{ut("card.noNextVisit")}</p>
        {v.can("appointments.manage") ? (
          <Button variant="primary" className="mt-3" icon={<Pi.calendarPlus />} onClick={() => v.open("book")}>
            {ut("card.bookTip")}
          </Button>
        ) : null}
      </Panel>
    );
  }
  const a = ctx.data?.appointment;
  return (
    <Panel
      title={ut("card.nextVisit")}
      icon={<Pi.calendarClock />}
      actions={v.last ? <span className="pr-1.5 text-small text-muted">{ut("card.sessionN").replace("{n}", String(v.last.n + 1))}</span> : undefined}
    >
      <div className="text-[22px] font-extrabold leading-7 tracking-[-0.02em] text-text">
        {wdm(next.at)}, {timeOfDay(next.at)}
        {a ? `–${timeOfDay(a.endsAt)}` : ""}
      </div>
      <div className="mt-1 text-small text-text-2">
        {[
          a ? ut(a.mode === "remote" ? "card.online" : "card.onsite") : null,
          a ? ut(a.kind === "primary" ? "card.nxPrimary" : "card.nxRepeat") : null,
          v.nextIsMine ? null : next.specialist,
        ]
          .filter(Boolean)
          .join(", ")}
      </div>
      {unread ? (
        <div className="mt-3.5 rounded-[14px] rounded-bl-[6px] bg-sunk px-3.5 py-3 text-[13px] leading-[19px] text-text">
          «{lastIn!.text}»
          <div className="mt-2 flex items-center gap-1.5 text-caption text-muted">
            <Ic.message size={13} />
            {dm(lastIn!.sentAt)}, {timeOfDay(lastIn!.sentAt)}
            <Tag tone="attention" className="ml-auto">
              {ut("card.noReply")}
            </Tag>
          </div>
        </div>
      ) : null}
      {v.nextIsMine && v.can("appointments.manage") ? (
        near.length ? (
          <>
            <div className="mt-3.5 text-caption font-bold text-muted">{ut("card.freeNear")}</div>
            <div className="mt-2 grid grid-cols-3 gap-2" role="group" aria-label={ut("card.freeNear")}>
              {near.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={v.slotId === s.id}
                  onClick={() => v.setSlotId(v.slotId === s.id ? null : s.id)}
                  className={cx(
                    "grid h-10 min-h-0 cursor-pointer place-items-center rounded-control border-0 text-body font-extrabold leading-none",
                    "outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]",
                    v.slotId === s.id ? "bg-violet text-onfill shadow-primary" : "bg-sunk text-text hover:bg-sunk-2",
                  )}
                >
                  <span>
                    {timeOfDay(s.startsAt)}
                    <small className="block text-[11px] font-semibold opacity-80">{dm(s.startsAt)}</small>
                  </span>
                </button>
              ))}
            </div>
            {v.can("messages.write") ? (
              <Button variant="primary" className="mt-3 w-full" icon={<Ic.calendar />} onClick={() => v.open("thread", { slotId: v.slotId ?? undefined })}>
                {ut(v.slotId ? "card.moveAndReply" : "card.replyOrMove")}
              </Button>
            ) : null}
          </>
        ) : slots.data ? (
          <p className="m-0 mt-3 text-small text-muted">{ut("card.noFree")}</p>
        ) : null
      ) : null}
    </Panel>
  );
}

/** Свободные окна ближе всего ко времени приёма (сначала тот же день), по времени */
export function nearSlots<T extends { startsAt: string }>(slots: readonly T[], at: string | null, count = 3): T[] {
  if (!at) return [];
  const t = Date.parse(at);
  const sameDay = (s: T) => new Date(s.startsAt).toDateString() === new Date(t).toDateString();
  return [...slots]
    .filter((s) => Date.parse(s.startsAt) > Date.now())
    .sort((a, b) => Number(sameDay(b)) - Number(sameDay(a)) || Math.abs(Date.parse(a.startsAt) - t) - Math.abs(Date.parse(b.startsAt) - t))
    .slice(0, count)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}


/* ─────────── заключення ─────────── */

function ConclusionsPanel({ v }: { v: CardView }) {
  const { ut } = useLang();
  const list = v.card.conclusions;
  return (
    <Panel
      title={ut("pcard.conclusions")}
      icon={<Ic.file />}
      actions={
        v.can("conclusions.write") && v.card.responses.length ? (
          <Button variant="ghost" size="xs" icon={<Ic.plus />} onClick={() => v.open("concl")}>
            {ut("card.newConcl")}
          </Button>
        ) : undefined
      }
    >
      {!list.length ? (
        <p className="m-0 text-small text-muted">{ut("pcard.noConclusions")}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {list.slice(0, 3).map((c) => (
            <li key={c.id} className="border-t border-divider py-3 first:border-t-0 first:pt-0.5">
              <div className="flex items-center gap-2">
                <b className="min-w-0 truncate font-extrabold text-text">
                  {shortTitle(c.surveyTitle)}, {dm(c.createdAt)}
                </b>
                {c.status === "draft" ? (
                  <Tag icon={<Pi.filePen />}>{ut("card.draft")}</Tag>
                ) : (
                  <Tag tone="good" icon={<Ic.check />}>
                    {ut("card.signed")}
                  </Tag>
                )}
              </div>
              {c.text ? <p className="m-0 mt-1.5 line-clamp-2 text-[13px] leading-[19px] text-text-2">{c.text}</p> : null}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-small text-muted">
                {c.status === "signed" ? (
                  <>
                    {c.authorName}, {c.signedAt ? day(c.signedAt) : ""}
                    <Link to={`/responses/${c.responseId}/conclusion`} className="ml-auto font-bold text-violet-ink">
                      {ut("card.openDoc")}
                    </Link>
                  </>
                ) : (
                  <>
                    {v.cases?.length ? (
                      <span className="flex items-center gap-1.5 text-text-2">
                        <Ic.info size={13} className="text-violet-ink" />
                        {ut("card.signAfterReview")}
                      </span>
                    ) : null}
                    <Button size="xs" className="ml-auto" onClick={() => v.open("concl", { responseId: c.responseId })}>
                      {ut("card.continue")}
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ─────────── призначено ─────────── */

function AssignedPanel({ v }: { v: CardView }) {
  const { ut } = useLang();
  return (
    <Panel title={ut("card.assigned")} icon={<Pi.send />}>
      {v.assignments.length ? (
        <ul className="m-0 list-none p-0">
          {v.assignments.map((a) => {
            const overdue = a.dueAt ? Date.parse(a.dueAt) < v.now : false;
            return (
              <li key={a.id} className="flex items-start gap-2.5 border-t border-divider py-2.5 first:border-t-0 first:pt-0.5">
                <span className="min-w-0 flex-1">
                  <b className="font-extrabold text-text">{a.title}</b>
                  <small className="mt-px block text-small text-muted">{ut("card.assignedOn").replace("{d}", dm(a.at))}</small>
                </span>
                {a.dueAt ? (
                  <span className={cx("whitespace-nowrap text-right text-[13px]", overdue && "text-warn")}>
                    {ut("card.dueShort")} <b className="font-extrabold">{dm(a.dueAt)}</b>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="m-0 text-small text-muted">{ut("card.nothingAssigned")}</p>
      )}
      {/* «плану немає» — только по ответу сервера: отказ говорит об отказе, а не об отсутствии плана */}
      {!v.planKnown ? (
        v.planError ? (
          <div role="alert" className="mt-2 flex items-center gap-2.5 rounded-[12px] bg-sunk py-3 pl-3.5 pr-3 text-small text-text-2">
            <span className="min-w-0 flex-1">
              <b className="block text-body font-extrabold text-text">{ut("rr.safetyPlan")}</b>
              {v.planError}
            </span>
            <Button variant="paper" size="xs" onClick={v.reloadPlan}>
              {ut("common.retry")}
            </Button>
          </div>
        ) : (
          <div className="mt-2 rounded-[12px] bg-sunk px-3.5 py-3">
            <Loading rows={1} bare />
          </div>
        )
      ) : (
        <div className="mt-2 flex items-center gap-2.5 rounded-[12px] bg-sunk py-3 pl-3.5 pr-3">
          <span className="min-w-0 flex-1 text-small text-text-2">
            <b className="block text-body font-extrabold text-text">
              {v.plan ? ut("card.planChip").replace("{v}", String(v.plan.version)) : ut("rr.noPlan")}
            </b>
            {v.plan ? ut("rr.planUpdated").replace("{d}", day(v.plan.reviewedAt ?? v.plan.createdAt)) : ut("card.planWhere")}
          </span>
          {v.plan && v.cases?.length && v.can("alerts.review") ? (
            <Button variant="paper" size="xs" onClick={() => v.open("signal")}>
              {ut("card.open")}
            </Button>
          ) : (
            <Link to={`/patients/${v.id}/case`} className="text-small font-bold text-violet-ink">
              {v.plan ? ut("card.open") : ut("rr.makePlan")}
            </Link>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ─────────── нотатка ─────────── */

const NOTE_KIND = { intake: "note.intake", session: "note.session", observation: "note.observation", consult: "note.consult" } as const;

function LastNotePanel({ v }: { v: CardView }) {
  const { ut } = useLang();
  const cur = v.notes?.current ?? null;
  return (
    <Panel
      title={ut("card.notePanel")}
      icon={<Pi.notebookText />}
      sub={cur ? `${ut(NOTE_KIND[cur.kind]).toLowerCase()}, ${day(cur.signedAt ?? cur.createdAt)}` : undefined}
      actions={
        v.can("notes.write") ? (
          <Button variant="ghost" size="xs" icon={<Pi.notebookPen />} onClick={() => v.open("note")}>
            {ut("card.newNote")}
          </Button>
        ) : undefined
      }
    >
      {!v.notes ? (
        <Loading rows={2} bare />
      ) : cur ? (
        <>
          <p className="m-0 line-clamp-6 whitespace-pre-wrap text-[13px] leading-5 text-text-2">{cur.text}</p>
          <p className="m-0 mt-2 text-caption text-muted">
            {cur.authorName}
            {cur.status === "draft" ? `, ${ut("card.draft").toLowerCase()}` : ""}
          </p>
        </>
      ) : (
        <p className="m-0 text-small text-muted">{ut("card.noNotes")}</p>
      )}
    </Panel>
  );
}
