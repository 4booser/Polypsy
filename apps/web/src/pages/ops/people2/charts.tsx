import type {
  AuditDaily,
  GrantStats,
  MfaCoverageRow,
  OpsSessionsSummary,
  OpsUsersSummary,
  Role,
  SuspiciousStats,
  UiKey,
  WhoViewedReport,
} from "@quizzy/shared";
import { api } from "../../../api";
import { Figure, HBars, ShareBar, TimeColumns } from "../../../charts/clinical";
import { day, locale } from "../../../format";
import { useLang } from "../../../lang";
import { Loading } from "../../../ui";
import { cx } from "../../../ui/cx";
import { NoData } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { ROLE_KEY } from "../model";
import {
  STEP_KEY,
  ageParts,
  auditColumns,
  coverageBars,
  findingColumns,
  grantParts,
  loginColumns,
  mfaParts,
  newAccountColumns,
  ruleBars,
  sessionRoleBars,
  stateParts,
  weekColumns,
  whoViewedActions,
  whoViewedDays,
  type StackSeries,
} from "./model";
import { FIGURE_GRID, Section, ShareRows, StackColumns } from "./parts";

/*
 * Графики разделов людей техпанели (волна 11, участок people).
 *
 * Решение заказчика 2026-09-26: «должны быть графики в админ панеле». Каждый
 * раздел, у данных которого есть форма, показывает её НАД своей таблицей;
 * таблица остаётся — это и есть «табличный вид» графика для чтения и
 * диктора.
 *
 * Каждая фигура — парой: `…Body` рисует готовые данные (его проверяют без
 * сети, apps/web/test/opsPeopleChartsRender.test.tsx), обёртка без суффикса
 * сама ходит за ними. Ряды считаются в model.ts.
 *
 * Цвет — по правилам набора: один ряд — фиолетовый действия; части одного
 * целого — светлотой того же фиолетового (ShareBar, step); два независимых
 * ряда — фиолетовый действия и фоновый --series-quiet в постоянном порядке
 * с легендой (--cat-* — синий и оранжевый старой палитры, в консоли чужие); янтарь — только у того, что требует внимания: неудачные входы,
 * отказы в журнале, нерозібрані срабатывания. Статус нигде не цветом в
 * одиночку — рядом подпись легенды.
 */

const PRIMARY = "var(--primary)";
const ATTENTION = "var(--accent)";

const roleLabel = (ut: (k: UiKey) => string) => (role: Role) => ut(ROLE_KEY[role]);

/* ═══════════ Користувачі ═══════════ */

/** «Зведення реєстру» над списком учёток — весь реестр, без отбора списка */
export function UsersOverview() {
  const { ut } = useLang();
  const res = useResource(() => api.opsUsersSummary(), []);
  return (
    <RuleSection
      title={ut("opsp.users.section")}
      hint={res.data ? fill(ut("opsp.users.sectionHint"), { n: res.data.smallCellFloor }) : undefined}
    >
      {res.error ? <Loading error={res.error} onRetry={res.reload} /> : !res.data ? <Loading rows={4} /> : <UsersOverviewBody data={res.data} />}
    </RuleSection>
  );
}

export function UsersOverviewBody({ data }: { data: OpsUsersSummary }) {
  const { ut } = useLang();
  const label = roleLabel(ut);
  const staff = data.roles.filter((r) => r.mfa);
  const accounts: StackSeries[] = [
    { key: "staff", label: ut("opsp.series.staff"), color: "var(--primary)" },
    { key: "patients", label: ut("opsp.series.patients"), color: "var(--series-quiet)" },
  ];
  const logins: StackSeries[] = [
    { key: "success", label: ut("opsp.series.success"), color: PRIMARY },
    { key: "failed", label: ut("opsp.series.failed"), color: ATTENTION },
  ];
  return (
    <div className={FIGURE_GRID}>
      <Figure title={ut("opsp.users.states")} caption={ut("opsp.users.statesHint")}>
        <ShareRows rows={data.roles.map((r) => ({ key: r.role, title: label(r.role), total: r.total, parts: stateParts(r, ut) }))} />
      </Figure>
      <Figure title={ut("opsp.users.mfa")} caption={ut("opsp.users.mfaHint")}>
        <ShareRows rows={staff.map((r) => ({ key: r.role, title: label(r.role), total: r.mfa!.total, parts: mfaParts(r.mfa!, ut) }))} />
      </Figure>
      <Figure
        title={ut("opsp.users.newByWeek")}
        caption={fill(ut("opsp.users.newByWeekHint"), { n: data.newByWeek.length, floor: data.smallCellFloor })}
      >
        <StackColumns series={accounts} columns={newAccountColumns(data.newByWeek, day)} label={ut("opsp.users.newByWeek")} />
      </Figure>
      <Figure title={ut("opsp.users.logins")} caption={fill(ut("opsp.users.loginsHint"), { n: data.loginsByDay.length })}>
        <StackColumns series={logins} columns={loginColumns(data.loginsByDay, day)} label={ut("opsp.users.logins")} />
      </Figure>
    </div>
  );
}

/* ═══════════ Сесії ═══════════ */

/**
 * «Зведення сесій»: по роли и по возрасту. Устройства и клиента нет — у
 * refresh-токена их нет, и об этом сказано в пояснении раздела, а не
 * умолчано.
 */
export function SessionsOverview() {
  const { ut } = useLang();
  const res = useResource(() => api.opsSessionsSummary(), []);
  return (
    <RuleSection title={ut("opsp.sess.section")} hint={ut("opsp.sess.sectionHint")}>
      {res.error ? <Loading error={res.error} onRetry={res.reload} /> : !res.data ? <Loading rows={3} /> : <SessionsOverviewBody data={res.data} />}
    </RuleSection>
  );
}

export function SessionsOverviewBody({ data }: { data: OpsSessionsSummary }) {
  const { ut } = useLang();
  return (
    <div className={FIGURE_GRID}>
      <Figure title={ut("opsp.sess.byRole")}>
        <HBars items={sessionRoleBars(data.byRole, roleLabel(ut))} />
      </Figure>
      <Figure title={ut("opsp.sess.byAge")} caption={ut("opsp.sess.byAgeHint")}>
        <ShareRows
          rows={data.byAge.map((g) => ({
            key: g.group,
            title: ut(g.group === "staff" ? "opsp.series.staff" : "opsp.series.patients"),
            total: g.total,
            parts: ageParts(g.buckets, ut),
          }))}
        />
      </Figure>
    </div>
  );
}

/* ═══════════ Аудит ═══════════ */

/** Подпись корзины: день и неделя — датой начала, месяц — месяцем с годом */
function bucketLabel(iso: string, step: AuditDaily["step"]): string {
  if (step !== "month") return day(iso);
  const [y, m] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString(locale(), { month: "short", year: "2-digit" });
}

/**
 * Записи журнала по текущему отбору во времени. `query` — тот же
 * устоявшийся отбор (JSON), по которому грузится таблица: график и строки
 * под ним обязаны говорить об одном и том же.
 */
export function AuditTimeline({ query }: { query: string }) {
  const res = useResource(() => api.auditDaily(JSON.parse(query) as Record<string, string>), [query]);
  if (res.error && !res.data) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading rows={3} />;
  return <AuditTimelineBody data={res.data} />;
}

export function AuditTimelineBody({ data }: { data: AuditDaily }) {
  const { ut } = useLang();
  const series: StackSeries[] = [
    { key: "ok", label: ut("opsp.series.ok"), color: PRIMARY },
    { key: "refused", label: ut("opsp.series.refused"), color: ATTENTION },
  ];
  return (
    <Figure
      title={ut("opsp.audit.chart")}
      caption={`${day(data.from)} — ${day(data.to)} · ${ut(STEP_KEY[data.step])}. ${ut("opsp.audit.chartHint")}`}
      className="mb-[24px]"
    >
      <StackColumns series={series} columns={auditColumns(data, bucketLabel)} height={160} label={ut("opsp.audit.chart")} />
    </Figure>
  );
}

/* ═══════════ Підозріла активність ═══════════ */

export function SuspiciousOverviewBody({ stats }: { stats: SuspiciousStats }) {
  const { ut } = useLang();
  const series: StackSeries[] = [
    { key: "resolved", label: ut("opsp.series.resolved"), color: PRIMARY },
    { key: "open", label: ut("opsp.series.open"), color: ATTENTION },
  ];
  return (
    <div className={FIGURE_GRID}>
      <Figure title={ut("opsp.susp.byRule")} caption={ut("opsp.susp.byRuleHint")}>
        <HBars items={ruleBars(stats.byRule, ut)} />
      </Figure>
      <Figure title={ut("opsp.susp.byDay")} caption={fill(ut("opsp.susp.byDayHint"), { n: stats.days })}>
        <StackColumns series={series} columns={findingColumns(stats.byDay, day)} label={ut("opsp.susp.byDay")} />
      </Figure>
    </div>
  );
}

/* ═══════════ Тимчасові доступи ═══════════ */

export function GrantsOverviewBody({ stats }: { stats: GrantStats }) {
  const { ut } = useLang();
  const parts = grantParts(stats, ut);
  const weeks = weekColumns(stats.byWeek, day);
  return (
    <Section title={ut("opsp.overview")}>
      <div className={FIGURE_GRID}>
        <Figure title={ut("opsp.grants.states")} caption={ut("opsp.grants.statesHint")}>
          {parts.some((p) => (p.value ?? 0) > 0) ? <ShareBar parts={parts} label={ut("opsp.grants.states")} /> : <NoData />}
        </Figure>
        <Figure title={ut("opsp.grants.byWeek")} caption={fill(ut("opsp.grants.byWeekHint"), { n: stats.byWeek.length })}>
          {weeks.some((w) => w.value > 0) ? <TimeColumns columns={weeks} height={180} label={ut("opsp.grants.byWeek")} /> : <NoData />}
        </Figure>
      </div>
    </Section>
  );
}

/* ═══════════ Хто переглядав ═══════════ */

/**
 * Над отчётом: действия по дням и что именно делали. Имён здесь нет —
 * они в разделах отчёта ниже; график отвечает «когда и что», таблица —
 * «кто». Пустой отчёт графиков не получает: «никто не открывал» сказано
 * словами под заголовком.
 */
export function WhoViewedCharts({ report, label }: { report: WhoViewedReport; label: (action: string) => string }) {
  const { ut } = useLang();
  if (!report.total) return null;
  return (
    <div className={cx(FIGURE_GRID, "mb-[24px] break-inside-avoid-page")}>
      <Figure title={ut("opsp.who.byDay")} caption={ut("opsp.who.byDayHint")}>
        <TimeColumns columns={whoViewedDays(report, day)} height={180} label={ut("opsp.who.byDay")} />
      </Figure>
      <Figure title={ut("opsp.who.byAction")} caption={ut("opsp.who.byActionHint")}>
        <HBars items={whoViewedActions(report, label, ut("opsp.others"))} />
      </Figure>
    </div>
  );
}

/* ═══════════ Другий фактор ═══════════ */

/**
 * Охват по причине требования — над списком покрытия. Ось 0–100 %: у доли
 * другой оси нет, и полоса «2 з 3» должна быть короче полной, а не равна ей.
 */
export function MfaCoverageChart({ coverage }: { coverage: readonly MfaCoverageRow[] }) {
  const { ut } = useLang();
  const bars = coverageBars(coverage, ut);
  if (!bars.length) return null;
  return (
    <Figure title={ut("opsp.mfa.coverage")} caption={ut("opsp.mfa.coverageHint")} className="mb-[24px] max-w-[560px]">
      <HBars items={bars} max={100} />
    </Figure>
  );
}
