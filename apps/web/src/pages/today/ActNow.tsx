import type { ComponentType } from "react";
import { Link } from "react-router-dom";
import type { AlertCase, AppointmentView, WorkItem } from "@quizzy/shared";
import { ApiError, api } from "../../api";
import { day } from "../../format";
import { AlertChip, AlertStrip, Avatar, Callout, Kbd, Skeleton } from "../../ui";
import { cx } from "../../ui/cx";
import { Ic, type IconProps } from "../../ui/icons";
import { Panel } from "../../ui/layout";
import { Button, ButtonLink, Tag } from "../../ui/primitives";
import { TextAction } from "../../ui/records";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { fill } from "../dashboard/model";
import { workWhy } from "../worklist/model";
import { Di } from "./icons";
import { caseTimer, hhmm, hmm, localDate, overdueWork, type Timer } from "./model";
import type { DrawerTarget } from "./drawers";

/**
 * «Дія зараз» — человек, которому нужно действие прямо сейчас, плиткой со
 * всем его открытым, и справа — остальное срочное.
 *
 * Сверху — самый срочный открытый случай риска (urgentCases): таймер нормы
 * разбора, «Розібрати» (клавиша R), письмо без ответа (M) и строка
 * открытого — неявки, просроченные назначения, приём сегодня. Справа —
 * следующие случаи и просроченное из очереди.
 *
 * «Розібрати» ведёт на разбор случая — экран «Випадки ризику» с отбором по
 * человеку (/alerts?patient=…): сам разбор принадлежит ему.
 */

export function reviewHref(userId: string): string {
  return `/alerts?patient=${encodeURIComponent(userId)}`;
}

/**
 * Случаи риска — или null, если разбор не положен (403).
 *
 * Только отказ в праве значит «случаев здесь не показываем». Прежде любой
 * отказ (обрыв, пятисотка) превращался в тот же null, и «Дія зараз»
 * говорила «Нічого термінового», а зведення убирало віджет случаев и
 * писало «Відкритих випадків 0» — открытый риск прятался за сбоем загрузки.
 * Прочие отказы уходят дальше: экран показывает их словами с «повторити».
 * По ответу сервера, а не по правам в консоли: не дошедший при входе
 * справочник прав спрятал бы риск так же.
 */
export function unlessForbidden<T>(load: Promise<T>): Promise<T | null> {
  return load.catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 403) return null;
    throw e;
  });
}

/** Случаи не загрузились: что это значит и «повторити» — вместо «нічого термінового» */
export function CasesFailed({ error, onRetry }: { error: string; onRetry?: () => void }) {
  const { ut } = useLang();
  return (
    <Callout
      kind="warn"
      role="alert"
      title={ut("dayA.casesFailed")}
      actions={
        onRetry ? (
          <Button size="xs" icon={<Ic.refresh />} onClick={onRetry}>
            {ut("common.retry")}
          </Button>
        ) : undefined
      }
    >
      {error}
    </Callout>
  );
}

/** «4 год», «30 хв», «1 год 30 хв» */
export function useNormText() {
  const { ut } = useLang();
  return (minutes: number) => {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return [h ? fill(ut("dayA.hours"), { n: h }) : null, m ? fill(ut("dayA.minutes"), { n: m }) : null].filter(Boolean).join(" ");
  };
}

/** Таймер случая крупно: «2:48 з 4 год», полоска, «лишилось 1:12» */
export function BigTimer({ t }: { t: Timer }) {
  const { ut } = useLang();
  const norm = useNormText();
  const over = t.left < 0;
  return (
    <span className="flex flex-col items-end gap-[5px] whitespace-nowrap text-caption font-semibold leading-[14px] text-text-2">
      <span className="flex items-baseline gap-[5px]">
        <b className="text-[24px] font-extrabold leading-none tracking-[-0.03em] text-risk-ink tabular-nums">{t.elapsed}</b>
        {fill(ut("dayA.ofNorm"), { norm: norm(t.norm) })}
      </span>
      <span aria-hidden className="block h-1.5 w-[104px] overflow-hidden rounded-[3px] bg-risk-line">
        <i className="block h-full rounded-[3px] bg-risk" style={{ width: `${t.pct}%` }} />
      </span>
      <span className={over ? "font-bold text-risk-ink" : undefined}>
        {over ? fill(ut("dayA.overBy"), { t: hmm(-t.left) }) : fill(ut("dayA.leftT"), { t: hmm(t.left) })}
      </span>
    </span>
  );
}

/** Подпись сигнала: методика, пункт и ответ */
export function signalText(c: AlertCase, ut: (k: never) => string): string {
  const s = c.signals[0];
  const t = (k: string) => ut(k as never);
  const head = fill(t("dayA.surveyFrom"), { survey: c.surveyTitle, d: day(c.openedAt) });
  return s ? `${head}: ${s.questionTitle} — «${s.label}»` : head;
}

const KIND_ICON: Record<WorkItem["kind"], ComponentType<IconProps>> = {
  noshow: Di.calendarX,
  message: Ic.message,
  dispensary: Di.repeat,
  followup: Di.clipboardCheck,
  referral: Di.arrows,
  assignment: Di.clipboardCheck,
};

export function WorkIcon({ kind, size = 15 }: { kind: WorkItem["kind"]; size?: number }) {
  const I = KIND_ICON[kind];
  return <I size={size} />;
}

export function ActNow({
  cases,
  work,
  appointments,
  meId,
  onReply,
  loading = false,
  casesError = null,
  onRetryCases,
}: {
  /** Открытые случаи в порядке срочности (urgentCases); null — разбор не положен или они не пришли */
  cases: AlertCase[] | null;
  /** Случаи и очередь ещё в пути: «нічого термінового» до ответа было бы неправдой */
  loading?: boolean;
  /** Случаи не загрузились: «нічого термінового» при этом было бы неправдой тоже */
  casesError?: string | null;
  onRetryCases?: () => void;
  work: WorkItem[];
  appointments: readonly AppointmentView[];
  meId: string | null;
  onReply: (t: DrawerTarget) => void;
}) {
  const { ut } = useLang();
  const norm = useNormText();
  const hero = cases?.[0] ?? null;
  const heroWork = hero ? work.filter((w) => w.userId === hero.userId) : [];
  const heroMsg = heroWork.find((w) => w.kind === "message") ?? null;
  const heroSession = hero ? appointments.find((a) => a.patientId === hero.userId && a.status !== "cancelled") : undefined;
  /* справа — два пункта, как на кадре: третий уже не «зараз», а очередь */
  const sideCases = (cases ?? []).slice(1, 3);
  const sideWork = overdueWork(work)
    .filter((w) => w.userId !== hero?.userId)
    .slice(0, Math.max(0, (hero ? 2 : 4) - sideCases.length));
  const total = cases?.length ?? 0;
  const norms = [...new Set((cases ?? []).map((c) => c.escalateMinutes).filter((n): n is number => !!n))];

  const sub =
    norms.length === 1 ? fill(ut("dayA.nowSubNorm"), { norm: norm(norms[0]!) }) : ut("dayA.nowSub");

  return (
    <Panel
      title={ut("dayA.actNow")}
      icon={<Di.zap />}
      sub={sub}
      actions={cases ? <TextAction to="/alerts">{fill(ut("dayA.casesN"), { n: total })}</TextAction> : null}
      flush
    >
      {casesError && !loading ? (
        <div className="px-2.5 pb-2.5">
          <CasesFailed error={casesError} onRetry={onRetryCases} />
        </div>
      ) : null}
      {loading ? (
        <div className="px-4 pb-4" role="status" aria-label={ut("common.loading")}>
          <Skeleton lines={3} />
        </div>
      ) : !hero && !sideWork.length ? (
        casesError ? null : (
          <p className="m-0 mx-2.5 mb-2.5 flex items-center gap-2.5 rounded-[12px] bg-good-tint px-3.5 py-3 text-small font-semibold text-good">
            <Ic.circleCheck size={17} />
            {ut("dayA.nothingUrgent")}
          </p>
        )
      ) : (
        <div
          className={cx(
            "grid items-start gap-5 px-2.5 pb-2.5",
            hero ? "grid-cols-[minmax(0,1fr)_minmax(300px,400px)] max-[1180px]:grid-cols-1" : "grid-cols-[repeat(auto-fit,minmax(300px,1fr))]",
          )}
        >
          {hero ? (
            <HeroTile c={hero} msg={heroMsg} others={heroWork.filter((w) => w.kind !== "message")} session={heroSession} onReply={onReply} />
          ) : null}
          {/*
            Без героя плитки встают в сетку рядом — «contents» без «flex»: оба
            класса сразу решала очерёдность в таблице стилей, и побеждал
            столбец — плитки шли одна под другой во всю ширину.
          */}
          <div className={hero ? "flex min-w-0 flex-col gap-2" : "contents"}>
            {sideCases.map((c) => (
              <CaseTile key={c.id} c={c} meId={meId} />
            ))}
            {sideWork.map((w) => (
              <WorkTile key={`${w.kind}-${w.id}`} w={w} onReply={onReply} />
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

function HeroTile({
  c,
  msg,
  others,
  session,
  onReply,
}: {
  c: AlertCase;
  msg: WorkItem | null;
  others: WorkItem[];
  session: AppointmentView | undefined;
  onReply: (t: DrawerTarget) => void;
}) {
  const { ut } = useLang();
  const timer = caseTimer(c);
  const due = timer ? hhmm(timer.due) : null;
  const quote = useResource(
    () =>
      msg
        ? api.thread(msg.id).then((t) => [...t.items].reverse().find((m) => !m.mine)?.text ?? null).catch(() => null)
        : Promise.resolve(null),
    [msg?.id],
  );
  const reply = () => onReply({ patientId: c.userId, patientName: c.userName, threadId: msg?.id ?? null });

  return (
    <div className="min-w-0 rounded-[16px] bg-panel-2 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="flex items-center gap-3 px-0.5 pb-3">
        <Avatar name={c.userName} size={44} />
        <div className="flex min-w-0 flex-col gap-[3px]">
          <h3 className="m-0 truncate text-[17px] font-extrabold leading-[22px] tracking-[-0.02em] text-text">
            <Link to={`/patients/${c.userId}`} className="text-text no-underline hover:underline hover:decoration-violet-line hover:decoration-2 hover:underline-offset-[3px]">
              {c.userName}
            </Link>
          </h3>
          <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-small text-text-2">
            {c.unit ? (
              <span className="inline-flex items-center gap-1.5">
                <Ic.user size={14} className="text-muted" />
                {c.unit}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5">
              <Di.clipboardCheck size={14} className="text-muted" />
              {c.surveyTitle}
            </span>
            {session ? (
              <span className="inline-flex items-center gap-1.5">
                <Ic.calendar size={14} className="text-muted" />
                <span className="text-muted">{ut("dayA.sessionToday")}</span>
                <b className="font-extrabold text-text tabular-nums">{hhmm(session.startsAt)}</b>
              </span>
            ) : null}
          </span>
        </div>
        <ButtonLink to={`/patients/${c.userId}`} variant="ghost" size="xs" className="ml-auto">
          <Di.outLink />
          {ut("dayA.card")}
        </ButtonLink>
      </div>

      <div className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0 rounded-[12px] bg-risk-tint p-2.5 max-[900px]:grid-cols-[36px_minmax(0,1fr)]">
        <span aria-hidden className="grid size-9 place-items-center rounded-[11px] bg-risk text-onfill">
          <Ic.alert size={18} />
        </span>
        <div className="min-w-0 text-small text-text-2">
          <b className="block text-[14px] font-extrabold leading-5 text-risk-ink">
            {due ? fill(ut("dayA.reviewBy"), { t: due }) : ut("dayA.reviewNow")}
          </b>
          <span className="line-clamp-2">{signalText(c, ut)}</span>
          {c.assignedToName ? <span className="block text-muted">{fill(ut("dayA.heldBy"), { name: c.assignedToName })}</span> : null}
        </div>
        <div className="flex items-center gap-2.5 max-[900px]:col-start-2 max-[900px]:mt-2">
          {timer ? <BigTimer t={timer} /> : null}
          <ButtonLink to={reviewHref(c.userId)} variant="risk" size="md" aria-keyshortcuts="R">
            {ut("dayA.review")}
          </ButtonLink>
          <Kbd>R</Kbd>
        </div>
      </div>

      {msg ? (
        <div className="mt-1.5 grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0 rounded-[12px] bg-panel p-2.5 max-[900px]:grid-cols-[36px_minmax(0,1fr)]">
          <span aria-hidden className="grid size-9 place-items-center rounded-[11px] bg-info-tint text-info">
            <Ic.message size={18} />
          </span>
          <div className="min-w-0 text-small text-text-2">
            <b className="block text-[14px] font-extrabold leading-5 text-text">
              {fill(ut("dayA.noAnswerSince"), { at: stamp(msg.since) === hhmm(msg.since) ? hhmm(msg.since) : `${day(msg.since)}, ${hhmm(msg.since)}` })}
            </b>
            {quote.data ? (
              <q className="line-clamp-2 font-semibold text-text">{quote.data}</q>
            ) : quote.loading ? (
              <span className="mt-1 block w-3/4">
                <Skeleton lines={1} />
              </span>
            ) : (
              <span>{workWhy(msg, ut)}</span>
            )}
          </div>
          <div className="flex items-center gap-2.5 max-[900px]:col-start-2 max-[900px]:mt-2">
            <Button variant="primary" size="md" icon={<Ic.reply />} onClick={reply} aria-keyshortcuts="M">
              {ut("dayA.replyBtn")}
            </Button>
            <Kbd>M</Kbd>
          </div>
        </div>
      ) : null}

      {others.length || (c.group?.cases ?? 1) > 1 ? (
        <AlertStrip className="mt-2.5 gap-1.5" label={fill(ut("dayA.openOf"), { name: c.userName })}>
          {(c.group?.cases ?? 1) > 1 ? (
            <AlertChip
              kind="neutral"
              icon={<Ic.alert />}
              label={fill(ut("dayA.moreCases"), { n: (c.group?.cases ?? 1) - 1 })}
              to={reviewHref(c.userId)}
            />
          ) : null}
          {others.map((w) => (
            <AlertChip
              key={`${w.kind}-${w.id}`}
              kind={w.overdue || w.kind === "noshow" ? "warn" : "neutral"}
              icon={<WorkIcon kind={w.kind} />}
              label={chipLabel(w, ut)}
              detail={w.overdue ? ut("dayA.overdueWord") : day(w.since)}
              to={w.href}
              pop={workWhy(w, ut)}
              popTitle={chipLabel(w, ut)}
            />
          ))}
        </AlertStrip>
      ) : null}
    </div>
  );
}

/** Сегодняшнее — временем, давнее — днём: «Лист 16:20», «Лист 15 жовт.» */
export function stamp(iso: string, now = Date.now()): string {
  return localDate(new Date(iso)) === localDate(new Date(now)) ? hhmm(iso) : day(iso);
}

/** Короткое имя пункта очереди для пилюли */
export function chipLabel(w: WorkItem, ut: (k: never) => string): string {
  const t = (k: string) => ut(k as never);
  switch (w.kind) {
    case "noshow":
      return fill(t("dayA.chipNoshow"), { d: day(w.since) });
    case "message":
      return fill(t("dayA.chipMessage"), { t: stamp(w.since) });
    case "assignment":
      return w.title;
    case "followup":
      return fill(t("dayA.chipFollowup"), { title: w.title });
    case "dispensary":
      return t("dayA.chipDispensary");
    case "referral":
      return t("dayA.chipReferral");
  }
}

function CaseTile({ c, meId }: { c: AlertCase; meId: string | null }) {
  const { ut } = useLang();
  const timer = caseTimer(c);
  const foreign = c.assignedTo && c.assignedTo !== meId;
  return (
    <div className="grid grid-cols-[36px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-[14px] bg-panel-2 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
      <span aria-hidden className="grid size-9 place-items-center rounded-[11px] bg-risk-tint text-risk-ink">
        <Ic.alert size={18} />
      </span>
      <div className="min-w-0">
        <b className="block text-[14px] font-extrabold leading-5 text-text">
          {fill(ut("dayA.signalAt"), { d: day(c.openedAt), t: hhmm(c.openedAt) })}
        </b>
        <Link to={`/patients/${c.userId}`} className="block truncate text-small font-bold text-text-2 no-underline hover:underline">
          {c.userName}
        </Link>
        <p className="m-0 mt-0.5 line-clamp-2 text-small text-text-2">{signalText(c, ut)}</p>
        {foreign ? <p className="m-0 mt-0.5 text-small font-semibold text-risk-ink">{fill(ut("dayA.heldBy"), { name: c.assignedToName ?? "" })}</p> : null}
      </div>
      <div className="col-start-2 flex items-center justify-between gap-2">
        {timer ? (
          <Tag tone={timer.left < 0 ? "danger" : "plain"} icon={<Ic.timer />}>
            {fill(ut("dayA.timerShort"), { t: timer.elapsed, norm: hmm(timer.norm) })}
          </Tag>
        ) : (
          <Tag icon={<Di.clock />}>{fill(ut("dayA.waitsSince"), { d: day(c.openedAt) })}</Tag>
        )}
        <ButtonLink to={reviewHref(c.userId)} size="xs">
          {ut("dayA.review")}
        </ButtonLink>
      </div>
    </div>
  );
}

function WorkTile({ w, onReply }: { w: WorkItem; onReply: (t: DrawerTarget) => void }) {
  const { ut } = useLang();
  return (
    <div className="grid grid-cols-[36px_minmax(0,1fr)] items-start gap-x-3 gap-y-2 rounded-[14px] bg-panel-2 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
      <span aria-hidden className="grid size-9 place-items-center rounded-[11px] bg-warn-tint text-warn">
        <WorkIcon kind={w.kind} size={18} />
      </span>
      <div className="min-w-0">
        <b className="block text-[14px] font-extrabold leading-5 text-text">{chipLabel(w, ut)}</b>
        <Link to={`/patients/${w.userId}`} className="block truncate text-small font-bold text-text-2 no-underline hover:underline">
          {w.userName}
        </Link>
        <p className="m-0 mt-0.5 line-clamp-2 text-small text-text-2">{workWhy(w, ut)}</p>
      </div>
      <div className="col-start-2 flex items-center justify-between gap-2">
        <Tag tone="attention" icon={<Di.clockAlert />}>
          {(w.days ?? 0) > 0 ? fill(ut("dayA.overdueDays"), { n: w.days ?? 0 }) : ut("dayA.overdueWord")}
        </Tag>
        {w.kind === "noshow" ? (
          <Button size="xs" onClick={() => onReply({ patientId: w.userId, patientName: w.userName })}>
            {ut("dayA.write")}
          </Button>
        ) : (
          <ButtonLink to={w.href} size="xs">
            {ut("dayA.open")}
          </ButtonLink>
        )}
      </div>
    </div>
  );
}
