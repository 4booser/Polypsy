import { Link } from "react-router-dom";
import type { AnswerMatrix, RespondentDynamics, SurveyAnalytics } from "@quizzy/shared";
import type { AnalyticsSlice } from "../../../api";
import { BandTrend, Figure, HBars } from "../../../charts/clinical";
import { day, duration } from "../../../format";
import { useLang } from "../../../lang";
import { cx } from "../../../ui/cx";
import { NoData } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { cellTone, chartsHref, fill, numText, toneStep } from "./model";
import { NUM, ResponsesList, TD, TH, rungsOf, useResponsePages } from "./views";

/*
 * Срез «Один пацієнт»: как этот человек проходил эту методику.
 *
 * Порядок — от общего к частному: его прохождения списком → куда двигались
 * баллы по лестнице каждой шкалы → какие ответы менялись от раза к разу →
 * сколько времени занимало. Это порядок разговора на приёме: сначала «как
 * дела по шкалам», потом «а что именно изменилось».
 */

/**
 * Тон клетки матрицы — пять ступеней одного фиолетового, литералами.
 *
 * Литералами, а не подстановкой процента в строку класса: Tailwind собирает
 * классы, читая исходник, и `bg-[color-mix(…_${p}%…)]` не увидел бы вовсе.
 * Верхняя ступень — 46%, не больше: на ней текст клетки обязан читаться в
 * обеих темах (светлая: #1a1a1a на смеси ≈ 7:1, тёмная: #e9e9ed ≈ 6:1).
 */
const TONE = [
  "bg-[color-mix(in_srgb,var(--primary)_6%,var(--card))]",
  "bg-[color-mix(in_srgb,var(--primary)_14%,var(--card))]",
  "bg-[color-mix(in_srgb,var(--primary)_24%,var(--card))]",
  "bg-[color-mix(in_srgb,var(--primary)_35%,var(--card))]",
  "bg-[color-mix(in_srgb,var(--primary)_46%,var(--card))]",
];

export function PatientView({
  data,
  dynamics,
  slice,
}: {
  data: SurveyAnalytics;
  dynamics: RespondentDynamics | null;
  slice: AnalyticsSlice;
}) {
  const { ut } = useLang();
  const sid = data.surveyId;
  const pages = useResponsePages(sid, { ...slice, versionId: data.versionId ?? undefined });
  const mine = dynamics?.surveys.find((s) => s.surveyId === sid);
  const timed = pages.rows.filter((r) => r.status === "completed" && r.durationMs > 0);

  /*
   * Ни одного прохождения под фильтрами — одна фраза вместо четырёх пустых
   * разделов: четыре «даних поки немає» подряд читаются как поломка экрана.
   */
  if (data.started === 0) {
    return (
      <>
        {dynamics ? <PersonHead dynamics={dynamics} /> : null}
        <p className="m-0 py-[12px] text-[15px] leading-[21px] text-muted">{ut("ant.noPatientResponses")}</p>
      </>
    );
  }

  return (
    <>
      {dynamics ? <PersonHead dynamics={dynamics} /> : null}

      <RuleSection title={ut("ant.patientResponses")}>
        <ResponsesList pages={pages} surveyId={sid} showName={false} />
      </RuleSection>

      <RuleSection title={ut("ant.patientDynamics")} hint={ut("ant.dynamicsCaption")}>
        {mine?.scales.length ? (
          <div className="grid grid-cols-2 gap-x-[45px] gap-y-[28px] max-[900px]:grid-cols-1">
            {mine.scales.map((sc) => {
              /* лестница — по коду шкалы: id у версий разные, код один */
              const scale = data.scales.find((s) => s.code === sc.code);
              const rungs = scale ? rungsOf(scale) : [];
              return (
                <Figure key={sc.code} title={sc.title} aside={<span className="font-mono text-[12px] text-muted">{sc.code}</span>}>
                  <BandTrend
                    label={sc.title}
                    rungs={rungs}
                    max={rungs.length ? null : (scale?.maxPossible ?? sc.points[0]?.maxScore ?? null)}
                    sem={sc.sem ?? null}
                    height={200}
                    points={sc.points.map((p) => ({
                      key: p.responseId,
                      t: Date.parse(p.submittedAt),
                      label: day(p.submittedAt),
                      /* rawScore динамики — итоговое значение шкалы (см. routes/dynamics.ts) */
                      value: p.rawScore,
                      band: p.severity && p.bandLabel ? { label: p.bandLabel, severity: p.severity } : null,
                    }))}
                  />
                </Figure>
              );
            })}
          </div>
        ) : (
          <NoData />
        )}
      </RuleSection>

      <RuleSection
        title={ut("ant.answersChange")}
        hint={data.answerMatrix?.responses.length ? fill(ut("ant.answersCaption"), { n: data.answerMatrix.responses.length }) : undefined}
      >
        {data.answerMatrix?.responses.length ? <Matrix matrix={data.answerMatrix} surveyId={sid} /> : <NoData />}
      </RuleSection>

      <RuleSection title={ut("ant.timeByResponse")}>
        {timed.length ? (
          <HBars
            items={timed
              .slice()
              .reverse()
              .map((r) => ({
                key: r.id,
                label: day(r.submittedAt ?? r.startedAt),
                value: r.durationMs,
                text: duration(r.durationMs),
              }))}
          />
        ) : (
          <NoData />
        )}
      </RuleSection>
    </>
  );
}

/** Имя человека над разделами — ссылкой на его карточку, как в списке пациентов */
function PersonHead({ dynamics }: { dynamics: RespondentDynamics }) {
  const { ut } = useLang();
  return (
    <p className="m-0 mb-[8px] flex flex-wrap items-baseline gap-x-[16px] gap-y-[4px]">
      <Link to={`/patients/${dynamics.userId}`} className="text-[20px] font-bold leading-[24px] text-primary no-underline hover:underline">
        {dynamics.fullName}
      </Link>
      <Link to={`/patients/${dynamics.userId}`} className="text-[13px] text-muted no-underline hover:text-primary">
        {ut("ant.openCard")}
      </Link>
    </p>
  );
}

/**
 * «Пункт × прохождение»: что человек выбирал от раза к разу.
 *
 * Таблица, а не график: вопрос здесь не «насколько», а «что именно
 * ответил», и ответ — слово варианта. Тон клетки — балл от максимума пункта
 * ступенями одного фиолетового: глаз находит пункты, где тон поменялся, не
 * читая слов. Колонка пунктов прибита к левому краю — у методики на
 * семьдесят пунктов таблица шире колонки и прокручивается сама, а номер и
 * формулировка при этом остаются на виду.
 */
function Matrix({ matrix, surveyId }: { matrix: AnswerMatrix; surveyId: string }) {
  const { ut } = useLang();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse">
        <thead>
          <tr>
            <th scope="col" className={cx(TH, "sticky left-0 z-[1] bg-[var(--bg)]")}>
              {ut("an.item")}
            </th>
            {matrix.responses.map((r) => (
              <th scope="col" key={r.id} className={cx(TH, "min-w-[128px] px-[8px] font-mono tabular-nums")}>
                <Link to={chartsHref(surveyId, r.id)} className="text-muted no-underline hover:text-primary">
                  {r.submittedAt ? day(r.submittedAt) : "—"}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row) => (
            <tr key={row.questionId}>
              <th scope="row" className={cx(TD, "sticky left-0 z-[1] max-w-[360px] bg-[var(--bg)] text-left font-normal")}>
                <span className="mr-[6px] font-mono text-muted tabular-nums">{row.position + 1}</span>
                <span className="line-clamp-2">{row.title}</span>
              </th>
              {row.cells.map((c, i) => {
                const tone = c ? cellTone(c.score, row.maxScore) : null;
                return (
                  <td
                    key={matrix.responses[i]?.id ?? i}
                    className={cx(TD, "px-[8px]", tone !== null && TONE[toneStep(tone)])}
                  >
                    {c === null ? (
                      <span className="text-muted">—</span>
                    ) : c.skipped ? (
                      <span className="italic text-muted">{ut("ant.cellSkipped")}</span>
                    ) : (
                      <span className="flex min-w-0 items-baseline gap-[6px]">
                        <span className="line-clamp-2 min-w-0 text-text">{c.label ?? ut("ant.cellHidden")}</span>
                        {c.score !== null && row.maxScore !== null ? (
                          <span className={cx(NUM, "shrink-0 text-[12px] text-text-2")}>{numText(c.score)}</span>
                        ) : null}
                      </span>
                    )}
                    {c?.changed ? (
                      /* кольцо, а не цвет: пометка о сомнении — не тяжесть и не тревога */
                      <span className="mt-[2px] flex items-center gap-[4px] text-[11px] text-muted">
                        <span aria-hidden className="inline-block size-[6px] rounded-full border border-primary" />
                        {ut("ant.cellChanged")}
                      </span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
