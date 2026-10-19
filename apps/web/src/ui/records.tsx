import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "./cx";
import { grouped } from "./decimal";
import { Ic } from "./icons";
import { IconTile } from "./layout";
import { Popover } from "./Popover";
import { buttonClass } from "./primitives";
import { useLang, useScreenLang } from "../lang";

/*
 * Запись о человеке в наборе «Виразна»: строка открытого (alert strip),
 * плитка списка, ячейка человека, пары «ключ — значение» и хронология.
 */

/* ─────────── строка открытого ─────────── */

/** Вид пилюли строки: нейтральная, сообщение, внимание, «всё в порядке» (только значок) */
export type AlertKind = "neutral" | "message" | "warn" | "good";

const chipTone: Record<AlertKind, { box: string; ink: string }> = {
  neutral: { box: "bg-sunk hover:bg-sunk-2", ink: "text-muted" },
  message: { box: "bg-info-tint hover:bg-info-tint-2", ink: "text-info" },
  warn: { box: "bg-warn-tint hover:bg-warn-tint-2", ink: "text-warn" },
  good: { box: "bg-good-tint hover:shadow-[inset_0_0_0_1px_var(--goodline)]", ink: "text-good" },
};

/**
 * Пилюля строки открытого (.chip набора): 34 px, значок, жирная подпись и
 * приглушённая подробность. У каждой своё действие (`onClick` / `to`) и свой
 * поповер (`pop`). `good` — только значок, подпись уходит в aria-label.
 * `draft` — точка «тут лежит черновик» в углу; `locked` — замок после
 * подписи (подпись закрыта, пока не разобран сигнал).
 */
export function AlertChip({
  kind = "neutral",
  icon,
  label,
  detail,
  onClick,
  to,
  pop,
  popTitle,
  popNote,
  popActions,
  pressed,
  locked,
  draft,
}: {
  kind?: AlertKind;
  icon?: ReactNode;
  label: string;
  /** Приглушённое после подписи: «учора», «до 15.10» */
  detail?: ReactNode;
  onClick?: () => void;
  to?: string;
  /** Тело поповера; без него поповера нет */
  pop?: ReactNode;
  popTitle?: ReactNode;
  popNote?: ReactNode;
  popActions?: ReactNode;
  /** Связанный ящик открыт: пилюля «нажата» */
  pressed?: boolean;
  locked?: boolean;
  draft?: boolean;
}) {
  const tone = chipTone[kind];
  const good = kind === "good";
  const cls = cx(
    "relative inline-flex h-[34px] shrink-0 cursor-pointer items-center gap-[5px] rounded-[17px] border-0 text-caption font-semibold leading-none text-text-2 no-underline",
    "transition-[background-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease)] hover:no-underline",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
    good ? "w-[34px] justify-center p-0" : "pl-[9px] pr-[11px]",
    pressed ? "bg-violet-tint shadow-[inset_0_0_0_1.5px_var(--vring)]" : tone.box,
  );
  const inner = (
    <>
      {icon ? (
        <span className={cx("inline-flex [&>svg]:size-[15px]", pressed ? "text-violet-ink" : tone.ink, good && "[&>svg]:size-4")}>{icon}</span>
      ) : null}
      {good ? null : (
        <b className={cx("font-bold", pressed ? "text-violet-ink" : kind === "neutral" ? "text-text" : tone.ink)}>{label}</b>
      )}
      {detail && !good ? <span className={cx("font-medium", kind === "message" ? "text-text-2" : "text-muted")}>{detail}</span> : null}
      {locked ? <Ic.lock size={12} className="text-muted" /> : null}
      {draft ? (
        <i aria-hidden className="absolute -right-[3px] -top-[3px] size-[11px] rounded-full border-2 border-panel bg-primary" />
      ) : null}
    </>
  );
  const node = to ? (
    <Link to={to} className={cls} aria-label={good ? label : undefined}>
      {inner}
    </Link>
  ) : (
    <button type="button" className={cls} onClick={onClick} aria-pressed={pressed} aria-label={good ? label : undefined}>
      {inner}
    </button>
  );
  return pop ? (
    <Popover content={pop} title={popTitle ?? label} note={popNote} actions={popActions}>
      {node}
    </Popover>
  ) : (
    node
  );
}

/**
 * Таймер разбора: «2:48 з 4 год» и полоска. `size="lg"` — плашка в шапке
 * ящика (.dtimer), обычный — внутри красной пилюли. `done` — разобрано
 * (зелёная), `note` — правая часть плашки: «до 18:12, лишилось 1:12».
 */
export function RiskTimer({
  elapsed,
  of,
  pct,
  size = "sm",
  done,
  note,
}: {
  elapsed: string;
  of: string;
  /** Сколько прошло от нормы, 0–100 */
  pct: number;
  size?: "sm" | "lg";
  done?: boolean;
  note?: ReactNode;
}) {
  const { ut } = useLang();
  const [, after] = ut("kit.timerOf").split("{elapsed}");
  const rest = (after ?? "").replace("{of}", of);
  const ink = done ? "text-good" : "text-risk-ink";
  const fill = Math.max(0, Math.min(100, pct));
  if (size === "lg") {
    return (
      <div
        className={cx(
          "flex h-[52px] items-center gap-2.5 whitespace-nowrap rounded-panel px-3.5 text-small font-semibold text-text-2",
          done ? "bg-good-tint" : "bg-risk-tint",
        )}
      >
        <Ic.timer size={15} className={ink} />
        <span>
          <b className={cx("mr-0.5 text-[28px] font-extrabold leading-none tracking-[-0.03em]", ink)}>{elapsed}</b>
          {rest}
        </span>
        <span className="inline-block h-2 w-[72px] overflow-hidden rounded-[4px] bg-risk-line" aria-hidden>
          <i className={cx("block h-full rounded-[4px]", done ? "bg-good" : "bg-risk")} style={{ width: `${fill}%` }} />
        </span>
        {note ? <span className="ml-auto text-text-2">{note}</span> : null}
      </div>
    );
  }
  return (
    <span className="inline-flex items-center gap-[5px] text-caption font-semibold text-text-2">
      <Ic.timer size={14} className={ink} />
      <span>
        <b className={cx("text-body font-extrabold leading-none", ink)}>{elapsed}</b>
        {rest}
      </span>
      <span className="inline-block h-1.5 w-7 overflow-hidden rounded-[3px] bg-risk-line" aria-hidden>
        <i className={cx("block h-full rounded-[3px]", done ? "bg-good" : "bg-risk")} style={{ width: `${fill}%` }} />
      </span>
    </span>
  );
}

/**
 * Красная пилюля сигнала (.chip-risk): номер, таймер, «Розібрати». Красный —
 * только здесь и в действии над риском. `state="duty"` — передано
 * черговому (контур вместо заливки), `done` — разобрано (зелёная).
 */
export function RiskChip({
  title,
  timer,
  action,
  state = "open",
  pop,
  popTitle,
  popNote,
  popActions,
}: {
  /** «Сигнал № 214» */
  title: string;
  /** <RiskTimer …/> */
  timer?: ReactNode;
  /** Кнопка действия: <Button variant="risk" size="xs">Розібрати</Button> */
  action?: ReactNode;
  state?: "open" | "duty" | "done";
  pop?: ReactNode;
  popTitle?: ReactNode;
  popNote?: ReactNode;
  popActions?: ReactNode;
}) {
  const ink = state === "done" ? "text-good" : "text-risk-ink";
  const label = (
    <span className="inline-flex h-full items-center gap-[7px] rounded-[14px]">
      {state === "done" ? <Ic.circleCheck size={17} className={ink} /> : <Ic.alert size={17} className={ink} />}
      <b className={cx("text-[13px] font-extrabold", ink)}>{title}</b>
      {timer}
    </span>
  );
  return (
    <div
      role={state === "open" ? "alert" : undefined}
      data-state={state}
      className={cx(
        "inline-flex h-10 shrink-0 items-center gap-2 rounded-[20px] pl-[11px]",
        state === "open" && "bg-risk-tint pr-1",
        state === "done" && "bg-good-tint pr-3.5",
        state === "duty" && "bg-sunk pr-3.5 shadow-[inset_0_0_0_1px_var(--riskline)]",
      )}
    >
      {pop ? (
        <Popover content={pop} title={popTitle ?? title} note={popNote} actions={popActions}>
          {label}
        </Popover>
      ) : (
        label
      )}
      {state === "open" ? action : null}
    </div>
  );
}

/**
 * Строка открытого (.strip, «подпись набора»): всё открытое о человеке —
 * сигнал, сообщение, неявка, черновик, назначенная методика, согласие —
 * одной строкой пилюль, у каждой своё действие. Не переносится: лишнее
 * уходит в прокрутку строки, а не во вторую строку.
 */
export function AlertStrip({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  const { ut } = useLang();
  return (
    <div
      role="group"
      aria-label={label ?? ut("kit.openItems")}
      className={cx("flex min-w-0 items-center gap-[5px] overflow-x-auto whitespace-nowrap py-[3px] [scrollbar-width:none]", className)}
    >
      {children}
    </div>
  );
}

/* ─────────── список и запись ─────────── */

/** Маркер группы списка: цвет — причина, слово — рядом в заголовке группы */
export type GroupMark = "risk" | "warn" | "violet" | "info" | "neutral" | "ok";

const markTone: Record<GroupMark, string> = {
  risk: "bg-risk",
  warn: "bg-warn",
  violet: "bg-primary",
  info: "bg-info",
  neutral: "bg-muted",
  ok: "border-[1.5px] border-muted",
};

/** Заголовок группы списка (.pgrp): маркер, подпись, число и пометка справа */
export function ListGroup({
  label,
  count,
  mark = "violet",
  note,
}: {
  label: ReactNode;
  count?: number;
  mark?: GroupMark;
  note?: ReactNode;
}) {
  const lang = useScreenLang();
  return (
    <div className="mt-1.5 flex h-9 w-full items-center gap-2 pl-5 pr-4 text-small font-extrabold text-text">
      <span aria-hidden className={cx("inline-block size-2.5 shrink-0 rounded-[3px]", markTone[mark])} />
      {label}
      {count !== undefined ? (
        <span className="inline-grid h-5 min-w-5 place-items-center rounded-[10px] bg-sunk px-1.5 text-[11.5px] font-bold text-text-2">{grouped(count, lang)}</span>
      ) : null}
      {note ? <span className="ml-auto text-caption font-medium text-muted">{note}</span> : null}
    </div>
  );
}

/**
 * Плитка списка (.prow набора): строка 12 px радиусом, которая говорит,
 * ПОЧЕМУ человек здесь сейчас и ЧТО дальше.
 *
 *   имя и возраст
 *   пилюля причины            мини-курс «PHQ-9 19 → 16 → 14 ↓»
 *   [why — строка пояснения]
 *   ↳ следующий шаг           когда: «сб 10.10, 10:30»
 *
 * Выбранная — тонированная с кольцом, имя фиолетовым 800. Непрочитанное —
 * точка слева. `peek` — поповер «хто це» на наведении и фокусе.
 */
export function ListTile({
  title,
  meta,
  reason,
  aside,
  why,
  next,
  nextIcon,
  when,
  whenToday,
  selected,
  unread,
  to,
  onClick,
  peek,
  peekTitle,
}: {
  /** Имя */
  title: string;
  /** Справа от имени: «38 р.» */
  meta?: ReactNode;
  /** Пилюля причины: <Tag tone="danger" icon={…}>сигнал 2:48 з 4 год</Tag> */
  reason?: ReactNode;
  /** Справа от причины: мини-курс, число */
  aside?: ReactNode;
  /** Строка пояснения: почему сейчас */
  why?: ReactNode;
  /** Следующий шаг: «Розібрати № 214 до 18:12» */
  next?: ReactNode;
  nextIcon?: ReactNode;
  /** Когда: «сб 10.10, 10:30» */
  when?: ReactNode;
  /** Сегодня — когда жирным */
  whenToday?: boolean;
  selected?: boolean;
  unread?: boolean;
  to?: string;
  onClick?: () => void;
  /** Поповер «хто це» */
  peek?: ReactNode;
  peekTitle?: ReactNode;
}) {
  const { ut } = useLang();
  const cls = cx(
    "relative mx-1.5 my-0.5 block cursor-pointer rounded-[12px] pb-[11px] pl-5 pr-2.5 pt-2.5 text-left no-underline outline-offset-[-2px] hover:no-underline",
    "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
    selected ? "bg-violet-tint shadow-[inset_0_0_0_1px_var(--vline)]" : "hover:bg-sunk",
  );
  const body = (
    <>
      {unread ? <span title={ut("kit.unread")} className="absolute left-2 top-[17px] size-[7px] rounded-full bg-primary" /> : null}
      <span className="flex items-baseline gap-2">
        <span
          className={cx(
            "min-w-0 truncate text-[14px] leading-5 tracking-[-0.005em]",
            selected ? "font-extrabold text-violet-ink" : "font-bold text-text",
          )}
        >
          {title}
        </span>
        {meta ? <span className="ml-auto whitespace-nowrap text-small text-muted">{meta}</span> : null}
      </span>
      {reason || aside ? (
        <span className="mt-1.5 flex items-center justify-between gap-1.5">
          {reason}
          {aside}
        </span>
      ) : null}
      {why ? <span className="mt-1.5 block text-caption text-text-2">{why}</span> : null}
      {next || when ? (
        <span className="mt-1.5 flex items-center gap-2.5 text-caption text-text-2">
          {next ? (
            <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
              <span className="inline-flex text-muted [&>svg]:size-[13px]">{nextIcon ?? <Ic.arrowRight />}</span>
              <span className="truncate">{next}</span>
            </span>
          ) : null}
          {when ? (
            <span className={cx("ml-auto whitespace-nowrap", whenToday ? "font-bold text-text" : "text-muted")}>{when}</span>
          ) : null}
        </span>
      ) : null}
    </>
  );
  const node = to ? (
    <Link to={to} className={cls} aria-current={selected ? "page" : undefined} data-row>
      {body}
    </Link>
  ) : (
    <button type="button" className={cx(cls, "w-[calc(100%-12px)] border-0 bg-transparent")} aria-pressed={selected} onClick={onClick} data-row>
      {body}
    </button>
  );
  return peek ? (
    <Popover content={peek} title={peekTitle ?? title} side="right" align="start">
      {node}
    </Popover>
  ) : (
    node
  );
}

/**
 * Ячейка человека (.pc): кружок, имя, строка под ним. В таблицах и списках.
 * `peek` — поповер «хто це» на имени.
 */
export function PersonCell({
  name,
  sub,
  avatar,
  peek,
  peekTitle,
  to,
}: {
  name: string;
  sub?: ReactNode;
  /** <Avatar …/>; без него — только текст */
  avatar?: ReactNode;
  peek?: ReactNode;
  peekTitle?: ReactNode;
  to?: string;
}) {
  const nameNode = to ? (
    <Link to={to} className="truncate font-bold text-text no-underline hover:underline hover:decoration-violet-line hover:decoration-2 hover:underline-offset-[3px]">
      {name}
    </Link>
  ) : (
    <span className="truncate rounded-[4px] font-bold text-text">{name}</span>
  );
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {avatar}
      <span className="flex min-w-0 flex-col">
        <b className="block min-w-0 truncate text-body leading-[18px]">
          {peek ? (
            <Popover content={peek} title={peekTitle ?? name}>
              {nameNode}
            </Popover>
          ) : (
            nameNode
          )}
        </b>
        {sub ? <small className="truncate text-caption text-muted">{sub}</small> : null}
      </span>
    </span>
  );
}

/** Пары «ключ — значение» (.kv): подпись 12.5/700 приглушённым, значение — чернилами */
export function KV({ rows, w = 120, className }: { rows: [ReactNode, ReactNode][]; w?: number; className?: string }) {
  return (
    <dl
      className={cx("m-0 grid gap-x-3 gap-y-1.5 text-small", className)}
      style={{ gridTemplateColumns: `${w}px minmax(0,1fr)` }}
    >
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="font-bold text-muted">{k}</dt>
          <dd className="m-0 text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Тон строки хронологии: риск — только для человека, внимание — неявка, просрочка; сделано */
export type ActivityTone = "risk" | "warn" | "good" | "neutral";

export interface ActivityEvent {
  /** «25.09» */
  date: ReactNode;
  /** «14:12» — приглушённо рядом с датой */
  time?: ReactNode;
  icon: ReactNode;
  /** Текст: жирное начало («Сигнал № 214») и пояснение */
  text: ReactNode;
  tone?: ActivityTone;
  /** Действие справа: ссылка-кнопка «Розібрати» */
  action?: ReactNode;
}

/**
 * Хронология (.ev набора): дата, квадрат значка 28, текст и действие.
 * Красным — только сигнал, янтарём — неявка и просрочка, зелёным — сделано.
 */
export function ActivityList({ events, className }: { events: ActivityEvent[]; className?: string }) {
  return (
    <ol className={cx("m-0 list-none p-0", className)}>
      {events.map((e, i) => (
        <li
          key={i}
          className="grid min-h-[46px] grid-cols-[88px_28px_minmax(0,1fr)_auto] items-center gap-x-2 border-t border-divider py-1.5 pl-4 pr-3 text-[13px] leading-[18px]"
        >
          <span className="whitespace-nowrap font-bold text-text-2">
            {e.date}
            {e.time ? <small className="ml-1 text-caption font-medium text-muted">{e.time}</small> : null}
          </span>
          <IconTile
            icon={e.icon}
            size={28}
            tone={e.tone === "risk" ? "risk" : e.tone === "warn" ? "warn" : e.tone === "good" ? "good" : "neutral"}
          />
          <span
            className={cx(
              "min-w-0 text-text [&_b]:font-bold",
              e.tone === "risk" && "[&_b]:font-extrabold [&_b]:text-risk-ink",
              e.tone === "warn" && "[&_b]:text-warn",
            )}
          >
            {e.text}
          </span>
          {e.action ?? <span />}
        </li>
      ))}
    </ol>
  );
}

/** Ссылка-действие строки хронологии и шапки панели: «Хронологія», «Розібрати» */
export function TextAction({ children, onClick, to }: { children: ReactNode; onClick?: () => void; to?: string }) {
  const cls = buttonClass("ghost", "xs", "font-bold");
  return to ? (
    <Link to={to} className={cls}>
      {children}
    </Link>
  ) : (
    <button type="button" className={cls} onClick={onClick}>
      {children}
    </button>
  );
}
