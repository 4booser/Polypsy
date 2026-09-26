import type { ReactNode } from "react";
import type { ReleaseEntry, ReleasesView } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { Figure, TimeColumns } from "../../../charts/clinical";
import { dateTime, day, duration } from "../../../format";
import { useLang } from "../../../lang";
import { Screen, useAction } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Button, Num } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { perWeek, rollbackPlan, shortSha, uptimeMs, weeklyDeploys, type RollbackPlan } from "./model";

/**
 * Раздел «Випуски» техпанели: история выкаток и откат на предыдущий тег.
 *
 * Решение заказчика 2026-09-26 (техпанель, пункт 12): тег, коммит, кто и
 * когда, миграции выпуска, ссылка на прогон CI, откат.
 *
 * Откат здесь — не обратная миграция. Схема переключением тега назад не
 * едет (см. комментарии в .github/workflows/deploy.yml), поэтому кнопка
 * честно говорит, какие миграции останутся в базе, и только потом ведёт к
 * запуску: на страницу workflow_dispatch в GitHub, где тег вписывают
 * руками, или — если на сервере задан GITHUB_DISPATCH_TOKEN и у человека
 * есть ops.manage — запускает выкатку сама, с записью в журнал.
 */
export default function OpsReleases() {
  const { ut } = useLang();
  const res = useResource(() => api.opsReleases(), []);

  return (
    <RuleSection title={ut("ops.tab.releases")} hint={ut("rl.hint")}>
      <Screen res={res}>
        {(view: ReleasesView) =>
          view.items.length ? (
            <>
              <Rollback view={view} plan={rollbackPlan(view.items)} />
              <Cadence items={view.items} />
              <ReleaseList items={view.items} />
            </>
          ) : (
            <p className="m-0 max-w-[760px] text-[13px] text-muted">{ut("rl.empty")}</p>
          )
        }
      </Screen>
    </RuleSection>
  );
}

function Rollback({ view, plan }: { view: ReleasesView; plan: RollbackPlan | null }) {
  const { ut } = useLang();
  const { can } = useAuth();
  const { run, busy } = useAction();
  if (!plan) return <p className="m-0 mb-[24px] text-[13px] text-muted">{ut("rl.noPrevious")}</p>;

  const version = plan.target.version;
  const direct = view.dispatchConfigured && can("ops.manage");
  return (
    <div className="mb-[28px] max-w-[760px] rounded-[5px] border border-hairline px-[16px] py-[14px]">
      <h3 className="m-0 text-[17px] font-bold leading-[20px] text-primary">
        {ut("rl.rollback")} <span className="font-mono">{version}</span>
      </h3>
      <p className="m-0 mt-[6px] text-[13px] leading-[18px] text-muted">{ut("rl.rollbackHint")}</p>
      {/*
        Предупреждение о миграциях — янтарём: это ровно «требует внимания».
        Старый код поверх новой схемы может не встать вовсе, и увидеть это
        надо ДО нажатия, а не в логах выкатки.
      */}
      {plan.unknown ? (
        <p className="m-0 mt-[8px] text-[14px] text-accent">{ut("rl.rollbackUnknownMig")}</p>
      ) : null}
      {plan.left.length ? (
        <div className="mt-[8px] text-[14px] text-accent">
          {ut("rl.rollbackLeft")}
          <ul className="m-0 mt-[4px] list-none p-0 font-mono text-[12px] leading-[18px]">
            {plan.left.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : plan.unknown ? null : (
        <p className="m-0 mt-[8px] text-[14px] text-muted">{ut("rl.rollbackNoMig")}</p>
      )}

      <div className="mt-[12px] flex flex-wrap items-center gap-[16px]">
        {direct ? (
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (!window.confirm(ut("rl.rollbackConfirm"))) return false;
                await api.opsRollback(version);
              }, ut("rl.rollbackStarted"))
            }
          >
            {ut("rl.rollback")} {version}
          </Button>
        ) : null}
        {view.workflowUrl ? (
          <span className="text-[13px] text-muted">
            {direct ? null : (
              <>
                {ut("rl.rollbackPage")} <span className="font-mono text-text">{version}</span>.{" "}
              </>
            )}
            <a
              href={view.workflowUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-sm font-bold text-primary underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
            >
              {ut("rl.rollbackOpen")}
            </a>
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Недель в ряду: полгода — видно и ритм, и паузу; дальше столбцы стали бы нитками */
const WEEKS = 26;

/**
 * Частота выкладок над списком (волна 11): столбцы по неделям.
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
      className="mb-[28px]"
      title={ut("sig.rl.cadence")}
      caption={fill(ut("sig.rl.cadenceCaption"), { weeks: weeks.length, n: items.length })}
      aside={
        avg === null ? null : (
          <span className="text-[13px] text-muted">
            {ut("sig.rl.perWeek")} <Num className="text-text-2">{avg}</Num>
          </span>
        )
      }
    >
      <TimeColumns columns={weeks.map((w) => ({ key: w.key, label: day(w.key), value: w.value }))} label={ut("sig.rl.cadence")} />
    </Figure>
  );
}

function ReleaseList({ items }: { items: ReleaseEntry[] }) {
  const { ut } = useLang();
  const now = Date.now();
  const link =
    "rounded-sm text-primary underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]";
  return (
    <ul className="m-0 list-none p-0">
      {items.map((r, i) => (
        <li
          key={r.id}
          className={cx(
            "grid grid-cols-[150px_repeat(4,minmax(0,1fr))] gap-x-[24px] border-t border-hairline py-[12px] text-[13px] leading-[18px]",
            "max-[900px]:grid-cols-2 max-[900px]:gap-y-[8px]",
          )}
        >
          <div className="min-w-0">
            <span className="block font-mono text-[17px] font-bold leading-[20px] text-primary [overflow-wrap:anywhere]">
              {r.version}
            </span>
            {i === 0 ? <span className="text-[11px] font-bold text-primary">{ut("rl.running")}</span> : null}
          </div>
          <Col label={ut("rl.commit")}>
            {r.commitSha ? (
              r.commitUrl ? (
                <a href={r.commitUrl} target="_blank" rel="noreferrer" className={cx(link, "font-mono")}>
                  {shortSha(r.commitSha)}
                </a>
              ) : (
                <span className="font-mono">{shortSha(r.commitSha)}</span>
              )
            ) : (
              "—"
            )}
            {r.runUrl ? (
              <a href={r.runUrl} target="_blank" rel="noreferrer" className={cx(link, "block")}>
                {ut("rl.run")}
              </a>
            ) : null}
          </Col>
          <Col label={ut("rl.by")}>
            <span className="block">{r.deployedBy ?? "—"}</span>
            <span className="block font-mono tabular-nums text-muted">{dateTime(r.startedAt)}</span>
          </Col>
          <Col label={ut("rl.uptime")}>
            <span className="font-mono tabular-nums">{duration(uptimeMs(r, now))}</span>
            {r.endedAt ? null : <span className="block text-muted">{ut("rl.now")}</span>}
          </Col>
          <Col label={ut("rl.migrations")}>
            {r.migrations === null ? (
              <span className="text-muted">{ut("rl.migrationsUnknown")}</span>
            ) : r.migrations.length ? (
              <ul className="m-0 list-none p-0 font-mono text-[12px]">
                {r.migrations.map((m) => (
                  <li key={m} className="[overflow-wrap:anywhere]">
                    {m}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted">{ut("rl.noMigrations")}</span>
            )}
          </Col>
        </li>
      ))}
    </ul>
  );
}

function Col({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="block text-[13px] font-bold text-muted">{label}</span>
      <div className="text-text">{children}</div>
    </div>
  );
}
