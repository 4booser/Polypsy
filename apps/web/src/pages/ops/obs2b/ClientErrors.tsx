import { useMemo } from "react";
import type { OpsClientErrorGroup } from "@quizzy/shared";
import { api } from "../../../api";
import { Figure, HBars, ShareBar, TimeColumns } from "../../../charts/clinical";
import { dateTime, day, locale } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useUrlState } from "../../../ui";
import { cx } from "../../../ui/cx";
import { IconDisclosure } from "../../../ui/glyphs";
import { Button, Input, Num } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { fill } from "../../dashboard/model";
import { PeriodSwitch } from "../../dashboard/parts";
import { fmtInt } from "../model";
import { Quiet, Stamp, useOpsResource } from "../parts";
import {
  KIND_KEY,
  PLATFORM_KEY,
  browserFamily,
  filterClientErrors,
  lastDays,
  newGroupsByDay,
  parseKind,
  parsePlatform,
  rankBy,
  REST_KEY,
  topGroups,
  type KindFilter,
  type PlatformFilter,
} from "./model";
import { FIG_GRID } from "./charts";
import { Meta } from "./parts";

/*
 * Помилки клієнта: что падает у людей в браузере и в телефоне.
 *
 * Решение заказчика 2026-09-26: падения React (граница ошибок консоли и
 * кабинета), window.onerror и необработанные отказы промисов, сетевые сбои
 * консоли (сеть, 5xx — не 4xx бизнес-логики) и глобальный обработчик ошибок
 * мобилки. Отдельным разделом, а не вкладкой «Помилок»: те — память
 * процесса сервера, эти — база, и смешать их в одном списке значило бы
 * сравнивать «с момента запуска» с «за девяносто дней».
 *
 * Группа — отпечаток (платформа, вид, имя, сообщение без данных, верхний
 * кадр, маршрут шаблоном): двести одинаковых падений у двухсот человек —
 * одна строка «200 разів». Ни адреса с идентификатором, ни текста полей:
 * всё вычищено на клиенте и ещё раз на сервере. Чтение — в журнал.
 *
 * Фильтры и раскрытая группа — в адресе: ссылку «вот эта ошибка»
 * пересылают коллеге.
 */

const POLL_MS = 60_000;

export default function OpsClientErrors() {
  const { ut } = useLang();
  const loc = locale();
  const [q, setQ] = useUrlState("q", "");
  const [rawPlatform, setPlatform] = useUrlState("platform", "all");
  const [rawKind, setKind] = useUrlState("kind", "all");
  const [open, setOpen] = useUrlState("open", "");
  const platform = parsePlatform(rawPlatform);
  const kind = parseKind(rawKind);

  const res = useOpsResource(() => api.opsClientErrors(), [], POLL_MS);
  const shown = useMemo(() => (res.data ? filterClientErrors(res.data.items, { q, platform, kind }) : null), [res.data, q, platform, kind]);

  if (res.error && !res.data) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data || !shown) return <Loading rows={5} />;
  const d = res.data;
  const total = d.items.reduce((s, g) => s + g.count, 0);

  return (
    <div>
      <Stamp updatedAt={res.updatedAt} note={fill(ut("o2b.ce.stamp"), { days: d.retentionDays })} />

      <RuleSection
        className="mt-[16px]"
        title={ut("o2b.tab.clientErrors")}
        hint={ut("o2b.ce.hint")}
        actions={
          <>
            <Num className="text-[13px] text-muted">
              {fill(ut("ops.errors.summary"), { groups: fmtInt(d.items.length, loc), n: fmtInt(total, loc) })}
            </Num>
            <Input
              look="fill"
              ph="plain"
              aria-label={ut("o2b.ce.search")}
              placeholder={ut("o2b.ce.search")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-[260px] px-[10px] max-[600px]:w-full"
              autoComplete="off"
              maxLength={120}
            />
          </>
        }
      >
        <div className="mb-[12px] flex flex-wrap items-center gap-x-[24px] gap-y-[8px]">
          <PeriodSwitch<PlatformFilter>
            label={ut("o2b.ce.platform")}
            value={platform}
            onChange={setPlatform}
            options={[
              ["all", ut("o2b.ce.all")],
              ["web", ut(PLATFORM_KEY.web)],
              ["mobile", ut(PLATFORM_KEY.mobile)],
            ]}
          />
          <PeriodSwitch<KindFilter>
            label={ut("o2b.ce.kind")}
            value={kind}
            onChange={setKind}
            options={[
              ["all", ut("o2b.ce.all")],
              ["react", ut(KIND_KEY.react)],
              ["error", ut(KIND_KEY.error)],
              ["rejection", ut(KIND_KEY.rejection)],
              ["network", ut(KIND_KEY.network)],
            ]}
          />
        </div>
        {d.total > d.items.length ? (
          <Quiet>{fill(ut("o2b.ce.more"), { shown: fmtInt(d.items.length, loc), total: fmtInt(d.total, loc) })}</Quiet>
        ) : null}
        {d.total >= d.capacity ? <Quiet>{fill(ut("o2b.ce.full"), { cap: fmtInt(d.capacity, loc) })}</Quiet> : null}
        {d.items.length === 0 ? (
          <Quiet>{ut("o2b.ce.empty")}</Quiet>
        ) : shown.length === 0 ? (
          <Quiet>{ut("ops.errors.noMatch")}</Quiet>
        ) : (
          <>
            <ErrorShape items={shown} retentionDays={d.retentionDays} now={res.updatedAt ?? Date.now()} />
            <ul className="m-0 list-none p-0">
              {shown.map((g) => (
                <GroupRow
                  key={g.fingerprint}
                  g={g}
                  open={open === g.fingerprint}
                  onToggle={() => setOpen(open === g.fingerprint ? "" : g.fingerprint)}
                />
              ))}
            </ul>
          </>
        )}
      </RuleSection>
    </div>
  );
}

const SHAPE_DAYS = 30;
const TOP = 8;

/**
 * Форма списка над ним (волна 11) — по тем же группам, что показаны ниже,
 * с учётом поиска и фильтров: график — вид этого списка, а не отдельный
 * отчёт, и фильтр «мобілка» должен менять оба.
 *
 * Случаев по дням здесь нет, и это не упущение: группа хранит общий
 * счётчик и два момента — первый и последний раз, — а не счёт по дням, и
 * разложить его по дням значило бы выдумать. По дням рисуется то, что
 * известно точно: в какой день появилась новая группа. Столбец после
 * выкатки — первое, что ищут на этом экране.
 */
export function ErrorShape({ items, retentionDays, now }: { items: readonly OpsClientErrorGroup[]; retentionDays: number; now: number }) {
  const { ut } = useLang();
  const days = lastDays(now, SHAPE_DAYS);
  const fresh = newGroupsByDay(items, days);
  const routes = rankBy(items, (g) => g.route, TOP);
  const groups = topGroups(items, TOP);
  const other = (n: number) => fill(ut("sig.other"), { n });

  /* доли — по случаям; светлее — реже; «не відомо» (мобілка без браузера) — отдельной частью, а не пропуском */
  const share = (keyOf: (g: OpsClientErrorGroup) => string | null) => {
    const r = rankBy(items, keyOf, 4);
    const parts = [...r.top, ...(r.rest ? [r.rest] : [])];
    return parts.map((p, i) => ({
      key: p.key,
      label: r.rest && p.key === REST_KEY ? other(r.rest.keys) : p.key || ut("sig.ce.unknown"),
      value: p.value,
      step: parts.length > 1 ? 1 - i / (parts.length - 1) : 1,
    }));
  };

  return (
    <div className={cx(FIG_GRID, "mb-[24px] mt-[8px]")}>
      <Figure title={ut("sig.ce.newByDay")} caption={fill(ut("sig.ce.newByDayCaption"), { days: SHAPE_DAYS })}>
        {fresh.some((n) => n > 0) ? (
          <TimeColumns columns={days.map((d, i) => ({ key: d, label: day(d), value: fresh[i]! }))} label={ut("sig.ce.newByDay")} />
        ) : (
          <Quiet>{fill(ut("sig.ce.noNew"), { days: SHAPE_DAYS })}</Quiet>
        )}
      </Figure>
      <Figure title={ut("sig.ce.byScreen")} caption={fill(ut("sig.ce.countsCaption"), { days: retentionDays })}>
        <HBars
          items={[
            ...routes.top.map((r) => ({
              key: r.key,
              label: <span className="font-mono text-[12px]">{r.key}</span>,
              value: r.value,
              text: fill(ut("sig.ce.inGroups"), { n: r.value, g: r.groups }),
            })),
            ...(routes.rest ? [{ key: routes.rest.key, label: other(routes.rest.keys), value: routes.rest.value }] : []),
          ]}
        />
      </Figure>
      <Figure title={ut("sig.ce.topGroups")} caption={fill(ut("sig.ce.countsCaption"), { days: retentionDays })}>
        <HBars
          items={groups.map((g) => ({
            key: g.fingerprint,
            label: (
              <>
                <span className="font-mono text-[12px] font-bold text-primary">{g.name}</span>{" "}
                <span className="font-mono text-[12px]">{g.message || g.route}</span>
              </>
            ),
            value: g.count,
          }))}
        />
      </Figure>
      <Figure title={ut("sig.ce.where")} caption={ut("sig.ce.whereCaption")}>
        <span className="mb-[6px] block text-[13px] font-bold leading-[16px] text-muted">{ut("sig.ce.browser")}</span>
        <ShareBar parts={share((g) => browserFamily(g.browser))} label={ut("sig.ce.browser")} />
        <span className="mb-[6px] mt-[16px] block text-[13px] font-bold leading-[16px] text-muted">{ut("sig.ce.os")}</span>
        <ShareBar parts={share((g) => g.os)} label={ut("sig.ce.os")} />
      </Figure>
    </div>
  );
}

function GroupRow({ g, open, onToggle }: { g: OpsClientErrorGroup; open: boolean; onToggle: () => void }) {
  const { ut } = useLang();
  const loc = locale();
  const stackId = `o2b-stack-${g.fingerprint}`;
  return (
    <li className="border-b border-hairline py-[12px]">
      <div className="flex flex-wrap items-baseline gap-x-[14px] gap-y-[4px]">
        {/* число повторов — первым: по нему решают, с какой группы начинать */}
        <Num className="w-[56px] shrink-0 text-right text-[17px] font-bold leading-[20px] text-accent">{fmtInt(g.count, loc)}</Num>
        <span className="min-w-0 break-all font-mono text-[15px] font-bold leading-[20px] text-primary">{g.name}</span>
        <span className="min-w-0 flex-1 basis-[280px] break-words font-mono text-[13px] leading-[18px] text-text-2">{g.message || "—"}</span>
      </div>
      <div className="mt-[6px] flex flex-wrap items-center gap-x-[16px] gap-y-[6px] pl-[70px] max-[600px]:pl-0">
        <Meta className="text-text">
          {ut(PLATFORM_KEY[g.platform])} · {ut(KIND_KEY[g.kind])}
        </Meta>
        <span className="font-mono text-[12px] text-text" title={ut("o2b.ce.screen")}>
          {g.route}
        </span>
        {g.kind === "network" ? (
          <span className="font-mono text-[12px] text-text-2">
            {g.apiMethod ?? ""} {g.apiRoute ?? ""} {g.status === 0 ? `· ${ut("o2b.ce.noResponse")}` : g.status ? `· ${g.status}` : ""}
          </span>
        ) : null}
        {g.release ? <Meta>{fill(ut("o2b.ce.release"), { v: g.release })}</Meta> : null}
        {g.browser || g.os ? <Meta>{[g.browser, g.os].filter(Boolean).join(" · ")}</Meta> : null}
        <Meta>
          <span title={dateTime(g.firstAt)}>{fill(ut("ops.errors.first"), { time: dateTime(g.firstAt) })}</span>
        </Meta>
        <Meta>
          <span title={dateTime(g.lastAt)}>{fill(ut("o2b.ce.last"), { time: dateTime(g.lastAt) })}</span>
        </Meta>
        {g.frames.length ? (
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
        ) : null}
      </div>
      {open && g.frames.length ? (
        <div id={stackId} className="mt-[8px] pl-[70px] max-[600px]:pl-0">
          <pre className="m-0 overflow-x-auto rounded-[5px] bg-primary-soft p-[12px] font-mono text-[12px] leading-[18px] text-text-2">
            {g.frames.join("\n")}
          </pre>
        </div>
      ) : null}
    </li>
  );
}
