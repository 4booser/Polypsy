import type { ScoreResult, UiKey } from "@quizzy/shared";
import { useLang } from "../lang";
import { SeverityTag } from "../ui/primitives";
import { cx } from "../ui/cx";
import { dm } from "./when";

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
    const [big = String(s.rawScore), rest = ""] = ut("qi.pointOf")
      .replace("{n}", String(s.rawScore))
      .replace("{max}", String(s.maxScore))
      .split(/ (.*)/s);
    return { big, of: rest || null };
  }
  return { big: String(Math.round(s.value * 10) / 10), of: null };
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
      <div className="flex flex-wrap items-center justify-end gap-2">
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
