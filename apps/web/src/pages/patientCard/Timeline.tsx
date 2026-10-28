import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { LOCALE_OF, type DynamicsPoint, type UiKey } from "@quizzy/shared";
import type { TimelineItem } from "../../api";
import { dayKey, severityKey } from "../../format";
import { useLang } from "../../lang";
import { Empty, Ic, Loading, ViewPills } from "../../ui";
import { IconTile, Panel } from "../../ui/layout";
import { withCount } from "../../ui/plural";
import { Segmented, SeverityTag, Tag } from "../../ui/primitives";
import { useUrlState } from "../../ui/urlState";
import { EVENT_KINDS, EVENT_PLURAL, eventView, type EventKind, type EventView } from "../patients/events";
import { instrumentsOf } from "../patients/instruments";
import { ddmm, hhmm, kitSeverity, shownStep, shownValue, signedShown } from "../patients/model";
import { groupByDay, rowsOf, signalLabels, type TimelineLine } from "./timelineModel";
import type { CardView } from "./types";

/*
 * «Хронологія» — всё, что с человеком происходило, на одной оси: приёмы и
 * неявки, замеры с баллами, сигналы, заключения, назначения, направления.
 * Порядок здесь и есть клинический смысл: сработала тревога до направления
 * или после, был ли повторный замер после начала работы.
 *
 * Прежде лент было две — «Події» карточки и «Хронологія» клинической карты —
 * с разными подписями одного и того же. Осталась одна: по дням, с отбором по
 * виду и периоду; замеры одного часа и сигналы одной сдачи — одной строкой.
 * Что впереди (записанные приёмы, назначенное) — в «Плані» огляда.
 */

type Period = "course" | "30" | "all";

export function TimelineTab({ v }: { v: CardView }) {
  const { ut, lang } = useLang();
  const locale = LOCALE_OF[lang];
  const [kindRaw, setKind] = useUrlState("kind", "all");
  const kind = (EVENT_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as EventKind) : "all";
  const [period, setPeriod] = useState<Period>("course");

  /* балл замера по его прохождению — из динамики: хронология отдаёт факт, динамика — числа */
  const scoreOf = useMemo(() => {
    const map = new Map<string, { code: string; point: DynamicsPoint; prev: DynamicsPoint | null }>();
    for (const i of instrumentsOf(v.dynamics)) {
      i.main.scale.points.forEach((p, n) => map.set(p.responseId, { code: i.code, point: p, prev: i.main.scale.points[n - 1] ?? null }));
    }
    return map;
  }, [v.dynamics]);

  if (!v.timeline) return <Loading rows={6} error={v.timelineError} onRetry={v.reloadTimeline} />;
  const items = v.timeline as TimelineItem[];
  if (!items.length) return <Empty icon={<Ic.history />} title={ut("tl.empty")} hint={ut("tl.emptyHint")} />;

  const now = v.now;
  const past = items.filter((e) => Date.parse(e.at) <= now);
  const firstResponse = past.filter((e) => e.kind === "response").at(-1)?.at ?? null;
  const from =
    period === "30" ? now - 30 * 86_400_000 : period === "course" && firstResponse ? Date.parse(firstResponse) - 7 * 86_400_000 : 0;
  const inPeriod = past.filter((e) => Date.parse(e.at) >= from);
  const counts = new Map<EventKind, number>();
  for (const e of inPeriod) counts.set(e.kind as EventKind, (counts.get(e.kind as EventKind) ?? 0) + 1);
  const shown = kind === "all" ? inPeriod : inPeriod.filter((e) => e.kind === kind);
  const byDay = groupByDay(rowsOf(shown));
  const start = inPeriod.at(-1)?.at ?? null;

  return (
    <Panel
      title={ut("tlx.events")}
      icon={<Ic.history />}
      sub={start ? ut("tlx.eventsSub").replace("{d}", ddmm(start, locale)) : undefined}
      actions={
        <Segmented
          label={ut("tlx.period")}
          value={period}
          onChange={setPeriod}
          items={[
            { key: "course", label: ut("dyn.course") },
            { key: "30", label: ut("tlx.days30") },
            { key: "all", label: ut("tlx.all") },
          ]}
        />
      }
      flush
      footer={
        <>
          <span className="text-caption text-text-2">
            {ut("tlx.shown").replace("{n}", String(shown.length)).replace("{d}", start ? ddmm(start, locale) : "—")}
          </span>
          {/* одна строка о том, чего на оси нет: отсутствие записи здесь не значит, что приёма не было */}
          <span className="text-caption text-muted">{ut("tlx.note")}</span>
        </>
      }
    >
      <div className="px-4 pb-3">
        <ViewPills
          label={ut("tlx.kind")}
          value={kind}
          onChange={(k) => setKind(k === "all" ? "" : k)}
          items={[
            { key: "all", label: ut("pg.allTab"), count: inPeriod.length },
            ...EVENT_KINDS.filter((k) => counts.get(k)).map((k) => ({
              key: k,
              label: ut(EVENT_PLURAL[k]),
              count: counts.get(k) ?? 0,
              risk: k === "alert",
            })),
          ]}
        />
      </div>
      {shown.length === 0 ? (
        <Empty compact title={ut("tlx.noneInPeriod")} hint={ut("tl.emptyHint")} />
      ) : (
        <ol className="m-0 list-none p-0">
          {[...byDay.entries()].map(([d, rows]) => (
            <li key={d}>
              {/* data-day — день ключом «YYYY-MM-DD»: опора смоука на порядок дней (screens.e2e.ts) */}
              <h3 data-day={d} className="m-0 flex h-9 items-center gap-2 border-t border-divider bg-panel-2 px-4 text-small font-extrabold text-text">
                {dayTitle(d, now, locale, ut)}
                <span className="inline-grid h-5 min-w-5 place-items-center rounded-[10px] bg-sunk px-1.5 text-[11.5px] font-bold text-text-2">
                  {rows.reduce((n, r) => n + r.items.length, 0)}
                </span>
              </h3>
              <ol className="m-0 list-none p-0">
                {rows.map((r) => (
                  <EventRow key={r.key} row={r} scoreOf={scoreOf} locale={locale} v={v} />
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/** «Сьогодні, четвер 8 жовтня» / «П’ятниця, 11 вересня» */
function dayTitle(day: string, now: number, locale: string, ut: (k: UiKey) => string): string {
  const d = new Date(`${day}T12:00:00`);
  const long = d.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
  if (day === dayKey(new Date(now).toISOString())) return `${ut("plist.today")[0]!.toUpperCase()}${ut("plist.today").slice(1)}, ${long}`;
  return `${long[0]!.toUpperCase()}${long.slice(1)}`;
}

function EventRow({
  row,
  scoreOf,
  locale,
  v,
}: {
  row: TimelineLine;
  scoreOf: Map<string, { code: string; point: DynamicsPoint; prev: DynamicsPoint | null }>;
  locale: string;
  v: CardView;
}) {
  const { ut, lang } = useLang();
  const first = row.items[0]!;
  const view: EventView = eventView(first, ut as (k: UiKey, f?: string) => string);
  const many = row.items.length > 1;
  const scores = row.items
    .map((it) => scoreOf.get(it.id.slice(it.id.indexOf(":") + 1)))
    .filter((s): s is NonNullable<typeof s> => !!s);
  const tone = view.tone === "risk" ? "risk" : view.tone === "warn" ? "warn" : view.tone === "good" ? "good" : "neutral";
  const signals = row.kind === "alert" ? signalLabels(row.items) : [];
  /* заключение ведёт во «Записи», а не на прежний адрес сводки: его дом теперь там */
  const href = row.kind === "conclusion" ? null : view.href;
  const head = many
    ? row.kind === "alert"
      ? withCount(ut("ws.signalsN"), row.items.length, lang)
      : ut("tlx.measuresN").replace("{n}", String(row.items.length))
    : view.head;
  const body = (
    <>
      <span className="whitespace-nowrap pt-0.5 text-small font-bold tabular-nums text-text-2">{hhmm(row.at, locale)}</span>
      <IconTile icon={view.icon} size={28} tone={tone} />
      <span className="min-w-0">
        <span className={`block text-[13.5px] leading-5 ${view.tone === "risk" ? "text-risk-ink" : "text-text"}`}>
          <b className={view.tone === "risk" ? "font-extrabold" : "font-bold"}>{head}</b>
          {!many && view.rest ? <span className={view.tone === "risk" ? "text-text" : "text-text-2"}> {view.rest}</span> : null}
        </span>
        {signals.length && many ? (
          <span className="mt-0.5 block text-caption leading-[17px] text-text-2">
            {signals.map((s) => (s.count > 1 ? `${s.label} (×${s.count})` : s.label)).join("; ")}
          </span>
        ) : scores.length ? (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {scores.map((s) => {
              const val = shownValue(s.point.rawScore, s.point.normalization);
              /* сдвиг — в единицах числа рядом: у доли («49%») — процентные пункты, а не «+0,2» */
              const d = s.prev ? shownStep(s.point.rawScore - s.prev.rawScore, s.point.normalization) : null;
              const pp = s.point.normalization === "ratio" ? ut("dyn.pp") : "";
              return (
                <span key={s.point.responseId} className="inline-flex h-7 items-center gap-1.5 rounded-pill bg-sunk pl-2.5 pr-2 text-caption text-text-2">
                  <b className="font-bold text-text">{s.code}</b>
                  <b className="font-extrabold tabular-nums text-text">
                    {val.text}
                    {val.unit}
                  </b>
                  {s.point.severity || s.point.bandLabel ? (
                    <SeverityTag level={kitSeverity(s.point.severity)} small>
                      {s.point.bandLabel ?? ut(severityKey[s.point.severity ?? "none"])}
                    </SeverityTag>
                  ) : null}
                  <span className="tabular-nums text-muted">{d === null ? ut("tlx.start") : `${signedShown(d)}${d ? pp : ""}`}</span>
                </span>
              );
            })}
          </span>
        ) : many ? (
          <span className="mt-0.5 block text-caption text-text-2">{row.items.map((it) => it.title).join(", ")}</span>
        ) : null}
      </span>
      <span className="self-center">{view.badge ? <Tag tone={view.badge.tone}>{view.badge.text}</Tag> : null}</span>
    </>
  );
  const cls =
    "grid min-h-[48px] grid-cols-[52px_28px_minmax(0,1fr)_auto] items-start gap-x-3 border-t border-divider px-4 py-2.5 no-underline outline-offset-[-2px] hover:bg-panel-2 hover:no-underline focus-visible:bg-panel-2";
  return (
    <li>
      {row.kind === "conclusion" ? (
        <button type="button" data-evt onClick={() => v.goTab("records", { kind: "concl" })} className={`${cls} w-full cursor-pointer whitespace-normal border-0 bg-transparent text-left`}>
          {body}
        </button>
      ) : href && !many ? (
        <Link to={href} data-evt className={cls}>
          {body}
        </Link>
      ) : (
        <div data-evt tabIndex={0} className={cls}>
          {body}
        </div>
      )}
    </li>
  );
}
