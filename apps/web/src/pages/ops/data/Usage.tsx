import { useState } from "react";
import type { UsageReport } from "@quizzy/shared";
import { api } from "../../../api";
import { ShareBar, TimeColumns, TimeLines } from "../../../charts/clinical";
import { SmallCell } from "../../../charts/kit";
import { dayFull } from "../../../format";
import { useLang } from "../../../lang";
import { DataTable, Empty, Screen, type Column } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Ic } from "../../../ui/icons";
import { Panel } from "../../../ui/layout";
import { Button, Tag, type TagTone } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { SectionPage } from "../people2/frame";
import { Ix } from "../people2/icons";
import { Meter, Swatch } from "./charts";
import { Id } from "./icons";
import { APP_LABEL, activeLines, appSplit, dayColumns, funnelSteps, shareOf, topScreens, type Window } from "./model";
import { FootNote, Facts, WindowSwitch, dayTick, dayWithYear, int, pct, usePlural } from "./parts";

/** Шаблонов в таблице сразу; остальные — строкой «інші» и по кнопке «Показати всі» */
const TOP_SCREENS = 8;

/** Пилюля приложения в таблице экранов: консоль — фиолетовым, кабинет — сведениями, приложение — нейтральной */
const APP_TONE: Record<UsageReport["screens"]["top"][number]["app"], TagTone> = {
  console: "primary",
  patient: "info",
  mobile: "plain",
};

/**
 * «Використання» — какие экраны открывают, сколько людей работает, где
 * пациенты теряются по дороге от приглашения до повторного прохождения.
 *
 * Экраны — по шаблону маршрута (`/patients/:userId`), а не по адресу: кто
 * чью карточку открывал — вопрос журнала чтений, и отвечать на него здесь,
 * мимо журнала и права audit.read, нельзя. Поэтому строка таблицы — шаблон
 * моноширинным, и ничего больше.
 *
 * Пациенты — через порог малых ячеек: «n < 5» значит «меньше порога», а не
 * «никого», и линия в такой день рвётся, а не падает в ноль. Специалисты —
 * числом всегда (обоснование — lib/opsData.ts).
 */
export default function OpsUsage() {
  const { ut } = useLang();
  const [days, setDays] = useState<Window>(30);
  const res = useResource(() => api.opsUsage(days), [days]);
  const data = res.data;
  const first = data?.screens.byDay[0]?.date;
  const last = data?.screens.byDay.at(-1)?.date;

  return (
    <SectionPage
      title={ut("opsd.tab.usage")}
      perm="ops.read"
      meta={first && last ? [fill(ut("oppd.window"), { from: dayTick(first), to: dayWithYear(last) }), ut("oppd.u.once")] : undefined}
      actions={<WindowSwitch value={days} onChange={setDays} />}
      lead={
        <>
          {ut("oppd.u.lead")}
          {data ? ` ${fill(ut("oppd.u.leadFloor"), { n: data.smallCellFloor })}` : null}
        </>
      }
    >
      <Screen res={res}>{(d) => <UsageBody data={d} />}</Screen>
    </SectionPage>
  );
}

export function UsageBody({ data }: { data: UsageReport }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="@container">
        <div className="grid items-start gap-4 @min-[860px]:grid-cols-[minmax(0,1fr)_400px]">
          <Active data={data} />
          <Funnel funnel={data.funnel} floor={data.smallCellFloor} />
        </div>
      </div>
      <Screens screens={data.screens} />
    </div>
  );
}

/* ─────────── активные люди ─────────── */

interface ActiveRow {
  key: "staff" | "patients";
  color: string;
  week: number | null;
  month: number | null;
}

function Active({ data }: { data: UsageReport }) {
  const { ut } = useLang();
  const floor = data.smallCellFloor;
  const lines = activeLines(data.active.byDay, dayTick, dayFull);
  const label = (k: ActiveRow["key"]) => (k === "staff" ? ut("oppd.u.staff") : ut("oppd.u.patients"));
  const n = (v: number | null) => (v === null ? <SmallCell floor={floor} /> : <b className="font-extrabold text-text">{int(v)}</b>);
  const rows: ActiveRow[] = [
    { key: "staff", color: "var(--c2)", week: data.active.staff7, month: data.active.staff30 },
    { key: "patients", color: "var(--c1)", week: data.active.patients7, month: data.active.patients30 },
  ];
  const columns: Column<ActiveRow>[] = [
    {
      key: "who",
      header: "",
      required: true,
      render: (r) => (
        <span className="flex items-center gap-2 font-extrabold text-text">
          <Swatch color={r.color} />
          {label(r.key)}
        </span>
      ),
    },
    { key: "week", header: ut("oppd.u.week"), num: true, required: true, width: 150, render: (r) => n(r.week) },
    { key: "month", header: ut("oppd.u.month"), num: true, required: true, width: 150, render: (r) => n(r.month) },
  ];

  return (
    <Panel title={ut("oppd.u.activeTitle")} icon={<Ic.users />} sub={fill(ut("oppd.u.activeSub"), { n: floor })} flush>
      <div className="px-4 pb-3 pt-1">
        <TimeLines
          x={lines.x}
          height={250}
          label={ut("oppd.u.activeTitle")}
          format={int}
          series={[
            { key: "patients", label: ut("oppd.u.patients"), color: "var(--c1)", values: lines.patients },
            { key: "staff", label: ut("oppd.u.staff"), color: "var(--c2)", values: lines.staff },
          ]}
        />
      </div>
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.key} label={ut("oppd.u.activeTitle")} dense sticky={false} />
    </Panel>
  );
}

/* ─────────── путь пациента ─────────── */

/**
 * Воронка пациента строками: ступень, число, полоса и доля от предыдущей
 * показанной ступени.
 *
 * Полоса — от общего нуля до наибольшей ступени: длина полосы — тоже число,
 * и у скрытой ступени её нет («n < 5» без полосы). «Без запрошення» —
 * отдельной строкой ниже, а не пятой ступенью: эти люди в воронку не
 * входили, и полоса рядом с остальными читалась бы как её продолжение.
 */
function Funnel({ funnel, floor }: { funnel: UsageReport["funnel"]; floor: number }) {
  const { ut } = useLang();
  const steps = funnelSteps(funnel);
  const top = Math.max(0, ...steps.map((s) => s.value ?? 0));

  return (
    <Panel title={ut("opsd.u.funnel")} icon={<Ix.route />}>
      <p className="m-0 mb-3 text-caption text-muted">{fill(ut("opsd.u.funnelHint"), { days: funnel.days })}</p>
      <ol className="m-0 list-none p-0">
        {steps.map((s, i) => (
          <li key={s.key} className={cx("pb-2.5", i > 0 && "border-t border-divider pt-2.5")}>
            <div className="flex items-baseline justify-between gap-3 text-small">
              <span className="min-w-0 font-semibold text-text-2">{ut(s.label)}</span>
              {s.value === null ? <SmallCell floor={floor} /> : <b className="font-extrabold tabular-nums text-text">{int(s.value)}</b>}
            </div>
            <Meter className="mt-1.5" value={s.value ?? 0} max={top} />
            {s.conversion !== null ? (
              <div className="mt-1.5 flex items-center gap-1 text-caption text-muted">
                <Id.cornerDownRight size={12} />
                {fill(ut("opsd.u.conv"), { p: s.conversion })}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <Facts
        className="border-t border-divider pt-2.5"
        rows={[
          {
            key: "self",
            label: ut("opsd.u.self"),
            value: funnel.selfRegistered === null ? <SmallCell floor={floor} /> : int(funnel.selfRegistered),
          },
        ]}
      />
      <p className="m-0 mt-2 text-caption text-muted">{ut("opsd.u.invitesNote")}</p>
    </Panel>
  );
}

/* ─────────── экраны ─────────── */

interface ScreenRow {
  key: string;
  app: UsageReport["screens"]["top"][number]["app"] | null;
  route: string | null;
  /** Сколько шаблонов в строке «інші» */
  rest: number;
  views: number;
  days: number | null;
}

function Screens({ screens }: { screens: UsageReport["screens"] }) {
  const { ut } = useLang();
  const plural = usePlural();
  const [all, setAll] = useState(false);
  const limit = all ? screens.top.length : TOP_SCREENS;
  const top = topScreens(screens.top, screens.total, limit);
  const restRoutes = Math.max(0, screens.routes - top.rows.length);
  const rows: ScreenRow[] = [
    ...top.rows.map((r) => ({ key: `${r.app}${r.route}`, app: r.app, route: r.route, rest: 0, views: r.views, days: r.days })),
    ...(top.rest > 0 ? [{ key: "\u0000rest", app: null, route: null, rest: restRoutes, views: top.rest, days: null }] : []),
  ];
  const widest = Math.max(1, ...rows.map((r) => r.views));
  const split = appSplit(screens.byApp);

  const columns: Column<ScreenRow>[] = [
    {
      key: "app",
      header: ut("opsd.u.app"),
      required: true,
      width: 150,
      render: (r) =>
        r.app ? (
          <Tag tone={APP_TONE[r.app]}>{ut(APP_LABEL[r.app])}</Tag>
        ) : (
          <Tag tone="plain">{ut("oppd.u.rest")}</Tag>
        ),
    },
    {
      key: "route",
      header: ut("opsd.u.route"),
      required: true,
      render: (r) =>
        r.route ? (
          <span className="break-all font-mono text-[12px] text-text">{r.route}</span>
        ) : r.rest > 0 ? (
          <span className="text-muted">{plural(r.rest, { one: "oppd.u.restRoutes.one", few: "oppd.u.restRoutes.few", many: "oppd.u.restRoutes.many" })}</span>
        ) : null,
    },
    { key: "views", header: ut("opsd.u.views"), num: true, required: true, width: 100, render: (r) => int(r.views) },
    { key: "days", header: ut("opsd.u.days"), num: true, required: true, width: 64, render: (r) => (r.days === null ? null : r.days) },
    {
      key: "share",
      header: ut("oppd.u.share"),
      required: true,
      width: 140,
      render: (r) => {
        const s = shareOf(r.views, screens.total);
        return (
          <span className="flex items-center gap-2">
            <Meter thin className="flex-1" value={r.views} max={widest} color={r.app ? "var(--c1)" : "var(--c5)"} />
            <span className="w-[44px] shrink-0 text-right text-caption tabular-nums text-muted">{s === null ? "" : pct(s)}</span>
          </span>
        );
      },
    },
  ];

  return (
    <Panel
      title={ut("opsd.u.screens")}
      icon={<Id.appWindow />}
      sub={ut("oppd.u.screensSub")}
      flush
      footer={<FootNote icon={<Ix.eyeOff />}>{ut("oppd.u.privacy")}</FootNote>}
    >
      <div className="@container">
        <div className="grid @min-[940px]:grid-cols-[440px_minmax(0,1fr)]">
          <div className="min-w-0 p-4 @min-[940px]:border-r @min-[940px]:border-divider">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <b className="text-body font-extrabold text-text">{ut("opsd.u.viewsByDay")}</b>
              <span className="text-caption text-muted">
                {ut("opsd.u.total")} <b className="font-extrabold tabular-nums text-text">{int(screens.total)}</b>
              </span>
            </div>
            <TimeColumns
              columns={dayColumns(screens.byDay, (d) => d.views, dayTick).map((c) => ({ ...c, tip: dayFull(c.key) }))}
              height={236}
              label={ut("opsd.u.viewsByDay")}
            />
            <div className="mt-3 border-t border-divider pt-3">
              <div className="flex items-baseline justify-between gap-3 text-small">
                <span className="font-semibold text-text-2">{ut("oppd.u.byApp")}</span>
                <b className="font-extrabold tabular-nums text-text">{int(screens.total)}</b>
              </div>
              <ShareBar
                className="mt-1.5"
                label={ut("oppd.u.byApp")}
                format={int}
                parts={split.map((a) => ({ key: a.app, label: ut(APP_LABEL[a.app]), value: a.views, color: a.color }))}
              />
            </div>
          </div>
          {/* верхнюю черту правой колонке даёт шапка таблицы */}
          <div className="min-w-0">
            {rows.length ? (
              <>
                <DataTable rows={rows} columns={columns} rowKey={(r) => r.key} label={ut("opsd.u.screens")} dense sticky={false} />
                {screens.top.length > TOP_SCREENS ? (
                  <div className="border-t border-divider px-3 py-2">
                    <Button variant="ghost" size="xs" aria-expanded={all} onClick={() => setAll((v) => !v)}>
                      {all ? ut("oppd.u.less") : fill(ut("oppd.u.more"), { n: screens.top.length })}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="px-4">
                <Empty compact title={ut("opsd.u.noScreens")} />
              </div>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}
