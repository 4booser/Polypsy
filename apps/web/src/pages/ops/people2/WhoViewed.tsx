import { Fragment, useMemo, useState } from "react";
import type { PatientPick, Role, UiKey, WhoViewedActor, WhoViewedReport } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { Figure, HBars, TimeColumns } from "../../../charts/clinical";
import { useLang } from "../../../lang";
import { Avatar, Empty, Loading, useAction } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Ic } from "../../../ui/icons";
import { Panel } from "../../../ui/layout";
import { Popover, Tooltip } from "../../../ui/Popover";
import { Button, ButtonLink, Input, Segmented, Tag } from "../../../ui/primitives";
import { useDebounced, useResource } from "../../../useResource";
import { ROLE_KEY, actionLabel } from "../model";
import { SectionPage } from "./frame";
import { Ix } from "./icons";
import { whoViewedCsv, whoViewedActions, whoViewedDays } from "./model";
import { saveText } from "./parts";
import { FootNote, Rich, Sx } from "./securityParts";
import {
  PERIOD_PRESETS,
  actorAs,
  actorLast,
  actorLines,
  clock,
  fill,
  fullDay,
  hiddenDays,
  periodOk,
  pluralForm,
  presetOf,
  presetPeriod,
  reportSummary,
  shortDay,
  stamp,
  type PeriodPreset,
} from "./securityModel";

/*
 * Техпанель → «Хто переглядав» (people2, пункт 21) в «Виразній».
 *
 * Отчёт по запросу пациента или проверяющего: кто из персонала открывал
 * данные этого человека за период — карта, прохождения, заключения, записи
 * приёма, выгрузки, вход от его имени. Сверху — выбор человека и периода;
 * ниже — итог одной фразой, действия по дням и по типу, затем сотрудники
 * строками с раскладкой по дням.
 *
 * Сам отчёт записывается в журнал на сервере (audit.subject_report). CSV —
 * из того же ответа, в браузере: второй поход за тем же ради файла был бы
 * второй строкой журнала о том же. Печать — средствами браузера: выбор и
 * кнопки в печать не идут, раскладка по дням идёт вся, даже свёрнутая.
 *
 * Право — audit.read: это чтение журнала, только в разрезе одного человека.
 */

/** Сколько строк раскладки показывать до «Ще N днів» */
const LINES = 5;

export default function OpsWhoViewed() {
  const { ut } = useLang();
  const { user } = useAuth();
  const { run, busy } = useAction();
  const [q, setQ] = useState("");
  const settled = useDebounced(q.trim());
  const [picked, setPicked] = useState<PatientPick | null>(null);
  const [period, setPeriod] = useState(() => presetPeriod("30", new Date()));
  const [report, setReport] = useState<WhoViewedReport | null>(null);

  const found = useResource(() => api.patientPick(settled), [settled], { enabled: !picked && settled.length >= 2 });
  const label = (action: string) => actionLabel(action, ut);
  const preset = presetOf(period, new Date());
  const valid = periodOk(period);

  const build = () =>
    void run(async () => {
      if (!picked || !valid) return false;
      setReport(await api.whoViewed(picked.id, period.from, period.to));
    });

  return (
    <SectionPage
      title={ut("ops.tab.whoViewed")}
      perm="audit.read"
      meta={[ut("opps.who.metaTitle"), ut("opps.who.metaSub")]}
      lead={ut("opps.who.lead")}
    >
      <div className="flex min-w-0 flex-col gap-4">
        <Panel className="print:hidden">
          <div className="grid items-end gap-4 grid-cols-[minmax(260px,1fr)_auto_auto] max-[1440px]:grid-cols-[minmax(0,1fr)_auto] max-[860px]:grid-cols-1">
            <div className="min-w-0 max-[1240px]:col-span-2 max-[860px]:col-span-1">
              <span id="wv-patient" className="mb-1.5 block text-caption font-bold text-muted">
                {ut("ops.who.patient")}
              </span>
              {picked ? (
                <div
                  role="group"
                  aria-labelledby="wv-patient"
                  className="flex h-10 min-w-0 items-center gap-2.5 rounded-control border border-field-border bg-panel pl-1.5 pr-1"
                >
                  <Avatar name={picked.fullName || picked.email} size={28} tone="violet" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <b className="truncate text-[13px] font-extrabold leading-[17px] text-text">{picked.fullName || picked.email}</b>
                    <small className="truncate text-[11.5px] leading-[15px] text-muted">
                      {[picked.birthYear ? fill(ut("opps.who.born"), { y: picked.birthYear }) : null, picked.email].filter(Boolean).join(", ")}
                    </small>
                  </span>
                  <Tooltip label={ut("ops.who.change")}>
                    <Button
                      variant="quiet"
                      size="icon-sm"
                      icon={<Ix.repeat />}
                      aria-label={ut("ops.who.change")}
                      onClick={() => {
                        setPicked(null);
                        setReport(null);
                      }}
                    />
                  </Tooltip>
                </div>
              ) : (
                <div className="relative">
                  <Input
                    aria-labelledby="wv-patient"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={ut("ops.who.search")}
                    icon={<Ic.search />}
                    autoComplete="off"
                  />
                  {settled.length >= 2 ? (
                    <div className="absolute inset-x-0 top-[calc(100%+6px)] z-30 max-h-[320px] overflow-y-auto rounded-panel border border-border bg-panel p-1.5 shadow-pop">
                      {found.error ? (
                        <Loading bare error={found.error} onRetry={found.reload} />
                      ) : !found.data ? (
                        <p role="status" className="m-0 px-2.5 py-2 text-small text-muted">
                          {ut("opps.who.searching")}
                        </p>
                      ) : found.data.length === 0 ? (
                        <p className="m-0 px-2.5 py-2 text-small text-muted">{ut("pt.nobodyFound")}</p>
                      ) : (
                        <ul className="m-0 list-none p-0" aria-label={ut("ops.who.patient")}>
                          {found.data.map((p) => (
                            <li key={p.id}>
                              <button
                                type="button"
                                onClick={() => {
                                  setPicked(p);
                                  setQ("");
                                  setReport(null);
                                }}
                                className="flex w-full min-h-0 cursor-pointer items-center gap-2.5 rounded-[9px] border-0 bg-transparent px-2 py-1.5 text-left hover:bg-sunk focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
                              >
                                <Avatar name={p.fullName || p.email} size={28} tone="soft" />
                                <span className="flex min-w-0 flex-col">
                                  <b className="truncate text-[13px] font-bold text-text">{p.fullName || p.email}</b>
                                  <small className="truncate text-caption text-muted">
                                    {[p.birthYear ? fill(ut("opps.who.born"), { y: p.birthYear }) : null, p.email].filter(Boolean).join(", ")}
                                  </small>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
            </div>

            {/* на 1280 период — своей строкой под человеком: пресеты и две даты в одну строку не помещаются рядом с ним */}
            <div role="group" aria-labelledby="wv-period" className="min-w-0 max-[1440px]:col-span-2 max-[1440px]:row-start-2 max-[860px]:col-span-1 max-[860px]:row-auto">
              <span id="wv-period" className="mb-1.5 block text-caption font-bold text-muted">
                {ut("ops.who.period")}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented<PeriodPreset | "custom">
                  label={ut("opps.who.presets")}
                  value={preset ?? "custom"}
                  onChange={(p) => {
                    if (p !== "custom") setPeriod(presetPeriod(p, new Date()));
                  }}
                  items={PERIOD_PRESETS.map((p) => ({ key: p, label: ut(`opps.who.preset.${p}` as UiKey) }))}
                />
                <Input
                  type="date"
                  aria-label={ut("ops.audit.from")}
                  value={period.from}
                  max={period.to}
                  onChange={(e) => setPeriod({ ...period, from: e.target.value })}
                  style={{ width: 160 }}
                />
                <span aria-hidden className="text-muted">
                  —
                </span>
                <Input
                  type="date"
                  aria-label={ut("ops.audit.to")}
                  value={period.to}
                  min={period.from}
                  onChange={(e) => setPeriod({ ...period, to: e.target.value })}
                  style={{ width: 160 }}
                />
              </div>
            </div>

            <Button
              variant="primary"
              icon={<Sx.fileSearch2 />}
              disabled={busy || !picked || !valid}
              onClick={build}
              className="max-[1440px]:col-start-2 max-[1440px]:row-start-1 max-[860px]:col-start-auto max-[860px]:row-auto"
            >
              {ut("ops.who.build")}
            </Button>
          </div>
          <FootNote quiet className="mt-3">
            {ut("ops.who.hint")}
          </FootNote>
        </Panel>

        {report ? (
          <ReportPanel key={report.generatedAt} report={report} label={label} author={user?.fullName || user?.email || ""} />
        ) : (
          <Panel className="print:hidden">
            <Empty icon={<Ix.userSearch />} title={ut("ops.who.choose")} hint={ut("opps.who.chooseHint")} />
          </Panel>
        )}
      </div>
    </SectionPage>
  );
}

type SortKey = "name" | "total" | "days";

function ReportPanel({ report, label, author }: { report: WhoViewedReport; label: (action: string) => string; author: string }) {
  const { ut, lang } = useLang();
  const sum = reportSummary(report);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "total", desc: true });
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(report.actors[0] ? [report.actors[0].actorId] : []));
  const [full, setFull] = useState<ReadonlySet<string>>(() => new Set());

  const actors = useMemo(() => {
    const val = (a: WhoViewedActor): string | number =>
      sort.key === "name" ? (a.actorName || a.actorEmail || "").toLocaleLowerCase() : sort.key === "days" ? a.days.length : a.total;
    return [...report.actors].sort((x, y) => {
      const a = val(x);
      const b = val(y);
      const c = a < b ? -1 : a > b ? 1 : 0;
      return sort.desc ? -c : c;
    });
  }, [report, sort]);

  const busiest = useMemo(() => {
    const by = new Map<string, number>();
    for (const a of report.actors) for (const d of a.days) by.set(d.day, (by.get(d.day) ?? 0) + d.actions.reduce((s, x) => s + x.count, 0));
    let best: [string, number] | null = null;
    for (const e of by) if (!best || e[1] > best[1]) best = e;
    return best;
  }, [report]);

  const csv = () =>
    saveText(
      whoViewedCsv(report, label, [
        ut("ops.who.staff"),
        ut("person.email"),
        ut("adm.role"),
        ut("ops.who.day"),
        ut("ops.who.action"),
        ut("ops.who.count"),
        ut("ops.who.first"),
        ut("ops.who.last"),
        ut("ops.who.as"),
      ]),
      `who-viewed-${report.patient.email}-${report.from}-${report.to}.csv`,
    );

  const toggle = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const head = (key: SortKey, text: string, num?: boolean) => {
    const on = sort.key === key;
    return (
      <th
        aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}
        className={cx(TH, num && "text-right", on && "text-text")}
      >
        <button
          type="button"
          onClick={() => setSort({ key, desc: on ? !sort.desc : key !== "name" })}
          className="inline-flex min-h-0 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-bold text-inherit"
        >
          {text}
          {on ? sort.desc ? <Ic.arrowDown size={13} className="text-violet-ink" /> : <Ic.arrowUp size={13} className="text-violet-ink" /> : <Ic.sortable size={13} />}
        </button>
      </th>
    );
  };

  const staffNames = report.actors.map((a) => a.actorName || a.actorEmail || a.actorId).join(", ");

  return (
    <Panel
      as="article"
      title={fill(ut("opps.who.reportTitle"), { name: report.patient.fullName || report.patient.email })}
      icon={<Sx.fileSearch2 />}
      sub={`${shortDay(`${report.from}T12:00:00`, lang)}–${fullDay(`${report.to}T12:00:00`, lang)}`}
      flush
      actions={
        <span className="flex gap-1.5 print:hidden">
          <Button size="xs" icon={<Sx.printer />} onClick={() => window.print()}>
            {ut("ops.who.print")}
          </Button>
          <Button size="xs" icon={<Ic.download />} onClick={csv}>
            {ut("opps.who.csv")}
          </Button>
        </span>
      }
    >
      <div className="px-4 pb-4">
        <p className="m-0 text-caption text-muted">
          {fill(ut("opps.who.generated"), {
            date: fullDay(report.generatedAt, lang),
            time: clock(report.generatedAt, lang),
            who: author,
          })}
        </p>
        <p className="m-0 mt-2 text-[14px] leading-[22px] text-text">
          {report.total ? (
            <Rich
              text={ut(sum.asOther ? "opps.who.summaryAs" : "opps.who.summary")}
              values={{
                total: <b className="font-extrabold tabular-nums">{sum.total}</b>,
                staff: (
                  <Popover title={ut("opps.who.staffPop")} content={<p className="m-0">{staffNames}</p>}>
                    <b tabIndex={0} className="cursor-default rounded-[4px] font-extrabold tabular-nums underline decoration-violet-line decoration-dotted underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-violet-ring">
                      {sum.staff}
                    </b>
                  </Popover>
                ),
                as: <b className="font-extrabold tabular-nums">{sum.asOther}</b>,
                days: busiest ? (
                  <Popover
                    title={ut("opps.who.daysPop")}
                    content={
                      <p className="m-0">
                        {fill(ut("opps.who.busiest"), {
                          day: shortDay(`${busiest[0]}T12:00:00`, lang),
                          n: busiest[1],
                        })}
                      </p>
                    }
                  >
                    <b tabIndex={0} className="cursor-default rounded-[4px] font-extrabold tabular-nums underline decoration-violet-line decoration-dotted underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-violet-ring">
                      {sum.activeDays}
                    </b>
                  </Popover>
                ) : (
                  <b className="font-extrabold tabular-nums">{sum.activeDays}</b>
                ),
                period: <b className="font-extrabold tabular-nums">{sum.periodDays}</b>,
              }}
            />
          ) : (
            ut("ops.who.nobody")
          )}
        </p>
        {report.total ? (
          <div className="mt-4 grid gap-8 grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] max-[1200px]:grid-cols-1 break-inside-avoid-page">
            <Figure title={ut("opsp.who.byDay")} caption={ut("opps.who.byDayHint")}>
              <TimeColumns columns={whoViewedDays(report, (iso) => shortDay(`${iso}T12:00:00`, lang))} height={190} label={ut("opsp.who.byDay")} />
            </Figure>
            <Figure title={ut("opsp.who.byAction")} caption={ut("opps.who.byActionHint")}>
              <HBars items={whoViewedActions(report, label, ut("opsp.others"))} />
            </Figure>
          </div>
        ) : null}
      </div>

      {report.actors.length ? (
        <div className="overflow-x-auto">
          <table aria-label={ut("ops.who.staff")} className="w-full border-separate border-spacing-0 text-body leading-[19px]">
            <thead>
              <tr>
                <th className={cx(TH, "w-11 pr-0")}>
                  <span className="sr-only">{ut("opps.who.expand")}</span>
                </th>
                {head("name", ut("ops.who.staff"))}
                {head("total", ut("opps.who.colActions"), true)}
                {head("days", ut("opps.who.colDays"), true)}
                <th className={TH}>{ut("ops.who.last")}</th>
                <th className={TH}>
                  <span className="sr-only">{ut("opps.who.marks")}</span>
                </th>
                <th className={cx(TH, "print:hidden")}>
                  <span className="sr-only">{ut("ops.susp.inLog")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {actors.map((a) => (
                <ActorRows
                  key={a.actorId}
                  a={a}
                  report={report}
                  label={label}
                  open={open.has(a.actorId)}
                  full={full.has(a.actorId)}
                  onToggle={() => setOpen((s) => toggle(s, a.actorId))}
                  onMore={() => setFull((s) => toggle(s, a.actorId))}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}

const TH =
  "h-[38px] whitespace-nowrap border-y border-divider bg-panel-2 px-2.5 text-left align-middle text-caption font-bold leading-none text-muted first:pl-4 last:pr-4";
const TD = "border-b border-divider px-2.5 py-2 align-middle first:pl-4 last:pr-4";

function ActorRows({
  a,
  report,
  label,
  open,
  full,
  onToggle,
  onMore,
}: {
  a: WhoViewedActor;
  report: WhoViewedReport;
  label: (action: string) => string;
  open: boolean;
  full: boolean;
  onToggle: () => void;
  onMore: () => void;
}) {
  const { ut, lang } = useLang();
  const name = a.actorName || a.actorEmail || a.actorId;
  const lines = actorLines(a);
  const more = hiddenDays(lines, LINES);
  const last = actorLast(a);
  const as = actorAs(a);
  const detailId = `wv-${a.actorId}`;
  const role = a.actorRole && a.actorRole in ROLE_KEY ? ut(ROLE_KEY[a.actorRole as Role]) : null;
  const qs = new URLSearchParams({ actor: a.actorId, subject: report.patient.id, from: report.from, to: report.to });
  return (
    <Fragment>
      <tr className={cx("break-inside-avoid", open && "bg-panel-2")}>
        <td className={cx(TD, "w-11 pr-0")}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={fill(ut("opps.who.expandOne"), { name })}
            onClick={onToggle}
            className={cx(
              "inline-grid size-8 min-h-0 cursor-pointer place-items-center rounded-[9px] border-0 text-text-2 print:hidden",
              open ? "bg-violet-tint text-violet-ink" : "bg-transparent hover:bg-sunk",
            )}
          >
            <Ic.chevronRight size={16} className={cx("transition-transform duration-[var(--dur-fast)]", open && "rotate-90")} />
          </button>
        </td>
        <td className={TD}>
          <span className="flex min-w-0 items-center gap-2.5">
            <Avatar name={name} size={28} tone="soft" />
            <span className="flex min-w-0 flex-col">
              <b className="truncate font-bold leading-[18px] text-text">{name}</b>
              <small className="truncate text-caption text-muted">{[role, a.actorEmail].filter(Boolean).join(", ")}</small>
            </span>
          </span>
        </td>
        <td className={cx(TD, "text-right text-[15px] font-extrabold tabular-nums text-text")}>{a.total}</td>
        <td className={cx(TD, "whitespace-nowrap text-right tabular-nums text-text-2")}>
          {fill(ut(`opps.n.day.${pluralForm(a.days.length, lang)}` as UiKey), { n: a.days.length })}
        </td>
        <td className={cx(TD, "whitespace-nowrap tabular-nums text-text-2")}>{last ? stamp(last, lang) : "—"}</td>
        <td className={TD}>
          <span className="flex flex-wrap gap-1">
            {as.map((email) => (
              <Tooltip key={email} label={ut("opps.who.asTip")}>
                <span tabIndex={0} className="inline-flex rounded-pill outline-none focus-visible:ring-2 focus-visible:ring-violet-ring">
                  <Tag tone="attention" icon={<Ix.venetianMask />}>
                    {fill(ut("opps.who.asTag"), { who: email })}
                  </Tag>
                </span>
              </Tooltip>
            ))}
          </span>
        </td>
        <td className={cx(TD, "text-right print:hidden")}>
          <ButtonLink to={`/ops/audit?${qs}`} variant="quiet" size="xs" className="gap-1.5">
            <Ix.fileSearch />
            {ut("ops.susp.inLog")}
          </ButtonLink>
        </td>
      </tr>
      <tr id={detailId} className={cx(open ? "" : "hidden print:table-row", "break-inside-avoid")}>
        <td colSpan={7} className="border-b border-divider bg-panel-2 pb-4 pl-[58px] pr-4 pt-1">
          <div className="grid grid-cols-[64px_minmax(0,1fr)_56px_84px_92px] items-center gap-x-3 border-b border-divider py-1.5 text-[11.5px] font-bold leading-4 text-muted">
            <span>{ut("ops.who.day")}</span>
            <span>{ut("ops.who.action")}</span>
            <span className="text-right">{ut("ops.who.count")}</span>
            <span>{ut("ops.who.first")}</span>
            <span>{ut("ops.who.last")}</span>
          </div>
          {lines.map((l, i) => (
            <div
              key={l.key}
              className={cx(
                "grid min-h-8 grid-cols-[64px_minmax(0,1fr)_56px_84px_92px] items-center gap-x-3 border-b border-divider py-1 text-small leading-[18px] text-text-2 last:border-b-0",
                i >= LINES && !full && "hidden print:grid",
              )}
            >
              <span className="font-bold tabular-nums text-text">{shortDay(`${l.day}T12:00:00`, lang)}</span>
              <span className="min-w-0 text-text">
                {label(l.action)}
                {l.asUserEmail ? (
                  <span className="text-muted"> {fill(ut("opps.who.asLine"), { who: l.asUserEmail })}</span>
                ) : null}
              </span>
              <span className="text-right font-extrabold tabular-nums text-text">{l.count}</span>
              <span className="tabular-nums">{clock(l.first, lang)}</span>
              <span className="tabular-nums">{clock(l.last, lang)}</span>
            </div>
          ))}
          {lines.length > LINES ? (
            <div className="mt-1.5 print:hidden">
              <Button variant="ghost" size="xs" icon={<Sx.chevronsDown />} aria-expanded={full} onClick={onMore}>
                {full
                  ? ut("opps.who.less")
                  : more
                    ? fill(ut(`opps.who.moreDays.${pluralForm(more, lang)}` as UiKey), { n: more })
                    : fill(ut("opps.who.moreLines"), { n: lines.length - LINES })}
              </Button>
            </div>
          ) : null}
        </td>
      </tr>
    </Fragment>
  );
}
