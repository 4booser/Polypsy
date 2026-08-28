import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { onAppEvent, type AppEvent } from "../events";
import { useLang } from "../lang";
import { dateTime, severityColor } from "../format";

/**
 * Центр событий.
 *
 * Одно место, где видно, что произошло, пока тебя не было. Раньше об этом
 * можно было узнать, только обойдя экраны: тревога появлялась в очереди,
 * взятый коллегой случай — там же, и заметить изменение можно было лишь по
 * счётчику в меню.
 *
 * Лента живёт только в памяти вкладки и не переживает перезагрузку: это
 * оповещение, а не журнал. Журнал — отдельный экран, и он не теряет ничего.
 */

const LIMIT = 30;

export function EventCenter() {
  const { ut } = useLang();
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
        {unread > 0 ? <span className="events-dot">{unread > 9 ? "9+" : unread}</span> : null}
      </button>

      {open ? (
        <div className="events-panel" role="dialog" aria-label={ut("ev.title")}>
          <div className="events-head">
            <strong>{ut("ev.title")}</strong>
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
