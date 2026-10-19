import { useState } from "react";
import type { ReleaseEntry, ReleasesView } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { Figure, TimeColumns } from "../../../charts/clinical";
import { day, locale } from "../../../format";
import { useLang } from "../../../lang";
import { DataTable, Loading, Modal, useAction, type Column } from "../../../ui";
import { cx } from "../../../ui/cx";
import { IconTile, Panel } from "../../../ui/layout";
import { Button, ButtonLink, Tag } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { OpsIcon } from "../icons";
import { fmtUptime } from "../model";
import { CopyLinkButton, Mono, OpsHead, PanelNote, Quiet, StatusMark } from "../parts";
import { perWeek, rollbackPlan, shortSha, uptimeMs, weeklyDeploys, type RollbackPlan } from "./model";

/**
 * Раздел «Випуски» техпанели: что работает сейчас, откат на предыдущий тег,
 * ритм выкладок и история выкаток.
 *
 * Решение заказчика 2026-09-26 (техпанель, пункт 12): тег, коммит, кто и
 * когда, миграции выпуска, ссылка на прогон CI, откат.
 *
 * Откат здесь — не обратная миграция. Схема переключением тега назад не
 * едет (см. комментарии в .github/workflows/deploy.yml), поэтому панель
 * отката честно говорит, какие миграции останутся в базе, и только потом
 * ведёт к запуску: на страницу workflow_dispatch в GitHub, где тег
 * вписывают руками, или — если на сервере задан GITHUB_DISPATCH_TOKEN и у
 * человека есть ops.manage — запускает выкатку сама после подтверждения в
 * окне, с записью в журнал.
 *
 * В истории две отмеченные строки сравниваются на «Порівнянні випусків».
 * Откат виден словом: выпуск с версией ниже предыдущего — «відкат з …»,
 * а тот, с которого откатили, — «відкочено».
 */
export default function OpsReleases() {
  const { ut } = useLang();
  const res = useResource(() => api.opsReleases(), []);
  const view = res.data;
  const current = view ? (view.running.version ?? view.items[0]?.version ?? null) : null;

  const head = (
    <OpsHead
      meta={view ? [current ? fill(ut("opx.rl.metaNow"), { v: current }) : ut("ops.build.unset"), ut("opx.rl.metaSub")] : null}
      actions={
        <>
          <ButtonLink to="/ops/compare">
            <OpsIcon name="git-compare" size={15} />
            {ut("ops.tab.releaseCompare")}
          </ButtonLink>
          <CopyLinkButton />
        </>
      }
    />
  );

  if (res.error && !view) {
    return (
      <>
        {head}
        <Loading error={res.error} onRetry={res.reload} />
      </>
    );
  }
  if (!view) {
    return (
      <>
        {head}
        <Loading rows={5} />
      </>
    );
  }
  if (!view.items.length) {
    return (
      <div className="flex flex-col gap-4">
        {head}
        <Panel title={ut("rl.running")} icon={<OpsIcon name="rocket" />}>
          <Quiet>{ut("rl.empty")}</Quiet>
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {head}
      <CurrentPanel view={view} />
      <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-start gap-4 max-[1100px]:grid-cols-1">
        <RollbackPanel view={view} plan={rollbackPlan(view.items)} />
        <Panel title={ut("sig.rl.cadence")} icon={<OpsIcon name="chart-column" />} sub={ut("opx.rl.cadenceSub")}>
          <Cadence items={view.items} />
          <CadenceFacts items={view.items} />
        </Panel>
      </div>
      <HistoryPanel items={view.items} />
    </div>
  );
}

/** Время жизни выпуска двумя старшими единицами: «5 дн. 2 год», «38 хв» */
const life = (ms: number) => fmtUptime(Math.round(ms / 1000), locale());

/** Момент выкатки коротко: «06.10.2026, 21:41» */
const stamp = (iso: string) =>
  new Date(iso).toLocaleString(locale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Номер миграции из её тега: «0118_visit_recording_retention» → «0118» */
const migNo = (tag: string) => /^\d+/.exec(tag)?.[0] ?? tag;

/** Версия как числа: v1.19.1 → [1, 19, 1]; не похожа на версию — null */
function semver(v: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Откат: версия строки ниже, чем у выпуска, который она сменила (следующей строки — он старше) */
export function rolledBackFrom(items: readonly ReleaseEntry[], i: number): string | null {
  const a = semver(items[i]!.version);
  const prev = items[i + 1];
  const b = prev ? semver(prev.version) : null;
  if (!a || !b) return null;
  for (let k = 0; k < 3; k++) {
    if (a[k]! < b[k]!) return prev!.version;
    if (a[k]! > b[k]!) return null;
  }
  return null;
}

/* ─────────── что работает ─────────── */

function CurrentPanel({ view }: { view: ReleasesView }) {
  const { ut } = useLang();
  const now = Date.now();
  const r = view.items[0]!;
  const version = view.running.version ?? r.version;
  const sha = view.running.commitSha ?? r.commitSha;
  const cells = [
    {
      key: "commit",
      label: ut("rl.commit"),
      value: sha ? (
        r.commitUrl ? (
          <a href={r.commitUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[13px] font-semibold text-violet-ink no-underline hover:underline">
            {shortSha(sha)}
            <OpsIcon name="arrow-up-right" size={13} />
          </a>
        ) : (
          <Mono className="text-[13px]">{shortSha(sha)}</Mono>
        )
      ) : (
        "—"
      ),
      sub: r.lastMigration ? <Mono className="text-muted">{r.lastMigration}</Mono> : null,
    },
    { key: "by", label: ut("rl.by"), value: r.deployedBy ?? "—", sub: null },
    { key: "at", label: ut("opx.rl.started"), value: stamp(r.startedAt), sub: null },
    { key: "up", label: ut("rl.uptime"), value: life(uptimeMs(r, now)), sub: r.endedAt ? null : ut("rl.now") },
    {
      key: "ci",
      label: ut("rl.run"),
      value: r.runUrl ? (
        <a href={r.runUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-violet-ink no-underline hover:underline">
          {ut("opx.rl.openRun")}
          <OpsIcon name="arrow-up-right" size={13} />
        </a>
      ) : (
        "—"
      ),
      sub: null,
    },
  ];
  return (
    <section aria-label={ut("rl.running")} className="rounded-panel border border-border bg-panel shadow-panel">
      <div className="flex items-center gap-3 px-4 pb-3.5 pt-4">
        <IconTile size={48} icon={<OpsIcon name="rocket" />} />
        <div className="min-w-0">
          <span className="block text-caption font-bold text-muted">{ut("rl.running")}</span>
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[22px] font-bold leading-7 text-text">{version}</span>
            <Tag tone="good" icon={<OpsIcon name="check" />}>
              {ut("opx.rl.live")}
            </Tag>
          </span>
        </div>
      </div>
      <dl className="m-0 grid grid-cols-5 border-t border-divider max-[1000px]:grid-cols-3">
        {cells.map((c, i) => (
          <div key={c.key} className={cx("min-w-0 px-4 pb-3.5 pt-3", i > 0 && "border-l border-divider")}>
            <dt className="text-caption font-bold text-muted">{c.label}</dt>
            <dd className="m-0 mt-0.5 truncate text-[15px] font-extrabold leading-[22px] text-text">{c.value}</dd>
            {c.sub ? <dd className="m-0 truncate text-caption leading-4 text-muted">{c.sub}</dd> : null}
          </div>
        ))}
      </dl>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-t border-divider max-[1000px]:grid-cols-1">
        <div className="min-w-0 px-4 py-3">
          <span className="block text-caption font-bold text-muted">{ut("opx.rl.releaseMigrations")}</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {r.migrations === null ? (
              <span className="text-small text-muted">{ut("rl.migrationsUnknown")}</span>
            ) : r.migrations.length ? (
              r.migrations.map((m) => (
                <span key={m} className="inline-flex h-6 items-center rounded-[7px] bg-sunk px-2 font-mono text-[11.5px] font-semibold text-text-2">
                  {m}
                </span>
              ))
            ) : (
              <span className="text-small text-muted">{ut("rl.noMigrations")}</span>
            )}
          </div>
        </div>
        <div className="min-w-0 border-l border-divider px-4 py-3 max-[1000px]:border-l-0 max-[1000px]:border-t">
          <span className="block text-caption font-bold text-muted">{ut("opx.rl.after")}</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <ButtonLink to="/ops/compare" size="xs" variant="ghost">
              <OpsIcon name="git-compare" size={14} />
              {ut("opx.rl.toCompare")}
            </ButtonLink>
            <ButtonLink to="/ops/errors?window=7d&order=new" size="xs" variant="ghost">
              <OpsIcon name="bug" size={14} />
              {ut("opx.rl.toErrors")}
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────── откат ─────────── */

function RollbackPanel({ view, plan }: { view: ReleasesView; plan: RollbackPlan | null }) {
  const { ut } = useLang();
  const { can } = useAuth();
  const { run, busy } = useAction();
  const [confirm, setConfirm] = useState(false);
  if (!plan) {
    return (
      <Panel title={ut("opx.rl.rollbackTitle")} icon={<OpsIcon name="undo-2" />}>
        <Quiet>{ut("rl.noPrevious")}</Quiet>
      </Panel>
    );
  }
  const t = plan.target;
  const version = t.version;
  const direct = view.dispatchConfigured && can("ops.manage");
  const ran = t.endedAt
    ? fill(ut("opx.rl.ran"), {
        from: day(t.startedAt),
        to: day(t.endedAt),
        d: life(uptimeMs(t, Date.now())),
      })
    : null;
  return (
    <Panel
      title={ut("opx.rl.rollbackTitle")}
      icon={<OpsIcon name="undo-2" />}
      sub={ut("opx.rl.rollbackSub")}
      footer={<PanelNote>{ut(direct ? "opx.rl.confirmNote" : "rl.rollbackPage")}</PanelNote>}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[13.5px] text-text">{ut("rl.rollback")}</span>
        <Mono className="text-[15px] font-bold text-text">{version}</Mono>
        {ran ? <span className="text-small text-muted">{ran}</span> : null}
      </div>
      <p className="m-0 mt-2 text-small leading-[19px] text-text-2">{ut("rl.rollbackHint")}</p>
      {/*
        Предупреждение о миграциях: старый код поверх новой схемы может не
        встать вовсе, и увидеть это надо ДО нажатия, а не в логах выкатки.
      */}
      <div className="mt-3 rounded-panel bg-sunk px-3.5 py-3">
        {plan.left.length ? (
          <>
            <b className="block text-[13px] font-extrabold text-text">{ut("rl.rollbackLeft")}</b>
            <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
              {plan.left.map((m) => (
                <li key={m} className="flex items-center gap-2">
                  <OpsIcon name="database" size={14} className="text-muted" />
                  <Mono className="text-text">{m}</Mono>
                </li>
              ))}
            </ul>
          </>
        ) : plan.unknown ? null : (
          <span className="text-small text-text-2">{ut("rl.rollbackNoMig")}</span>
        )}
        {plan.unknown ? <StatusMark tone="warn" className="mt-2 whitespace-normal">{ut("rl.rollbackUnknownMig")}</StatusMark> : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {direct ? (
          <Button icon={<OpsIcon name="undo-2" />} disabled={busy} onClick={() => setConfirm(true)}>
            {fill(ut("opx.rl.runRollback"), { v: version })}
          </Button>
        ) : null}
        {view.workflowUrl ? (
          <a
            href={view.workflowUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center gap-1.5 rounded-control px-3 text-body font-bold text-violet-ink no-underline hover:bg-violet-tint"
          >
            <OpsIcon name="external-link" size={15} />
            {ut("rl.rollbackOpen")}
          </a>
        ) : null}
      </div>
      {confirm ? (
        <Modal
          title={fill(ut("opx.rl.confirmTitle"), { v: version })}
          sub={ut("rl.rollbackConfirm")}
          icon={<OpsIcon name="undo-2" />}
          tone="warn"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.opsRollback(version);
                    setConfirm(false);
                  }, ut("rl.rollbackStarted"))
                }
              >
                {fill(ut("opx.rl.runRollback"), { v: version })}
              </Button>
              <Button variant="quiet" onClick={() => setConfirm(false)}>
                {ut("common.cancel")}
              </Button>
            </>
          }
        >
          {plan.left.length ? (
            <div className="text-small text-text-2">
              {ut("rl.rollbackLeft")}
              <ul className="m-0 mt-1 list-none p-0">
                {plan.left.map((m) => (
                  <li key={m}>
                    <Mono className="text-text">{m}</Mono>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <span className="text-small text-text-2">{ut("rl.rollbackNoMig")}</span>
          )}
        </Modal>
      ) : null}
    </Panel>
  );
}

/* ─────────── ритм ─────────── */

/** Недель в ряду: квартал — видно и ритм, и паузу; дальше столбцы стали бы нитками */
const WEEKS = 12;

/**
 * Частота выкладок: столбцы по неделям и среднее числом.
 *
 * Список отвечает «что и когда», но не «как часто»: десять строк за неделю
 * и десять за квартал выглядят в нём одинаково. Столбцы — счёт по неделе,
 * пустая неделя — ноль в ряду. Одна неделя — не ряд: тогда достаточно
 * списка, и график не рисуется.
 */
export function Cadence({ items, now = Date.now() }: { items: readonly ReleaseEntry[]; now?: number }) {
  const { ut } = useLang();
  const weeks = weeklyDeploys(items, now, WEEKS);
  if (weeks.length < 2) return null;
  const avg = perWeek(weeks);
  return (
    <Figure
      title={
        avg === null ? (
          ut("sig.rl.cadence")
        ) : (
          <span className="flex items-baseline gap-2">
            <b className="text-stat font-extrabold leading-none tabular-nums">{avg.toLocaleString(locale())}</b>
            <span className="text-small font-medium text-text-2">{ut("sig.rl.perWeek")}</span>
          </span>
        )
      }
      caption={fill(ut("sig.rl.cadenceCaption"), { weeks: weeks.length, n: items.length })}
    >
      <TimeColumns columns={weeks.map((w) => ({ key: w.key, label: day(w.key), value: w.value }))} label={ut("sig.rl.cadence")} />
    </Figure>
  );
}

function CadenceFacts({ items }: { items: readonly ReleaseEntry[] }) {
  const { ut } = useLang();
  const now = Date.now();
  const done = items.filter((r) => r.endedAt);
  const avg = done.length ? done.reduce((s, r) => s + uptimeMs(r, now), 0) / done.length : null;
  const rollbacks = items.filter((_, i) => rolledBackFrom(items, i) !== null).length;
  if (items.length < 2) return null;
  return (
    <dl className="m-0 mt-4 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-4 border-t border-divider pt-3">
      <div>
        <dt className="text-caption font-bold text-muted">{ut("opx.rl.avgLife")}</dt>
        <dd className="m-0 mt-0.5 font-extrabold">{avg === null ? "—" : life(avg)}</dd>
      </div>
      <div>
        <dt className="text-caption font-bold text-muted">{ut("opx.rl.rollbacks")}</dt>
        <dd className="m-0 mt-0.5 font-extrabold tabular-nums">{rollbacks}</dd>
      </div>
    </dl>
  );
}

/* ─────────── история ─────────── */

function HistoryPanel({ items }: { items: ReleaseEntry[] }) {
  const { ut } = useLang();
  const now = Date.now();
  const rolledFrom = new Map(items.map((r, i) => [r.id, rolledBackFrom(items, i)]));
  const undone = new Set(items.flatMap((_, i) => (rolledBackFrom(items, i) ? [items[i + 1]!.id] : [])));
  const columns: Column<ReleaseEntry>[] = [
    {
      key: "version",
      header: ut("opx.rl.colVersion"),
      required: true,
      render: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <Mono className="font-bold text-text">{r.version}</Mono>
          {r.id === items[0]!.id ? (
            <Tag tone="good" icon={<OpsIcon name="check" />}>
              {ut("opx.rl.nowTag")}
            </Tag>
          ) : null}
          {rolledFrom.get(r.id) ? (
            <Tag tone="info" icon={<OpsIcon name="undo-2" />}>
              {fill(ut("opx.rl.rolledFrom"), { v: rolledFrom.get(r.id)! })}
            </Tag>
          ) : null}
          {undone.has(r.id) ? (
            <Tag tone="attention" icon={<OpsIcon name="undo-2" />}>
              {ut("opx.rl.undone")}
            </Tag>
          ) : null}
        </span>
      ),
    },
    {
      key: "commit",
      header: ut("rl.commit"),
      width: 110,
      required: true,
      render: (r) =>
        r.commitSha ? (
          r.commitUrl ? (
            <a href={r.commitUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[12px] font-semibold text-violet-ink no-underline hover:underline">
              {shortSha(r.commitSha)}
              <OpsIcon name="arrow-up-right" size={12} />
            </a>
          ) : (
            <Mono>{shortSha(r.commitSha)}</Mono>
          )
        ) : (
          "—"
        ),
    },
    { key: "by", header: ut("rl.by"), width: 140, required: true, render: (r) => <span className="text-text-2">{r.deployedBy ?? "—"}</span> },
    { key: "at", header: ut("opx.rl.started"), width: 150, required: true, render: (r) => <span className="tabular-nums text-text-2">{stamp(r.startedAt)}</span> },
    {
      key: "up",
      header: ut("rl.uptime"),
      width: 140,
      required: true,
      render: (r) =>
        r.endedAt ? (
          <span className="tabular-nums text-text-2">{life(uptimeMs(r, now))}</span>
        ) : (
          <b className="font-extrabold text-good">{fill(ut("opx.rl.stillRunning"), { d: life(uptimeMs(r, now)) })}</b>
        ),
    },
    {
      key: "mig",
      header: ut("rl.migrations"),
      width: 170,
      required: true,
      render: (r) =>
        r.migrations === null ? (
          <span className="text-small text-muted">{ut("rl.migrationsUnknown")}</span>
        ) : r.migrations.length ? (
          <span className="flex flex-wrap gap-1">
            {r.migrations.map((m) => (
              <span key={m} title={m} className="inline-flex h-[22px] items-center rounded-[7px] bg-sunk px-1.5 font-mono text-[11px] font-semibold text-text-2">
                {migNo(m)}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-small text-muted">{ut("rl.noMigrations")}</span>
        ),
    },
    {
      key: "ci",
      header: ut("rl.run"),
      width: 90,
      required: true,
      render: (r) =>
        r.runUrl ? (
          <a href={r.runUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-small font-semibold text-violet-ink no-underline hover:underline">
            {ut("opx.rl.openRun")}
            <OpsIcon name="arrow-up-right" size={12} />
          </a>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
  ];
  return (
    <Panel title={ut("opx.rl.history")} icon={<OpsIcon name="history" />} sub={ut("opx.rl.metaSub")} flush footer={<PanelNote>{ut("rl.hint")}</PanelNote>}>
      <DataTable
        rows={items}
        columns={columns}
        rowKey={(r) => r.id}
        selectable
        dense
        sticky={false}
        label={ut("opx.rl.history")}
        bulkActions={(picked) => {
          /* «було» — старший по времени выпуск, «стало» — младший, в каком бы порядке их ни отметили */
          const [older, newer] = [...picked].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
          return picked.length === 2 && older && newer ? (
            <ButtonLink
              size="xs"
              variant="panel"
              to={`/ops/compare?before=${encodeURIComponent(older.version)}&after=${encodeURIComponent(newer.version)}`}
            >
              <OpsIcon name="git-compare" size={14} />
              {ut("opx.rl.comparePicked")}
            </ButtonLink>
          ) : (
            <span className="text-small text-text-2">{ut("opx.rl.pickTwo")}</span>
          );
        }}
      />
    </Panel>
  );
}
