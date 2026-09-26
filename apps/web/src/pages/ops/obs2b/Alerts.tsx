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
import { Figure, HBars } from "../../../charts/clinical";
import { dateTime, day, locale } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useAction, useToast } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Button, Field, Input, Num } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { fill } from "../../dashboard/model";
import { PeriodSwitch } from "../../dashboard/parts";
import { fmtAgo, fmtUptime } from "../model";
import { Cell, GridRow, GridTable, Quiet, Stamp, StatusMark, useOpsResource } from "../parts";
import {
  ALERT_SERIES,
  CHANNEL_KEY,
  DELIVERY_KEY,
  EVENT_KEY,
  EVENT_TONE,
  RULE_BELOW,
  RULE_HINT,
  RULE_NAME,
  RULE_UNIT,
  STATE_KEY,
  STATE_TONE,
  alertGroups,
  anyAlerts,
  draftOf,
  fmtRuleValue,
  hasThreshold,
  hasWindow,
  ruleInputOf,
  toggleChannel,
  unavailableKey,
  type DraftError,
  type RuleDraft,
} from "./model";
import { FIG_GRID, GroupedColumns } from "./charts";
import { FIELD_LABEL, Meta, ToggleSet } from "./parts";

/*
 * Сповіщення: правила, каналы, история.
 *
 * Решение заказчика 2026-09-26: всплеск 5xx, молчащий планировщик, рост
 * p95, место на диске, провал проверки журнала — в Telegram или на почту,
 * одно оповещение на инцидент, повтор не чаще N минут, «відновлено» по
 * окончании. Правила правит ops.manage, смотрит ops.read — кнопки правки и
 * «Надіслати тестове» видны только первому, а сервер проверяет то же сам.
 *
 * Про каналы экран говорит только «задано / не задано»: токен бота, номер
 * чата и адреса получателей сюда не приходят вовсе.
 *
 * Бэкап — строкой «недоступно із застосунку»: его снимает cron на хосте, и
 * сервер о нём не знает. Выдумывать здесь «гаразд» было бы хуже пустоты.
 */

const POLL_MS = 30_000;

const CHANNELS: readonly OpsAlertChannel[] = ["telegram", "email"];

const HISTORY_COLS = "grid-cols-[150px_minmax(160px,1fr)_150px_150px_minmax(220px,1.3fr)]";

export default function OpsAlertsPage() {
  const { ut } = useLang();
  const { can } = useAuth();
  const manage = can("ops.manage");
  const res = useOpsResource(() => api.opsAlerts(), [], POLL_MS);
  const hist = useOpsResource(() => api.opsAlertHistory(), [], POLL_MS);

  if (res.error && !res.data) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading rows={6} />;
  const d = res.data;
  const now = res.updatedAt ?? Date.now();

  return (
    <div>
      <Stamp updatedAt={res.updatedAt} note={ut("o2b.alerts.stamp")} />

      <RuleSection className="mt-[16px]" title={ut("o2b.alerts.rules")} hint={ut("o2b.alerts.rulesHint")}>
        <Checker d={d} now={now} />
        <ul className="m-0 list-none p-0">
          {d.rules.map((r) => (
            <RuleRow key={r.key} r={r} manage={manage} now={now} onSaved={res.reload} />
          ))}
          <BackupRow />
        </ul>
        <Quiet>{ut("o2b.alerts.diskNote")}</Quiet>
      </RuleSection>

      <RuleSection title={ut("o2b.alerts.channels")} hint={ut("o2b.alerts.channelsHint")}>
        <Channels d={d} manage={manage} onTested={hist.reload} />
      </RuleSection>

      <RuleSection title={ut("o2b.alerts.history")} hint={ut("o2b.alerts.historyHint")}>
        {hist.error && !hist.data ? (
          <Loading error={hist.error} onRetry={hist.reload} />
        ) : !hist.data ? (
          <Loading rows={3} />
        ) : hist.data.items.length === 0 ? (
          <Quiet>{ut("o2b.alerts.historyEmpty")}</Quiet>
        ) : (
          <>
            <HistoryShape h={hist.data} />
            <GridTable
              label={ut("o2b.alerts.history")}
              cols={HISTORY_COLS}
              minW="min-w-[900px]"
              head={[ut("ops.col.time"), ut("o2b.col.rule"), ut("o2b.col.event"), ut("o2b.col.value"), ut("o2b.col.deliveries")]}
            >
              {hist.data.items.map((e) => (
                <HistoryRow key={e.id} e={e} />
              ))}
            </GridTable>
          </>
        )}
      </RuleSection>
    </div>
  );
}

/** Где и как часто идёт проверка: на экземпляре без планировщика её нет, и это надо сказать */
function Checker({ d, now }: { d: OpsAlerts; now: number }) {
  const { ut } = useLang();
  const loc = locale();
  if (!d.checker.enabled) return <Quiet>{ut("o2b.alerts.checkerOff")}</Quiet>;
  return (
    <Quiet>
      {fill(ut("o2b.alerts.checker"), {
        every: fmtUptime(d.checker.intervalSec, loc),
        last: d.checker.lastRunAt ? fmtAgo(d.checker.lastRunAt, now, loc) : ut("ops.never"),
      })}
    </Quiet>
  );
}

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_180px_minmax(0,260px)_110px] items-start gap-x-[16px] gap-y-[6px] max-[800px]:grid-cols-[minmax(0,1fr)_auto]";

function RuleRow({ r, manage, now, onSaved }: { r: OpsAlertRule; manage: boolean; now: number; onSaved: () => void }) {
  const { ut } = useLang();
  const loc = locale();
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const reason = r.state === "unavailable" ? unavailableKey(r.unavailable) : null;
  const channels = r.channels.length ? r.channels.map((c) => ut(CHANNEL_KEY[c])).join(", ") : ut("o2b.rule.noChannels");

  return (
    <li className="border-b border-hairline py-[12px]">
      <div className={ROW_GRID}>
        <div className="min-w-0">
          <span className="block text-[17px] font-bold leading-[21px] text-primary">{ut(RULE_NAME[r.key])}</span>
          <span className="block text-[13px] leading-[18px] text-muted">{ut(RULE_HINT[r.key])}</span>
        </div>
        <div className="min-w-0">
          <StatusMark tone={STATE_TONE[r.state]}>{ut(STATE_KEY[r.state])}</StatusMark>
          {r.state === "firing" && r.firingSince ? (
            <Meta className="block">
              <span title={dateTime(r.firingSince)}>{fill(ut("o2b.rule.since"), { time: fmtAgo(r.firingSince, now, loc) })}</span>
            </Meta>
          ) : null}
          {reason ? <Meta className="block">{ut(reason)}</Meta> : null}
          {r.lastCheckedAt ? (
            <Meta className="block">
              <span title={dateTime(r.lastCheckedAt)}>{fill(ut("o2b.rule.checked"), { time: fmtAgo(r.lastCheckedAt, now, loc) })}</span>
            </Meta>
          ) : null}
        </div>
        <div className="min-w-0 text-[13px] leading-[18px] max-[800px]:col-span-2">
          {hasThreshold(r.key) ? (
            <>
              <span className="block">
                <span className="text-muted">{ut("o2b.rule.now")} </span>
                <Num>{fmtRuleValue(r.key, r.lastValue, loc)}</Num>
              </span>
              <span className="block">
                <span className="text-muted">{ut(RULE_BELOW.has(r.key) ? "o2b.rule.below" : "o2b.rule.above")} </span>
                <Num>{fmtRuleValue(r.key, r.threshold, loc)}</Num>
                {r.windowMin ? <span className="text-muted"> · {fill(ut("o2b.rule.window"), { n: r.windowMin })}</span> : null}
              </span>
            </>
          ) : (
            <span className="block text-muted">{ut("o2b.rule.noThreshold")}</span>
          )}
          <span className="block text-muted">
            {fill(ut("o2b.rule.repeat"), { t: fmtUptime(r.repeatMin * 60, loc) })} · {channels}
          </span>
        </div>
        <div className="flex justify-end max-[800px]:col-span-2 max-[800px]:justify-start">
          {manage && !draft ? (
            <Button variant="ghost" onClick={() => setDraft(draftOf(r))}>
              {ut("o2b.rule.edit")}
            </Button>
          ) : null}
        </div>
      </div>
      {draft ? (
        <RuleForm
          r={r}
          draft={draft}
          setDraft={setDraft}
          onDone={(saved) => {
            setDraft(null);
            if (saved) onSaved();
          }}
        />
      ) : null}
    </li>
  );
}

const UNIT_KEY = { pct: "o2b.unit.pct", ms: "o2b.unit.ms", min: "o2b.unit.min" } as const;

function RuleForm({
  r,
  draft,
  setDraft,
  onDone,
}: {
  r: OpsAlertRule;
  draft: RuleDraft;
  setDraft: (d: RuleDraft) => void;
  onDone: (saved: boolean) => void;
}) {
  const { ut } = useLang();
  const loc = locale();
  const { run, busy } = useAction();
  const [error, setError] = useState<DraftError | null>(null);
  const lim = OPS_RULE_LIMITS[r.key];
  const unit = RULE_UNIT[r.key];
  const num = (n: number) => new Intl.NumberFormat(loc).format(n);
  const range = (v: [number, number]) => fill(ut("o2b.form.range"), { min: num(v[0]), max: num(v[1]) });

  const save = () => {
    const out = ruleInputOf(r.key, draft);
    if ("error" in out) {
      setError(out.error);
      return;
    }
    setError(null);
    void run(async () => {
      await api.opsSaveAlertRule(r.key, out.input);
      onDone(true);
    }, ut("o2b.rule.saved"));
  };

  return (
    <div className="mt-[14px] border-l-2 border-primary-rule pl-[16px]">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(180px,100%),1fr))] items-start gap-x-[24px]">
        <div className="mb-[15px]">
          <span className={FIELD_LABEL}>{ut("o2b.form.enabled")}</span>
          <PeriodSwitch
            label={ut("o2b.form.enabled")}
            value={draft.enabled ? "on" : "off"}
            onChange={(v) => setDraft({ ...draft, enabled: v === "on" })}
            options={[
              ["on", ut("o2b.form.on")],
              ["off", ut("o2b.form.off")],
            ]}
          />
        </div>
        {lim.threshold && unit ? (
          <Field
            label={`${ut("o2b.form.threshold")}, ${ut(UNIT_KEY[unit])}`}
            labelClassName={FIELD_LABEL}
            hint={range(lim.threshold)}
            error={error === "threshold" ? range(lim.threshold) : null}
          >
            <Input
              inputMode="decimal"
              autoComplete="off"
              value={draft.threshold}
              onChange={(e) => setDraft({ ...draft, threshold: e.target.value })}
              aria-invalid={error === "threshold"}
            />
          </Field>
        ) : null}
        {hasWindow(r.key) && lim.window ? (
          <Field
            label={`${ut("o2b.form.window")}, ${ut("o2b.unit.min")}`}
            labelClassName={FIELD_LABEL}
            hint={range(lim.window)}
            error={error === "window" ? range(lim.window) : null}
          >
            <Input
              inputMode="numeric"
              autoComplete="off"
              value={draft.windowMin}
              onChange={(e) => setDraft({ ...draft, windowMin: e.target.value })}
              aria-invalid={error === "window"}
            />
          </Field>
        ) : null}
        <Field
          label={`${ut("o2b.form.repeat")}, ${ut("o2b.unit.min")}`}
          labelClassName={FIELD_LABEL}
          hint={range(OPS_REPEAT_LIMITS)}
          error={error === "repeat" ? range(OPS_REPEAT_LIMITS) : null}
        >
          <Input
            inputMode="numeric"
            autoComplete="off"
            value={draft.repeatMin}
            onChange={(e) => setDraft({ ...draft, repeatMin: e.target.value })}
            aria-invalid={error === "repeat"}
          />
        </Field>
        <div className="mb-[15px]">
          <span className={FIELD_LABEL}>{ut("o2b.form.channels")}</span>
          <ToggleSet
            label={ut("o2b.form.channels")}
            value={draft.channels}
            onChange={(c) => setDraft({ ...draft, channels: toggleChannel(draft.channels, c) })}
            options={CHANNELS.map((c) => [c, ut(CHANNEL_KEY[c])] as const)}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-[12px]">
        <Button onClick={save} disabled={busy}>
          {ut("common.save")}
        </Button>
        <Button variant="ghost" onClick={() => onDone(false)} disabled={busy}>
          {ut("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Бэкап — в списке заказчика, но не в силах приложения: честно и с адресом, где смотреть */
function BackupRow() {
  const { ut } = useLang();
  return (
    <li className="border-b border-hairline py-[12px]">
      <div className={ROW_GRID}>
        <div className="min-w-0">
          <span className="block text-[17px] font-bold leading-[21px] text-primary">{ut("o2b.rule.backup")}</span>
          <span className="block text-[13px] leading-[18px] text-muted">{ut("o2b.rule.backup.hint")}</span>
        </div>
        <div className="min-w-0">
          <StatusMark tone="quiet">{ut("o2b.state.notFromApp")}</StatusMark>
        </div>
        <div className="min-w-0 text-[13px] leading-[18px] text-muted max-[800px]:col-span-2">{ut("o2b.rule.backup.where")}</div>
        <div />
      </div>
    </li>
  );
}

function Channels({ d, manage, onTested }: { d: OpsAlerts; manage: boolean; onTested: () => void }) {
  const { ut } = useLang();
  const toast = useToast();
  const { run, busy } = useAction();
  const setWord = (v: boolean) => ut(v ? "o2b.env.set" : "o2b.env.unset");
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

  const rows: { ch: OpsAlertChannel; on: boolean; facts: string[] }[] = [
    { ch: "telegram", on: t.configured, facts: [`TELEGRAM_BOT_TOKEN — ${setWord(t.token)}`, `TELEGRAM_CHAT_ID — ${setWord(t.chat)}`] },
    { ch: "email", on: m.configured, facts: [`SMTP_URL — ${setWord(m.smtp)}`, recipients] },
  ];

  return (
    <ul className="m-0 list-none p-0">
      {rows.map(({ ch, on, facts }) => (
        <li
          key={ch}
          className="grid min-h-[58px] grid-cols-[minmax(0,200px)_150px_minmax(0,1fr)_auto] items-center gap-x-[16px] gap-y-[6px] border-b border-hairline py-[10px] max-[700px]:grid-cols-[minmax(0,1fr)_auto]"
        >
          <span className="text-[17px] font-bold leading-[21px] text-primary">{ut(CHANNEL_KEY[ch])}</span>
          <StatusMark tone={on ? "ok" : "quiet"}>{ut(on ? "o2b.channel.ready" : "o2b.channel.notReady")}</StatusMark>
          <span className="min-w-0 font-mono text-[12px] leading-[18px] text-text-2 max-[700px]:col-span-2">
            {facts.map((f) => (
              <span key={f} className="block">
                {f}
              </span>
            ))}
          </span>
          {manage ? (
            <Button variant="ghost" onClick={() => test(ch)} disabled={busy}>
              {ut("o2b.channel.test")}
            </Button>
          ) : (
            <span />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Форма истории над списком (волна 11): когда срабатывало и что чаще.
 *
 * Текущее состояние правил здесь не рисуется — оно словами выше, в строке
 * каждого правила, и второй раз графиком было бы тем же самым. Здесь —
 * месяц: «збій» и «відновлено» по дням парой столбцов (янтарь — сбой, он
 * требует внимания; фиолетовый — восстановление) и правила по числу сбоев.
 * Ряды считает сервер по всей таблице: список ниже — сто последних
 * событий, и ночь повторов съела бы его целиком.
 */
export function HistoryShape({ h }: { h: OpsAlertHistory }) {
  const { ut } = useLang();
  if (!anyAlerts(h.daily)) return <Quiet>{fill(ut("sig.al.quiet"), { days: h.days })}</Quiet>;
  const series = ALERT_SERIES.map((s) => ({ key: s.key, label: ut(s.label), tone: s.tone }));
  return (
    <div className={cx(FIG_GRID, "mb-[24px]")}>
      <Figure title={ut("sig.al.byDay")} caption={fill(ut("sig.al.byDayCaption"), { days: h.days })}>
        <GroupedColumns groups={alertGroups(h.daily, day)} series={series} label={ut("sig.al.byDay")} />
      </Figure>
      <Figure title={ut("sig.al.byRule")} caption={fill(ut("sig.al.byRuleCaption"), { days: h.days })}>
        {h.byRule.length ? (
          <HBars
            items={h.byRule.map((r) => ({
              key: r.rule,
              label: ut(RULE_NAME[r.rule]),
              value: r.fired,
              text: r.repeat ? fill(ut("sig.al.firedRepeat"), { n: r.fired, r: r.repeat }) : String(r.fired),
            }))}
          />
        ) : (
          <Quiet>{ut("sig.al.noFired")}</Quiet>
        )}
      </Figure>
    </div>
  );
}

function HistoryRow({ e }: { e: OpsAlertEvent }) {
  const { ut } = useLang();
  const loc = locale();
  return (
    <GridRow cols={HISTORY_COLS} className="items-start">
      <Cell className="text-text-2">{dateTime(e.at)}</Cell>
      <Cell className="font-bold text-primary">{e.rule ? ut(RULE_NAME[e.rule]) : ut("o2b.event.anyRule")}</Cell>
      <Cell>
        <StatusMark tone={EVENT_TONE[e.kind]}>{ut(EVENT_KEY[e.kind])}</StatusMark>
      </Cell>
      <Cell className="font-mono text-[12px] tabular-nums text-text-2">
        {e.rule && e.value !== null ? fmtRuleValue(e.rule, e.value, loc) : "—"}
        {e.rule && e.threshold !== null ? <span className="text-muted"> / {fmtRuleValue(e.rule, e.threshold, loc)}</span> : null}
      </Cell>
      <Cell>
        {e.deliveries.length === 0 ? (
          <span className="text-muted">{ut("o2b.rule.noChannels")}</span>
        ) : (
          e.deliveries.map((dl) => (
            <span key={dl.channel} className="block">
              <span className={dl.outcome === "failed" ? "font-bold text-accent" : dl.outcome === "sent" ? "text-text" : "text-muted"}>
                {ut(CHANNEL_KEY[dl.channel])} — {ut(DELIVERY_KEY[dl.outcome])}
              </span>
              {dl.error ? <span className="block break-words font-mono text-[12px] text-text-2">{dl.error}</span> : null}
            </span>
          ))
        )}
      </Cell>
    </GridRow>
  );
}
