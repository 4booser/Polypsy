import { Fragment, type ReactNode } from "react";
import type { SuspiciousRule } from "@quizzy/shared";
import { cx } from "../../../ui/cx";
import { Ic, type IconProps } from "../../../ui/icons";
import { Tag } from "../../../ui/primitives";
import { Ix, makeIcon } from "./icons";

/*
 * Детали экранов безопасности техпанели в «Виразній»: значки, которых нет в
 * наборе и в общих значках участка, код права пилюлей, полоска срока и
 * доли. Пилюля роли — общая с реестром (users/parts.tsx, RolePill).
 */

const FILE = "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z";
const FOLD = "M14 2v4a2 2 0 0 0 2 2h4";

export const Sx = {
  files: makeIcon(<><path d="M20 7h-3a2 2 0 0 1-2-2V2" /><path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z" /><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8" /></>),
  fileDown: makeIcon(<><path d={FILE} /><path d={FOLD} /><path d="M12 18v-6" /><path d="m9 15 3 3 3-3" /></>),
  fileSearch2: makeIcon(<><path d={FILE} /><path d={FOLD} /><circle cx="11.5" cy="14.5" r="2.5" /><path d="M13.3 16.3 15 18" /></>),
  globeLock: makeIcon(<><path d="M15.686 15A14.5 14.5 0 0 1 12 22a14.5 14.5 0 0 1 0-20 10 10 0 1 0 9.542 13" /><path d="M2 12h8.5" /><path d="M20 6V4a2 2 0 1 0-4 0v2" /><rect width="8" height="5" x="14" y="6" rx="1" /></>),
  radar: makeIcon(<><path d="M19.07 4.93A10 10 0 0 0 6.99 3.34" /><path d="M4 6h.01" /><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35" /><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67" /><path d="M12 18h.01" /><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67" /><circle cx="12" cy="12" r="2" /><path d="m13.41 10.59 5.66-5.66" /></>),
  calendarCheck: makeIcon(<><path d="M8 2v4" /><path d="M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" /><path d="m9 16 2 2 4-4" /></>),
  printer: makeIcon(<><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" /><rect x="6" y="14" width="12" height="8" rx="1" /></>),
  circleUser: makeIcon(<><path d="M18 20a6 6 0 0 0-12 0" /><circle cx="12" cy="10" r="4" /><circle cx="12" cy="12" r="10" /></>),
  smartphoneNfc: makeIcon(<><rect width="7" height="12" x="2" y="6" rx="1" /><path d="M13 8.32a7.43 7.43 0 0 1 0 7.36" /><path d="M16.46 6.21a11.76 11.76 0 0 1 0 11.58" /><path d="M19.91 4.1a15.91 15.91 0 0 1 .01 15.8" /></>),
  chevronsDown: makeIcon(<><path d="m7 6 5 5 5-5" /><path d="m7 13 5 5 5-5" /></>),
  circleDot: makeIcon(<><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="1" /></>),
  chartPie: makeIcon(<><path d="M21 12c.552 0 1.005-.449.95-.998a10 10 0 0 0-8.953-8.951c-.55-.055-.998.398-.998.95v8a1 1 0 0 0 1 1z" /><path d="M21.21 15.89A10 10 0 1 1 8 2.83" /></>),
  chartBar: makeIcon(<><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="M7 16h8" /><path d="M7 11h12" /><path d="M7 6h3" /></>),
  undo: makeIcon(<><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" /></>),
};

/** Значок правила — тот же в карточке срабатывания, в списке разобранных и в «Як працюють правила» */
export const RULE_ICON: Record<SuspiciousRule, (p: IconProps) => ReactNode> = {
  failedLoginsAccount: Ix.keyRound,
  failedLoginsIp: Sx.globeLock,
  newDevice: Ix.monitorSmartphone,
  massReads: Sx.files,
  nightActivity: Ix.moon,
  namedExport: Sx.fileDown,
  impersonation: Ix.venetianMask,
};

/** Код права или адрес — моноширинной пилюлей (.cd набора): его ищут буква в букву */
export function CodeChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cx(
        "inline-flex h-5 items-center whitespace-nowrap rounded-[6px] bg-sunk px-1.5 align-middle font-mono text-[11.5px] font-semibold leading-none text-text-2",
        className,
      )}
    >
      {children}
    </code>
  );
}

/** Пилюля факта: нейтральная или янтарная (сверх порога), со значком; адрес — моноширинным */
export function FactChip({ children, tone, icon, mono }: { children: ReactNode; tone?: "warn"; icon?: ReactNode; mono?: boolean }) {
  return (
    <Tag tone={tone === "warn" ? "attention" : "plain"} icon={icon} className={mono ? "font-mono font-semibold" : undefined}>
      {children}
    </Tag>
  );
}

/**
 * Полоска доли (.pbar набора): дорожка и заливка. `thin` — 4 px под сроком
 * в строке таблицы; тон — фиолетовый, янтарь (внимание) или зелёный (полностью).
 */
export function Meter({
  pct,
  tone = "plain",
  thin,
  label,
  className,
}: {
  pct: number;
  tone?: "plain" | "warn" | "good";
  thin?: boolean;
  /** Подпись для диктора: «минуло 96 % строку» */
  label?: string;
  className?: string;
}) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx("relative block overflow-hidden bg-track", thin ? "h-1 rounded-[2px]" : "h-2 rounded-[4px]", className)}
    >
      <i
        className={cx(
          "absolute inset-y-0 left-0",
          thin ? "rounded-[2px]" : "rounded-[4px]",
          tone === "warn" ? "bg-warn" : tone === "good" ? "bg-good" : "bg-violet",
        )}
        style={{ width: `${w}%` }}
      />
    </span>
  );
}

/**
 * Фраза словаря с подстановками-разметкой: «Дій — {total}, співробітників —
 * {staff}» с жирными числами и поповерами. Подстановка без значения
 * остаётся как есть — её видно и в проверке, и на экране.
 */
export function Rich({ text, values }: { text: string; values: Record<string, ReactNode> }) {
  const parts = text.split(/(\{\w+\})/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\{(\w+)\}$/.exec(p);
        const key = m?.[1];
        if (key && key in values) return <Fragment key={i}>{values[key]}</Fragment>;
        return p ? <Fragment key={i}>{p}</Fragment> : null;
      })}
    </>
  );
}

/** Строка пояснения со значком «і» под панелью или таблицей (.pfx набора) */
export function FootNote({ children, quiet, className }: { children: ReactNode; quiet?: boolean; className?: string }) {
  return (
    <p className={cx("m-0 flex items-start gap-2", quiet ? "text-caption text-muted" : "text-small text-text-2", className)}>
      <span className="mt-px inline-flex shrink-0 text-muted" aria-hidden>
        <Ic.info size={15} />
      </span>
      <span className="min-w-0">{children}</span>
    </p>
  );
}
