import { api } from "../api";
import { Loading } from "../ui";
import { useResource } from "../useResource";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { SeverityTag } from "../ui/primitives";
import { RuleSection } from "../ui/section";

// ключи: карта вне компонента, перевод берётся при отрисовке
const SEX_KEY = { male: "dq.men", female: "dq.women" } as const;

/*
 * Ячейки таблиц — утилитами: голых <table> наследия с классом .num больше
 * нет. Те же классы, что у таблиц вкладки «Тести» (pages/analytics/tests):
 * панель стоит внутри неё, в виде «Якість».
 */
const TH = "border-b border-hairline py-[8px] pr-[16px] text-left align-bottom text-[13px] font-bold leading-[16px] text-muted";
const TD = "border-b border-hairline py-[8px] pr-[16px] align-top text-[13px] leading-[18px] text-text-2";
const NUM = "text-right font-mono tabular-nums";

/**
 * Качество данных: кто доходит до конца, изменилась ли выборка, повторяемо ли
 * измерение. Вопросы, которые обычная аналитика не задаёт, — а без ответов на
 * них нормы и сравнения стоят на песке.
 *
 * Три раздела с линией 2px, как остальные разделы вида «Якість», а не три
 * панели-карточки: на экране, где всё остальное лежит на белом, карточки
 * выглядели бы вставкой из другого приложения.
 */
export function DataQualityPanel({ surveyId }: { surveyId: string }) {
  const { ut } = useLang();
  const sexLabel = (sex: string) =>
    sex in SEX_KEY ? ut(SEX_KEY[sex as keyof typeof SEX_KEY]) : sex;
  // через useResource: смена методики не должна оставлять ответ по прежней
  const res = useResource(() => api.dataQuality(surveyId), [surveyId]);
  const { data, error } = res;

  if (error) return <Loading error={error} onRetry={res.reload} />;
  if (!data) return <Loading />;

  const worst = data.strata
    .filter((s) => !s.suppressed && s.completionRate !== undefined)
    .sort((a, b) => (a.completionRate ?? 100) - (b.completionRate ?? 100))[0];

  return (
    <>
      <RuleSection
        title={ut("dq.completionTitle")}
        actions={
          <span className="text-[13px] text-muted">
            {ut("dq.groupsSmallerThan")} {data.smallCellFloor} {ut("dq.areHidden")}
          </span>
        }
      >
        {/* заметно худшая доходимость группы — повод посмотреть: янтарь «требует внимания» */}
        {worst && (worst.completionRate ?? 100) < 80 ? (
          <p className="m-0 mb-[12px] text-[13px] leading-[18px] text-accent">
            {sexLabel(worst.sex)} {worst.band}: {ut("dq.reaches")} {worst.completionRate}%. {ut("dq.underrepresented")}
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse">
            <thead>
              <tr>
                <th scope="col" className={TH}>{ut("dq.sex")}</th>
                <th scope="col" className={TH}>{ut("dq.age")}</th>
                <th scope="col" className={cx(TH, "text-right")}>{ut("dq.started")}</th>
                <th scope="col" className={cx(TH, "text-right")}>{ut("dq.finished")}</th>
                <th scope="col" className={cx(TH, "text-right")}>{ut("dq.completion")}</th>
                <th scope="col" className={cx(TH, "text-right")}>{ut("dq.skippedItems")}</th>
              </tr>
            </thead>
            <tbody>
              {data.strata.map((s) => (
                <tr key={`${s.sex}-${s.band}`}>
                  <td className={TD}>{sexLabel(s.sex)}</td>
                  <td className={cx(TD, "text-muted")}>{s.band}</td>
                  {s.suppressed ? (
                    <td colSpan={4} className={cx(TD, "text-muted")}>
                      {ut("dq.lessThan")} {data.smallCellFloor} {ut("dq.notShownDash")}
                    </td>
                  ) : (
                    <>
                      <td className={cx(TD, NUM)}>{s.started}</td>
                      <td className={cx(TD, NUM)}>{s.completed}</td>
                      <td className={cx(TD, NUM)}>{s.completionRate}%</td>
                      <td className={cx(TD, NUM, "text-muted")}>{s.avgSkipped}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </RuleSection>

      {data.drift.length ? (
        <RuleSection title={ut("dq.driftTitle")} hint={ut("dq.psiHint")}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr>
                  <th scope="col" className={TH}>{ut("dq.scale")}</th>
                  <th scope="col" className={TH}>{ut("dq.month")}</th>
                  <th scope="col" className={cx(TH, "text-right")}>n</th>
                  <th scope="col" className={cx(TH, "text-right")}>PSI</th>
                  <th scope="col" className={TH}>{ut("dq.verdict")}</th>
                </tr>
              </thead>
              <tbody>
                {data.drift.map((d) => (
                  <tr key={d.code}>
                    <td className={TD}>
                      {d.code} — {d.title}
                    </td>
                    <td className={cx(TD, "text-muted")}>{d.month}</td>
                    <td className={cx(TD, NUM)}>{d.n}</td>
                    <td className={cx(TD, NUM)}>{d.psi}</td>
                    <td className={TD}>
                      {/*
                        Вердикт дрейфа — степень («заметно изменилась» vs «в
                        пределах шума»), поэтому цвет не работает один:
                        SeverityTag добавляет форму точки и оставляет текст
                        вердикта видимым всегда, а не только по цвету.
                      */}
                      {d.psi > 0.2 ? <SeverityTag level="mild">{d.verdict}</SeverityTag> : d.verdict}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </RuleSection>
      ) : null}

      <RuleSection
        title={ut("dq.repeatTitle")}
        hint={`${ut("dq.iccHintPart1")} ${data.retestWindow.minDays}–${data.retestWindow.maxDays} ${ut("dq.iccHintPart2")}`}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse">
            <thead>
              <tr>
                <th scope="col" className={TH}>{ut("dq.scale")}</th>
                <th scope="col" className={cx(TH, "text-right")}>{ut("dq.pairs")}</th>
                <th scope="col" className={cx(TH, "text-right")}>ICC</th>
              </tr>
            </thead>
            <tbody>
              {data.retest.map((r) => (
                <tr key={r.code}>
                  <td className={TD}>
                    {r.code} — {r.title}
                  </td>
                  <td className={cx(TD, NUM)}>{r.pairs}</td>
                  <td className={cx(TD, NUM)}>
                    {r.icc === null ? (
                      <span className="font-sans text-muted">
                        {ut("dq.needAtLeast")}
                        {data.retestWindow.minPairs} {ut("dq.pairsLower")}
                      </span>
                    ) : (
                      r.icc
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </RuleSection>
    </>
  );
}
