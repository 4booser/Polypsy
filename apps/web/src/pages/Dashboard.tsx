import { useState } from "react";
import { Link } from "react-router-dom";
import type { AlertCase, OverviewAnalytics, Page as CursorPage, Worklist } from "@quizzy/shared";
import { api } from "../api";
import { Figure, Kpi, TimeColumns } from "../charts/clinical";
import { day, duration, severityKey } from "../format";
import { Screen } from "../ui";
import { ButtonLink, Num, SeverityTag, Tag } from "../ui/primitives";
import { RuleSection } from "../ui/section";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { useLiveReload } from "../events";
import { Suggestions } from "../components/Suggestions";
import { describeWork } from "../workText";
import { ConditionsSection, PeriodSwitch } from "./dashboard/parts";
import {
  WORK_KIND,
  dailyColumns,
  fill,
  localDay,
  periodTotals,
  weeklyColumns,
  weeklyCounts,
  workTiles,
} from "./dashboard/model";

/**
 * «Зведення» — первая вкладка стартового экрана.
 *
 * Редизайн по просьбе заказчика 2026-09-26: «тут редизайн по стилю, нужные
 * графики сделай типо прохождений тестов за последнее время, средний уровень
 * стресса, депрессии, тревоги и подобное». Экран собран из пяти блоков, и
 * порядок их задан, а не сложился: сначала то, что требует действия сегодня,
 * потом очередь, потом объём работы, потом состояние людей.
 *
 *   1. Случаи на разбор и просрочки — единственное место с янтарём.
 *   2. Очередь работы — строками консоли, а не карточками.
 *   3. Проходження за останній час — столбцы по дням или неделям и плитки.
 *   4. Стан пацієнтів за напрямами — доля в клинических полосах и средний
 *      балл основной методики (pages/dashboard/parts.tsx, сервер —
 *      routes/dashboard.ts).
 *
 * Что ушло и почему. Линия «Динаміка проходжень» с заливкой — счёт по дням
 * это отдельные корзины, и линия между ними рисовала промежуточные значения,
 * которых не было (см. TimeColumns). Кольцо «Вираженість за всіма шкалами»
 * считало строки баллов, а не людей: методика с одиннадцатью шкалами давала
 * одиннадцать отметок; его вопрос теперь отвечает «Усі методики разом» — по
 * человеку один раз. Область по неделям и «Навантаження за методиками» — их
 * вопросы («больше ли тяжёлых», «чем занято отделение») отвечают ход среднего
 * в каждом направлении и столбцы проходжень; таблица «Усі методики» — это
 * каталог тестов, и второй его копии на стартовом экране не нужно.
 */

type Range = "30d" | "12w";

/* отказ очереди не должен прятать сводку — отдаём пустую, но полной формы */
const NO_WORK: Worklist = {
  items: [],
  total: 0,
  truncated: false,
  byKind: { noshow: 0, message: 0, dispensary: 0, followup: 0, referral: 0, assignment: 0 },
  mine: 0,
};

export default function Dashboard() {
  /*
   * Три запроса одной загрузкой: экран без сводки неполон, а очередь и случаи
   * — дополнение, и их отказ (нет права разбирать случаи) не повод прятать
   * всё остальное. Раньше отказ случаев гасил сводку целиком — у того, кому
   * разбор не положен, стартовый экран не открывался вовсе.
   *
   * Состояние по направлениям грузится отдельно (ConditionsSection): у него
   * свой период, и смена периода не должна перезапрашивать очередь.
   */
  const res = useResource(async () => {
    const [overview, alerts, work] = await Promise.all([
      api.overview(),
      api.alertCases({ limit: "6" }).catch((): CursorPage<AlertCase> | null => null),
      // очередь работы — то, с чего начинается день; её отказ не должен прятать остальную сводку
      api.worklist().catch((): Worklist => NO_WORK),
    ]);
    return { overview, alerts, work };
  }, []);
  // сводка дежурного стареет от чужих действий: сдача, тревога, тик расписания
  useLiveReload(["alert.created", "case.changed", "response.submitted", "schedule.run"], res.reload);

  return (
    <Screen res={res} rows={5}>
      {({ overview, alerts, work }) => (
        <div className="flex flex-col">
          {/*
            Предложения правил стоят выше всего, но это подсказка, а не
            сигнал. Если предложений нет, блок не рисуется вовсе — постоянный
            пустой заголовок быстро становится невидимым.
          */}
          <Suggestions />
          <Attention alerts={alerts} work={work} />
          <WorkQueue work={work} inProgress={overview.inProgress} />
          <Passes overview={overview} />
          <ConditionsSection />
        </div>
      )}
    </Screen>
  );
}

/* ─────────── 1. требует внимания ─────────── */

export function Attention({ alerts, work }: { alerts: CursorPage<AlertCase> | null; work: Worklist }) {
  const { ut } = useLang();
  const openCases = alerts ? (alerts.total ?? alerts.items.length) : 0;
  /*
   * Не имена, а то, что помогает решить, идти ли разбирать сейчас.
   *
   * Сами случаи со сводки убраны давно: имена людей со сработавшей тревогой
   * на первом экране — это раскрытие того самого факта, ради сокрытия
   * которого в системе есть коды вместо имён и спрятанный телефон. Экран
   * открывается первым и висит на мониторе весь день; вместо фамилий —
   * сколько срочных и сколько ждёт самый давний. Имена — в двух нажатиях, на
   * экране разбора, куда просто так не заглядывают.
   */
  const urgent = alerts ? alerts.items.filter((x) => x.severity === "severe").length : 0;
  const oldest = alerts?.items.length
    ? Math.max(...alerts.items.map((x) => Math.floor((Date.now() - new Date(x.openedAt).getTime()) / 86_400_000)))
    : 0;
  const tiles = workTiles(work.byKind);

  if (!openCases && !tiles.length) return null;

  return (
    <div className="mb-[32px] flex flex-col gap-[20px]">
      {openCases ? (
        /*
          Без рамки и подложки: внимание держит число, набранное крупно и
          янтарём, а не коробка вокруг. Янтарная заливка здесь уже была и
          ушла — на светлой теме она роняла контраст текста на себе ниже 4,5:1
          (нашла это проверка доступности, а не глаз).
        */
        <div className="flex flex-wrap items-center gap-x-[20px] gap-y-[12px]">
          <span className="font-mono text-[40px] leading-none tabular-nums text-accent">{openCases}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[17px] font-bold leading-[20px] text-text">{ut("dash.casesOpen")}</span>
            <span className="block text-[13px] leading-[18px] text-muted">
              {urgent > 0 ? `${ut("dash.casesUrgent").replace("{n}", String(urgent))} · ` : ""}
              {ut("dash.casesOldest").replace("{n}", String(oldest))}
            </span>
          </span>
          <ButtonLink to="/alerts" className="shrink-0">
            {ut("dash.review")}
          </ButtonLink>
        </div>
      ) : null}

      {/*
        Разбивка очереди по видам работы. «71» ничего не говорит о том, что
        именно ждёт; шесть чисел отвечают сразу, а нажатие ведёт в
        отфильтрованную очередь, а не в общий список. Пустые виды не
        показываются, янтарь — только у просроченных (model.ts, workTiles).
      */}
      {tiles.length ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-[16px]">
          {tiles.map((t) => (
            <Link
              key={t.kind}
              to={`/worklist?kind=${t.kind}`}
              className="group block rounded-[5px] no-underline outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
            >
              <Kpi
                label={ut(WORK_KIND[t.kind])}
                value={t.count}
                tone={t.attention ? "attention" : "plain"}
                className="h-full transition-shadow duration-[var(--dur-fast)] group-hover:shadow-[0_0_0_1px_var(--primary-rule)]"
              />
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ─────────── 2. очередь ─────────── */

export function WorkQueue({ work, inProgress }: { work: Worklist; inProgress: OverviewAnalytics["inProgress"] }) {
  const { ut } = useLang();
  return (
    /*
      `grid-cols-1` на узком — не лишнее. Без него у сетки одна неявная
      колонка размером `auto`, то есть по самому длинному содержимому, и
      обрезанная многоточием строка очереди растягивала её на ширину всей
      строки текста: на телефоне страница уезжала вбок на 160px.
    */
    <div className={inProgress.length ? "grid grid-cols-1 gap-x-[45px] min-[900px]:grid-cols-[minmax(0,1fr)_300px]" : ""}>
      <RuleSection
        title={ut("work.title")}
        actions={
          <Link to="/worklist" className="text-[13px] font-bold text-primary no-underline hover:underline">
            {fill(ut("dash.workAll"), { n: work.total })} →
          </Link>
        }
      >
        {work.items.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">{ut("work.nothing")}</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {work.items.slice(0, 7).map((i) => (
              /*
                Строка списка консоли: имя 17/700 ссылкой, за ним то, что
                различает строки, — вид работы и срок, — потом метки. Сначала
                различающее, потом общее: семь строк с одинаковой методикой,
                различающиеся только фамилией, выбрать не помогают.
              */
              <li
                key={`${i.kind}-${i.id}`}
                className="flex min-h-[58px] flex-wrap items-center gap-x-[16px] gap-y-[4px] border-b border-hairline py-[10px]"
              >
                <Link
                  to={i.href || "/worklist"}
                  className="max-w-full shrink-0 truncate text-[17px] font-bold leading-[20px] text-primary no-underline hover:underline"
                >
                  {i.userName}
                </Link>
                <span className="min-w-0 flex-1 basis-[200px] truncate text-[13px] leading-[18px] text-muted">
                  {[i.unit, describeWork(i, ut)].filter(Boolean).join(" · ")}
                </span>
                {i.severity ? <SeverityTag level={i.severity}>{ut(severityKey[i.severity])}</SeverityTag> : null}
                {/* «Прострочено» — обычным регистром: капители в консоли нет, метка — не крик */}
                {i.overdue ? <Tag tone="attention">{ut("dash.overdueTag")}</Tag> : null}
                <span className="w-[72px] shrink-0 text-right font-mono text-[12px] text-muted tabular-nums">
                  {day(i.since)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </RuleSection>

      {inProgress.length ? (
        /*
         * Кто прямо сейчас за экраном. Смысл в оперативности: если человек
         * застрял или закрыл приложение посреди методики, специалист узнаёт
         * об этом сегодня, а не при разборе назначений через месяц.
         */
        <RuleSection title={ut("dash.inProgress")} actions={<Num className="text-[13px] text-muted">{inProgress.length}</Num>}>
          <ul className="m-0 list-none p-0">
            {inProgress.slice(0, 6).map((r) => (
              <li key={r.responseId} className="flex min-h-[44px] items-center gap-[12px] border-b border-hairline text-[13px]">
                <span aria-hidden className="size-[8px] shrink-0 rounded-full bg-primary" />
                <span className="min-w-0 flex-1 truncate text-text-2">{r.surveyTitle}</span>
                <Num className="text-muted">{duration(Date.now() - new Date(r.lastSavedAt).getTime())}</Num>
              </li>
            ))}
          </ul>
        </RuleSection>
      ) : null}
    </div>
  );
}

/* ─────────── 3. проходження ─────────── */

/**
 * Проходження за останній час.
 *
 * Четыре прежние плитки остались — они отвечают на «сколько всего» и
 * графиком не дублируются. Столбцы — на «сколько за последнее время», по
 * дням за 30 дней или по неделям за 12: день показывает ритм недели
 * (выходные, день приёма), неделя — направление за квартал. Плитка справа
 * — итог окна рядом с таким же окном перед ним и ход за полгода линией:
 * полгода длиннее любого из двух окон, так что линия не повторяет столбцы.
 */
export function Passes({ overview }: { overview: OverviewAnalytics }) {
  const { ut } = useLang();
  const [range, setRange] = useState<Range>("30d");
  const today = localDay(new Date());
  const weekly = range === "12w";
  const columns = weekly
    ? weeklyColumns(overview.timeline, 12, today, day)
    : dailyColumns(overview.timeline, 30, today, day);
  const totals = periodTotals(overview.timeline, weekly ? 84 : 30, today);
  const title = weekly ? ut("dash.byWeek") : ut("dash.byDay");

  return (
    <RuleSection
      title={ut("dash.passes")}
      actions={
        <PeriodSwitch
          label={ut("dash.rangeLabel")}
          value={range}
          onChange={setRange}
          options={[
            ["30d", ut("dash.range30d")],
            ["12w", ut("dash.range12w")],
          ]}
        />
      }
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-[16px]">
        <Kpi
          label={ut("dash.responses")}
          value={overview.responseCount}
          hint={`${ut("dash.completion")} ${overview.completionRate}%`}
        />
        <Kpi label={ut("dash.respondents")} value={overview.respondentCount} />
        <Kpi label={ut("dash.surveys")} value={overview.surveyCount} hint={`${ut("dash.published")} ${overview.publishedCount}`} />
        <Kpi label={ut("dash.avgTime")} value={duration(overview.avgDurationMs)} />
      </div>

      <div className="mt-[28px] grid grid-cols-1 gap-x-[32px] gap-y-[20px] min-[900px]:grid-cols-[minmax(0,1fr)_240px]">
        <Figure title={title} caption={weekly ? ut("dash.byWeekHint") : undefined}>
          <TimeColumns columns={columns} label={title} />
        </Figure>
        <Kpi
          className="self-start"
          label={weekly ? ut("dash.last12w") : ut("dash.last30d")}
          value={totals.current}
          spark={weeklyCounts(overview.timeline, 26, today)}
          hint={
            <>
              {fill(ut("dash.prevPeriod"), { n: totals.previous })}
              <br />
              {ut("dash.halfYear")}
            </>
          }
        />
      </div>
    </RuleSection>
  );
}
