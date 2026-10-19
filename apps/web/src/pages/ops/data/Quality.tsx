import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { DataCheck } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { HBars } from "../../../charts/clinical";
import { timeOfDay } from "../../../format";
import { useLang } from "../../../lang";
import { Callout, Empty, Screen, useAction, useToast } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Ic } from "../../../ui/icons";
import { Panel } from "../../../ui/layout";
import { Button, ButtonLink, Tabs, Tag } from "../../../ui/primitives";
import { useUrlState } from "../../../ui/urlState";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { SectionPage } from "../people2/frame";
import { Ix } from "../people2/icons";
import {
  CHECK_KIND,
  CHECK_TEXT,
  KIND_UNIT,
  QUALITY_JOB,
  bySurveyHref,
  checkSummary,
  exampleHref,
  extraRows,
  findingsOf,
  qualityView,
  type QualityView,
} from "./model";
import { Facts, Label, LevelTag, int, stamp, usePlural } from "./parts";

/** Как часто спрашивать итог, пока идёт ручная перепроверка, и когда перестать */
const RECHECK_POLL_MS = 4_000;
const RECHECK_WAIT_MS = 3 * 60_000;

/** Методик в строке находки пилюлями; остальные — числом «+N», целиком — в раскрытой строке */
const CHIPS = 3;

/**
 * «Якість даних» — несостыковки записей по всей базе (lib/dataChecks.ts).
 *
 * Не то же, что вкладка «Якість» аналитики методики: там — как люди
 * заполняют одну методику (доходимость, дрейф, тест-ретест), здесь — не
 * разошлись ли между собой сами записи: прохождение без версии, балл на
 * шкале чужой редакции, подсчёт без полос. Ссылка на ту вкладку стоит
 * заметкой внизу, чтобы два вопроса не путали и не искали одно в другом.
 *
 * «Виразна»: сработавшие проверки — таблицей «від небезпечнішого» (порядок
 * сервера: сначала то, что уже врёт), строка раскрывается на месте — чем
 * опасно, числа сверх основного, примеры и разбивка по методикам. Чистые —
 * одной панелью строк с галочкой: двенадцать пустых разделов заслонили бы
 * две настоящие находки. Вкладки сверху — по уровню.
 *
 * Ничего не чинит и кнопок «исправить» не несёт: клиническая запись не
 * правится молча, а чинить её — работа того, кто видит протокол целиком.
 * «Перевірити знову» — ручной запуск той же задачи, что идёт по расписанию
 * (data.quality, ops.manage): экран показывает сохранённый итог, а не
 * прогоняет проверки на каждое открытие (#189).
 */
export default function OpsDataQuality() {
  const { ut } = useLang();
  const { can } = useAuth();
  const toast = useToast();
  const { run, busy } = useAction();
  /*
   * Ручная перепроверка идёт фоном: сервер отвечает «запущено» сразу, а итог
   * пишет задача. Экран спрашивает итог, пока checkedAt не сменится, — но не
   * дольше трёх минут: задача, упавшая молча, не должна держать опрос вечно.
   */
  const [waiting, setWaiting] = useState<{ prev: string; since: number } | null>(null);
  const res = useResource(() => api.opsDataQuality(), [], { pollMs: waiting ? RECHECK_POLL_MS : undefined });
  const [rawView, setView] = useUrlState("level", "all");
  const view = qualityView(rawView);
  const data = res.data;

  /* каждый ответ опроса (updatedAt) — повод сверить: итог сменился или ждать уже нечего */
  const answeredAt = res.updatedAt;
  useEffect(() => {
    if (!waiting || !data || answeredAt === null) return;
    if (data.checkedAt !== waiting.prev) {
      setWaiting(null);
      toast(ut("oppd.q.done"), "ok");
    } else if (answeredAt - waiting.since > RECHECK_WAIT_MS) {
      setWaiting(null);
    }
  }, [data, answeredAt, waiting, toast, ut]);

  const recheck = () => {
    if (!data) return;
    const prev = data.checkedAt;
    void run(async () => {
      await api.opsRunJob(QUALITY_JOB);
      setWaiting({ prev, since: Date.now() });
    }, fill(ut("oppd.q.started"), { t: timeOfDay(new Date().toISOString()) }));
  };

  const sum = data ? checkSummary(data.checks) : null;
  const fired = sum ? sum.error + sum.warning + sum.info : 0;

  return (
    <SectionPage
      title={ut("opsd.tab.quality")}
      perm="ops.read"
      meta={
        data
          ? [
              fill(ut("oppd.q.meta"), { n: fired, total: data.checks.length }),
              fill(ut("opsd.q.checkedAt"), { at: stamp(data.checkedAt) }),
            ]
          : undefined
      }
      actions={
        can("ops.manage") ? (
          <Button icon={<Ic.refresh />} disabled={!data || busy || waiting !== null} onClick={recheck}>
            {ut("oppd.q.recheck")}
          </Button>
        ) : null
      }
      lead={ut("opsd.q.summaryHint")}
      toolbar={
        sum ? (
          <Tabs
            label={ut("oppd.q.tabs")}
            items={(
              [
                ["all", ut("oppd.q.findings"), fired],
                ["error", ut("opsd.q.errors"), sum.error],
                ["warning", ut("opsd.q.warnings"), sum.warning],
                ["info", ut("opsd.q.infos"), sum.info],
                ["clean", ut("opsd.q.cleanOne"), sum.clean],
              ] as const
            ).map(([key, label, count]) => ({
              id: `dq-tab-${key}`,
              label,
              count,
              active: view === key,
              onSelect: () => setView(key),
            }))}
          />
        ) : undefined
      }
    >
      <Screen res={res}>{(d) => <QualityBody checks={d.checks} view={view} />}</Screen>
    </SectionPage>
  );
}

export function QualityBody({ checks, view = "all" }: { checks: readonly DataCheck[]; view?: QualityView }) {
  const { ut } = useLang();
  const findings = findingsOf(checks, view);
  const clean = checks.filter((c) => c.count === 0);

  return (
    <div className="flex flex-col gap-4">
      {view !== "clean" ? (
        <Panel
          title={ut("oppd.q.findings")}
          icon={<Ix.badgeCheck />}
          count={findings.length}
          sub={ut("oppd.q.order")}
          flush
        >
          {findings.length ? (
            /* своя таблица на вкладку: при смене вкладки раскрыта первая находка этой вкладки */
            <FindingsTable key={view} checks={findings} />
          ) : (
            <div className="px-4 pb-2">
              <Empty compact title={view === "all" ? ut("oppd.q.allClean") : ut("oppd.q.noFindings")} />
            </div>
          )}
        </Panel>
      ) : null}

      {view === "all" || view === "clean" ? (
        <Panel
          title={ut("opsd.q.cleanOne")}
          icon={<Ic.circleCheck />}
          tone="good"
          sub={fill(ut("oppd.q.ofTotal"), { n: clean.length, total: checks.length })}
        >
          {clean.length ? (
            <ul className="m-0 grid list-none gap-x-6 gap-y-3 p-0 min-[900px]:grid-cols-2">
              {clean.map((c) => (
                <li key={c.key} className="flex min-w-0 items-center gap-2 text-body font-semibold text-text-2">
                  <Ic.circleCheck size={15} className="text-good" />
                  <span className="min-w-0">{ut(CHECK_TEXT[c.key].title)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty compact title={ut("oppd.q.noClean")} />
          )}
        </Panel>
      ) : null}

      <Callout
        kind="violet"
        icon={<Ic.chart />}
        actions={
          <ButtonLink to="/analytics/tests?view=quality" variant="paper" size="xs">
            <Ic.external size={14} />
            {ut("opsd.q.surveyQualityLink")}
          </ButtonLink>
        }
      >
        {ut("opsd.q.surveyQuality")}
      </Callout>
    </div>
  );
}

/** Решётка таблицы находок: раскрытие, уровень, проверка, сколько, примеры */
const TH =
  "h-[38px] whitespace-nowrap border-y border-divider bg-panel-2 px-2.5 text-left align-middle text-caption font-bold leading-none text-muted first:pl-4 last:pr-4";

function FindingsTable({ checks }: { checks: readonly DataCheck[] }) {
  const { ut } = useLang();
  /* первая находка раскрыта: самое опасное видно сразу, остальные — по нажатию */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(checks[0] ? [checks[0].key] : []));
  const toggle = (key: string, on?: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (on ?? !next.has(key)) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <div className="overflow-x-auto">
      <table aria-label={ut("oppd.q.findings")} className="w-full min-w-[640px] table-fixed border-separate border-spacing-0 text-body">
        <colgroup>
          <col className="w-[52px]" />
          <col className="w-[150px]" />
          <col />
          <col className="w-[120px]" />
          <col className="w-[130px]" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className={TH}>
              <span className="sr-only">{ut("oppd.q.details")}</span>
            </th>
            <th scope="col" className={TH}>
              {ut("oppd.q.level")}
            </th>
            <th scope="col" className={TH}>
              {ut("oppd.q.check")}
            </th>
            <th scope="col" className={cx(TH, "text-right")}>
              {ut("oppd.q.count")}
            </th>
            <th scope="col" className={TH}>
              <span className="sr-only">{ut("opsd.q.examples")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <Finding key={c.key} check={c} open={open.has(c.key)} onToggle={(on) => toggle(c.key, on)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Finding({ check, open, onToggle }: { check: DataCheck; open: boolean; onToggle: (on?: boolean) => void }) {
  const { ut } = useLang();
  const plural = usePlural();
  const examplesRef = useRef<HTMLDivElement>(null);
  const [focusExamples, setFocusExamples] = useState(false);
  const text = CHECK_TEXT[check.key];
  const kind = CHECK_KIND[check.key];
  const detailsId = `dq-${check.key.replace(/\W/g, "-")}`;
  const td = cx("border-b border-divider px-2.5 py-2 align-middle first:pl-4 last:pr-4", open && "bg-panel-2");

  /* «Приклади» раскрывает строку и ставит фокус на первый пример: ссылки — то, ради чего нажимали */
  useEffect(() => {
    if (!focusExamples || !open) return;
    examplesRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    setFocusExamples(false);
  }, [focusExamples, open]);

  const chips = check.bySurvey.slice(0, CHIPS);
  const more = check.bySurvey.length - chips.length;
  const extras = extraRows(check.extra);

  return (
    <>
      <tr
        className="group/row cursor-pointer"
        onClick={(e) => {
          // нажатие по ссылке или кнопке — их действие, а не раскрытие строки
          if ((e.target as HTMLElement).closest("a, button")) return;
          onToggle();
        }}
      >
        <td className={td}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={`${ut("oppd.q.details")}: ${ut(text.title)}`}
            onClick={() => onToggle()}
            className={cx(
              "inline-grid size-8 min-h-0 cursor-pointer place-items-center rounded-[9px] border-0 p-0 text-muted",
              "hover:bg-sunk hover:text-text focus-visible:outline-2 focus-visible:outline-[var(--focus)]",
              open ? "bg-violet-tint text-violet-ink" : "bg-transparent",
            )}
          >
            {open ? <Ic.chevronDown size={16} /> : <Ic.chevronRight size={16} />}
          </button>
        </td>
        <td className={td}>
          <LevelTag level={check.level} />
        </td>
        <td className={td}>
          <div className="flex min-w-0 flex-col gap-1.5 py-1">
            <b className="text-body font-extrabold text-text">{ut(text.title)}</b>
            {chips.length ? (
              <span className="flex flex-wrap items-center gap-1.5">
                {chips.map((b) => (
                  <Tag key={b.surveyId} tone="plain" className="max-w-full">
                    <span className="min-w-0 truncate">{b.title}</span>
                    <b className="ml-1 shrink-0 font-extrabold tabular-nums text-text">{int(b.count)}</b>
                  </Tag>
                ))}
                {more > 0 ? <span className="text-caption font-bold text-muted">+{more}</span> : null}
              </span>
            ) : null}
          </div>
        </td>
        <td className={cx(td, "text-right")}>
          <b className="block text-[20px] font-extrabold leading-6 tabular-nums text-text">{int(check.count)}</b>
          <small className="block text-caption text-muted">{plural(check.count, KIND_UNIT[kind])}</small>
        </td>
        <td className={cx(td, "text-right")}>
          {check.examples.length ? (
            <Button
              variant="ghost"
              size="xs"
              icon={<Ic.list />}
              onClick={() => {
                onToggle(true);
                setFocusExamples(true);
              }}
            >
              {ut("opsd.q.examples")}
            </Button>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr id={detailsId}>
          <td colSpan={5} className="border-b border-divider bg-panel-2 pb-4 pl-[66px] pr-4 pt-1">
            <div className="grid gap-x-8 gap-y-4 min-[1100px]:grid-cols-[minmax(0,1fr)_300px]">
              <div className="min-w-0">
                <Label>{ut("opsd.q.danger")}</Label>
                <p className="m-0 mt-1 max-w-[72ch] text-body text-text">{ut(text.danger)}</p>
                {extras.length ? (
                  <Facts
                    className="mt-3 max-w-[420px]"
                    rows={extras.map((x) => ({ key: x.key, label: ut(x.label), value: x.value }))}
                  />
                ) : null}
                {check.examples.length ? (
                  <div ref={examplesRef} className="mt-3">
                    <Label>{kind === "response" ? ut("oppd.q.examplesResponse") : ut("oppd.q.examplesSurvey")}</Label>
                    {/* голые идентификаторы: ни имени, ни ответа — права проверит экран, куда ведёт ссылка */}
                    <ul className="m-0 mt-1 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
                      {check.examples.map((e) => (
                        <li key={e.id} className="min-w-0">
                          <Link
                            to={exampleHref(e)}
                            title={e.id}
                            className="rounded-[4px] font-mono text-[12px] font-semibold text-violet-ink no-underline hover:underline"
                          >
                            {e.id.slice(0, 8)}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
              {check.bySurvey.length ? (
                <div className="min-w-0">
                  <Label className="mb-2">{ut("opsd.q.bySurvey")}</Label>
                  <HBars
                    items={check.bySurvey.map((b) => ({
                      key: b.surveyId,
                      label: (
                        <Link to={bySurveyHref(check.key, b.surveyId)} className="text-text-2 no-underline hover:underline">
                          {b.title}
                        </Link>
                      ),
                      value: b.count,
                    }))}
                  />
                </div>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
