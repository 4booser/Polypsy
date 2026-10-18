import { useState } from "react";
import {
  OPS_REPEAT_LIMITS,
  OPS_RULE_LIMITS,
  type OpsAlertChannel,
  type OpsAlertEvent,
  type OpsAlertHistory,
  type OpsAlertRule,
  type OpsAlerts,
} from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { Figure, TimeColumns } from "../../../charts/clinical";
import { locale, timeOfDay } from "../../../format";
import { useLang } from "../../../lang";
import { Callout, DataTable, Drawer, DrawerSection, Loading, Tooltip, useAction, useToast, type Column } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Panel } from "../../../ui/layout";
import { Button, CheckLabel, Checkbox, Field, Input, Switch } from "../../../ui/primitives";
import type { Resource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { RankBars } from "../charts";
import { OpsIcon } from "../icons";
import { fmtUptime } from "../model";
import { CopyLinkButton, OpsHead, PanelNote, Quiet, StatusMark, sinceText, useCount, useOpsResource } from "../parts";
import {
  CHANNEL_KEY,
  DELIVERY_KEY,
  EVENT_KEY,
  RULE_BELOW,
  RULE_HINT,
  RULE_NAME,
  RULE_SHORT,
  RULE_UNIT,
  STATE_KEY,
  STATE_TONE,
  anyAlerts,
  channelTrail,
  dayLabel,
  draftOf,
  firedByRule,
  fmtRuleValue,
  hasThreshold,
  hasWindow,
  ruleEvents,
  ruleInputOf,
  toggleChannel,
  unavailableKey,
  type DraftError,
  type RuleDraft,
} from "./model";
import { CHANNEL_ICON, EventGlyph, EventTag } from "./parts";

/*
 * Сповіщення в «Виразній»: правила таблицей с правкой в ящике, каналы
 * карточками, история — формой месяца и списком событий.
 *
 * Решение заказчика 2026-09-26: всплеск 5xx, молчащий планировщик, рост
 * p95, место на диске, провал проверки журнала — в Telegram или на почту,
 * одно оповещение на инцидент, повтор не чаще N минут, «відновлено» по
 * окончании. Правила правит ops.manage, смотрит ops.read — карандаш и
 * «Тестове» видны только первому, а сервер проверяет то же сам.
 *
 * Про каналы экран говорит только «задано / не задано»: токен бота, номер
 * чата и адреса получателей сюда не приходят вовсе.
 *
 * Бэкап — строкой «поза застосунком»: его снимает cron на хосте, и сервер
 * о нём не знает. Выдумывать здесь «гаразд» было бы хуже пустоты.
 */

const POLL_MS = 30_000;

const CHANNELS: readonly OpsAlertChannel[] = ["telegram", "email"];

export default function OpsAlertsPage() {
  const { ut } = useLang();
  const loc = locale();
  const { can } = useAuth();
  const manage = can("ops.manage");
  const count = useCount();
  const res = useOpsResource(() => api.opsAlerts(), [], POLL_MS);
  const hist = useOpsResource(() => api.opsAlertHistory(), [], POLL_MS);
  const [editing, setEditing] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const d = res.data;
  const firing = d ? d.rules.filter((r) => r.state === "firing").length : 0;
  const ok = d ? d.rules.filter((r) => r.state === "ok").length : 0;
  const lastFired = hist.data?.items.find((e) => e.kind === "fired") ?? null;

  const head = (
    <OpsHead
      meta={
        d
          ? [
              firing
                ? count(["opx.al.firingN.one", "opx.al.firingN.few", "opx.al.firingN.many"], firing)
                : count(["opx.al.okN.one", "opx.al.okN.few", "opx.al.okN.many"], ok),
              !d.checker.enabled
                ? ut("opx.al.metaCheckerOff")
                : lastFired
                  ? fill(ut("opx.al.metaLast"), { time: sinceText(lastFired.at, loc) })
                  : ut("opx.al.metaNever"),
            ]
          : null
      }
      actions={<CopyLinkButton />}
    />
  );

  if (res.error && !d) {
    return (
      <>
        {head}
        <Loading error={res.error} onRetry={res.reload} />
      </>
    );
  }
  if (!d) {
    return (
      <>
        {head}
        <Loading rows={6} />
      </>
    );
  }
  const now = res.updatedAt ?? Date.now();
  const rule = d.rules.find((r) => r.key === editing) ?? null;

  return (
    <div className="flex flex-col gap-4">
      {head}
      <p className="m-0 max-w-[110ch] text-small text-text-2">{ut("opx.al.lead")}</p>
      <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4 max-[1180px]:grid-cols-1">
        <RulesPanel
          d={d}
          manage={manage}
          editing={drawerOpen ? editing : null}
          onEdit={(key) => {
            setEditing(key);
            setDrawerOpen(true);
          }}
        />
        <ChannelsPanel d={d} manage={manage} events={hist.data?.items ?? []} onTested={hist.reload} />
      </div>
      <HistoryPanel hist={hist} />
      {manage && rule ? (
        <RuleDrawer
          key={rule.key}
          open={drawerOpen}
          rule={rule}
          d={d}
          history={hist.data}
          now={now}
          onClose={() => setDrawerOpen(false)}
          onReturn={() => setDrawerOpen(true)}
          onSaved={() => {
            setDrawerOpen(false);
            res.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/* ─────────── правила ─────────── */

/** Строка таблицы правил; null — бэкап: правило из списка заказчика, которого застосунок не видит */
type RuleLine = { key: string; rule: OpsAlertRule | null };

/** «10 хв», «1 год», «1 дн.» — окно и повтор в одну меру */
const minutes = (n: number, loc: string) => fmtUptime(n * 60, loc);

function RulesPanel({
  d,
  manage,
  editing,
  onEdit,
}: {
  d: OpsAlerts;
  manage: boolean;
  editing: string | null;
  onEdit: (key: string) => void;
}) {
  const { ut } = useLang();
  const loc = locale();
  const every = fmtUptime(d.checker.intervalSec, loc);
  const sub = !d.checker.enabled
    ? ut("opx.al.metaCheckerOff")
    : d.checker.lastRunAt
      ? fill(ut("opx.al.rulesSub"), { every, time: timeOfDay(d.checker.lastRunAt) })
      : fill(ut("opx.al.rulesEvery"), { every });

  const columns: Column<RuleLine>[] = [
    {
      key: "rule",
      header: ut("opx.al.colRule"),
      required: true,
      render: ({ rule }) => (rule ? <RuleName rule={rule} /> : <BackupName />),
    },
    {
      key: "state",
      header: ut("opx.al.colState"),
      width: 132,
      required: true,
      render: ({ rule }) => (rule ? <RuleState rule={rule} /> : <StatusMark tone="unk">{ut("opx.al.outside")}</StatusMark>),
    },
    {
      key: "now",
      header: ut("opx.al.colNow"),
      num: true,
      width: 84,
      required: true,
      render: ({ rule }) => <b className="font-extrabold tabular-nums text-text">{rule ? nowText(rule, ut, loc) : "—"}</b>,
    },
    {
      key: "signal",
      header: ut("opx.al.colSignal"),
      width: 130,
      required: true,
      render: ({ rule }) => <span className="text-text-2">{rule ? signalText(rule, ut, loc) : "—"}</span>,
    },
    {
      key: "window",
      header: ut("opx.al.colWindow"),
      width: 116,
      required: true,
      render: ({ rule }) => (
        <span className="whitespace-nowrap tabular-nums text-text-2">
          {rule ? `${rule.windowMin !== null ? minutes(rule.windowMin, loc) : "—"} / ${minutes(rule.repeatMin, loc)}` : "— / —"}
        </span>
      ),
    },
    {
      key: "edit",
      header: "",
      width: 48,
      required: true,
      render: ({ rule }) =>
        manage && rule ? (
          <Tooltip label={ut("opx.al.editRule")}>
            <Button
              variant="quiet"
              size="icon-sm"
              aria-label={fill(ut("opx.al.editOne"), { name: ut(RULE_NAME[rule.key]) })}
              icon={<OpsIcon name="pencil" />}
              onClick={() => onEdit(rule.key)}
            />
          </Tooltip>
        ) : null,
    },
  ];

  const rows: RuleLine[] = [...d.rules.map((r) => ({ key: r.key, rule: r })), { key: "backup", rule: null }];

  return (
    <Panel
      title={ut("o2b.alerts.rules")}
      icon={<OpsIcon name="list-checks" />}
      sub={sub}
      flush
      footer={<PanelNote icon="info">{ut("opx.al.backupNote")}</PanelNote>}
    >
      {d.checker.enabled ? null : (
        <div className="px-4 pb-3">
          <Callout kind="warn" icon={<OpsIcon name="timer" />}>
            {ut("o2b.alerts.checkerOff")}
          </Callout>
        </div>
      )}
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.key}
        dense
        sticky={false}
        label={ut("o2b.alerts.rules")}
        onRowClick={manage ? (r) => (r.rule ? onEdit(r.rule.key) : undefined) : undefined}
        isRowActive={(r) => r.key === editing}
      />
    </Panel>
  );
}

function ChannelGlyphs({ channels }: { channels: readonly OpsAlertChannel[] }) {
  const { ut } = useLang();
  if (!channels.length) return <span>{ut("o2b.rule.noChannels")}</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {channels.map((c) => (
        <Tooltip key={c} label={ut(CHANNEL_KEY[c])}>
          <span className="inline-flex text-muted">
            <OpsIcon name={CHANNEL_ICON[c]} size={14} />
            <span className="sr-only">{ut(CHANNEL_KEY[c])}</span>
          </span>
        </Tooltip>
      ))}
    </span>
  );
}

function RuleName({ rule }: { rule: OpsAlertRule }) {
  const { ut } = useLang();
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <b className="text-[14px] font-extrabold leading-5 text-text">{ut(RULE_NAME[rule.key])}</b>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-small leading-[17px] text-muted">
        <span className="min-w-0">{ut(RULE_SHORT[rule.key])}</span>
        <ChannelGlyphs channels={rule.enabled ? rule.channels : []} />
      </span>
    </span>
  );
}

function BackupName() {
  const { ut } = useLang();
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <b className="text-[14px] font-extrabold leading-5 text-text">{ut("o2b.rule.backup")}</b>
      <span className="text-small leading-[17px] text-muted">{ut("o2b.rule.backup.hint")}</span>
    </span>
  );
}

function RuleState({ rule }: { rule: OpsAlertRule }) {
  const { ut } = useLang();
  const reason = rule.state === "unavailable" ? unavailableKey(rule.unavailable) : null;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <StatusMark tone={STATE_TONE[rule.state]}>{ut(STATE_KEY[rule.state])}</StatusMark>
      {rule.state === "firing" && rule.firingSince ? (
        <span className="text-caption text-muted">{fill(ut("o2b.rule.since"), { time: timeOfDay(rule.firingSince) })}</span>
      ) : null}
      {reason ? <span className="text-caption leading-4 text-muted">{ut(reason)}</span> : null}
    </span>
  );
}

type Ut = ReturnType<typeof useLang>["ut"];

/**
 * «Зараз» в единице правила. У проверки журнала числа нет — есть «цілий»
 * или «розрив»; больше единицы — часы без сверки (давняя сверка, #203).
 */
function nowText(rule: OpsAlertRule, ut: Ut, loc: string): string {
  if (rule.key === "auditChain") {
    if (rule.lastValue !== null && rule.lastValue > 1) return fmtRuleValue(rule.key, rule.lastValue, loc);
    if (rule.state === "ok") return ut("opx.al.chainOk");
    if (rule.state === "firing") return ut("opx.al.chainBroken");
    return "—";
  }
  /* «хвилин від останнього такту» меньше нуля — расхождение часов базы и процесса, а не будущее */
  if (rule.key === "schedulerSilent" && rule.lastValue !== null) return fmtRuleValue(rule.key, Math.max(0, rule.lastValue), loc);
  return fmtRuleValue(rule.key, rule.lastValue, loc);
}

/** «більше 1 %», «менше 10 %», «без порога: так чи ні» */
function signalText(rule: OpsAlertRule, ut: Ut, loc: string): string {
  if (!hasThreshold(rule.key)) return ut("o2b.rule.noThreshold");
  if (rule.threshold === null) return ut("o2b.unavail.noThreshold");
  return fill(ut(RULE_BELOW.has(rule.key) ? "opx.al.below" : "opx.al.above"), { v: fmtRuleValue(rule.key, rule.threshold, loc) });
}

/* ─────────── каналы ─────────── */

function ChannelsPanel({
  d,
  manage,
  events,
  onTested,
}: {
  d: OpsAlerts;
  manage: boolean;
  events: readonly OpsAlertEvent[];
  onTested: () => void;
}) {
  const { ut } = useLang();
  const toast = useToast();
  const { run, busy } = useAction();
  const t = d.channels.telegram;
  const m = d.channels.email;
  const recipients =
    m.recipients === "env"
      ? fill(ut("o2b.channel.toEnv"), { n: m.count })
      : m.recipients === "superadmins"
        ? fill(ut("o2b.channel.toSupers"), { n: m.count })
        : ut("o2b.channel.toNobody");

  const test = (channel: OpsAlertChannel) =>
    void run(async () => {
      const r = await api.opsTestAlert(channel);
      onTested();
      if (r.outcome === "sent") toast(ut("o2b.test.sent"), "ok");
      else if (r.outcome === "unset") toast(ut("o2b.test.unset"), "err");
      else toast(fill(ut("o2b.test.failed"), { error: r.error ?? "—" }), "err");
    });

  const cards: { ch: OpsAlertChannel; ready: boolean; sub: string; env: [string, boolean][] }[] = [
    {
      ch: "telegram",
      ready: t.configured,
      sub: ut("opx.al.tgSub"),
      env: [
        ["TELEGRAM_BOT_TOKEN", t.token],
        ["TELEGRAM_CHAT_ID", t.chat],
      ],
    },
    {
      ch: "email",
      ready: m.configured,
      sub: recipients,
      env: [
        ["SMTP_URL", m.smtp],
        ["OPS_ALERT_EMAIL", m.recipients === "env"],
      ],
    },
  ];

  return (
    <Panel title={ut("o2b.alerts.channels")} icon={<OpsIcon name="radio-tower" />} flush>
      <p className="m-0 px-4 pb-3 text-small text-muted">{ut("opx.al.channelsLead")}</p>
      {cards.map((c) => (
        <div key={c.ch} className="border-t border-divider px-4 py-3.5">
          <div className="flex items-start gap-2.5">
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-control bg-violet-tint text-violet-ink">
              <OpsIcon name={CHANNEL_ICON[c.ch]} size={16} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <b className="text-[14px] font-extrabold leading-5 text-text">{ut(CHANNEL_KEY[c.ch])}</b>
              <span className="text-small leading-[17px] text-muted">{c.sub}</span>
            </span>
            <StatusMark tone={c.ready ? "ok" : "warn"}>{ut(c.ready ? "o2b.channel.ready" : "o2b.channel.notReady")}</StatusMark>
          </div>
          <dl className="m-0 mt-3 rounded-control bg-sunk px-3 py-1.5">
            {c.env.map(([name, set]) => (
              <div key={name} className="flex min-h-[26px] items-center justify-between gap-3">
                <dt className="min-w-0 truncate font-mono text-[12px] font-medium text-text-2">{name}</dt>
                <dd className="m-0">
                  <StatusMark tone={set ? "ok" : "quiet"}>{ut(set ? "o2b.env.set" : "o2b.env.unset")}</StatusMark>
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-3 flex items-center gap-2">
            <TrailLine events={events} channel={c.ch} />
            {manage ? (
              <Tooltip label={ut("o2b.channel.test")}>
                <Button size="sm" icon={<OpsIcon name="send" />} disabled={busy} onClick={() => test(c.ch)} className="ml-auto">
                  {ut("opx.al.test")}
                </Button>
              </Tooltip>
            ) : null}
          </div>
        </div>
      ))}
    </Panel>
  );
}

/** «Востаннє: 07.10, 14:22 — відправлено; 02.10, 10:05 — відмова» — из истории событий */
function TrailLine({ events, channel }: { events: readonly OpsAlertEvent[]; channel: OpsAlertChannel }) {
  const { ut } = useLang();
  const loc = locale();
  const trail = channelTrail(events, channel);
  if (!trail.last) return <span className="min-w-0 flex-1 text-small text-muted">{ut("opx.al.neverSent")}</span>;
  return (
    <span className="min-w-0 flex-1 text-small text-muted">
      {fill(ut("opx.al.lastDelivery"), { time: sinceText(trail.last.at, loc), outcome: ut(DELIVERY_KEY[trail.last.outcome]) })}
      {trail.failedAt ? (
        <span className="font-semibold text-warn">{fill(ut("opx.al.lastFailure"), { time: sinceText(trail.failedAt, loc) })}</span>
      ) : null}
    </span>
  );
}

/* ─────────── история ─────────── */

function HistoryPanel({ hist }: { hist: Resource<OpsAlertHistory> }) {
  const { ut } = useLang();
  const loc = locale();
  const h = hist.data;

  const columns: Column<OpsAlertEvent>[] = [
    {
      key: "at",
      header: ut("opx.er.colWhen"),
      width: 130,
      required: true,
      render: (e) => <span className="whitespace-nowrap tabular-nums text-text-2">{sinceText(e.at, loc)}</span>,
    },
    {
      key: "rule",
      header: ut("o2b.col.rule"),
      required: true,
      render: (e) => <b className="font-extrabold text-text">{e.rule ? ut(RULE_NAME[e.rule]) : ut("o2b.event.anyRule")}</b>,
    },
    { key: "kind", header: ut("o2b.col.event"), width: 150, required: true, render: (e) => <EventTag kind={e.kind} /> },
    {
      key: "value",
      header: ut("o2b.col.value"),
      width: 170,
      required: true,
      render: (e) => (
        <span className="whitespace-nowrap tabular-nums text-text">
          {e.rule && e.value !== null ? fmtRuleValue(e.rule, e.value, loc) : "—"}
          {e.rule && e.threshold !== null ? <span className="text-muted"> / {fmtRuleValue(e.rule, e.threshold, loc)}</span> : null}
        </span>
      ),
    },
    { key: "deliveries", header: ut("o2b.col.deliveries"), width: 230, required: true, render: (e) => <Deliveries e={e} /> },
  ];

  return (
    <Panel
      title={ut("o2b.alerts.history")}
      icon={<OpsIcon name="history" />}
      sub={h ? fill(ut("opx.al.histSub"), { days: h.days }) : undefined}
      flush
      footer={<PanelNote>{ut("o2b.alerts.historyHint")}</PanelNote>}
    >
      {hist.error && !h ? (
        <div className="px-4 pb-3">
          <Loading bare error={hist.error} onRetry={hist.reload} />
        </div>
      ) : !h ? (
        <div className="px-4 pb-3">
          <Loading bare rows={3} />
        </div>
      ) : h.items.length === 0 ? (
        <div className="px-4 pb-3">
          <Quiet>{ut("o2b.alerts.historyEmpty")}</Quiet>
        </div>
      ) : (
        <>
          <div className="px-4 pb-4">
            <HistoryShape h={h} />
          </div>
          <DataTable rows={h.items} columns={columns} rowKey={(e) => e.id} dense sticky={false} label={ut("o2b.alerts.history")} />
        </>
      )}
    </Panel>
  );
}

/**
 * Форма истории над списком: когда срабатывало и что чаще.
 *
 * Текущее состояние правил здесь не рисуется — оно словами выше, в строке
 * каждого правила. Здесь — месяц: сбои по дням столбцами янтарём (повтор
 * «досі триває» — напоминание о том же сбое, его число — у полосы правила)
 * и правила по числу сбоев, тихие — нулём. Ряды считает сервер по всей
 * таблице: список ниже — сто последних событий, и ночь повторов съела бы
 * его целиком.
 */
export function HistoryShape({ h }: { h: OpsAlertHistory }) {
  const { ut } = useLang();
  const loc = locale();
  if (!anyAlerts(h.daily)) return <Quiet>{fill(ut("sig.al.quiet"), { days: h.days })}</Quiet>;
  const fired = h.daily.some((x) => x.fired > 0);
  return (
    <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-6 max-[1100px]:grid-cols-1">
      <Figure title={ut("sig.al.byDay")} caption={fill(ut("sig.al.byDayCaption"), { days: h.days })}>
        {fired ? (
          <TimeColumns
            columns={h.daily.map((x) => ({ key: x.date, label: dayLabel(x.date, loc), value: x.fired }))}
            label={ut("sig.al.byDay")}
            tone="attention"
            height={180}
          />
        ) : (
          <Quiet>{ut("sig.al.noFired")}</Quiet>
        )}
      </Figure>
      <Figure title={ut("sig.al.byRule")} caption={fill(ut("sig.al.byRuleCaption"), { days: h.days })}>
        <RankBars
          items={firedByRule(h).map((r) => ({
            key: r.rule,
            title: ut(RULE_NAME[r.rule]),
            label: <span className="text-small font-semibold text-text-2">{ut(RULE_NAME[r.rule])}</span>,
            value: r.fired,
            text: String(r.fired),
            extra: r.repeat ? fill(ut("opx.al.repeats"), { n: r.repeat }) : undefined,
            attention: r.fired > 0,
          }))}
        />
      </Figure>
    </div>
  );
}

function Deliveries({ e }: { e: OpsAlertEvent }) {
  const { ut } = useLang();
  if (e.deliveries.length === 0) return <span className="text-muted">{ut("o2b.rule.noChannels")}</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {e.deliveries.map((dl) => (
        <span
          key={dl.channel}
          title={dl.error ?? undefined}
          className={cx(
            "inline-flex items-center gap-1 whitespace-nowrap text-small",
            dl.outcome === "failed" ? "font-bold text-warn" : dl.outcome === "sent" ? "text-text-2" : "text-muted",
          )}
        >
          <OpsIcon name={CHANNEL_ICON[dl.channel]} size={14} />
          {dl.outcome === "sent" ? ut(CHANNEL_KEY[dl.channel]) : `${ut(CHANNEL_KEY[dl.channel])}: ${ut(DELIVERY_KEY[dl.outcome])}`}
        </span>
      ))}
    </span>
  );
}

/* ─────────── ящик правки правила ─────────── */

const UNIT_KEY = { pct: "o2b.unit.pct", ms: "o2b.unit.ms", min: "o2b.unit.min" } as const;

function RuleDrawer({
  open,
  rule,
  d,
  history,
  now,
  onClose,
  onReturn,
  onSaved,
}: {
  open: boolean;
  rule: OpsAlertRule;
  d: OpsAlerts;
  history: OpsAlertHistory | null;
  now: number;
  onClose: () => void;
  onReturn: () => void;
  onSaved: () => void;
}) {
  const { ut } = useLang();
  const loc = locale();
  const { run, busy } = useAction();
  const [draft, setDraft] = useState<RuleDraft>(() => draftOf(rule));
  const [error, setError] = useState<DraftError | null>(null);
  const lim = OPS_RULE_LIMITS[rule.key];
  const unit = RULE_UNIT[rule.key];
  const name = ut(RULE_NAME[rule.key]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(rule));
  const n = (v: number) => new Intl.NumberFormat(loc).format(v);
  const range = (v: [number, number]) => fill(ut("o2b.form.range"), { min: n(v[0]), max: n(v[1]) });
  const ready = { telegram: d.channels.telegram.configured, email: d.channels.email.configured };
  const days = history?.days ?? 30;
  const events = history ? ruleEvents(history.items, rule.key, days, now) : [];

  const save = () => {
    const out = ruleInputOf(rule.key, draft);
    if ("error" in out) {
      setError(out.error);
      return;
    }
    setError(null);
    void run(async () => {
      await api.opsSaveAlertRule(rule.key, out.input);
      onSaved();
    }, ut("o2b.rule.saved"));
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      onReturn={onReturn}
      wide
      title={name}
      sub={fill(ut("opx.al.drawerSub"), { hint: ut(RULE_SHORT[rule.key]), now: nowText(rule, ut, loc) })}
      icon={<OpsIcon name="bell-ring" />}
      dirty={dirty}
      draftName={fill(ut("opx.al.draftName"), { name })}
      note={ut("opx.al.logged")}
      noteIcon={<OpsIcon name="history" />}
      footer={
        <>
          <Button variant="primary" icon={<OpsIcon name="check" />} disabled={busy} onClick={save}>
            {ut("common.save")}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3 border-b border-divider py-4">
        <Switch checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label={ut("opx.al.enabled")} />
        {d.checker.enabled ? (
          <span className="ml-auto pt-0.5 text-small text-muted">
            {rule.lastCheckedAt
              ? fill(ut("opx.al.checkedSub"), { every: fmtUptime(d.checker.intervalSec, loc), time: timeOfDay(rule.lastCheckedAt) })
              : fill(ut("opx.al.rulesEvery"), { every: fmtUptime(d.checker.intervalSec, loc) })}
          </span>
        ) : null}
      </div>

      <DrawerSection
        title={ut("opx.al.when")}
        sub={hasThreshold(rule.key) ? ut(RULE_BELOW.has(rule.key) ? "opx.al.whenBelow" : "opx.al.whenAbove") : ut("o2b.rule.noThreshold")}
      >
        <div className="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-3 max-[520px]:grid-cols-1">
          {lim.threshold && unit ? (
            <Field label={ut("o2b.form.threshold")} hint={range(lim.threshold)} error={error === "threshold" ? range(lim.threshold) : null}>
              <Input
                inputMode="decimal"
                autoComplete="off"
                value={draft.threshold}
                suffix={ut(UNIT_KEY[unit])}
                onChange={(e) => setDraft({ ...draft, threshold: e.target.value })}
                aria-invalid={error === "threshold"}
              />
            </Field>
          ) : null}
          {hasWindow(rule.key) && lim.window ? (
            <Field label={ut("o2b.form.window")} hint={range(lim.window)} error={error === "window" ? range(lim.window) : null}>
              <Input
                inputMode="numeric"
                autoComplete="off"
                value={draft.windowMin}
                suffix={ut("o2b.unit.min")}
                onChange={(e) => setDraft({ ...draft, windowMin: e.target.value })}
                aria-invalid={error === "window"}
              />
            </Field>
          ) : null}
          <Field label={ut("o2b.form.repeat")} hint={range(OPS_REPEAT_LIMITS)} error={error === "repeat" ? range(OPS_REPEAT_LIMITS) : null}>
            <Input
              inputMode="numeric"
              autoComplete="off"
              value={draft.repeatMin}
              suffix={ut("o2b.unit.min")}
              onChange={(e) => setDraft({ ...draft, repeatMin: e.target.value })}
              aria-invalid={error === "repeat"}
            />
          </Field>
        </div>
        <p className="m-0 mt-2 text-small text-muted">{ut(RULE_HINT[rule.key])}</p>
        {rule.key === "diskFree" ? <p className="m-0 mt-1 text-small text-muted">{ut("o2b.alerts.diskNote")}</p> : null}
      </DrawerSection>

      <DrawerSection title={ut("o2b.form.channels")} sub={ut("opx.al.sendToSub")}>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {CHANNELS.map((c) => (
            <CheckLabel
              key={c}
              label={
                <span className="inline-flex items-center gap-1.5">
                  {ut(CHANNEL_KEY[c])}
                  {ready[c] ? null : <span className="text-small text-muted">({ut("o2b.channel.notReady")})</span>}
                </span>
              }
              control={<Checkbox checked={draft.channels.includes(c)} onChange={() => setDraft({ ...draft, channels: toggleChannel(draft.channels, c) })} />}
            />
          ))}
        </div>
        {draft.channels.length === 0 ? <p className="m-0 mt-2 text-small text-muted">{ut("o2b.rule.noChannels")}</p> : null}
      </DrawerSection>

      <DrawerSection title={ut("opx.al.howFired")} sub={fill(ut("opx.al.histSub"), { days })}>
        {events.length === 0 ? (
          <Quiet>{fill(ut("opx.al.notFired"), { days })}</Quiet>
        ) : (
          <ul className="m-0 list-none p-0">
            {events.slice(0, 8).map((e) => (
              <li key={e.id} className="flex items-center gap-3 border-b border-divider py-2.5 last:border-b-0">
                <span className="w-[86px] shrink-0 text-small tabular-nums text-text-2">{sinceText(e.at, loc)}</span>
                <EventGlyph kind={e.kind} />
                <span className="min-w-0 text-small text-text">
                  <b className={cx("font-extrabold", e.kind === "fired" || e.kind === "repeat" ? "text-warn" : "text-text")}>{ut(EVENT_KEY[e.kind])}</b>{" "}
                  <span className="tabular-nums">
                    {e.value !== null ? fmtRuleValue(rule.key, e.value, loc) : ""}
                    {e.threshold !== null ? ` / ${fmtRuleValue(rule.key, e.threshold, loc)}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </DrawerSection>
    </Drawer>
  );
}
