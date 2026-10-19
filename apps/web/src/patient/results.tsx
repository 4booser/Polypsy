import type { ScoreResult, UiKey } from "@quizzy/shared";
import { locale } from "../format";
import { useLang } from "../lang";
import { SeverityTag } from "../ui/primitives";
import { cx } from "../ui/cx";
import { dm } from "./when";

/**
 * Число результата: до десятой и знаком языка страницы — «52,3» на
 * украинском и русском, «52.3» на английском. `signed` — изменение со
 * знаком: «+2,5», «−1», а ноль — без знака.
 */
export function scoreNumber(v: number, signed = false): string {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 1, ...(signed ? { signDisplay: "exceptZero" as const } : {}) }).format(v);
}

/**
 * Результат шкалы глазами человека: «14 з 27», «40 %», полоса словом.
 *
 * Показывается только то, что прислал сервер: баллы приходят лишь у методик,
 * где психолог включил показ (showResultsToPatient, resultsShownTo на
 * сервере), у остальных список пуст — и экран говорит «пояснить фахівець».
 */
export function scoreValue(s: ScoreResult, ut: (key: UiKey) => string): { big: string; of: string | null } {
  if (s.normalization === "ratio") return { big: `${Math.round(s.percent)} %`, of: null };
  if (s.normalization === "raw") {
    const [big = scoreNumber(s.rawScore), rest = ""] = ut("qi.pointOf")
      .replace("{n}", scoreNumber(s.rawScore))
      .replace("{max}", scoreNumber(s.maxScore))
      .split(/ (.*)/s);
    return { big, of: rest || null };
  }
  return { big: scoreNumber(s.value), of: null };
}

/** Шкала, которую показывают первой: содержательная (не шкала лжи) */
export function mainScore(scores: ScoreResult[]): ScoreResult | null {
  return scores.find((s) => s.kind === "clinical" || !s.kind) ?? null;
}

/**
 * Ячейка результата в строке пройденного: значение, полоса и с чем
 * сравнить — «було 16 на 11.09». Сравнение — с прошлым прохождением той же
 * методики, если оно было и его результат тоже показан.
 */
export function ResultCell({
  score,
  before,
  className,
}: {
  score: ScoreResult;
  before?: { at: string; score: ScoreResult } | null;
  className?: string;
}) {
  const { ut } = useLang();
  const v = scoreValue(score, ut);
  return (
    <div className={cx("text-right", className)}>
      <div className="flex flex-wrap items-center justify-end gap-2 max-[760px]:justify-start">
        <span className="text-[20px] font-extrabold leading-none tracking-[-0.01em] tabular-nums text-text">
          {v.big}
          {v.of ? <span className="ml-1 text-[15px] font-bold text-muted">{v.of}</span> : null}
        </span>
        {score.band ? <SeverityTag level={score.band.severity}>{score.band.label}</SeverityTag> : null}
      </div>
      <small className="mt-1 block text-[13px] leading-[17px] text-muted">
        {before
          ? ut("ptw.wasOn").replace("{v}", scoreValue(before.score, ut).big).replace("{d}", dm(before.at))
          : ut("ptw.firstMeasure")}
      </small>
    </div>
  );
}
