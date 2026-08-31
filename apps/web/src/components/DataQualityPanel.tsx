import { api } from "../api";
import { Loading } from "../ui";
import { useResource } from "../useResource";
import { useLang } from "../lang";
import { Panel, Stack } from "../ui/layout";
import { SeverityTag } from "../ui/primitives";

// ключи: карта вне компонента, перевод берётся при отрисовке
const SEX_KEY = { male: "dq.men", female: "dq.women" } as const;

/**
 * Качество данных: кто доходит до конца, изменилась ли выборка, повторяемо ли
 * измерение. Вопросы, которые обычная аналитика не задаёт, — а без ответов на
 * них нормы и сравнения стоят на песке.
 */
export function DataQualityPanel({ surveyId }: { surveyId: string }) {
  const { ut } = useLang();
  const sexLabel = (sex: string) =>
    sex in SEX_KEY ? ut(SEX_KEY[sex as keyof typeof SEX_KEY]) : sex;
  // через useResource: смена методики не должна оставлять ответ по прежней
  const res = useResource(() => api.dataQuality(surveyId), [surveyId]);
  const { data, error } = res;

  if (error) return <p className="text-danger">{error}</p>;
  if (!data) return <Loading />;

  const worst = data.strata
    .filter((s) => !s.suppressed && s.completionRate !== undefined)
    .sort((a, b) => (a.completionRate ?? 100) - (b.completionRate ?? 100))[0];

  return (
    <Stack>
      <Panel
        title={ut("dq.completionTitle")}
        actions={
          <span className="text-caption text-muted">
            {ut("dq.groupsSmallerThan")} {data.smallCellFloor} {ut("dq.areHidden")}
          </span>
        }
        className="overflow-x-auto"
      >
        {worst && (worst.completionRate ?? 100) < 80 ? (
          <p className="mb-3 text-caption text-accent">
            {sexLabel(worst.sex)} {worst.band}: {ut("dq.reaches")} {worst.completionRate}%.{" "}
            {ut("dq.underrepresented")}
          </p>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>{ut("dq.sex")}</th><th>{ut("dq.age")}</th><th className="num">{ut("dq.started")}</th>
              <th className="num">{ut("dq.finished")}</th><th className="num">{ut("dq.completion")}</th>
              <th className="num">{ut("dq.skippedItems")}</th>
            </tr>
          </thead>
          <tbody>
            {data.strata.map((s) => (
              <tr key={`${s.sex}-${s.band}`}>
                <td>{sexLabel(s.sex)}</td>
                <td className="text-muted">{s.band}</td>
                {s.suppressed ? (
                  <td colSpan={4} className="text-muted">
                    {ut("dq.lessThan")} {data.smallCellFloor} {ut("dq.notShownDash")}
                  </td>
                ) : (
                  <>
                    <td className="num">{s.started}</td>
                    <td className="num">{s.completed}</td>
                    <td className="num">{s.completionRate}%</td>
                    <td className="num text-muted">{s.avgSkipped}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {data.drift.length ? (
        <Panel
          title={ut("dq.driftTitle")}
          hint={ut("dq.psiHint")}
          className="overflow-x-auto"
        >
          <table>
            <thead>
              <tr><th>{ut("dq.scale")}</th><th>{ut("dq.month")}</th><th className="num">n</th><th className="num">PSI</th><th>{ut("dq.verdict")}</th></tr>
            </thead>
            <tbody>
              {data.drift.map((d) => (
                <tr key={d.code}>
                  <td>{d.code} — {d.title}</td>
                  <td className="text-muted">{d.month}</td>
                  <td className="num">{d.n}</td>
                  <td className="num">{d.psi}</td>
                  <td>
                    {/*
                      Вердикт дрейфа — степень («заметно изменилась» vs «в
                      пределах шума»), поэтому цвет не работает один:
                      SeverityTag добавляет форму точки и оставляет текст
                      вердикта видимым всегда, а не только по цвету.
                    */}
                    {d.psi > 0.2 ? (
                      <SeverityTag level="mild">{d.verdict}</SeverityTag>
                    ) : (
                      d.verdict
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}

      <Panel
        title={ut("dq.repeatTitle")}
        hint={`${ut("dq.iccHintPart1")} ${data.retestWindow.minDays}–${data.retestWindow.maxDays} ${ut("dq.iccHintPart2")}`}
        className="overflow-x-auto"
      >
        <table>
          <thead>
            <tr><th>{ut("dq.scale")}</th><th className="num">{ut("dq.pairs")}</th><th className="num">ICC</th></tr>
          </thead>
          <tbody>
            {data.retest.map((r) => (
              <tr key={r.code}>
                <td>{r.code} — {r.title}</td>
                <td className="num">{r.pairs}</td>
                <td className="num">
                  {r.icc === null ? (
                    <span className="text-muted">
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
      </Panel>
    </Stack>
  );
}
