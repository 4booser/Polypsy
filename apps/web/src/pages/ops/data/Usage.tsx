import { useState } from "react";
import type { UsageReport } from "@quizzy/shared";
import { api } from "../../../api";
import { Figure, HBars, Kpi, TimeColumns } from "../../../charts/clinical";
import { day } from "../../../format";
import { useLang } from "../../../lang";
import { Screen } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Num } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { APP_LABEL, dayColumns, funnelSteps, maybeDayColumns, topScreens, type Window } from "./model";
import { KPI_GRID, MaybeColumns, NUM, Note, PAIR_GRID, TD, TH, WindowSwitch } from "./parts";

/** Полос в рейтинге экранов: больше глаз разом не сравнит, остальное — строкой «інші» и в таблице */
const TOP_SCREENS = 8;

/**
 * «Використання» — какие экраны открывают, сколько людей работает, где
 * пациенты теряются по дороге от приглашения до повторного прохождения.
 *
 * Экраны — по шаблону маршрута (`/patients/:userId`), а не по адресу: кто
 * чью карточку открывал — вопрос журнала чтений, и отвечать на него здесь,
 * мимо журнала и права audit.read, нельзя. Поэтому строка таблицы — шаблон
 * моноширинным, и ничего больше.
 *
 * Пациенты — через порог малых ячеек: «—» значит «меньше порога», а не
 * «никого». Специалисты — числом всегда (обоснование — lib/opsData.ts).
 */
export default function OpsUsage() {
  const [days, setDays] = useState<Window>(30);
  const res = useResource(() => api.opsUsage(days), [days]);
  return (
    <Screen res={res}>
      {(data) => <UsageBody data={data} days={days} onDays={setDays} />}
    </Screen>
  );
}

export function UsageBody({ data, days, onDays }: { data: UsageReport; days: Window; onDays: (w: Window) => void }) {
  const { ut } = useLang();
  const hidden = fill(ut("opsd.hiddenBelow"), { n: data.smallCellFloor });
  const screenCols = dayColumns(data.screens.byDay, (d) => d.views, day);
  const staffCols = dayColumns(data.active.byDay, (d) => d.staff, day);
  const patientCols = maybeDayColumns(data.active.byDay, (d) => d.patients, day);
  const top = topScreens(data.screens.top, data.screens.total, TOP_SCREENS);

  return (
    <>
      <RuleSection title={ut("opsd.u.screens")} hint={ut("opsd.u.screensHint")} actions={<WindowSwitch value={days} onChange={onDays} />}>
        {/*
          Волна 11: графики — над таблицей, таблица — их табличный вид.
          Слева — какие экраны открывают чаще (форма таблицы ниже), справа —
          открытия по дням; до волны 11 он стоял под таблицей один.
        */}
        <div className={cx(PAIR_GRID, "mb-[28px]")}>
          <Figure title={ut("sig.u.topScreens")} caption={fill(ut("sig.u.topCaption"), { n: TOP_SCREENS })}>
            {top.rows.length ? (
              <HBars
                items={[
                  ...top.rows.map((r) => ({
                    key: `${r.app}${r.route}`,
                    label: (
                      <>
                        <span className="text-muted">{ut(APP_LABEL[r.app])}</span> <span className="font-mono text-[12px]">{r.route}</span>
                      </>
                    ),
                    value: r.views,
                  })),
                  ...(top.rest > 0 ? [{ key: "\u0000rest", label: ut("sig.u.otherScreens"), value: top.rest }] : []),
                ]}
              />
            ) : (
              <p className="m-0 text-[13px] text-muted">{ut("opsd.u.noScreens")}</p>
            )}
          </Figure>
          <Figure
            title={ut("opsd.u.viewsByDay")}
            aside={
              <span className="text-[13px] text-muted">
                {ut("opsd.u.total")} <Num className="text-text-2">{data.screens.total}</Num>
              </span>
            }
          >
            <TimeColumns columns={screenCols} label={ut("opsd.u.viewsByDay")} />
          </Figure>
        </div>
        {data.screens.top.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr>
                  <th scope="col" className={TH}>{ut("opsd.u.app")}</th>
                  <th scope="col" className={TH}>{ut("opsd.u.route")}</th>
                  <th scope="col" className={cx(TH, "text-right")}>{ut("opsd.u.views")}</th>
                  <th scope="col" className={cx(TH, "text-right")}>{ut("opsd.u.days")}</th>
                </tr>
              </thead>
              <tbody>
                {data.screens.top.map((r) => {
                  const app = ut(APP_LABEL[r.app]);
                  return (
                    <tr key={`${r.app}${r.route}`}>
                      <td className={cx(TD, "text-muted")}>{app}</td>
                      <td className={cx(TD, "font-mono text-[12px] text-text")}>{r.route}</td>
                      <td className={cx(TD, NUM)}>{r.views}</td>
                      <td className={cx(TD, NUM, "text-muted")}>{r.days}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </RuleSection>

      <RuleSection title={ut("opsd.u.active")} hint={fill(ut("opsd.u.activeHint"), { n: data.smallCellFloor })}>
        <div className={KPI_GRID}>
          <Kpi label={ut("opsd.u.staff7")} value={data.active.staff7} />
          <Kpi label={ut("opsd.u.staff30")} value={data.active.staff30} />
          <Kpi label={ut("opsd.u.patients7")} value={data.active.patients7} hint={data.active.patients7 === null ? hidden : undefined} />
          <Kpi label={ut("opsd.u.patients30")} value={data.active.patients30} hint={data.active.patients30 === null ? hidden : undefined} />
        </div>
        <div className={cx(PAIR_GRID, "mt-[28px]")}>
          <Figure title={ut("opsd.u.staffByDay")}>
            <TimeColumns columns={staffCols} label={ut("opsd.u.staffByDay")} />
          </Figure>
          <Figure title={ut("opsd.u.patientsByDay")} caption={hidden}>
            <MaybeColumns columns={patientCols} label={ut("opsd.u.patientsByDay")} />
          </Figure>
        </div>
        <Note>{ut("opsd.u.sources")}</Note>
      </RuleSection>

      <Funnel funnel={data.funnel} floor={data.smallCellFloor} />
    </>
  );
}

/**
 * Воронка пациента строками: ступень, число, доля от предыдущей показанной.
 *
 * Полосы — HBars от общего нуля до числа приглашений: длина полосы — тоже
 * число, и у скрытой ступени её нет (прочерк без полосы, правило ShareBar).
 * «Без запрошення» — отдельной строкой ниже, а не пятой ступенью: эти люди
 * в воронку не входили, и полоса рядом с остальными читалась бы как её
 * продолжение.
 */
function Funnel({ funnel, floor }: { funnel: UsageReport["funnel"]; floor: number }) {
  const { ut } = useLang();
  const steps = funnelSteps(funnel);
  const items = steps.map((s) => ({
    key: s.key,
    label: ut(s.label),
    value: s.value,
    text:
      s.value === null
        ? undefined
        : s.conversion === null
          ? String(s.value)
          : `${s.value} · ${fill(ut("opsd.u.conv"), { p: s.conversion })}`,
  }));

  return (
    <RuleSection title={ut("opsd.u.funnel")} hint={fill(ut("opsd.u.funnelHint"), { days: funnel.days })}>
      <div className="max-w-[760px]">
        <HBars items={items} />
        <div className="mt-[16px] flex items-baseline justify-between gap-[12px] border-t border-hairline pt-[10px] text-[13px] leading-[18px]">
          <span className="text-text-2">{ut("opsd.u.self")}</span>
          <Num className="text-muted">{funnel.selfRegistered === null ? "—" : funnel.selfRegistered}</Num>
        </div>
      </div>
      <Note>
        {ut("opsd.u.invitesNote")} {fill(ut("opsd.hiddenBelow"), { n: floor })}
      </Note>
    </RuleSection>
  );
}
