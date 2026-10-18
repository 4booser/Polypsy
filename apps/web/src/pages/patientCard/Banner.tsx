import { forwardRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth";
import { dateTime, day, timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { AlertChip, AlertStrip, Avatar, Ic, Kbd, Popover, RiskChip, RiskTimer, Tooltip } from "../../ui";
import { cx } from "../../ui/cx";
import { ActionMenu } from "../../ui/menu";
import { Button, Tabs } from "../../ui/primitives";
import { clockText, normText, riskClock } from "../alerts/model";
import { ageOf, instrumentCode } from "./clinical";
import { dm } from "./format";
import { Pi } from "./icons";
import { leadAction } from "./model";
import type { CardView } from "./types";

/*
 * Карточка пациента на фиолетово-тонированной полосе (.banner макета):
 * кто это, что открыто по человеку одной строкой пилюль — у каждой своё
 * действие и свой поповер — и вкладки. Липнет к верху колонки: ящик
 * действий встаёт под ней, и человек, о котором действие, всегда виден.
 */

export type CardTab = "overview" | "measures" | "dynamics" | "conclusions" | "visits" | "messages" | "notes" | "timeline";

export const CARD_TABS: CardTab[] = ["overview", "measures", "dynamics", "conclusions", "visits", "messages", "notes", "timeline"];

const TAB_KEY = {
  overview: "card.tOverview",
  measures: "card.tMeasures",
  dynamics: "card.tDynamics",
  conclusions: "card.tConclusions",
  visits: "card.tVisits",
  messages: "card.tMessages",
  notes: "card.tNotes",
  timeline: "card.tTimeline",
} as const;

export const Banner = forwardRef<
  HTMLElement,
  {
    v: CardView;
    tab: CardTab;
    onTab: (t: CardTab) => void;
    counts: Partial<Record<CardTab, number>>;
    collapsed: boolean;
    onExpand: () => void;
    onAssign: () => void;
    onToggleLead: () => void;
    leadBusy: boolean;
    /** «Тут же зараз»: кто ещё открыл этого человека */
    here?: ReactNode;
    drafts: { thread: boolean; concl: boolean; note: boolean; signal: boolean };
  }
>(function Banner({ v, tab, onTab, counts, collapsed, onExpand, onAssign, onToggleLead, leadBusy, here, drafts }, ref) {
  const { ut } = useLang();
  const { card } = v;
  const age = ageOf(card.birthDate, v.now);
  const sex = card.sex === "male" ? ut("card.male") : card.sex === "female" ? ut("card.female") : null;
  const lead = leadAction(card);

  return (
    <section
      ref={ref}
      aria-label={ut("card.bannerLabel")}
      className="sticky top-0 z-20 flex shrink-0 flex-col border-b border-band-card-line bg-band px-4 pt-3.5"
    >
      <div className="rounded-drawer border border-band-card-line bg-band-card py-3 pl-3.5 pr-3 shadow-banner">
        <div className="flex min-w-0 items-center gap-3">
          {collapsed ? (
            <Tooltip label={ut("card.expandList")} kbd="[">
              <Button variant="quiet" size="glyph" aria-label={ut("card.expandList")} aria-controls="card-list" onClick={onExpand}>
                <Pi.panelOpen size={18} />
              </Button>
            </Tooltip>
          ) : null}
          <Popover title={card.fullName} note={card.unit ?? undefined} content={<WhoPeek v={v} />} width={360}>
            <div tabIndex={0} className="group flex min-w-0 items-center gap-3.5 rounded-[16px] pr-1.5 outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]">
              <Avatar name={card.fullName} size={56} />
              <div className="flex min-w-0 flex-col gap-[5px]">
                <h1 className="m-0 truncate text-title font-extrabold leading-[30px] tracking-[-0.03em] text-text group-hover:underline group-hover:decoration-violet-line group-hover:decoration-2 group-hover:underline-offset-[5px]">
                  {card.fullName}
                </h1>
                <span className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-[13px] font-semibold text-text-2">
                  {age !== null || sex ? (
                    <Fact icon={<Pi.userRound size={15} />}>
                      {age !== null ? <b className="font-extrabold text-text">{ut("card.years").replace("{n}", String(age))}</b> : null}
                      {age !== null && sex ? ", " : null}
                      {sex}
                    </Fact>
                  ) : null}
                  {card.unit ? (
                    <Fact icon={<Ic.idCard size={15} />}>
                      <b className="font-extrabold text-text">{card.unit}</b>
                    </Fact>
                  ) : null}
                  {v.last ? (
                    <Fact icon={<Pi.repeat size={15} />}>
                      <span className="font-medium text-muted">{ut("card.sessions")}</span> <b className="font-extrabold text-text">{v.last.n}</b>
                    </Fact>
                  ) : null}
                  {card.lead && !card.lead.mine ? (
                    <Fact icon={<Ic.user size={15} />}>
                      <span className="font-medium text-muted">{ut("card.leads")}</span>{" "}
                      <b className="font-extrabold text-text">{card.lead.name}</b>
                    </Fact>
                  ) : null}
                </span>
              </div>
            </div>
          </Popover>
          <div className="ml-auto flex shrink-0 items-center gap-2 max-[1279px]:gap-1.5">
            {here}
            {v.can("messages.write") ? (
              <Tooltip label={ut("card.writeTip")} kbd="M">
                <Button icon={<Pi.messageSquare />} aria-expanded={v.pane === "thread"} onClick={() => v.open("thread")}>
                  <span className="max-[1365px]:sr-only">{ut("card.write")}</span>
                </Button>
              </Tooltip>
            ) : null}
            {v.can("notes.write") ? (
              <Tooltip label={ut("card.noteTip")} kbd="N">
                <Button icon={<Pi.notebookPen />} aria-expanded={v.pane === "note"} onClick={() => v.open("note")}>
                  <span className="max-[1365px]:sr-only">{ut("card.note")}</span>
                </Button>
              </Tooltip>
            ) : null}
            {v.can("appointments.manage") ? (
              <Tooltip label={ut("card.bookTip")}>
                <Button size="icon" aria-label={ut("card.bookTip")} aria-expanded={v.pane === "book"} onClick={() => v.open("book")}>
                  <Pi.calendarPlus />
                </Button>
              </Tooltip>
            ) : null}
            <Tooltip label={ut("pg.assignTest")}>
              <Button size="icon" aria-label={ut("pg.assignTest")} onClick={onAssign}>
                <Pi.clipboardPlus />
              </Button>
            </Tooltip>
            {v.can("conclusions.write") && card.responses.length ? (
              <Tooltip label={ut("card.conclTip")}>
                <Button size="icon" aria-label={ut("card.conclTip")} aria-expanded={v.pane === "concl"} onClick={() => v.open("concl")}>
                  <Pi.filePlus />
                </Button>
              </Tooltip>
            ) : null}
            <ActionMenu
              triggerSize="icon"
              entries={[
                {
                  key: "lead",
                  label: ut(lead === "subscribe" ? "pcard.subscribe" : "pcard.unsubscribe"),
                  icon: <Pi.userPlus size={15} />,
                  disabled: leadBusy,
                  onSelect: onToggleLead,
                },
                { key: "case", label: ut("pcard.clinical"), icon: <Ic.layers size={15} />, to: `/patients/${card.id}/case` },
              ]}
            />
          </div>
        </div>
        <Strip v={v} drafts={drafts} />
      </div>
      {/* полоса вкладок узкая (1280 со списком) — счётчики уходят, подписи остаются */}
      <div className="@container flex min-w-0 items-center gap-2 py-2">
        <div className="min-w-0 overflow-x-auto [scrollbar-width:none] [&>[role=tablist]]:flex-nowrap @max-[960px]:[&_[role=tab]>span]:hidden">
          <Tabs
            label={ut("card.tabsLabel")}
            items={CARD_TABS.map((t) => ({
              id: `card-tab-${t}`,
              label: ut(TAB_KEY[t]),
              active: tab === t,
              count: counts[t] ? counts[t] : null,
              controls: "card-tabpanel",
              onSelect: () => onTab(t),
            }))}
          />
        </div>
        <Link
          to={`/patients/${card.id}/case`}
          className="ml-auto inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-control px-3 text-body font-bold text-violet-ink no-underline hover:bg-tab-hover hover:no-underline @max-[1080px]:px-2.5"
          title={ut("pcard.clinical")}
        >
          <Ic.layers size={15} />
          <span className="@max-[1080px]:sr-only">{ut("pcard.clinical")}</span>

        </Link>
      </div>
    </section>
  );
});

function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap [&>svg]:shrink-0 [&>svg]:text-violet-ink">
      {icon}
      <span className="truncate">{children}</span>
    </span>
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
  rows.push([ut("card.leadRow"), card.lead ? (card.lead.mine ? ut("card.leadYou") : card.lead.name) : ut("card.noLead")]);
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

/* ─────────── строка открытого ─────────── */

function Strip({ v, drafts }: { v: CardView; drafts: { thread: boolean; concl: boolean; note: boolean; signal: boolean } }) {
  const { ut } = useLang();
  const { can } = useAuth();
  const items: ReactNode[] = [];
  const cases = v.cases ?? [];
  const first = cases[0];

  if (first) {
    const clock = riskClock(first, v.now);
    const elapsed = clockText(clock.elapsed, ut("rr.days"));
    items.push(
      <RiskChip
        key="risk"
        title={cases.length > 1 ? ut("card.signals").replace("{n}", String(cases.length)) : ut("card.signal")}
        timer={
          clock.norm !== null ? (
            <RiskTimer elapsed={elapsed} of={normText(clock.norm, { h: ut("rr.hours"), min: ut("dur.min") })} pct={clock.pct} />
          ) : (
            <span className="text-caption font-semibold text-text-2">
              <b className="text-body font-extrabold text-risk-ink">{elapsed}</b>
            </span>
          )
        }
        popTitle={ut("card.signalOf").replace("{s}", first.surveyTitle)}
        popNote={`${dm(first.lastAlertAt)}, ${timeOfDay(first.lastAlertAt)}`}
        pop={
          <div className="flex flex-col gap-1.5">
            {first.signals.slice(0, 2).map((s) => (
              <p key={s.id} className="m-0">
                {s.label}
              </p>
            ))}
            {clock.norm !== null && clock.dueAt !== null ? (
              <p className="m-0">
                {ut("card.normLine")
                  .replace("{e}", elapsed)
                  .replace("{t}", timeOfDay(new Date(clock.dueAt).toISOString()))}
              </p>
            ) : null}
            <p className="m-0 text-muted">
              {first.assignedToName ? ut("card.takenBy").replace("{n}", first.assignedToName) : ut("card.notTaken")}
            </p>
          </div>
        }
        action={
          can("alerts.review") ? (
            <Tooltip label={ut("card.reviewTip")} kbd="R">
              <Button
                variant="risk"
                size="xs"
                className="rounded-2xl"
                aria-expanded={v.pane === "signal"}
                onClick={() => v.open("signal")}
              >
                {ut("card.review")}
                {drafts.signal ? <i aria-hidden className="absolute -right-[3px] -top-[3px] size-[11px] rounded-full border-2 border-panel bg-primary" /> : null}
              </Button>
            </Tooltip>
          ) : undefined
        }
      />,
    );
  }

  if (v.thread && v.thread.unread > 0) {
    const lastIn = [...(v.messages ?? [])].reverse().find((m) => !m.mine);
    items.push(
      <AlertChip
        key="msg"
        kind="message"
        icon={<Ic.message />}
        label={ut("card.message")}
        detail={relDay(v.thread.lastMessageAt, v.now, ut)}
        pressed={v.pane === "thread"}
        draft={drafts.thread && v.pane !== "thread"}
        onClick={() => v.open("thread")}
        popTitle={v.card.fullName}
        popNote={`${dm(v.thread.lastMessageAt)}, ${timeOfDay(v.thread.lastMessageAt)}`}
        pop={
          <div className="flex flex-col gap-1.5">
            {lastIn ? <p className="m-0">«{lastIn.text}»</p> : null}
            <p className="m-0 text-muted">{ut("card.unread").replace("{n}", String(v.thread.unread))}</p>
          </div>
        }
        popActions={
          <>
            <Button variant="primary" size="xs" onClick={() => v.open("thread")}>
              {ut("card.reply")}
            </Button>
            <Kbd>M</Kbd>
          </>
        }
      />,
    );
  }

  if (v.noShow) {
    const ns = v.noShow;
    items.push(
      <AlertChip
        key="noshow"
        kind="warn"
        icon={<Pi.calendarX />}
        label={ut("card.noShow").replace("{d}", dm(ns.at))}
        popTitle={ut("card.noShowTitle")}
        popNote={`${dm(ns.at)}, ${timeOfDay(ns.at)}`}
        pop={<p className="m-0">{ut("card.noShowWith").replace("{n}", ns.specialist)}</p>}
        popActions={
          can("appointments.manage") ? (
            <Button size="xs" onClick={() => v.open("book")}>
              {ut("card.bookAgain")}
            </Button>
          ) : undefined
        }
      />,
    );
  }

  for (const c of v.card.conclusions.filter((x) => x.status === "draft").slice(0, 2)) {
    items.push(
      <AlertChip
        key={`draft-${c.id}`}
        icon={<Pi.filePen />}
        label={ut("card.draftOf").replace("{s}", clip(shortTitle(c.surveyTitle), 18))}
        pressed={v.pane === "concl"}
        draft={drafts.concl && v.pane !== "concl"}
        onClick={() => v.open("concl", { responseId: c.responseId })}
        popTitle={ut("card.conclusionOf").replace("{s}", c.surveyTitle)}
        popNote={day(c.createdAt)}
        pop={<p className="m-0 line-clamp-3">{c.text || ut("card.emptyDraft")}</p>}
        popActions={
          <Button size="xs" onClick={() => v.open("concl", { responseId: c.responseId })}>
            {ut("card.continue")}
          </Button>
        }
      />,
    );
  }

  const a = v.assignments[0];
  if (a) {
    const overdue = a.dueAt ? Date.parse(a.dueAt) < v.now : false;
    items.push(
      <AlertChip
        key="assigned"
        kind={overdue ? "warn" : "neutral"}
        icon={<Pi.clipboardClock />}
        label={a.dueAt ? ut("card.assignedDue").replace("{s}", clip(a.title, 22)).replace("{d}", dm(a.dueAt)) : clip(a.title, 28)}
        detail={v.assignments.length > 1 ? `+${v.assignments.length - 1}` : undefined}
        popTitle={a.title}
        popNote={a.dueAt ? ut("card.dueOn").replace("{d}", dm(a.dueAt)) : undefined}
        pop={
          <p className="m-0">
            {ut("card.assignedOn").replace("{d}", dateTime(a.at))}
            {overdue ? <b className="font-extrabold text-warn"> {ut("cases.overdue")}</b> : null}
          </p>
        }
      />,
    );
  }

  if (v.plan) {
    const p = v.plan;
    items.push(
      <AlertChip
        key="plan"
        kind="good"
        icon={<Ic.shieldCheck />}
        label={ut("card.planChip").replace("{v}", String(p.version))}
        popTitle={ut("card.planChip").replace("{v}", String(p.version))}
        popNote={day(p.reviewedAt ?? p.createdAt)}
        pop={<p className="m-0">{ut("card.planBy").replace("{n}", p.authorName)}</p>}
      />,
    );
  } else if (first) {
    items.push(
      <AlertChip
        key="noplan"
        kind="warn"
        icon={<Pi.shieldAlert />}
        label={ut("rr.noPlan")}
        to={`/patients/${v.card.id}/case`}
        pop={<p className="m-0">{ut("rr.noPlanHint")}</p>}
      />,
    );
  }

  return (
    <AlertStrip className={cx("mt-3 min-h-10")}>
      {items.length ? items : <span className="text-small text-muted">{ut("card.nothingOpen")}</span>}
    </AlertStrip>
  );
}

/** Длинное название в пилюле строки — с многоточием: строка одна, и пилюли не должны выталкивать соседей */
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** «PHQ-9» из «Депресія (PHQ-9)» или из «PHQ-9. Опитувальник здоров’я пацієнта» */
export function shortTitle(title: string): string {
  return instrumentCode(title);
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
