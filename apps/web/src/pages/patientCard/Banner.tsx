import { forwardRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { day, timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { Avatar, Ic, Popover, RiskTimer, Tooltip } from "../../ui";
import { cx } from "../../ui/cx";
import { ActionMenu, type MenuEntry } from "../../ui/menu";
import { Button, Tabs } from "../../ui/primitives";
import { clockText, normText, riskClock } from "../alerts/model";
import { initialsName } from "../patients/model";
import { ageOf } from "./clinical";
import { daysBetween, dm, wdm } from "./format";
import { Pi } from "./icons";
import { CARD_TABS } from "./tabs";
import type { CardTab, CardView } from "./types";

/*
 * Шапка рабочего места пациента — на фиолетово-тонированной полосе, липнет
 * к верху колонки: ящик действий встаёт под ней, и человек, о котором
 * действие, всегда виден.
 *
 * Шапка отвечает на четыре вопроса — по строке на каждый, без повторов:
 * кто ведёт человека, зачем он здесь (обращение и его повод), когда
 * следующий приём и что с риском (открытый случай, кто его разбирает, план
 * безпеки). Открытый случай — красной строкой во всю ширину над прочими:
 * это то, что требует действия сейчас. Под ними — действия дня с прежними
 * подписями и вкладки.
 *
 * Прежде под именем стояла строка пилюль «открытого» — случай, план,
 * назначенное, черновики, письмо — и та же картина повторялась панелями
 * «Огляду». Теперь у каждого сведения один дом: письмо — счётчиком на
 * «Написати», черновики — во «Записах», назначенное — в «Плані» огляда.
 */

const TAB_KEY = {
  overview: "card.tOverview",
  dynamics: "card.tDynamics",
  measures: "card.tMeasures",
  records: "ws.tRecords",
  referrals: "ws.tReferrals",
  messages: "card.tMessages",
  timeline: "card.tTimeline",
} as const;

export const Banner = forwardRef<
  HTMLElement,
  {
    v: CardView;
    tab: CardTab;
    onTab: (t: CardTab) => void;
    /** Вкладки, которые видит читатель: «Направлення» и «Листування» — по праву */
    tabs: readonly CardTab[];
    counts: Partial<Record<CardTab, number>>;
    collapsed: boolean;
    onExpand: () => void;
    onAssign: () => void;
    onToggleLead: () => void;
    leadBusy: boolean;
    /** Пункты меню «⋯»: закрепление, обращение, план, направление, печать */
    menu: MenuEntry[];
    /** «Тут же зараз»: кто ещё открыл этого человека */
    here?: ReactNode;
    drafts: { thread: boolean; concl: boolean; note: boolean; signal: boolean };
  }
>(function Banner({ v, tab, onTab, tabs, counts, collapsed, onExpand, onAssign, onToggleLead, leadBusy, menu, here, drafts }, ref) {
  const { ut } = useLang();
  const { card } = v;
  const age = ageOf(card.birthDate, v.now);
  const sex = card.sex === "male" ? ut("card.male") : card.sex === "female" ? ut("card.female") : null;
  const facts = [age !== null ? ut("card.years").replace("{n}", String(age)) : null, sex, card.unit].filter(Boolean).join(", ");
  const unread = v.thread?.unread ?? 0;
  const risky = !!v.cases?.length;

  return (
    <section
      ref={ref}
      aria-label={ut("card.bannerLabel")}
      className="sticky top-0 z-20 flex shrink-0 flex-col border-b border-band-card-line bg-band px-4 pt-2.5"
    >
      <div className="@container rounded-drawer border border-band-card-line bg-band-card px-3.5 pb-2.5 pt-2 shadow-banner">
        <div className="flex min-w-0 items-center gap-3">
          {collapsed ? (
            <Tooltip label={ut("card.expandList")} kbd="[">
              <Button variant="quiet" size="glyph" aria-label={ut("card.expandList")} aria-controls="card-list" onClick={onExpand}>
                <Pi.panelOpen size={18} />
              </Button>
            </Tooltip>
          ) : null}
          <Popover title={card.fullName} note={card.unit ?? undefined} content={<WhoPeek v={v} />} width={360}>
            <div
              tabIndex={0}
              className="group flex min-w-0 items-center gap-3 rounded-[14px] pr-1.5 outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]"
            >
              <Avatar name={card.fullName} size={40} />
              {/* ФИО не обрезается: длинное встаёт в две строки, а не теряет отчество; возраст и подразделение — следом, если влезают */}
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <h1 className="m-0 text-[21px] font-extrabold leading-[26px] tracking-[-0.03em] text-text group-hover:underline group-hover:decoration-violet-line group-hover:decoration-2 group-hover:underline-offset-[5px]">
                  {card.fullName}
                </h1>
                {facts ? <span className="text-small font-semibold text-text-2">{facts}</span> : null}
              </div>
            </div>
          </Popover>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 self-start">
            {here}
            <ActionMenu triggerSize="icon-sm" label={ut("ws.moreLabel")} entries={menu} />
          </div>
        </div>

        {risky ? <RiskLine v={v} draft={drafts.signal} /> : null}
        {/*
          Подписи — колонкой по самой длинной в своей половине («План безпеки»
          по-русски шире «Фахівця»): строки обеих половин стоят ровно, а
          значению остаётся всё, что не занято подписью.
        */}
        <dl className="m-0 mt-1.5 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-0 @min-[620px]:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
          <LeadFact v={v} busy={leadBusy} onTake={onToggleLead} />
          <EpisodeFact v={v} />
          <VisitFact v={v} />
          {risky ? <PlanFact v={v} /> : <QuietRiskFact v={v} />}
        </dl>

        <div role="group" aria-label={ut("card.actionsLabel")} className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 print:hidden">
          {v.can("messages.write") ? (
            <Tooltip label={ut("card.writeTip")} kbd="M">
              <Button size="xs" icon={<Pi.messageSquare />} aria-expanded={v.pane === "thread"} onClick={() => v.open("thread")}>
                {ut("card.write")}
                {unread > 0 ? (
                  <>
                    {/* число — глазу, «непрочитаних: 3» — диктору: aria-label у простого span не читается */}
                    <span
                      aria-hidden
                      className="ml-1.5 inline-grid h-[18px] min-w-[18px] place-items-center rounded-[9px] bg-info px-1 text-[11px] font-bold text-onfill"
                    >
                      {unread}
                    </span>
                    <span className="sr-only">{`, ${ut("card.unread").replace("{n}", String(unread))}`}</span>
                  </>
                ) : null}
                <DraftDot on={drafts.thread && v.pane !== "thread"} />
              </Button>
            </Tooltip>
          ) : null}
          {v.can("notes.write") ? (
            <Tooltip label={ut("ws.newNote")} kbd="N">
              <Button size="xs" icon={<Pi.notebookPen />} aria-expanded={v.pane === "note"} onClick={() => v.open("note")}>
                {ut("ws.note")}
                <DraftDot on={drafts.note && v.pane !== "note"} />
              </Button>
            </Tooltip>
          ) : null}
          {v.can("conclusions.write") && card.responses.length ? (
            <Tooltip label={ut("card.conclTip")}>
              <Button size="xs" icon={<Pi.filePlus />} aria-expanded={v.pane === "concl"} onClick={() => v.open("concl")}>
                {ut("card.concl")}
                <DraftDot on={drafts.concl && v.pane !== "concl"} />
              </Button>
            </Tooltip>
          ) : null}
          {v.can("appointments.manage") ? (
            <Button size="xs" icon={<Pi.calendarPlus />} aria-expanded={v.pane === "book"} onClick={() => v.open("book")}>
              {ut("card.bookTip")}
            </Button>
          ) : null}
          {v.can("assignments.manage") ? (
            <Button size="xs" icon={<Pi.clipboardPlus />} onClick={onAssign}>
              {ut("pg.assignTest")}
            </Button>
          ) : null}
        </div>
      </div>
      {/* полоса вкладок узкая (1280 со списком) — счётчики уходят, подписи остаются */}
      <div className="@container flex min-w-0 items-center gap-2 py-1.5">
        <div className="min-w-0 overflow-x-auto [scrollbar-width:none] [&>[role=tablist]]:flex-nowrap @max-[700px]:[&_[role=tab]>span]:hidden">
          <Tabs
            label={ut("card.tabsLabel")}
            items={CARD_TABS.filter((t) => tabs.includes(t)).map((t) => ({
              id: `card-tab-${t}`,
              label: ut(TAB_KEY[t]),
              active: tab === t,
              count: counts[t] ? counts[t] : null,
              controls: "card-tabpanel",
              onSelect: () => onTab(t),
            }))}
          />
        </div>
      </div>
    </section>
  );
});

/** Точка «есть черновик» на кнопке действия */
function DraftDot({ on }: { on: boolean }) {
  return on ? <i aria-hidden className="absolute -right-[3px] -top-[3px] size-[11px] rounded-full border-2 border-panel bg-primary" /> : null;
}

/** Строка шапки: подпись слева, значение в одну строку; лишнее — многоточием, целиком — в подсказке */
function Fact({ label, children, tone }: { label: string; children: ReactNode; tone?: "warn" }) {
  return (
    <div className="contents">
      <dt className="whitespace-nowrap text-caption font-bold text-muted">{label}</dt>
      <dd
        className={cx(
          "m-0 flex h-7 min-w-0 items-center gap-2 pr-4 text-small",
          tone === "warn" ? "text-warn" : "text-text",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/** Действие строки шапки — словом, без рамки: строка остаётся строкой */
export function InlineAction({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="min-h-0 shrink-0 cursor-pointer rounded-[6px] border-0 bg-transparent px-1 py-0.5 text-small font-bold text-violet-ink outline-none hover:underline focus-visible:shadow-[0_0_0_2px_var(--vring)] disabled:cursor-default disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Значение с многоточием: полный текст — в подсказке браузера */
function Clip({ children, title, strong }: { children: ReactNode; title?: string; strong?: boolean }) {
  return (
    <span className={cx("min-w-0 truncate", strong && "font-bold")} title={title}>
      {children}
    </span>
  );
}

function LeadFact({ v, busy, onTake }: { v: CardView; busy: boolean; onTake: () => void }) {
  const { ut } = useLang();
  const lead = v.card.lead;
  return (
    <Fact label={ut("plist.lead")}>
      {lead ? (
        <>
          <Clip strong title={lead.name}>
            {lead.name}
          </Clip>
          {lead.mine ? <span className="shrink-0 text-muted">{ut("ws.you")}</span> : null}
        </>
      ) : (
        <>
          <span className="shrink-0 text-muted">{ut("card.noLead")}</span>
          <InlineAction disabled={busy} onClick={onTake}>
            {ut("pcard.subscribe")}
          </InlineAction>
        </>
      )}
    </Fact>
  );
}

function EpisodeFact({ v }: { v: CardView }) {
  const { ut } = useLang();
  const ep = v.card.episode ?? null;
  const manage = v.can("episodes.manage");
  if (!ep) {
    return (
      <Fact label={ut("ws.episode")}>
        <span className="shrink-0 text-muted">{ut("ws.episodeNone")}</span>
        {manage ? <InlineAction onClick={() => v.open("episode")}>{ut("ws.episodeOpen")}</InlineAction> : null}
      </Fact>
    );
  }
  const days = daysBetween(ep.openedAt, v.now);
  const since = ut("ws.episodeSince").replace("{d}", dm(ep.openedAt)).replace("{n}", String(Math.max(days, 0)));
  const reason = ep.reason?.trim() || ut("ws.episodeNoReason");
  return (
    <Fact label={ut("ws.episode")}>
      <button
        type="button"
        onClick={() => v.open("episode")}
        title={`${since} · ${reason}`}
        className="flex min-h-0 min-w-0 cursor-pointer items-center gap-1.5 rounded-[6px] border-0 bg-transparent p-0 text-left text-small text-text outline-none hover:underline focus-visible:shadow-[0_0_0_2px_var(--vring)]"
      >
        <b className="shrink-0 font-bold">{since}</b>
        <span className="shrink-0 text-muted">·</span>
        <span className={cx("min-w-0 truncate", !ep.reason?.trim() && "text-muted")}>{reason}</span>
      </button>
    </Fact>
  );
}

function VisitFact({ v }: { v: CardView }) {
  const { ut } = useLang();
  const next = v.next;
  const book = v.can("appointments.manage");
  if (!next) {
    /* неявка без новой записи — то, о чём надо вспомнить сейчас: янтарём */
    return v.noShow ? (
      <Fact label={ut("ws.visit")} tone="warn">
        <b className="shrink-0 font-bold">{ut("ws.noShowUnbooked").replace("{d}", dm(v.noShow.at))}</b>
        {book ? <InlineAction onClick={() => v.open("book")}>{ut("card.bookAgain")}</InlineAction> : null}
      </Fact>
    ) : (
      <Fact label={ut("ws.visit")}>
        <span className="shrink-0 text-muted">{ut("ws.visitNone")}</span>
        {book ? <InlineAction onClick={() => v.open("book")}>{ut("card.book")}</InlineAction> : null}
      </Fact>
    );
  }
  const known = v.card.upcoming?.find((u) => u.id === next.id) ?? null;
  const how = known
    ? [ut(known.mode === "remote" ? "card.online" : "card.onsite"), ut(known.kind === "primary" ? "card.nxPrimary" : "card.nxRepeat")].join(", ")
    : null;
  const whose = v.nextIsMine ? null : ut("ws.visitWith").replace("{n}", initialsName(next.specialist));
  const text = [`${wdm(next.at)}, ${timeOfDay(next.at)}`, how, whose].filter(Boolean).join(" · ");
  return (
    <Fact label={ut("ws.visit")}>
      <b className="shrink-0 font-bold">
        {wdm(next.at)}, {timeOfDay(next.at)}
      </b>
      <Clip title={text}>{[how, whose].filter(Boolean).join(" · ")}</Clip>
    </Fact>
  );
}

/** Строка риска без открытого случая — нейтральная: тишина не требует внимания */
export function QuietRiskFact({ v }: { v: CardView }) {
  const { ut } = useLang();
  if (!v.can("alerts.review")) return <PlanFact v={v} />;
  if (v.casesError) {
    return (
      <Fact label={ut("ws.risk")}>
        <b className="shrink-0 font-bold text-risk-ink">{ut("rr.casesFailed")}</b>
        <InlineAction onClick={v.reloadCases}>{ut("common.retry")}</InlineAction>
      </Fact>
    );
  }
  if (!v.cases) {
    return (
      <Fact label={ut("ws.risk")}>
        <span className="h-3 w-40 animate-pulse rounded bg-sunk" aria-hidden />
      </Fact>
    );
  }
  const plan = v.plan
    ? ut("ws.planOf").replace("{v}", String(v.plan.version))
    : v.planKnown
      ? ut("ws.planNone")
      : null;
  return (
    <Fact label={ut("ws.risk")}>
      <Clip title={[ut("ws.noOpenCases"), plan].filter(Boolean).join(" · ")}>
        <span className="text-text-2">{ut("ws.noOpenCases")}</span>
        {plan ? <span className="text-muted"> · {plan}</span> : null}
      </Clip>
    </Fact>
  );
}

/** План безпеки при открытом случае: его нет — янтарём и «Скласти» */
export function PlanFact({ v }: { v: CardView }) {
  const { ut } = useLang();
  const risky = !!v.cases?.length;
  if (!v.planKnown) {
    return (
      <Fact label={ut("rr.safetyPlan")}>
        {v.planError ? (
          <>
            <span className="min-w-0 truncate text-muted">{v.planError}</span>
            <InlineAction onClick={v.reloadPlan}>{ut("common.retry")}</InlineAction>
          </>
        ) : (
          <span className="h-3 w-32 animate-pulse rounded bg-sunk" aria-hidden />
        )}
      </Fact>
    );
  }
  if (!v.plan) {
    return (
      <Fact label={ut("rr.safetyPlan")} tone={risky ? "warn" : undefined}>
        <span className={cx("shrink-0", risky ? "font-bold" : "text-muted")}>{ut("ws.planNoneShort")}</span>
        <InlineAction onClick={() => v.open("plan")}>{ut("sp.create")}</InlineAction>
      </Fact>
    );
  }
  return (
    <Fact label={ut("rr.safetyPlan")}>
      <b className="shrink-0 font-bold">{ut("ws.planVersion").replace("{v}", String(v.plan.version))}</b>
      <span className="shrink-0 text-muted">{day(v.plan.reviewedAt ?? v.plan.createdAt)}</span>
      <InlineAction onClick={() => v.open("plan")}>{ut("card.open")}</InlineAction>
    </Fact>
  );
}

/**
 * Открытый случай риска — красной строкой во всю ширину: с какого времени,
 * сколько до нормы разбора, кто разбирает, и «Розібрати» (R). Права — из
 * CardView, а не из контекста входа: строка проверяется разметкой без входа
 * (test/riskReview.test.tsx).
 */
export function RiskLine({ v, draft }: { v: CardView; draft: boolean }) {
  const { ut } = useLang();
  const cases = v.cases ?? [];
  const first = cases[0];
  if (!first) return null;
  const clock = riskClock(first, v.now);
  const elapsed = clockText(clock.elapsed, ut("rr.days"));
  const who = first.assignedToName ? ut("ws.riskTaken").replace("{n}", initialsName(first.assignedToName)) : ut("ws.riskNotTaken");
  const title = cases.length > 1 ? ut("card.cases").replace("{n}", String(cases.length)) : ut("card.case");
  return (
    <div
      role="status"
      className="mt-2 flex min-h-9 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-[12px] bg-risk-tint py-1 pl-3 pr-1 text-small text-text"
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 font-extrabold text-risk-ink">
        <Ic.alert size={15} />
        {title}
      </span>
      <span className="shrink-0 text-text-2">
        {ut("ws.riskSince").replace("{d}", `${dm(first.openedAt)}, ${timeOfDay(first.openedAt)}`)}
      </span>
      {clock.norm !== null ? (
        <RiskTimer elapsed={elapsed} of={normText(clock.norm, { h: ut("rr.hours"), min: ut("dur.min") })} pct={clock.pct} />
      ) : null}
      <span className={cx("min-w-0 truncate", first.assignedToName ? "text-text-2" : "font-bold text-risk-ink")}>{who}</span>
      {v.can("alerts.review") ? (
        <Tooltip label={ut("card.reviewTip")} kbd="R">
          <Button variant="risk" size="xs" className="relative ml-auto rounded-2xl" aria-expanded={v.pane === "signal"} onClick={() => v.open("signal")}>
            {ut("card.review")}
            <DraftDot on={draft} />
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** «Хто це»: всё о человеке, чего нет в шапке, — на наведении и фокусе */
function WhoPeek({ v }: { v: CardView }) {
  const { ut } = useLang();
  const { card } = v;
  const age = ageOf(card.birthDate, v.now);
  const rows: [string, ReactNode][] = [];
  if (card.birthDate) rows.push([ut("person.birthDate"), `${day(card.birthDate)}${age !== null ? `, ${ut("card.years").replace("{n}", String(age))}` : ""}`]);
  if (card.phone) rows.push([ut("ppl.phone"), <b key="p" className="font-extrabold text-text">{card.phone}</b>]);
  if (card.email) rows.push([ut("ppl.email"), card.email]);
  const role = [card.rank, card.position].filter(Boolean).join(", ");
  if (role) rows.push([ut("card.role"), role]);
  if (card.groups.length) {
    rows.push([
      ut("top.groups"),
      <span key="g" className="flex flex-wrap gap-x-2">
        {card.groups.map((g) => (
          <Link key={g.id} to={`/patient-groups/${g.id}`} className="font-bold text-violet-ink">
            {g.title}
          </Link>
        ))}
      </span>,
    ]);
  }
  if (v.last) rows.push([ut("card.sessions"), String(v.last.n)]);
  rows.push([ut("card.since"), day(card.createdAt)]);
  return (
    <table className="w-full border-collapse text-small">
      <tbody>
        {rows.map(([k, val]) => (
          <tr key={k}>
            <td className="whitespace-nowrap border-t border-divider py-[5px] pr-3 align-top text-muted first:border-t-0">{k}</td>
            <td className="border-t border-divider py-[5px] text-text">{val}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** «сьогодні», «учора» или дата */
export function relDay(iso: string, now: number, ut: (k: "card.today" | "card.yesterday") => string): string {
  const d = new Date(iso);
  const n = new Date(now);
  const mid = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((mid(n) - mid(d)) / 86_400_000);
  if (diff === 0) return ut("card.today");
  if (diff === 1) return ut("card.yesterday");
  return dm(iso);
}

