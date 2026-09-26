import { useState } from "react";
import type { MobileReport } from "@quizzy/shared";
import { api } from "../../../api";
import { Figure, Kpi, ShareBar, TimeColumns } from "../../../charts/clinical";
import { dateTime, day } from "../../../format";
import { useLang } from "../../../lang";
import { Screen } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Tag } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { PLATFORM_LABEL, dayColumns, lagParts, lateParts, type Window } from "./model";
import { KPI_GRID, NUM, PAIR_GRID, TD, TH, WindowSwitch } from "./parts";

/**
 * «Мобільний застосунок» — на каких сборках сидят люди, что застряло в
 * очередях на телефонах, какие сдачи пришли с опозданием.
 *
 * Сборка важна не сама по себе: приложение считает баллы офлайн тем же
 * движком, что и сервер (docs/ARCHITECTURE.md), и исправление в движке
 * доходит до человека только с новой сборкой. Поэтому «на старых сборках» —
 * янтарём, когда их больше нуля: это ровно «требует внимания».
 *
 * Падения здесь не собираются: их сбор — у раздела ошибок клиента
 * техпанели. Место под его сводку оставлено разделом внизу.
 */
export default function OpsMobile() {
  const [days, setDays] = useState<Window>(90);
  const res = useResource(() => api.opsMobile(days), [days]);
  return <Screen res={res}>{(data) => <MobileBody data={data} days={days} onDays={setDays} />}</Screen>;
}

export function MobileBody({ data, days, onDays }: { data: MobileReport; days: Window; onDays: (w: Window) => void }) {
  const { ut } = useLang();
  const lag = (ms: number | null) => {
    const p = lagParts(ms);
    return p ? fill(ut(p.unit), { n: p.n }) : null;
  };

  return (
    <>
      <RuleSection title={ut("opsd.m.versions")} hint={ut("opsd.m.versionsHint")} actions={<WindowSwitch value={days} onChange={onDays} />}>
        <div className={KPI_GRID}>
          <Kpi label={ut("opsd.m.devices")} value={data.devices.total} />
          <Kpi
            label={ut("opsd.m.old")}
            value={data.old.devices}
            tone={data.old.devices > 0 ? "attention" : "plain"}
            hint={data.old.percent === null ? undefined : fill(ut("opsd.m.oldShare"), { p: data.old.percent })}
          />
          <Kpi label={ut("opsd.m.newest")} value={data.newest} />
          <Kpi label={ut("opsd.m.unknown")} value={data.devices.unknown} hint={ut("opsd.m.unknownHint")} />
        </div>
        {data.versions.length ? (
          <div className="mt-[24px] overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse">
              <thead>
                <tr>
                  <th scope="col" className={TH}>{ut("opsd.m.platform")}</th>
                  <th scope="col" className={TH}>{ut("opsd.m.version")}</th>
                  <th scope="col" className={TH}>{ut("opsd.m.build")}</th>
                  <th scope="col" className={cx(TH, "text-right")}>{ut("opsd.m.devicesCol")}</th>
                  <th scope="col" className={TH}>{ut("opsd.m.lastSeen")}</th>
                </tr>
              </thead>
              <tbody>
                {data.versions.map((v) => {
                  const platform = v.platform ? (PLATFORM_LABEL[v.platform] ? ut(PLATFORM_LABEL[v.platform]!) : v.platform) : "—";
                  return (
                    <tr key={`${v.platform}|${v.version}|${v.build}`}>
                      <td className={cx(TD, "text-muted")}>{platform}</td>
                      <td className={TD}>
                        <span className="font-mono tabular-nums text-text">{v.version ?? "—"}</span>
                        {v.old ? <Tag tone="attention" className="ml-[8px]">{ut("opsd.m.oldTag")}</Tag> : null}
                      </td>
                      <td className={cx(TD, "font-mono tabular-nums text-muted")}>{v.build ?? "—"}</td>
                      <td className={cx(TD, NUM)}>{v.devices}</td>
                      <td className={cx(TD, "text-muted")}>{dateTime(v.lastSeenAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="m-0 mt-[16px] text-[13px] text-muted">{ut("opsd.m.noDevices")}</p>
        )}
      </RuleSection>

      <RuleSection title={ut("opsd.m.queue")} hint={ut("opsd.m.queueHint")}>
        <div className={KPI_GRID}>
          <Kpi label={ut("opsd.m.reporting")} value={data.queue.devicesReporting} />
          <Kpi
            label={ut("opsd.m.pending")}
            value={data.queue.pending}
            hint={fill(ut("opsd.m.onDevices"), { n: data.queue.devicesWithPending })}
          />
          {/* отклонённые сами не повторяются — ждут человека: вот это и требует внимания */}
          <Kpi
            label={ut("opsd.m.rejected")}
            value={data.queue.rejected}
            tone={data.queue.rejected > 0 ? "attention" : "plain"}
            hint={fill(ut("opsd.m.onDevices"), { n: data.queue.devicesWithRejected })}
          />
        </div>
      </RuleSection>

      <RuleSection title={ut("opsd.m.late")} hint={ut("opsd.m.lateHint")}>
        <div className={KPI_GRID}>
          <Kpi
            label={ut("opsd.m.lateTotal")}
            value={data.late.total}
            hint={fill(ut("opsd.m.lateOf"), { n: data.late.submitted })}
          />
          {/* null, а не ноль: у пустой выборки медианы нет, и «0 хв» соврало бы */}
          <Kpi label={ut("opsd.m.median")} value={lag(data.late.medianLagMs)} />
          <Kpi label={ut("opsd.m.p90")} value={lag(data.late.p90LagMs)} />
        </div>
        <div className={cx(PAIR_GRID, "mt-[28px]")}>
          <Figure title={ut("opsd.m.lateBuckets")}>
            <ShareBar
              label={ut("opsd.m.lateBuckets")}
              parts={lateParts(data.late.buckets).map((p) => ({ key: p.key, label: ut(p.label), value: p.value, step: p.step }))}
            />
          </Figure>
          <Figure title={ut("opsd.m.lateByDay")}>
            <TimeColumns columns={dayColumns(data.late.byDay, (d) => d.count, day)} label={ut("opsd.m.lateByDay")} />
          </Figure>
        </div>
      </RuleSection>

      {/*
        Падения. Сбор — у раздела ошибок клиента техпанели (участок
        наблюдаемости): второй сборщик здесь дублировал бы его и расходился
        с ним в числах. Место оставлено, чтобы сводка встала сюда без
        перестройки экрана.
      */}
      <RuleSection title={ut("opsd.m.crashes")}>
        <p className="m-0 max-w-[760px] text-[13px] leading-[18px] text-muted">{ut("opsd.m.crashesHint")}</p>
      </RuleSection>
    </>
  );
}
