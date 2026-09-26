import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { onAppEvent, type AppEvent, type AppEventKind } from "../events";
import type { UiKey } from "@quizzy/shared";
import { useLang } from "../lang";
import { api } from "../api";
import { useAuth } from "../auth";
import { useResource } from "../useResource";
import { dateTime, severityKey } from "../format";
import { cx } from "../ui/cx";
import { Button, SeverityTag } from "../ui/primitives";

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
  const bell = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  /*
   * Точка отсчёта: когда человек в прошлый раз сказал «прочитано». Если такой
   * отметки нет — берём сутки назад, а не начало времён: первое открытие
   * панели не должно вываливать всю историю учреждения.
   *
   * Значение обязано быть устойчивым между отрисовками, и это не
   * придирка. Раньше запасная точка считалась выражением прямо в теле
   * компонента: каждая отрисовка давала новую строку, строка стояла в
   * зависимостях запроса, ответ вызывал отрисовку — и консоль уходила в
   * бесконечный опрос сервера. В записи ответов видно двенадцать запросов
   * к одному и тому же адресу за сто семьдесят миллисекунд.
   *
   * Страдал от этого каждый, кто ни разу не отмечал события прочитанными,
   * то есть по умолчанию все.
   */
  const seenAt = user?.workspace?.eventsSeenAt;
  const since = useMemo(
    () => seenAt ?? new Date(Date.now() - 86_400_000).toISOString(),
    [seenAt],
  );

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
    /*
     * Esc гасит панель, и только её, — если человек в ней или на
     * колокольчике.
     *
     * Панель живёт внутри бургера, и Esc слышат оба: бургер вешает свой
     * обработчик на документ раньше, и одно нажатие закрывало сразу и
     * панель, и весь список — человек, хотевший убрать ленту событий,
     * оставался без меню. Поэтому здесь перехват на фазе погружения и
     * остановка: до обработчика бургера нажатие не доходит. Если фокус не
     * здесь (человек ушёл Tab-ом к разделам), Esc принадлежит бургеру —
     * он закрывается целиком и уносит панель с собой.
     *
     * Фокус возвращается на колокольчик: панель исчезает из-под курсора, и
     * без возврата он упал бы в body, мимо ловушки бургера.
     */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !ref.current?.contains(document.activeElement)) return;
      e.stopPropagation();
      setOpen(false);
      bell.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

/*
 * Полный перебор видов, а не два известных и «остальное как есть».
 *
 * Раньше здесь стояла цепочка из двух условий, а всё прочее падало в
 * `e.kind` — то есть человек читал в списке событий голую строку «action».
 * Приходила она на КАЖДОЕ журналируемое изменение, так что список событий
 * состоял из неё едва ли не целиком.
 *
 * Record<AppEventKind, …> означает, что новый вид события не соберётся, пока
 * ему не дадут имени на человеческом языке.
 */
const EVENT_KEY: Record<AppEventKind, UiKey> = {
  "alert.created": "ev.alert",
  "case.changed": "ev.case",
  "response.submitted": "ev.response",
  "schedule.run": "ev.schedule",
  "presence.changed": "ev.presence",
  action: "ev.action",
} as const;

  const total = unread + missedCount;

  return (
    /*
      Обёртка без `relative`, и это не упущение: панель раскрывается под
      строкой поиска бургера во всю её ширину, а не свисает от колокольчика.
      Прежде она стояла шириной 340 справа от колокольчика, то есть шире
      бургера и левее его края, — на телефоне её левая кромка уходила за
      стекло. Отсчёт она берёт от строки бургера (там `relative`, Topbar.tsx).
    */
    <div ref={ref} className="shrink-0">
      {/*
        Колокольчик — глиф консоли (27 видимых, 44 нажимаемых), тот же, что у
        темы рядом с ним: две кнопки одной строки одного размера.
      */}
      <Button
        ref={bell}
        size="glyph"
        variant="ghost"
        aria-label={ut("ev.title")}
        title={ut("ev.title")}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="[&>svg]:size-[22px]"
        onClick={() => {
          setOpen((v) => !v);
          setUnread(0);
        }}
      >
        <IconBell />
        {/*
          Счётчик считает и пропущенное, и пришедшее при открытой вкладке.
          Фиолетовый, а не янтарный: это новости, а не тревога. Случаи риска
          среди них есть, но их число и так стоит янтарём у «Випадки ризику»
          в том же бургере, а «спрацював розклад» и «дія в журналі» внимания
          не требуют — янтарь на общей сумме кричал бы о них тем же голосом.
        */}
        {total > 0 ? (
          <span
            aria-hidden
            className="absolute -right-2 -top-1.5 min-w-[16px] rounded-full bg-primary px-1 text-center font-mono text-[10px] font-bold leading-[16px] text-primary-text tabular-nums"
          >
            {total > 9 ? "9+" : total}
          </span>
        ) : null}
      </Button>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label={ut("ev.title")}
          /*
            Плашка всплывающего слоя консоли: рамка #999999, радиус 5, тень.
            Прокручивается она сама, целиком, — выступать из неё нечему, а
            две ленты с прокруткой каждая внутри одной плашки читались бы как
            два окна.
          */
          className={cx(
            "absolute inset-x-2 top-[calc(100%+4px)] z-10 flex flex-col overflow-y-auto overscroll-contain",
            "max-h-[min(440px,calc(100dvh-200px))] [scrollbar-width:thin]",
            "rounded-[5px] border border-border-strong bg-[var(--bg)] shadow-pop",
          )}
        >
          <PanelHead title={ut("ec.missed")} note={`${ut("ec.since")} ${dateTime(since)}`} />

          {missedCount === 0 ? (
            <Empty>{ut("ec.nothing")}</Empty>
          ) : (
            <div className="flex flex-col">
              {(missed.data?.groups ?? []).map((g) => (
                <div key={g.kind} className="flex flex-col">
                  {/* подпись группы — как заголовки групп бургера: 13/700 серым, без капители */}
                  <div className="px-3 pb-1 pt-2 text-[13px] font-bold leading-[18px] text-muted">
                    {ut(GROUP_KEY[g.kind])} · <span className="font-mono tabular-nums">{g.count}</span>
                  </div>
                  {g.items.slice(0, 5).map((item) => (
                    <Link key={item.id} to={item.href} className={ROW} onClick={() => setOpen(false)}>
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      {item.severity ? <SevMark level={item.severity} /> : null}
                      <span className="shrink-0 font-mono text-[11px] text-muted tabular-nums">
                        {dateTime(item.at).slice(5, 16)}
                      </span>
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          )}

          {missedCount > 0 ? (
            <div className="border-t border-hairline p-2">
              <Button
                variant="quiet"
                className="w-full"
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
              </Button>
            </div>
          ) : null}

          <PanelHead title={ut("ec.live")} note={ut("ev.sessionOnly")} ruled />
          {events.length === 0 ? (
            <Empty>{ut("ev.empty")}</Empty>
          ) : (
            <div className="flex flex-col">
              {events.map((e, i) => (
                <Link key={`${e.at}-${i}`} to="/alerts" className={ROW} onClick={() => setOpen(false)}>
                  <span className="min-w-0 flex-1 truncate">{ut(EVENT_KEY[e.kind])}</span>
                  {e.severity ? <SevMark level={e.severity} /> : null}
                  <span className="shrink-0 font-mono text-[11px] text-muted tabular-nums">
                    {dateTime(e.at).slice(11)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* строка ленты: текст 13 тоном второго текста, подложка наведения — как у пунктов бургера */
const ROW = cx(
  "flex items-center gap-2.5 border-b border-hairline px-3 py-2 last:border-b-0",
  "text-[13px] leading-[18px] text-text-2 no-underline hover:bg-primary-tint hover:text-text hover:no-underline",
  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus)]",
);

/** Шапка ленты: название 13/700 серым и пояснение 11 справа */
function PanelHead({ title, note, ruled }: { title: string; note: string; ruled?: boolean }) {
  return (
    <div
      className={cx(
        "flex items-baseline justify-between gap-3 border-b border-hairline px-3 pb-2 pt-3",
        ruled && "border-t",
      )}
    >
      <span className="text-[13px] font-bold leading-[18px] text-muted">{title}</span>
      <span className="text-[11px] text-muted">{note}</span>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 px-3 py-5 text-center text-[13px] text-muted">{children}</p>;
}

/*
 * Выраженность — меткой со словом и формой точки (SeverityTag), а не голой
 * цветной точкой. Прежде у строки стояла точка 6 px цветом тяжести, и только
 * цветом: «умеренная» и «выраженная» различались оттенком оранжевого, то есть
 * для того, кто их не различает, не различались вовсе.
 */
function SevMark({ level }: { level: "moderate" | "severe" }) {
  const { ut } = useLang();
  return (
    <SeverityTag level={level} className="shrink-0">
      {ut(severityKey[level])}
    </SeverityTag>
  );
}

function IconBell() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
      <path d="M10.3 20a2 2 0 0 0 3.4 0" />
    </svg>
  );
}
