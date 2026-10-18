import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { AuditChainReport, AuditDaily, AuditEntry, AuditPage, OpsIntegrityState } from "@quizzy/shared";
import { api, ApiError } from "../../api";
import { useAuth } from "../../auth";
import { HBars, TimeColumns } from "../../charts/clinical";
import { day, locale } from "../../format";
import { useLang } from "../../lang";
import { Avatar, Callout, KbdHints, Loading, SearchField, useAction } from "../../ui";
import { cx } from "../../ui/cx";
import { Ic } from "../../ui/icons";
import { useHotkeys } from "../../ui/keys";
import { Panel } from "../../ui/layout";
import { listBody } from "../../ui/paging";
import { Button, ErrorText, Input, Tabs, Tag } from "../../ui/primitives";
import { type Page, usePagedResource, useResource } from "../../useResource";
import { useDebounced } from "./controls";
import { AUDIT_ACTION_CHOICES, AUDIT_PRESETS, type AuditFilterKey, actionLabel, auditFiltersFrom, prettyDetails } from "./model";
import { auditPeriodError, auditQueryOf } from "./auditModel";
import { SectionPage } from "./people2/frame";
import { Ix } from "./people2/icons";
import { ChoiceChip, fill, numDay, stamp } from "./users/parts";

/*
 * Техпанель → «Аудит»: журнал действий целиком, с отбором, проверкой
 * целостности и выгрузкой.
 *
 * Заменил прежний экран «Журнал доступу» (/audit теперь ведёт сюда) и
 * забрал всё, что тот умел: быстрые отборы (доступ к картам, выгрузки,
 * призначення, відмови, невдалі входи — вкладками над журналом), сводку
 * «хто частіше / що роблять», число отказов и размер хранилища (по кнопке:
 * она читает журнал целиком, и платить за это на каждом открытии незачем).
 *
 * Отбор — кто, над кем (почтой или идентификатором), действие, тип ресурса,
 * исход, период и свободный текст; всё в адресе. Страницы — курсором
 * («Показати ще»): журнал растёт сверху, и номер страницы через минуту
 * показывал бы уже другие строки.
 *
 * Polypsy 2.0 («Виразна»): сверху — состояние хэш-цепочки (последняя
 * сверка, конец цепочки, сверки по дням), под ним — сводка по тому же
 * отбору, что у таблицы. Запись раскрывается по строке (Enter): JSON как он
 * лежит в журнале, место записи в цепочке (номер, хэш, хэш предыдущей) и
 * переходы «дії цієї людини / дії щодо людини». Имён в строке нет — только
 * почта действующего лица и идентификатор того, над кем действовали: журнал
 * отвечает «кто и что», а расшифровывать чьё-то ФИО ради чтения журнала
 * значило бы открывать больше, чем в нём записано.
 *
 * Сам журнал отсюда не правится ничем — ни одной кнопки записи над ним нет:
 * он append-only, и целостность проверяется цепочкой («Перевірити
 * цілісність»).
 */

const PAGE = "50";

/** Типы ресурсов, которые пишет сервер чаще всего; незнакомый из адреса добавляется в выбор сам */
const RESOURCE_TYPES = ["user", "survey", "response", "route", "session", "device", "invite", "patient_group", "conclusion", "appointment"];

/** Отчёт сверки с тем, когда и как она была */
interface ChainSeen {
  report: AuditChainReport;
  at: string;
  trigger: "manual" | "schedule";
  actorEmail: string | null;
}

export default function OpsAuditLog() {
  const { ut } = useLang();
  const { user } = useAuth();
  const isSuper = user?.role === "superadmin";
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
  const daily = useResource(() => api.auditDaily(JSON.parse(settled) as Record<string, string>), [settled]);

  /* сверка: свежая — по кнопке, прежняя — из раздела «Цілісність» (он открыт суперадмину) */
  const [chain, setChain] = useState<ChainSeen | null>(null);
  const integrity = useResource(() => api.opsSecIntegrity(), [], { enabled: isSuper });
  const stored: ChainSeen | null = integrity.data?.audit
    ? {
        report: integrity.data.audit.summary,
        at: integrity.data.audit.at,
        trigger: integrity.data.audit.trigger,
        actorEmail: integrity.data.audit.actorEmail,
      }
    : null;
  const verify = () =>
    void run(async () => {
      /* порванная цепочка — 409 с тем же отчётом в теле: это ответ, а не сбой */
      const report = await api.auditVerify().catch((e) => {
        if (e instanceof ApiError && e.status === 409 && e.body) return e.body as AuditChainReport;
        throw e;
      });
      setChain({ report, at: new Date().toISOString(), trigger: "manual", actorEmail: user?.email ?? null });
    });

  const actionChoices = [
    { value: "", label: ut("ops.audit.allActions") },
    ...[...AUDIT_ACTION_CHOICES, ...(query.action && !AUDIT_ACTION_CHOICES.includes(query.action) ? [query.action] : [])].map(
      (a) => ({ value: a, label: actionLabel(a, ut) }),
    ),
  ];
  const typeChoices = [
    { value: "", label: ut("ops.audit.allTypes") },
    ...[...RESOURCE_TYPES, ...(query.resourceType && !RESOURCE_TYPES.includes(query.resourceType) ? [query.resourceType] : [])].map(
      (v) => ({ value: v, label: v }),
    ),
  ];

  return (
    <SectionPage
      title={ut("ops.tab.audit")}
      meta={[
        list.total !== null ? fill(ut("oppa.foundN"), { n: list.total.toLocaleString(locale()) }) : ut("ui.loading"),
        ut("oppa.immutable"),
      ]}
      perm="audit.read"
      actions={
        <>
          <Button icon={<Ic.download />} disabled={busy} onClick={() => void run(() => api.auditExport(query), ut("ops.audit.exported"))}>
            {ut("ops.audit.export")}
          </Button>
          <Button variant="primary" icon={<Ic.shieldCheck />} disabled={busy} onClick={verify}>
            {ut("ops.audit.verify")}
          </Button>
        </>
      }
      lead={ut("aud.sub")}
      toolbar={
        /*
          Быстрые отборы прежнего экрана журнала — тем же набором и теми же
          словами, вкладками: выбранная — та, чьё действие стоит в отборе.
        */
        <Tabs
          label={ut("aud.action")}
          items={AUDIT_PRESETS.map((p) => ({
            id: `audit-preset-${p.action || "all"}`,
            label: ut(p.key),
            active: (query.action ?? "") === p.action,
            onSelect: () => set("action", p.action),
          }))}
        />
      }
    >
      <div className="flex flex-col gap-4">
        <ChainPanel seen={chain ?? stored} state={integrity.data} />
        <AuditSummary daily={daily.data} dailyError={daily.error} onRetry={daily.reload} isSuper={isSuper} />

        <Panel flush>
          <div className="flex flex-col gap-2.5 px-4 pb-3 pt-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <SearchField
                slash
                width={280}
                placeholder={ut("ops.audit.text")}
                label={ut("ops.audit.text")}
                value={filters.q ?? ""}
                onChange={(v) => set("q", v)}
              />
              <ChoiceChip label={ut("aud.action")} choices={actionChoices} value={query.action ?? ""} onChange={(v) => set("action", v)} />
              <ChoiceChip label={ut("ops.audit.resource")} choices={typeChoices} value={query.resourceType ?? ""} onChange={(v) => set("resourceType", v)} />
              <ChoiceChip
                label={ut("aud.outcome")}
                value={query.outcome ?? ""}
                onChange={(v) => set("outcome", v)}
                choices={[
                  { value: "", label: ut("ops.audit.allOutcomes") },
                  { value: "success", label: ut("oppa.outcomeOk") },
                  { value: "denied", label: ut("aud.outcomeDenied") },
                  { value: "error", label: ut("aud.outcomeError") },
                ]}
              />
              <span className="ml-auto whitespace-nowrap text-small text-muted" aria-live="polite">
                {list.total !== null ? (
                  <>
                    {ut("ppl.found")} <b className="font-extrabold tabular-nums text-text">{list.total.toLocaleString(locale())}</b>
                  </>
                ) : null}
              </span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px_160px] gap-2 max-[1100px]:grid-cols-2 max-[640px]:grid-cols-1">
              <Input
                look="fill"
                placeholder={ut("ops.audit.actor")}
                aria-label={ut("ops.audit.actor")}
                value={filters.actor ?? ""}
                onChange={(e) => set("actor", e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <Input
                look="fill"
                placeholder={ut("ops.audit.subject")}
                aria-label={ut("ops.audit.subject")}
                value={filters.subject ?? ""}
                onChange={(e) => set("subject", e.target.value)}
                autoComplete="off"
                spellCheck={false}
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
              <div role="alert">
                <ErrorText>{ut(periodError)}</ErrorText>
              </div>
            ) : null}
            <SearchPeriodNote period={list.head?.searchPeriod} />
          </div>
          <JournalTable list={list} error={error} onFilter={set} />
        </Panel>
      </div>
    </SectionPage>
  );
}

/* ─────────── таблица журнала ─────────── */

type Journal = ReturnType<typeof usePagedResource<AuditEntry, AuditPage & Page<AuditEntry>>>;

const hash = (h: string | null | undefined) => (h ? `${h.slice(0, 4)}…${h.slice(-4)}` : "—");

/** «08.10 17:00:12»: в журнале секунды важны — записи одного запроса идут подряд */
function when(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  const year = d.getFullYear() === new Date().getFullYear() ? "" : `.${d.getFullYear()}`;
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}${year} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function Outcome({ outcome }: { outcome: AuditEntry["outcome"] }) {
  const { ut } = useLang();
  /* отказ и сбой — янтарной пилюлей со словом; успех — тихой точкой: в журнале почти всё успех */
  if (outcome === "success")
    return (
      <span className="inline-flex items-center gap-1.5 font-semibold text-text-2">
        <i aria-hidden className="size-2 rounded-full bg-good" />
        {ut("oppa.outcomeOk")}
      </span>
    );
  return (
    <Tag tone="attention" icon={outcome === "denied" ? <Ic.ban /> : <Ic.circleAlert />}>
      {outcome === "denied" ? ut("aud.outcomeDenied") : ut("aud.outcomeError")}
    </Tag>
  );
}

function JournalTable({
  list,
  error,
  onFilter,
}: {
  list: Journal;
  error: string | null;
  onFilter: (key: AuditFilterKey, value: string) => void;
}) {
  const { ut } = useLang();
  const [open, setOpen] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  const items = list.items ?? [];
  /*
   * Место списка — по общему правилу консоли (listBody, как и ListPlace):
   * отказ «Показати ще» или перечитывания строкой над журналом, а показанные
   * записи остаются: прежде неудачная подгрузка стирала всё долистанное.
   */
  const place = listBody(list.items, error);

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setCursor(id);
    const tr = body.current?.querySelector<HTMLTableRowElement>(`tr[data-key="${CSS.escape(id)}"]`);
    tr?.focus();
    tr?.scrollIntoView({ block: "nearest" });
  };
  const at = items.findIndex((e) => e.id === cursor);
  const current = at >= 0 ? items[at] : undefined;
  useHotkeys(
    {
      j: () => focusRow(items[Math.min(items.length - 1, at + 1)]?.id),
      k: () => focusRow(items[Math.max(0, at - 1)]?.id),
      a: () => (current?.actorId ? onFilter("actor", current.actorId) : undefined),
    },
    items.length > 0,
  );

  if (place.body === "loading" || place.body === "failed")
    return (
      <div className="px-4 pb-4">
        <Loading rows={8} error={error} onRetry={list.reload} bare />
      </div>
    );

  const th = "h-[38px] whitespace-nowrap border-y border-divider bg-panel-2 px-2.5 text-left align-middle text-caption font-bold text-muted";
  const td = "border-b border-divider px-2.5 py-2 align-top";

  return (
    <>
      {place.stale ? (
        <div role="alert" className="mx-4 mb-2.5 flex items-center gap-2.5">
          <ErrorText className="min-w-0 flex-1">{place.stale}</ErrorText>
          <Button size="xs" variant="quiet" onClick={list.reload}>
            {ut("common.retry")}
          </Button>
        </div>
      ) : null}
      {place.body === "empty" ? (
        <p className="m-0 px-4 pb-5 pt-2 text-small text-muted">{ut("ops.audit.none")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label={ut("aud.title")} className="w-full border-separate border-spacing-0 text-body leading-[19px]">
            <thead>
              <tr>
                <th className={cx(th, "w-10 pl-4")}>
                  <span className="sr-only">{ut("aud.details")}</span>
                </th>
                <th className={cx(th, "w-[150px]")}>{ut("aud.when")}</th>
                <th className={th}>{ut("aud.who")}</th>
                <th className={th}>{ut("aud.action")}</th>
                <th className={th}>{ut("ops.audit.resource")}</th>
                <th className={cx(th, "w-[120px]")}>{ut("ops.audit.subjectCol")}</th>
                <th className={cx(th, "w-[130px] pr-4")}>{ut("aud.outcome")}</th>
              </tr>
            </thead>
            <tbody ref={body}>
              {items.map((e) => {
                const expanded = open === e.id;
                const toggle = () => setOpen(expanded ? null : e.id);
                return (
                  <Fragment key={e.id}>
                    <tr
                      data-key={e.id}
                      tabIndex={e.id === (cursor ?? items[0]?.id) ? 0 : -1}
                      aria-expanded={expanded}
                      onFocus={() => setCursor(e.id)}
                      onClick={(ev) => {
                        if ((ev.target as HTMLElement).closest("button,a")) return;
                        toggle();
                      }}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          toggle();
                        }
                      }}
                      className={cx(
                        "cursor-pointer outline-none focus-visible:bg-sunk",
                        expanded ? "bg-violet-tint" : "hover:bg-panel-2",
                      )}
                    >
                      <td className={cx(td, "pl-4")}>
                        <Button
                          size="icon-sm"
                          variant="quiet"
                          tabIndex={-1}
                          aria-expanded={expanded}
                          aria-label={`${ut("aud.details")}: ${actionLabel(e.action, ut)}`}
                          icon={<Ic.chevronRight className={cx("transition-transform duration-[var(--dur-fast)]", expanded && "rotate-90")} />}
                          onClick={toggle}
                        />
                      </td>
                      <td className={cx(td, "whitespace-nowrap pt-2.5 font-mono text-[12.5px] text-text-2")}>{when(e.at)}</td>
                      <td className={td}>
                        <span className="flex min-w-0 items-center gap-2">
                          {e.actorEmail ? (
                            <Avatar name={e.actorEmail} size={28} tone={e.actorRole === "user" ? "violet" : "soft"} />
                          ) : (
                            <span aria-hidden className="inline-grid size-7 shrink-0 place-items-center rounded-full bg-sunk-2 text-muted">
                              <Ix.cpu size={14} />
                            </span>
                          )}
                          <span className="flex min-w-0 flex-col">
                            {e.actorId ? (
                              <button
                                type="button"
                                className="min-h-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-bold text-text hover:underline hover:decoration-violet-line hover:decoration-2 hover:underline-offset-[3px]"
                                title={ut("ops.audit.byThisActor")}
                                onClick={() => onFilter("actor", e.actorId!)}
                              >
                                {e.actorEmail ?? e.actorId}
                              </button>
                            ) : (
                              <b className="font-bold text-text-2">{e.actorEmail ?? ut("ops.audit.system")}</b>
                            )}
                            {e.actorRole ? <small className="text-caption text-muted">{ut(ROLE_WORD[e.actorRole])}</small> : null}
                          </span>
                        </span>
                      </td>
                      <td className={td}>
                        <span className="block text-text">{actionLabel(e.action, ut)}</span>
                        <span className="block font-mono text-[11.5px] text-muted">{e.action}</span>
                      </td>
                      <td className={td}>
                        {e.resourceType ? (
                          <>
                            <span className="block text-text-2">{e.resourceType}</span>
                            {e.resourceId ? <span className="block max-w-[180px] truncate font-mono text-[11.5px] text-muted">{e.resourceId}</span> : null}
                          </>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className={td}>
                        {e.subjectUserId ? (
                          <button
                            type="button"
                            className="min-h-0 cursor-pointer border-0 bg-transparent p-0 font-mono text-[12.5px] font-semibold text-violet-ink hover:underline"
                            title={ut("ops.audit.aboutThisSubject")}
                            onClick={() => onFilter("subject", e.subjectUserId!)}
                          >
                            {e.subjectUserId.slice(0, 8)}
                          </button>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className={cx(td, "pr-4")}>
                        <Outcome outcome={e.outcome} />
                      </td>
                    </tr>
                    {expanded ? (
                      <tr>
                        <td colSpan={7} className="border-b border-divider bg-panel-2 px-4 pb-4 pt-2 sm:pl-14">
                          <EntryDetails entry={e} onFilter={onFilter} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-divider px-4 py-2.5">
        <span className="text-small text-muted tabular-nums">
          {list.total !== null ? fill(ut("oppa.shownOf"), { n: items.length, total: list.total.toLocaleString(locale()) }) : null}
        </span>
        {list.hasMore ? (
          <Button size="xs" icon={<Ic.chevronDown />} disabled={list.loadingMore} onClick={list.loadMore}>
            {ut("ui.loadMore")}
          </Button>
        ) : null}
        <KbdHints
          className="ml-auto"
          label={ut("oppa.keys")}
          keys={[
            ["J K", ut("oppa.kEntry")],
            ["Enter", ut("aud.details").toLowerCase()],
            ["A", ut("oppa.kActor")],
            ["/", ut("hotkey.search")],
          ]}
        />
      </div>
    </>
  );
}

const ROLE_WORD = {
  superadmin: "oppu.role.superadmin",
  admin: "oppu.role.admin",
  user: "oppu.role.user",
} as const;

/**
 * За какие дни искался текст (#190). Сервер ищет свободный текст не дальше
 * 31 дня — индекс под политикой строк для него не работает, а перебор всего
 * журнала шёл секундами — и называет окно в ответе. Без этой строки «не
 * найдено за месяц» читалось бы как «не найдено во всём журнале».
 */
export function SearchPeriodNote({ period }: { period: AuditPage["searchPeriod"] }) {
  const { ut } = useLang();
  if (!period) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-muted tabular-nums">
      <Ic.info size={13} />
      {`${ut("ops.audit.searchPeriod")} ${day(period.from)} – ${day(period.to)}`}
    </span>
  );
}

/** Раскрытая запись: подробности как они лежат в журнале, место в цепочке и переходы */
function EntryDetails({ entry, onFilter }: { entry: AuditEntry; onFilter: (key: AuditFilterKey, value: string) => void }) {
  const { ut } = useLang();
  const facts: [string, string | null, boolean?][] = [
    [ut("oppa.entry"), entry.seq != null ? `№ ${entry.seq.toLocaleString(locale())}` : ut("oppa.beforeChain")],
    [ut("oppa.hash"), entry.entryHash ? hash(entry.entryHash) : null, true],
    [ut("oppa.prevHash"), entry.prevHash ? hash(entry.prevHash) : null, true],
    [ut("ops.audit.actorId"), entry.actorId, true],
    [ut("ops.audit.resource"), entry.resourceType ? `${entry.resourceType}${entry.resourceId ? ` ${entry.resourceId}` : ""}` : null, true],
    [ut("ops.audit.subjectFull"), entry.subjectUserId, true],
    ["IP", entry.ip, true],
    ["User-Agent", entry.userAgent],
  ];
  return (
    <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-5 max-[1100px]:grid-cols-1">
      <div className="min-w-0">
        <span className="mb-1.5 block text-caption font-bold text-text-2">{ut("aud.details")}</span>
        <pre className="m-0 max-h-[360px] overflow-auto rounded-[12px] bg-panel p-3 font-mono text-[12px] leading-[18px] text-text-2 shadow-[inset_0_0_0_1px_var(--border)]">
          {prettyDetails(entry.details)}
        </pre>
      </div>
      <div className="min-w-0">
        <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-small">
          {facts
            .filter(([, v]) => v)
            .map(([k, v, mono]) => (
              <Fragment key={k}>
                <dt className="font-bold text-muted">{k}</dt>
                <dd className={cx("m-0 text-text-2 [overflow-wrap:anywhere]", mono && "font-mono text-[12px]")}>{v}</dd>
              </Fragment>
            ))}
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          {entry.actorId ? (
            <Button size="xs" icon={<Ix.userSearch />} onClick={() => onFilter("actor", entry.actorId!)}>
              {ut("oppa.actorActions")}
            </Button>
          ) : null}
          {entry.subjectUserId ? (
            <Button size="xs" icon={<Ix.fileSearch />} onClick={() => onFilter("subject", entry.subjectUserId!)}>
              {ut("oppa.subjectActions")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ─────────── хэш-цепочка ─────────── */

/**
 * Состояние цепочки — словами и знаками.
 *
 * Цела — сколько записей проверено, когда и кем, чем кончается цепочка
 * (номер и начало хэша головы): голову стоит время от времени записывать
 * вовне, и тогда подмену даже всей таблицы видно сверкой. Порвана — на какой
 * записи: дальше этого места журналу верить нельзя, и это сказано прямо.
 * Плановая сверка и сверки по дням — из раздела «Цілісність» (суперадмину).
 */
function ChainPanel({ seen, state }: { seen: ChainSeen | null; state: OpsIntegrityState | null }) {
  const { ut } = useLang();
  if (!seen)
    return (
      <Panel title={ut("oppa.chain")} sub={ut("oppa.chainUnchecked")} icon={<Ix.link />}>
        <p className="m-0 max-w-[80ch] text-body text-text-2">{ut("oppa.chainText")}</p>
      </Panel>
    );
  const r = seen.report;
  const days = state ? chainDays(state) : [];
  return (
    <Panel
      title={r.ok ? ut("oppa.chainOk") : ut("oppa.chainBrokenTitle")}
      sub={fill(ut("oppa.checkedAt"), { t: stamp(seen.at) })}
      icon={r.ok ? <Ic.shieldCheck /> : <Ix.shieldAlert />}
      tone={r.ok ? "good" : "warn"}
      actions={
        r.ok ? (
          <Tag tone="good" icon={<Ic.check />}>
            {ut("oppa.intact")}
          </Tag>
        ) : (
          <Tag tone="attention" icon={<Ic.alert />}>
            {ut("oppa.broken")}
          </Tag>
        )
      }
    >
      <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-6 max-[1100px]:grid-cols-1">
        <div className="min-w-0">
          {r.ok ? (
            <p className="m-0 mb-3 text-body text-text-2">{ut("oppa.chainText")}</p>
          ) : (
            <Callout kind="warn" className="mb-3">
              {`${ut("ops.audit.chainBroken")} № ${r.brokenAtSeq ?? "—"}. ${ut("ops.audit.chainBrokenWhy")}`}
            </Callout>
          )}
          <dl className="m-0 flex flex-col text-small">
            <div className="flex items-baseline gap-3 border-t border-divider py-[7px] first:border-t-0 first:pt-0">
              <dt className="min-w-0 text-text-2">{ut("oppa.checkedEntries")}</dt>
              <dd className="m-0 ml-auto font-extrabold tabular-nums text-text">{r.checked.toLocaleString(locale())}</dd>
              <dd className="m-0 w-[200px] truncate text-caption text-muted">
                {seen.trigger === "schedule" ? ut("oppa.bySchedule") : fill(ut("oppa.byHand"), { who: seen.actorEmail ?? "—" })}
              </dd>
            </div>
            {r.legacy > 0 ? (
              <div className="flex items-baseline gap-3 border-t border-divider py-[7px]">
                <dt className="min-w-0 text-text-2">{ut("oppa.legacy")}</dt>
                <dd className="m-0 ml-auto font-extrabold tabular-nums text-text">{r.legacy.toLocaleString(locale())}</dd>
                <dd className="m-0 w-[200px] text-caption text-muted">{ut("oppa.legacyNote")}</dd>
              </div>
            ) : null}
            {state ? (
              <div className="flex items-baseline gap-3 border-t border-divider py-[7px]">
                <dt className="min-w-0 text-text-2">{ut("oppa.autoCheck")}</dt>
                <dd className="m-0 ml-auto font-extrabold text-text">{fill(ut("oppa.everyHours"), { n: state.scheduleHours })}</dd>
                <dd className="m-0 w-[200px] text-caption text-muted tabular-nums">
                  {fill(ut("oppa.nextAfter"), { t: stamp(state.nextScheduledAfter) })}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
        <div className="min-w-0">
          {r.headSeq ? (
            <>
              <span className="mb-1.5 block text-caption font-bold text-text-2">{ut("oppa.chainEnd")}</span>
              <div className="inline-flex max-w-full flex-col rounded-[10px] bg-violet-tint px-2.5 py-[7px] shadow-[inset_0_0_0_1px_var(--violet-line)]">
                <span className="text-caption text-violet-ink">
                  {`№ ${r.headSeq.toLocaleString(locale())}`} <b className="ml-1 font-bold">{ut("oppa.head")}</b>
                </span>
                <b className="font-mono text-[12px] font-semibold text-violet-ink">{hash(r.headHash)}</b>
              </div>
            </>
          ) : null}
          {days.length ? (
            <div className="mt-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-caption font-bold text-text-2">{fill(ut("oppa.checksDays"), { n: state!.historyDays })}</span>
                {days.every((d) => d.ok !== false) ? (
                  <span className="ml-auto inline-flex items-center gap-1 text-caption font-bold text-good">
                    <Ic.circleCheck size={13} />
                    {ut("oppa.allIntact")}
                  </span>
                ) : null}
              </div>
              <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
                {days.map((d) => (
                  <li
                    key={d.day}
                    title={`${numDay(`${d.day}T12:00:00`)}: ${d.ok === null ? ut("oppa.noCheck") : d.ok ? ut("oppa.intact") : ut("oppa.broken")}`}
                    className={cx(
                      "grid size-6 place-items-center rounded-[7px]",
                      d.ok === null ? "bg-sunk text-muted" : d.ok ? "bg-good-tint text-good" : "bg-warn-tint-2 text-warn",
                    )}
                  >
                    {d.ok === null ? <Ic.minus size={12} /> : d.ok ? <Ic.check size={13} /> : <Ic.x size={13} />}
                    <span className="sr-only">{`${numDay(`${d.day}T12:00:00`)}: ${d.ok === null ? ut("oppa.noCheck") : d.ok ? ut("oppa.intact") : ut("oppa.broken")}`}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

/** Сверки по дням за окно истории: цела, порвана (хоть одна сверка дня) или сверки не было */
function chainDays(state: OpsIntegrityState): { day: string; ok: boolean | null }[] {
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const byDay = new Map<string, boolean>();
  for (const h of state.auditHistory) {
    const k = key(new Date(h.at));
    byDay.set(k, (byDay.get(k) ?? true) && h.ok);
  }
  const out: { day: string; ok: boolean | null }[] = [];
  const today = new Date();
  for (let i = state.historyDays - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const k = key(d);
    out.push({ day: k, ok: byDay.has(k) ? byDay.get(k)! : null });
  }
  return out;
}

/* ─────────── зведення ─────────── */

const SUMMARY_KEY = "quizzy.ops.audit.summaryHidden";

function readHidden(): boolean {
  try {
    return localStorage.getItem(SUMMARY_KEY) === "1";
  } catch {
    return false;
  }
}

/** Подпись корзины: день и неделя — «08.10», месяц — «10.26» */
function bucketLabel(iso: string, step: AuditDaily["step"]): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return step === "month" ? `${m}.${y!.slice(2)}` : `${d}.${m}`;
}

/**
 * Зведення журналу: записи и отказы во времени — по тому же отбору, что у
 * таблицы; «хто частіше / що роблять» и хранилище — по кнопке, по всему
 * журналу (оно читает его целиком). Хранилище — только суперадмину:
 * GET /api/stats/storage закрыт ему одному.
 */
function AuditSummary({
  daily,
  dailyError,
  onRetry,
  isSuper,
}: {
  daily: AuditDaily | null;
  dailyError: string | null;
  onRetry: () => void;
  isSuper: boolean;
}) {
  const { ut } = useLang();
  const [hidden, setHidden] = useState(readHidden);
  const [whole, setWhole] = useState(false);
  const toggle = () => {
    try {
      if (hidden) localStorage.removeItem(SUMMARY_KEY);
      else localStorage.setItem(SUMMARY_KEY, "1");
    } catch {
      /* без хранилища свёрнутость живёт до перезагрузки */
    }
    setHidden(!hidden);
  };
  const total = daily ? daily.buckets.reduce((s, b) => s + b.ok + b.refused, 0) : 0;
  const refused = daily ? daily.buckets.reduce((s, b) => s + b.refused, 0) : 0;
  const share = total ? ((refused / total) * 100).toLocaleString(locale(), { maximumFractionDigits: 1 }) : "0";
  return (
    <Panel
      title={ut("ops.audit.summary")}
      sub={ut("oppa.sameFilter")}
      icon={<Ix.chartColumn />}
      actions={
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!hidden}
          className="inline-flex h-8 min-h-0 cursor-pointer items-center gap-[7px] rounded-control border-0 bg-transparent px-2.5 text-small font-semibold text-muted hover:bg-sunk hover:text-text"
        >
          <Ic.chevronDown size={14} className={hidden ? undefined : "rotate-180"} />
          {hidden ? ut("ops.audit.showSummary") : ut("ops.audit.hideSummary")}
        </button>
      }
    >
      {hidden ? null : dailyError ? (
        <Loading error={dailyError} onRetry={onRetry} bare />
      ) : !daily ? (
        <Loading rows={3} bare />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-6 max-[1100px]:grid-cols-1">
            <div className="min-w-0">
              <div className="mb-2 flex items-baseline gap-2">
                <h3 className="m-0 text-h3 font-extrabold text-text">{ut(STEP_TITLE[daily.step])}</h3>
                <span className="ml-auto text-small text-muted tabular-nums">{fill(ut("oppa.totalN"), { n: total.toLocaleString(locale()) })}</span>
              </div>
              <TimeColumns
                label={ut(STEP_TITLE[daily.step])}
                height={180}
                columns={daily.buckets.map((b) => ({
                  key: b.start,
                  label: bucketLabel(b.start, daily.step),
                  value: b.ok + b.refused,
                }))}
              />
            </div>
            <div className="min-w-0">
              <div className="mb-2 flex items-baseline gap-2">
                <h3 className="m-0 text-h3 font-extrabold text-text">{ut("oppa.refusedTitle")}</h3>
                <span className="ml-auto text-small text-muted tabular-nums">
                  {fill(ut("oppa.refusedShare"), { n: refused.toLocaleString(locale()), p: share })}
                </span>
              </div>
              <TimeColumns
                label={ut("oppa.refusedTitle")}
                height={180}
                tone="attention"
                columns={daily.buckets.map((b) => ({ key: b.start, label: bucketLabel(b.start, daily.step), value: b.refused }))}
              />
            </div>
          </div>
          {whole ? (
            <WholeJournal isSuper={isSuper} />
          ) : (
            <div className="flex flex-wrap items-center gap-3 border-t border-divider pt-3">
              <span className="text-small text-muted">{ut("oppa.wholeHint")}</span>
              <Button size="xs" icon={<Ic.chart />} onClick={() => setWhole(true)}>
                {ut("oppa.wholeShow")}
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

const STEP_TITLE: Record<AuditDaily["step"], "oppa.byDays" | "oppa.byWeeks" | "oppa.byMonths"> = {
  day: "oppa.byDays",
  week: "oppa.byWeeks",
  month: "oppa.byMonths",
};

/** «Хто частіше / що роблять» и хранилище — по всему журналу */
function WholeJournal({ isSuper }: { isSuper: boolean }) {
  const { ut } = useLang();
  const summary = useResource(() => api.auditSummary(), []);
  const storage = useResource(() => api.storageStats(), [], { enabled: isSuper });
  const s = summary.data;
  if (summary.error) return <Loading error={summary.error} onRetry={summary.reload} bare />;
  if (!s) return <Loading rows={3} bare />;
  const total = s.byAction.reduce((n, a) => n + a.count, 0);
  return (
    <div className="flex flex-col gap-4 border-t border-divider pt-4">
      <p className="m-0 text-small text-text-2">
        {fill(ut("oppa.wholeLine"), { n: total.toLocaleString(locale()), d: s.deniedCount.toLocaleString(locale()) })}
      </p>
      <div className="grid grid-cols-2 gap-6 max-[1100px]:grid-cols-1">
        <div className="min-w-0">
          <h3 className="m-0 text-h3 font-extrabold text-text">{ut("aud.whoOften")}</h3>
          <p className="m-0 mb-2.5 text-small text-muted">{ut("aud.perAccount")}</p>
          <HBars items={s.byActor.slice(0, 8).map((a) => ({ key: a.actorEmail, label: a.actorEmail, value: a.count }))} />
        </div>
        <div className="min-w-0">
          <h3 className="m-0 text-h3 font-extrabold text-text">{ut("aud.whatDo")}</h3>
          <p className="m-0 mb-2.5 text-small text-muted">{ut("aud.byActionType")}</p>
          <HBars items={s.byAction.slice(0, 8).map((a) => ({ key: a.action, label: actionLabel(a.action, ut), value: a.count, attention: true }))} />
        </div>
      </div>
      {isSuper && storage.data ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-divider pt-3 text-small text-text-2">
          <Ix.database size={15} className="text-muted" />
          <b className="font-bold text-text">{ut("aud.storage")}</b>
          <span>
            {fill(ut("oppa.storageLine"), {
              size: storage.data.tables.find((t) => t.table === "audit_log")?.totalPretty ?? "—",
              rows: (storage.data.tables.find((t) => t.table === "audit_log")?.rows ?? 0).toLocaleString(locale()),
              db: storage.data.database.pretty,
            })}
          </span>
          <span className="basis-full text-caption text-muted">{ut("aud.retentionNote")}</span>
        </div>
      ) : null}
    </div>
  );
}
