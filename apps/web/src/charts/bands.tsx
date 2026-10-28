import { useLang } from "../lang";
import { labelColumn, stackBlocks, wrapWords, type Cutoff } from "./courseModel";
import type { Rung } from "./ladder";
import { textWidth } from "./kit";

/**
 * Поле полос тяжести с подписями — общее у графика курса (course.tsx) и
 * динамики средних по лестнице (BandTrend в clinical.tsx).
 *
 * Подпись полосы — главное, что есть на таком графике: «в какой полосе
 * человек (группа) сейчас и что выше и ниже». Прежде колонка подписей была
 * не шире трети графика, и длинное название резалось многоточием
 * («Депресія умеренной тяжес…»), а на узком графике подписи пропадали
 * вовсе. Здесь подпись переносится по словам и не режется никогда:
 *
 *   — колонка справа не шире 34 % графика (у малого — 42 %) и не уже
 *     самого длинного слова; строк — сколько даёт самая широкая колонка;
 *   — поле растёт, пока каждая подпись не встанет в свою полосу (fitHeight);
 *   — подписи, которые всё же налезают, раздвигаются, а ушедшая со своей
 *     полосы встаёт на подложку с выноской к полосе;
 *   — поле уже 150 px — колонки нет, подписи строками под графиком (BandKey).
 *
 * Клинический порог (cutoffOf) — плашкой в той же колонке, у конца своего
 * пунктира.
 */

/** Строка подписи полосы: 11,5 px */
export const LH = 14;
export const LABEL_SIZE = 11.5;
/** Ширина подписи — по жирному начертанию: перенос не зависит от того, текущая ли полоса */
export const labelWidth = (s: string) => textWidth(s, LABEL_SIZE, 800);

export interface BandColumn {
  /** Колонка справа есть; нет — подписи строками под графиком */
  withCol: boolean;
  colW: number;
  /** Левый край колонки */
  colX: number;
  /** Правый край поля данных */
  plotR: number;
  /** Переносы подписи каждой полосы */
  wrapped: Map<Rung, string[]>;
}

/**
 * Колонка подписей: ширина и переносы. `L` — левое поле (подписи делений),
 * `R` — правое; данным остаётся всё между ними, кроме колонки и зазора.
 */
export function planBandColumn({
  ladder,
  W,
  L,
  R,
  compact,
  bandText,
  extra = [],
}: {
  ladder: readonly Rung[];
  W: number;
  L: number;
  R: number;
  compact: boolean;
  bandText: (r: Rung) => string;
  /** Ещё подписи той же колонки: клинический порог */
  extra?: readonly string[];
}): BandColumn {
  const colMax = Math.min(Math.round(W * (compact ? 0.42 : 0.34)), 210);
  const wanted = ladder.length ? labelColumn([...ladder.map(bandText), ...extra], labelWidth, 84, colMax, 2) : 0;
  /* поле уже 150 px не читается: подписи полос тогда уходят под график строками */
  const withCol = ladder.length > 0 && W - R - wanted - 12 - L >= 150;
  const colW = withCol ? wanted : 0;
  const colX = W - R - colW;
  return {
    withCol,
    colW,
    colX,
    plotR: withCol ? colX - 12 : W - R,
    wrapped: new Map(ladder.map((r) => [r, withCol ? wrapWords(bandText(r), colW, labelWidth) : []] as const)),
  };
}

/**
 * Высота поля, при которой каждая подпись встаёт в свою полосу: полоса —
 * доля шкалы, и узкая полоса с подписью в три строки требует поля выше.
 * Не ниже `base` и не выше `cap`.
 */
export function fitHeight({
  spans,
  col,
  lo,
  hi,
  cutoff,
  base,
  cap,
}: {
  spans: readonly { rung: Rung; from: number; to: number }[];
  col: BandColumn;
  lo: number;
  hi: number;
  cutoff: Cutoff | null;
  base: number;
  cap: number;
}): number {
  if (!col.withCol) return base;
  /*
   * Полоса из одного значения среди обычных высоту получает сама (bandY,
   * не ниже своей подписи) — ради неё поле не растёт: иначе шесть пикселей
   * «20» на шкале 5–35 требовали бы поля в полэкрана.
   */
  const mixed = spans.some((s) => s.rung.min !== s.rung.max);
  const needs = spans.map((s) => {
    if (mixed && s.rung.min === s.rung.max) return base;
    const share = (s.to - s.from) / (hi - lo);
    /* порог у границы полосы занимает пол-строки её места */
    const tag = cutoff && (Math.abs(s.from - cutoff.at) < 1e-9 || Math.abs(s.to - cutoff.at) < 1e-9) ? LH / 2 + 2 : 0;
    return share > 0 ? ((col.wrapped.get(s.rung)?.length ?? 1) * LH + 6 + tag) / share : base;
  });
  return Math.round(Math.min(cap, Math.max(base, ...needs)));
}

/** Наименьшая высота полосы из одного значения — по её подписи (bandY); без колонки — строка */
export function bandMinPx(col: BandColumn): (rung: Rung) => number {
  return (rung) => (col.withCol ? Math.max(LH, (col.wrapped.get(rung)?.length ?? 1) * LH) + 4 : 12);
}

export interface LabelBlock {
  key: string;
  kind: "band" | "cutoff";
  lines: string[];
  /** Первая строка начинается с границ полосы — их рисуем приглушённо */
  range: string | null;
  want: number;
  h: number;
  current: boolean;
  /** Полоса блока на оси: верх и низ в пикселях — ушедший с неё блок соединяется с ней выноской */
  top: number;
  bottom: number;
}

/** Блоки колонки сверху вниз: подписи полос и плашка порога у его границы */
export function bandBlocks({
  spans,
  col,
  Y,
  current,
  rangeOf,
  cutoff,
  cutText,
  lo,
  hi,
}: {
  spans: readonly { rung: Rung; from: number; to: number }[];
  col: BandColumn;
  Y: (v: number) => number;
  current: Rung | null;
  rangeOf: (r: Rung) => string;
  cutoff: Cutoff | null;
  cutText: string | null;
  lo: number;
  hi: number;
}): LabelBlock[] {
  if (!col.withCol) return [];
  const blocks: LabelBlock[] = [...spans].reverse().map((s) => {
    const lines = col.wrapped.get(s.rung) ?? [];
    return {
      key: `b-${s.rung.min}-${s.rung.max}`,
      kind: "band",
      lines,
      range: rangeOf(s.rung),
      want: (Y(s.to) + Y(s.from)) / 2,
      h: lines.length * LH,
      current: s.rung === current,
      top: Y(s.to),
      bottom: Y(s.from),
    };
  });
  if (cutoff && cutText && cutoff.at > lo && cutoff.at < hi) {
    const lines = wrapWords(cutText, col.colW, labelWidth);
    const y = Y(cutoff.at);
    blocks.push({ key: "cutoff", kind: "cutoff", lines, range: null, want: y, h: lines.length * LH, current: false, top: y, bottom: y });
    blocks.sort((a, b) => a.want - b.want);
  }
  return blocks;
}

/**
 * Какие блоки встают и где. Все не помещаются даже раздвинутыми — остаются
 * текущая полоса и порог (малый формат): прочие полосы — в подсказке и в
 * полном графике.
 */
export function placeBlocks(blocks: readonly LabelBlock[], top: number, bottom: number): { shown: LabelBlock[]; tops: number[] } {
  const total = (list: readonly LabelBlock[]) => list.reduce((s, b) => s + b.h, 0) + Math.max(0, list.length - 1) * 2;
  const shown = total(blocks) > bottom - top ? blocks.filter((b) => b.current || b.kind === "cutoff") : [...blocks];
  return {
    shown,
    tops: stackBlocks(
      shown.map((b) => ({ want: b.want, h: b.h })),
      top,
      bottom,
    ),
  };
}

/** Подписи полос и плашка порога — целиком, переносом; ушедшая со своей полосы — на подложке с выноской */
export function BandLabels({ shown, tops, colX, colW }: { shown: readonly LabelBlock[]; tops: readonly number[]; colX: number; colW: number }) {
  const { ut } = useLang();
  const f1 = (v: number) => v.toFixed(1);
  return (
    <>
      {shown.map((b, i) => {
        const top = tops[i]!;
        const mid = top + b.h / 2;
        /* порог — всегда плашкой у конца своего пунктира; полоса — плашкой, только если ушла со своей полосы */
        const cut = b.kind === "cutoff";
        const off = cut || mid < b.top || mid > b.bottom;
        const lead = cut ? b.want : Math.min(Math.max(mid, b.top + 4), b.bottom - 4);
        return (
          <g key={b.key} data-label={cut ? "cutoff" : "band"}>
            {off ? (
              <>
                <rect
                  x={f1(colX - 5)}
                  y={f1(top - 2.5)}
                  width={f1(Math.min(colW, Math.max(...b.lines.map(labelWidth))) + 10)}
                  height={f1(b.h + 5)}
                  rx={6}
                  fill="var(--panel)"
                  stroke={cut ? "var(--text-2)" : "var(--border)"}
                />
                <polyline
                  points={`${f1(colX - 16)},${f1(lead)} ${f1(colX - 10)},${f1(lead)} ${f1(colX - 5)},${f1(Math.min(Math.max(lead, top + 2), top + b.h - 2))}`}
                  fill="none"
                  stroke="var(--text-2)"
                  strokeWidth={cut ? 1.6 : 1}
                  strokeDasharray={cut ? "3 2" : undefined}
                />
              </>
            ) : null}
            {cut ? <title>{ut("course.cutoffWhy")}</title> : null}
            <text
              x={f1(colX)}
              y={f1(top + LH - 3.5)}
              fontSize={LABEL_SIZE}
              fontWeight={b.current || cut ? 800 : 600}
              fill={b.current || cut ? "var(--text)" : "var(--text-2)"}
            >
              {b.lines.map((ln, j) => {
                const lead0 = j === 0 && b.range && ln.startsWith(b.range);
                return (
                  <tspan key={j} x={f1(colX)} dy={j ? LH : 0}>
                    {lead0 ? (
                      <>
                        <tspan fill="var(--muted)" fontWeight={600}>
                          {b.range}
                        </tspan>
                        {ln.slice(b.range!.length)}
                      </>
                    ) : (
                      ln
                    )}
                  </tspan>
                );
              })}
            </text>
          </g>
        );
      })}
    </>
  );
}

/**
 * Подписи полос строками под графиком — когда поле слишком узкое для
 * колонки справа. Целиком, с границами; текущая — жирнее.
 */
export function BandKey({ spans, current, rangeOf }: { spans: readonly { rung: Rung }[]; current: Rung | null; rangeOf: (r: Rung) => string }) {
  if (!spans.length) return null;
  return (
    <ul data-band-key className="m-0 mt-[8px] flex list-none flex-col gap-y-[2px] p-0 text-caption leading-[16px]">
      {[...spans].reverse().map(({ rung }) => (
        <li key={`${rung.min}-${rung.max}`} className={rung === current ? "font-extrabold text-text" : "font-semibold text-text-2"}>
          <span className="font-semibold text-muted tabular-nums">{rangeOf(rung)}</span> {rung.label}
        </li>
      ))}
    </ul>
  );
}
