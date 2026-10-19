import type { ReactNode } from "react";
import { api } from "../api";
import { Ic, Loading } from "../ui";
import { useResource } from "../useResource";
import { useLang } from "../lang";
import { cx } from "../ui/cx";
import { Panel, Stack } from "../ui/layout";
import { SeverityTag, Tag } from "../ui/primitives";
import { Rx } from "../pages/response/icons";

/**
 * Качество данных методики: доходимость по группам, дрейф выборки и
 * повторяемость измерения (Polypsy 2.0: листы набора с квадратом значка,
 * таблицы набора, числа Manrope с табличными цифрами).
 *
 * Группы меньше порога малых чисел не показываются: строка говорит, что их
 * мало, а не рисует ноль. Заметно худшая доходимость группы — повод
 * посмотреть: янтарь «требует внимания», а не красный.
 */
const SEX_KEY = { male: "dq.men", female: "dq.women" } as const;

const TH = "border-t border-divider bg-panel-2 px-4 py-2 text-left align-bottom text-[11.5px] font-bold leading-[14px] text-muted";
const TD = "border-t border-divider px-4 py-2.5 align-top text-[13px] leading-[18px] text-text-2";
const NUM = "text-right tabular-nums";

function Table({ head, children, min = 560 }: { head: ReactNode; children: ReactNode; min?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse" style={{ minWidth: min }}>
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function DataQualityPanel({ surveyId }: { surveyId: string }) {
  const { ut } = useLang();
  const sexLabel = (sex: string) => (sex in SEX_KEY ? ut(SEX_KEY[sex as keyof typeof SEX_KEY]) : sex);
  const res = useResource(() => api.dataQuality(surveyId), [surveyId]);
  const { data, error } = res;

  if (error) return <Loading error={error} onRetry={res.reload} />;
  if (!data) return <Loading />;

  const worst = data.strata
    .filter((s) => !s.suppressed && s.completionRate !== undefined)
    .sort((a, b) => (a.completionRate ?? 100) - (b.completionRate ?? 100))[0];

  return (
    <Stack>
      <Panel
        title={ut("dq.completionTitle")}
        icon={<Ic.users />}
        tone={worst && (worst.completionRate ?? 100) < 80 ? "warn" : "violet"}
        sub={`${ut("dq.groupsSmallerThan")} ${data.smallCellFloor} ${ut("dq.areHidden")}`}
        hint={
          worst && (worst.completionRate ?? 100) < 80 ? (
            <span className="font-bold text-warn">
              {sexLabel(worst.sex)} {worst.band}: {ut("dq.reaches")} {worst.completionRate}%. {ut("dq.underrepresented")}
            </span>
          ) : undefined
        }
        flush
      >
        <Table
          head={
            <>
              <th scope="col" className={TH}>{ut("dq.sex")}</th>
              <th scope="col" className={TH}>{ut("dq.age")}</th>
              <th scope="col" className={cx(TH, "text-right")}>{ut("dq.started")}</th>
              <th scope="col" className={cx(TH, "text-right")}>{ut("dq.finished")}</th>
              <th scope="col" className={cx(TH, "text-right")}>{ut("dq.completion")}</th>
              <th scope="col" className={cx(TH, "text-right")}>{ut("dq.skippedItems")}</th>
            </>
          }
        >
          {data.strata.map((s) => (
            <tr key={`${s.sex}-${s.band}`}>
              <td className={cx(TD, "font-bold text-text")}>{sexLabel(s.sex)}</td>
              <td className={cx(TD, "text-muted")}>{s.band}</td>
              {s.suppressed ? (
                <td colSpan={4} className={cx(TD, "text-muted")}>
                  {ut("dq.lessThan")} {data.smallCellFloor} {ut("dq.notShownDash")}
                </td>
              ) : (
                <>
                  <td className={cx(TD, NUM)}>{s.started}</td>
                  <td className={cx(TD, NUM)}>{s.completed}</td>
                  <td className={cx(TD, NUM, "font-extrabold", (s.completionRate ?? 100) < 80 ? "text-warn" : "text-text")}>
                    {s.completionRate}%
                  </td>
                  <td className={cx(TD, NUM, "text-muted")}>{s.avgSkipped}</td>
                </>
              )}
            </tr>
          ))}
        </Table>
      </Panel>

      {data.drift.length ? (
        <Panel title={ut("dq.driftTitle")} icon={<Ic.chart />} hint={ut("dq.psiHint")} flush>
          <Table
            head={
              <>
                <th scope="col" className={TH}>{ut("dq.scale")}</th>
                <th scope="col" className={TH}>{ut("dq.month")}</th>
                <th scope="col" className={cx(TH, "text-right")}>n</th>
                <th scope="col" className={cx(TH, "text-right")}>PSI</th>
                <th scope="col" className={TH}>{ut("dq.verdict")}</th>
              </>
            }
          >
            {data.drift.map((d) => (
              <tr key={d.code}>
                <td className={TD}>
                  <Tag className="mr-2">{d.code}</Tag>
                  {d.title}
                </td>
                <td className={cx(TD, "text-muted")}>{d.month}</td>
                <td className={cx(TD, NUM)}>{d.n}</td>
                <td className={cx(TD, NUM, "font-extrabold text-text")}>{d.psi}</td>
                <td className={TD}>
                  {/*
                    Вердикт дрейфа — степень («заметно изменилась» vs «в
                    пределах шума»), поэтому цвет не работает один: пилюля
                    оставляет текст вердикта видимым всегда.
                  */}
                  {d.psi > 0.2 ? (
                    <SeverityTag level="mild" small>
                      {d.verdict}
                    </SeverityTag>
                  ) : (
                    d.verdict
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Panel>
      ) : null}

      <Panel
        title={ut("dq.repeatTitle")}
        icon={<Rx.repeat />}
        hint={`${ut("dq.iccHintPart1")} ${data.retestWindow.minDays}–${data.retestWindow.maxDays} ${ut("dq.iccHintPart2")}`}
        flush
      >
        <Table
          min={480}
          head={
            <>
              <th scope="col" className={TH}>{ut("dq.scale")}</th>
              <th scope="col" className={cx(TH, "text-right")}>{ut("dq.pairs")}</th>
              <th scope="col" className={cx(TH, "text-right")}>ICC</th>
            </>
          }
        >
          {data.retest.map((r) => (
            <tr key={r.code}>
              <td className={TD}>
                <Tag className="mr-2">{r.code}</Tag>
                {r.title}
              </td>
              <td className={cx(TD, NUM)}>{r.pairs}</td>
              <td className={cx(TD, NUM, r.icc === null ? "text-muted" : "font-extrabold text-text")}>
                {r.icc === null ? (
                  <span>
                    {ut("dq.needAtLeast")}
                    {data.retestWindow.minPairs} {ut("dq.pairsLower")}
                  </span>
                ) : (
                  r.icc
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Panel>
    </Stack>
  );
}
