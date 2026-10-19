import { useState } from "react";
import type { MobileReport, MobileVersionRow } from "@quizzy/shared";
import { api } from "../../../api";
import { HBars, TimeColumns } from "../../../charts/clinical";
import { ATTENTION_COLOR, ChartLegend, OTHER_COLOR, SINGLE_COLOR } from "../../../charts/kit";
import { dayFull } from "../../../format";
import { useLang } from "../../../lang";
import { Callout, DataTable, Empty, Screen, type Column } from "../../../ui";
import { Ic } from "../../../ui/icons";
import { Panel } from "../../../ui/layout";
import { ButtonLink, Tag } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { SectionPage } from "../people2/frame";
import { Ix } from "../people2/icons";
import { Id } from "./icons";
import {
  PLATFORM_LABEL,
  dayColumns,
  lagParts,
  lateParts,
  newestBuilds,
  platformSplit,
  versionParts,
  type Window,
} from "./model";
import { Facts, FootNote, Label, WindowSwitch, dayTick, int, pct, stamp, usePlural } from "./parts";

/** Версий полосами поимённо; старше — одной строкой «старіші» */
const TOP_VERSIONS = 5;

const ON_DEVICES = { one: "oppd.onDevices.one", few: "oppd.onDevices.few", many: "oppd.onDevices.many" } as const;
const OF_DEVICES = { one: "oppd.ofDevices.one", few: "oppd.ofDevices.few", many: "oppd.ofDevices.many" } as const;

/**
 * «Мобільний застосунок» — на каких сборках сидят люди, что застряло в
 * очередях на телефонах, какие сдачи пришли с опозданием.
 *
 * Сборка важна не сама по себе: приложение считает баллы офлайн тем же
 * движком, что и сервер (docs/ARCHITECTURE.md), и исправление в движке
 * доходит до человека только с новой сборкой. Поэтому устройства на старых
 * сборках — янтарной заметкой сверху, когда их больше нуля: это ровно
 * «требует внимания».
 *
 * Падения здесь не собираются: их сбор — у раздела «Помилки клієнта»
 * техпанели, и заметка внизу ведёт туда: второй сборщик дублировал бы его
 * и расходился с ним в числах.
 */
export default function OpsMobile() {
  const { ut } = useLang();
  const plural = usePlural();
  const [days, setDays] = useState<Window>(90);
  const res = useResource(() => api.opsMobile(days), [days]);
  const data = res.data;
  const platform = usePlatformName();
  const builds = data ? newestBuilds(data.versions, data.newest) : [];

  return (
    <SectionPage
      title={ut("opsd.tab.mobile")}
      perm="ops.read"
      meta={
        data
          ? [
              plural(data.devices.total, { one: "oppd.m.metaDevices.one", few: "oppd.m.metaDevices.few", many: "oppd.m.metaDevices.many" }),
              platformSplit(data.versions)
                .map((p) => `${platform(p.platform)} ${int(p.devices)}`)
                .join(", "),
            ]
          : undefined
      }
      actions={<WindowSwitch value={days} onChange={setDays} />}
      lead={
        <>
          {ut("oppd.m.lead")}
          {data?.newest
            ? ` ${
                builds.length
                  ? fill(ut("oppd.m.leadNewest"), { v: data.newest, b: builds.join(", ") })
                  : fill(ut("oppd.m.leadNewestOnly"), { v: data.newest })
              }`
            : null}
        </>
      }
    >
      <Screen res={res}>{(d) => <MobileBody data={d} />}</Screen>
    </SectionPage>
  );
}

/** Имя платформы словарём; незнакомую сервер присылает как есть, без платформы — прочерк */
function usePlatformName(): (p: string | null) => string {
  const { ut } = useLang();
  return (p) => (p ? (PLATFORM_LABEL[p] ? ut(PLATFORM_LABEL[p]!) : p) : "—");
}

export function MobileBody({ data }: { data: MobileReport }) {
  const { ut } = useLang();
  const plural = usePlural();

  return (
    <div className="flex flex-col gap-4">
      {data.old.devices > 0 ? (
        <Callout
          kind="warn"
          icon={<Id.calculator />}
          title={plural(data.old.devices, { one: "oppd.m.oldTitle.one", few: "oppd.m.oldTitle.few", many: "oppd.m.oldTitle.many" })}
        >
          {data.old.percent === null ? ut("oppd.m.oldText") : fill(ut("oppd.m.oldTextShare"), { p: pct(data.old.percent) })}
        </Callout>
      ) : null}
      <div className="@container">
        <div className="grid items-stretch gap-4 @min-[860px]:grid-cols-2">
          <Versions data={data} />
          <Queue data={data} />
        </div>
      </div>
      <VersionTable rows={data.versions} />
      <Late late={data.late} />
      <Callout
        kind="line"
        icon={<Ix.monitorX />}
        actions={
          <ButtonLink to="/ops/client-errors" size="xs">
            <Ic.external size={14} />
            {ut("o2b.tab.clientErrors")}
          </ButtonLink>
        }
      >
        {ut("oppd.m.crashes")}
      </Callout>
    </div>
  );
}

/* ─────────── устройства по версии ─────────── */

/**
 * Устройства по версии — строками от новой к старым. Новая — фиолетовым,
 * старые — янтарём (исправление движка до них не дошло), неизвестная —
 * серым; слово каждого цвета — в легенде, чтобы старое читалось и без цвета.
 */
function Versions({ data }: { data: MobileReport }) {
  const { ut } = useLang();
  const parts = versionParts(data.versions, TOP_VERSIONS);
  return (
    <Panel title={ut("sig.m.versions")} icon={<Ix.smartphone />} sub={fill(ut("oppd.inWindowN"), { n: int(data.devices.total) })}>
      {parts.length ? (
        <>
          <HBars
            items={parts.map((p) => ({
              key: p.key,
              label: p.rest ? (
                fill(ut("sig.m.older"), { n: p.rest })
              ) : p.version === null ? (
                ut("sig.m.unknownVersion")
              ) : (
                <span className="font-mono">{p.version}</span>
              ),
              value: p.devices,
              strong: p.version !== null && !p.old,
              attention: p.old,
            }))}
          />
          <ChartLegend
            className="mt-3"
            items={[
              { key: "newest", label: ut("oppd.m.newest"), color: SINGLE_COLOR, kind: "band" },
              { key: "old", label: ut("opsd.m.oldTag"), color: ATTENTION_COLOR, kind: "band" },
              { key: "unknown", label: ut("oppd.m.unknownShort"), color: OTHER_COLOR, kind: "band" },
            ]}
          />
          <p className="m-0 mt-2 text-caption text-muted">{ut("sig.m.versionsCaption")}</p>
        </>
      ) : (
        <Empty compact title={ut("opsd.m.noDevices")} />
      )}
    </Panel>
  );
}

/* ─────────── очередь на устройствах ─────────── */

function Queue({ data }: { data: MobileReport }) {
  const { ut } = useLang();
  const plural = usePlural();
  const q = data.queue;
  return (
    <Panel title={ut("opsd.m.queue")} icon={<Ic.inbox />}>
      <p className="m-0 mb-2 text-caption text-muted">{ut("oppd.m.queueNote")}</p>
      <Facts
        rows={[
          {
            key: "reporting",
            label: ut("opsd.m.reporting"),
            value: int(q.devicesReporting),
            note: plural(data.devices.total, OF_DEVICES),
          },
          { key: "pending", label: ut("opsd.m.pending"), value: int(q.pending), note: plural(q.devicesWithPending, ON_DEVICES) },
          /* отклонённые сами не повторяются — ждут человека: вот это и требует внимания */
          {
            key: "rejected",
            label: ut("opsd.m.rejected"),
            value: int(q.rejected),
            warn: q.rejected > 0,
            note: plural(q.devicesWithRejected, ON_DEVICES),
          },
        ]}
      />
      {q.rejected > 0 ? (
        <Callout kind="warn" className="mt-3" icon={<Ic.alert />}>
          {ut("oppd.m.rejectedNote")}
        </Callout>
      ) : null}
    </Panel>
  );
}

/* ─────────── версии таблицей ─────────── */

function VersionTable({ rows }: { rows: readonly MobileVersionRow[] }) {
  const { ut } = useLang();
  const platform = usePlatformName();
  const columns: Column<MobileVersionRow>[] = [
    {
      key: "platform",
      header: ut("opsd.m.platform"),
      required: true,
      width: 150,
      render: (v) => (
        <span className="flex items-center gap-1.5 text-text-2">
          <Ix.smartphone size={14} className="text-muted" />
          {platform(v.platform)}
        </span>
      ),
    },
    {
      key: "version",
      header: ut("opsd.m.version"),
      required: true,
      width: 120,
      render: (v) => <span className="font-mono text-[12.5px] text-text">{v.version ?? "—"}</span>,
    },
    {
      key: "build",
      header: ut("opsd.m.build"),
      required: true,
      width: 110,
      render: (v) => <span className="font-mono text-[12.5px] text-text-2">{v.build ?? "—"}</span>,
    },
    { key: "devices", header: ut("opsd.m.devicesCol"), num: true, required: true, width: 110, render: (v) => int(v.devices) },
    { key: "seen", header: ut("opsd.m.lastSeen"), required: true, render: (v) => <span className="text-text-2">{stamp(v.lastSeenAt)}</span> },
    {
      key: "state",
      header: "",
      required: true,
      width: 150,
      render: (v) =>
        v.version === null ? null : v.old ? (
          <Tag tone="attention" icon={<Ic.history />}>
            {ut("opsd.m.oldTag")}
          </Tag>
        ) : (
          <Tag tone="good" icon={<Ic.check />}>
            {ut("oppd.m.newest")}
          </Tag>
        ),
    },
  ];
  return (
    <Panel
      title={ut("opsd.m.versions")}
      icon={<Ic.list />}
      sub={ut("oppd.m.oldDef")}
      flush
      footer={<FootNote>{ut("oppd.m.engine")}</FootNote>}
    >
      {rows.length ? (
        <DataTable
          rows={[...rows]}
          columns={columns}
          rowKey={(v) => `${v.platform}|${v.version}|${v.build}`}
          label={ut("opsd.m.versions")}
          dense
          sticky={false}
        />
      ) : (
        <div className="px-4">
          <Empty compact title={ut("opsd.m.noDevices")} />
        </div>
      )}
    </Panel>
  );
}

/* ─────────── запоздавшие сдачи ─────────── */

function Late({ late }: { late: MobileReport["late"] }) {
  const { ut } = useLang();
  /* null, а не ноль: у пустой выборки медианы нет, и «0 хв» соврало бы */
  const lag = (ms: number | null) => {
    const p = lagParts(ms);
    return p ? fill(ut(p.unit), { n: p.n }) : "—";
  };
  return (
    <Panel title={ut("opsd.m.late")} icon={<Ix.clockAlert />}>
      <div className="@container">
        <div className="grid gap-x-8 gap-y-5 @min-[900px]:grid-cols-[240px_minmax(0,1fr)_minmax(0,1.25fr)]">
          <div className="min-w-0">
            <p className="m-0 mb-2 text-caption text-muted">{ut("opsd.m.lateHint")}</p>
            <Facts
              rows={[
                { key: "total", label: ut("opsd.m.lateTotal"), value: int(late.total) },
                { key: "submitted", label: ut("oppd.m.submitted"), value: int(late.submitted) },
                { key: "median", label: ut("opsd.m.median"), value: lag(late.medianLagMs) },
                { key: "p90", label: ut("opsd.m.p90"), value: lag(late.p90LagMs) },
              ]}
            />
          </div>
          <div className="min-w-0">
            <Label className="mb-2">{ut("opsd.m.lateBuckets")}</Label>
            <HBars items={lateParts(late.buckets).map((p) => ({ key: p.key, label: ut(p.label), value: p.value }))} />
          </div>
          <div className="min-w-0">
            <Label className="mb-2">{ut("opsd.m.lateByDay")}</Label>
            <TimeColumns
              columns={dayColumns(late.byDay, (d) => d.count, dayTick).map((c) => ({ ...c, tip: dayFull(c.key) }))}
              height={170}
              label={ut("opsd.m.lateByDay")}
            />
          </div>
        </div>
      </div>
    </Panel>
  );
}
