import type { ReactNode } from "react";
import { cx } from "./cx";
import { Ic } from "./icons";
import { IconTile } from "./layout";
import { Button } from "./primitives";
import { useLang } from "../lang";

/*
 * Состояния места данных в наборе «Виразна»: загрузка, пусто, отказ,
 * заметка. Порядок и смысл состояний — в ui/index.tsx (loadView): здесь
 * только то, как каждое выглядит.
 */

/* полоска скелета: залитая sunk2, дышит, а не бежит бликом — блик тянет взгляд */
const bar = "skeleton block rounded-[6px] bg-sunk-2 animate-[kit-breathe_1.2s_ease-in-out_infinite_alternate]";

/**
 * Скелет вместо строки «Завантаження…»: держит место и форму будущего
 * содержимого, и экран не прыгает, когда данные приезжают.
 */
export function Skeleton({
  lines = 3,
  height = 12,
  width = "100%",
}: {
  lines?: number;
  height?: number;
  width?: string;
}) {
  return (
    <div className="grid gap-2.5" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          className={bar}
          // последняя строка короче: так блок читается как текст, а не как таблица
          style={{ height, width: i === lines - 1 ? "62%" : width }}
        />
      ))}
    </div>
  );
}

/** Строки скелета списка (.skr набора): квадрат 32 и две полоски разной длины */
export function SkeletonRows({ rows = 3, avatar = true }: { rows?: number; avatar?: boolean }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-t border-divider px-4 py-3 first:border-t-0">
          {avatar ? <span className={cx(bar, "size-8 shrink-0 rounded-control")} /> : null}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className={cx(bar, "h-4")} style={{ width: `${38 + ((i * 13) % 30)}%` }} />
            <span className={bar} style={{ height: 12, width: `${62 + ((i * 17) % 28)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Загрузка или отказ на месте данных.
 *
 * Отказ обязан давать выход: «Спробувати ще раз», если есть чем повторить.
 * Отказ — role="alert", загрузка — role="status" с aria-busy: иначе диктор
 * читает пустую страницу и не узнаёт, когда содержимое приехало.
 */
export function Loading({
  rows = 4,
  error,
  onRetry,
  busy,
  title,
}: {
  rows?: number;
  error?: string | null;
  /** Повторить запрос; без него экран, который не загрузился, — тупик */
  onRetry?: () => void;
  busy?: boolean;
  /** Заголовок отказа: «Не вдалося завантажити заміри» */
  title?: string;
}) {
  const { ut } = useLang();
  if (error) {
    return (
      <div
        role="alert"
        className="flex flex-col items-center rounded-panel border border-border bg-panel px-6 pb-11 pt-10 text-center"
      >
        <IconTile icon={<Ic.cloudOff />} tone="warn" size={48} />
        {/* не заголовок: состояние встаёт где угодно, и h3 под h1 ломал бы порядок заголовков */}
        {title ? <p className="m-0 mt-3.5 text-[16px] font-extrabold leading-[22px] text-text">{title}</p> : null}
        <p className={cx("m-0 max-w-[420px] text-body text-text-2", title ? "mt-1.5" : "mt-3.5")}>{error}</p>
        {onRetry ? (
          <Button type="button" className="mt-4" icon={<Ic.refresh />} disabled={busy} onClick={onRetry}>
            {ut("common.retry")}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div role="status" aria-busy="true" className="rounded-panel border border-border bg-panel pt-3">
      <div className="px-4 pb-1">
        <span className={cx(bar, "h-4")} style={{ width: "38%" }} />
      </div>
      <SkeletonRows rows={rows} />
    </div>
  );
}

/**
 * Пустое состояние (.estate набора): квадрат значка 48, заголовок 16/800,
 * одна фраза о том, что сделать, и действия.
 *
 * `compact` — пусто не на экране, а в одной его панели или строке: тогда это
 * подробность, а не ответ на вопрос, и рисуется одной приглушённой строкой.
 * Классы `empty` / `is-compact` — опора для смоук-тестов, оформления у них нет.
 */
export function Empty({
  title,
  hint,
  action,
  compact,
  icon,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  /** Значок в квадрате; по умолчанию — входящие */
  icon?: ReactNode;
}) {
  if (compact) {
    return (
      <div className="empty is-compact py-3 text-small text-muted">
        <span className="font-semibold text-text-2">{title}</span>
        {hint ? <span className="block">{hint}</span> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    );
  }
  return (
    <div className="empty flex flex-col items-center px-6 pb-11 pt-10 text-center">
      <IconTile icon={icon ?? <Ic.inbox />} size={48} />
      <p className="m-0 mt-3.5 text-[16px] font-extrabold leading-[22px] tracking-[-0.01em] text-text">{title}</p>
      {hint ? <p className="m-0 mt-1.5 max-w-[420px] text-body text-text-2">{hint}</p> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/** Тон заметки: нейтральная, «ваше», сведения, внимание, риск, сделано, контур */
export type CalloutKind = "neutral" | "violet" | "info" | "warn" | "risk" | "good" | "line";

const calloutTone: Record<CalloutKind, { box: string; ink: string }> = {
  neutral: { box: "bg-sunk", ink: "text-violet-ink" },
  violet: { box: "bg-violet-tint", ink: "text-violet-ink" },
  info: { box: "bg-info-tint", ink: "text-info" },
  warn: { box: "bg-warn-tint", ink: "text-warn" },
  risk: { box: "bg-risk-tint", ink: "text-risk-ink" },
  good: { box: "bg-good-tint", ink: "text-good" },
  line: { box: "bg-transparent shadow-[inset_0_0_0_1.5px_var(--ctl)]", ink: "text-violet-ink" },
};

const calloutIcon: Record<CalloutKind, ReactNode> = {
  neutral: <Ic.info />,
  violet: <Ic.sparkle />,
  info: <Ic.info />,
  warn: <Ic.circleAlert />,
  risk: <Ic.alert />,
  good: <Ic.circleCheck />,
  line: <Ic.info />,
};

/**
 * Заметка на тонированной плашке (.callout набора): значок, жирный
 * заголовок тоном вида, текст text-2 и действия.
 *
 * `risk` — только риск для человека. `warn` — внимание (просрочено, неявка,
 * ограничение доступа). `good` — сделано. Отказ формы — не заметка, а
 * ErrorText под полем.
 */
export function Callout({
  kind = "neutral",
  title,
  children,
  icon,
  actions,
  className,
  role,
}: {
  kind?: CalloutKind;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** "status" или "alert", когда заметка появляется в ответ на действие */
  role?: "status" | "alert" | "note";
}) {
  const tone = calloutTone[kind];
  return (
    <div
      role={role}
      className={cx("flex gap-2.5 rounded-panel px-3.5 py-3 text-small text-text-2", tone.box, className)}
    >
      <span className={cx("mt-px inline-flex shrink-0 [&>svg]:size-4", tone.ink)} aria-hidden>
        {icon ?? calloutIcon[kind]}
      </span>
      <div className="min-w-0 flex-1">
        {title ? <b className={cx("block text-body font-extrabold", kind === "neutral" || kind === "violet" || kind === "line" ? "text-text" : tone.ink)}>{title}</b> : null}
        {children}
        {actions ? <div className="mt-2.5 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
