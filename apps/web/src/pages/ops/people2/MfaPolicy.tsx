import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { MfaCoverageRow } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { dateTime, day } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, useAction } from "../../../ui";
import { Button, Tag } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { Cell, ColumnHead, metaClass, nameClass, rowClass } from "../controls";
import { ROLE_KEY, personHref } from "../model";
import { MfaCoverageChart } from "./charts";
import { Empty, Section } from "./parts";
import { ResetMfaDialog } from "./UserTools";

/*
 * Техпанель → «Другий фактор» (people2, пункт 17): политика «обов’язково
 * для …» и покрытие — кому по ней нужен второй фактор и у кого он есть.
 *
 * Менять политику — ops.manage: требование меняет работу системы для всех
 * (как режим обслуживания). Покрытие стоит рядом с переключателями намеренно:
 * включают требование, глядя на то, сколько людей завтра утром упрётся в
 * настройку, — «не налаштовано» янтарём, это ровно «требует внимания».
 *
 * Сброс чужого фактора — только суперадмину (сервер проверяет сам); здесь
 * кнопка у тех строк, где фактор есть, и только суперадмину. Тот же пункт —
 * в меню строки на вкладке «Користувачі».
 */

const GRID = "grid grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.4fr)_auto] gap-x-[20px]";

export default function OpsMfaPolicy() {
  const { ut } = useLang();
  const { user } = useAuth();
  const isSuper = user?.role === "superadmin";
  const res = useResource(() => api.mfaPolicy(), []);
  const { run, busy } = useAction();
  const [draft, setDraft] = useState<{ superadmins: boolean; ops: boolean } | null>(null);
  const [resetting, setResetting] = useState<MfaCoverageRow | null>(null);

  useEffect(() => {
    if (res.data) setDraft({ superadmins: res.data.policy.superadmins, ops: res.data.policy.ops });
  }, [res.data]);

  if (res.error) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data || !draft) return <Loading rows={4} />;
  const { policy, coverage } = res.data;
  const changed = draft.superadmins !== policy.superadmins || draft.ops !== policy.ops;

  return (
    <>
      <Section title={ut("ops.mfa.policy")}>
        <div className="flex max-w-[760px] flex-col gap-[10px]">
          {(
            [
              ["superadmins", "ops.mfa.forSuper"],
              ["ops", "ops.mfa.forOps"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex cursor-pointer items-center gap-[10px] text-[15px] leading-[20px] text-text">
              <input
                type="checkbox"
                checked={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
                className="m-0 size-[18px]!"
              />
              {ut(label)}
            </label>
          ))}
          <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("ops.mfa.policyHint")}</p>
          {policy.updatedAt ? (
            <p className={metaClass}>
              {ut("ops.mfa.changed")} {dateTime(policy.updatedAt)}
              {policy.updatedByEmail ? ` · ${policy.updatedByEmail}` : ""}
            </p>
          ) : null}
          <div>
            <Button
              disabled={busy || !changed}
              onClick={() =>
                void run(async () => {
                  await api.saveMfaPolicy(draft);
                  res.reload();
                }, ut("ops.mfa.saved"))
              }
            >
              {ut("common.save")}
            </Button>
          </div>
        </div>
      </Section>

      <Section title={ut("ops.mfa.coverage")}>
        {/* волна 11: доля с фактором по причине требования — над списком покрытия, из того же ответа */}
        <MfaCoverageChart coverage={coverage} />
        {coverage.length === 0 ? (
          <Empty>{ut("ops.mfa.nobody")}</Empty>
        ) : (
          <>
            <ColumnHead grid={GRID} labels={[ut("ops.users.account"), ut("adm.role"), ut("ops.users.state"), null]} />
            <ul className="m-0 list-none p-0">
              {coverage.map((row) => (
                <li key={row.id} className={rowClass(GRID)}>
                  <div className="min-w-0">
                    <Link to={personHref(row)} className={nameClass}>
                      {row.fullName || row.email}
                    </Link>
                    <span className={metaClass}>{row.email}</span>
                  </div>
                  <Cell label={ut("adm.role")}>
                    <span className="block">{ut(ROLE_KEY[row.role])}</span>
                    <span className={metaClass}>{ut(row.because === "superadmin" ? "ops.mfa.because.superadmin" : "ops.mfa.because.ops")}</span>
                  </Cell>
                  <Cell label={ut("ops.users.state")}>
                    {row.enabled ? (
                      <span className="block">
                        {ut("ops.mfa.enabled")}
                        {row.confirmedAt ? <span className="text-muted"> · {day(row.confirmedAt)}</span> : null}
                      </span>
                    ) : (
                      /* «не налаштовано» — янтарём: при включённом требовании это завтрашний отказ во вході */
                      <Tag tone="attention">{ut("ops.mfa.missing")}</Tag>
                    )}
                    {row.disabled ? <span className={metaClass}>{ut("ops.users.disabledOne")}</span> : null}
                  </Cell>
                  <div className="flex justify-end max-[900px]:justify-start">
                    {isSuper && row.enabled && row.id !== user?.id ? (
                      <Button variant="quiet" onClick={() => setResetting(row)}>
                        {ut("ops.mfa.reset")}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      {resetting ? (
        <ResetMfaDialog
          id={resetting.id}
          email={resetting.email}
          onClose={() => setResetting(null)}
          onDone={() => {
            setResetting(null);
            res.reload();
          }}
        />
      ) : null}
    </>
  );
}
