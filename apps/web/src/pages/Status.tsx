import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { PublicServiceStatus, ServiceAnnouncement, ServiceStatus } from "@quizzy/shared";
import { locale, timeOfDay } from "../format";
import { useLang } from "../lang";
import { minutesLeft, sameLocalDay, statusPollMs } from "../service/model";
import { refreshServiceStatus, useServiceStatus } from "../service/status";
import { ShellIcon, type IconName } from "../shell/icons";
import { Ic, Loading, Popover } from "../ui";
import { cx } from "../ui/cx";
import { IconTile, Page, Panel, type PanelTone } from "../ui/layout";
import { Button, ButtonLink, Tag, type TagTone } from "../ui/primitives";
import { AccessIcon } from "./public/accessIcons";
import { fill, rich } from "./public/authParts";
import { PublicFrame } from "./public/PublicFrame";

/**
 * Страница статуса — «всё работает / идут работы / сбои» (набор «Виразна»,
 * access-status).
 *
 * Решение заказчика 2026-09-26 (техпанель, пункт 8): страница для
 * сотрудников, где видно текущее состояние и история последних объявлений;
 * открывается и без входа — ссылкой с экрана входа, потому что нужна она
 * именно тогда, когда войти не получается.
 *
 * Одна страница в трёх рамках: у гостя — гостевая рамка (как вход), у
 * сотрудника — экран консоли, у пациента — узкая колонка кабинета.
 * Содержимое одно и то же, и расходиться ему нечем.
 *
 * Всё на экране — из ответа GET /api/status: состояние, объявление, начало и
 * ожидаемый конец, принимает ли сервер изменения, молчит ли база, история
 * объявлений. «Що працює зараз» — те же поля, разложенные по тому, что
 * человек делает: смотрит, сохраняет, ждёт ответов пациентов.
 *
 * Состояние названо словом и значком формы, а не только цветом; янтарь —
 * «требует внимания», красного здесь нет: это не риск для человека.
 */
export default function StatusPage({ frame }: { frame: "public" | "console" | "patient" }) {
  const { ut } = useLang();
  const { status, unreachable } = useServiceStatus();
  const [checking, setChecking] = useState(false);
  const check = () => {
    setChecking(true);
    void refreshServiceStatus().finally(() => setChecking(false));
  };
  const checkedLine = status ? (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-small text-muted">
      <AccessIcon name="refresh-cw" size={14} />
      <span>
        {rich(ut("ax.st.checked"), {
          time: <b className="font-bold tabular-nums text-text">{clock(status.checkedAt)}</b>,
        })}
        , {pollText(ut, statusPollMs(status))}
      </span>
    </span>
  ) : null;
  const checkButton = (
    <Button variant="ghost" icon={<AccessIcon name="refresh-cw" />} disabled={checking} onClick={check}>
      {checking ? ut("conn.checking") : ut("conn.checkNow")}
    </Button>
  );

  if (frame === "console") {
    return (
      <Page
        title={ut("svc.title")}
        actions={
          <>
            {checkedLine}
            {checkButton}
          </>
        }
      >
        <StatusBody status={status} unreachable={unreachable} />
      </Page>
    );
  }

  if (frame === "patient") {
    return (
      <div className="mx-auto flex min-h-[100dvh] max-w-[560px] flex-col gap-4 p-4 text-[16px]">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 text-title font-extrabold text-text">{ut("svc.title")}</h1>
          <span className="ml-auto">{checkButton}</span>
        </div>
        <StatusBody status={status} unreachable={unreachable} narrow />
        <Link to="/me" className="self-start rounded-[6px] font-bold text-violet-ink no-underline hover:underline">
          {ut("pt.home")}
        </Link>
      </div>
    );
  }

  return (
    <PublicFrame>
      <div className="pb-4 pt-4">
        <header className="mb-4 flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="m-0 whitespace-nowrap text-page font-extrabold text-text">{ut("svc.title")}</h1>
          <div className="flex flex-col border-l border-border pl-4 text-[13px] leading-[18px] text-text-2">
            <b className="font-extrabold text-text">{ut("ax.st.meta1")}</b>
            <span>{ut("ax.st.meta2")}</span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {checkedLine}
            {checkButton}
            <ButtonLink to="/login">
              <ShellIcon name="log-in" size={15} />
              {ut("svc.toLogin")}
            </ButtonLink>
          </div>
        </header>
        <StatusBody status={status} unreachable={unreachable} />
      </div>
    </PublicFrame>
  );
}

/** Время проверки с секундами: «17:00:12» — проверка идёт каждые полминуты */
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function pollText(ut: ReturnType<typeof useLang>["ut"], ms: number): string {
  return ms >= 60_000 ? fill(ut("ax.st.everyMin"), { n: Math.round(ms / 60_000) }) : fill(ut("ax.st.everySec"), { n: Math.round(ms / 1000) });
}

/** Значок и тон состояния — один на все места страницы */
const LOOK: Record<ServiceStatus, { icon: IconName; tag: TagTone; tile: PanelTone }> = {
  ok: { icon: "circle-check", tag: "good", tile: "good" },
  maintenance: { icon: "wrench", tag: "attention", tile: "warn" },
  degraded: { icon: "circle-alert", tag: "attention", tile: "warn" },
};

/** Состояние и история — общее для трёх рамок (и проверяется тестом opsMaint) */
export function StatusBody({
  status,
  unreachable,
  narrow,
}: {
  status: PublicServiceStatus | null;
  unreachable: boolean;
  /** Колонка кабинета пациента: всё одной стопкой */
  narrow?: boolean;
}) {
  const { ut } = useLang();
  if (!status && unreachable) {
    return (
      <section
        aria-label={ut("ax.st.downTitle")}
        className="flex items-start gap-4 rounded-[18px] border border-warn-line bg-warn-tint p-5"
      >
        <IconTile icon={<ShellIcon name="wifi-off" />} tone="warn" size={48} className="!bg-panel" />
        <div>
          <h2 className="m-0 text-big font-extrabold text-text">{ut("ax.st.downTitle")}</h2>
          <p className="m-0 mt-1.5 text-body text-text-2">{ut("svc.unreachable")}</p>
        </div>
      </section>
    );
  }
  if (!status) return <Loading rows={3} />;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <NowState status={status} unreachable={unreachable} />
      <div
        className={cx(
          "grid min-w-0 items-start gap-4",
          narrow ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_440px] max-[1180px]:grid-cols-[minmax(0,1fr)_360px] max-[960px]:grid-cols-1",
        )}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <Capabilities status={status} unreachable={unreachable} />
          <History status={status} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {status.status === "ok" && !unreachable ? null : (
            <Panel title={ut("ax.st.todoTitle")} icon={<ShellIcon name="list-checks" />}>
              <ul className="m-0 list-none p-0">
                <Todo icon={<ShellIcon name="stethoscope" size={17} />} title={ut("ax.st.todoStaffT")}>
                  {ut("ax.st.todoStaff")}
                </Todo>
                <Todo icon={<ShellIcon name="smartphone" size={17} />} title={ut("ax.st.todoPtT")}>
                  {ut("ax.st.todoPt")}
                </Todo>
              </ul>
            </Panel>
          )}
          <CrisisCalls />
        </div>
      </div>
    </div>
  );
}

/** Сейчас: состояние крупно, объявление словами объявившего, начало и ожидаемый конец */
function NowState({ status, unreachable }: { status: PublicServiceStatus; unreachable: boolean }) {
  const { ut } = useLang();
  const [now, setNow] = useState(() => Date.now());
  const ticking = !!status.expectedEnd && status.status !== "ok";
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [ticking]);

  const s = status.status;
  const look = LOOK[s];
  const attention = s !== "ok" || unreachable;
  const title = s === "maintenance" ? ut("svc.banner.maintenance") : s === "degraded" ? ut("svc.banner.degraded") : ut("ax.st.okTitle");
  /* сегодня — только часы; другой день — «18.10, 21:00»: полная дата не помещается в колонку */
  const at = (iso: string) =>
    sameLocalDay(iso, now)
      ? timeOfDay(iso)
      : `${new Date(iso).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" })}, ${timeOfDay(iso)}`;
  const left = minutesLeft(status.expectedEnd, now);
  const span =
    status.since && status.expectedEnd ? Date.parse(status.expectedEnd) - Date.parse(status.since) : 0;
  const pct = span > 0 ? Math.min(100, Math.max(0, ((now - Date.parse(status.since!)) / span) * 100)) : 0;
  const showWhen = attention && (status.since || status.expectedEnd);

  return (
    <section
      aria-label={title}
      className={cx(
        "grid items-center gap-5 rounded-[18px] border py-5 pl-5 pr-[22px]",
        showWhen ? "grid-cols-[56px_minmax(0,1fr)_260px] max-[900px]:grid-cols-[56px_minmax(0,1fr)]" : "grid-cols-[56px_minmax(0,1fr)]",
        attention ? "border-warn-line bg-warn-tint" : "border-good-line bg-good-tint",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "grid size-14 place-items-center self-start rounded-[17px] bg-panel supports-[corner-shape:squircle]:rounded-[18px] supports-[corner-shape:squircle]:[corner-shape:squircle]",
          attention ? "text-warn" : "text-good",
        )}
      >
        <ShellIcon name={look.icon} size={24} />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="m-0 text-big font-extrabold text-text">{title}</h2>
          <Tag tone={look.tag} icon={<ShellIcon name={look.icon} size={12} />}>
            {ut(`svc.status.${s}`)}
          </Tag>
        </div>
        {status.message ? (
          <p className="m-0 mt-1.5 max-w-[720px] whitespace-pre-line text-body leading-5 text-text-2 [overflow-wrap:anywhere]">
            {status.message}
          </p>
        ) : null}
        {s === "ok" ? (
          <p className="m-0 mt-1.5 text-body text-text-2">{ut("svc.writeOpen")}</p>
        ) : (
          <p className={cx("m-0 mt-1.5 flex items-center gap-1.5 text-body font-extrabold", status.writable ? "text-text-2" : "text-warn")}>
            {status.writable ? <Ic.check size={15} /> : <Ic.lock size={15} />}
            {status.writable ? ut("svc.writeOpen") : ut("svc.writeClosed")}
          </p>
        )}
        {/* то, что сервер увидел сам: только молчащая база, ничего придуманного */}
        {status.auto === "db" ? <p className="m-0 mt-1 text-body font-bold text-warn">{ut("svc.autoDb")}</p> : null}
        {unreachable ? <p className="m-0 mt-1 text-body font-bold text-warn">{ut("svc.unreachable")}</p> : null}
      </div>
      {showWhen ? (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-l border-warn-line pl-5 text-[13px] leading-[19px] max-[900px]:col-span-2 max-[900px]:border-l-0 max-[900px]:border-t max-[900px]:pl-0 max-[900px]:pt-3">
          {status.since ? (
            <>
              <dt className="font-semibold text-text-2">{ut("svc.since")}</dt>
              <dd className="m-0 text-right font-extrabold tabular-nums text-text">{at(status.since)}</dd>
            </>
          ) : null}
          {status.expectedEnd ? (
            <>
              <dt className="font-semibold text-text-2">{ut("svc.until")}</dt>
              <dd className="m-0 text-right font-extrabold tabular-nums text-text">{at(status.expectedEnd)}</dd>
            </>
          ) : null}
          {status.since && status.expectedEnd ? (
            <dd className="col-span-2 m-0 mt-1.5 flex flex-col items-stretch gap-1 text-right text-caption font-semibold text-text-2">
              <span className="h-1.5 w-full overflow-hidden rounded-[3px] bg-warn-line">
                <i className="block h-full rounded-[3px] bg-warn" style={{ width: `${pct}%` }} />
              </span>
              <span>{left !== null ? fill(ut("ax.st.leftMin"), { n: left }) : ut("ax.st.overdue")}</span>
            </dd>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}

/** Что работает: то же состояние, разложенное по делам человека */
function Capabilities({ status, unreachable }: { status: PublicServiceStatus; unreachable: boolean }) {
  const { ut } = useLang();
  const unknown = <Tag tone="plain">{ut("ax.st.unknown")}</Tag>;
  const good = (text: string) => (
    <Tag tone="good" icon={<Ic.check />}>
      {text}
    </Tag>
  );
  const warn = (text: string, icon: ReactNode) => (
    <Tag tone="attention" icon={icon}>
      {text}
    </Tag>
  );
  const dbDown = status.auto === "db";
  const rows: { icon: ReactNode; tone: PanelTone; title: string; text: string; badge: ReactNode }[] = [
    {
      icon: <ShellIcon name="log-in" />,
      tone: unreachable ? "neutral" : "good",
      title: ut("ax.st.capView"),
      text: ut("ax.st.capViewText"),
      badge: unreachable ? unknown : good(ut("ax.st.works")),
    },
    {
      icon: status.writable ? <ShellIcon name="file-pen-line" /> : <Ic.lock />,
      tone: unreachable ? "neutral" : status.writable ? "good" : "warn",
      title: ut("ax.st.capSave"),
      text: status.writable ? ut("ax.st.capSaveOn") : ut("ax.st.capSaveOff"),
      badge: unreachable ? unknown : status.writable ? good(ut("ax.st.works")) : warn(ut("ax.st.paused"), <AccessIcon name="pause" />),
    },
    {
      icon: <ShellIcon name="smartphone" />,
      tone: unreachable ? "neutral" : status.writable ? "good" : "warn",
      title: ut("ax.st.capAnswers"),
      text: status.writable ? ut("ax.st.capAnswersOn") : ut("ax.st.capAnswersOff"),
      badge: unreachable ? unknown : status.writable ? good(ut("ax.st.arriving")) : warn(ut("ax.st.queued"), <AccessIcon name="clock" />),
    },
    {
      icon: <ShellIcon name="database" />,
      tone: unreachable ? "neutral" : dbDown ? "warn" : "good",
      title: ut("ax.st.capDb"),
      text: dbDown ? ut("svc.autoDb") : ut("ax.st.capDbOk"),
      badge: unreachable ? unknown : dbDown ? warn(ut("ax.st.dbDown"), <ShellIcon name="circle-alert" />) : good(ut("ax.st.dbOk")),
    },
  ];
  return (
    <Panel
      title={ut("ax.st.capsTitle")}
      icon={<AccessIcon name="activity" />}
      sub={fill(ut("ax.st.checked"), { time: clock(status.checkedAt) })}
      flush
    >
      <ul className="m-0 list-none border-t border-divider p-0">
        {rows.map((r) => (
          <li
            key={r.title}
            className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-b border-divider px-4 py-3 text-small leading-[17px] text-text-2 last:border-b-0"
          >
            <IconTile icon={r.icon} tone={r.tone} />
            <span className="min-w-0">
              <b className="block text-body font-extrabold leading-[19px] text-text">{r.title}</b>
              {r.text}
            </span>
            {r.badge}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

const DAY_MS = 86_400_000;
const RANK: Record<ServiceStatus, number> = { ok: 0, maintenance: 1, degraded: 2 };

/** Ключ местного дня: «2026-10-08» по часам этого компьютера */
function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * История: полоса 30 дней (день — клетка, цвет — худшее объявленное в тот
 * день, с подписью в поповере) и список объявлений словами.
 */
function History({ status }: { status: PublicServiceStatus }) {
  const { ut } = useLang();
  const now = Date.now();
  const byDay = new Map<string, ServiceAnnouncement[]>();
  for (const a of status.history) {
    const k = dayKey(Date.parse(a.at));
    byDay.set(k, [...(byDay.get(k) ?? []), a]);
  }
  const days = Array.from({ length: 30 }, (_, i) => now - (29 - i) * DAY_MS);
  let maint = 0;
  let degraded = 0;
  let quiet = 0;
  const cells = days.map((t, i) => {
    const events = (byDay.get(dayKey(t)) ?? []).filter((a) => a.status !== "ok");
    const today = i === 29;
    const live = today && status.status !== "ok";
    const worst = events.reduce<ServiceStatus>((w, a) => (RANK[a.status] > RANK[w] ? a.status : w), live ? status.status : "ok");
    maint += events.filter((a) => a.status === "maintenance").length;
    degraded += events.filter((a) => a.status === "degraded").length;
    if (worst === "ok") quiet += 1;
    const date = new Date(t).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" });
    const cls = cx(
      "block h-[34px] min-w-0 flex-1 rounded-[4px]",
      worst === "ok" && "bg-good-tint shadow-[inset_0_0_0_1px_var(--goodline)]",
      worst === "maintenance" && !live && "bg-warn-tint-2 shadow-[inset_0_0_0_1px_var(--warnline)]",
      worst === "degraded" && !live && "bg-warn",
      live && "bg-warn-tint-2 shadow-[inset_0_0_0_1.5px_var(--warn)]",
    );
    if (worst === "ok") return <i key={t} className={cls} title={date} />;
    return (
      <Popover
        key={t}
        title={date}
        note={today ? ut("ax.st.today") : undefined}
        content={
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {(events.length ? events : [{ id: "now", status: status.status, message: status.message, at: status.since ?? "", expectedEnd: status.expectedEnd }]).map((a) => (
              <li key={a.id}>
                <b>{ut(`svc.status.${a.status}`)}</b>
                {a.at ? `, ${timeOfDay(a.at)}` : ""}
                {a.message ? <span className="block opacity-80">{a.message}</span> : null}
              </li>
            ))}
          </ul>
        }
      >
        <i tabIndex={0} aria-label={`${date}: ${ut(`svc.status.${worst}`)}`} className={cx(cls, "cursor-default focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--vring)]")} />
      </Popover>
    );
  });
  const summary = [
    fill(ut("ax.st.lgOk"), { n: quiet }),
    fill(ut("ax.st.lgMaint"), { n: maint }),
    fill(ut("ax.st.lgDegraded"), { n: degraded }),
  ];
  const fmt = (t: number) => new Date(t).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" });

  return (
    <Panel title={ut("svc.history")} icon={<Ic.history />} sub={ut("ax.st.histSub")} flush>
      <div className="px-4 pb-4 pt-1">
        <div role="img" aria-label={fill(ut("ax.st.stripAlt"), { summary: summary.join("; ") })} className="flex gap-[3px]">
          {cells}
        </div>
        <div className="mt-1.5 flex justify-between text-[11.5px] font-semibold text-muted">
          <span>{fmt(days[0]!)}</span>
          <span>{fmt(days[15]!)}</span>
          <span>
            {ut("ax.st.today")}, {fmt(now)}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-small text-text-2">
          <span className="inline-flex items-center gap-1.5">
            <i className="size-3 rounded-[3px] bg-good-tint shadow-[inset_0_0_0_1px_var(--goodline)]" />
            {summary[0]}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="size-3 rounded-[3px] bg-warn-tint-2 shadow-[inset_0_0_0_1px_var(--warnline)]" />
            {summary[1]}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="size-3 rounded-[3px] bg-warn" />
            {summary[2]}
          </span>
        </div>
      </div>
      {status.history.length ? (
        <ul className="m-0 list-none border-t border-divider p-0">
          {status.history.map((a) => (
            <li
              key={a.id}
              className="grid grid-cols-[112px_28px_minmax(0,1fr)] items-start gap-3 border-b border-divider px-4 py-2.5 text-small leading-[18px] text-text-2 last:border-b-0 max-[600px]:grid-cols-[28px_minmax(0,1fr)]"
            >
              <span className="pt-1 tabular-nums max-[600px]:hidden">
                <b className="font-extrabold text-text">{new Date(a.at).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit" })}</b>{" "}
                <span className="text-muted">{timeOfDay(a.at)}</span>
              </span>
              <IconTile icon={<ShellIcon name={LOOK[a.status].icon} />} tone={a.status === "ok" ? "neutral" : "warn"} size={28} />
              <span className="min-w-0 pt-1 [overflow-wrap:anywhere]">
                <b className={cx("font-extrabold", a.status === "ok" ? "text-text" : "text-warn")}>{ut(`svc.status.${a.status}`)}</b>
                {a.expectedEnd ? `, ${fill(ut("ax.st.untilShort"), { time: timeOfDay(a.expectedEnd) })}` : ""}
                {a.message ? <span className="whitespace-pre-line">{`. ${a.message}`}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 border-t border-divider px-4 py-3 text-small text-muted">{ut("svc.noHistory")}</p>
      )}
    </Panel>
  );
}

function Todo({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[36px_minmax(0,1fr)] items-start gap-3 border-t border-divider py-2.5 text-small leading-[18px] text-text-2 first:border-t-0 first:pt-0.5">
      <IconTile icon={icon} size={36} />
      <span>
        <b className="block text-body font-extrabold leading-[19px] text-text">{title}</b>
        {children}
      </span>
    </li>
  );
}

/** Термінова допомога — не зависит от системы: Лайфлайн и 103 ссылками tel: */
function CrisisCalls() {
  const { ut } = useLang();
  const rows = [
    { key: "hotline", name: ut("home.hotline"), sub: ut("pt.helpHotlineSub"), num: ut("home.hotlineNumber"), risk: false },
    { key: "emergency", name: ut("pt.emergency"), sub: ut("pt.emergencySub"), num: ut("pt.emergencyNumber"), risk: true },
  ];
  return (
    <Panel title={ut("ax.st.crisisTitle")} icon={<ShellIcon name="life-buoy" />}>
      <p className="m-0 -mt-1 mb-2.5 text-small text-text-2">{ut("ax.st.crisisLead")}</p>
      <div className="overflow-hidden rounded-[16px] border border-border">
        {rows.map((r) => (
          <a
            key={r.key}
            href={`tel:${r.num}`}
            aria-label={`${ut("pt.helpCall")}: ${r.name}, ${r.num}`}
            className="group grid min-h-[64px] grid-cols-[minmax(0,1fr)_auto_44px] items-center gap-3 border-t border-divider py-2 pl-4 pr-3 text-text no-underline first:border-t-0 hover:bg-panel-2 hover:no-underline"
          >
            <span className="min-w-0">
              <b className={cx("block text-[16px] font-extrabold leading-[22px]", r.risk && "text-risk-ink")}>{r.name}</b>
              <small className="block truncate text-small font-semibold text-muted">{r.sub}</small>
            </span>
            <span className={cx("text-[20px] font-extrabold leading-none tabular-nums", r.risk ? "text-risk-ink" : "text-violet-ink")}>
              {r.num}
            </span>
            <span
              aria-hidden
              className={cx(
                "grid size-11 place-items-center rounded-[14px]",
                r.risk ? "bg-risk text-onfill group-hover:bg-risk-hover" : "bg-violet-tint text-violet-ink group-hover:bg-violet-tint-2",
              )}
            >
              <ShellIcon name="phone" size={19} />
            </span>
          </a>
        ))}
      </div>
    </Panel>
  );
}
