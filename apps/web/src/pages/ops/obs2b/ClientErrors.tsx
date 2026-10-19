import { useMemo, useState } from "react";
import type { ClientErrorKind, ClientPlatform, OpsClientErrorGroup } from "@quizzy/shared";
import { api } from "../../../api";
import { Figure, ShareBar, type SharePart } from "../../../charts/clinical";
import { locale } from "../../../format";
import { useLang } from "../../../lang";
import { Callout, Loading, SearchField, ViewPills, useToast, useUrlState } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Panel } from "../../../ui/layout";
import { Button, Segmented, Tag, type TagTone } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { MarkedColumns, RankBars } from "../charts";
import { OpsIcon, type OpsIconName } from "../icons";
import { PERIOD_KEY, fmtInt } from "../model";
import { CopyLinkButton, Facts, Mono, OpsHead, OpsToolbar, Quiet, sinceText, useCount, useOpsResource } from "../parts";
import {
  CE_WINDOWS,
  KIND_KEY,
  PLATFORM_KEY,
  REST_KEY,
  browserFamily,
  dayLabel,
  filterClientErrors,
  lastDays,
  newGroupsByDay,
  parseCeWindow,
  parseKind,
  parsePlatform,
  rankBy,
  releaseDayMarks,
  seenWithin,
  type KindFilter,
  type PlatformFilter,
} from "./model";
import { ExpandButton } from "./parts";

/*
 * Помилки клієнта в «Виразній»: что падает у людей в браузере и в телефоне.
 *
 * Решение заказчика 2026-09-26: падения React (граница ошибок консоли и
 * кабинета), window.onerror и необработанные отказы промисов, сетевые сбои
 * консоли (сеть, 5xx — не 4xx бизнес-логики) и глобальный обработчик ошибок
 * мобилки. Отдельным разделом, а не вкладкой «Помилок»: те — процесс
 * сервера, эти — база, и смешать их в одном списке значило бы сравнивать
 * несравнимое.
 *
 * Группа — отпечаток (платформа, вид, имя, сообщение без данных, верхний
 * кадр, маршрут шаблоном): двести одинаковых падений у двухсот человек —
 * одна строка. Ни адреса с идентификатором, ни текста полей: всё вычищено
 * на клиенте и ещё раз на сервере. Чтение — в журнал.
 *
 * Период — по последнему случаю группы: «что падало за 30 днів». Счётчик
 * группы — за всю её жизнь (до срока хранения): случаев по дням сервер не
 * хранит, и делить счётчик по дням значило бы выдумать.
 *
 * Фильтры и раскрытая группа — в адресе: ссылку «вот эта ошибка»
 * пересылают коллеге.
 */

const POLL_MS = 60_000;
const PAGE = 20;
const DAY_MS = 86_400_000;

export default function OpsClientErrors() {
  const { ut } = useLang();
  const loc = locale();
  const count = useCount();
  const [q, setQ] = useUrlState("q", "");
  const [rawDays, setDays] = useUrlState("days", "30");
  const [rawPlatform, setPlatform] = useUrlState("platform", "all");
  const [rawKind, setKind] = useUrlState("kind", "all");
  const [order, setOrder] = useUrlState("order", "last");
  const [open, setOpen] = useUrlState("open", "");
  const [limit, setLimit] = useState(PAGE);
  const days = parseCeWindow(rawDays);
  const platform = parsePlatform(rawPlatform);
  const kind = parseKind(rawKind);

  const res = useOpsResource(() => api.opsClientErrors(), [], POLL_MS);
  const releases = useResource(() => api.opsReleaseVersions(), []);
  const now = res.updatedAt ?? Date.now();
  const data = res.data;

  /* окно и платформа — для всего экрана; вид — только для списка, у его пилюль свои счётчики */
  const scoped = useMemo(
    () => (data ? filterClientErrors(seenWithin(data.items, days, now), { q, platform, kind: "all" }) : null),
    [data, days, now, q, platform],
  );
  const shown = useMemo(() => {
    if (!scoped) return null;
    const list = kind === "all" ? scoped.slice() : scoped.filter((g) => g.kind === kind);
    return order === "count"
      ? list.sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
      : list.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }, [scoped, kind, order]);

  const cases = (list: readonly OpsClientErrorGroup[]) => list.reduce((s, g) => s + g.count, 0);
  const inWindow = data ? seenWithin(data.items, days, now) : [];
  const head = (
    <OpsHead
      meta={
        data
          ? [
              fill(ut("opx.er.metaBold"), {
                groups: count(["opx.er.groups.one", "opx.er.groups.few", "opx.er.groups.many"], inWindow.length),
                cases: count(["opx.er.cases.one", "opx.er.cases.few", "opx.er.cases.many"], cases(inWindow)),
              }),
              fill(ut("opx.ce.metaSub"), {
                web: fmtInt(cases(inWindow.filter((g) => g.platform === "web")), loc),
                mobile: fmtInt(cases(inWindow.filter((g) => g.platform === "mobile")), loc),
                days,
              }),
            ]
          : null
      }
      actions={<CopyLinkButton />}
      toolbar={
        <OpsToolbar>
          <SearchField value={q} onChange={setQ} placeholder={ut("opx.ce.search")} slash width={260} />
          <Segmented
            label={ut("ops.history.periodLabel")}
            value={String(days)}
            onChange={(v) => setDays(v)}
            items={CE_WINDOWS.map((w) => ({ key: String(w), label: ut(PERIOD_KEY[`${w}d` as "7d" | "30d" | "90d"]) }))}
          />
          <span className="ml-2 text-small font-semibold text-muted">{ut("o2b.ce.platform")}</span>
          <Segmented<PlatformFilter>
            label={ut("o2b.ce.platform")}
            value={platform}
            onChange={setPlatform}
            items={[
              { key: "all", label: ut("o2b.ce.all") },
              { key: "web", label: ut(PLATFORM_KEY.web) },
              { key: "mobile", label: ut(PLATFORM_KEY.mobile) },
            ]}
          />
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
  if (!data || !scoped || !shown) {
    return (
      <>
        {head}
        <Loading rows={5} />
      </>
    );
  }

  const kinds: ClientErrorKind[] = ["react", "error", "rejection", "network"];
  const visible = shown.slice(0, limit);
  const range = `${dayLabel(lastDays(now, days)[0]!, loc)}–${dayLabel(lastDays(now, 1)[0]!, loc)}`;

  return (
    <div className="flex flex-col gap-4">
      {head}
      {scoped.length ? (
        <Panel title={fill(ut("opx.ce.overview"), { days })} icon={<OpsIcon name="chart-column" />} sub={range}>
          <ErrorShape items={scoped} retentionDays={data.retentionDays} now={now} days={days} releases={releases.data?.items ?? []} />
        </Panel>
      ) : null}

      <Panel
        title={ut("opx.ce.groups")}
        icon={<OpsIcon name="layers" />}
        sub={ut("opx.ce.groupsSub")}
        actions={
          <Segmented
            label={ut("opx.er.order")}
            value={order === "count" ? "count" : "last"}
            onChange={(o) => setOrder(o)}
            items={[
              { key: "last", label: ut("opx.er.byLast") },
              { key: "count", label: ut("opx.er.byCount") },
            ]}
          />
        }
        flush
        footer={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {shown.length > visible.length ? (
              <>
                <span className="text-small text-text-2">{fill(ut("opx.ce.shownOf"), { shown: visible.length, total: shown.length })}</span>
                <Button variant="ghost" size="sm" icon={<OpsIcon name="chevron-down" />} onClick={() => setLimit(limit + PAGE)}>
                  {ut("opx.ce.showMore")}
                </Button>
              </>
            ) : null}
            <span className="ml-auto text-small text-muted">{ut("opx.ce.readLogged")}</span>
          </div>
        }
      >
        <div className="px-4 pb-3">
          <ViewPills
            label={ut("o2b.ce.kind")}
            value={kind}
            onChange={(k) => setKind(k as KindFilter)}
            items={[
              { key: "all", label: ut("opx.ce.allKinds"), count: cases(scoped) },
              ...kinds.map((k) => ({ key: k, label: ut(KIND_KEY[k]), count: cases(scoped.filter((g) => g.kind === k)) })),
            ]}
          />
        </div>
        {data.total > data.items.length ? (
          <div className="px-4 pb-2">
            <Quiet>{fill(ut("o2b.ce.more"), { shown: fmtInt(data.items.length, loc), total: fmtInt(data.total, loc) })}</Quiet>
          </div>
        ) : null}
        {data.total >= data.capacity ? (
          <div className="px-4 pb-3">
            <Callout kind="warn">{fill(ut("o2b.ce.full"), { cap: fmtInt(data.capacity, loc) })}</Callout>
          </div>
        ) : null}
        {data.items.length === 0 ? (
          <div className="px-4 pb-3">
            <Quiet>{ut("o2b.ce.empty")}</Quiet>
          </div>
        ) : shown.length === 0 ? (
          <div className="px-4 pb-3">
            <Quiet>{ut("ops.errors.noMatch")}</Quiet>
          </div>
        ) : (
          <div role="table" aria-label={ut("opx.ce.groups")} className="overflow-x-auto">
            <div className="min-w-[860px]">
              <div role="row" className={cx(ROW, "h-[38px] border-y border-divider bg-panel-2 text-caption font-bold leading-none text-muted")}>
                <span role="columnheader" />
                <span role="columnheader">{ut("o2b.ce.kind")}</span>
                <span role="columnheader">
                  <span className="max-[1365px]:sr-only">{ut("o2b.ce.platform")}</span>
                </span>
                <span role="columnheader">{ut("opx.ce.colWhat")}</span>
                <span role="columnheader">{ut("opx.ce.colBuild")}</span>
                <span role="columnheader" className="text-right">
                  {ut("opx.ce.colCases")}
                </span>
                <span role="columnheader">{ut("opx.er.colWhen")}</span>
              </div>
              <ul className="m-0 list-none p-0">
                {visible.map((g) => (
                  <GroupRow
                    key={g.fingerprint}
                    g={g}
                    fresh={Date.parse(g.firstAt) >= now - DAY_MS}
                    open={open === g.fingerprint}
                    onToggle={() => setOpen(open === g.fingerprint ? "" : g.fingerprint)}
                  />
                ))}
              </ul>
            </div>
          </div>
        )}
      </Panel>

      <Callout kind="line" icon={<OpsIcon name="shield-check" />}>
        {fill(ut("o2b.ce.stamp"), { days: data.retentionDays })}
      </Callout>
    </div>
  );
}

/* ─────────── форма списка ─────────── */

/** Цвета долей по порядку: фиолетовый, янтарь, бирюза, синий; остаток и «не відомо» — серым */
const SHARE_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)"];

/**
 * Форма списка над ним — по тем же группам, что показаны ниже (окно,
 * платформа, поиск): график — вид этого списка, а не отдельный отчёт.
 *
 * Случаев по дням здесь нет, и это не упущение: группа хранит общий
 * счётчик и два момента — первый и последний раз, — а не счёт по дням. По
 * дням рисуется то, что известно точно: в какой день появилась новая
 * группа, с отметками выкаток — столбец после выкатки ищут первым.
 */
export function ErrorShape({
  items,
  retentionDays,
  now,
  days = 30,
  releases = [],
}: {
  items: readonly OpsClientErrorGroup[];
  retentionDays: number;
  now: number;
  days?: number;
  releases?: readonly { version: string; firstAt: string }[];
}) {
  const { ut } = useLang();
  const loc = locale();
  const dayKeys = lastDays(now, days);
  const fresh = newGroupsByDay(items, dayKeys);
  const freshTotal = fresh.reduce((s, n) => s + n, 0);
  const marks = releaseDayMarks(dayKeys, releases);
  const lastMark = marks.at(-1) ?? null;
  const lastRelease = lastMark ? releases.find((r) => r.version === lastMark.label) : undefined;
  const after = lastRelease ? items.filter((g) => g.firstAt >= lastRelease.firstAt).length : 0;
  const routes = rankBy(items, (g) => g.route, 5);
  const other = (n: number) => fill(ut("sig.other"), { n });

  /* доли — по случаям; мобилка без браузера — «застосунок», а не пропуск; остаток — серым */
  const share = (keyOf: (g: OpsClientErrorGroup) => string | null, label: (key: string) => string): SharePart[] => {
    const r = rankBy(items, keyOf, 4);
    return [
      ...r.top.map((p, i) => ({ key: p.key || "\u0000none", label: label(p.key), value: p.value, color: p.key ? SHARE_COLORS[i] : "var(--c5)" })),
      ...(r.rest ? [{ key: REST_KEY, label: other(r.rest.keys), value: r.rest.value, color: "var(--c5)" }] : []),
    ];
  };
  const browserOf = (g: OpsClientErrorGroup) => browserFamily(g.browser) ?? (g.platform === "mobile" ? "\u0000app" : null);
  const browserLabel = (key: string) => (key === "\u0000app" ? ut("opx.ce.app") : key || ut("sig.ce.unknown"));

  return (
    <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,0.95fr)] gap-6 max-[1200px]:grid-cols-[repeat(2,minmax(0,1fr))] max-[760px]:grid-cols-1">
      <Figure
        title={ut("sig.ce.newByDay")}
        caption={
          lastRelease && freshTotal
            ? fill(ut("opx.ce.newAfter"), { n: freshTotal, k: after, v: lastRelease.version })
            : fill(ut("opx.ce.newN"), { n: freshTotal })
        }
      >
        {freshTotal ? (
          <MarkedColumns
            columns={dayKeys.map((k, i) => ({ key: k, label: dayLabel(k, loc), value: fresh[i]! }))}
            marks={marks}
            label={ut("sig.ce.newByDay")}
            height={180}
          />
        ) : (
          <Quiet>{fill(ut("sig.ce.noNew"), { days })}</Quiet>
        )}
      </Figure>
      <Figure title={ut("sig.ce.byScreen")} caption={fill(ut("sig.ce.countsCaption"), { days: retentionDays })}>
        <RankBars
          labelW={150}
          items={[
            ...routes.top.map((r) => ({
              key: r.key,
              title: r.key,
              label: <Mono className="text-[11.5px] text-text">{r.key}</Mono>,
              value: r.value,
              text: fmtInt(r.value, loc),
              note: fill(ut("sig.ce.inGroups"), { n: fmtInt(r.value, loc), g: r.groups }),
            })),
            ...(routes.rest
              ? [
                  {
                    key: routes.rest.key,
                    title: other(routes.rest.keys),
                    label: <span className="text-small text-text-2">{other(routes.rest.keys)}</span>,
                    value: routes.rest.value,
                    text: fmtInt(routes.rest.value, loc),
                    muted: true,
                  },
                ]
              : []),
          ]}
        />
      </Figure>
      <Figure title={ut("sig.ce.where")} caption={ut("opx.ce.whereSub")}>
        <span className="mb-1.5 block text-caption font-bold text-muted">{ut("sig.ce.browser")}</span>
        <ShareBar parts={share(browserOf, browserLabel)} label={ut("sig.ce.browser")} percent={false} />
        <span className="mb-1.5 mt-4 block text-caption font-bold text-muted">{ut("sig.ce.os")}</span>
        <ShareBar parts={share((g) => g.os, (k) => k || ut("sig.ce.unknown"))} label={ut("sig.ce.os")} percent={false} />
      </Figure>
    </div>
  );
}

/* ─────────── строка группы ─────────── */

/* на 1280 платформа — значком (слово остаётся для диктора): ширина нужнее тексту ошибки */
const ROW =
  "grid grid-cols-[40px_136px_100px_minmax(0,1fr)_110px_64px_150px] items-center gap-3 px-4 max-[1365px]:grid-cols-[40px_136px_24px_minmax(0,1fr)_104px_56px_142px]";

const KIND_TAG: Record<ClientErrorKind, { tone: TagTone; icon: OpsIconName }> = {
  react: { tone: "attention", icon: "monitor-x" },
  error: { tone: "plain", icon: "circle-alert" },
  rejection: { tone: "plain", icon: "circle-dashed" },
  network: { tone: "info", icon: "wifi-off" },
};

const PLATFORM_ICON: Record<ClientPlatform, OpsIconName> = { web: "monitor", mobile: "smartphone" };

function GroupRow({ g, fresh, open, onToggle }: { g: OpsClientErrorGroup; fresh: boolean; open: boolean; onToggle: () => void }) {
  const { ut } = useLang();
  const loc = locale();
  const id = `o2b-group-${g.fingerprint}`;
  const k = KIND_TAG[g.kind];
  return (
    <li className={cx("border-b border-divider last:border-b-0", open && "bg-panel-2")}>
      <div role="row" className={cx(ROW, "py-2.5")}>
        <span role="cell">
          <ExpandButton open={open} controls={id} onToggle={onToggle} labels={{ open: ut("opx.er.expand"), close: ut("opx.er.collapse") }} />
        </span>
        <span role="cell">
          <Tag tone={k.tone} icon={<OpsIcon name={k.icon} />}>
            {ut(KIND_KEY[g.kind])}
          </Tag>
        </span>
        <span role="cell" title={ut(PLATFORM_KEY[g.platform])} className="inline-flex items-center gap-1.5 text-small text-text-2">
          <OpsIcon name={PLATFORM_ICON[g.platform]} size={15} className="shrink-0 text-muted" />
          <span className="max-[1365px]:sr-only">{ut(PLATFORM_KEY[g.platform])}</span>
        </span>
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
          <span className="flex min-w-0 items-center gap-x-2 whitespace-nowrap text-small text-muted">
            {ut("opx.ce.screen")}
            <Mono className="shrink-0 text-text-2">{g.route}</Mono>
            {g.kind === "network" && (g.apiRoute || g.status !== null) ? (
              <>
                <span className="shrink-0">{ut("opx.ce.request")}</span>
                <Mono className="min-w-0 truncate text-text-2">
                  {[g.apiMethod, g.apiRoute].filter(Boolean).join(" ")}
                  {g.status === 0 ? ` · ${ut("o2b.ce.noResponse")}` : g.status ? ` · ${g.status}` : ""}
                </Mono>
              </>
            ) : null}
          </span>
        </span>
        <span role="cell">
          {g.release ? (
            <Tag tone={fresh ? "attention" : "plain"} className="font-mono">
              {g.release}
            </Tag>
          ) : (
            <span className="text-muted">—</span>
          )}
        </span>
        <b role="cell" className="text-right text-[17px] font-extrabold tabular-nums text-text">
          {fmtInt(g.count, loc)}
        </b>
        <span role="cell" className="flex min-w-0 flex-col text-small leading-[18px]">
          <span className="tabular-nums text-text">{sinceText(g.lastAt, loc)}</span>
          {g.browser || g.os ? <span className="truncate text-muted">{[g.browser, g.os].filter(Boolean).join(", ")}</span> : null}
        </span>
      </div>
      {open ? <GroupDetails id={id} g={g} /> : null}
    </li>
  );
}

function GroupDetails({ id, g }: { id: string; g: OpsClientErrorGroup }) {
  const { ut } = useLang();
  const loc = locale();
  const toast = useToast();
  const copy = (text: string, done: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => toast(done, "ok"),
      () => toast(ut("ops.copyFailed"), "err"),
    );
  const link = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("open", g.fingerprint);
    copy(url.toString(), ut("opx.linkCopied"));
  };
  return (
    <div id={id} className="grid grid-cols-[minmax(0,1fr)_300px] gap-6 px-4 pb-4 pl-[60px] max-[1000px]:grid-cols-1">
      <div className="min-w-0">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-caption font-bold text-muted">{g.release ? fill(ut("opx.ce.stackOf"), { v: g.release }) : ut("opx.er.stack")}</span>
          {g.frames.length ? (
            <Button variant="ghost" size="xs" icon={<OpsIcon name="copy" />} className="ml-auto" onClick={() => copy([`${g.name}: ${g.message}`, ...g.frames].join("\n"), ut("opx.er.stackCopied"))}>
              {ut("opx.er.copy")}
            </Button>
          ) : null}
        </div>
        {g.frames.length ? (
          <pre className="m-0 max-h-[260px] overflow-auto rounded-control bg-sunk px-3 py-2.5 font-mono text-[12px] leading-[18px] text-text shadow-[inset_0_0_0_1px_var(--divider)]">
            <span className="font-bold text-warn">
              {g.name}: {g.message}
            </span>
            {g.frames.map((f, i) => (
              <span key={`${i}-${f}`} className="block">
                <span className="mr-2 inline-block w-4 text-right text-muted">{i + 1}</span>
                {f}
              </span>
            ))}
          </pre>
        ) : (
          <Quiet>{ut("opx.ce.noStack")}</Quiet>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-small text-muted">
          <span>
            {ut("opx.ce.first")} <b className="font-extrabold tabular-nums text-text">{sinceText(g.firstAt, loc)}</b>
          </span>
          <span>
            {ut("opx.ce.fingerprint")} <Mono className="font-semibold text-text">{g.fingerprint.slice(0, 8)}</Mono>
          </span>
          <Button variant="ghost" size="sm" icon={<OpsIcon name="link" />} onClick={link}>
            {ut("opx.ce.groupLink")}
          </Button>
        </div>
      </div>
      <Facts
        w={130}
        items={[
          [ut("o2b.ce.platform"), ut(PLATFORM_KEY[g.platform])],
          [ut("sig.ce.browser"), g.browser ?? (g.platform === "mobile" ? ut("opx.ce.app") : ut("sig.ce.unknown"))],
          [ut("sig.ce.os"), g.os ?? ut("sig.ce.unknown")],
          [ut("opx.ce.colBuild"), g.release ? <Mono key="r">{g.release}</Mono> : "—"],
          [ut("opx.ce.colCases"), <b key="n" className="font-extrabold tabular-nums">{fmtInt(g.count, loc)}</b>],
        ]}
      />
    </div>
  );
}
