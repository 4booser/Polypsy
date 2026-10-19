import { useMemo } from "react";
import type { OpsErrorGroup, OpsErrorWindow } from "@quizzy/shared";
import { api } from "../../api";
import { locale } from "../../format";
import { useLang } from "../../lang";
import { Loading, SearchField, Tooltip, useToast, useUrlState } from "../../ui";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { Button, ButtonLink, Segmented, Tag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { fill } from "../dashboard/model";
import { ErrorCharts } from "./charts";
import { OpsIcon } from "./icons";
import { ERROR_WINDOWS, PERIOD_KEY, filterErrors, fmtInt, parseErrorWindow } from "./model";
import { HistoryNote } from "./obs2a/parts";
import {
  CopyLinkButton,
  HttpCode,
  MethodRoute,
  Mono,
  OpsHead,
  FilterToggle,
  OpsToolbar,
  PanelNote,
  Quiet,
  RequestId,
  TraceBox,
  fillNode,
  useCount,
  useOpsResource,
} from "./parts";

/*
 * Помилки: необработанные исключения процесса, сведённые в группы.
 *
 * Группа — это отпечаток: тип, сообщение без данных, верхний кадр нашего
 * кода и маршрут (сервер, lib/opsBuffer.ts). Двести одинаковых падений на
 * двухстах пациентах — одна строка «200 разів», а не двести. Сообщение уже
 * вычищено на сервере: идентификаторы, почта, телефоны и значения в
 * кавычках заменены.
 *
 * Раскрытая группа — в адресе (?open=<отпечаток>): ссылку «вот эта ошибка»
 * пересылают коллеге. Поиск (?q=), «лише нові» (?new=1), «поза запитом»
 * (?outside=1) и порядок (?order=) — тоже там. Чтение вкладки пишется в
 * журнал (ops.errors.read) — опросы одного человека склеены сервером.
 *
 * Группы — из истории в базе за период (?window=24h|7d|30d|90d), а не с
 * момента запуска. Число в строке — случаи за период; «усього» — с первого
 * появления, пока группа хранится (90 дней без повторов). Группа, впервые
 * появившаяся внутри периода, помечена «нова»: после выкатки это первое,
 * что ищут.
 *
 * Над списком — огляд периоду: случаи во времени с отметками выкаток,
 * самые частые группы и сводка. Поиск на огляд не действует: он сужает
 * список, а «сколько всего и когда» — вопрос периода.
 */

const POLL_MS = 30_000;

type Order = "last" | "count" | "new";
const parseOrder = (v: string): Order => (v === "count" || v === "new" ? v : "last");

/** Порядок групп: последние, частые или новые (по первому появлению) */
function ordered(items: readonly OpsErrorGroup[], order: Order): OpsErrorGroup[] {
  const out = items.slice();
  if (order === "count") out.sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
  else if (order === "new") out.sort((a, b) => b.firstAt.localeCompare(a.firstAt));
  else out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return out;
}

const PERIOD_WORD: Record<OpsErrorWindow, "opx.er.per24h" | "opx.er.per7d" | "opx.er.per30d" | "opx.er.per90d"> = {
  "24h": "opx.er.per24h",
  "7d": "opx.er.per7d",
  "30d": "opx.er.per30d",
  "90d": "opx.er.per90d",
};

export default function OpsErrors() {
  const { ut } = useLang();
  const count = useCount();
  const [q, setQ] = useUrlState("q", "");
  const [open, setOpen] = useUrlState("open", "");
  const [rawWindow, setWindow] = useUrlState("window", "24h");
  const [onlyNew, setOnlyNew] = useUrlState("new", "");
  const [outside, setOutside] = useUrlState("outside", "");
  const [rawOrder, setOrder] = useUrlState("order", "last");
  const win: OpsErrorWindow = parseErrorWindow(rawWindow);
  const order = parseOrder(rawOrder);

  const res = useOpsResource(() => api.opsErrors(win), [win], POLL_MS);
  /* выкатки — отметками на оси «випадки в часі» */
  const releases = useResource(() => api.opsReleaseVersions(), []);

  const data = res.data;
  const from = data?.from ? Date.parse(data.from) : null;
  const isNew = (g: OpsErrorGroup) => from !== null && Date.parse(g.firstAt) >= from;
  const shown = useMemo(() => {
    if (!data) return null;
    let list = filterErrors(data.items, q);
    if (onlyNew) list = list.filter((g) => from !== null && Date.parse(g.firstAt) >= from);
    if (outside) list = list.filter((g) => !g.route);
    return ordered(list, order);
  }, [data, q, onlyNew, outside, order, from]);

  const total = data ? data.items.reduce((s, g) => s + g.count, 0) : 0;
  const head = (
    <OpsHead
      meta={
        data
          ? [
              fill(ut("opx.er.metaBold"), {
                groups: count(["opx.er.groups.one", "opx.er.groups.few", "opx.er.groups.many"], data.items.length),
                cases: count(["opx.er.cases.one", "opx.er.cases.few", "opx.er.cases.many"], total),
              }),
              data.from ? ut(PERIOD_WORD[win]) : ut("opx.er.perProcess"),
            ]
          : null
      }
      actions={
        <>
          <TraceBox />
          <CopyLinkButton />
        </>
      }
      toolbar={
        <OpsToolbar
          right={
            data ? (
              <HistoryNote
                window={win}
                from={data.from}
                retentionDays={data.retentionDays}
                store={data.store}
                unavailable={data.historyUnavailable}
              />
            ) : null
          }
        >
          <SearchField value={q} onChange={setQ} placeholder={ut("opx.er.search")} slash width={260} />
          <Segmented
            label={ut("ops.history.periodLabel")}
            value={win}
            onChange={(v) => setWindow(v)}
            items={ERROR_WINDOWS.map((w) => ({ key: w, label: ut(PERIOD_KEY[w]) }))}
          />
          <FilterToggle label={ut("opx.er.onlyNew")} on={!!onlyNew} onChange={(v) => setOnlyNew(v ? "1" : "")} />
          <FilterToggle label={ut("opx.er.outside")} on={!!outside} onChange={(v) => setOutside(v ? "1" : "")} />
        </OpsToolbar>
      }
    />
  );

  if (res.error && !data) {
    return (
      <>
        {head}
        <Loading error={res.error} onRetry={res.reload} />
      </>
    );
  }
  if (!data || !shown) {
    return (
      <>
        {head}
        <Loading rows={5} />
      </>
    );
  }
  const loc = locale();
  const periodSub = data.from
    ? fill(ut("opx.er.overviewSub"), {
        from: new Date(data.from).toLocaleDateString(loc, { day: "2-digit", month: "2-digit" }),
        to: new Date(res.updatedAt ?? Date.now()).toLocaleDateString(loc, { day: "2-digit", month: "2-digit" }),
      })
    : ut("opx.er.perProcess");

  return (
    <div className="flex flex-col gap-4">
      {head}
      {data.items.length ? (
        <Panel
          title={ut("opx.er.overview")}
          icon={<OpsIcon name="chart-column" />}
          sub={periodSub}
          actions={q ? <span className="text-small text-muted">{ut("opx.er.searchIgnored")}</span> : undefined}
        >
          <ErrorCharts data={data} window={win} now={res.updatedAt ?? Date.now()} releases={releases.data?.items ?? []} />
        </Panel>
      ) : null}

      <Panel
        title={ut("ops.errors.title")}
        icon={<OpsIcon name="layers" />}
        sub={fill(ut("ops.errors.summary"), { groups: fmtInt(data.items.length, loc), n: fmtInt(total, loc) })}
        actions={
          <span className="flex items-center gap-2">
            <span className="text-small text-muted">{ut("opx.er.order")}</span>
            <Segmented
              label={ut("opx.er.order")}
              value={order}
              onChange={(o) => setOrder(o)}
              items={[
                { key: "last", label: ut("opx.er.byLast") },
                { key: "count", label: ut("opx.er.byCount") },
                { key: "new", label: ut("opx.er.byNew") },
              ]}
            />
          </span>
        }
        flush
        footer={<PanelNote>{ut("ops.errors.hint")}</PanelNote>}
      >
        {data.dropped > 0 ? (
          <div className="px-4 pb-2">
            <Quiet>{fill(ut("ops.errors.dropped"), { n: fmtInt(data.dropped, loc), cap: data.capacity })}</Quiet>
          </div>
        ) : null}
        {data.items.length === 0 ? (
          <div className="px-4 pb-3">
            <Quiet>{data.from ? ut("ops.history.errorsEmpty") : ut("ops.errors.empty")}</Quiet>
          </div>
        ) : shown.length === 0 ? (
          <div className="px-4 pb-3">
            <Quiet>{ut("ops.errors.noMatch")}</Quiet>
          </div>
        ) : (
          <div role="table" aria-label={ut("ops.errors.title")} className="overflow-x-auto">
            <div className="min-w-[760px]">
              <div
                role="row"
                className="grid h-[38px] grid-cols-[44px_112px_minmax(0,1fr)_minmax(170px,210px)] items-center gap-3 border-y border-divider bg-panel-2 px-4 text-caption font-bold leading-none text-muted"
              >
                <span role="columnheader" />
                <span role="columnheader" className="whitespace-nowrap">
                  {fill(ut("opx.er.colCases"), { period: data.from ? ut(PERIOD_KEY[win]) : ut("opx.er.colProcess") })}
                </span>
                <span role="columnheader">{ut("opx.er.colWhat")}</span>
                <span role="columnheader">{ut("opx.er.colWhen")}</span>
              </div>
              <ul className="m-0 list-none p-0">
                {shown.map((g) => (
                  <GroupRow
                    key={g.fingerprint}
                    g={g}
                    fresh={isNew(g)}
                    open={open === g.fingerprint}
                    onToggle={() => setOpen(open === g.fingerprint ? "" : g.fingerprint)}
                    win={win}
                  />
                ))}
              </ul>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

function GroupRow({
  g,
  fresh,
  open,
  onToggle,
  win,
}: {
  g: OpsErrorGroup;
  fresh: boolean;
  open: boolean;
  onToggle: () => void;
  win: OpsErrorWindow;
}) {
  const { ut } = useLang();
  const loc = locale();
  const id = `ops-group-${g.fingerprint}`;
  const when = (iso: string) => new Date(iso).toLocaleString(loc, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  return (
    <li className={cx("border-b border-divider last:border-b-0", open && "bg-panel-2")}>
      <div role="row" className="grid grid-cols-[44px_112px_minmax(0,1fr)_minmax(170px,210px)] items-center gap-3 px-4 py-2.5">
        <span role="cell">
          <Tooltip label={open ? ut("opx.er.collapse") : ut("opx.er.expand")}>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              aria-label={open ? ut("opx.er.collapse") : ut("opx.er.expand")}
              onClick={onToggle}
              className={cx(
                "inline-grid size-7 min-h-0 cursor-pointer place-items-center rounded-[8px] border-0 p-0 transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
                open ? "bg-violet-tint text-violet-ink" : "bg-transparent text-muted hover:bg-sunk hover:text-text",
              )}
            >
              <OpsIcon name="chevron-right" size={16} className={cx("transition-transform duration-[180ms]", open && "rotate-90")} />
            </button>
          </Tooltip>
        </span>
        <b role="cell" className="text-[17px] font-extrabold tabular-nums text-text">
          {fmtInt(g.count, loc)}
        </b>
        <span role="cell" className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <Mono className="shrink-0 font-bold text-text">{g.name}</Mono>
            {fresh ? (
              <Tag tone="attention" icon={<OpsIcon name="sparkles" />}>
                {ut("ops.history.new")}
              </Tag>
            ) : null}
            <Mono className="min-w-0 truncate text-text-2" title={g.message}>
              {g.message || "—"}
            </Mono>
          </span>
          {g.route ? (
            <MethodRoute method={g.method} route={g.route} />
          ) : (
            <span className="inline-flex items-center gap-1.5 text-small text-muted">
              <OpsIcon name="cog" size={14} />
              {ut("ops.errors.outside")}
            </span>
          )}
        </span>
        <span role="cell" className="flex flex-col text-small leading-[18px]">
          <span className="text-text-2">{fillNode(ut("ops.history.lastOn"), { time: <b className="font-extrabold text-text">{when(g.lastAt)}</b> })}</span>
          <span className="text-muted">
            {fill(ut("opx.er.totalFirst"), { n: fmtInt(g.totalCount ?? g.count, loc), time: when(g.firstAt) })}
          </span>
        </span>
      </div>
      {open ? <GroupDetails id={id} g={g} win={win} /> : null}
    </li>
  );
}

function GroupDetails({ id, g, win }: { id: string; g: OpsErrorGroup; win: OpsErrorWindow }) {
  const { ut } = useLang();
  const toast = useToast();
  const loc = locale();
  const head = `${g.name}: ${g.message}`;
  const copy = (text: string, ok: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => toast(ok, "ok"),
      () => toast(ut("ops.copyFailed"), "err"),
    );
  };
  const link = () => {
    const url = new URL(window.location.href);
    url.search = new URLSearchParams({ window: win, open: g.fingerprint }).toString();
    return url.toString();
  };
  return (
    <div id={id} className="grid grid-cols-[minmax(0,1fr)_minmax(260px,400px)] gap-6 px-4 pb-4 pl-[60px] max-[1100px]:grid-cols-1">
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-caption font-bold text-muted">{ut("opx.er.stack")}</span>
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            icon={<OpsIcon name="copy" />}
            onClick={() => copy([head, ...g.frames].join("\n"), ut("opx.er.stackCopied"))}
          >
            {ut("opx.er.copy")}
          </Button>
        </div>
        <pre className="m-0 overflow-x-auto whitespace-pre-wrap rounded-control bg-sunk px-3 py-2.5 font-mono text-[12px] font-medium leading-[18px] text-text [overflow-wrap:anywhere]">
          <b className="font-bold text-warn">{head}</b>
          {g.frames.length
            ? g.frames.map((f, i) => (
                <span key={i} className="block">
                  <span className="mr-2.5 inline-block w-[18px] text-right text-muted">{i + 1}</span>
                  {f}
                </span>
              ))
            : null}
        </pre>
        {g.frames.length ? null : <Quiet>{ut("ops.errors.noStack")}</Quiet>}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-small text-text-2">
          <span className="inline-flex items-center gap-1.5">
            {ut("opx.er.fingerprint")}
            <Mono className="font-bold text-text" title={g.fingerprint}>
              {g.fingerprint.slice(0, 8)}
            </Mono>
          </span>
          {g.code ? (
            <span className="inline-flex items-center gap-1.5">
              {ut("opx.er.code")}
              <HttpCode code={g.code} />
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5">
            {ut("opx.er.origin")}
            <b className="font-bold text-text">{ut(g.origin === "request" ? "opx.er.originRequest" : "opx.er.originLog")}</b>
          </span>
        </div>
      </div>
      <div className="min-w-0">
        <span className="mb-2 block text-caption font-bold text-muted">{ut("opx.er.lastCase")}</span>
        <div className="flex min-h-10 items-center gap-2.5 border-y border-divider">
          <Mono className="text-text-2">{new Date(g.lastAt).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</Mono>
          {g.lastRequestId ? (
            <>
              <RequestId id={g.lastRequestId} />
              <ButtonLink to={`/ops/trace/${encodeURIComponent(g.lastRequestId)}`} size="xs" className="ml-auto">
                <OpsIcon name="route" size={14} />
                {ut("opx.rq.trace")}
              </ButtonLink>
            </>
          ) : (
            <span className="text-small text-muted">{ut("opx.er.noRequest")}</span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <ButtonLink to="/ops/compare" size="xs">
            <OpsIcon name="git-compare" size={14} />
            {ut("opx.er.compare")}
          </ButtonLink>
          <Button size="xs" variant="ghost" icon={<OpsIcon name="link" />} onClick={() => copy(link(), ut("opx.er.groupLinkCopied"))}>
            {ut("opx.er.groupLink")}
          </Button>
        </div>
      </div>
    </div>
  );
}
