import { useCallback, useState, type ReactNode } from "react";
import type { AlertCase, AppointmentView, DashWidget, Page as CursorPage, Worklist } from "@quizzy/shared";
import { DASH_WIDGETS } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { dayFull } from "../format";
import { Screen, useUrlState } from "../ui";
import { Button, ButtonLink } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { useLiveReload } from "../events";
import { Suggestions } from "../components/Suggestions";
import { StartHead } from "./Start";
import { CustomizeDrawer } from "./dashboard/Customize";
import { ConditionsWidget } from "./dashboard/parts";
import { PassesWidget } from "./dashboard/passes";
import { CasesWidget, CollectWidget, DayWidget, MissedWidget, WorkWidget } from "./dashboard/widgets";
import { WIDGET_COLUMN, fill, localDay, periodTotals, widgetLayout, type WidgetLayout } from "./dashboard/model";
import { unlessForbidden } from "./today/ActNow";
import { Di } from "./today/icons";

/**
 * «Зведення» — огляд зміни (кадр day-start Polypsy 2.0).
 *
 * Віджети, а не плитки: у каждого своя панель с квадратом значка, своё
 * число в подписи и дверь туда, где с этим работают. Порядок задан, но
 * настраивается: сначала то, что требует действия сейчас (випадки ризику,
 * прийом сьогодні, «поки вас не було», черга), потом объём работы
 * (проходження, методики та збір), потом состояние людей (стан за
 * напрямами). Порядок и выключенные хранятся в профиле
 * («Налаштувати зведення»), случаи риска не выключаются.
 *
 * Колонка віджета — по его природе: широкие — слева, списки — справа,
 * таблица направлений — во всю ширину (WIDGET_COLUMN).
 */

/* отказ очереди не должен прятать сводку — отдаём пустую, но полной формы */
const NO_WORK: Worklist = {
  items: [],
  total: 0,
  truncated: false,
  byKind: { noshow: 0, message: 0, dispensary: 0, followup: 0, referral: 0, assignment: 0 },
  mine: 0,
};

export default function Dashboard() {
  const { ut } = useLang();
  const { user } = useAuth();
  /*
   * Ящик настройки — в адресе (`?customize=1`): смена стартового экрана
   * перестраивает «/», и ящик должен пережить это, а не закрыться посреди
   * настройки (Customize.tsx переводит на «/?view=overview»).
   */
  const [customizeParam, setCustomizeParam] = useUrlState("customize");
  const customize = customizeParam === "1";
  const setCustomize = (open: boolean) => setCustomizeParam(open ? "1" : "");
  /* правка из ящика видна сразу, до ответа сервера */
  const [local, setLocal] = useState<WidgetLayout | null>(null);
  const layout = local ?? widgetLayout(user?.workspace?.dashboard);

  /*
   * Одна загрузка на сводку, очередь и день: экран без сводки неполон,
   * остальное — дополнение, и отказ любого из них не повод прятать всё.
   */
  const res = useResource(async () => {
    const [overview, work, day] = await Promise.all([
      api.overview(),
      api.worklist().catch((): Worklist => NO_WORK),
      api
        .today()
        .then((d) => d.items)
        .catch((): AppointmentView[] | null => null),
    ]);
    return { overview, work, day };
  }, []);
  /*
   * Случаи — своей загрузкой: «разбор не положен» (403, null) прячет
   * віджет, а сбой загрузки — нет. Віджет случаев риска не выключается и
   * настройкой, и пропасть из-за обрыва связи ему тоже нельзя (unlessForbidden).
   */
  const cases = useResource(() => unlessForbidden(api.alertCases({ status: "open", limit: "6" })), []);
  const reloadOverview = res.reload;
  const reloadCases = cases.reload;
  const reload = useCallback(() => {
    reloadOverview();
    reloadCases();
  }, [reloadOverview, reloadCases]);
  // сводка дежурного стареет от чужих действий: сдача, тревога, тик расписания
  useLiveReload(["alert.created", "case.changed", "response.submitted", "schedule.run"], reload);
  const alerts: CursorPage<AlertCase> | null = cases.data;
  const casesPending = alerts === null && (cases.loading || cases.offline);

  const today = localDay(new Date());
  const visible = layout.order.filter((k) => !layout.hidden.has(k));

  return (
    <>
      <StartHead
        meta={
          <>
            <b className="font-extrabold text-text">{dayFull(today)}</b>
            <span>
              {res.data
                ? fill(ut("dashA.metaLine"), {
                    /* не пришли или не положены — прочерк, а не «0»: ноль здесь звучал бы как «рисков нет» */
                    cases: alerts ? (alerts.total ?? alerts.items.length) : "—",
                    work: res.data.work.total,
                    sessions: res.data.day?.filter((a) => a.status !== "cancelled").length ?? 0,
                  })
                : ut("common.loading")}
            </span>
          </>
        }
        actions={
          <>
            <Button icon={<Di.dashboard />} aria-expanded={customize} onClick={() => setCustomize(true)}>
              {ut("dashA.customize")}
            </Button>
            {user?.canInvite ? (
              <ButtonLink to="/invites?new=1" variant="primary">
                <Di.link />
                {ut("inv.create")}
              </ButtonLink>
            ) : null}
          </>
        }
      />
      <Screen res={res} rows={5}>
        {({ overview, work, day }) => {
          const { current, previous } = periodTotals(overview.timeline, 30, localDay(new Date()));
          const node: Record<DashWidget, ReactNode> = {
            cases: (
              <CasesWidget
                alerts={alerts}
                meId={user?.id ?? null}
                loading={casesPending}
                error={cases.error}
                onRetry={reloadCases}
                updatedAt={cases.updatedAt}
              />
            ),
            day: <DayWidget items={day} />,
            missed: <MissedWidget />,
            work: <WorkWidget work={work} />,
            passes: <PassesWidget overview={overview} />,
            collect: <CollectWidget overview={overview} cur={current} delta={current - previous} />,
            conditions: <ConditionsWidget />,
          };
          const col = (c: "main" | "side" | "full") =>
            visible.filter((k) => WIDGET_COLUMN[k] === c).map((k) => <div key={k}>{node[k]}</div>);
          return (
            <div className="flex flex-col gap-4">
              {/*
                Предложения правил стоят выше всего, но это подсказка, а не
                сигнал: нет предложений — блока нет вовсе.
              */}
              <Suggestions />
              <div className="grid grid-cols-[minmax(0,1fr)_440px] items-start gap-4 max-[1360px]:grid-cols-[minmax(0,1fr)_400px] max-[1080px]:grid-cols-1">
                <div className="flex min-w-0 flex-col gap-4">{col("main")}</div>
                <div className="flex min-w-0 flex-col gap-4">{col("side")}</div>
              </div>
              {col("full")}
              <p className="m-0 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pb-2 text-small text-text-2">
                <Di.dashboard size={14} className="text-muted" />
                {fill(ut("dashA.shownNote"), {
                  n: visible.length,
                  of: DASH_WIDGETS.length,
                  start: ut(START_TITLE[user?.workspace?.startScreen ?? "dashboard"] ?? "dash.title"),
                })}
                <button
                  type="button"
                  onClick={() => setCustomize(true)}
                  className="cursor-pointer border-0 bg-transparent p-0 text-small font-bold text-violet-ink hover:underline"
                >
                  {ut("dashA.change")}
                </button>
              </p>
            </div>
          );
        }}
      </Screen>
      <CustomizeDrawer open={customize} onClose={() => setCustomize(false)} layout={layout} onLayout={setLocal} />
    </>
  );
}

const START_TITLE: Record<string, "dash.title" | "work.title" | "nav.cases" | "nav.patients"> = {
  dashboard: "dash.title",
  worklist: "work.title",
  alerts: "nav.cases",
  patients: "nav.patients",
};
