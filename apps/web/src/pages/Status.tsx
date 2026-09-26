import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { PublicServiceStatus, ServiceStatus } from "@quizzy/shared";
import { dateTime } from "../format";
import { useLang } from "../lang";
import { useServiceStatus } from "../service/status";
import { IconLock, IconOk, IconWarn, Loading } from "../ui";
import { cx } from "../ui/cx";
import { Page } from "../ui/layout";
import { RuleSection } from "../ui/section";
import { PublicFrame } from "./public/PublicFrame";

/**
 * Страница статуса — «всё работает / идут работы / сбои».
 *
 * Решение заказчика 2026-09-26 (техпанель, пункт 8): страница для
 * сотрудников, где видно текущее состояние и история последних объявлений;
 * открывается и без входа — ссылкой с экрана входа, потому что нужна она
 * именно тогда, когда войти не получается.
 *
 * Одна страница в трёх рамках: у гостя — лист публичных страниц (как вход),
 * у сотрудника — экран консоли, у пациента — узкая колонка кабинета.
 * Содержимое одно и то же, и расходиться ему нечем.
 *
 * Состояние названо словом и значком формы, а не только цветом: «працює» —
 * кружок с галочкой фиолетовым (состояние), «обслуговування» — замок,
 * «збої» — восклицательный знак; оба последних янтарём, потому что
 * требуют внимания.
 */
export default function StatusPage({ frame }: { frame: "public" | "console" | "patient" }) {
  const { ut } = useLang();
  const { status, unreachable } = useServiceStatus();
  const body = <StatusBody status={status} unreachable={unreachable} />;

  if (frame === "public") {
    return (
      <PublicFrame>
        <h1 className="m-0 mt-[57px] text-[32px] font-bold leading-[44px] text-primary">{ut("svc.title")}</h1>
        <div className="mt-[32px] max-w-[760px] text-text">{body}</div>
        <Link
          to="/login"
          className="mt-[24px] inline-block rounded-sm text-[17px] font-bold text-primary underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        >
          {ut("svc.toLogin")}
        </Link>
      </PublicFrame>
    );
  }
  if (frame === "patient") {
    return (
      <div className="mx-auto flex min-h-[100dvh] max-w-md flex-col gap-4 p-4">
        <h1 className="m-0 font-display text-section font-medium tracking-tight">{ut("svc.title")}</h1>
        {body}
        <Link
          to="/me"
          className="rounded-sm font-bold text-primary underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        >
          {ut("pt.home")}
        </Link>
      </div>
    );
  }
  return <Page title={ut("svc.title")}>{body}</Page>;
}

const GLYPH: Record<ServiceStatus, ReactNode> = {
  ok: <IconOk />,
  maintenance: <IconLock />,
  degraded: <IconWarn />,
};

/** Состояние и история — общее для трёх рамок и для раздела техпанели */
export function StatusBody({ status, unreachable }: { status: PublicServiceStatus | null; unreachable: boolean }) {
  const { ut } = useLang();
  if (!status && unreachable) return <p className="m-0 text-[16px] text-accent">{ut("svc.unreachable")}</p>;
  if (!status) return <Loading rows={3} />;

  const attention = status.status !== "ok";
  return (
    <div className="flex flex-col gap-[8px]">
      <StatusLine status={status.status} />
      {status.message ? (
        <p className="m-0 max-w-[640px] whitespace-pre-line text-[16px] leading-[22px] text-text">{status.message}</p>
      ) : null}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-[16px] gap-y-[4px] text-[14px] leading-[20px]">
        {status.since ? (
          <>
            <dt className="text-muted">{ut("svc.since")}</dt>
            <dd className="m-0 font-mono tabular-nums text-text">{dateTime(status.since)}</dd>
          </>
        ) : null}
        {status.expectedEnd ? (
          <>
            <dt className="text-muted">{ut("svc.until")}</dt>
            <dd className="m-0 font-mono tabular-nums text-text">{dateTime(status.expectedEnd)}</dd>
          </>
        ) : null}
      </dl>
      <p className={cx("m-0 text-[14px]", attention && !status.writable ? "text-accent" : "text-muted")}>
        {status.writable ? ut("svc.writeOpen") : ut("svc.writeClosed")}
      </p>
      {/* то, что сервер увидел сам: только молчащая база, ничего придуманного */}
      {status.auto === "db" ? <p className="m-0 text-[14px] text-accent">{ut("svc.autoDb")}</p> : null}
      {unreachable ? <p className="m-0 text-[14px] text-accent">{ut("svc.unreachable")}</p> : null}
      <p className="m-0 text-[11px] text-muted">
        {ut("svc.checkedAt")} <span className="font-mono tabular-nums">{dateTime(status.checkedAt)}</span>
      </p>

      <RuleSection title={ut("svc.history")} className="mt-[24px]">
        {status.history.length ? (
          <ul className="m-0 list-none p-0">
            {status.history.map((a) => (
              <li
                key={a.id}
                className="grid grid-cols-[200px_160px_1fr] gap-x-[24px] border-b border-hairline py-[10px] text-[14px] leading-[20px] max-[900px]:grid-cols-1 max-[900px]:gap-y-[2px]"
              >
                <span className="font-mono tabular-nums text-muted">{dateTime(a.at)}</span>
                <StatusLine status={a.status} small />
                <span className="min-w-0 whitespace-pre-line text-text [overflow-wrap:anywhere]">
                  {a.message ?? ""}
                  {a.expectedEnd ? (
                    <span className="block text-muted">
                      {ut("svc.until")} <span className="font-mono tabular-nums">{dateTime(a.expectedEnd)}</span>
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-[14px] text-muted">{ut("svc.noHistory")}</p>
        )}
      </RuleSection>
    </div>
  );
}

/** Состояние словом и значком — форма значка несёт то же, что цвет */
export function StatusLine({ status, small }: { status: ServiceStatus; small?: boolean }) {
  const { ut } = useLang();
  return (
    <span
      className={cx(
        "inline-flex items-center gap-[8px] font-bold",
        small ? "text-[14px] leading-[20px] [&_svg]:size-[16px]" : "text-[20px] leading-[24px] [&_svg]:size-[22px]",
        status === "ok" ? "text-primary" : "text-accent",
      )}
    >
      <span aria-hidden className="inline-flex shrink-0">
        {GLYPH[status]}
      </span>
      {ut(`svc.status.${status}`)}
    </span>
  );
}
