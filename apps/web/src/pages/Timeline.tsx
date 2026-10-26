import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { LOCALE_OF, type DynamicsPoint, type UiKey } from "@quizzy/shared";
import { api, type TimelineItem } from "../api";
import { HBars, TimeColumns } from "../charts/clinical";
import { dayKey, severityKey } from "../format";
import { useLang } from "../lang";
import { Callout, Empty, Ic, KbdHints, Loading, useHotkeys } from "../ui";
import { IconTile, Panel, SideLayout } from "../ui/layout";
import { Segmented, SeverityTag, Tag } from "../ui/primitives";
import { ViewPills } from "../ui/filters";
import { useResource } from "../useResource";
import { EVENT_KINDS, EVENT_PLURAL, eventView, type EventKind, type EventView } from "./patients/events";
import { instrumentsOf } from "./patients/instruments";
import { DYN_KEY, TL_KEY, ddmm, hhmm, kitSeverity, shownStep, shownValue, signedShown } from "./patients/model";

/**
 * Вкладка «Хронологія» справы — кадр patients-case-timeline.
 *
 * Раньше историю приходилось собирать с четырёх экранов и складывать порядок
 * в голове. Между тем именно порядок и есть клинический смысл: сработала
 * тревога до направления или после, был ли повторный замер после начала
 * терапии, сколько прошло между сигналом и разбором.
 *
 * События сгруппированы по дням: без группировки лента из двухсот строк
 * читается как журнал, а не как история. Замеры одного часа (набор,
 * сданный за один присест) — одной строкой с баллами: так их и читают.
 * Отбор по виду и периоду; справа — сколько чего было за курс, по неделям,
 * и что впереди (записанные приёмы, неначатые назначения).
 *
 * Подпись внизу остаётся: без неё вкладка не говорит, ЧТО именно на оси, а
 * отсутствие события легко прочесть как «этого не было».
 */

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

type Period = "course" | "30" | "all";

/** Строка ленты: одно событие или замеры одного часа вместе */
interface Row {
  key: string;
  at: string;
  kind: EventKind;
  items: TimelineItem[];
}

/**
 * Замеры подряд в пределах часа — одна строка: набор сдают за один
 * присест, и четыре строки «пройдено» подряд читались бы как четыре события.
 */
export function rowsOf(items: readonly TimelineItem[]): Row[] {
  const out: Row[] = [];
  for (const it of items) {
    const prev = out.at(-1);
    if (
      prev &&
      it.kind === "response" &&
      prev.kind === "response" &&
      dayKey(prev.at) === dayKey(it.at) &&
      Math.abs(Date.parse(prev.items.at(-1)!.at) - Date.parse(it.at)) <= 3_600_000
    ) {
      prev.items.push(it);
      continue;
    }
    out.push({ key: it.id, at: it.at, kind: it.kind as EventKind, items: [it] });
  }
  return out;
}

export default function Timeline() {
  const { userId } = useParams<{ userId: string }>();
  const { ut, lang } = useLang();
  const locale = LOCALE_OF[lang];
  /* keep: false — хронология прежнего пациента не стоит под адресом следующего (#177) */
  const res = useResource(() => api.timeline(userId!), [userId], { enabled: !!userId, keep: false, key: TL_KEY });
  const dyn = useResource(() => api.dynamics(userId!), [userId], { enabled: !!userId, keep: false, key: DYN_KEY });
  const [kind, setKind] = useState<EventKind | "all">("all");
  const [period, setPeriod] = useState<Period>("course");
  const listRef = useRef<HTMLOListElement>(null);

  /* балл замера по его прохождению — из динамики: хронология отдаёт факт, динамика — числа */
  const scoreOf = useMemo(() => {
    const map = new Map<string, { code: string; point: DynamicsPoint; prev: DynamicsPoint | null }>();
    for (const i of instrumentsOf(dyn.data)) {
      i.main.scale.points.forEach((p, n) => map.set(p.responseId, { code: i.code, point: p, prev: i.main.scale.points[n - 1] ?? null }));
    }
    return map;
  }, [dyn.data]);

  const move = (step: 1 | -1) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-evt]") ?? []);
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at < 0 ? 0 : at + step))];
    next?.focus();
    next?.scrollIntoView({ block: "nearest" });
  };
  useHotkeys({ j: () => move(1), k: () => move(-1) });

  const items = res.data;
  if (!items) return <Loading rows={6} error={res.error} onRetry={res.reload} busy={res.loading} />;

  const now = Date.now();
  const past = items.filter((e) => Date.parse(e.at) <= now);
  const ahead = items
    .filter((e) => (Date.parse(e.at) > now && e.kind === "visit") || (e.kind === "assignment" && e.detail === "open"))
    .sort((a, b) => a.at.localeCompare(b.at));
  const firstResponse = past.filter((e) => e.kind === "response").at(-1)?.at ?? null;
  const from =
    period === "30" ? now - 30 * 86_400_000 : period === "course" && firstResponse ? Date.parse(firstResponse) - 7 * 86_400_000 : 0;
  const inPeriod = past.filter((e) => Date.parse(e.at) >= from);
  const counts = new Map<EventKind, number>();
  for (const e of inPeriod) counts.set(e.kind as EventKind, (counts.get(e.kind as EventKind) ?? 0) + 1);
  const shown = kind === "all" ? inPeriod : inPeriod.filter((e) => e.kind === kind);
  const byDay = groupByDay(rowsOf(shown));
  const start = inPeriod.at(-1)?.at ?? null;
  const weeks = weekly(inPeriod, now, locale);

  if (!items.length) {
    return <Empty icon={<Ic.history />} title={ut("tl.empty")} hint={ut("tl.emptyHint")} />;
  }

  return (
    <SideLayout
      side={
        <>
          <Panel
            title={ut("tlx.forCourse")}
            icon={<Ic.layers />}
            sub={start ? ut("tlx.since").replace("{d}", ddmm(start, locale)) : undefined}
          >
            <HBars
              items={EVENT_KINDS.filter((k) => counts.get(k)).map((k) => ({
                key: k,
                label: ut(EVENT_PLURAL[k]),
                value: counts.get(k) ?? 0,
                strong: k === "alert" ? false : undefined,
              }))}
            />
          </Panel>
          <Panel title={ut("tlx.perWeek")} icon={<Ic.chart />} sub={ut("tlx.perWeekSub")}>
            <TimeColumns columns={weeks} label={ut("tlx.perWeek")} height={180} emptyTip={ut("tlx.noEvents")} />
          </Panel>
          <Panel title={ut("tlx.ahead")} icon={<Ic.calendar />} sub={ut("tlx.aheadSub")} flush>
            {ahead.length ? (
              <ul className="m-0 list-none p-0">
                {ahead.slice(0, 6).map((e) => {
                  const v = eventView(e, ut as (k: UiKey, f?: string) => string);
                  const future = Date.parse(e.at) > now;
                  return (
                    <li key={e.id} className="grid grid-cols-[86px_28px_minmax(0,1fr)] items-center gap-2 border-t border-divider px-4 py-2.5 text-small first:border-t-0">
                      <span className="whitespace-nowrap font-bold text-text">
                        {ddmm(e.at, locale)}
                        {future ? <small className="ml-1 font-medium text-muted">{hhmm(e.at, locale)}</small> : null}
                      </span>
                      <IconTile icon={v.icon} size={28} tone="neutral" />
                      <span className="min-w-0 text-text">
                        <b className="font-bold">{v.head}</b>
                        {v.rest ? <span className="text-text-2"> {v.rest}</span> : null}
                        {!future ? <span className="text-muted"> {ut("evt.open")}</span> : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="m-0 px-4 pb-4 text-small text-muted">{ut("tlx.nothingAhead")}</p>
            )}
          </Panel>
          <Callout kind="info">
            {ut("tl.sub")}. {ut("tlx.note")}
          </Callout>
        </>
      }
    >
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
            <KbdHints
              className="ml-auto"
              keys={[
                ["J K", ut("tlx.between")],
                ["Enter", ut("case.open")],
              ]}
            />
          </>
        }
      >
        <div className="px-4 pb-3">
          <ViewPills
            label={ut("tlx.kind")}
            value={kind}
            onChange={(k) => setKind(k as EventKind | "all")}
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
          <ol ref={listRef} className="m-0 list-none p-0">
            {[...byDay.entries()].map(([day, rows]) => (
              <li key={day}>
                {/* data-day — день ключом «YYYY-MM-DD»: опора смоука на порядок дней (screens.e2e.ts) */}
                <h3
                  data-day={day}
                  className="m-0 flex h-9 items-center gap-2 border-t border-divider bg-panel-2 px-4 text-small font-extrabold text-text"
                >
                  {dayTitle(day, now, locale, ut)}
                  <span className="inline-grid h-5 min-w-5 place-items-center rounded-[10px] bg-sunk px-1.5 text-[11.5px] font-bold text-text-2">
                    {rows.reduce((n, r) => n + r.items.length, 0)}
                  </span>
                </h3>
                <ol className="m-0 list-none p-0">
                  {rows.map((r) => (
                    <EventRow key={r.key} row={r} scoreOf={scoreOf} locale={locale} />
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </SideLayout>
  );
}

/** «Сьогодні, четвер 8 жовтня» / «П’ятниця, 11 вересня» */
function dayTitle(day: string, now: number, locale: string, ut: (k: UiKey) => string): string {
  const d = new Date(`${day}T12:00:00`);
  const long = d.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
  if (day === dayKey(new Date(now).toISOString())) return `${ut("plist.today")[0]!.toUpperCase()}${ut("plist.today").slice(1)}, ${long}`;
  return `${long[0]!.toUpperCase()}${long.slice(1)}`;
}

/**
 * Корзины по неделям с понедельника — последние восемь, текущая неполная.
 *
 * Начала недель — календарём (полночь понедельника по часам консоли), а не
 * вычитанием 7×24 часов: через перевод часов (последнее воскресенье
 * октября) вычтенная полночь сдвигалась на час, ни одно событие с ней не
 * совпадало, и все недели до перевода стояли нулями.
 */
export function weekly(items: readonly TimelineItem[], now: number, locale: string) {
  const monday = (t: number) => {
    const d = new Date(t);
    const shift = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - shift).getTime();
  };
  const base = new Date(monday(now));
  const out = Array.from({ length: 8 }, (_, i) => {
    const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() - (7 - i) * 7).getTime();
    return { key: String(start), label: ddmm(new Date(start).toISOString(), locale), value: 0 as number | null, partial: i === 7 };
  });
  for (const e of items) {
    const w = monday(Date.parse(e.at));
    const slot = out.find((o) => Number(o.key) === w);
    if (slot) slot.value = (slot.value ?? 0) + 1;
  }
  return out;
}

function EventRow({
  row,
  scoreOf,
  locale,
}: {
  row: Row;
  scoreOf: Map<string, { code: string; point: DynamicsPoint; prev: DynamicsPoint | null }>;
  locale: string;
}) {
  const { ut } = useLang();
  const first = row.items[0]!;
  const v: EventView = eventView(first, ut as (k: UiKey, f?: string) => string);
  const many = row.items.length > 1;
  const scores = row.items
    .map((it) => scoreOf.get(it.id.slice(it.id.indexOf(":") + 1)))
    .filter((s): s is NonNullable<typeof s> => !!s);
  const tone = v.tone === "risk" ? "risk" : v.tone === "warn" ? "warn" : v.tone === "good" ? "good" : "neutral";
  const body = (
    <>
      <span className="whitespace-nowrap pt-0.5 text-small font-bold tabular-nums text-text-2">{hhmm(row.at, locale)}</span>
      <IconTile icon={v.icon} size={28} tone={tone} />
      <span className="min-w-0">
        <span className={`block text-[13.5px] leading-5 ${v.tone === "risk" ? "text-risk-ink" : "text-text"}`}>
          <b className={v.tone === "risk" ? "font-extrabold" : "font-bold"}>
            {many ? ut("tlx.measuresN").replace("{n}", String(row.items.length)) : v.head}
          </b>
          {!many && v.rest ? <span className={v.tone === "risk" ? "text-text" : "text-text-2"}> {v.rest}</span> : null}
        </span>
        {scores.length ? (
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
      <span className="self-center">
        {v.badge ? <Tag tone={v.badge.tone}>{v.badge.text}</Tag> : null}
      </span>
    </>
  );
  const cls =
    "grid min-h-[48px] grid-cols-[52px_28px_minmax(0,1fr)_auto] items-start gap-x-3 border-t border-divider px-4 py-2.5 no-underline outline-offset-[-2px] hover:bg-panel-2 hover:no-underline focus-visible:bg-panel-2";
  return (
    <li>
      {v.href && !many ? (
        <Link to={v.href} data-evt className={cls}>
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
