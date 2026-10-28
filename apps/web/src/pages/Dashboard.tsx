import { useCallback, useState, type ReactNode } from "react";
import type { AlertCase, AppointmentView, DashWidget, Page as CursorPage, Worklist } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { Loading, Screen, Skeleton, useUrlState } from "../ui";
import { Ic } from "../ui/icons";
import { Panel } from "../ui/layout";
import { Button } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { useLiveReload } from "../events";
import { Suggestions } from "../components/Suggestions";
import { StartHead } from "./Start";
import { CustomizeDrawer } from "./dashboard/Customize";
import { ConditionsWidget } from "./dashboard/parts";
import { PassesWidget } from "./dashboard/passes";
import { CasesWidget, CollectWidget, DayWidget, MissedWidget, WorkWidget } from "./dashboard/widgets";
import { WIDGET_COLUMN, boardScope, fill, localDay, periodTotals, widgetLayout, type WidgetLayout } from "./dashboard/model";
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
  const { user, can } = useAuth();
  /*
   * Ящик настройки — в адресе (`?customize=1`): смена стартового экрана
   * перестраивает «/», и ящик должен пережить это, а не закрыться посреди
   * настройки (Customize.tsx переводит на «/?view=overview»).
   */
  const [customizeParam, setCustomizeParam] = useUrlState("customize");
  const customize = customizeParam === "1";
  const setCustomize = (open: boolean) => setCustomizeParam(open ? "1" : "");
  /*
   * Что доступно и что стоит по умолчанию — по роли (boardScope): счёт
   * отделения у специалиста выключен, пока он сам его не включит.
   */
  const scope = boardScope(user, can);
  /* правка из ящика видна сразу, до ответа сервера */
  const [local, setLocal] = useState<WidgetLayout | null>(null);
  const layout = local ?? widgetLayout(user?.workspace?.dashboard, scope);
  const visible = layout.order.filter((k) => !layout.hidden.has(k));

  /*
   * Очередь и день — одной загрузкой: отказ любого из них не повод прятать
   * всё, они приходят пустыми полной формы.
   */
  const res = useResource(async () => {
    const [work, day] = await Promise.all([
      api.worklist().catch((): Worklist => NO_WORK),
      api
        .today()
        .then((d) => d.items)
        .catch((): AppointmentView[] | null => null),
    ]);
    return { work, day };
  }, []);
  /*
   * Сводка аналитики — своей загрузкой и только когда она на экране: её
   * читают два віджета счёта отделения, и у специалиста они выключены. Без
   * права analytics.read маршрут ответил бы отказом — тогда не спрашиваем
   * вовсе (віджетов нет в раскладке, widgetLayout).
   */
  const wantOverview = visible.includes("passes") || visible.includes("collect");
  const overview = useResource(() => (wantOverview ? api.overview() : Promise.resolve(null)), [wantOverview]);
  /*
   * Случаи — своей загрузкой: «разбор не положен» (403, null) прячет
   * віджет, а сбой загрузки — нет. Віджет случаев риска не выключается и
   * настройкой, и пропасть из-за обрыва связи ему тоже нельзя (unlessForbidden).
   */
  const cases = useResource(() => unlessForbidden(api.alertCases({ status: "open", limit: "6" })), []);
  const reloadDay = res.reload;
  const reloadOverview = overview.reload;
  const reloadCases = cases.reload;
  const reload = useCallback(() => {
    reloadDay();
    reloadOverview();
    reloadCases();
  }, [reloadDay, reloadOverview, reloadCases]);
  // сводка дежурного стареет от чужих действий: сдача, тревога, тик расписания
  useLiveReload(["alert.created", "case.changed", "response.submitted", "schedule.run"], reload);
  const alerts: CursorPage<AlertCase> | null = cases.data;
  const casesPending = alerts === null && (cases.loading || cases.offline);

  return (
    <>
      <StartHead
        /*
         * Без даты: сегодняшнее число и время уже стоят на полосе приложения,
         * а зведення всегда про сегодня — второй раз в шапке оно ничего не
         * сообщало.
         */
        meta={
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
        }
        actions={
          /*
           * Главного действия у зведення нет: это обзор, а не форма.
           * «Створити запрошення» стояло здесь фиолетовой кнопкой и читалось
           * главным делом смены; оно — главное на своей вкладке «Запрошення»,
           * в один щелчок отсюда, и в палитре команд.
           */
          <Button icon={<Di.dashboard />} aria-expanded={customize} onClick={() => setCustomize(true)}>
            {ut("dashA.customize")}
          </Button>
        }
      />
      <Screen res={res} rows={5}>
        {({ work, day }) => {
          const ov = overview.data;
          const totals = ov ? periodTotals(ov.timeline, 30, localDay(new Date())) : null;
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
            passes: ov ? (
              <PassesWidget overview={ov} />
            ) : (
              <PendingWidget title={ut("dash.passes")} icon={<Di.columns />} error={overview.error} onRetry={reloadOverview} />
            ),
            collect:
              ov && totals ? (
                <CollectWidget overview={ov} cur={totals.current} delta={totals.current - totals.previous} />
              ) : (
                <PendingWidget title={ut("dashA.collect")} icon={<Ic.clipboard />} error={overview.error} onRetry={reloadOverview} />
              ),
            conditions: <ConditionsWidget />,
          };
          const col = (c: "main" | "side" | "full") =>
            visible.filter((k) => WIDGET_COLUMN[k] === c).map((k) => <div key={k}>{node[k]}</div>);
          return (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-[minmax(0,1fr)_440px] items-start gap-4 max-[1360px]:grid-cols-[minmax(0,1fr)_400px] max-[1080px]:grid-cols-1">
                <div className="flex min-w-0 flex-col gap-4">{col("main")}</div>
                <div className="flex min-w-0 flex-col gap-4">{col("side")}</div>
              </div>
              {/*
                Предложения правил — под случаями риска и приёмом дня, а не над
                ними: это подсказка, а не сигнал. Стояли выше всего, и с шагами
                скрининга каталога (десять правил на отделение) экран дня
                открывался стеной «що далі», а риск уезжал за край. Нет
                предложений — блока нет вовсе.
              */}
              <Suggestions />
              {col("full")}
              {/*
                Строки «Показано 7 віджетів з 7. Стартовий екран — …. Змінити»
                под віджетами больше нет: она повторяла «Налаштувати зведення»
                из шапки.
              */}
            </div>
          );
        }}
      </Screen>
      <CustomizeDrawer open={customize} onClose={() => setCustomize(false)} layout={layout} scope={scope} onLayout={setLocal} />
    </>
  );
}

/** Віджет счёта отделения, пока сводка в пути или не пришла: на своём месте, с «повторити» */
function PendingWidget({ title, icon, error, onRetry }: { title: string; icon: ReactNode; error: string | null; onRetry: () => void }) {
  const { ut } = useLang();
  return (
    <Panel title={title} icon={icon}>
      {error ? (
        <Loading bare error={error} onRetry={onRetry} />
      ) : (
        <div role="status" aria-label={ut("common.loading")}>
          <Skeleton lines={3} />
        </div>
      )}
    </Panel>
  );
}
