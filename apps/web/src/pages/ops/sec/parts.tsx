import { type ReactNode, useState } from "react";
import { useLang } from "../../../lang";
import { useToast } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Button } from "../../../ui/primitives";
import { OpsIcon, type OpsIconName } from "../icons";
import type { CheckDay, CheckDayState } from "./model";

/*
 * Общие куски трёх разделов безопасности техпанели («Ключі й секрети»,
 * «Цілісність», «SQL (читання)») в «Виразній»: подпись колонки, пояснение,
 * итог проверки плашкой со значком, полоса сверок по дням, команды для
 * сервера с копированием. Таблицы — по строке набора (.dtbl): шапка 38 на
 * подложке, строки через волосяную линию.
 */
export const TH =
  "h-[38px] whitespace-nowrap border-y border-divider bg-panel-2 px-2.5 text-left align-middle text-caption font-bold leading-none text-muted first:pl-4 last:pr-4";
export const TD = "border-b border-divider px-2.5 py-2 align-middle text-body leading-[19px] text-text first:pl-4 last:pr-4";
export const NUM = "text-right tabular-nums";

/** Подпись: 12/700 приглушённым — над значением, над списком */
export function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("text-caption font-bold leading-4 text-muted", className)}>{children}</div>;
}

/** Пояснение раздела: 13/400, ширина строки — для чтения, а не во всю колонку */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("m-0 max-w-[760px] text-[13px] leading-[19px] text-text-2", className)}>{children}</p>;
}

/**
 * Итог проверки словами — плашкой со значком (.gbox набора). `plain` —
 * норма, зелёная плашка с галочкой; `attention` — «требует внимания»,
 * янтарём; `danger` — поломка (потеря данных, политики не действуют,
 * разрыв цепочки): тоже янтарём, но значок сбоя и жирный заголовок — в
 * техпанели красный остаётся за риском для человека.
 */
export function Verdict({
  tone,
  title,
  children,
  className,
  icon,
  aside,
}: {
  tone: "plain" | "attention" | "danger";
  /** Заголовок плашки: «Політики діють», «Ланцюжок цілий» */
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  icon?: OpsIconName;
  aside?: ReactNode;
}) {
  const glyph: OpsIconName = icon ?? (tone === "plain" ? "circle-check" : tone === "danger" ? "octagon-x" : "triangle-alert");
  return (
    <div
      role={tone === "plain" ? undefined : "alert"}
      className={cx(
        "flex items-start gap-3.5 rounded-panel px-4 py-3.5",
        tone === "plain" ? "bg-good-tint" : "bg-warn-tint",
        className,
      )}
    >
      <span
        aria-hidden
        className={cx(
          "grid size-10 shrink-0 place-items-center rounded-[12px] bg-panel",
          tone === "plain" ? "text-good" : "text-warn",
        )}
      >
        <OpsIcon name={glyph} size={19} />
      </span>
      <div className="min-w-0 flex-1">
        {title ? (
          <b className={cx("block text-[15px] font-extrabold leading-5", tone === "plain" ? "text-good" : "text-warn")}>{title}</b>
        ) : null}
        {children ? (
          <div className={cx("text-[13px] leading-[19px] text-text", title ? "mt-0.5" : tone === "danger" && "font-bold")}>{children}</div>
        ) : null}
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </div>
  );
}

/** Таблица/колонка/ключ пилюлей моноширинно: «users.full_name» */
export function CodeChip({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "warn" | "good" }) {
  return (
    <span
      className={cx(
        "inline-flex h-6 items-center rounded-[7px] px-2 font-mono text-[11.5px] font-semibold",
        tone === "warn" ? "bg-warn-tint-2 text-warn" : tone === "good" ? "bg-good-tint text-good" : "bg-sunk text-text-2",
      )}
    >
      {children}
    </span>
  );
}

/* ─────────── сверки по дням (волна 11) ─────────── */

/*
 * Клетка дня — формой значка и цветом сразу: цела — галочка на зелёной
 * подложке, разрыв — разорванное звено янтарём, не сверяли — черта в
 * контуре. Форма читается и без цвета — в печати и при любом виде
 * дальтонизма.
 */
const CELL: Record<CheckDayState, string> = {
  ok: "bg-good-tint text-good",
  broken: "bg-warn-tint-2 text-warn",
  none: "bg-transparent text-muted shadow-[inset_0_0_0_1px_var(--ctl)]",
};
const CELL_ICON: Record<CheckDayState, OpsIconName> = { ok: "check", broken: "link-2-off", none: "minus" };

export function StripMark({ state }: { state: CheckDayState }) {
  return (
    <span aria-hidden className={cx("inline-grid size-4 shrink-0 place-items-center rounded-[5px]", CELL[state])}>
      <OpsIcon name={CELL_ICON[state]} size={11} />
    </span>
  );
}

/**
 * Полоса дней: по клетке на день окна, в клетке — итог сверок того дня.
 *
 * Не столбцы и не линия: у сверки нет величины, есть «цела / разрыв / не
 * сверяли», и высота столбца тут означала бы число нажатий кнопки — не то,
 * о чём спрашивают. Подпись для диктора — счёт дней по итогам и края
 * окна; у клетки — подсказка с датой и словом, а легенда словами с тем же
 * счётом стоит над полосой.
 */
export function CheckStrip({
  days,
  label,
  words,
  dayLabel,
}: {
  days: readonly CheckDay[];
  label: string;
  words: Record<CheckDayState, string>;
  dayLabel: (key: string) => string;
}) {
  if (!days.length) return null;
  const count = (s: CheckDayState) => days.filter((d) => d.state === s).length;
  const order: CheckDayState[] = ["ok", "none", "broken"];
  const first = dayLabel(days[0]!.key);
  const last = dayLabel(days.at(-1)!.key);
  /* подписи под полосой — раз в неделю, считая от последнего дня */
  const ticks = new Set(days.map((_, i) => i).filter((i) => (days.length - 1 - i) % 7 === 0));
  return (
    <div>
      <ul className="m-0 mb-2.5 flex list-none flex-wrap justify-end gap-x-4 gap-y-1 p-0 text-small text-text-2">
        {order.map((s) => (
          <li key={s} className={cx("flex items-center gap-1.5", s === "broken" && count(s) ? "font-bold text-warn" : undefined)}>
            <StripMark state={s} />
            {words[s]}
            <span className="tabular-nums text-muted">{count(s)}</span>
          </li>
        ))}
      </ul>
      <ol
        role="img"
        aria-label={`${label}: ${first} — ${last}; ${order.map((s) => `${words[s]} ${count(s)}`).join(", ")}`}
        className="m-0 flex list-none gap-[3px] p-0"
      >
        {days.map((d) => (
          <li
            key={d.key}
            title={`${dayLabel(d.key)}: ${words[d.state]}${d.ok + d.broken > 1 ? ` (${d.ok + d.broken})` : ""}`}
            className={cx("grid h-[30px] min-w-0 flex-1 place-items-center rounded-[7px]", CELL[d.state])}
          >
            <OpsIcon name={CELL_ICON[d.state]} size={14} />
          </li>
        ))}
      </ol>
      <ol aria-hidden className="m-0 mt-1.5 flex list-none gap-[3px] p-0 text-micro font-semibold text-muted">
        {days.map((d, i) => (
          <li key={d.key} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
            {ticks.has(i) ? dayLabel(d.key) : ""}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Команды для сервера: моноширинный блок на подложке, с копированием */
export function Commands({ children, title }: { children: string; title?: ReactNode }) {
  const { ut } = useLang();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-2">
      <div className="mb-1.5 flex items-center gap-2">
        {title ? <Caption>{title}</Caption> : null}
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          icon={<OpsIcon name="copy" />}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void navigator.clipboard
              ?.writeText(children)
              .then(
                () => toast(ut("opx.sc.copied"), "ok"),
                () => toast(ut("ops.copyFailed"), "err"),
              )
              .finally(() => setBusy(false));
          }}
        >
          {ut("opx.er.copy")}
        </Button>
      </div>
      <pre className="m-0 overflow-x-auto whitespace-pre rounded-control bg-sunk px-3 py-2.5 font-mono text-[12px] font-medium leading-[18px] text-text shadow-[inset_0_0_0_1px_var(--divider)]">
        {children}
      </pre>
    </div>
  );
}

/** «лише суперадміністратор» — пометка в шапке разделов безопасности */
export function SuperOnly() {
  const { ut } = useLang();
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] text-muted">
      <OpsIcon name="shield-check" size={13} />
      {ut("opx.sc.superOnly")}
    </span>
  );
}
