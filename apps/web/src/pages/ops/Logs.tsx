import { useEffect, useRef, useState } from "react";
import type { OpsLevel, OpsLogLine, OpsLogs, OpsLogWindow } from "@quizzy/shared";
import { api } from "../../api";
import { locale } from "../../format";
import { useLang } from "../../lang";
import { Loading, useUrlState } from "../../ui";
import { cx } from "../../ui/cx";
import { Button, ButtonLink, Input, Select } from "../../ui/primitives";
import { RuleSection } from "../../ui/section";
import { fill } from "../dashboard/model";
import { PeriodSwitch } from "../dashboard/parts";
import {
  FEED_CAP,
  HISTORY_CAP,
  LEVELS,
  LEVEL_KEY,
  LOG_WINDOWS,
  PERIOD_KEY,
  clock,
  fieldsText,
  fmtInt,
  lineKey,
  mergeFeed,
  parseLevel,
  parseLogWindow,
  shortId,
} from "./model";
import { LogVolumeCharts } from "./charts";
import { HistoryNote } from "./obs2a/parts";
import { Quiet, Stamp, StatusMark, useOpsResource } from "./parts";

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
 * последней увиденной, и лента не перекачивает одно и то же. «Пауза»
 * останавливает опрос, не сбрасывая курсор: после паузы приходят строки,
 * накопившиеся за неё, а если их было больше, чем держит буфер, — лента
 * говорит о разрыве, а не молчит.
 *
 * Фильтры — уровень (от выбранного и выше), поиск по сообщению и полям,
 * номер запроса — в адресе: ?level=warn&q=…&rid=…. Нажатие на номер
 * запроса в строке ставит фильтр по нему — так разбирают один запрос от
 * первой строки до последней. Смена фильтра начинает ленту заново.
 *
 * Скрытая вкладка браузера не опрашивается; ушёл с вкладки панели —
 * компонент размонтирован, и цикл гаснет вместе с ним.
 *
 * Над лентой (волна 11) — объём строк за период по уровням: всего и
 * отдельно предупреждения с ошибками (GET /api/ops/logs/volume, только
 * счёт). Своим опросом раз в минуту и без фильтров ленты: график отвечает
 * «когда стало шумно», а фильтр — «что именно», и смешивать их значило бы
 * рисовать поиск по тексту за две недели на каждый набранный символ.
 */

const POLL_MS = 4_000;
const VOLUME_POLL_MS = 60_000;
/* первая выборка — побольше: человек открывает ленту, чтобы увидеть, что было */
const FIRST_LIMIT = 300;
const NEXT_LIMIT = 500;
/* страница истории назад — та же, что первая: читается одним взглядом прокрутки */
const OLDER_LIMIT = 300;

const LEVEL_TEXT: Record<OpsLevel, string> = {
  error: "text-danger",
  warn: "text-accent",
  info: "text-text-2",
  debug: "text-muted",
};

type Meta = Pick<OpsLogs, "since" | "capacity" | "threshold" | "from" | "retentionDays" | "store" | "historyUnavailable">;

export default function OpsLogs() {
  const { ut } = useLang();
  const loc = locale();
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

  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const [lines, setLines] = useState<OpsLogLine[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [gap, setGap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  /* курсор более старой страницы истории; null — старше в периоде ничего нет */
  const [older, setOlder] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /* поколение фильтров: страница «старіші», пришедшая от прежних фильтров, отбрасывается */
  const generation = useRef(0);

  useEffect(() => {
    /*
     * Свой цикл, а не useResource: здесь ответ не заменяет данные, а
     * дописывается к ним, и следующий вопрос зависит от предыдущего ответа
     * (курсор). Каждое поколение фильтров — свой цикл: ответ, пришедший от
     * прежних фильтров, отбрасывается по номеру поколения.
     */
    let alive = true;
    let cursor: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    generation.current++;
    setLines([]);
    setGap(false);
    setLoaded(false);
    setOlder(null);

    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState === "visible" && !pausedRef.current) {
        try {
          const first = cursor === null;
          const page = await api.opsLogs({
            level: level ?? undefined,
            q: q || undefined,
            requestId: rid || undefined,
            after: first ? undefined : cursor!,
            limit: first ? FIRST_LIMIT : NEXT_LIMIT,
            /* период — только у первой страницы: дальше лента берёт живой хвост памяти */
            window: first ? win : undefined,
          });
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
          if (alive) setError(e instanceof Error ? e.message : ut("common.error"));
        }
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [level, q, rid, win, ut]);

  const filtered = Boolean(level || q || rid);
  const capped = lines.length >= HISTORY_CAP;

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

  return (
    <div>
      <Stamp
        updatedAt={updatedAt}
        note={
          meta ? (
            <HistoryNote
              window={win}
              from={meta.from}
              retentionDays={meta.retentionDays}
              store={meta.store}
              unavailable={meta.historyUnavailable}
            />
          ) : undefined
        }
      />

      <RuleSection
        className="mt-[16px]"
        title={ut("ops.logs.title")}
        hint={
          meta
            ? `${fill(ut("ops.logs.threshold"), { level: ut(LEVEL_KEY[meta.threshold]) })} ${fill(ut("ops.logs.capacity"), { n: fmtInt(meta.capacity, loc) })}`
            : undefined
        }
        actions={
          <>
            <PeriodSwitch<OpsLogWindow>
              label={ut("ops.history.periodLabel")}
              value={win}
              onChange={(v) => setWindow(v)}
              options={LOG_WINDOWS.map((w) => [w, ut(PERIOD_KEY[w])] as const)}
            />
            {paused ? <StatusMark tone="warn">{ut("ops.logs.pausedNote")}</StatusMark> : null}
            <Button variant={paused ? "primary" : "ghost"} aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
              {paused ? ut("ops.logs.resume") : ut("ops.logs.pause")}
            </Button>
          </>
        }
      >
        {/* график — только когда пришёл: его отказ не должен закрывать ленту, ради которой вкладку открыли */}
        {volume.data ? (
          <div className="mb-[28px]">
            <LogVolumeCharts volume={volume.data} now={volume.updatedAt ?? Date.now()} />
          </div>
        ) : null}
        <div className="mb-[12px] flex flex-wrap items-center gap-[12px]">
          <Select
            aria-label={ut("ops.logs.level")}
            value={level ?? ""}
            onChange={(e) => setLevel(e.target.value)}
            className="w-[210px] max-[600px]:w-full"
          >
            <option value="">{ut("ops.logs.levelAll")}</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {fill(ut("ops.logs.levelFrom"), { level: ut(LEVEL_KEY[l]) })}
              </option>
            ))}
          </Select>
          <Input
            look="fill"
            ph="plain"
            aria-label={ut("ops.logs.search")}
            placeholder={ut("ops.logs.search")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-[200px] flex-1 px-[10px]"
            autoComplete="off"
            maxLength={200}
          />
          <Input
            look="fill"
            ph="plain"
            aria-label={ut("ops.logs.requestId")}
            placeholder={ut("ops.logs.requestId")}
            value={rid}
            onChange={(e) => setRid(e.target.value.trim())}
            className="w-[240px] px-[10px] font-mono max-[600px]:w-full"
            autoComplete="off"
            maxLength={64}
          />
          {/* номер задан — одна кнопка до трассы: те же строки плюс итог, ошибка, журнал и SQL */}
          {rid ? (
            <ButtonLink variant="ghost" to={`/ops/trace/${encodeURIComponent(rid)}`}>
              {ut("ops.trace.open")}
            </ButtonLink>
          ) : null}
          {filtered ? (
            <Button
              variant="quiet"
              onClick={() => {
                setLevel("");
                setQ("");
                setRid("");
                setDraft("");
              }}
            >
              {ut("ops.logs.clear")}
            </Button>
          ) : null}
        </div>

        {gap ? <Quiet>{ut("ops.logs.gap")}</Quiet> : null}

        {error && !loaded ? (
          <Loading error={error} />
        ) : !loaded ? (
          <Loading rows={8} />
        ) : lines.length === 0 ? (
          <Quiet>{filtered ? ut("ops.logs.noMatch") : ut("ops.logs.empty")}</Quiet>
        ) : (
          /*
            Новые — сверху. aria-live не ставим: лента, зачитывающая каждую
            строку раз в четыре секунды, сделала бы экран непригодным для
            диктора; отметка «оновлено о» объявляет себя сама.
          */
          <ol aria-label={ut("ops.logs.title")} className="m-0 list-none overflow-x-auto p-0 font-mono text-[12px] leading-[18px]">
            {lines.map((l) => (
              <li
                key={lineKey(l)}
                className="grid grid-cols-[76px_104px_84px_minmax(0,1fr)] gap-x-[12px] border-b border-hairline py-[4px] max-[700px]:grid-cols-[76px_minmax(0,1fr)]"
              >
                <span className="text-muted tabular-nums">{clock(l.at, loc)}</span>
                <span className={cx("truncate", LEVEL_TEXT[l.level], l.level === "error" && "font-bold")}>
                  {ut(LEVEL_KEY[l.level])}
                </span>
                <span className="max-[700px]:hidden">
                  {l.requestId ? (
                    <button
                      type="button"
                      title={`${l.requestId} — ${ut("ops.logs.onlyThis")}`}
                      aria-label={`${ut("ops.logs.onlyThis")}: ${l.requestId}`}
                      onClick={() => setRid(l.requestId!)}
                      className="border-0 bg-transparent p-0 font-mono text-[12px] text-primary hover:underline outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                    >
                      {shortId(l.requestId)}
                    </button>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </span>
                <span className="min-w-0 break-words max-[700px]:col-span-2">
                  <span className="font-bold text-text">{l.message}</span>
                  {Object.keys(l.fields).length ? <span className="text-muted"> {fieldsText(l.fields)}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        )}

        {loaded && older ? (
          <div className="flex flex-wrap items-center gap-x-[14px] gap-y-[6px] pt-[12px]">
            {capped ? (
              <Quiet>{fill(ut("ops.history.capped"), { n: fmtInt(HISTORY_CAP, loc) })}</Quiet>
            ) : (
              <Button variant="ghost" onClick={() => void loadOlder()} disabled={loadingOlder}>
                {ut("ops.history.older")}
              </Button>
            )}
            <span className="text-[13px] text-muted">{fill(ut("ops.history.shown"), { n: fmtInt(lines.length, loc) })}</span>
          </div>
        ) : null}
      </RuleSection>
    </div>
  );
}
