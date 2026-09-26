import { useMemo } from "react";
import type { OpsErrorGroup, OpsErrorWindow } from "@quizzy/shared";
import { api } from "../../api";
import { dateTime, locale } from "../../format";
import { useLang } from "../../lang";
import { Loading, useUrlState } from "../../ui";
import { IconDisclosure } from "../../ui/glyphs";
import { Button, Input, Num } from "../../ui/primitives";
import { RuleSection } from "../../ui/section";
import { fill } from "../dashboard/model";
import { PeriodSwitch } from "../dashboard/parts";
import { ErrorCharts } from "./charts";
import { ERROR_WINDOWS, PERIOD_KEY, filterErrors, fmtInt, parseErrorWindow } from "./model";
import { HistoryNote, TraceSearch } from "./obs2a/parts";
import { Quiet, RequestId, Stamp, StatusMark, useOpsResource } from "./parts";

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
 * пересылают коллеге. Поиск (?q=) — тоже там. Чтение вкладки пишется в
 * журнал (ops.errors.read) — опросы одного человека склеены сервером.
 *
 * Решение заказчика 2026-09-26 (участок obs2a): группы — из истории в базе
 * за период (?window=24h|7d|30d|90d), а не с момента запуска. Число в
 * строке — случаи за период; «усього» — с первого появления, пока группа
 * хранится (90 дней без повторов). Группа, впервые появившаяся внутри
 * периода, помечена «нова»: после выкатки это первое, что ищут. Поле
 * номера запроса ведёт в трассу — номер с экрана ошибки у человека.
 *
 * Над списком (волна 11) — случаи во времени (часы из базы, разложенные в
 * местные корзины периода) и самые частые группы. Поиск на графики не
 * действует: он сужает список, а «сколько всего и когда» — вопрос периода.
 */

const POLL_MS = 30_000;

export default function OpsErrors() {
  const { ut } = useLang();
  const loc = locale();
  const [q, setQ] = useUrlState("q", "");
  const [open, setOpen] = useUrlState("open", "");
  const [rawWindow, setWindow] = useUrlState("window", "24h");
  const win: OpsErrorWindow = parseErrorWindow(rawWindow);

  const res = useOpsResource(() => api.opsErrors(win), [win], POLL_MS);
  const shown = useMemo(() => (res.data ? filterErrors(res.data.items, q) : null), [res.data, q]);

  if (res.error && !res.data) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data || !shown) return <Loading rows={5} />;
  const total = res.data.items.reduce((s, g) => s + g.count, 0);
  const from = res.data.from;

  return (
    <div>
      <Stamp
        updatedAt={res.updatedAt}
        note={
          <HistoryNote
            window={win}
            from={res.data.from}
            retentionDays={res.data.retentionDays}
            store={res.data.store}
            unavailable={res.data.historyUnavailable}
          />
        }
      />

      <RuleSection
        className="mt-[16px]"
        title={ut("ops.errors.title")}
        hint={ut("ops.errors.hint")}
        actions={
          <>
            <Num className="text-[13px] text-muted">
              {fill(ut("ops.errors.summary"), { groups: fmtInt(res.data.items.length, loc), n: fmtInt(total, loc) })}
            </Num>
            <PeriodSwitch<OpsErrorWindow>
              label={ut("ops.history.periodLabel")}
              value={win}
              onChange={(v) => setWindow(v)}
              options={ERROR_WINDOWS.map((w) => [w, ut(PERIOD_KEY[w])] as const)}
            />
          </>
        }
      >
        {res.data.items.length ? (
          <div className="mb-[28px]">
            <ErrorCharts data={res.data} window={win} now={res.updatedAt ?? Date.now()} />
          </div>
        ) : null}
        <div className="mb-[12px] flex flex-wrap items-start justify-between gap-[12px]">
          <Input
            look="fill"
            ph="plain"
            aria-label={ut("ops.errors.search")}
            placeholder={ut("ops.errors.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-[280px] px-[10px] max-[600px]:w-full"
            autoComplete="off"
            maxLength={120}
          />
          <TraceSearch />
        </div>
        {res.data.dropped > 0 ? (
          <Quiet>{fill(ut("ops.errors.dropped"), { n: fmtInt(res.data.dropped, loc), cap: res.data.capacity })}</Quiet>
        ) : null}
        {res.data.items.length === 0 ? (
          <Quiet>{res.data.from ? ut("ops.history.errorsEmpty") : ut("ops.errors.empty")}</Quiet>
        ) : shown.length === 0 ? (
          <Quiet>{ut("ops.errors.noMatch")}</Quiet>
        ) : (
          <ul className="m-0 list-none p-0">
            {shown.map((g) => (
              <ErrorRow
                key={g.fingerprint}
                g={g}
                from={from}
                open={open === g.fingerprint}
                onToggle={() => setOpen(open === g.fingerprint ? "" : g.fingerprint)}
              />
            ))}
          </ul>
        )}
      </RuleSection>
    </div>
  );
}

function ErrorRow({
  g,
  from,
  open,
  onToggle,
}: {
  g: OpsErrorGroup;
  /** Начало периода истории; нет — вкладка в режиме памяти процесса */
  from?: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { ut } = useLang();
  const loc = locale();
  const stackId = `ops-stack-${g.fingerprint}`;
  /* впервые — внутри периода: новая ошибка, а не старая знакомая */
  const fresh = Boolean(from && g.firstAt >= from);
  return (
    <li className="border-b border-hairline py-[12px]">
      <div className="flex flex-wrap items-baseline gap-x-[14px] gap-y-[4px]">
        {/* число повторов — первым: по нему решают, с какой группы начинать */}
        <Num className="w-[56px] shrink-0 text-right text-[17px] font-bold leading-[20px] text-accent">{fmtInt(g.count, loc)}</Num>
        <span className="min-w-0 break-all font-mono text-[15px] font-bold leading-[20px] text-primary">{g.name}</span>
        <span className="min-w-0 flex-1 basis-[280px] break-words font-mono text-[13px] leading-[18px] text-text-2">
          {g.message || "—"}
        </span>
        {fresh ? <StatusMark tone="warn">{ut("ops.history.new")}</StatusMark> : null}
      </div>
      <div className="mt-[6px] flex flex-wrap items-center gap-x-[16px] gap-y-[6px] pl-[70px] text-[13px] leading-[18px] text-muted max-[600px]:pl-0">
        {g.route ? (
          <span className="font-mono text-[12px] text-text">
            {g.method} {g.route}
          </span>
        ) : (
          <span>{ut("ops.errors.outside")}</span>
        )}
        {g.code ? <Num>{g.code}</Num> : null}
        <span title={dateTime(g.firstAt)}>{fill(ut("ops.errors.first"), { time: dateTime(g.firstAt) })}</span>
        <span title={dateTime(g.lastAt)}>{fill(ut("ops.history.lastOn"), { time: dateTime(g.lastAt) })}</span>
        {g.totalCount !== undefined && g.totalCount !== g.count ? (
          <Num>{fill(ut("ops.history.total"), { n: fmtInt(g.totalCount, loc) })}</Num>
        ) : null}
        <RequestId id={g.lastRequestId} />
        <Button
          variant="ghost"
          aria-expanded={open}
          aria-controls={stackId}
          onClick={onToggle}
          className="h-[28px] px-[8px] text-[13px]"
          icon={
            <span aria-hidden className={open ? "inline-block rotate-90" : "inline-block"}>
              <IconDisclosure />
            </span>
          }
        >
          {open ? ut("ops.errors.hideStack") : ut("ops.errors.showStack")}
        </Button>
      </div>
      {open ? (
        <div id={stackId} className="mt-[8px] pl-[70px] max-[600px]:pl-0">
          {g.frames.length ? (
            <pre className="m-0 overflow-x-auto rounded-[5px] bg-primary-soft p-[12px] font-mono text-[12px] leading-[18px] text-text-2">
              {g.frames.join("\n")}
            </pre>
          ) : (
            <Quiet>{ut("ops.errors.noStack")}</Quiet>
          )}
        </div>
      ) : null}
    </li>
  );
}
