import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AlertCase, AlertCasePage, AppointmentView, OverviewAnalytics, Page as CursorPage, Worklist } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { day, duration, locale } from "../../format";
import { Avatar, Loading, SkeletonRows, Tooltip, useAction } from "../../ui";
import { cx } from "../../ui/cx";
import { Ic } from "../../ui/icons";
import { IconTile, Panel, type PanelTone } from "../../ui/layout";
import { Button, ButtonLink, Tag } from "../../ui/primitives";
import { TextAction } from "../../ui/records";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { CasesFailed, reviewHref, signalText, useNormText, WorkIcon } from "../today/ActNow";
import { Di } from "../today/icons";
import { caseTimer, clashes, hhmm, liveCases, sessionStates, urgentCases } from "../today/model";
import { DayStrip } from "../today/strip";
import { useNow, useUntil } from "../today/Agenda";
import { workWhy } from "../worklist/model";
import { WORK_KIND, fill, withCount, workTiles } from "./model";

/**
 * Віджети «Зведення» (кадр day-start Polypsy 2.0). Каждый — панель набора с
 * квадратом значка 32, своим числом в подписи и дверью туда, где с этим
 * работают. Данные — только то, что консоль уже получает: случаи, очередь,
 * день приёма, «поки вас не було», сводка аналитики.
 */

/** Строка-ссылка боковых віджетів: значок, что и кто, число справа */
function CountRow({
  to,
  icon,
  tone,
  title,
  detail,
  n,
  nTone,
}: {
  to: string;
  icon: ReactNode;
  tone: PanelTone;
  title: ReactNode;
  detail?: ReactNode;
  n: number;
  nTone?: "risk" | "warn";
}) {
  return (
    <Link
      to={to}
      className="mx-2 grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0 rounded-[12px] px-2 py-2 text-text no-underline transition-colors duration-[var(--dur-fast)] hover:bg-sunk hover:no-underline"
    >
      <IconTile icon={icon} tone={tone} size={32} />
      <span className="min-w-0">
        <b className="block text-[13.5px] font-extrabold leading-[18px] text-text">{title}</b>
        {detail ? <small className="block truncate text-caption text-text-2">{detail}</small> : null}
      </span>
      <span
        className={cx(
          "text-[17px] font-extrabold tabular-nums",
          nTone === "risk" ? "text-risk-ink" : nTone === "warn" ? "text-warn" : "text-text",
        )}
      >
        {n}
      </span>
    </Link>
  );
}

/** Подвал віджета: тонкая строка под линией */
function Foot({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-divider px-4 py-2.5 text-caption text-text-2">{children}</div>;
}

/* ─────────── випадки ризику ─────────── */

/**
 * Случаи риска: самые срочные строкой с таймером нормы и «Розібрати» —
 * разбор открывается на «Випадки ризику» с отбором по человеку. Подвал —
 * счётчики по всей очереди с сервера (facets), а не по загруженным строкам:
 * по шести строкам выходило «термінових: 6» при сотне тяжёлых.
 */
export function CasesWidget({
  alerts,
  meId,
  loading = false,
  error = null,
  onRetry,
  updatedAt = null,
}: {
  /** Открытые случаи; null — разбор не положен (и тогда віджета нет), либо они ещё не пришли или не загрузились */
  alerts: CursorPage<AlertCase> | null;
  meId: string | null;
  loading?: boolean;
  /** Отказ загрузки: віджет остаётся на месте и говорит об отказе, а не исчезает */
  error?: string | null;
  onRetry?: () => void;
  /** Когда пришёл ответ — от него идут минуты таймера нормы (liveCases) */
  updatedAt?: number | null;
}) {
  const { ut, lang } = useLang();
  const norm = useNormText();
  const now = useNow();
  if (!alerts && !loading && !error) return null;
  const items = alerts ? liveCases(alerts.items, now, updatedAt) : [];
  const facets = alerts && "facets" in alerts ? (alerts as AlertCasePage).facets : undefined;
  const total = alerts ? (alerts.total ?? alerts.items.length) : 0;
  const urgent = facets ? facets.sections.severe : items.filter((x) => x.severity === "severe").length;
  const overdue = facets ? facets.overdue : items.filter((x) => x.overdue).length;
  const oldestAt = facets
    ? facets.oldestOpenedAt
    : items.length
      ? items.map((x) => x.openedAt).sort()[0]!
      : null;
  const oldest = oldestAt ? Math.floor((now - new Date(oldestAt).getTime()) / 86_400_000) : 0;
  const rows = urgentCases(items, meId).slice(0, 3);
  const norms = [...new Set(items.map((c) => c.escalateMinutes).filter((n): n is number => !!n))];

  return (
    <Panel
      title={ut("dashA.cases")}
      icon={<Ic.alert />}
      tone="risk"
      sub={
        !alerts
          ? undefined
          : norms.length === 1
            ? fill(ut("dashA.casesSubNorm"), { open: withCount(ut("dashA.casesSub"), total, lang), norm: norm(norms[0]!) })
            : withCount(ut("dashA.casesSub"), total, lang)
      }
      actions={<TextAction to="/alerts">{ut("dashA.allCases")}</TextAction>}
      flush
    >
      {error ? (
        <div className="px-2.5 pb-2.5">
          <CasesFailed error={error} onRetry={onRetry} />
        </div>
      ) : null}
      {!alerts ? (
        error ? null : (
          <div className="pb-2" role="status" aria-label={ut("common.loading")}>
            <SkeletonRows rows={2} />
          </div>
        )
      ) : rows.length === 0 ? (
        /* «немає» — только по свежему ответу: при отказе перечитывания прежний ноль уже неправда */
        error ? null : (
          <p className="m-0 mx-2.5 mb-2.5 flex items-center gap-2.5 rounded-[12px] bg-good-tint px-3.5 py-3 text-small font-semibold text-good">
            <Ic.circleCheck size={17} />
            {ut("dashA.noCases")}
          </p>
        )
      ) : (
        <div className="flex flex-col gap-1 px-2 pb-2">
          {rows.map((c, i) => {
            const t = caseTimer(c);
            const first = i === 0;
            return (
              <div
                key={c.id}
                className={cx(
                  "grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0 rounded-[14px] px-2.5 py-2.5",
                  first ? "bg-risk-tint" : "hover:bg-panel-2",
                )}
              >
                <Avatar name={c.userName} size={34} tone={first ? "violet" : "soft"} />
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <Link to={`/patients/${c.userId}`} className="truncate text-[14px] font-extrabold text-text no-underline hover:underline">
                      {c.userName}
                    </Link>
                    {c.assignedTo && c.assignedTo !== meId ? (
                      <Tag tone="handover">{fill(ut("dayA.heldBy"), { name: c.assignedToName ?? "" })}</Tag>
                    ) : (
                      <Tag tone="danger" icon={<Ic.alert />}>
                        {fill(ut("dashA.signalDay"), { d: day(c.openedAt) })}
                      </Tag>
                    )}
                  </div>
                  <p className="m-0 mt-0.5 line-clamp-1 text-small text-text-2">{signalText(c, ut)}</p>
                </div>
                <div className="flex items-center gap-2.5">
                  {t ? (
                    <span className="flex flex-col items-end whitespace-nowrap text-caption font-semibold text-text-2 max-[1180px]:hidden">
                      <span>
                        <b className="text-[18px] font-extrabold tracking-[-0.02em] text-risk-ink tabular-nums">{t.elapsed}</b>{" "}
                        {fill(ut("dayA.ofNorm"), { norm: norm(t.norm) })}
                      </span>
                      <span aria-hidden className="mt-1 block h-1.5 w-[88px] overflow-hidden rounded-[3px] bg-risk-line">
                        <i className="block h-full rounded-[3px] bg-risk" style={{ width: `${t.pct}%` }} />
                      </span>
                    </span>
                  ) : null}
                  <ButtonLink to={reviewHref(c.userId)} variant={first ? "risk" : "secondary"} size="sm">
                    {ut("dayA.review")}
                  </ButtonLink>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {total > 0 ? (
        <Foot>
          <span>
            {fill(ut("dashA.openTotal"), { n: total })} {fill(ut("dash.casesUrgent"), { n: urgent })}
          </span>
          <span className="ml-auto">
            {fill(ut("dashA.overdueN"), { n: overdue })}
            {", "}
            {fill(ut("dash.casesOldest"), { n: oldest })}
          </span>
        </Foot>
      ) : null}
    </Panel>
  );
}

/* ─────────── прийом сьогодні ─────────── */

export function DayWidget({ items }: { items: AppointmentView[] | null }) {
  const { ut, lang } = useLang();
  const until = useUntil();
  if (!items) return null;
  const sorted = [...items].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const now = Date.now();
  const states = sessionStates(sorted, now);
  const clash = clashes(sorted);
  const alive = sorted.filter((a) => a.status !== "cancelled");
  const done = alive.filter((a) => a.status === "done").length;
  const ahead = alive.filter((a) => ["next", "later", "here"].includes(states.get(a.id) ?? "")).length;
  const upcoming = alive.filter((a) => ["here", "next", "later", "late"].includes(states.get(a.id) ?? "")).slice(0, 3);

  return (
    <Panel
      title={ut("dayA.dayTitle")}
      icon={<Di.calendarClock />}
      sub={alive.length ? fill(ut("dashA.daySub"), { sessions: withCount(ut("dayA.sessionsN"), alive.length, lang), done, ahead }) : undefined}
      actions={<TextAction to="/today">{ut("dashA.openDay")}</TextAction>}
      flush
    >
      {alive.length === 0 ? (
        <p className="m-0 px-4 pb-4 text-small text-muted">{ut("day.nobody")}</p>
      ) : (
        <>
          <DayStrip items={sorted} states={states} clash={clash} now={now} />
          {upcoming.length ? (
            <div className="border-t border-divider px-2 pb-2 pt-1.5">
              {upcoming.map((a) => {
                const s = states.get(a.id);
                const c = clash.get(a.id);
                return (
                  <div
                    key={a.id}
                    className={cx(
                      "grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0 rounded-[14px] px-2.5 py-2.5",
                      s === "next" || s === "here" ? "bg-violet-tint" : "",
                    )}
                  >
                    <span className="text-[15px] font-extrabold leading-5 text-text tabular-nums">
                      {hhmm(a.startsAt)}
                      <small className="block text-caption font-semibold leading-4 text-muted">{hhmm(a.endsAt)}</small>
                    </span>
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <Link to={`/patients/${a.patientId}`} className="truncate text-[14px] font-extrabold text-text no-underline hover:underline">
                          {a.patientName}
                        </Link>
                        {a.mode === "remote" ? (
                          <Tag tone="info" icon={<Di.video />}>
                            {ut("dayA.online")}
                          </Tag>
                        ) : a.room ? (
                          <Tag icon={<Di.door />}>
                            {ut("day.room")} {a.room}
                          </Tag>
                        ) : null}
                      </div>
                      <p className="m-0 mt-0.5 truncate text-small text-text-2">
                        {a.reason ?? ut(a.kind === "primary" ? "day.primary" : "day.repeat")}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {c ? (
                        <Tag tone="attention" icon={<Di.calendarClock />}>
                          {fill(ut("dayA.clashTag"), { from: hhmm(c.from), to: hhmm(c.to) })}
                        </Tag>
                      ) : a.pendingAssignments > 0 ? (
                        <Tag tone="attention" icon={<Di.clipboardCheck />}>
                          {ut("day.pending")} {a.pendingAssignments}
                        </Tag>
                      ) : null}
                      {s === "here" ? (
                        <Tag tone="primary" icon={<Di.logIn />}>
                          {ut("dayA.inRoomNow")}
                        </Tag>
                      ) : s === "late" ? (
                        <Tag tone="attention" icon={<Di.clockAlert />}>
                          {ut("dayA.notMarked")}
                        </Tag>
                      ) : (
                        <Tag tone={s === "next" ? "primary" : "done"} icon={<Di.clock />}>
                          {until((Date.parse(a.startsAt) - now) / 60_000)}
                        </Tag>
                      )}
                      <ButtonLink to="/today" size="xs" variant={s === "next" || s === "here" ? "secondary" : "ghost"}>
                        {ut("dashA.prep")}
                      </ButtonLink>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="m-0 border-t border-divider px-4 py-3 text-small text-muted">{ut("dayA.dayOver")}</p>
          )}
        </>
      )}
    </Panel>
  );
}

/* ─────────── поки вас не було ─────────── */

type Missed = Awaited<ReturnType<typeof api.missed>>;
type MissedKind = Missed["groups"][number]["kind"];

const MISSED: Record<MissedKind, { key: "ec.caseOpened" | "ec.caseResolved" | "ec.referralCreated" | "ec.scheduleRun"; tone: PanelTone; icon: ReactNode; to: string }> = {
  "case.opened": { key: "ec.caseOpened", tone: "risk", icon: <Ic.alert />, to: "/alerts" },
  "case.resolved": { key: "ec.caseResolved", tone: "good", icon: <Ic.circleCheck />, to: "/alerts" },
  "referral.created": { key: "ec.referralCreated", tone: "violet", icon: <Di.arrows />, to: "/referrals" },
  "schedule.run": { key: "ec.scheduleRun", tone: "neutral", icon: <Di.repeat />, to: "/surveys" },
};

/**
 * «Поки вас не було» — то же, что сводка центра событий, с той же точкой
 * отсчёта из профиля (eventsSeenAt): смена вернулась с другой машины — и
 * сводка показывает смену. «Прочитано» сдвигает точку для обоих мест.
 */
export function MissedWidget() {
  const { ut } = useLang();
  const { user, refreshUser } = useAuth();
  const { run, busy } = useAction();
  const seenAt = user?.workspace?.eventsSeenAt ?? null;
  /*
   * Точка отсчёта устойчива между отрисовками — как в центре событий
   * (shell/EventCenter.tsx). Запасная «сутки назад», посчитанная в теле
   * компонента, давала новую строку на каждой отрисовке, строка стояла в
   * ключе загрузки, ответ вызывал отрисовку — и «Зведення» спрашивало
   * /api/missed без остановки, раз в 70 мс, у каждого, кто ни разу не нажал
   * «Прочитано» (волна 27; сторожит e2e/responsive.e2e.ts).
   */
  const since = useMemo(() => seenAt ?? new Date(Date.now() - 86_400_000).toISOString(), [seenAt]);
  const res = useResource(() => api.missed(since), [since]);
  const groups = (res.data?.groups ?? []).filter((g) => g.count > 0);
  const total = groups.reduce((n, g) => n + g.count, 0);

  return (
    <Panel
      title={ut("dashA.missed")}
      icon={<Ic.history />}
      sub={fill(ut("dashA.missedSince"), { d: day(since), t: hhmm(since) })}
      actions={
        total > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            icon={<Ic.check />}
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.saveWorkspace({ eventsSeenAt: new Date().toISOString() });
                await refreshUser();
              }, ut("dashA.markedRead"))
            }
          >
            {ut("dashA.markRead")}
          </Button>
        ) : null
      }
      flush
    >
      {res.error ? (
        <div className="px-4 pb-4">
          <Loading bare error={res.error} onRetry={res.reload} />
        </div>
      ) : !res.data ? (
        <div className="pb-2" role="status" aria-label={ut("common.loading")}>
          <SkeletonRows rows={3} />
        </div>
      ) : groups.length === 0 ? (
        <p className="m-0 px-4 pb-4 text-small text-muted">{ut("ec.nothing")}</p>
      ) : (
        <div className="pb-2 pt-0.5">
          {groups.map((g) => {
            const look = MISSED[g.kind] ?? MISSED["schedule.run"];
            const latest = g.items[0];
            const names = g.items.slice(0, 2).map((i) => i.title).join(", ");
            return (
              <CountRow
                key={g.kind}
                to={latest?.href || look.to}
                icon={look.icon}
                tone={look.tone}
                title={ut(look.key)}
                detail={latest ? `${names}${g.count > 2 ? fill(ut("dashA.andMore"), { n: g.count - 2 }) : ""}` : undefined}
                n={g.count}
                nTone={g.kind === "case.opened" ? "risk" : undefined}
              />
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/* ─────────── черга роботи ─────────── */

/**
 * Очередь по видам работы: «71» ничего не говорит о том, что именно ждёт;
 * виды с именами отвечают сразу, а нажатие ведёт в отобранную очередь.
 * Пустые виды не показываются, янтарь — только у просроченных (workTiles).
 */
export function WorkWidget({ work }: { work: Worklist }) {
  const { ut } = useLang();
  const tiles = workTiles(work.byKind);
  return (
    <Panel
      title={ut("work.title")}
      icon={<Di.listChecks />}
      sub={fill(ut("dashA.workSub"), { n: work.total })}
      actions={<TextAction to="/worklist">{ut("dashA.allWork")}</TextAction>}
      flush
    >
      {tiles.length === 0 ? (
        <p className="m-0 px-4 pb-4 text-small text-muted">{ut("work.nothing")}</p>
      ) : (
        <div className="pb-2 pt-0.5">
          {tiles.map((t) => {
            const of = work.items.filter((i) => i.kind === t.kind);
            const names = of.slice(0, 2).map((i) => i.userName);
            return (
              <CountRow
                key={t.kind}
                to={`/worklist?kind=${t.kind}`}
                icon={<WorkIcon kind={t.kind} />}
                tone={t.attention || t.kind === "noshow" ? "warn" : t.kind === "message" ? "info" : "violet"}
                title={ut(WORK_KIND[t.kind])}
                detail={
                  names.length
                    ? `${names.join(", ")}${t.count > names.length ? fill(ut("dashA.andMore"), { n: t.count - names.length }) : ""}`
                    : of[0]
                      ? workWhy(of[0], ut)
                      : undefined
                }
                n={t.count}
                nTone={t.attention ? "warn" : undefined}
              />
            );
          })}
        </div>
      )}
      {work.truncated ? <Foot>{ut("work.truncated")}</Foot> : null}
    </Panel>
  );
}

/* ─────────── методики та збір ─────────── */

const pct = (v: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(v);

export function CollectWidget({ overview, cur, delta }: { overview: OverviewAnalytics; cur: number; delta: number }) {
  const { ut } = useLang();
  const live = overview.inProgress;
  const rows: { k: string; sub: string; v: ReactNode; extra?: ReactNode; tip?: string }[] = [
    { k: ut("dashA.kvSurveys"), sub: fill(ut("dashA.kvPublished"), { n: overview.publishedCount }), v: overview.surveyCount },
    {
      k: ut("dashA.kvPasses"),
      sub: fill(ut("dashA.kvPassesSub"), { all: overview.responseCount }),
      v: cur,
      extra: delta ? (
        <span className={delta > 0 ? "text-good" : "text-text-2"}>{fill(ut("dashA.kvVsPrev"), { d: delta > 0 ? `+${delta}` : `−${Math.abs(delta)}` })}</span>
      ) : null,
    },
    { k: ut("dash.respondents"), sub: ut("dashA.kvUnique"), v: overview.respondentCount },
    { k: ut("dashA.kvCompletion"), sub: ut("dashA.kvCompletionSub"), v: `${pct(overview.completionRate)} %` },
    { k: ut("dash.avgTime"), sub: ut("dashA.kvAvgSub"), v: duration(overview.avgDurationMs) },
  ];
  return (
    <Panel title={ut("dashA.collect")} icon={<Ic.clipboard />} sub={ut("dashA.collectSub")} flush>
      <dl className="m-0">
        {rows.map((r) => (
          <div key={r.k} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0 border-t border-divider px-4 py-2.5 first:border-t-0">
            <dt className="min-w-0 text-[13.5px] font-bold text-text">
              {r.k}
              <small className="block text-caption font-medium text-muted">{r.sub}</small>
            </dt>
            <dd className="m-0 text-right">
              <b className="block text-[18px] font-extrabold leading-6 tracking-[-0.01em] text-text tabular-nums">{r.v}</b>
              {r.extra ? <small className="block text-caption font-semibold">{r.extra}</small> : null}
            </dd>
          </div>
        ))}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0 border-t border-divider px-4 py-2.5">
          <dt className="min-w-0 text-[13.5px] font-bold text-text">
            <span className="inline-flex items-center gap-1.5">
              {ut("dash.inProgress")}
              {live.length ? (
                <Tooltip label={ut("dashA.liveTip")}>
                  <span tabIndex={0} role="img" aria-label={ut("dashA.liveTip")} className="inline-block size-2 rounded-full bg-good" />
                </Tooltip>
              ) : null}
            </span>
            <small className="block truncate text-caption font-medium text-muted">
              {live.length ? [...new Set(live.map((r) => r.surveyTitle))].slice(0, 3).join(", ") : ut("dashA.nobodyNow")}
            </small>
          </dt>
          <dd className="m-0 text-right">
            <b className="block text-[18px] font-extrabold leading-6 text-text tabular-nums">{live.length}</b>
          </dd>
        </div>
      </dl>
    </Panel>
  );
}
