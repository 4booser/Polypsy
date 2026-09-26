import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { locale } from "../../format";
import { useLang } from "../../lang";
import { useToast } from "../../ui";
import { cx } from "../../ui/cx";
import { IconCopy } from "../../ui/glyphs";
import { type Resource, useResource } from "../../useResource";
import { fill } from "../dashboard/model";
import { clock, shortId } from "./model";

/**
 * Общие части вкладок техпанели: опрос с отметкой времени, строка «с момента
 * запуска», таблица на сетке, номер запроса с копированием, метка статуса.
 *
 * Таблица — сетка строк с ролями table/row/cell, а не <table>: голый <table>
 * подхватывает правила наследия (legacy.css — капитель заголовков, липкая
 * шапка, высота строки из токена плотности), и перебивать их пришлось бы по
 * одному свойству. Строки сеткой — тот же приём, что у списков макета.
 */

/**
 * Опрос раз в `pollMs` и момент последнего пришедшего ответа.
 *
 * Сам опрос — в useResource: он же не опрашивает скрытую вкладку браузера и
 * гасит таймер, когда вкладку панели закрыли (компонент размонтирован), —
 * то есть «ушёл со вкладки — опрос встал» выполняется устройством, а не
 * памятью автора экрана.
 */
export function useOpsResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
  pollMs: number,
): Resource<T> & { updatedAt: number | null } {
  const res = useResource(load, deps, { pollMs });
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  useEffect(() => {
    if (res.data !== null) setUpdatedAt(Date.now());
  }, [res.data]);
  return { ...res, updatedAt };
}

/**
 * «Дані з моменту запуску процесу…» и «оновлено о …».
 *
 * Первая половина обязательна на каждой вкладке с памятью процесса: пустые
 * ошибки и тихий график после перезапуска выглядят как «всё хорошо», хотя
 * значат «ничего не помню». `since` не передан — у вкладки нет памяти
 * процесса (база отвечает о своём состоянии сейчас), и сказано это другими
 * словами.
 */
export function Stamp({ since, updatedAt, note }: { since?: string; updatedAt: number | null; note?: ReactNode }) {
  const { ut } = useLang();
  const loc = locale();
  return (
    <div className="mb-[4px] flex flex-wrap items-baseline justify-between gap-x-[24px] gap-y-[4px] pt-[20px] text-[13px] leading-[18px] text-muted">
      <span className="min-w-0">
        {since ? fill(ut("ops.since"), { time: `${new Date(since).toLocaleDateString(loc, { day: "numeric", month: "long" })} ${clock(since, loc)}` }) : note}
      </span>
      {updatedAt !== null ? (
        <span role="status" className="shrink-0 font-mono tabular-nums">
          {fill(ut("ops.updated"), { time: clock(updatedAt, loc) })}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Номер запроса: укороченный на экране, целиком — в подсказке и в буфере обмена.
 *
 * Ведёт в трассу запроса (/ops/trace/:id, участок obs2a), а не в ленту с
 * фильтром: трасса — это те же строки лога плюс итог, ошибка, журнал и SQL,
 * то есть всё, ради чего номер нажимают.
 */
export function RequestId({ id, linked = true }: { id: string | null; linked?: boolean }) {
  const { ut } = useLang();
  const toast = useToast();
  if (!id) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-[6px]">
      {linked ? (
        <Link
          to={`/ops/trace/${encodeURIComponent(id)}`}
          title={`${id} — ${ut("ops.trace.open")}`}
          className="truncate font-mono text-[12px] text-primary no-underline hover:underline"
        >
          {shortId(id)}
        </Link>
      ) : (
        <span title={id} className="truncate font-mono text-[12px] text-text-2">
          {shortId(id)}
        </span>
      )}
      <button
        type="button"
        aria-label={ut("ops.copyId")}
        title={ut("ops.copyId")}
        onClick={() => {
          void navigator.clipboard?.writeText(id).then(
            () => toast(ut("ops.idCopied"), "ok"),
            () => toast(ut("ops.copyFailed"), "err"),
          );
        }}
        className={cx(
          "relative inline-flex size-[20px] shrink-0 items-center justify-center rounded-[4px] border-0 bg-transparent p-0 text-[14px] text-muted",
          "hover:bg-primary-soft hover:text-primary",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
          /* видимый квадрат 20, нажимается 44 — как у глифов макета */
          "after:absolute after:left-1/2 after:top-1/2 after:size-[44px] after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
        )}
      >
        <IconCopy />
      </button>
    </span>
  );
}

export type Tone = "ok" | "warn" | "fail" | "quiet";

/*
 * Форма точки несёт то же, что цвет, — как у SeverityTag: круг — порядок,
 * квадрат — предупреждение, ромб — сбой. Янтарь — только у предупреждения и
 * сбоя: он значит «требует внимания», и «гаразд» им не красится.
 */
const DOT: Record<Tone, string> = {
  ok: "rounded-full bg-primary",
  warn: "bg-accent",
  fail: "rotate-45 bg-accent",
  quiet: "rounded-full bg-[var(--grid)]",
};
const WORD: Record<Tone, string> = {
  ok: "text-primary",
  warn: "text-accent",
  fail: "font-bold text-accent",
  quiet: "text-muted",
};

/** Статус словом и формой точки */
export function StatusMark({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-[6px] whitespace-nowrap text-[13px] leading-[17px]", WORD[tone])}>
      <span aria-hidden className={cx("inline-block size-[8px] shrink-0", DOT[tone])} />
      {children}
    </span>
  );
}

/** Таблица-сетка: шапка и строки с одним шаблоном колонок; широкая — прокручивается внутри себя */
export function GridTable({
  label,
  cols,
  minW,
  head,
  children,
}: {
  label: string;
  /** Литерал `grid-cols-[…]`: Tailwind собирает классы, читая исходник */
  cols: string;
  /** Литерал `min-w-[…]` — ниже этой ширины таблица прокручивается, а страница нет */
  minW: string;
  head: readonly ReactNode[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <div role="table" aria-label={label} className={minW}>
        <div role="row" className={cx("grid items-end gap-x-[16px] border-b border-hairline pb-[6px]", cols)}>
          {head.map((h, i) => (
            <span key={i} role="columnheader" className="min-w-0 text-[13px] font-bold leading-[16px] text-muted">
              {h}
            </span>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}

export function GridRow({ cols, children, className }: { cols: string; children: ReactNode; className?: string }) {
  return (
    <div
      role="row"
      className={cx("grid min-h-[40px] items-center gap-x-[16px] border-b border-hairline py-[6px] text-[13px] leading-[18px]", cols, className)}
    >
      {children}
    </div>
  );
}

export function Cell({ children, num, className }: { children?: ReactNode; num?: boolean; className?: string }) {
  return (
    <span role="cell" className={cx("min-w-0", num && "text-right font-mono tabular-nums", className)}>
      {children}
    </span>
  );
}

/** Шапка числовой колонки — по правому краю, как сами числа */
export const NumHead = ({ children }: { children: ReactNode }) => <span className="block text-right">{children}</span>;

/** Подпись и значение столбцом: сборка, сведения о базе */
export function Facts({ items }: { items: readonly (readonly [ReactNode, ReactNode])[] }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(0,200px)_minmax(0,1fr)] gap-x-[24px] max-[600px]:grid-cols-1">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="flex min-h-[36px] items-center border-b border-hairline text-[13px] font-bold text-muted max-[600px]:min-h-0 max-[600px]:border-0 max-[600px]:pt-[8px]">
            {k}
          </dt>
          <dd className="m-0 flex min-h-[36px] min-w-0 items-center border-b border-hairline text-[13px] text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Пусто — строкой, как у списков макета, а не плашкой */
export function Quiet({ children }: { children: ReactNode }) {
  return <p className="m-0 py-[12px] text-[13px] leading-[18px] text-muted">{children}</p>;
}
