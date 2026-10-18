import { useMemo, useState } from "react";
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
import { dateTime, locale } from "../../../format";
import { useLang } from "../../../lang";
import { refreshFlags } from "../../../service/flags";
import { Callout, Drawer, DrawerSection, Loading, SearchField, ViewPills, useAction } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Panel } from "../../../ui/layout";
import { MenuButton, menuItemClass } from "../../../ui/menu";
import { Button, CheckLabel, Checkbox, Segmented, Switch, Tag } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { fill } from "../../dashboard/model";
import { OpsIcon } from "../icons";
import { CopyLinkButton, Mono, OpsHead, PanelNote, Quiet, useCount } from "../parts";
import { audienceParts, enabledForNobody, toggleIn, toggleRole, type ListField } from "./model";

/**
 * Раздел «Прапорці» техпанели: какие флаги есть, кому включены, их
 * переключение, правка аудитории в ящике и журнал изменений.
 *
 * Решение заказчика 2026-09-26 (техпанель, пункт 11): включать новые
 * экраны отдельным людям или группам без выкатки.
 *
 * Список — из реестра кода (packages/shared/src/featureFlags.ts) плюс
 * строки таблицы, пережившие свой ключ: такие помечены «застарілий» и
 * править их нечего — сервер их никому не отдаёт.
 *
 * Переключатель в строке включает и выключает флаг сразу, с той же
 * аудиторией. «Змінити» открывает ящик: класс учётки, должности, люди,
 * отделения, группы методик; страница остаётся на месте, набранное в
 * ящике живёт до сохранения. Выбор «кому» грузится только при открытии
 * ящика: в нём имена всех сотрудников, и их чтение пишется в журнал.
 *
 * Флаг — не право: закрытое правом остаётся закрытым, это сказано у
 * сохранения.
 */

type View = "all" | "on" | "off" | "stale";

export default function OpsFlags() {
  const { ut, lang } = useLang();
  const { can } = useAuth();
  const manage = can("ops.manage");
  const count = useCount();
  const res = useResource(() => api.opsFlags(), []);
  const changes = useResource(() => api.opsFlagChanges(), []);
  const [editing, setEditing] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("all");

  const saved = () => {
    res.reload();
    changes.reload();
    // у правящего — сразу: флаг мог включиться ему самому
    refreshFlags();
  };

  const data = res.data;
  const items = data?.items ?? [];
  const on = items.filter((f) => f.enabled).length;
  const nobody = items.filter((f) => enabledForNobody(f.enabled, f.audience)).length;
  const stale = items.filter((f) => !f.known).length;
  const needle = q.trim().toLowerCase();
  const title = (f: OpsFlag) => (f.title ? (f.title[lang] ?? f.title.uk) : f.key);
  const shown = items.filter(
    (f) =>
      (view === "all" || (view === "on" && f.enabled) || (view === "off" && !f.enabled) || (view === "stale" && !f.known)) &&
      (!needle || f.key.toLowerCase().includes(needle) || title(f).toLowerCase().includes(needle)),
  );
  const flag = items.find((f) => f.key === editing) ?? null;

  const head = (
    <OpsHead
      meta={
        data
          ? [
              fill(ut("opx.fl.metaBold"), { flags: count(["opx.fl.flags.one", "opx.fl.flags.few", "opx.fl.flags.many"], items.length), on }),
              drawerOpen && flag ? fill(ut("opx.fl.metaEditing"), { name: title(flag) }) : nobody ? fill(ut("opx.fl.metaNobody"), { n: nobody }) : ut("opx.fl.metaOk"),
            ]
          : null
      }
      actions={<CopyLinkButton />}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {head}
      <p className="m-0 max-w-[90ch] text-small text-text-2">{ut("fl.hint")}</p>
      <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-start gap-4 max-[1180px]:grid-cols-1">
        <Panel
          title={ut("fl.title")}
          icon={<OpsIcon name="flag" />}
          sub={data ? fill(ut("opx.fl.sub"), { on, nobody }) : undefined}
          flush
          footer={<PanelNote icon="shield-check">{ut("opx.fl.notRight")}</PanelNote>}
        >
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
            <SearchField value={q} onChange={setQ} placeholder={ut("opx.fl.search")} slash width={220} />
            <ViewPills
              label={ut("opx.fl.views")}
              value={view}
              onChange={(k) => setView(k as View)}
              items={[
                { key: "all", label: ut("opx.jb.viewAll"), count: items.length },
                { key: "on", label: ut("opx.fl.viewOn"), count: on },
                { key: "off", label: ut("opx.fl.viewOff"), count: items.length - on },
                { key: "stale", label: ut("opx.fl.viewStale"), count: stale },
              ]}
            />
          </div>
          {res.error && !data ? (
            <div className="px-4 pb-3">
              <Loading bare error={res.error} onRetry={res.reload} />
            </div>
          ) : !data ? (
            <div className="px-4 pb-3">
              <Loading bare rows={4} />
            </div>
          ) : shown.length === 0 ? (
            <div className="px-4 pb-3">
              <Quiet>{ut("opx.fl.none")}</Quiet>
            </div>
          ) : (
            <ul className="m-0 list-none border-t border-divider p-0">
              {shown.map((f) => (
                <FlagRow
                  key={f.key}
                  flag={f}
                  view={data}
                  manage={manage && f.known}
                  editing={drawerOpen && editing === f.key}
                  onEdit={() => {
                    setEditing(f.key);
                    setDrawerOpen(true);
                  }}
                  onSaved={saved}
                />
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={ut("fl.changes")} icon={<OpsIcon name="history" />} flush>
          {changes.error && !changes.data ? (
            <div className="px-4 pb-3">
              <Loading bare error={changes.error} onRetry={changes.reload} />
            </div>
          ) : !changes.data ? (
            <div className="px-4 pb-3">
              <Loading bare rows={3} />
            </div>
          ) : (
            <ChangeLog items={changes.data.items} names={data?.names ?? null} />
          )}
        </Panel>
      </div>
      {manage && flag ? (
        <FlagEditor
          key={flag.key}
          open={drawerOpen}
          flag={flag}
          title={title(flag)}
          onClose={() => setDrawerOpen(false)}
          onReturn={() => setDrawerOpen(true)}
          onSaved={() => {
            setDrawerOpen(false);
            saved();
          }}
        />
      ) : null}
    </div>
  );
}

/* ─────────── строка флага ─────────── */

const PART_ICON: Record<"roles" | "staffRoles" | "users" | "surveyGroups" | "departments", Parameters<typeof OpsIcon>[0]["name"]> = {
  roles: "users",
  staffRoles: "badge-check",
  users: "user-round",
  surveyGroups: "layers",
  departments: "building-2",
};

/** «Кому» пилюлями: класс, должность, человек, группа, отделение — каждая со своим значком */
function Audience({ a, view }: { a: FeatureFlagAudience; view: OpsFlagsView }) {
  const { ut, lang } = useLang();
  if (a.all) return <Tag tone="primary">{ut("fl.everyone")}</Tag>;
  const parts: { key: string; icon: Parameters<typeof OpsIcon>[0]["name"]; label: string }[] = [
    ...a.roles.map((r) => ({ key: `r-${r}`, icon: PART_ICON.roles, label: ut(`fl.role.${r}`) })),
    ...a.staffRoles.map((c) => ({ key: `s-${c}`, icon: PART_ICON.staffRoles, label: view.names.staffRoles[c] ? t(view.names.staffRoles[c]!, lang) : c })),
    ...a.users.map((id) => ({ key: `u-${id}`, icon: PART_ICON.users, label: view.names.users[id] ?? id })),
    ...a.surveyGroups.map((id) => ({ key: `g-${id}`, icon: PART_ICON.surveyGroups, label: view.names.surveyGroups[id] ?? id })),
    ...a.departments.map((id) => ({ key: `d-${id}`, icon: PART_ICON.departments, label: view.names.departments[id] ? t(view.names.departments[id]!, lang) : id })),
  ];
  if (!parts.length) return <b className="text-small font-extrabold text-warn">{ut("fl.nobody")}</b>;
  return (
    <>
      {parts.map((p) => (
        <Tag key={p.key} icon={<OpsIcon name={p.icon} />}>
          {p.label}
        </Tag>
      ))}
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
  const { run, busy } = useAction();
  const name = flag.title ? (flag.title[lang] ?? flag.title.uk) : flag.key;
  return (
    <li className={cx("grid grid-cols-[46px_minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-divider px-4 py-3.5 last:border-b-0", editing && "bg-violet-tint", !flag.known && "opacity-90")}>
      <span className="pt-0.5">
        <Switch
          checked={flag.enabled}
          disabled={!manage || busy}
          label={<span className="sr-only">{fill(ut("opx.fl.toggle"), { name })}</span>}
          onChange={(next) =>
            void run(async () => {
              await api.opsSaveFlag(flag.key, { enabled: next, audience: flag.audience });
              onSaved();
            }, ut(next ? "opx.fl.turnedOn" : "opx.fl.turnedOff"))
          }
        />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <b className="text-[14px] font-extrabold leading-5 text-text">{name}</b>
          {flag.known ? null : (
            <Tag icon={<OpsIcon name="archive" />}>{ut("opx.fl.staleTag")}</Tag>
          )}
          <Mono className="text-text-2">{flag.key}</Mono>
        </div>
        {flag.description ? <p className="m-0 mt-0.5 text-[13px] leading-[19px] text-text-2">{flag.description[lang] ?? flag.description.uk}</p> : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-small text-muted">
          <span>{ut("fl.audience")}</span>
          <Audience a={flag.audience} view={view} />
          {flag.updatedAt ? (
            <span className="ml-1">{fill(ut("opx.fl.changed"), { time: dateTime(flag.updatedAt), by: flag.updatedBy ?? "—" })}</span>
          ) : null}
        </div>
        {enabledForNobody(flag.enabled, flag.audience) ? (
          <Callout kind="warn" icon={<OpsIcon name="users" />} className="mt-3">
            {ut("fl.emptyWarn")}
          </Callout>
        ) : null}
        {flag.known ? null : (
          <Callout kind="line" icon={<OpsIcon name="archive" />} title={ut("opx.fl.staleTitle")} className="mt-3">
            {ut("fl.stale")}
          </Callout>
        )}
      </div>
      <div>
        {editing ? (
          <span className="inline-flex items-center gap-1.5 text-small font-bold text-violet-ink">
            <OpsIcon name="pencil" size={14} />
            {ut("opx.fl.editing")}
          </span>
        ) : manage ? (
          <Button size="xs" icon={<OpsIcon name="pencil" />} onClick={onEdit}>
            {ut("fl.edit")}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/* ─────────── ящик правки ─────────── */

/** Список выбранного пилюлями с крестиком и «Додати» меню из оставшихся */
function ChipPicker({
  title,
  empty,
  chosen,
  options,
  onToggle,
  addLabel,
}: {
  title: string;
  empty: string;
  chosen: string[];
  options: { value: string; label: string }[];
  onToggle: (v: string) => void;
  addLabel: string;
}) {
  const { ut } = useLang();
  const rest = options.filter((o) => !chosen.includes(o.value));
  return (
    <DrawerSection title={title} sub={chosen.length ? undefined : empty}>
      <div className="flex flex-wrap items-center gap-2">
        {chosen.map((v) => (
          <span key={v} className="inline-flex h-9 items-center gap-1 rounded-[18px] bg-violet-tint pl-3 pr-1 text-small font-semibold text-violet-ink">
            {options.find((o) => o.value === v)?.label ?? v}
            <Button
              variant="quiet"
              size="icon-sm"
              aria-label={fill(ut("opx.fl.removeOne"), { name: options.find((o) => o.value === v)?.label ?? v })}
              icon={<OpsIcon name="x" />}
              onClick={() => onToggle(v)}
              className="size-7 text-violet-ink"
            />
          </span>
        ))}
        {rest.length ? (
          <MenuButton
            label={addLabel}
            trigger={(p) => (
              <Button size="sm" variant="outline" icon={<OpsIcon name="plus" />} {...p}>
                {addLabel}
              </Button>
            )}
          >
            {(close) => (
              <div className="max-h-[280px] overflow-y-auto">
                {rest.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="menuitem"
                    className={menuItemClass("left")}
                    onClick={() => {
                      onToggle(o.value);
                      close();
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </MenuButton>
        ) : null}
      </div>
    </DrawerSection>
  );
}

function FlagEditor({
  open,
  flag,
  title,
  onClose,
  onReturn,
  onSaved,
}: {
  open: boolean;
  flag: OpsFlag;
  title: string;
  onClose: () => void;
  onReturn: () => void;
  onSaved: () => void;
}) {
  const { ut, lang } = useLang();
  const { run, busy } = useAction();
  const options = useResource(() => api.opsFlagAudience(), []);
  const [enabled, setEnabled] = useState(flag.enabled);
  const [audience, setAudience] = useState<FeatureFlagAudience>(flag.audience);
  const dirty = enabled !== flag.enabled || JSON.stringify(audience) !== JSON.stringify(flag.audience);
  const flip = (field: ListField, value: string) => setAudience((a) => toggleIn(a, field, value));
  const o: FlagAudienceOptions | null = options.data;
  const save = (next: { enabled: boolean; audience: FeatureFlagAudience }) =>
    void run(async () => {
      await api.opsSaveFlag(flag.key, next);
      onSaved();
    }, ut("mt.done"));

  const lists = useMemo(
    () =>
      o
        ? {
            staffRoles: o.staffRoles.map((r) => ({ value: r.code, label: t(r.title, lang) })),
            users: o.people.map((p) => ({ value: p.id, label: p.name || p.email })),
            departments: o.departments.map((d) => ({ value: d.id, label: t(d.title, lang) })),
            surveyGroups: o.surveyGroups.map((g) => ({ value: g.id, label: g.title })),
          }
        : null,
    [o, lang],
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      onReturn={onReturn}
      wide
      title={title}
      sub={<Mono className="text-muted">{flag.key}</Mono>}
      icon={<OpsIcon name="flag" />}
      dirty={dirty}
      draftName={fill(ut("opx.fl.draftName"), { name: title })}
      note={ut("opx.fl.notRight")}
      noteIcon={<OpsIcon name="shield-check" />}
      footer={
        <>
          <Button variant="primary" icon={<OpsIcon name="check" />} disabled={busy} onClick={() => save({ enabled, audience })}>
            {ut("common.save")}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
          {flag.enabled ? (
            <Button variant="ghost" icon={<OpsIcon name="power" />} disabled={busy} onClick={() => save({ enabled: false, audience })} className="ml-auto">
              {ut("opx.fl.offForAll")}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-3 py-4">
        <Switch checked={enabled} onChange={setEnabled} label={ut("fl.enabled")} />
        <Segmented
          className="ml-auto"
          label={ut("fl.audience")}
          value={audience.all ? "all" : "some"}
          onChange={(k) => setAudience((a) => ({ ...a, all: k === "all" }))}
          items={[
            { key: "all", label: ut("fl.all") },
            { key: "some", label: ut("opx.fl.chosen") },
          ]}
        />
      </div>
      {audience.all ? null : !lists ? (
        <Loading bare rows={3} error={options.error} onRetry={options.reload} />
      ) : (
        <>
          <DrawerSection title={ut("fl.roles")} sub={ut("opx.fl.wholeClass")}>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {FLAG_BASE_ROLES.map((r) => (
                <CheckLabel
                  key={r}
                  label={ut(`fl.role.${r}`)}
                  control={<Checkbox checked={audience.roles.includes(r)} onChange={() => setAudience((a) => toggleRole(a, r))} />}
                />
              ))}
            </div>
          </DrawerSection>
          <ChipPicker
            title={ut("fl.staffRoles")}
            empty={ut("opx.fl.noneChosen")}
            chosen={audience.staffRoles}
            options={lists.staffRoles}
            onToggle={(v) => flip("staffRoles", v)}
            addLabel={ut("fl.add")}
          />
          <ChipPicker
            title={ut("fl.people")}
            empty={ut("opx.fl.nobodyChosen")}
            chosen={audience.users}
            options={lists.users}
            onToggle={(v) => flip("users", v)}
            addLabel={ut("opx.fl.addPerson")}
          />
          <ChipPicker
            title={ut("fl.departments")}
            empty={ut("opx.fl.noneChosen")}
            chosen={audience.departments}
            options={lists.departments}
            onToggle={(v) => flip("departments", v)}
            addLabel={ut("fl.add")}
          />
          <ChipPicker
            title={ut("fl.surveyGroups")}
            empty={ut("opx.fl.noneChosen")}
            chosen={audience.surveyGroups}
            options={lists.surveyGroups}
            onToggle={(v) => flip("surveyGroups", v)}
            addLabel={ut("opx.fl.addGroup")}
          />
        </>
      )}
      {enabledForNobody(enabled, audience) ? (
        <Callout kind="warn" icon={<OpsIcon name="users" />} className="mb-4">
          {ut("fl.emptyWarn")}
        </Callout>
      ) : null}
    </Drawer>
  );
}

/* ─────────── журнал ─────────── */

function ChangeLog({ items, names }: { items: FlagChange[]; names: OpsFlagsView["names"] | null }) {
  const { ut, lang } = useLang();
  if (!items.length)
    return (
      <div className="px-4 pb-3">
        <Quiet>{ut("fl.noChanges")}</Quiet>
      </div>
    );
  const empty = { staffRoles: {}, users: {}, surveyGroups: {}, departments: {} };
  const describe = (s: FlagChange["after"]) => {
    const who = audienceParts(s.audience, names ?? empty, lang, ut);
    return fill(ut("opx.fl.state"), { state: s.enabled ? ut("fl.on") : ut("fl.off"), who: who.length ? who.join(", ") : ut("fl.nobody") });
  };
  return (
    <ul className="m-0 list-none border-t border-divider p-0">
      {items.map((c) => (
        <li key={c.id} className="grid grid-cols-[96px_minmax(0,1fr)] gap-2.5 border-b border-divider px-4 py-2.5 text-small leading-[18px] last:border-b-0">
          <span className="font-bold text-text-2">
            {new Date(c.at).toLocaleString(locale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
            <small className="block font-medium text-muted">{c.by ?? "—"}</small>
          </span>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <Mono className="block font-bold text-text">{c.key}</Mono>
            <span className="block text-muted">
              {ut("fl.before")}: {c.before ? describe(c.before) : ut("fl.created")}
            </span>
            <span className="block text-text">
              {ut("fl.after")}: {describe(c.after)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
