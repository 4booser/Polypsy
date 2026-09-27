import { Fragment, useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { AuditChainReport, AuditEntry, AuditPage } from "@quizzy/shared";
import { api, ApiError } from "../../api";
import { useAuth } from "../../auth";
import { HBars, Kpi } from "../../charts/clinical";
import { dateTime, locale } from "../../format";
import { useLang } from "../../lang";
import { Loading, useAction } from "../../ui";
import { IconDisclosure } from "../../ui/glyphs";
import { cx } from "../../ui/cx";
import { RuleSection } from "../../ui/section";
import { Button, Input } from "../../ui/primitives";
import { type Page, usePagedResource, useResource } from "../../useResource";
import { Cell, ColumnHead, FilterSelect, SearchField, useDebounced } from "./controls";
import { AUDIT_ACTION_CHOICES, AUDIT_PRESETS, type AuditFilterKey, actionLabel, auditFiltersFrom, prettyDetails } from "./model";
import { auditPeriodError, auditQueryOf } from "./auditModel";
import { AuditTimeline } from "./people2/charts";

/*
 * Техпанель → «Аудит»: журнал действий целиком, с отбором, проверкой
 * целостности и выгрузкой.
 *
 * Заменил прежний экран «Журнал доступу» (/audit теперь ведёт сюда) и
 * забрал всё, что тот умел: быстрые отборы (доступ к картам, выгрузки,
 * призначення, відмови, невдалі входи — первыми пунктами выбора действия),
 * сводку «хто частіше / що роблять», число отказов и размер хранилища
 * (раздел «Зведення», по кнопке: он читает журнал целиком, и платить за это
 * на каждом открытии вкладки незачем).
 *
 * Отбор — кто, над кем (почтой или идентификатором), действие, тип ресурса,
 * исход, период и свободный текст; всё в адресе. Страницы — курсором
 * («Показати ще»): журнал растёт сверху, и номер страницы через минуту
 * показывал бы уже другие строки.
 *
 * Подробности раскрываются по строке: JSON как он лежит в журнале, без
 * добавлений. Имён в строке нет — только почта действующего лица и
 * идентификатор того, над кем действовали: журнал отвечает «кто и что», а
 * расшифровывать чьё-то ФИО ради чтения журнала значило бы открывать больше,
 * чем в нём записано.
 *
 * Сам журнал отсюда не правится ничем — ни одной кнопки записи над ним нет:
 * он append-only, и целостность проверяется цепочкой («Перевірити
 * цілісність»).
 */

const GRID =
  "grid grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_minmax(0,1.8fr)_minmax(0,1fr)_minmax(0,0.8fr)_44px] gap-x-[16px]";

const PAGE = "50";

/** Типы ресурсов, которые пишет сервер чаще всего; незнакомый из адреса добавляется в выбор сам */
const RESOURCE_TYPES = ["user", "survey", "response", "route", "session", "device", "invite", "patient_group", "conclusion", "appointment"];

export default function OpsAuditLog() {
  const { ut } = useLang();
  const { user } = useAuth();
  const { run, busy } = useAction();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => auditFiltersFrom(params), [params]);
  /*
   * На сервер — разобранный отбор (auditModel.ts): кривая дата или
   * незнакомый исход из ссылки значат «условия нет», а не отказ всего
   * экрана. Поля показывают набранное; что не применилось — видно по ним.
   */
  const query = useMemo(() => auditQueryOf(filters), [filters]);
  const periodError = auditPeriodError(filters);
  const settled = useDebounced(JSON.stringify(query), 300);

  const set = useCallback(
    (key: AuditFilterKey, value: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const [open, setOpen] = useState<string | null>(null);

  /*
   * Журнал — страницами через слой загрузки (волна 13). Раньше «Показати
   * ще» дописывал ответ к тому, что на экране в момент ответа: сменил отбор,
   * пока летела страница, — и хвост прежней выборки вставал под новую, с
   * чужим «Знайдено». Теперь страницы лежат под ключом отбора. Прежние
   * строки под новым отбором не показываются (keep: false): в журнале
   * строка, не отвечающая отбору, — неправда, а не «обновляется».
   */
  const list = usePagedResource<AuditEntry, AuditPage & Page<AuditEntry>>(
    (cursor) =>
      api
        .auditPage({ ...(JSON.parse(settled) as Record<string, string>), limit: PAGE, cursor: cursor ?? undefined })
        .then((p) => ({ ...p, items: p.entries, nextCursor: p.nextCursor ?? null })),
    [settled],
    { keep: false },
  );
  const error = list.error;

  const [chain, setChain] = useState<AuditChainReport | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const actionOptions = [
    { value: "", label: ut("ops.audit.allActions") },
    ...[...AUDIT_ACTION_CHOICES, ...(query.action && !AUDIT_ACTION_CHOICES.includes(query.action) ? [query.action] : [])].map(
      (a) => ({ value: a, label: actionLabel(a, ut) }),
    ),
  ];
  const typeOptions = [
    { value: "", label: ut("ops.audit.allTypes") },
    ...[...RESOURCE_TYPES, ...(query.resourceType && !RESOURCE_TYPES.includes(query.resourceType) ? [query.resourceType] : [])].map(
      (v) => ({ value: v, label: v }),
    ),
  ];

  return (
    <>
      <p className="m-0 mb-[14px] max-w-[760px] text-[13px] leading-[18px] text-muted">{ut("aud.sub")}</p>
      {/*
        Быстрые отборы прежнего экрана журнала — тем же набором и теми же
        словами. Нажатая — фиолетовой заливкой плашки (primary), не янтарём:
        это состояние, а не внимание.
      */}
      <div className="mb-[12px] flex flex-wrap gap-[8px]" role="group" aria-label={ut("aud.action")}>
        {AUDIT_PRESETS.map((p) => {
          const on = (query.action ?? "") === p.action;
          return (
            <Button key={p.key} variant={on ? "primary" : "quiet"} aria-pressed={on} onClick={() => set("action", p.action)}>
              {ut(p.key)}
            </Button>
          );
        })}
      </div>
      {/* строка отбора: две строки полей — кто/над кем/текст, затем действие, тип, исход, период */}
      <div className="mb-[12px] grid grid-cols-3 gap-[12px] max-[900px]:grid-cols-1">
        <SearchField label={ut("ops.audit.text")} value={filters.q ?? ""} onChange={(v) => set("q", v)} />
        <Input
          look="fill"
          ph="plain"
          placeholder={ut("ops.audit.actor")}
          aria-label={ut("ops.audit.actor")}
          value={filters.actor ?? ""}
          onChange={(e) => set("actor", e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <Input
          look="fill"
          ph="plain"
          placeholder={ut("ops.audit.subject")}
          aria-label={ut("ops.audit.subject")}
          value={filters.subject ?? ""}
          onChange={(e) => set("subject", e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="mb-[12px] grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)] gap-[12px] max-[900px]:grid-cols-1">
        {/* выборы показывают применённое: незнакомое значение из ссылки не применено — и выбор стоит на «усі» */}
        <FilterSelect label={ut("aud.action")} value={query.action ?? ""} onChange={(v) => set("action", v)} options={actionOptions} />
        <FilterSelect label={ut("ops.audit.type")} value={query.resourceType ?? ""} onChange={(v) => set("resourceType", v)} options={typeOptions} />
        <FilterSelect
          label={ut("aud.outcome")}
          value={query.outcome ?? ""}
          onChange={(v) => set("outcome", v)}
          options={[
            { value: "", label: ut("ops.audit.allOutcomes") },
            { value: "success", label: ut("aud.outcomeOk") },
            { value: "denied", label: ut("aud.outcomeDenied") },
            { value: "error", label: ut("aud.outcomeError") },
          ]}
        />
        <Input
          look="fill"
          type="date"
          aria-label={ut("ops.audit.from")}
          title={ut("ops.audit.from")}
          aria-invalid={periodError ? true : undefined}
          value={filters.from ?? ""}
          onChange={(e) => set("from", e.target.value)}
        />
        <Input
          look="fill"
          type="date"
          aria-label={ut("ops.audit.to")}
          title={ut("ops.audit.to")}
          aria-invalid={periodError ? true : undefined}
          value={filters.to ?? ""}
          onChange={(e) => set("to", e.target.value)}
        />
      </div>
      {/* перевёрнутый период — словами у места: конец не применён, и журнал показан от начала */}
      {periodError ? (
        <p role="alert" className="m-0 -mt-[4px] mb-[12px] text-[13px] leading-[18px] text-danger">
          {ut(periodError)}
        </p>
      ) : null}

      <div className="mb-[18px] flex flex-wrap items-center gap-[12px]">
        <span className="font-mono text-[13px] text-muted tabular-nums" aria-live="polite">
          {list.total !== null ? `${ut("ppl.found")} ${list.total.toLocaleString(locale())}` : ""}
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              /* порванная цепочка — 409 с тем же отчётом в теле: это ответ, а не сбой */
              const report = await api.auditVerify().catch((e) => {
                if (e instanceof ApiError && e.status === 409 && e.body) return e.body as AuditChainReport;
                throw e;
              });
              setChain(report);
            })
          }
        >
          {ut("ops.audit.verify")}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.auditExport(query), ut("ops.audit.exported"))}>
          {ut("ops.audit.export")}
        </Button>
        <Button variant="quiet" aria-expanded={summaryOpen} onClick={() => setSummaryOpen((v) => !v)}>
          {summaryOpen ? ut("ops.audit.hideSummary") : ut("ops.audit.showSummary")}
        </Button>
      </div>

      {chain ? <ChainResult report={chain} /> : null}
      {summaryOpen ? <Summary isSuper={user?.role === "superadmin"} /> : null}

      {/*
        Волна 11: записи по тому же отбору во времени — над таблицей, в одном
        разделе с ней: график — форма тех же строк, что ниже, а не отдельный
        отчёт. «Хто частіше / що роблять» остаётся в «Зведенні» по кнопке:
        оно читает журнал целиком и не зависит от отбора.
      */}
      <RuleSection title={ut("opsp.audit.section")}>
        <AuditTimeline query={settled} />
        {error ? (
          <Loading error={error} onRetry={list.reload} />
        ) : !list.items ? (
          <Loading rows={8} />
        ) : list.items.length === 0 ? (
          <p className="m-0 py-[24px] text-[13px] text-muted">{ut("ops.audit.none")}</p>
        ) : (
          <>
            <ColumnHead grid={GRID} labels={[ut("aud.when"), ut("aud.who"), ut("aud.action"), ut("ops.audit.subjectCol"), ut("aud.outcome"), null]} />
            <ul className="m-0 list-none p-0" aria-label={ut("aud.title")}>
              {list.items.map((e) => (
                <Fragment key={e.id}>
                  <li className={cx(GRID, "items-start border-b border-hairline py-[10px] max-[900px]:grid-cols-1 max-[900px]:gap-y-[4px]", open === e.id && "bg-primary-tint")}>
                    <Cell label={ut("aud.when")} className="font-mono text-[13px] tabular-nums">
                      {dateTime(e.at)}
                    </Cell>
                    <Cell label={ut("aud.who")} className="[overflow-wrap:anywhere]">
                      <button
                        type="button"
                        className="m-0 border-0 bg-transparent p-0 text-left text-[15px] text-primary [overflow-wrap:anywhere] hover:underline"
                        title={ut("ops.audit.byThisActor")}
                        disabled={!e.actorId}
                        onClick={() => e.actorId && set("actor", e.actorId)}
                      >
                        {e.actorEmail ?? ut("ops.audit.system")}
                      </button>
                      {e.actorRole ? <span className="block text-[11px] text-muted">{e.actorRole}</span> : null}
                    </Cell>
                    <Cell label={ut("aud.action")}>
                      <span className="block text-text">{actionLabel(e.action, ut)}</span>
                      <span className="block font-mono text-[11px] text-muted">{e.action}</span>
                    </Cell>
                    <Cell label={ut("ops.audit.subjectCol")}>
                      {e.subjectUserId ? (
                        <button
                          type="button"
                          className="m-0 border-0 bg-transparent p-0 font-mono text-[13px] text-primary hover:underline"
                          title={ut("ops.audit.aboutThisSubject")}
                          onClick={() => set("subject", e.subjectUserId!)}
                        >
                          {e.subjectUserId.slice(0, 8)}
                        </button>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </Cell>
                    <Cell label={ut("aud.outcome")}>
                      {/* отказ и сбой — словом цвета danger; успех — тихим серым: в журнале почти всё успех */}
                      {e.outcome === "success" ? (
                        <span className="text-muted">{ut("aud.outcomeOk")}</span>
                      ) : (
                        <span className="font-bold text-danger">
                          {e.outcome === "denied" ? ut("aud.outcomeDenied") : ut("aud.outcomeError")}
                        </span>
                      )}
                    </Cell>
                    <div className="flex justify-end max-[900px]:justify-start">
                      <Button
                        size="glyph"
                        variant="ghost"
                        aria-expanded={open === e.id}
                        aria-label={`${ut("aud.details")}: ${actionLabel(e.action, ut)}`}
                        onClick={() => setOpen((v) => (v === e.id ? null : e.id))}
                      >
                        <span className={cx("transition-transform duration-[var(--dur-fast)]", open === e.id && "rotate-180")}>
                          <IconDisclosure />
                        </span>
                      </Button>
                    </div>
                  </li>
                  {open === e.id ? <EntryDetails entry={e} /> : null}
                </Fragment>
              ))}
            </ul>
            {list.hasMore ? (
              <div className="mt-[18px] flex justify-center">
                <Button variant="ghost" disabled={list.loadingMore} onClick={list.loadMore}>
                  {ut("ui.loadMore")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </RuleSection>
    </>
  );
}

/** Раскрытая запись: служебные поля и подробности как они лежат в журнале */
function EntryDetails({ entry }: { entry: AuditEntry }) {
  const { ut } = useLang();
  const facts: [string, string | null][] = [
    [ut("ops.audit.resource"), entry.resourceType ? `${entry.resourceType}${entry.resourceId ? ` · ${entry.resourceId}` : ""}` : null],
    [ut("ops.audit.subjectFull"), entry.subjectUserId],
    [ut("ops.audit.actorId"), entry.actorId],
    ["IP", entry.ip],
    ["User-Agent", entry.userAgent],
  ];
  return (
    <li className="border-b border-hairline bg-primary-tint px-[12px] pb-[14px] pt-[4px]">
      <dl className="m-0 mb-[10px] grid grid-cols-[160px_minmax(0,1fr)] gap-x-[16px] gap-y-[4px] text-[13px] max-[900px]:grid-cols-1">
        {facts
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <Fragment key={k}>
              <dt className="font-bold text-muted">{k}</dt>
              <dd className="m-0 font-mono text-text-2 [overflow-wrap:anywhere]">{v}</dd>
            </Fragment>
          ))}
      </dl>
      <pre className="m-0 max-h-[360px] overflow-auto rounded-[5px] bg-[var(--bg)] p-[12px] font-mono text-[12px] leading-[17px] text-text-2">
        {prettyDetails(entry.details)}
      </pre>
    </li>
  );
}

/**
 * Итог проверки цепочки — словами.
 *
 * Цела — сколько записей проверено и чем кончается цепочка (номер и начало
 * хэша головы): голову стоит время от времени записывать вовне, и тогда
 * подмену даже всей таблицы видно сверкой. Порвана — на какой записи: дальше
 * этого места журналу верить нельзя, и это сказано прямо.
 */
function ChainResult({ report }: { report: AuditChainReport }) {
  const { ut } = useLang();
  return (
    <div role="status" className="mb-[18px] rounded-[5px] bg-primary-soft px-[16px] py-[12px] text-[15px] leading-[21px]">
      {report.ok ? (
        <p className="m-0 text-primary">
          {ut("ops.audit.chainOk")} {report.checked.toLocaleString(locale())}.{" "}
          {report.headSeq ? (
            <span className="font-mono text-[13px] text-text-2">
              {ut("ops.audit.chainHead")} №{report.headSeq} · {report.headHash?.slice(0, 16)}
            </span>
          ) : null}
        </p>
      ) : (
        <p className="m-0 font-bold text-danger">
          {ut("ops.audit.chainBroken")} №{report.brokenAtSeq}. {ut("ops.audit.chainBrokenWhy")}
        </p>
      )}
      {report.legacy > 0 ? (
        <p className="m-0 mt-[4px] text-[13px] text-muted">
          {ut("ops.audit.chainLegacy")}: {report.legacy.toLocaleString(locale())}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Зведення: сколько событий, сколько отказов, кто чаще и что делают, — то,
 * что показывал прежний экран журнала над таблицей. Хранилище — только
 * суперадмину: GET /api/stats/storage закрыт ему одному.
 */
function Summary({ isSuper }: { isSuper: boolean }) {
  const { ut } = useLang();
  const summary = useResource(() => api.auditSummary(), []);
  const storage = useResource(() => api.storageStats(), [], { enabled: isSuper });
  const s = summary.data;
  const total = s ? s.byAction.reduce((n, a) => n + a.count, 0) : null;
  return (
    <RuleSection title={ut("ops.audit.summary")} className="mb-[18px]">
      {summary.error ? (
        <Loading error={summary.error} onRetry={summary.reload} />
      ) : !s ? (
        <Loading rows={3} />
      ) : (
        <div className="grid gap-[24px]">
          <div className="grid grid-cols-2 gap-[16px] max-[900px]:grid-cols-1">
            <Kpi label={ut("aud.totalEvents")} value={total === null ? null : total.toLocaleString(locale())} />
            {/* отказы — янтарём, только когда они есть: отказ в доступе и есть то, на что смотрят в журнале первым */}
            <Kpi label={ut("aud.denied")} value={s.deniedCount.toLocaleString(locale())} tone={s.deniedCount ? "attention" : "plain"} />
          </div>
          <div className="grid grid-cols-2 gap-[32px] max-[900px]:grid-cols-1">
            <div className="min-w-0">
              <h3 className="m-0 mb-[4px] text-[15px] font-bold text-primary">{ut("aud.whoOften")}</h3>
              <p className="m-0 mb-[12px] text-[13px] text-muted">{ut("aud.perAccount")}</p>
              <HBars items={s.byActor.map((a) => ({ key: a.actorEmail, label: a.actorEmail, value: a.count }))} />
            </div>
            <div className="min-w-0">
              <h3 className="m-0 mb-[4px] text-[15px] font-bold text-primary">{ut("aud.whatDo")}</h3>
              <p className="m-0 mb-[12px] text-[13px] text-muted">{ut("aud.byActionType")}</p>
              <HBars items={s.byAction.slice(0, 12).map((a) => ({ key: a.action, label: actionLabel(a.action, ut), value: a.count }))} />
            </div>
          </div>
          {isSuper && storage.data ? (
            <div className="min-w-0">
              <h3 className="m-0 mb-[4px] text-[15px] font-bold text-primary">{ut("aud.storage")}</h3>
              <p className="m-0 mb-[12px] text-[13px] text-muted">
                {ut("aud.wholeDatabase")}: {storage.data.database.pretty}
              </p>
              <HBars
                items={storage.data.tables.slice(0, 10).map((t) => ({
                  key: t.table,
                  label: <span className="font-mono">{t.table}</span>,
                  value: t.totalBytes,
                  text: `${t.totalPretty} · ${t.rows.toLocaleString(locale())} ${ut("aud.rows")}`,
                }))}
              />
              <p className="m-0 mt-[12px] text-[13px] text-muted">{ut("aud.retentionNote")}</p>
            </div>
          ) : null}
        </div>
      )}
    </RuleSection>
  );
}
