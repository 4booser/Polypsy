import { api } from "../api";
import { useResource } from "../useResource";
import { severityColor, severityKey } from "../format";
import { useLang } from "../lang";
import { Empty, Loading, useUrlState } from "../ui";
import { Page, Panel, Grid, Stack } from "../ui/layout";
import { Button, Input, Select, Stat, SeverityTag } from "../ui/primitives";

/**
 * Состояние подразделения за период.
 *
 * Отвечает на вопрос начальника отделения — «что с людьми», — не давая при
 * этом посмотреть на конкретного человека: для этого есть карта пациента, и
 * она под другим доступом.
 *
 * Малые ячейки скрыты и помечены прочерком, а не нулём. В роте на двенадцать
 * человек строка «выраженная: 1» указывает на конкретного, и по ней его
 * узнают сослуживцы; ноль же читался бы как «таких нет».
 */
export default function UnitReportPage() {
  const { ut } = useLang();
  const [unit, setUnit] = useUrlState("unit");
  const [from, setFrom] = useUrlState("from");
  const [to, setTo] = useUrlState("to");
  // список подразделений — выбор; его отказ не должен прятать сам отчёт
  const units = useResource(() => api.unitReportUnits(), []).data ?? [];

  const res = useResource(
    () => api.unitReport(unit, from || undefined, to || undefined),
    [unit, from, to],
    { enabled: !!unit },
  );
  const { data, error } = res;

  return (
    <Page
      title={ut("nav.unitReport")}
      sub={ut("unit.sub")}
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            aria-label={ut("ui.unit")}
            className="max-w-[220px]"
          >
            <option value="">— {ut("ui.unit")} —</option>
            {units.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </Select>
          <label className="flex items-center gap-1.5 text-caption text-muted">
            <span>{ut("ec.since")}</span>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-label={ut("ur.periodStart")}
              className="max-w-[160px]"
            />
          </label>
          <label className="flex items-center gap-1.5 text-caption text-muted">
            <span>{ut("sch.to")}</span>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-label={ut("ur.periodEnd")}
              className="max-w-[160px]"
            />
          </label>
        </div>
      }
      actions={data ? <Button onClick={() => window.print()}>{ut("unit.print")}</Button> : null}
    >
      {!unit ? (
        <Empty compact title={ut("unit.choose")} hint={ut("unit.chooseHint")} />
      ) : error ? (
        <p className="text-danger">{error}</p>
      ) : !data ? (
        <Loading rows={5} />
      ) : (
        <Stack>
          <Grid min={196}>
            <Panel>
              <Stat value={data.coverage} unit="%" label={ut("unit.coverage")} />
              <p className="m-0 mt-1 text-caption text-muted">
                {ut("unit.measured")} {data.measured} / {data.people}
              </p>
            </Panel>
            <Panel>
              <Stat value={data.responses} label={ut("dash.responses")} />
            </Panel>
            <Panel>
              <Stat value={data.atRisk} tone={data.atRisk ? "danger" : "plain"} label={ut("unit.atRisk")} />
              <p className="m-0 mt-1 text-caption text-muted">
                {data.atRisk === null
                  ? `${ut("unit.lessThan")} ${data.smallCellFloor} ${ut("unit.hiddenBelowFloor")}`
                  : ut("unit.atLeastOneScale")}
              </p>
            </Panel>
            <Panel>
              <Stat value={data.surveys.length} label={ut("dash.surveys")} />
            </Panel>
          </Grid>

          <Panel
            title={ut("unit.distribution")}
            hint={`${ut("unit.cellsBelow")} ${data.smallCellFloor} ${ut("unit.cellsHiddenReason")}`}
            flush
          >
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>{ut("sum.scale")}</th>
                    <th className="num">{ut("sum.measurements")}</th>
                    <th>{ut("unit.distribution")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.scales.map((s) => (
                    <tr key={s.code}>
                      <td>
                        <strong>{s.code}</strong> <span className="text-muted">{s.title}</span>
                      </td>
                      <td className="num">{s.total}</td>
                      <td>
                        <div className="sev-bar-row">
                          {s.breakdown.map((b) => (
                            <span
                              key={b.severity}
                              className="sev-seg"
                              style={{ width: `${b.percent}%`, background: severityColor[b.severity] }}
                              title={`${ut(severityKey[b.severity])}: ${b.count ?? ut("unit.hiddenValue")} (${b.percent}%)`}
                            />
                          ))}
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {s.breakdown.map((b) => (
                            <SeverityTag key={b.severity} level={b.severity}>
                              {ut(severityKey[b.severity])} {b.count === null ? "—" : b.count} · {b.percent}%
                            </SeverityTag>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.scales.length === 0 ? (
                <p className="m-0 p-5 text-muted">
                  {ut("unit.tooFewMeasurements")} {data.smallCellFloor} {ut("unit.summaryNotBuilt")}
                </p>
              ) : null}
            </div>
          </Panel>

          <Panel title={ut("nav.surveys")} flush>
            <div className="overflow-x-auto">
              <table>
                <thead>
                  <tr>
                    <th>{ut("nav.surveys")}</th>
                    <th className="num">{ut("dash.responses")}</th>
                    <th className="num">{ut("unit.people")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.surveys.map((s) => (
                    <tr key={s.surveyId}>
                      <td>{s.title}</td>
                      <td className="num">{s.responses}</td>
                      <td className="num">{s.people}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </Stack>
      )}
    </Page>
  );
}
