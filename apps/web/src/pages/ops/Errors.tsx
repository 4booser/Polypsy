import { useMemo } from "react";
import type { OpsErrorGroup } from "@quizzy/shared";
import { api } from "../../api";
import { dateTime, locale } from "../../format";
import { useLang } from "../../lang";
import { Loading, useUrlState } from "../../ui";
import { IconDisclosure } from "../../ui/glyphs";
import { Button, Input, Num } from "../../ui/primitives";
import { RuleSection } from "../../ui/section";
import { fill } from "../dashboard/model";
import { clock, filterErrors, fmtInt } from "./model";
import { Quiet, RequestId, Stamp, useOpsResource } from "./parts";

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
 */

const POLL_MS = 30_000;

export default function OpsErrors() {
  const { ut } = useLang();
  const loc = locale();
  const [q, setQ] = useUrlState("q", "");
  const [open, setOpen] = useUrlState("open", "");

  const res = useOpsResource(() => api.opsErrors(), [], POLL_MS);
  const shown = useMemo(() => (res.data ? filterErrors(res.data.items, q) : null), [res.data, q]);

  if (res.error && !res.data) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data || !shown) return <Loading rows={5} />;
  const total = res.data.items.reduce((s, g) => s + g.count, 0);

  return (
    <div>
      <Stamp since={res.data.since} updatedAt={res.updatedAt} />

      <RuleSection
        className="mt-[16px]"
        title={ut("ops.errors.title")}
        hint={ut("ops.errors.hint")}
        actions={
          <>
            <Num className="text-[13px] text-muted">
              {fill(ut("ops.errors.summary"), { groups: fmtInt(res.data.items.length, loc), n: fmtInt(total, loc) })}
            </Num>
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
          </>
        }
      >
        {res.data.dropped > 0 ? (
          <Quiet>{fill(ut("ops.errors.dropped"), { n: fmtInt(res.data.dropped, loc), cap: res.data.capacity })}</Quiet>
        ) : null}
        {res.data.items.length === 0 ? (
          <Quiet>{ut("ops.errors.empty")}</Quiet>
        ) : shown.length === 0 ? (
          <Quiet>{ut("ops.errors.noMatch")}</Quiet>
        ) : (
          <ul className="m-0 list-none p-0">
            {shown.map((g) => (
              <ErrorRow
                key={g.fingerprint}
                g={g}
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

function ErrorRow({ g, open, onToggle }: { g: OpsErrorGroup; open: boolean; onToggle: () => void }) {
  const { ut } = useLang();
  const loc = locale();
  const stackId = `ops-stack-${g.fingerprint}`;
  return (
    <li className="border-b border-hairline py-[12px]">
      <div className="flex flex-wrap items-baseline gap-x-[14px] gap-y-[4px]">
        {/* число повторов — первым: по нему решают, с какой группы начинать */}
        <Num className="w-[56px] shrink-0 text-right text-[17px] font-bold leading-[20px] text-accent">{fmtInt(g.count, loc)}</Num>
        <span className="min-w-0 break-all font-mono text-[15px] font-bold leading-[20px] text-primary">{g.name}</span>
        <span className="min-w-0 flex-1 basis-[280px] break-words font-mono text-[13px] leading-[18px] text-text-2">
          {g.message || "—"}
        </span>
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
        <span title={dateTime(g.lastAt)}>{fill(ut("ops.errors.last"), { time: clock(g.lastAt, loc) })}</span>
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
