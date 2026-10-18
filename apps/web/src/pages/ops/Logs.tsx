import { useEffect, useRef, useState } from "react";
import type { OpsLevel, OpsLogLine, OpsLogs, OpsLogWindow } from "@quizzy/shared";
import { api, ApiError, withSignal } from "../../api";
import { connection } from "../../connection";
import { locale } from "../../format";
import { useLang } from "../../lang";
import { KbdHints, Loading, SearchField, Tooltip, useHotkeys, useToast, useUrlState } from "../../ui";
import { cx } from "../../ui/cx";
import { Panel } from "../../ui/layout";
import { Button, ButtonLink, Input, Segmented, Tag } from "../../ui/primitives";
import { fill } from "../dashboard/model";
import { LogVolumeCharts } from "./charts";
import { OpsIcon } from "./icons";
import {
  FEED_CAP,
  HISTORY_CAP,
  LEVEL_KEY,
  LOG_STEP,
  LOG_WINDOWS,
  PERIOD_KEY,
  STEP_KEY,
  fieldsText,
  fmtInt,
  lineKey,
  mergeFeed,
  parseLevel,
  parseLogWindow,
  shortId,
} from "./model";
import { HistoryNote } from "./obs2a/parts";
import { CopyLinkButton, Live, Mono, OpsHead, OpsToolbar, PanelNote, Quiet, TraceBox, useCount, useOpsResource } from "./parts";

/*
 * Логи: история из базы за период и живой хвост процесса поверх неё.
 *
 * Решение заказчика 2026-09-26 (участок obs2a): история переживает
 * перезапуск и выкатку. Первая страница — строки за период (?window=1h|24h|
 * 7d|14d) из базы, склеенные сервером с памятью процесса без дублей; дальше
 * лента, как и прежде, опрашивает только живой хвост памяти по курсору.
 * «Старіші» дочитывает историю назад страницами — до потолка HISTORY_CAP:
 * дальше это уже выгрузка, и её место — узкий фильтр или короткий период.
 *
 * Опрос раз в четыре секунды с курсором: сервер отдаёт только строки новее
 * последней увиденной, и лента не перекачивает одно и то же. «Пауза» (P)
 * останавливает опрос, не сбрасывая курсор: после паузы приходят строки,
 * накопившиеся за неё, а если их было больше, чем держит буфер, — лента
 * говорит о разрыве, а не молчит.
 *
 * Фильтры — уровень (от выбранного и выше), поиск по сообщению и полям,
 * номер запроса — в адресе: ?level=warn&q=…&rid=…. Строка раскрывается на
 * месте: все её поля, «лише цей запит», трасса, группа ошибок, копирование.
 * Смена фильтра начинает ленту заново.
 *
 * Скрытая вкладка браузера не опрашивается; ушёл с вкладки панели —
 * компонент размонтирован, и цикл гаснет вместе с ним.
 *
 * Над лентой — объём строк за период по уровням: всего и отдельно
 * предупреждения с ошибками (GET /api/ops/logs/volume, только счёт). Своим
 * опросом раз в минуту и без фильтров ленты: график отвечает «когда стало
 * шумно», а фильтр — «что именно».
 */

const POLL_MS = 4_000;
const VOLUME_POLL_MS = 60_000;
/* первая выборка — побольше: человек открывает ленту, чтобы увидеть, что было */
const FIRST_LIMIT = 300;
const NEXT_LIMIT = 500;
/* страница истории назад — та же, что первая: читается одним взглядом прокрутки */
const OLDER_LIMIT = 300;

const LINE_COLS = "grid-cols-[110px_150px_minmax(0,1fr)_150px_40px]";

type Meta = Pick<OpsLogs, "since" | "capacity" | "threshold" | "from" | "retentionDays" | "store" | "historyUnavailable">;

/* «Усі» — с налагодження: уровень ниже порога записи процесс и так не пишет */
const LEVEL_PICK: readonly { key: "" | OpsLevel; label: "opx.lg.all" | "opx.lg.fromInfo" | "opx.lg.fromWarn" | "opx.lg.errors" }[] = [
  { key: "", label: "opx.lg.all" },
  { key: "info", label: "opx.lg.fromInfo" },
  { key: "warn", label: "opx.lg.fromWarn" },
  { key: "error", label: "opx.lg.errors" },
];

const PERIOD_WORD: Record<OpsLogWindow, "opx.lg.per1h" | "opx.lg.per24h" | "opx.lg.per7d" | "opx.lg.per14d"> = {
  "1h": "opx.lg.per1h",
  "24h": "opx.lg.per24h",
  "7d": "opx.lg.per7d",
  "14d": "opx.lg.per14d",
};

/** Время строки до миллисекунд: в ленте строки одной секунды различаются только ими */
function stamp(iso: string, loc: string): string {
  const d = new Date(iso);
  return `${d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export default function OpsLogs() {
  const { ut } = useLang();
  const loc = locale();
  const count = useCount();
  const [rawLevel, setLevel] = useUrlState("level", "");
  const [q, setQ] = useUrlState("q", "");
  const [rid, setRid] = useUrlState("rid", "");
  const [rawWindow, setWindow] = useUrlState("window", "1h");
  const level = parseLevel(rawLevel);
  const win: OpsLogWindow = parseLogWindow(rawWindow);
  const volume = useOpsResource(() => api.opsLogVolume(win), [win], VOLUME_POLL_MS);

  /* поиск печатается в поле сразу, а в адрес и на сервер уходит после паузы в наборе */
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    if (draft === q) return;
    const t = setTimeout(() => setQ(draft), 350);
    return () => clearTimeout(t);
  }, [draft, q, setQ]);
  const [ridDraft, setRidDraft] = useState(rid);
  useEffect(() => setRidDraft(rid), [rid]);

  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [pausedAt, setPausedAt] = useState<number | null>(null);

  const [lines, setLines] = useState<OpsLogLine[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [gap, setGap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  /* курсор более старой страницы истории; null — старше в периоде ничего нет */
  const [older, setOlder] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  /* поколение фильтров: страница «старіші», пришедшая от прежних фильтров, отбрасывается */
  const generation = useRef(0);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    /*
     * Свой цикл, а не useResource: здесь ответ не заменяет данные, а
     * дописывается к ним, и следующий вопрос зависит от предыдущего ответа
     * (курсор). Каждое поколение фильтров — свой цикл: ответ, пришедший от
     * прежних фильтров, отбрасывается по номеру поколения.
     *
     * Волна 13 (слой загрузки — TanStack Query): цикл остался своим и
     * записан в белый список сторожа (test/dataLayer.test.ts) — живой хвост
     * с курсором вперёд и дочиткой назад в «бесконечный запрос» не ложится
     * без потерь. Но гарантии у него те же: запрос прежнего поколения
     * отменяется (сигнал), а без связи лента не стучится в сервер — ждёт,
     * пока connection.ts не скажет, что связь вернулась.
     */
    let alive = true;
    let cursor: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    generation.current++;
    setLines([]);
    setGap(false);
    setLoaded(false);
    setOlder(null);

    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState === "visible" && !pausedRef.current && connection.isOnline()) {
        try {
          const first = cursor === null;
          const page = await withSignal(abort.signal, () => api.opsLogs({
            level: level ?? undefined,
            q: q || undefined,
            requestId: rid || undefined,
            after: first ? undefined : cursor!,
            limit: first ? FIRST_LIMIT : NEXT_LIMIT,
            /* период — только у первой страницы: дальше лента берёт живой хвост памяти */
            window: first ? win : undefined,
          }));
          if (!alive) return;
          cursor = page.cursor;
          /* ленту, дочитанную вручную назад, живой хвост не обрезает до обычного потолка */
          setLines((prev) => mergeFeed(first ? [] : prev, page.items, Math.min(HISTORY_CAP, Math.max(FEED_CAP, prev.length))));
          if (first) {
            setMeta({
              since: page.since,
              capacity: page.capacity,
              threshold: page.threshold,
              from: page.from,
              retentionDays: page.retentionDays,
              store: page.store,
              historyUnavailable: page.historyUnavailable,
            });
            setOlder(page.older ?? null);
          }
          if (!first && (page.gap || page.truncated)) setGap(true);
          setUpdatedAt(Date.now());
          setLoaded(true);
          setError(null);
        } catch (e) {
          // обрыв связи — не ошибка ленты: о нём говорит строка оболочки, а лента ждёт
          if (alive && !(e instanceof ApiError && e.status === 0)) setError(e instanceof Error ? e.message : ut("common.error"));
        }
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [level, q, rid, win, ut]);

  const filtered = Boolean(level || q || rid);
  const capped = lines.length >= HISTORY_CAP;
  const togglePause = () => {
    setPaused((p) => !p);
    setPausedAt(paused ? null : Date.now());
  };

  /* J/K — по строкам ленты, Enter раскрывает (на самой строке), P — пауза */
  const step = (dir: 1 | -1) => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-line]") ?? [])];
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[at < 0 ? (dir > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + dir))];
    next?.focus();
    next?.scrollIntoView({ block: "nearest" });
  };
  useHotkeys({ j: () => step(1), k: () => step(-1), p: togglePause });

  const loadOlder = async () => {
    if (!older || loadingOlder || capped) return;
    const gen = generation.current;
    setLoadingOlder(true);
    try {
      const page = await api.opsLogs({
        level: level ?? undefined,
        q: q || undefined,
        requestId: rid || undefined,
        window: win,
        before: older,
        limit: OLDER_LIMIT,
      });
      if (gen !== generation.current) return;
      setLines((prev) => mergeFeed(prev, page.items, HISTORY_CAP));
      setOlder(page.older ?? null);
    } catch (e) {
      if (gen === generation.current) setError(e instanceof Error ? e.message : ut("common.error"));
    } finally {
      if (gen === generation.current) setLoadingOlder(false);
    }
  };

  const volumeTotal = volume.data ? volume.data.buckets.reduce((s, b) => s + b.debug + b.info + b.warn + b.error, 0) : null;

  const head = (
    <OpsHead
      meta={[
        volumeTotal === null
          ? ut("ops.logs.title")
          : count(["opx.lg.lines.one", "opx.lg.lines.few", "opx.lg.lines.many"], volumeTotal, { period: ut(PERIOD_WORD[win]) }),
        meta?.retentionDays ? fill(ut("opx.lg.metaSub"), { n: meta.retentionDays }) : ut("opx.lg.metaLive"),
      ]}
      actions={
        <>
          <TraceBox />
          <CopyLinkButton />
        </>
      }
      toolbar={
        <OpsToolbar>
          <SearchField value={draft} onChange={setDraft} placeholder={ut("opx.lg.search")} slash width={240} />
          <Segmented
            label={ut("ops.history.periodLabel")}
            value={win}
            onChange={(v) => setWindow(v)}
            items={LOG_WINDOWS.map((w) => ({ key: w, label: ut(PERIOD_KEY[w]) }))}
          />
          <span className="flex items-center gap-2">
            <span className="text-small text-muted">{ut("ops.logs.level")}</span>
            <Segmented
              label={ut("ops.logs.level")}
              value={(level ?? "") as "" | OpsLevel}
              onChange={(v) => setLevel(v)}
              items={LEVEL_PICK.map((l) => ({ key: l.key, label: ut(l.label) }))}
            />
          </span>
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              setRid(ridDraft.trim());
            }}
          >
            <Input
              look="fill"
              aria-label={ut("ops.logs.requestId")}
              placeholder={ut("ops.logs.requestId")}
              value={ridDraft}
              onChange={(e) => setRidDraft(e.target.value)}
              onBlur={() => setRid(ridDraft.trim())}
              icon={<OpsIcon name="hash" />}
              className="rounded-[12px] [&_input]:font-mono [&_input]:text-[12.5px] [&_input::placeholder]:font-sans [&_input::placeholder]:text-[13px]"
              style={{ width: 190 }}
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
            />
          </form>
        </OpsToolbar>
      }
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {head}
      {/* график — только когда пришёл: его отказ не должен закрывать ленту, ради которой вкладку открыли */}
      {volume.data ? (
        <Panel
          title={ut("opx.lg.volume")}
          icon={<OpsIcon name="chart-column" />}
          sub={fill(ut("ops.ch.logHint"), { step: ut(STEP_KEY[LOG_STEP[win]]) })}
          actions={<span className="text-small text-muted">{ut("opx.lg.volumeEvery")}</span>}
        >
          <LogVolumeCharts volume={volume.data} now={volume.updatedAt ?? Date.now()} />
        </Panel>
      ) : null}

      <Panel
        title={ut("ops.logs.title")}
        icon={<OpsIcon name="scroll-text" />}
        sub={loaded ? fill(ut("opx.lg.feedSub"), { n: fmtInt(lines.length, loc) }) : undefined}
        actions={
          <>
            <Live pollSec={POLL_MS / 1000} updatedAt={paused ? pausedAt : updatedAt} paused={paused} />
            {filtered ? (
              <Button
                variant="ghost"
                size="xs"
                icon={<OpsIcon name="x" />}
                onClick={() => {
                  setLevel("");
                  setQ("");
                  setRid("");
                  setDraft("");
                  setRidDraft("");
                }}
              >
                {ut("ops.logs.clear")}
              </Button>
            ) : null}
            <Tooltip label={paused ? ut("ops.logs.resume") : ut("ops.logs.pause")} kbd="P">
              <Button size="xs" aria-pressed={paused} icon={<OpsIcon name={paused ? "play" : "pause"} />} onClick={togglePause}>
                {paused ? ut("ops.logs.resume") : ut("ops.logs.pause")}
              </Button>
            </Tooltip>
          </>
        }
        flush
      >
        {meta ? (
          <div className="px-4 pb-2.5">
            <HistoryNote window={win} from={meta.from} retentionDays={meta.retentionDays} store={meta.store} unavailable={meta.historyUnavailable} />
          </div>
        ) : null}
        {gap ? (
          <div className="px-4 pb-2">
            <Quiet>{ut("ops.logs.gap")}</Quiet>
          </div>
        ) : null}

        {error && !loaded ? (
          <div className="px-4 pb-3">
            <Loading bare error={error} />
          </div>
        ) : !loaded ? (
          <div className="px-4 pb-3">
            <Loading bare rows={8} />
          </div>
        ) : lines.length === 0 ? (
          <div className="px-4 pb-3">
            <Quiet>{filtered ? ut("ops.logs.noMatch") : ut("ops.logs.empty")}</Quiet>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[820px]">
              <div
                aria-hidden
                className={cx("grid h-[38px] items-center gap-3 border-y border-divider bg-panel-2 px-4 text-caption font-bold leading-none text-muted", LINE_COLS)}
              >
                <span>{ut("ops.col.time")}</span>
                <span>{ut("ops.logs.level")}</span>
                <span>{ut("opx.lg.colMessage")}</span>
                <span>{ut("opx.lg.colRequest")}</span>
                <span />
              </div>
              {/*
                Новые — сверху. aria-live не ставим: лента, зачитывающая каждую
                строку раз в четыре секунды, сделала бы экран непригодным для
                диктора; отметка «оновлено о» объявляет себя сама.
              */}
              <ol ref={listRef} aria-label={ut("ops.logs.title")} className="m-0 list-none p-0">
                {lines.map((l) => {
                  const key = lineKey(l);
                  return (
                    <LogRow
                      key={key}
                      line={l}
                      open={open === key}
                      onToggle={() => setOpen(open === key ? null : key)}
                      onOnly={(id) => setRid(id)}
                    />
                  );
                })}
              </ol>
            </div>
          </div>
        )}

        {loaded ? (
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-divider px-4 py-3">
            {older ? (
              capped ? (
                <Quiet>{fill(ut("ops.history.capped"), { n: fmtInt(HISTORY_CAP, loc) })}</Quiet>
              ) : (
                <Button size="xs" icon={<OpsIcon name="chevrons-down" />} onClick={() => void loadOlder()} disabled={loadingOlder}>
                  {ut("ops.history.older")}
                </Button>
              )
            ) : null}
            {meta ? (
              <span className="text-small text-text-2">
                {fill(ut("ops.logs.threshold"), { level: ut(LEVEL_KEY[meta.threshold]) })}{" "}
                {fill(ut("ops.logs.capacity"), { n: fmtInt(meta.capacity, loc) })}
              </span>
            ) : null}
          </div>
        ) : null}
        <KbdHints
          bar
          keys={[
            ["J K", ut("opx.kbd.rows")],
            ["Enter", ut("opx.lg.kbdOpen")],
            ["/", ut("opx.kbd.search")],
            ["P", ut("opx.lg.kbdPause")],
          ]}
        />
      </Panel>
    </div>
  );
}

function LevelTag({ level }: { level: OpsLevel }) {
  const { ut } = useLang();
  if (level === "error") {
    return (
      <Tag tone="attention" icon={<OpsIcon name="octagon-x" />}>
        {ut(LEVEL_KEY.error)}
      </Tag>
    );
  }
  if (level === "warn") {
    return (
      <Tag tone="attention" icon={<OpsIcon name="triangle-alert" />}>
        {ut(LEVEL_KEY.warn)}
      </Tag>
    );
  }
  return <Tag tone={level === "info" ? "plain" : "done"}>{ut(LEVEL_KEY[level])}</Tag>;
}

function LogRow({
  line,
  open,
  onToggle,
  onOnly,
}: {
  line: OpsLogLine;
  open: boolean;
  onToggle: () => void;
  onOnly: (id: string) => void;
}) {
  const { ut } = useLang();
  const toast = useToast();
  const loc = locale();
  const fields = Object.keys(line.fields).length ? fieldsText(line.fields) : "";
  const id = `ops-line-${line.instance ?? ""}-${line.seq}`;
  const raw = JSON.stringify(
    {
      level: line.level,
      msg: line.message,
      time: line.at,
      ...(line.requestId ? { requestId: line.requestId } : {}),
      ...line.fields,
      ...(line.fingerprint ? { fingerprint: line.fingerprint } : {}),
      ...(line.instance ? { instance: line.instance } : {}),
    },
    null,
    2,
  );
  return (
    <li className={cx("border-b border-divider last:border-b-0", line.level === "error" && !open && "bg-warn-tint", open && "bg-panel-2")}>
      <div
        data-line
        tabIndex={-1}
        role="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a, button")) return;
          onToggle();
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className={cx(
          "grid min-h-11 cursor-pointer items-center gap-3 px-4 py-1.5 outline-none hover:bg-panel-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus",
          LINE_COLS,
        )}
      >
        <Mono className="tabular-nums text-text">{stamp(line.at, loc)}</Mono>
        <span>
          <LevelTag level={line.level} />
        </span>
        <span className="min-w-0 break-words font-mono text-[12px] leading-[18px]">
          <b className="font-bold text-text">{line.message}</b>
          {fields ? <span className="text-text-2"> {fields}</span> : null}
        </span>
        <span className="min-w-0">
          {line.requestId ? (
            <span className="inline-flex items-center gap-1">
              <Tooltip label={ut("ops.logs.onlyThis")}>
                <button
                  type="button"
                  aria-label={`${ut("ops.logs.onlyThis")}: ${line.requestId}`}
                  onClick={() => onOnly(line.requestId!)}
                  className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[12px] font-semibold text-violet-ink hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                >
                  {shortId(line.requestId)}
                </button>
              </Tooltip>
              <button
                type="button"
                aria-label={ut("ops.copyId")}
                title={ut("ops.copyId")}
                onClick={() =>
                  void navigator.clipboard?.writeText(line.requestId!).then(
                    () => toast(ut("ops.idCopied"), "ok"),
                    () => toast(ut("ops.copyFailed"), "err"),
                  )
                }
                className="inline-grid size-7 min-h-0 cursor-pointer place-items-center rounded-[8px] border-0 bg-transparent p-0 text-muted hover:bg-sunk hover:text-text"
              >
                <OpsIcon name="copy" size={14} />
              </button>
            </span>
          ) : (
            <span className="text-muted">—</span>
          )}
        </span>
        <span className="flex justify-end">
          <OpsIcon name="chevron-right" size={16} className={cx("text-muted transition-transform duration-[180ms]", open && "rotate-90 text-violet-ink")} />
        </span>
      </div>
      {open ? (
        <div id={id} className="grid grid-cols-[minmax(0,1fr)_260px] gap-4 px-4 pb-4 max-[1000px]:grid-cols-1">
          <pre className="m-0 overflow-x-auto whitespace-pre-wrap rounded-control bg-sunk px-3 py-2.5 font-mono text-[12px] font-medium leading-[18px] text-text [overflow-wrap:anywhere]">
            {raw}
          </pre>
          <div className="flex flex-col gap-2">
            {line.requestId ? (
              <>
                <Button size="xs" icon={<OpsIcon name="list-filter" />} onClick={() => onOnly(line.requestId!)}>
                  {ut("ops.logs.onlyThis")}
                </Button>
                <ButtonLink size="xs" to={`/ops/trace/${encodeURIComponent(line.requestId)}`}>
                  <OpsIcon name="route" size={14} />
                  {ut("ops.trace.open")}
                </ButtonLink>
              </>
            ) : null}
            {line.fingerprint ? (
              <ButtonLink size="xs" to={`/ops/errors?window=24h&open=${encodeURIComponent(line.fingerprint)}`}>
                <OpsIcon name="bug" size={14} />
                {ut("opx.lg.toGroup")}
              </ButtonLink>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              icon={<OpsIcon name="copy" />}
              onClick={() =>
                void navigator.clipboard?.writeText(raw).then(
                  () => toast(ut("opx.lg.lineCopied"), "ok"),
                  () => toast(ut("ops.copyFailed"), "err"),
                )
              }
            >
              {ut("opx.lg.copyLine")}
            </Button>
            <PanelNote icon="shield-check">{ut("opx.lg.scrubbed")}</PanelNote>
          </div>
        </div>
      ) : null}
    </li>
  );
}
