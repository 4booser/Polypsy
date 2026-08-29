import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { onAppEvent, type AppEvent } from "../events";
import { useLang } from "../lang";
import { api } from "../api";
import { useAuth } from "../auth";
import { useResource } from "../useResource";
import { dateTime, severityColor } from "../format";

/**
 * Центр событий.
 *
 * Одно место, где видно, что произошло, пока тебя не было. Раньше об этом
 * можно было узнать, только обойдя экраны: тревога появлялась в очереди,
 * взятый коллегой случай — там же, и заметить изменение можно было лишь по
 * счётчику в меню.
 *
 * Панель показывает две разные вещи, и это различие важно.
 *
 * Живая лента — то, что пришло по каналу, пока вкладка открыта. Она в памяти и
 * перезагрузку не переживает: это оповещение, а не журнал.
 *
 * Сводка «пока вас не было» — запрос к серверу за тем, что изменилось с
 * момента, когда человек в прошлый раз нажал «прочитано». Она считается по
 * самим данным, а не читается из второго журнала событий: журнал пришлось бы
 * писать при каждом изменении, и однажды он разошёлся бы с реальностью —
 * случай закрыт, а в ленте открыт.
 */

const LIMIT = 30;

const GROUP_KEY = {
  "case.opened": "ec.caseOpened",
  "case.resolved": "ec.caseResolved",
  "referral.created": "ec.referralCreated",
  "schedule.run": "ec.scheduleRun",
} as const;

export function EventCenter() {
  const { ut } = useLang();
  const { user, refreshUser } = useAuth();
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  /*
   * Точка отсчёта: когда человек в прошлый раз сказал «прочитано». Если такой
   * отметки нет — берём сутки назад, а не начало времён: первое открытие
   * панели не должно вываливать всю историю учреждения.
   */
  const since =
    user?.workspace?.eventsSeenAt ?? new Date(Date.now() - 86_400_000).toISOString();

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

  // закрытие по клику вне и по Esc — иначе панель остаётся висеть
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = (e: AppEvent) =>
    e.kind === "alert.created" ? ut("ev.alert") : e.kind === "case.changed" ? ut("ev.case") : e.kind;

  return (
    <div className="events" ref={ref}>
      <button
        className="ghost icon-btn"
        aria-label={ut("ev.title")}
        title={ut("ev.title")}
        onClick={() => {
          setOpen((v) => !v);
          setUnread(0);
        }}
      >
        <IconBell />
        {/* счётчик считает и пропущенное, и пришедшее при открытой вкладке */}
        {unread + missedCount > 0 ? (
          <span className="events-dot">{unread + missedCount > 9 ? "9+" : unread + missedCount}</span>
        ) : null}
      </button>

      {open ? (
        <div className="events-panel" role="dialog" aria-label={ut("ev.title")}>
          <div className="events-head">
            <strong>{ut("ec.missed")}</strong>
            <span className="hint">
              {ut("ec.since")} {dateTime(since)}
            </span>
          </div>

          {missedCount === 0 ? (
            <p className="events-empty">{ut("ec.nothing")}</p>
          ) : (
            <div className="events-list">
              {(missed.data?.groups ?? []).map((g) => (
                <div key={g.kind}>
                  <div className="events-group">
                    {ut(GROUP_KEY[g.kind])} · {g.count}
                  </div>
                  {g.items.slice(0, 5).map((item) => (
                    <Link
                      key={item.id}
                      to={item.href}
                      className="events-row"
                      onClick={() => setOpen(false)}
                    >
                      <i
                        className="events-mark"
                        style={{
                          background: item.severity
                            ? severityColor[item.severity]
                            : "var(--border-strong)",
                        }}
                      />
                      <span className="grow">{item.title}</span>
                      <span className="muted">{dateTime(item.at).slice(5, 16)}</span>
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          )}

          {missedCount > 0 ? (
            <button
              className="ghost"
              style={{ width: "100%" }}
              onClick={() => {
                /*
                 * «Прочитано» сдвигает точку отсчёта на сейчас. Отдельной
                 * отметки на каждое событие нет намеренно: человек читает
                 * сводку целиком, и учёт по одному пункту создавал бы работу
                 * там, где её нет.
                 */
                void api
                  .saveWorkspace({ eventsSeenAt: new Date().toISOString() })
                  .then(refreshUser)
                  .catch(() => {});
              }}
            >
              {ut("ec.markRead")}
            </button>
          ) : null}

          <div className="events-head">
            <strong>{ut("ec.live")}</strong>
            <span className="hint">{ut("ev.sessionOnly")}</span>
          </div>
          {events.length === 0 ? (
            <p className="events-empty">{ut("ev.empty")}</p>
          ) : (
            <div className="events-list">
              {events.map((e, i) => (
                <Link
                  key={`${e.at}-${i}`}
                  to="/alerts"
                  className="events-row"
                  onClick={() => setOpen(false)}
                >
                  <i
                    className="events-mark"
                    style={{ background: e.severity ? severityColor[e.severity] : "var(--border-strong)" }}
                  />
                  <span className="grow">{label(e)}</span>
                  <span className="muted">{dateTime(e.at).slice(11)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function IconBell() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
      <path d="M10.3 20a2 2 0 0 0 3.4 0" />
    </svg>
  );
}
