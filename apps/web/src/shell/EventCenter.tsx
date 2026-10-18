import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { onAppEvent, type AppEvent, type AppEventKind } from "../events";
import type { UiKey } from "@quizzy/shared";
import { useLang } from "../lang";
import { api } from "../api";
import { useAuth } from "../auth";
import { useResource, type Resource } from "../useResource";
import { loadView } from "../ui";
import { day, severityKey, timeOfDay } from "../format";
import { cx } from "../ui/cx";
import { occurrenceKeys } from "../ui/rowKeys";
import { SeverityTag } from "../ui/primitives";
import { ShellIcon, type IconName } from "./icons";
import { Drawer, Tooltip } from "../ui";

/**
 * Центр событий — колокольчик на полосе приложения и ящик справа.
 *
 * Одно место, где видно, что произошло, пока тебя не было. Ящик показывает
 * две разные вещи, и это различие важно.
 *
 * Сводка «пока вас не было» — запрос к серверу за тем, что изменилось с
 * момента, когда человек в прошлый раз нажал «прочитано». Она считается по
 * самим данным, а не читается из второго журнала событий: журнал пришлось бы
 * писать при каждом изменении, и однажды он разошёлся бы с реальностью.
 *
 * Живая лента — то, что пришло по каналу, пока вкладка открыта. Она в памяти
 * и перезагрузку не переживает: это оповещение, а не журнал.
 *
 * Колокольчик стоит на полосе всегда, а не в меню: число на нём видно с
 * любого экрана, и сквозной сценарий «тревога догоняет открытый экран»
 * (e2e/triage.e2e.ts) ловит его без единого нажатия.
 */

const LIMIT = 30;

type Kind = "case.opened" | "case.resolved" | "referral.created" | "schedule.run";

const GROUP: Record<Kind, { key: UiKey; icon: IconName; risk?: boolean }> = {
  "case.opened": { key: "ec.caseOpened", icon: "triangle-alert", risk: true },
  "case.resolved": { key: "ec.caseResolved", icon: "circle-check" },
  "referral.created": { key: "ec.referralCreated", icon: "arrow-right-left" },
  "schedule.run": { key: "ec.scheduleRun", icon: "calendar-days" },
};

/*
 * Отбор ящика — по смыслу события, а не по его виду: «Ризик» — случаи и
 * тревоги, «Пацієнти» — направления и сданные методики, «Система» —
 * расписания и журнал. Набор рисует эти четыре вкладки над лентой.
 */
type Filter = "all" | "risk" | "patients" | "system";
const FILTERS: { key: Filter; label: UiKey }[] = [
  { key: "all", label: "cases.filterAll" },
  { key: "risk", label: "rail.cases" },
  { key: "patients", label: "nav.patients" },
  { key: "system", label: "ops.group.system" },
];
const MISSED_FILTER: Record<Kind, Filter> = {
  "case.opened": "risk",
  "case.resolved": "risk",
  "referral.created": "patients",
  "schedule.run": "system",
};

/*
 * Полный перебор видов, а не два известных и «остальное как есть»:
 * Record<AppEventKind, …> означает, что новый вид события не соберётся, пока
 * ему не дадут имени на человеческом языке и места в отборе.
 */
const EVENT_KEY: Record<AppEventKind, { key: UiKey; filter: Filter }> = {
  "alert.created": { key: "ev.alert", filter: "risk" },
  "case.changed": { key: "ev.case", filter: "risk" },
  "response.submitted": { key: "ev.response", filter: "patients" },
  "schedule.run": { key: "ev.schedule", filter: "system" },
  "presence.changed": { key: "ev.presence", filter: "system" },
  action: { key: "ev.action", filter: "system" },
};

export function EventCenter() {
  const { ut } = useLang();
  const { user, refreshUser } = useAuth();
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const bell = useRef<HTMLButtonElement>(null);

  /*
   * Точка отсчёта: когда человек в прошлый раз сказал «прочитано». Если
   * такой отметки нет — сутки назад, а не начало времён.
   *
   * Значение обязано быть устойчивым между отрисовками: запасная точка,
   * посчитанная выражением в теле компонента, давала новую строку на каждой
   * отрисовке, строка стояла в зависимостях запроса, и консоль уходила в
   * бесконечный опрос сервера (e2e/responsive.e2e.ts это сторожит).
   */
  const seenAt = user?.workspace?.eventsSeenAt;
  const since = useMemo(() => seenAt ?? new Date(Date.now() - 86_400_000).toISOString(), [seenAt]);

  const missed = useResource(() => api.missed(since), [since]);
  const missedCount = (missed.data?.groups ?? []).reduce((n, g) => n + g.count, 0);

  useEffect(
    () =>
      onAppEvent((e) => {
        setEvents((prev) => [e, ...prev].slice(0, LIMIT));
        setUnread((n) => n + 1);
      }),
    [],
  );

  const close = useCallback(() => setOpen(false), []);
  const total = unread + missedCount;
  const name = total > 0 ? `${ut("ev.title")}, ${total}` : ut("ev.title");

  return (
    <>
      <Tooltip label={ut("ev.title")} side="bottom">
          <button
            ref={bell}
            type="button"
            aria-label={name}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => {
              setOpen((v) => !v);
              setUnread(0);
            }}
            className={cx(
              "relative grid size-10 min-h-0 shrink-0 place-items-center rounded-[12px] border-0 bg-transparent p-0",
              "text-appbar-muted transition-colors duration-[var(--dur-fast)] hover:bg-appbar-hover hover:text-appbar-ink",
              "aria-expanded:bg-appbar-hover aria-expanded:text-appbar-ink",
            )}
          >
            <ShellIcon name="bell" size={17} />
            {/*
              Счётчик — сиреневый на тёмной полосе, а не янтарь и не красный:
              это новости, а не тревога. Случаи риска среди них есть, но их
              число и так стоит красным у «Ризик» на рельсе.
            */}
            {total > 0 ? (
              <span
                aria-hidden
                /* признак для сквозного сценария «тревога догоняет открытый экран»: класс здесь — набор утилит, и цепляться за него хрупко */
                data-events-dot=""
                className={cx(
                  "absolute right-[3px] top-[3px] h-[18px] min-w-[18px] rounded-[9px] px-[5px] text-center",
                  "bg-appbar-badge text-[10.5px] font-extrabold leading-[18px] text-appbar-badge-ink tabular-nums",
                  "shadow-[0_0_0_2px_var(--appbar)]",
                )}
              >
                {total > 9 ? "9+" : total}
              </span>
            ) : null}
          </button>
      </Tooltip>

      {/*
        Ящик набора (ui/Drawer): справа под полосой приложения, Esc и
        подложка закрывают, фокус заперт и возвращается колокольчику. Не
        размонтируется при закрытии — выбранный отбор живёт до следующего
        открытия.
      */}
      <Drawer
        open={open}
        onClose={close}
        title={ut("ev.title")}
        sub={total > 0 ? ut("ec.newCount").replace("{n}", String(total)) : ut("ec.allCaught")}
        icon={<ShellIcon name="bell" size={18} />}
      >
          <div className="pb-[4px] pt-[14px]">
            <FilterBar value={filter} onChange={setFilter} />
          </div>
          <div className="pb-[8px]">
            <div className="flex items-center gap-[10px] pb-[6px] pt-[14px]">
              <h3 className="m-0 text-[15px] font-extrabold leading-5 tracking-[-0.01em] text-text">{ut("ec.missed")}</h3>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">
                {ut("ec.since")} {when(since)}
              </span>
              {missedCount > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    /*
                     * «Прочитано» сдвигает точку отсчёта на сейчас. Отметки на
                     * каждое событие нет намеренно: человек читает сводку
                     * целиком, и учёт по одному пункту создавал бы работу там,
                     * где её нет.
                     */
                    void api
                      .saveWorkspace({ eventsSeenAt: new Date().toISOString() })
                      .then(refreshUser)
                      .catch(() => {});
                  }}
                  className={cx(
                    "inline-flex h-8 min-h-0 shrink-0 items-center gap-[6px] rounded-[9px] border-0 bg-violet-tint px-[12px]",
                    "text-[12.5px] font-bold text-violet-ink transition-colors hover:bg-violet-tint-2",
                  )}
                >
                  <ShellIcon name="check" size={15} />
                  {ut("ec.markRead")}
                </button>
              ) : null}
            </div>
            <MissedList res={missed} onGo={close} filter={filter} />

            <div className="mt-[10px] flex items-center gap-[10px] border-t border-divider pb-[6px] pt-[16px]">
              <h3 className="m-0 text-[15px] font-extrabold leading-5 tracking-[-0.01em] text-text">{ut("ec.live")}</h3>
              <span className="text-[12.5px] text-muted">{ut("ev.sessionOnly")}</span>
            </div>
            <LiveFeed events={events} filter={filter} onGo={close} />
          </div>
      </Drawer>
    </>
  );
}

/** Отбор ящика — сегменты набора (.seg): одна плашка, выбранный сегмент белой карточкой */
function FilterBar({ value, onChange }: { value: Filter; onChange: (f: Filter) => void }) {
  const { ut } = useLang();
  return (
    <div role="group" aria-label={ut("ec.filter")} className="flex gap-[2px] rounded-[12px] bg-sunk p-[3px]">
      {FILTERS.map((f) => {
        const on = f.key === value;
        return (
          <button
            key={f.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(f.key)}
            className={cx(
              "h-9 min-h-0 flex-1 rounded-[9px] border-0 px-2 text-[13px] leading-none",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
              on ? "bg-panel font-bold text-violet-ink shadow-tile" : "bg-transparent font-semibold text-text-2 hover:text-text",
            )}
          >
            {ut(f.label)}
          </button>
        );
      })}
    </div>
  );
}

function LiveFeed({ events, filter, onGo }: { events: AppEvent[]; filter: Filter; onGo: () => void }) {
  const { ut } = useLang();
  const shown = filter === "all" ? events : events.filter((e) => EVENT_KEY[e.kind].filter === filter);
  /*
   * Ключ — момент и вид события, а не место в ленте: новое встаёт сверху, и
   * по номеру каждое прибытие перенумеровывало все строки ниже — фокус с
   * клавиатуры слетал со строки, на которой стоял.
   */
  const keys = useMemo(() => occurrenceKeys(shown, (e) => `${e.at}|${e.kind}|${e.userId ?? ""}`), [shown]);
  if (shown.length === 0) return <Quiet>{ut("ev.empty")}</Quiet>;
  return (
    <div className="flex flex-col">
      {shown.map((e, i) => (
        <Link key={keys[i]} to="/alerts" className={ROW} onClick={onGo}>
          <span className="min-w-0 flex-1 truncate font-semibold text-text">{ut(EVENT_KEY[e.kind].key)}</span>
          {e.severity ? <SevMark level={e.severity} /> : null}
          <span className="shrink-0 text-[12.5px] text-muted tabular-nums">{when(e.at)}</span>
        </Link>
      ))}
    </div>
  );
}

/**
 * Сводка «пока вас не было» по загрузке — без запроса внутри
 * (test/loadStates.test.tsx).
 *
 * «Нічого нового» — ответ сервера, а не отсутствие ответа: до ответа —
 * «завантаження», на отказе — текст отказа и «Повторити». Сводка, которая
 * на отказе говорила бы «нічого не пропущено», лгала бы про смену, за которую
 * могли открыться случаи риска.
 */
export function MissedList({
  res,
  onGo,
  filter = "all",
}: {
  res: Pick<Resource<Awaited<ReturnType<typeof api.missed>>>, "data" | "error" | "loading" | "reload" | "updatedAt">;
  onGo: () => void;
  filter?: Filter;
}) {
  const { ut } = useLang();
  const view = loadView(res, (d) => d.groups.every((g) => g.count === 0));
  if (view === "failed") {
    return (
      <div role="alert" className="flex items-center gap-3 py-4">
        <p className="m-0 min-w-0 flex-1 text-[13px] leading-[18px] text-danger">{res.error}</p>
        <button
          type="button"
          disabled={res.loading}
          onClick={res.reload}
          className="h-8 min-h-0 shrink-0 rounded-[9px] border-0 bg-violet-tint px-[12px] text-[12.5px] font-bold text-violet-ink disabled:opacity-45"
        >
          {ut("common.retry")}
        </button>
      </div>
    );
  }
  if (view === "wait") return <Quiet>{ut("common.loading")}</Quiet>;
  if (view === "empty") return <Quiet>{ut("ec.nothing")}</Quiet>;
  const groups = (res.data?.groups ?? []).filter(
    (g) => g.count > 0 && (filter === "all" || MISSED_FILTER[g.kind as Kind] === filter),
  );
  if (groups.length === 0) return <Quiet>{ut("ec.nothing")}</Quiet>;
  return (
    <div className="flex flex-col gap-[6px]">
      {groups.map((g) => {
        const look = GROUP[g.kind as Kind] ?? GROUP["schedule.run"];
        return (
          <section key={g.kind} className="flex flex-col">
            <div className="flex items-center gap-[10px] py-[8px]">
              <span
                aria-hidden
                className={cx(
                  "grid size-7 shrink-0 place-items-center rounded-[8px]",
                  look.risk ? "bg-risk-tint text-risk-ink" : "bg-violet-tint text-violet-ink",
                )}
              >
                <ShellIcon name={look.icon} size={15} />
              </span>
              <h4 className="m-0 text-[13.5px] font-bold leading-[18px] text-text">{ut(look.key)}</h4>
              <span
                className={cx(
                  "inline-grid h-5 min-w-[20px] place-items-center rounded-[10px] px-[6px] text-[11.5px] font-bold tabular-nums",
                  look.risk ? "bg-risk text-onfill" : "bg-sunk text-text-2",
                )}
              >
                {g.count}
              </span>
            </div>
            {g.items.slice(0, 5).map((item) => (
              <Link key={item.id} to={item.href} className={ROW} onClick={onGo}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold text-text">{item.title}</span>
                  {item.detail ? <span className="block truncate text-[12.5px] text-text-2">{item.detail}</span> : null}
                </span>
                {item.severity ? <SevMark level={item.severity} /> : null}
                <span className="shrink-0 self-start pt-[1px] text-[12.5px] text-muted tabular-nums">
                  {when(item.at)}
                </span>
              </Link>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/**
 * Когда: сегодняшнее — часами («14:12»), прежнее — днём и часами
 * («17 жовт., 18:40»). Прежде здесь резалась строка полной даты по
 * позициям, и с длинным месяцем на экран выходил её обрывок.
 */
function when(iso: string): string {
  const sameDay = new Date(iso).toDateString() === new Date().toDateString();
  return sameDay ? timeOfDay(iso) : `${day(iso)}, ${timeOfDay(iso)}`;
}

/* строка ленты: подложка наведения и кольцо фокуса — внутри строки, ящик прокручивается сам */
const ROW = cx(
  "flex items-center gap-[10px] rounded-[10px] px-[10px] py-[8px] text-[13px] leading-[18px]",
  "text-text-2 no-underline hover:bg-sunk hover:no-underline",
  "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
);

function Quiet({ children }: { children: ReactNode }) {
  return <p className="m-0 py-[18px] text-center text-[13px] text-muted">{children}</p>;
}

/*
 * Выраженность — меткой со словом и формой точки (SeverityTag), а не голой
 * цветной точкой: «умеренная» и «выраженная» иначе различались бы только
 * оттенком.
 */
function SevMark({ level }: { level: "moderate" | "severe" }) {
  const { ut } = useLang();
  return (
    <SeverityTag level={level} className="shrink-0">
      {ut(severityKey[level])}
    </SeverityTag>
  );
}
