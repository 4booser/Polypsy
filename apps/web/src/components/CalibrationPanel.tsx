import { api } from "../api";
import { Loading } from "../ui";
import { useResource } from "../useResource";
import { useLang } from "../lang";
import { Panel, Stack } from "../ui/layout";

/**
 * Калибровка порогов по клиническим исходам.
 *
 * Показывает две вещи рядом: как работает ДЕЙСТВУЮЩИЙ порог пособия на нашей
 * выборке и какой порог предложил бы индекс Юдена. Публиковать кандидата
 * можно только при достаточном числе исходов обоих видов — иначе кривая
 * рисует шум, а не популяцию.
 */
export function CalibrationPanel({ surveyId }: { surveyId: string }) {
  const { ut } = useLang();
  // через useResource: смена методики не должна оставлять ответ по прежней
  const res = useResource(() => api.calibration(surveyId), [surveyId]);
  const { data, error } = res;

  if (error) return <p className="text-danger">{error}</p>;
  if (!data) return <Loading />;

  return (
    <Stack>
      <Panel
        title={ut("cal.title")}
        hint={
          <>
            {ut("cal.hintIntro")} {data.minPerOutcome} {ut("cal.hintAndConfirmed")}{" "}
            {data.minPerOutcome} {ut("cal.hintNotConfirmedTail")}
          </>
        }
        actions={
          <span className="text-caption text-muted">
            {ut("cal.casesReviewed")}: {data.cases}
          </span>
        }
      >
        {data.cases === 0 ? <p className="m-0 text-muted">{ut("cal.noOutcomesYet")}</p> : null}
      </Panel>

      {data.scales.map((scale) => (
        <Panel
          key={scale.code}
          title={`${scale.code} — ${scale.title}`}
          actions={
            <span className="text-caption text-muted">
              {scale.normalization === "tscore" ? ut("co.tScores") : scale.normalization}
            </span>
          }
          className="overflow-x-auto"
        >
          <table>
            <thead>
              <tr>
                <th>{ut("cal.stratum")}</th>
                <th className="num">{ut("cal.confirmed")}</th>
                <th className="num">{ut("cal.notConfirmed")}</th>
                <th className="num">{ut("cal.currentThreshold")}</th>
                <th className="num">{ut("cal.sensitivity")}</th>
                <th className="num">{ut("cal.specificity")}</th>
                <th className="num">AUC</th>
                <th className="num">{ut("cal.candidate")}</th>
              </tr>
            </thead>
            <tbody>
              {scale.strata.map((s) => (
                <tr key={s.stratum}>
                  <td>{s.stratum}</td>
                  <td className="num">{s.confirmed}</td>
                  <td className="num">{s.notConfirmed}</td>
                  <td className="num">{s.currentThreshold ?? "—"}</td>
                  <td className="num">{s.currentSensitivity ?? "—"}</td>
                  <td className="num">{s.currentSpecificity ?? "—"}</td>
                  <td className="num">{s.roc ? s.roc.auc : <span className="text-muted">{ut("cal.fewData")}</span>}</td>
                  <td className="num">
                    {s.roc ? (
                      <span
                        title={`${ut("cal.sensitivityWord")} ${s.roc.bestSensitivity}, ${ut("cal.specificityWord")} ${s.roc.bestSpecificity}`}
                      >
                        {s.roc.bestThreshold}
                        <span className="text-caption text-muted">
                          {" "}({s.roc.bestSensitivity}/{s.roc.bestSpecificity})
                        </span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-caption text-muted">{ut("cal.aucExplain")}</p>
        </Panel>
      ))}
    </Stack>
  );
}

/** PPV скрининга: доля подтверждённых среди разобранных — для Сводки */
export function PpvCard() {
  const { ut } = useLang();
  // отказ здесь молчит намеренно: карточка справочная, и её отсутствие
  // не должно ломать сводку
  const { data } = useResource(() => api.ppv(), []);

  if (!data?.overall) return null;
  const trend = data.byMonth.slice(-6);

  return (
    <Panel
      title={ut("cal.ppvTitle")}
      actions={
        <span className="text-caption text-muted">
          {data.overall.confirmed} {ut("ppv.of")} {data.overall.n} {ut("ppv.reviewed")}
          {data.withoutOutcome ? ` · ${ut("ppv.noOutcome")}: ${data.withoutOutcome}` : ""}
        </span>
      }
    >
      <div className="tiles">
        <div className="tile">
          <span className="label">{ut("cal.total")}</span>
          <span className="value">{data.overall.ppv}%</span>
        </div>
        {trend.map((m) => (
          <div className="tile" key={m.month}>
            <span className="label">{m.month}</span>
            <span className="value text-[20px]">{m.ppv}%</span>
            <span className="label">{m.n} {ut("ppv.cases")}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 max-w-[68ch] text-caption text-muted">{ut("ppv.why")}</p>
    </Panel>
  );
}
