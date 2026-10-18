import type { ReactNode } from "react";
import type { OpsUserRow } from "@quizzy/shared";
import { api } from "../../../api";
import { locale } from "../../../format";
import { useAuth } from "../../../auth";
import { useLang } from "../../../lang";
import { AlertChip, AlertStrip, Callout, Drawer, DrawerSection, KV, Loading, useAction } from "../../../ui";
import { Ic } from "../../../ui/icons";
import { useHotkeys } from "../../../ui/keys";
import { ActionMenu, type MenuEntry } from "../../../ui/menu";
import { Tooltip } from "../../../ui/Popover";
import { Button, ButtonLink, Tag } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { actionLabel, holdKey, holdsOfRow } from "../model";
import { Ix } from "../people2/icons";
import type { Dialog } from "../Users";
import { DevicesSection } from "../UserDevices";
import { accountOutOfReach, rowFactor, rowState } from "../usersModel";
import { clock, fill, numDay, RolePill, stamp } from "./parts";

/*
 * Обліковий запис у панелі справа (Polypsy 2.0, «Виразна»): реестр
 * остаётся на месте, запись открывается рядом — по строке, по Enter, по
 * имени в «Потребує уваги» и по ссылке `?user=:id`.
 *
 * Шапка — кто это и что о нём открыто сейчас (строка пилюль: исключения
 * прав, стирание устройства, сессии, второй фактор, блок входа), под ней —
 * частые действия. Тело — ключевые факты, устройства застосунку со
 * стиранием, живые сессии, клинический след с причиной «видалити не можна»
 * и последние действия по журналу. Внизу — действия над входом.
 *
 * Права те же, что у меню строки (userRowMenu): у записи вне досягаемости
 * действий нет вовсе, остаются переходы «подивитися». Решает всё равно
 * сервер — экран лишь не обещает того, что кончится отказом.
 */

function SessionsSection({ row, canEnd, onEndAll }: { row: OpsUserRow; canEnd: boolean; onEndAll: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.opsSessions({ userId: row.id, per: "20" }), [row.id, row.sessions]);
  return (
    <DrawerSection
      id="ops-user-sessions"
      title={ut("oppu.sessionsTitle")}
      right={
        canEnd && row.sessions > 0 ? (
          <Button size="xs" variant="quiet" icon={<Ix.logOut />} onClick={onEndAll}>
            {ut("oppu.endAll")}
          </Button>
        ) : undefined
      }
    >
      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} bare />
      ) : !res.data ? (
        <Loading rows={2} bare />
      ) : !res.data.items.length ? (
        <p className="m-0 text-small text-muted">{ut("ops.users.noSessions")}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {res.data.items.map((s) => (
            <li key={s.id} className="flex min-h-10 items-center gap-2.5 border-t border-divider py-1.5 first:border-t-0">
              <span className="inline-grid size-7 shrink-0 place-items-center rounded-[9px] bg-sunk text-muted">
                <Ix.monitorSmartphone size={15} />
              </span>
              <span className="min-w-0 flex-1 text-small text-text-2 tabular-nums">
                <b className="font-bold text-text">{fill(ut("oppu.sessionIn"), { t: stamp(s.startedAt) })}</b>
                <span className="block text-caption text-muted">
                  {fill(ut("oppu.sessionUpd"), { t: stamp(s.lastUsedAt) })}, {fill(ut("oppu.sessionUntil"), { d: numDay(s.expiresAt) })}
                </span>
              </span>
              {canEnd ? (
                <Button
                  size="xs"
                  variant="quiet"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.revokeSession(s.id);
                      res.reload();
                    }, ut("oppu.sessionEnded"))
                  }
                >
                  {ut("oppu.end")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </DrawerSection>
  );
}

function RecentSection({ row }: { row: OpsUserRow }) {
  const { ut } = useLang();
  const res = useResource(() => api.auditPage({ actorId: row.id, limit: "5" }), [row.id]);
  return (
    <DrawerSection
      title={ut("oppu.recent")}
      sub={row.journalEntries ? fill(ut("oppu.inJournal"), { n: row.journalEntries.toLocaleString(locale()) }) : undefined}
      right={
        <ButtonLink to={`/ops/audit?actor=${row.id}`} size="xs" variant="quiet">
          {ut("oppu.allJournal")}
        </ButtonLink>
      }
    >
      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} bare />
      ) : !res.data ? (
        <Loading rows={2} bare />
      ) : !res.data.entries.length ? (
        <p className="m-0 text-small text-muted">{ut("oppu.recentNone")}</p>
      ) : (
        <ol className="m-0 list-none p-0">
          {res.data.entries.map((e) => (
            <li key={e.id} className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 border-t border-divider py-1.5 text-small first:border-t-0">
              <span className="tabular-nums text-muted">{stamp(e.at)}</span>
              <span className="min-w-0 text-text-2">
                {actionLabel(e.action, ut)}
                {e.outcome !== "success" ? (
                  <Tag tone="attention" className="ml-1.5 h-5 align-[1px]">
                    {e.outcome === "denied" ? ut("oppu.denied") : ut("oppu.failed")}
                  </Tag>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      )}
      <ButtonLink to={`/ops/audit?subject=${row.id}`} size="xs" variant="quiet" className="mt-1.5">
        <Ix.fileSearch />
        {ut("ops.users.subjectLog")}
      </ButtonLink>
    </DrawerSection>
  );
}

function Facts({ row }: { row: OpsUserRow }) {
  const { ut } = useLang();
  const f = rowFactor(row);
  const why = row.secondFactor?.required
    ? ut(row.secondFactor.required === "superadmin" ? "ops.mfa.because.superadmin" : "ops.mfa.because.ops")
    : "";
  const factor =
    f === "none" ? (
      <span className="text-muted">{ut("oppu.mfaNotForPatients")}</span>
    ) : f === "on" ? (
      ut("ops.mfa.enabled")
    ) : f === "missing" ? (
      <span>
        {ut("ops.mfa.missing")}
        <span className="font-bold text-warn">{`, ${fill(ut("oppu.mfaRequired"), { why }).toLowerCase()}`}</span>
      </span>
    ) : (
      <span>
        {ut("ops.mfa.missing")}
        <span className="text-muted">{`, ${ut("oppu.mfaOptional").toLowerCase()}`}</span>
      </span>
    );
  const rows: [ReactNode, ReactNode][] = [
    [ut("adm.createdAt"), <span className="tabular-nums">{numDay(row.createdAt)}</span>],
    [
      ut("ops.users.lastSeen"),
      row.lastSeenAt ? <span className="tabular-nums">{stamp(row.lastSeenAt)}</span> : <span className="text-muted">{ut("ops.users.neverSeen")}</span>,
    ],
    [ut("oppu.factPassword"), row.mustChangePassword ? <span className="text-warn">{ut("oppu.passwordTemp")}</span> : ut("oppu.passwordOwn")],
    [ut("ops.tab.mfa"), factor],
  ];
  if (row.role !== "user")
    rows.push([
      ut("oppu.factExceptions"),
      row.exceptions ? (
        <span className="font-bold text-warn tabular-nums">{fill(ut("oppu.exceptionsN"), { n: row.exceptions })}</span>
      ) : (
        <span className="text-muted">{ut("oppu.none")}</span>
      ),
    ]);
  if (row.lock)
    rows.push([
      ut("oppu.factLock"),
      <span className="text-warn tabular-nums">{fill(ut("oppu.lockedSub"), { n: row.lock.failures, t: clock(row.lock.until) })}</span>,
    ]);
  if (row.disabledAt)
    rows.push([
      ut("opsp.state.disabled"),
      <span>
        <span className="tabular-nums">{numDay(row.disabledAt)}</span>
        {row.disabledByEmail ? <span className="text-muted">{`, ${row.disabledByEmail}`}</span> : null}
        {row.disabledReason ? <span className="block text-text-2">«{row.disabledReason}»</span> : null}
      </span>,
    ]);
  return (
    <DrawerSection title={ut("oppu.facts")}>
      <KV rows={rows} w={128} />
    </DrawerSection>
  );
}

function TraceSection({ row }: { row: OpsUserRow }) {
  const { ut } = useLang();
  const holds = holdsOfRow(row);
  return (
    <DrawerSection title={ut("oppu.trace")}>
      {holds.length ? (
        <div className="flex flex-wrap gap-1.5">
          {holds.map((h) => (
            <Tag key={h.key}>
              {ut(holdKey(h.key))}
              <b className="ml-1 font-extrabold tabular-nums text-text">{h.count.toLocaleString(locale())}</b>
            </Tag>
          ))}
        </div>
      ) : null}
      <Callout kind={holds.length ? "info" : "neutral"} className={holds.length ? "mt-3" : undefined}>
        {holds.length ? ut("oppu.traceHeld") : ut("oppu.traceFree")}
      </Callout>
    </DrawerSection>
  );
}

export function UserDrawer({
  open,
  id,
  hint,
  version,
  onClose,
  onDialog,
  menu,
  onStep,
}: {
  open: boolean;
  id: string | null;
  /** Строка из списка — пока свежая запись грузится */
  hint: OpsUserRow | null;
  /** Счётчик перечитывания после действия над записью */
  version: number;
  onClose: () => void;
  onDialog: (d: Dialog) => void;
  menu: (row: OpsUserRow) => MenuEntry[];
  /** J / K — соседняя запись страницы */
  onStep: (step: 1 | -1) => void;
}) {
  const { ut } = useLang();
  const { user } = useAuth();
  const isSuper = user?.role === "superadmin";
  const res = useResource(() => api.opsUser(id!), [id, version], { enabled: !!id });
  const row = res.data && res.data.id === id ? res.data : hint && hint.id === id ? hint : null;
  useHotkeys({ j: () => onStep(1), k: () => onStep(-1) }, open);

  const self = row ? row.id === user?.id : false;
  const outOfReach = row ? accountOutOfReach(user, row) : true;
  const act = !!row && !outOfReach && !self;
  const state = row ? rowState(row) : "active";
  const factor = row ? rowFactor(row) : "none";
  const impersonable = !!row && isSuper && !self && row.role !== "superadmin" && !row.disabledAt;

  const name = row ? (row.anonymous ? ut("sel.noName") : row.fullName || row.email) : ut("ops.users.account");
  const scrollTo = (anchor: string) => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const header = row ? (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <RolePill role={row.role} />
        {row.roleTitles.map((t) => (
          <Tag key={t}>{t}</Tag>
        ))}
        {state === "active" ? (
          <span className="ml-1 inline-flex items-center gap-1.5 text-small font-semibold text-text-2">
            <i aria-hidden className="size-2 rounded-full bg-good" />
            {ut("ops.users.activeOne")}
          </span>
        ) : state === "disabled" ? (
          <Tag tone="done" icon={<Ic.ban />}>
            {fill(ut("oppu.disabledOn"), { d: numDay(row.disabledAt!).slice(0, 5) })}
          </Tag>
        ) : null}
      </div>
      <AlertStrip>
        {row.exceptions ? (
          <AlertChip
            kind="warn"
            icon={<Ix.keyRound />}
            label={fill(ut("oppu.chipExceptions"), { n: row.exceptions })}
            to={`/permissions?user=${row.id}`}
          />
        ) : null}
        {state === "locked" ? (
          <AlertChip
            kind="warn"
            icon={<Ic.lock />}
            label={ut("oppu.locked")}
            detail={fill(ut("oppu.untilT"), { t: clock(row.lock!.until) })}
          />
        ) : null}
        {state === "temp" ? <AlertChip kind="warn" icon={<Ix.keyRound />} label={ut("ops.users.tempMark")} /> : null}
        {row.sessions ? (
          <AlertChip
            icon={<Ix.monitorSmartphone />}
            label={fill(ut("oppu.chipSessions"), { n: row.sessions })}
            detail={ut("oppu.now")}
            onClick={() => scrollTo("ops-user-sessions")}
          />
        ) : null}
        {factor === "on" ? <AlertChip kind="good" icon={<Ic.shieldCheck />} label={ut("oppu.chipMfaOn")} /> : null}
        {factor === "missing" ? (
          <AlertChip kind="warn" icon={<Ix.shieldAlert />} label={ut("ops.tab.mfa")} detail={ut("ops.mfa.missing")} />
        ) : null}
      </AlertStrip>
      <div className="flex flex-wrap items-center gap-2">
        {act ? (
          <Button size="xs" icon={<Ix.userCog />} onClick={() => onDialog({ kind: "role", row })}>
            {ut("ops.users.changeRole")}
          </Button>
        ) : null}
        {row.role !== "user" && !outOfReach ? (
          <ButtonLink to={`/permissions?user=${row.id}`} size="xs">
            <Ix.keyRound />
            {ut("ops.users.permissions")}
          </ButtonLink>
        ) : null}
        {impersonable ? (
          <Tooltip label={ut("ops.imp.action")}>
            <Button size="xs" icon={<Ic.eye />} onClick={() => onDialog({ kind: "impersonate", row })}>
              {ut("oppu.viewAs")}
            </Button>
          </Tooltip>
        ) : null}
        <ActionMenu
          label={`${ut("oppu.moreActions")}: ${name}`}
          glyph={<Ic.ellipsis />}
          entries={menu(row)}
          triggerSize="icon-sm"
          align="right"
          plateClassName="min-w-[280px]"
        />
      </div>
    </div>
  ) : null;

  const footer = act ? (
    <>
      <Button size="xs" icon={<Ix.rotateCcw />} onClick={() => onDialog({ kind: "reset", row: row! })}>
        {ut("ops.users.resetPassword")}
      </Button>
      {isSuper && row!.secondFactor?.enabled ? (
        <Button size="xs" icon={<Ix.shieldAlert />} onClick={() => onDialog({ kind: "resetMfa", row: row! })}>
          {ut("ops.mfa.reset")}
        </Button>
      ) : null}
      {row!.disabledAt ? (
        <Button size="xs" icon={<Ic.circleCheck />} onClick={() => onDialog({ kind: "enable", row: row! })}>
          {ut("ops.users.enable")}
        </Button>
      ) : (
        <Button size="xs" icon={<Ic.ban />} onClick={() => onDialog({ kind: "disable", row: row! })}>
          {`${ut("ops.users.disable")}…`}
        </Button>
      )}
    </>
  ) : undefined;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      wide
      title={name}
      sub={row ? row.email : undefined}
      icon={<Ix.userRound />}
      headerExtra={header}
      note={ut("oppu.drawerNote")}
      noteIcon={<Ix.fileSearch />}
      footer={footer}
    >
      {/* закрытая панель не держит скелетов: ящик не размонтируется, и пустой скелет висел бы в странице */}
      {!id ? null : !row ? (
        res.error ? (
          <Loading error={res.error} onRetry={res.reload} bare />
        ) : (
          <Loading rows={6} bare />
        )
      ) : (
        <>
          <Facts row={row} />
          {isSuper ? <DevicesSection userId={row.id} name={name} /> : null}
          <SessionsSection row={row} canEnd={!outOfReach} onEndAll={() => onDialog({ kind: "revoke", row })} />
          <TraceSection row={row} />
          <RecentSection row={row} />
        </>
      )}
    </Drawer>
  );
}
