import type { ReactNode } from "react";
import type { Lang } from "@quizzy/shared";
import { cx } from "./cx";
import { Ic } from "./icons";
import { Popover } from "./Popover";
import { SeverityTag, type Severity } from "./primitives";
import { currentLang, useLang } from "../lang";

/*
 * Число со сравнением и смыслом (набор «Виразна»): значение, слово тяжести,
 * «краще ↓/↑», было → стало, изменение от старта и надёжность (порог RC).
 *
 * Компоненты ничего не считают: шкала, пороги и слова тяжести — клиническая
 * логика экрана (shared). Сюда приходят готовые величины, а уходит вид.
 */

/** «краще ↓» / «краще ↑» — в какую сторону лучше (.better) */
export function BetterTag({ direction }: { direction: "down" | "up" }) {
  const { ut } = useLang();
  return (
    <span className="inline-flex h-[22px] shrink-0 items-center whitespace-nowrap rounded-[11px] bg-sunk px-2 text-[11.5px] font-bold leading-none text-text-2">
      {direction === "down" ? ut("kit.betterDown") : ut("kit.betterUp")}
    </span>
  );
}

/**
 * Полоска надёжности (.rel meter): дорожка 44, заливка = |изменение| / (2 ×
 * порог), риска посередине — порог. Зелёная, только когда изменение надёжно
 * и к лучшему.
 */
export function RelMeter({ delta, threshold, good }: { delta: number; threshold: number; good: boolean }) {
  const w = 44;
  const fill = threshold > 0 ? Math.min(Math.abs(delta) / (threshold * 2), 1) * w : 0;
  return (
    <svg width={w} height={10} viewBox={`0 0 ${w} 10`} aria-hidden className="shrink-0">
      <rect x={0} y={3} width={w} height={4} rx={2} className="fill-track" />
      <rect x={0} y={3} width={fill} height={4} rx={2} className={good ? "fill-good" : "fill-muted"} />
      <rect x={w / 2 - 1} y={0} width={2} height={10} rx={1} className="fill-text" />
    </svg>
  );
}

/** Надёжность изменения: надёжно лучше, надёжно хуже, в пределах погрешности */
export type Reliability = "better" | "worse" | "within";

/** Слово надёжности по изменению, порогу и направлению «лучше» */
export function reliabilityOf(delta: number, threshold: number, better: "down" | "up"): Reliability {
  if (Math.abs(delta) < threshold) return "within";
  const improved = better === "down" ? delta < 0 : delta > 0;
  return improved ? "better" : "worse";
}

/**
 * Число на языке экрана: до `digits` знаков, лишние нули прочь, дробная
 * часть — через запятую в украинском и русском («5,5») и через точку в
 * английском («5.5»). Без 0.30000000000000004 из суммы.
 *
 * Язык по умолчанию — языка консоли (lang.tsx, currentLang): функцию зовут и
 * вне компонентов. Компонент передаёт свой `lang` из useLang явно.
 */
export function decimal(v: number, lang: Lang = currentLang, digits = 2): string {
  const k = 10 ** digits;
  const s = String(Math.round(v * k) / k);
  return lang === "en" ? s : s.replace(".", ",");
}

/** «−14», «+16 в. п.», «−2,5» — со знаком минус, а не дефисом, и дробью языка экрана */
export function signed(delta: number, unit = "", lang: Lang = currentLang): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  return `${sign}${decimal(Math.abs(delta), lang)}${unit}`;
}

/** Число или подпись как есть: число — дробью языка, строка — без изменений */
function shown(v: number | string, lang: Lang): string {
  return typeof v === "number" ? decimal(v, lang) : v;
}

/**
 * Изменение от старта с надёжностью (ячейка таблицы методик): «−14 надійно
 * краще», полоска и «поріг 11».
 */
export function ChangeCell({
  delta,
  threshold,
  better,
  unit,
  inline,
}: {
  delta: number;
  threshold: number;
  better: "down" | "up";
  /** « в. п.» для процентных шкал */
  unit?: string;
  /** Изменение и слово в одну строку (под большим числом) */
  inline?: boolean;
}) {
  const { ut, lang } = useLang();
  const rel = reliabilityOf(delta, threshold, better);
  const good = rel === "better";
  const word = rel === "better" ? ut("kit.reliablyBetter") : rel === "worse" ? ut("kit.reliablyWorse") : ut("kit.withinError");
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className={cx(
          "flex whitespace-nowrap text-small",
          inline ? "flex-row items-baseline gap-1.5" : "flex-col items-start gap-px",
          good ? "font-bold text-good" : rel === "worse" ? "font-bold text-warn" : "text-text-2",
        )}
      >
        <span className={cx("text-[15px] font-extrabold leading-[18px]", good ? "text-good" : rel === "worse" ? "text-warn" : "text-text")}>
          {signed(delta, unit, lang)}
        </span>
        {word}
      </span>
      <span className="flex items-center gap-1.5 whitespace-nowrap text-[11.5px] leading-none text-muted">
        <RelMeter delta={delta} threshold={threshold} good={good} />
        {ut("kit.threshold").replace("{n}", `${decimal(threshold, lang)}${unit ?? ""}`)}
      </span>
    </div>
  );
}

/**
 * Большое значение (.bv набора): код и «краще ↓», что меряет; 32/800 число с
 * единицей и словом тяжести; «було 19 → 16»; изменение с надёжностью.
 * Несколько стоят рядом в <BigValues>.
 *
 * ```tsx
 * <BigValue code="PHQ-9" measure="депресія" better="down" value={14}
 *   severity={{ word: "помірна", level: "moderate" }} history={[19, 16]}
 *   change={{ delta: -5, threshold: 6 }} />
 * ```
 */
export function BigValue({
  code,
  measure,
  better,
  value,
  unit,
  severity,
  history,
  change,
  pop,
}: {
  code: string;
  /** Что меряет: «депресія» */
  measure?: ReactNode;
  better?: "down" | "up";
  value: number | string | null;
  /** «%» для процентных шкал */
  unit?: string;
  severity?: { word: string; level: Severity };
  /** Прежние значения до текущего: «було 19 → 16» */
  history?: (number | string)[];
  /** Изменение от старта и порог надёжного изменения; без него — «старт курсу» */
  change?: { delta: number; threshold: number; unit?: string };
  /** Поповер на числе: дата, тяжесть, изменение */
  pop?: ReactNode;
}) {
  const { ut, lang } = useLang();
  const num = (
    <span className="rounded-[6px] text-stat font-extrabold text-text">{value === null ? "—" : shown(value, lang)}</span>
  );
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 whitespace-nowrap">
        <span className="text-[14px] font-extrabold text-text">{code}</span>
        {better ? <BetterTag direction={better} /> : null}
        {measure ? <span className="block basis-full text-caption text-muted">{measure}</span> : null}
      </div>
      <div className="flex items-baseline gap-2 whitespace-nowrap">
        {pop ? (
          <Popover content={pop} title={code}>
            {num}
          </Popover>
        ) : (
          num
        )}
        {unit ? <span className="text-[14px] font-bold text-muted">{unit}</span> : null}
        {severity ? <SeverityTag level={severity.level} className="ml-0.5 self-center">{severity.word}</SeverityTag> : null}
      </div>
      {history && history.length ? (
        <span className="text-[13px] font-semibold text-muted">{ut("kit.was").replace("{v}", history.map((h) => shown(h, lang)).join(" → "))}</span>
      ) : null}
      {change && better ? (
        <ChangeCell delta={change.delta} threshold={change.threshold} better={better} unit={change.unit} inline />
      ) : (
        <span className="text-small text-text-2">{ut("kit.courseStart")}</span>
      )}
    </div>
  );
}

/** Несколько больших значений в ряд, через волосяные линии (.bvs) */
export function BigValues({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] [&>*]:border-l [&>*]:border-divider [&>*]:px-4 [&>*]:pb-4 [&>*]:pt-3.5 [&>*:first-child]:border-l-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Мини-курс цифрами (.crs): «PHQ-9 19 → 16 → 14» и плитка направления —
 * зелёная, когда лучше, янтарная, когда хуже, серая без изменений.
 */
export function CourseDigits({
  code,
  values,
  better,
  flat = 1,
}: {
  code: string;
  values: number[];
  better: "down" | "up";
  /** Изменение не больше этого — «без суттєвих змін» */
  flat?: number;
}) {
  const { lang } = useLang();
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  const last = v[v.length - 1]!;
  const total = last - v[0]!;
  const improved = better === "down" ? total < 0 : total > 0;
  const tile =
    v.length < 2 ? null : Math.abs(total) <= flat ? (
      <span className="ml-[3px] inline-grid size-[18px] place-items-center rounded-[6px] bg-sunk text-muted" aria-hidden>
        <Ic.minus size={12} />
      </span>
    ) : (
      <span
        className={cx("ml-[3px] inline-grid size-[18px] place-items-center rounded-[6px]", improved ? "bg-good-tint text-good" : "bg-warn-tint text-warn")}
        aria-hidden
      >
        {total < 0 ? <Ic.arrowDown size={12} /> : <Ic.arrowUp size={12} />}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-caption text-text-2">
      <span className="mr-[3px] text-[11px] font-bold text-muted">{code}</span>
      {v.slice(0, -1).map((x, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          {decimal(x, lang)}
          <span className="text-muted">→</span>
        </span>
      ))}
      <b className="font-extrabold text-text">{decimal(last, lang)}</b>
      {tile}
    </span>
  );
}
