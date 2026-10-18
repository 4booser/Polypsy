import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { AlertCase, AppointmentView, PatientListItem, UiKey, WorkItem } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { dayKey, timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { Ic, KbdHints, ListGroup, ListTile, Loading, SearchField, ViewPills, type GroupMark } from "../../ui";
import { cx } from "../../ui/cx";
import { Button, Tag } from "../../ui/primitives";
import { clockText, normText, riskClock } from "../alerts/model";
import { Pi } from "./icons";
import {
  buildList,
  flatIds,
  viewCounts,
  viewGroups,
  type ListPerson,
  type ListView,
  type Reason,
  type ReasonKind,
  type ThreadLike,
} from "./listModel";
import { dm } from "./format";
import { useCodeKeys } from "./keys";

/*
 * Колонка «Мої пацієнти» (.plist макета): список слева от карточки, каждая
 * строка говорит, ПОЧЕМУ человек здесь сейчас и ЧТО дальше. Группы — по
 * причине (listModel.ts), виды «Мої / Ризик / Сьогодні / Повідомлення /
 * Результати / Усі» — пилюлями с числами. J/K ходят по строкам и открывают
 * карточку, «/» ставит курсор в поиск, «[» сворачивает колонку.
 *
 * Пять источников, каждый — тот, которым приложение уже отвечает на вопрос
 * «что у меня сегодня»: пациенты зоны (ведущий — я), открытые случаи,
 * мой приёмный день, мои разговоры, моя очередь работы. Нет права на
 * источник — его причины просто не будет, а колонка работает.
 */

/** Сколько людей зоны тянуть страницами: зона — сотни, не тысячи (routes/patients.ts) */
const PAGE = 200;
const MAX_PAGES = 5;

async function allPatients(): Promise<{ items: PatientListItem[]; total: number }> {
  const items: PatientListItem[] = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await api.patientsPage({ limit: PAGE, offset: page * PAGE });
    items.push(...res.items);
    total = res.total;
    if (items.length >= res.total || !res.items.length) break;
  }
  return { items, total };
}

const MARK: Record<ReasonKind, GroupMark> = {
  now: "risk",
  today: "violet",
  msg: "info",
  res: "neutral",
  miss: "warn",
  work: "neutral",
  stable: "ok",
};

const GROUP_KEY: Record<ReasonKind, UiKey> = {
  now: "card.grpNow",
  today: "card.grpToday",
  msg: "card.grpMsg",
  res: "card.grpRes",
  miss: "card.grpMiss",
  work: "card.grpWork",
  stable: "card.grpStable",
};

/** Вид дела из очереди работы — словом словаря (как на экране очереди) */
const WORK_KIND: Record<WorkItem["kind"], UiKey> = {
  noshow: "work.kindNoshow",
  message: "work.kindMessage",
  dispensary: "work.kindDispensary",
  followup: "work.kindFollowup",
  referral: "work.kindReferral",
  assignment: "work.kindAssignment",
};

const VIEWS: { key: ListView; label: UiKey }[] = [
  { key: "mine", label: "card.viewMine" },
  { key: "risk", label: "card.viewRisk" },
  { key: "today", label: "card.viewToday" },
  { key: "msg", label: "card.viewMsg" },
  { key: "res", label: "card.viewRes" },
  { key: "all", label: "card.viewAll" },
];

export function PatientList({
  currentId,
  collapsed,
  onCollapse,
}: {
  currentId: string;
  collapsed: boolean;
  onCollapse: () => void;
}) {
  const { ut } = useLang();
  const { user, can } = useAuth();
  const navigate = useNavigate();
  const [view, setView] = useState<ListView>("mine");
  const [q, setQ] = useState("");
  const [stableOpen, setStableOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const patients = useResource(() => allPatients(), []);
  const cases = useResource(
    () =>
      can("alerts.review")
        ? api
            .alertCases({ status: "open", limit: "100" })
            .then((p) => p.items)
            .catch(() => [] as AlertCase[])
        : Promise.resolve([] as AlertCase[]),
    [],
  );
  const today = useResource(
    () =>
      api
        .today()
        .then((d) => d.items)
        .catch(() => [] as AppointmentView[]),
    [],
  );
  const threads = useResource(
    () =>
      api
        .threads()
        .then((d) => d.items as ThreadLike[])
        .catch(() => [] as ThreadLike[]),
    [],
  );
  const work = useResource(
    () =>
      api
        .worklist()
        .then((d) => d.items)
        .catch(() => [] as WorkItem[]),
    [],
  );

  const built = useMemo(
    () =>
      buildList({
        me: user?.id ?? "",
        patients: patients.data?.items ?? [],
        cases: cases.data ?? [],
        today: today.data ?? [],
        threads: threads.data ?? [],
        work: work.data ?? [],
        now,
      }),
    [user?.id, patients.data, cases.data, today.data, threads.data, work.data, now],
  );
  const counts = viewCounts(built, patients.data?.total ?? 0);
  const groups = viewGroups(built, view, q);
  const ids = flatIds(groups, stableOpen || view !== "mine");
  const shown = groups.reduce((n, g) => n + g.items.length, 0);

  /* выбранная строка — в поле зрения: J/K и переход по ссылке не теряют её за краем */
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-person="${currentId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [currentId, view]);

  const step = (d: number) => {
    if (!ids.length) return;
    const at = ids.indexOf(currentId);
    const next = ids[Math.min(Math.max((at < 0 ? (d > 0 ? -1 : 0) : at) + d, 0), ids.length - 1)];
    if (next && next !== currentId) navigate(`/patients/${next}`);
  };
  useCodeKeys({ KeyJ: () => step(1), KeyK: () => step(-1), BracketLeft: onCollapse });

  const loading = !patients.data && !patients.error;

  return (
    <aside
      id="card-list"
      aria-label={ut("card.listLabel")}
      aria-hidden={collapsed || undefined}
      inert={collapsed}
      className={cx(
        "flex min-h-0 shrink-0 flex-col overflow-hidden border-r bg-panel transition-[width] duration-[var(--dur-slow)] ease-[var(--ease)]",
        collapsed ? "w-0 border-transparent" : "w-[340px] border-border",
        "max-[1100px]:hidden",
      )}
    >
      <div className="w-[340px] shrink-0 px-4 pt-3.5">
        <div className="flex h-9 items-center gap-2">
          <h2 className="m-0 whitespace-nowrap text-[18px] font-extrabold leading-none tracking-[-0.02em] text-text">
            {ut(view === "mine" ? "card.listTitle" : "card.listTitleAll")}
          </h2>
          <span className="inline-grid h-[22px] min-w-[26px] place-items-center rounded-[11px] bg-sunk px-[7px] text-caption font-bold text-text-2">
            {view === "mine" ? counts.mine : counts.all}
          </span>
          <span className="ml-auto flex gap-1">
            <Button
              variant="quiet"
              size="glyph"
              aria-label={ut("card.collapseList")}
              title={ut("card.collapseList")}
              aria-controls="card-list"
              onClick={onCollapse}
            >
              <Pi.panelClose size={16} />
            </Button>
          </span>
        </div>
        <SearchField
          value={q}
          onChange={setQ}
          placeholder={ut("card.searchPh")}
          slash
          width={0}
          className="mt-2.5 w-full"
          inputProps={{ "data-list-search": "" }}
        />
        <ViewPills
          className="mt-2.5"
          label={ut("card.views")}
          value={view}
          onChange={(k) => setView(k as ListView)}
          items={VIEWS.map((v) => ({
            key: v.key,
            label: ut(v.label),
            count: counts[v.key],
            risk: v.key === "risk" && counts.risk > 0,
          }))}
        />
        <div className="mt-1.5 flex h-9 items-center gap-[7px] text-small text-muted">
          <Ic.sortDesc size={14} />
          {view === "all" ? (
            ut("card.sortAlpha")
          ) : (
            <>
              {ut("card.sortReason")} <b className="font-bold text-text-2">{ut("card.sortUrgent")}</b>
            </>
          )}
        </div>
      </div>
      <div ref={scroller} className="kit-scroll min-h-0 w-[340px] flex-1 overflow-y-auto border-t border-divider pb-2.5" data-rows="">
        {loading ? (
          <div className="p-4">
            <Loading rows={6} bare />
          </div>
        ) : patients.error && !built.people.size ? (
          <div className="p-4">
            <Loading rows={1} error={patients.error} onRetry={patients.reload} bare />
          </div>
        ) : !shown ? (
          <p className="m-0 px-[22px] py-7 text-body text-muted">{q ? ut("card.nobodyFound") : ut("card.nobodyInView")}</p>
        ) : (
          groups.map((g) =>
            g.key === "stable" && view === "mine" ? (
              <div key={g.key}>
                <button
                  type="button"
                  aria-expanded={stableOpen}
                  aria-controls="card-list-stable"
                  onClick={() => setStableOpen((v) => !v)}
                  className="mx-1.5 mt-2 flex h-9 w-[calc(100%-12px)] cursor-pointer items-center gap-2 rounded-[12px] border-0 bg-panel-2 px-3 text-left text-small font-extrabold text-text hover:bg-sunk"
                >
                  <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-[3px] border-[1.5px] border-muted" />
                  {ut(GROUP_KEY.stable)}
                  <span className="inline-grid h-5 min-w-5 place-items-center rounded-[10px] bg-sunk px-1.5 text-[11.5px] font-bold text-text-2">
                    {g.items.length}
                  </span>
                  <span className="ml-auto text-caption font-medium text-muted">{ut(stableOpen ? "card.hide" : "card.show")}</span>
                  <Ic.chevronRight size={14} className={cx("text-muted transition-transform", stableOpen && "rotate-90")} />
                </button>
                <div id="card-list-stable" hidden={!stableOpen}>
                  {stableOpen ? g.items.map((p) => <Row key={p.id} p={p} selected={p.id === currentId} now={now} />) : null}
                </div>
              </div>
            ) : (
              <section key={g.key} aria-label={ut(GROUP_KEY[g.key])}>
                {view !== "all" ? (
                  <ListGroup
                    label={ut(GROUP_KEY[g.key])}
                    count={g.items.length}
                    mark={MARK[g.key]}
                    note={g.key === "res" ? ut("card.grpResNote") : undefined}
                  />
                ) : null}
                {g.items.map((p) => (
                  <Row key={p.id} p={p} selected={p.id === currentId} now={now} />
                ))}
              </section>
            ),
          )
        )}
      </div>
      <div className="flex h-[42px] w-[340px] shrink-0 items-center gap-3 border-t border-divider bg-panel px-4 text-caption text-muted">
        <div className="min-w-0 [&>div]:flex-nowrap [&>div]:gap-x-3">
          <KbdHints
            keys={[
              ["J K", ut("card.kRows")],
              ["/", ut("card.kSearch")],
              ["[", ut("card.kCollapse")],
            ]}
          />
        </div>
        <span className="ml-auto whitespace-nowrap font-bold text-text-2">
          {ut("kit.ofTotal").replace("{n}", String(shown)).replace("{total}", String(view === "mine" ? counts.mine : counts.all))}
        </span>
      </div>
    </aside>
  );
}

/** Строка списка: имя, причина пилюлей, следующий шаг и когда; «хто це» — на наведении */
function Row({ p, selected, now }: { p: ListPerson; selected: boolean; now: number }) {
  const { ut } = useLang();
  const r = describe(p.reason, now, ut);
  return (
    <div data-person={p.id}>
      <ListTile
        to={`/patients/${p.id}`}
        title={p.name}
        meta={p.birthYear ? ut("card.born").replace("{y}", String(p.birthYear)) : undefined}
        selected={selected}
        unread={p.reason.kind === "msg"}
        reason={r.tag}
        why={p.reason.kind === "stable" ? (p.unit ?? undefined) : undefined}
        next={r.next}
        nextIcon={r.nextIcon}
        when={r.when}
        whenToday={p.reason.kind === "today"}
        peekTitle={p.name}
        peek={<Peek p={p} now={now} />}
      />
    </div>
  );
}

function Peek({ p, now }: { p: ListPerson; now: number }) {
  const { ut } = useLang();
  const lines = [p.reason, ...p.also].filter((r) => r.kind !== "stable").map((r) => describe(r, now, ut).line);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="m-0 text-text-2">
        {[p.birthYear ? ut("card.born").replace("{y}", String(p.birthYear)) : null, p.unit].filter(Boolean).join(", ")}
      </p>
      {p.phone ? (
        <p className="m-0 flex items-center gap-1.5">
          <Ic.phone size={13} />
          <b className="font-extrabold text-text">{p.phone}</b>
        </p>
      ) : null}
      {lines.length ? (
        <ul className="m-0 list-none border-t border-divider p-0 pt-1.5">
          {lines.map((l, i) => (
            <li key={i} className="py-0.5">
              {l}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-muted">{ut("card.nothingOpen")}</p>
      )}
    </div>
  );
}

/** Сегодня — время; иначе — дата «07.10» */
function whenText(iso: string, now: number): string {
  return dayKey(iso) === dayKey(new Date(now).toISOString()) ? timeOfDay(iso) : dm(iso);
}

interface Described {
  tag: ReactNode;
  next?: string;
  nextIcon?: ReactNode;
  when?: string;
  /** Одна строка для подсказки «хто це» */
  line: string;
}

function describe(r: Reason, now: number, ut: (k: UiKey) => string): Described {
  switch (r.kind) {
    case "now": {
      const clock = riskClock(r.c, now);
      const t =
        clock.norm !== null
          ? ut("kit.timerOf")
              .replace("{elapsed}", clockText(clock.elapsed, ut("rr.days")))
              .replace("{of}", normText(clock.norm, { h: ut("rr.hours"), min: ut("dur.min") }))
          : clockText(clock.elapsed, ut("rr.days"));
      const due = clock.dueAt !== null && clock.left !== null && clock.left > 0;
      return {
        tag: (
          <Tag tone="danger" icon={<Ic.timer />}>
            {ut("card.rsSignal").replace("{t}", t)}
          </Tag>
        ),
        next: due ? ut("card.nxReviewBy").replace("{t}", timeOfDay(new Date(clock.dueAt!).toISOString())) : ut("card.nxReview"),
        nextIcon: <Ic.alert />,
        when: r.c.surveyTitle.split(/[.:]/)[0],
        line: `${ut("card.rsSignal").replace("{t}", t)}: ${r.c.surveyTitle}`,
      };
    }
    case "today": {
      const at = timeOfDay(r.a.startsAt);
      return {
        tag: (
          <Tag tone="primary" icon={<Ic.calendar />}>
            {ut("card.rsVisit").replace("{t}", at)}
          </Tag>
        ),
        next: r.a.reason ?? ut(r.a.kind === "primary" ? "card.nxPrimary" : "card.nxRepeat"),
        nextIcon: <Ic.clipboard />,
        when: r.a.mode === "remote" ? ut("card.online") : r.a.room ? ut("card.room").replace("{r}", r.a.room) : undefined,
        line: ut("card.rsVisit").replace("{t}", at),
      };
    }
    case "msg": {
      const at = whenText(r.t.lastMessageAt, now);
      return {
        tag: (
          <Tag tone="info" icon={<Ic.message />}>
            {ut("card.rsMsg").replace("{t}", at)}
          </Tag>
        ),
        next: ut("card.nxReply"),
        nextIcon: <Ic.reply />,
        line: ut("card.rsMsg").replace("{t}", at),
      };
    }
    case "res": {
      const at = whenText(r.at, now);
      return {
        tag: <Tag icon={<Pi.clipboardCheck />}>{ut("card.rsRes").replace("{t}", at)}</Tag>,
        next: ut("card.nxSeeResult"),
        nextIcon: <Ic.eye />,
        line: ut("card.rsRes").replace("{t}", at),
      };
    }
    case "miss": {
      const at = dm(r.at);
      return {
        tag: (
          <Tag tone="attention" icon={<Pi.calendarX />}>
            {ut("card.rsMiss").replace("{t}", at)}
          </Tag>
        ),
        next: ut("card.nxCallBack"),
        nextIcon: <Ic.phone />,
        line: ut("card.rsMiss").replace("{t}", at),
      };
    }
    case "work": {
      const kind = ut(WORK_KIND[r.w.kind]);
      const what =
        r.w.kind === "referral" ? ut(r.w.title === "created" ? "work.refNotAccepted" : "work.refNotDone") : r.w.title;
      return {
        tag: <Tag tone={r.w.overdue ? "attention" : "plain"}>{kind}</Tag>,
        next: what,
        nextIcon: <Ic.arrowRight />,
        when: r.w.overdue && r.w.days ? ut("card.overdueDays").replace("{n}", String(r.w.days)) : undefined,
        line: `${kind}: ${what}`,
      };
    }
    default:
      return { tag: null, line: "" };
  }
}
