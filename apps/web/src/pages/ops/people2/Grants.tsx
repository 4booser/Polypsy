import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PERMISSION_TITLES, t, type Permission, type TemporaryGrant, type TemporaryGrants, type UiKey } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { ShareBar, TimeColumns, type SharePart } from "../../../charts/clinical";
import { useLang } from "../../../lang";
import { Avatar, DataTable, Drawer, DrawerPane, DrawerSection, KV, Loading, Modal, useAction } from "../../../ui";
import type { Column } from "../../../ui/DataTable";
import { FilterChip } from "../../../ui/filters";
import { Ic } from "../../../ui/icons";
import { Panel } from "../../../ui/layout";
import { MenuButton, menuItemClass } from "../../../ui/menu";
import { Tooltip } from "../../../ui/Popover";
import { Button, ButtonLink, Field, Input, Segmented, Select, Tag, Textarea } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { SectionPage } from "./frame";
import { Ix } from "./icons";
import { timeLeft, weekColumns } from "./model";
import { CodeChip, FootNote, Meter, Sx } from "./securityParts";
import {
  EXTEND_DAYS,
  GRANT_MAX_DAYS,
  daysUntil,
  elapsedPct,
  endingSoon,
  extendedUntil,
  fill,
  isoDay,
  pluralForm,
  shortDay,
  stamp,
} from "./securityModel";

/*
 * Техпанель → «Тимчасові доступи» (people2, пункт 19) в «Виразній».
 *
 * Личные исключения со сроком: что действует и сколько осталось, что
 * закончилось за тридцать дней, как исключения распределены по состоянию и
 * как часто их выдают. Бессрочные — числом со ссылкой на экран прав: их
 * разбирают там, по человеку.
 *
 * Смотреть — users.manage. Продлить, отозвать и выдать — только
 * суперадмину: исключения выдаёт он (routes/permissions.ts), продление — та
 * же выдача на новый срок. Остальным кнопки видны погашенными с подсказкой.
 *
 * Продление и выдача — в ящике справа, страница стоит на месте; отзыв —
 * окном подтверждения: он необратим, отозванное не продлевают.
 *
 * «Через 5 год» — янтарём: последние сутки — ровно «требует внимания»:
 * завтра утром доступа уже не будет.
 */

type DrawerMode = "extend" | "grant";
type ModeFilter = "" | "grant" | "revoke";

const SHARE_COLOR = {
  active: "var(--c1)",
  permanent: "var(--c4)",
  expired: "var(--c5)",
  revoked: "var(--c2)",
} as const;

export default function OpsGrants() {
  const { ut, lang } = useLang();
  const { user } = useAuth();
  const isSuper = user?.role === "superadmin";
  const res = useResource(() => api.temporaryGrants(), []);
  const [mode, setMode] = useState<DrawerMode>("extend");
  const [open, setOpen] = useState(false);
  const [extending, setExtending] = useState<TemporaryGrant | null>(null);
  const [revoking, setRevoking] = useState<TemporaryGrant | null>(null);
  const [permFilter, setPermFilter] = useState("");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("");
  /* люди и справочник прав для выдачи — только когда выдачу открыли */
  const [grantAsked, setGrantAsked] = useState(false);
  const now = Date.now();

  const openExtend = (g: TemporaryGrant) => {
    setExtending(g);
    setMode("extend");
    setOpen(true);
  };
  const openGrant = () => {
    setGrantAsked(true);
    setMode("grant");
    setOpen(true);
  };
  const done = () => {
    setOpen(false);
    setRevoking(null);
    res.reload();
  };

  const data = res.data;
  const soon = data ? endingSoon(data.active, now) : 0;
  const nearest = data?.active[0];
  const meta = data
    ? ([
        fill(ut(`opps.n.activeGrant.${pluralForm(data.active.length, lang)}` as UiKey), { n: data.active.length }),
        soon
          ? fill(ut(`opps.n.endingSoon.${pluralForm(soon, lang)}` as UiKey), { n: soon })
          : nearest
            ? fill(ut("opps.grants.nearest"), { at: stamp(nearest.expiresAt, lang) })
            : ut("opps.grants.nothingEnds"),
      ] as [string, string])
    : undefined;

  const active = useMemo(
    () =>
      (data?.active ?? []).filter(
        (g) => (!permFilter || g.permission === permFilter) && (!modeFilter || g.mode === modeFilter),
      ),
    [data, permFilter, modeFilter],
  );
  const activePerms = useMemo(() => [...new Set((data?.active ?? []).map((g) => g.permission))].sort(), [data]);

  const superOnly = ut("ops.users.superOnly");

  return (
    <SectionPage
      title={ut("ops.tab.grants")}
      perm="users.manage"
      meta={meta}
      lead={ut("opps.grants.lead")}
      actions={
        <>
          <ButtonLink to="/permissions" className="gap-2">
            <Ix.keyRound />
            {ut("opps.grants.toPermissions")}
          </ButtonLink>
          <Tooltip label={isSuper ? ut("opps.grants.grantTip") : superOnly}>
            <Button variant="primary" icon={<Ix.hourglass />} aria-disabled={!isSuper || undefined} aria-expanded={open && mode === "grant"} onClick={isSuper ? openGrant : undefined}>
              {ut("opps.grants.grant")}
            </Button>
          </Tooltip>
        </>
      }
    >
      {res.error && !data ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !data ? (
        <Loading rows={6} />
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid items-start gap-4 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-[1100px]:grid-cols-1">
            <StatesPanel data={data} soon={soon} />
            <WeeksPanel data={data} />
          </div>

          <Panel
            title={ut("ops.grants.active")}
            icon={<Ix.hourglass />}
            count={data.active.length}
            flush
            actions={
              <>
                {soon ? (
                  <Tag tone="attention" icon={<Ix.hourglass />}>
                    {fill(ut(`opps.n.endingSoon.${pluralForm(soon, lang)}` as UiKey), { n: soon })}
                  </Tag>
                ) : null}
                {data.active.length ? (
                  <>
                    <ChoiceChip
                      label={ut("ops.grants.permission")}
                      value={permFilter}
                      onChange={setPermFilter}
                      options={[{ value: "", label: ut("opps.grants.anyPermission") }, ...activePerms.map((p) => ({ value: p, label: p, code: true }))]}
                    />
                    <ChoiceChip
                      label={ut("opps.grants.action")}
                      value={modeFilter}
                      onChange={(v) => setModeFilter(v as ModeFilter)}
                      options={[
                        { value: "", label: ut("opps.grants.bothModes") },
                        { value: "grant", label: ut("ops.grants.given") },
                        { value: "revoke", label: ut("ops.grants.taken") },
                      ]}
                    />
                  </>
                ) : null}
              </>
            }
          >
            <GrantTable
              rows={active}
              ended={false}
              now={now}
              isSuper={isSuper}
              activeId={open && mode === "extend" ? extending?.id : undefined}
              onExtend={openExtend}
              onRevoke={setRevoking}
              empty={data.active.length ? ut("opps.grants.noneFiltered") : ut("ops.grants.noneActive")}
            />
          </Panel>

          <Panel
            title={ut("ops.grants.expired")}
            icon={<Ic.history />}
            count={data.expired.length}
            sub={ut("opps.grants.expiredSub")}
            flush
          >
            <GrantTable
              rows={data.expired}
              ended
              now={now}
              isSuper={isSuper}
              activeId={open && mode === "extend" ? extending?.id : undefined}
              onExtend={openExtend}
              onRevoke={setRevoking}
              empty={ut("ops.grants.noneExpired")}
            />
          </Panel>

          <FootNote>
            {fill(ut("opps.grants.permanentNote"), { n: data.permanent })}{" "}
            <Link to="/permissions" className="font-bold text-violet-ink no-underline hover:underline">
              {ut("opps.grants.toPermissions")}
            </Link>
          </FootNote>
        </div>
      )}

      <Drawer open={open} mode={mode} onClose={() => setOpen(false)} onReturn={(m) => {
        setMode((m as DrawerMode) ?? "extend");
        setOpen(true);
      }}>
        <ExtendPane g={extending} isSuper={isSuper} onDone={done} onCancel={() => setOpen(false)} />
        <GrantPane enabled={isSuper && grantAsked} isSuper={isSuper} onDone={done} onCancel={() => setOpen(false)} />
      </Drawer>

      {revoking ? <RevokeModal g={revoking} onClose={() => setRevoking(null)} onDone={done} /> : null}
    </SectionPage>
  );
}

/** Пилюля отбора с меню значений — «Право ⌄», «Дія ⌄» */
function ChoiceChip({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; code?: boolean }[];
}) {
  const current = options.find((o) => o.value === value && o.value);
  return (
    <MenuButton
      label={label}
      align="right"
      trigger={(p) => (
        <FilterChip
          label={label}
          value={current?.label}
          on={!!current}
          expanded={p["aria-expanded"]}
          onClick={p.onClick}
          onClear={current ? () => onChange("") : undefined}
        />
      )}
    >
      {(close) =>
        options.map((o) => (
          <button
            key={o.value || "all"}
            type="button"
            role="menuitemradio"
            aria-checked={o.value === value}
            className={menuItemClass("left")}
            onClick={() => {
              close();
              onChange(o.value);
            }}
          >
            <span className={o.code ? "min-w-0 flex-1 truncate font-mono text-[12px]" : "min-w-0 flex-1 truncate"}>{o.label}</span>
            {o.value === value ? <Ic.check size={15} className="text-violet-ink" /> : null}
          </button>
        ))
      }
    </MenuButton>
  );
}

/** Название права на языке страницы; неизвестное — кодом */
function usePermTitle() {
  const { lang } = useLang();
  return (code: string) => {
    const title = PERMISSION_TITLES[code as Permission];
    return title ? t(title, lang) : code;
  };
}

function ModeTag({ mode }: { mode: TemporaryGrant["mode"] }) {
  const { ut } = useLang();
  return mode === "grant" ? (
    <Tag tone="good" icon={<Ic.plus />}>
      {ut("ops.grants.given")}
    </Tag>
  ) : (
    <Tag tone="attention" icon={<Ic.minus />}>
      {ut("ops.grants.taken")}
    </Tag>
  );
}

function GrantTable({
  rows,
  ended,
  now,
  isSuper,
  activeId,
  onExtend,
  onRevoke,
  empty,
}: {
  rows: TemporaryGrant[];
  ended: boolean;
  now: number;
  isSuper: boolean;
  activeId?: string;
  onExtend: (g: TemporaryGrant) => void;
  onRevoke: (g: TemporaryGrant) => void;
  empty: string;
}) {
  const { ut, lang } = useLang();
  const permTitle = usePermTitle();
  const superOnly = ut("ops.users.superOnly");
  const columns: Column<TemporaryGrant>[] = [
    {
      key: "person",
      header: ut("ops.grants.person"),
      required: true,
      width: 200,
      sort: (g) => g.userName || g.userEmail,
      render: (g) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={g.userName || g.userEmail} size={28} tone="soft" />
          <Link
            to={`/permissions?user=${g.userId}`}
            title={g.userEmail}
            className="truncate font-bold text-text no-underline hover:underline hover:decoration-violet-line hover:decoration-2 hover:underline-offset-[3px]"
          >
            {g.userName || g.userEmail}
          </Link>
        </span>
      ),
    },
    {
      key: "permission",
      header: ut("ops.grants.permission"),
      required: true,
      width: 260,
      sort: (g) => g.permission,
      render: (g) => (
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <ModeTag mode={g.mode} />
            <CodeChip>{g.permission}</CodeChip>
          </span>
          <small className="truncate text-caption text-muted">{permTitle(g.permission)}</small>
        </span>
      ),
    },
    {
      key: "ends",
      header: ended ? ut("ops.grants.ended") : ut("ops.grants.ends"),
      required: true,
      width: 160,
      sort: (g) => g.expiresAt,
      render: (g) => {
        if (ended)
          return (
            <span className="flex flex-col">
              <span className="font-semibold tabular-nums text-text-2">{stamp(g.expiresAt, lang)}</span>
              <small className="text-caption text-muted">{ut("opps.grants.termEnded")}</small>
            </span>
          );
        const left = timeLeft(g.expiresAt, now);
        const pct = elapsedPct(g, now);
        const hours = left?.unit === "hours";
        return (
          <span className="flex flex-col gap-0.5">
            <span className={hours ? "font-extrabold text-warn" : "font-semibold text-text"}>
              {left
                ? fill(ut(hours ? "ops.grants.inHours" : "ops.grants.inDays"), { n: left.n })
                : ut("opps.grants.termEnded")}
            </span>
            <small className="text-caption tabular-nums text-muted">{fill(ut("opps.grants.until"), { at: stamp(g.expiresAt, lang) })}</small>
            <Meter
              thin
              pct={pct}
              tone={hours ? "warn" : "plain"}
              className="mt-0.5 w-[110px]"
              label={fill(ut("opps.grants.elapsed"), { pct })}
            />
          </span>
        );
      },
    },
    {
      key: "reason",
      header: ut("opps.grants.reason"),
      required: true,
      render: (g) => (
        <span className="flex min-w-0 flex-col">
          <span className="line-clamp-2 text-text [overflow-wrap:anywhere]">«{g.reason}»</span>
          {g.grantedByEmail ? (
            <small className="truncate text-caption text-muted">{fill(ut("opps.grants.by"), { who: g.grantedByEmail })}</small>
          ) : null}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      required: true,
      width: 168,
      render: (g) => (
        <span className="flex items-center justify-end gap-1">
          <Tooltip label={isSuper ? fill(ut("opps.grants.extendTip"), { name: g.userName || g.userEmail }) : superOnly}>
            <Button
              size="xs"
              icon={<Ix.calendarPlus />}
              aria-disabled={!isSuper || undefined}
              aria-expanded={activeId === g.id}
              onClick={isSuper ? () => onExtend(g) : undefined}
            >
              {ut("ops.grants.extend")}
            </Button>
          </Tooltip>
          {ended ? null : (
            <Tooltip label={isSuper ? ut("opps.grants.revokeNow") : superOnly}>
              <Button
                variant="quiet"
                size="icon-sm"
                icon={<Sx.undo />}
                aria-label={`${ut("opps.grants.revokeNow")}: ${g.userName || g.userEmail}, ${g.permission}`}
                aria-disabled={!isSuper || undefined}
                onClick={isSuper ? () => onRevoke(g) : undefined}
              />
            </Tooltip>
          )}
        </span>
      ),
    },
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(g) => g.id}
      initialSort={{ key: "ends", desc: ended }}
      isRowActive={(g) => g.id === activeId}
      label={ended ? ut("ops.grants.expired") : ut("ops.grants.active")}
      sticky={false}
      empty={
        <p className="m-0 border-t border-divider px-4 py-3.5 text-small text-muted">{empty}</p>
      }
    />
  );
}

/** «Усі винятки за станом»: одна полоса долей, легенда числами и что значит каждое */
function StatesPanel({ data, soon }: { data: TemporaryGrants; soon: number }) {
  const { ut, lang } = useLang();
  const s = data.stats;
  const total = s.active + s.permanent + s.expired + s.revoked;
  const parts: SharePart[] = [
    { key: "active", label: ut("opsp.grant.active"), value: s.active, color: SHARE_COLOR.active },
    { key: "permanent", label: ut("opsp.grant.permanent"), value: s.permanent, color: SHARE_COLOR.permanent },
    { key: "expired", label: ut("opsp.grant.expired"), value: s.expired, color: SHARE_COLOR.expired },
    { key: "revoked", label: ut("opsp.grant.revoked"), value: s.revoked, color: SHARE_COLOR.revoked },
  ];
  const rows: [string, number, string][] = [
    [
      ut("opsp.grant.active"),
      s.active,
      soon ? fill(ut(`opps.n.endingSoon.${pluralForm(soon, lang)}` as UiKey), { n: soon }) : ut("opps.grants.activeNote"),
    ],
    [ut("opsp.grant.permanent"), s.permanent, ut("opps.grants.permanentShort")],
    [ut("opps.grants.revokedEarly"), s.revoked, ut("opps.grants.revokedNote")],
  ];
  return (
    <Panel title={ut("opsp.grants.states")} icon={<Sx.chartPie />}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-small font-semibold text-text-2">{ut("opps.grants.inInstitution")}</span>
        <b className="text-[15px] font-extrabold tabular-nums text-text">{total}</b>
      </div>
      {total ? <ShareBar parts={parts} label={ut("opsp.grants.states")} /> : <p className="m-0 text-small text-muted">{ut("opps.grants.noneEver")}</p>}
      <dl className="m-0 mt-4 flex flex-col">
        {rows.map(([k, n, note]) => (
          <div key={k} className="flex items-baseline gap-2.5 border-t border-divider py-[7px] text-small first:border-t-0">
            <dt className="min-w-0 text-text-2">{k}</dt>
            <dd className="m-0 ml-auto flex items-baseline gap-2.5">
              <b className="font-extrabold tabular-nums text-text">{n}</b>
              <span className="text-caption text-muted">{note}</span>
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

/** «Видано за тижнями»: текущая неделя ещё идёт — её столбец светлее */
function WeeksPanel({ data }: { data: TemporaryGrants }) {
  const { ut, lang } = useLang();
  const cols = weekColumns(data.stats.byWeek, (iso) => shortDay(`${iso}T12:00:00`, lang)).map((c, i, all) =>
    i === all.length - 1 ? { ...c, partial: true } : c,
  );
  return (
    <Panel
      title={ut("opsp.grants.byWeek")}
      icon={<Ix.chartColumn />}
      sub={fill(ut("opsp.grants.byWeekHint"), { n: data.stats.byWeek.length })}
    >
      {cols.some((c) => c.value > 0) ? (
        <TimeColumns columns={cols} height={200} label={ut("opsp.grants.byWeek")} />
      ) : (
        <p className="m-0 text-small text-muted">{ut("opps.grants.noneWeeks")}</p>
      )}
    </Panel>
  );
}

/** Продлить: на сколько дней — и новый конец до нажатия, тем же правилом, что у сервера */
function ExtendPane({ g, isSuper, onDone, onCancel }: { g: TemporaryGrant | null; isSuper: boolean; onDone: () => void; onCancel: () => void }) {
  const { ut, lang } = useLang();
  const { run, busy } = useAction();
  const permTitle = usePermTitle();
  const [days, setDays] = useState(7);
  const now = Date.now();
  const until = g ? extendedUntil(g.expiresAt, days, now) : null;
  const left = g ? timeLeft(g.expiresAt, now) : null;
  const expired = g ? new Date(g.expiresAt).getTime() <= now : false;
  return (
    <DrawerPane
      mode="extend"
      title={ut("opps.grants.extendTitle")}
      sub={g ? `${g.userName || g.userEmail}, ${permTitle(g.permission)}` : undefined}
      icon={<Ix.calendarPlus />}
      note={isSuper ? undefined : ut("ops.users.superOnly")}
      noteIcon={<Ic.lock />}
      footer={
        <>
          <Button
            variant="primary"
            icon={<Sx.calendarCheck />}
            disabled={busy || !g || !isSuper}
            onClick={() =>
              void run(async () => {
                if (!g) return false;
                await api.extendGrant(g.id, days);
                onDone();
              }, ut("ops.grants.extended"))
            }
          >
            {until ? fill(ut("opps.grants.extendTo"), { day: shortDay(until, lang) }) : ut("ops.grants.extend")}
          </Button>
          <Button variant="quiet" onClick={onCancel}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      {g ? (
        <>
          <DrawerSection title={ut("opps.grants.exception")}>
            <KV
              w={96}
              rows={[
                [
                  ut("ops.grants.permission"),
                  <span key="p" className="inline-flex flex-wrap items-center gap-1.5">
                    <CodeChip>{g.permission}</CodeChip>
                    <span className="text-muted">{g.mode === "grant" ? ut("ops.grants.given") : ut("ops.grants.taken")}</span>
                  </span>,
                ],
                [
                  expired ? ut("ops.grants.ended") : ut("opps.grants.nowUntil"),
                  <span key="u">
                    <b className="font-extrabold tabular-nums">{stamp(g.expiresAt, lang)}</b>{" "}
                    {left ? (
                      <span className={left.unit === "hours" ? "font-bold text-warn" : "text-muted"}>
                        {fill(ut(left.unit === "hours" ? "ops.grants.inHours" : "ops.grants.inDays"), { n: left.n })}
                      </span>
                    ) : null}
                  </span>,
                ],
                [ut("opps.grants.reason"), <span key="r">«{g.reason}»</span>],
                [
                  ut("opps.grants.grantedBy"),
                  <span key="b" className="tabular-nums">
                    {[g.grantedByEmail, shortDay(g.grantedAt, lang)].filter(Boolean).join(", ")}
                  </span>,
                ],
              ]}
            />
          </DrawerSection>
          <DrawerSection title={ut("ops.grants.days")}>
            <Segmented
              wide
              label={ut("ops.grants.days")}
              value={String(days)}
              onChange={(v) => setDays(Number(v))}
              items={EXTEND_DAYS.map((d) => ({ key: String(d), label: d }))}
            />
            {until ? (
              <p className="m-0 mt-2.5 text-small text-muted">
                {fill(ut(expired ? "opps.grants.fromToday" : "opps.grants.fromEnd"), { from: stamp(g.expiresAt, lang) })}{" "}
                <b className="font-extrabold text-text">{stamp(until, lang)}</b>.
              </p>
            ) : null}
          </DrawerSection>
        </>
      ) : null}
    </DrawerPane>
  );
}

/** Выдать или отобрать право на срок — тот же маршрут, что у экрана прав */
function GrantPane({ enabled, isSuper, onDone, onCancel }: { enabled: boolean; isSuper: boolean; onDone: () => void; onCancel: () => void }) {
  const { ut, lang } = useLang();
  const { user } = useAuth();
  const { run, busy } = useAction();
  const staff = useResource(() => api.assignableStaff(), [], { enabled });
  const catalogue = useResource(() => api.permissionCatalogue(), [], { enabled });
  const [person, setPerson] = useState("");
  const [permission, setPermission] = useState("");
  const [mode, setMode] = useState<"grant" | "revoke">("grant");
  const today = new Date();
  const [until, setUntil] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return isoDay(d);
  });
  const [reason, setReason] = useState("");
  const days = daysUntil(until, today);
  const endsAt = days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
  const max = new Date(today);
  max.setDate(max.getDate() + GRANT_MAX_DAYS);
  const min = new Date(today);
  min.setDate(min.getDate() + 1);
  const ready = isSuper && !!person && !!permission && !!days && reason.trim().length >= 10;
  const dirty = !!person || !!permission || reason.trim().length > 0;

  return (
    <DrawerPane
      mode="grant"
      title={ut("opps.grants.grant")}
      sub={ut("opps.grants.grantTip")}
      icon={<Ix.hourglass />}
      dirty={dirty}
      draftName={ut("opps.grants.grantDraft")}
      footer={
        <>
          <Button
            variant="primary"
            icon={<Ix.hourglass />}
            disabled={busy || !ready}
            onClick={() =>
              void run(async () => {
                if (!ready || !days) return false;
                await api.addException(person, { permission, mode, reason: reason.trim(), days });
                setPerson("");
                setPermission("");
                setReason("");
                onDone();
              }, ut("perm.added"))
            }
          >
            {ut("perm.grant")}
          </Button>
          <Button variant="quiet" onClick={onCancel}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <DrawerSection>
        {staff.error || catalogue.error ? (
          <Loading bare error={staff.error ?? catalogue.error} onRetry={() => (staff.error ? staff.reload() : catalogue.reload())} />
        ) : !staff.data || !catalogue.data ? (
          <Loading bare rows={4} />
        ) : (
          <>
            <Field label={ut("ops.grants.person")}>
              <Select data-autofocus value={person} onChange={(e) => setPerson(e.target.value)}>
                <option value="">{ut("opps.grants.pickPerson")}</option>
                {staff.data
                  .filter((s) => s.id !== user?.id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.fullName || s.email}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={ut("ops.grants.permission")}>
              <Select value={permission} onChange={(e) => setPermission(e.target.value)}>
                <option value="">{ut("perm.pickPermission")}</option>
                {catalogue.data.groups.map((group) => (
                  <optgroup key={group.code} label={t(group.title, lang) || group.code}>
                    {group.permissions.map((p) => (
                      <option key={p.code} value={p.code}>
                        {t(p.title, lang)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Field>
            <Field label={ut("opps.grants.action")}>
              <Segmented
                wide
                label={ut("opps.grants.action")}
                value={mode}
                onChange={setMode}
                items={[
                  { key: "grant", label: ut("perm.grant") },
                  { key: "revoke", label: ut("perm.revoke") },
                ]}
              />
            </Field>
            <Field
              label={ut("opps.grants.untilLabel")}
              hint={endsAt ? fill(ut("opps.grants.endsAt"), { at: stamp(endsAt, lang), max: GRANT_MAX_DAYS }) : undefined}
              error={days ? null : fill(ut("opps.grants.badDate"), { max: GRANT_MAX_DAYS })}
            >
              <Input type="date" value={until} min={isoDay(min)} max={isoDay(max)} onChange={(e) => setUntil(e.target.value)} className="w-[180px]" />
            </Field>
            <Field label={ut("opps.grants.reason")} hint={ut("perm.reasonHint")}>
              <Textarea rows={3} maxLength={1000} value={reason} placeholder={ut("opps.grants.reasonPh")} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </>
        )}
      </DrawerSection>
    </DrawerPane>
  );
}

/** Отозвать сейчас — окном: необратимо, отозванное не продлевают */
function RevokeModal({ g, onClose, onDone }: { g: TemporaryGrant; onClose: () => void; onDone: () => void }) {
  const { ut, lang } = useLang();
  const { run, busy } = useAction();
  return (
    <Modal
      title={ut("opps.grants.revokeTitle")}
      sub={fill(ut("opps.grants.revokeSub"), { name: g.userName || g.userEmail, perm: g.permission, at: stamp(g.expiresAt, lang) })}
      icon={<Sx.undo />}
      tone="warn"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            icon={<Sx.undo />}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.revokeException(g.id);
                onDone();
              }, ut("ops.grants.revoked"))
            }
          >
            {ut("ops.grants.revoke")}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <p className="m-0 pt-3.5 text-body text-text-2">{ut("opps.grants.revokeText")}</p>
    </Modal>
  );
}
