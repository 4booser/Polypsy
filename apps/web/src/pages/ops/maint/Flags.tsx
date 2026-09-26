import { useState, type ReactNode } from "react";
import {
  FLAG_BASE_ROLES,
  t,
  type FeatureFlagAudience,
  type FlagAudienceOptions,
  type FlagChange,
  type OpsFlag,
  type OpsFlagsView,
} from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { dateTime } from "../../../format";
import { useLang } from "../../../lang";
import { refreshFlags } from "../../../service/flags";
import { Loading, Screen, useAction } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Button, Select } from "../../../ui/primitives";
import { RuleSection } from "../../../ui/section";
import { useResource } from "../../../useResource";
import { audienceParts, enabledForNobody, toggleIn, toggleRole, type ListField } from "./model";

/**
 * Раздел «Прапорці» техпанели: какие флаги есть, кому включены, их
 * переключение и журнал изменений.
 *
 * Решение заказчика 2026-09-26 (техпанель, пункт 11): включать новые
 * экраны отдельным людям или группам без выкатки.
 *
 * Список — из реестра кода (packages/shared/src/featureFlags.ts) плюс
 * строки таблицы, пережившие свой ключ: такие помечены «застарілий» и
 * править их нечего — сервер их никому не отдаёт.
 *
 * Правка — на месте, под строкой флага, а не в окне: форма короткая, и
 * человек должен видеть, какой флаг правит, не держа это в голове. Выбор
 * «кому» грузится только при открытии правки: в нём имена всех
 * сотрудников, и их чтение пишется в журнал.
 */
export default function OpsFlags() {
  const { ut } = useLang();
  const { can } = useAuth();
  const manage = can("ops.manage");
  const res = useResource(() => api.opsFlags(), []);
  const changes = useResource(() => api.opsFlagChanges(), []);
  const [editing, setEditing] = useState<string | null>(null);

  const saved = () => {
    setEditing(null);
    res.reload();
    changes.reload();
    // у правящего — сразу: флаг мог включиться ему самому
    refreshFlags();
  };

  return (
    <>
      <RuleSection title={ut("fl.title")} hint={ut("fl.hint")}>
        <Screen res={res}>
          {(view: OpsFlagsView) => (
            <ul className="m-0 list-none p-0">
              {view.items.map((flag) => (
                <FlagRow
                  key={flag.key}
                  flag={flag}
                  view={view}
                  manage={manage && flag.known}
                  editing={editing === flag.key}
                  onEdit={() => setEditing(editing === flag.key ? null : flag.key)}
                  onSaved={saved}
                />
              ))}
            </ul>
          )}
        </Screen>
      </RuleSection>

      <RuleSection title={ut("fl.changes")}>
        <Screen res={changes}>
          {(data: { items: FlagChange[] }) => <ChangeLog items={data.items} names={res.data?.names ?? null} />}
        </Screen>
      </RuleSection>
    </>
  );
}

function FlagRow({
  flag,
  view,
  manage,
  editing,
  onEdit,
  onSaved,
}: {
  flag: OpsFlag;
  view: OpsFlagsView;
  manage: boolean;
  editing: boolean;
  onEdit: () => void;
  onSaved: () => void;
}) {
  const { ut, lang } = useLang();
  const who = audienceParts(flag.audience, view.names, lang, ut);
  return (
    <li className="border-t border-hairline py-[12px] first:border-t-0 first:pt-0">
      <div className="grid grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)_auto] items-start gap-x-[24px] max-[900px]:grid-cols-1 max-[900px]:gap-y-[6px]">
        <div className="min-w-0">
          <span className="block text-[17px] font-bold leading-[20px] text-primary">
            {flag.title ? (flag.title[lang] ?? flag.title.uk) : flag.key}
          </span>
          <span className="block font-mono text-[11px] text-muted">{flag.key}</span>
          {flag.description ? (
            <p className="m-0 mt-[4px] text-[13px] leading-[18px] text-muted">
              {flag.description[lang] ?? flag.description.uk}
            </p>
          ) : null}
          {flag.known ? null : <p className="m-0 mt-[4px] text-[13px] text-accent">{ut("fl.stale")}</p>}
        </div>
        <div>
          <span className="block text-[13px] font-bold text-muted">{ut("mt.status")}</span>
          <span className={cx("text-[14px] font-bold", flag.enabled ? "text-primary" : "text-muted")}>
            {flag.enabled ? ut("fl.on") : ut("fl.off")}
          </span>
        </div>
        <div className="min-w-0">
          <span className="block text-[13px] font-bold text-muted">{ut("fl.audience")}</span>
          <span className="text-[14px] text-text [overflow-wrap:anywhere]">
            {who.length ? who.join(", ") : ut("fl.nobody")}
          </span>
          {flag.updatedAt ? (
            <span className="block text-[11px] text-muted">
              <span className="font-mono tabular-nums">{dateTime(flag.updatedAt)}</span>
              {flag.updatedBy ? ` · ${flag.updatedBy}` : ""}
            </span>
          ) : null}
        </div>
        {manage ? (
          <Button variant="quiet" onClick={onEdit} aria-expanded={editing}>
            {editing ? ut("common.cancel") : ut("fl.edit")}
          </Button>
        ) : null}
      </div>
      {editing ? <FlagEditor flag={flag} onSaved={onSaved} /> : null}
    </li>
  );
}

/** Флажок в силуэте кадра: рамка 16, внутри квадрат 8 фиолетовым (как в statistics/Chart.tsx) */
function Check({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label className="flex min-h-[30px] cursor-pointer items-center gap-[8px] text-[14px] text-text">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={onChange} />
      <span
        aria-hidden
        className={cx(
          "relative flex size-[16px] shrink-0 items-center justify-center rounded-[2px] border border-hairline",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--focus)]",
        )}
      >
        {checked ? <span className="size-[8px] rounded-[1px] bg-primary" /> : null}
      </span>
      <span className="min-w-0">{children}</span>
    </label>
  );
}

function FlagEditor({ flag, onSaved }: { flag: OpsFlag; onSaved: () => void }) {
  const { ut, lang } = useLang();
  const { run, busy } = useAction();
  const options = useResource(() => api.opsFlagAudience(), []);
  const [enabled, setEnabled] = useState(flag.enabled);
  const [audience, setAudience] = useState<FeatureFlagAudience>(flag.audience);
  const [person, setPerson] = useState("");

  if (!options.data) return <Loading rows={2} error={options.error} onRetry={options.reload} busy={options.loading} />;
  const o: FlagAudienceOptions = options.data;
  const flip = (field: ListField, value: string) => setAudience((a) => toggleIn(a, field, value));

  return (
    <div className="mt-[12px] rounded-[5px] bg-primary-tint px-[16px] py-[12px]">
      <Check checked={enabled} onChange={() => setEnabled(!enabled)}>
        <span className="font-bold">{ut("fl.enabled")}</span>
      </Check>
      <Check checked={audience.all} onChange={() => setAudience((a) => ({ ...a, all: !a.all }))}>
        {ut("fl.all")}
      </Check>

      {audience.all ? null : (
        <div className="mt-[8px] grid grid-cols-2 gap-x-[36px] gap-y-[12px] max-[900px]:grid-cols-1">
          <Group title={ut("fl.roles")}>
            {FLAG_BASE_ROLES.map((r) => (
              <Check key={r} checked={audience.roles.includes(r)} onChange={() => setAudience((a) => toggleRole(a, r))}>
                {ut(`fl.role.${r}`)}
              </Check>
            ))}
          </Group>
          <Group title={ut("fl.staffRoles")}>
            {o.staffRoles.map((r) => (
              <Check key={r.code} checked={audience.staffRoles.includes(r.code)} onChange={() => flip("staffRoles", r.code)}>
                {t(r.title, lang)}
              </Check>
            ))}
          </Group>
          <Group title={ut("fl.surveyGroups")}>
            {o.surveyGroups.map((g) => (
              <Check key={g.id} checked={audience.surveyGroups.includes(g.id)} onChange={() => flip("surveyGroups", g.id)}>
                {g.title}
              </Check>
            ))}
          </Group>
          <Group title={ut("fl.departments")}>
            {o.departments.map((d) => (
              <Check key={d.id} checked={audience.departments.includes(d.id)} onChange={() => flip("departments", d.id)}>
                {t(d.title, lang)}
              </Check>
            ))}
          </Group>
          <Group title={ut("fl.people")}>
            <ul className="m-0 mb-[6px] list-none p-0">
              {audience.users.map((id) => (
                <li key={id} className="flex items-center justify-between gap-[12px] text-[14px]">
                  <span className="min-w-0 truncate">{o.people.find((p) => p.id === id)?.name ?? id}</span>
                  <Button variant="ghost" onClick={() => flip("users", id)}>
                    {ut("fl.remove")}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-[8px]">
              <Select value={person} onChange={(e) => setPerson(e.target.value)} className="min-w-0 flex-1" aria-label={ut("fl.people")}>
                <option value="">—</option>
                {o.people
                  .filter((p) => !audience.users.includes(p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.email}
                    </option>
                  ))}
              </Select>
              <Button
                variant="quiet"
                disabled={!person}
                onClick={() => {
                  flip("users", person);
                  setPerson("");
                }}
              >
                {ut("fl.add")}
              </Button>
            </div>
          </Group>
        </div>
      )}

      {enabledForNobody(enabled, audience) ? (
        <p className="m-0 mt-[8px] text-[13px] text-accent">{ut("fl.emptyWarn")}</p>
      ) : null}
      <Button
        className="mt-[12px]"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await api.opsSaveFlag(flag.key, { enabled, audience });
            onSaved();
          }, ut("mt.done"))
        }
      >
        {ut("common.save")}
      </Button>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-[4px] p-0 text-[13px] font-bold text-muted">{title}</legend>
      {children}
    </fieldset>
  );
}

function ChangeLog({ items, names }: { items: FlagChange[]; names: OpsFlagsView["names"] | null }) {
  const { ut, lang } = useLang();
  if (!items.length) return <p className="m-0 text-[13px] text-muted">{ut("fl.noChanges")}</p>;
  const empty = { staffRoles: {}, users: {}, surveyGroups: {}, departments: {} };
  const describe = (s: FlagChange["after"]) => {
    const who = audienceParts(s.audience, names ?? empty, lang, ut);
    return `${s.enabled ? ut("fl.on") : ut("fl.off")} · ${who.length ? who.join(", ") : ut("fl.nobody")}`;
  };
  return (
    <ul className="m-0 list-none p-0">
      {items.map((c) => (
        <li
          key={c.id}
          className="grid grid-cols-[200px_minmax(0,1fr)_200px] gap-x-[24px] border-t border-hairline py-[10px] text-[14px] leading-[20px] first:border-t-0 max-[900px]:grid-cols-1 max-[900px]:gap-y-[2px]"
        >
          <span className="font-mono tabular-nums text-muted">{dateTime(c.at)}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className="block font-mono text-[12px] text-primary">{c.key}</span>
            <span className="block text-muted">
              {ut("fl.before")}: {c.before ? describe(c.before) : ut("fl.created")}
            </span>
            <span className="block text-text">
              {ut("fl.after")}: {describe(c.after)}
            </span>
          </span>
          <span className="min-w-0 truncate text-muted">{c.by ?? "—"}</span>
        </li>
      ))}
    </ul>
  );
}
