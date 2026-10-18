import type { ReactNode } from "react";
import type { OpsUserRow, Role, UiKey } from "@quizzy/shared";
import { api } from "../../../api";
import { useLang } from "../../../lang";
import { Avatar, Loading } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Ic } from "../../../ui/icons";
import { FilterChip } from "../../../ui/filters";
import { MenuButton, menuItemClass } from "../../../ui/menu";
import { Popover, Tooltip } from "../../../ui/Popover";
import { Button, Tag } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { Ix } from "../people2/icons";
import { rowFactor, rowState } from "../usersModel";

/*
 * Ячейки реестра «Користувачі» (Polypsy 2.0, «Виразна»): учётная запись с
 * кружком и пометкой «ви», роль пилюлей, вход с датой заведения, сессии с
 * подсказкой, второй фактор и состояние словом. Без своих решений: что
 * показать, решают rowState / rowFactor (usersModel.ts).
 */

const two = (n: number) => String(n).padStart(2, "0");

/**
 * Дата и время цифрами, как в реестрах набора: «08.10, 17:00»; год — когда
 * он не текущий («14.08.2025, 12:03»). Время — местное, как у всей консоли.
 */
export function stamp(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const year = d.getFullYear() === now.getFullYear() ? "" : `.${d.getFullYear()}`;
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}${year}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Дата цифрами с годом: «12.01.2025» */
export function numDay(iso: string): string {
  const d = new Date(iso);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Только время: «17:15» */
export function clock(iso: string): string {
  const d = new Date(iso);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Подстановка {name} в строку словаря */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

const ROLE_ICON: Record<Role, ReactNode> = {
  superadmin: <Ic.shieldCheck />,
  admin: <Ix.userCog />,
  user: <Ix.userRound />,
};

const ROLE_WORD: Record<Role, UiKey> = {
  superadmin: "oppu.role.superadmin",
  admin: "oppu.role.admin",
  user: "oppu.role.user",
};

/** Роль пилюлей: суперадмин — фиолетовым (вершина доступа), прочие — нейтрально */
export function RolePill({ role }: { role: Role }) {
  const { ut } = useLang();
  return (
    <Tag tone={role === "superadmin" ? "primary" : "plain"} icon={ROLE_ICON[role]}>
      {ut(ROLE_WORD[role])}
    </Tag>
  );
}

/** Кружок учётки: пациент — фиолетовым, персонал — светлым, без имени — нейтральным «?» */
export function AccountAvatar({ row, size = 28 }: { row: Pick<OpsUserRow, "fullName" | "email" | "role" | "anonymous">; size?: number }) {
  if (row.anonymous) return <Avatar name="?" initials="?" size={size} tone="neutral" />;
  return <Avatar name={row.fullName || row.email} size={size} tone={row.role === "user" ? "violet" : "soft"} />;
}

/** Обліковий запис: кружок, имя (или «без імені»), «ви» у своей строки, почта */
export function AccountCell({ row, self }: { row: OpsUserRow; self: boolean }) {
  const { ut } = useLang();
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <AccountAvatar row={row} />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <b className={cx("truncate text-body leading-[18px]", row.anonymous ? "font-semibold text-muted" : "font-bold text-text")}>
            {row.anonymous ? ut("sel.noName") : row.fullName || row.email}
          </b>
          {self ? (
            <Tag tone="primary" className="h-[18px] px-1.5 text-[10.5px]">
              {ut("oppu.you")}
            </Tag>
          ) : null}
        </span>
        <small className="truncate text-caption text-muted">{row.email}</small>
      </span>
    </span>
  );
}

/** Роль: пилюля и под ней роли-шаблоны с особыми исключениями прав (янтарём: это отступление от шаблона) */
export function RoleCell({ row }: { row: OpsUserRow }) {
  const { ut } = useLang();
  const titles = row.roleTitles.join(", ");
  return (
    <span className="flex min-w-0 flex-col items-start gap-[3px]">
      <RolePill role={row.role} />
      {titles || row.exceptions ? (
        <small className="text-caption leading-4 text-muted">
          {titles}
          {titles && row.exceptions ? ", " : null}
          {row.exceptions ? (
            <b className="font-bold text-warn">{fill(ut("oppu.exceptionsN"), { n: row.exceptions })}</b>
          ) : null}
        </small>
      ) : null}
    </span>
  );
}

/** Останній вхід: время входа (или «ще не входив») и под ним — с какого дня запись */
export function LastSeenCell({ row }: { row: OpsUserRow }) {
  const { ut } = useLang();
  return (
    <span className="flex min-w-0 flex-col gap-[3px]">
      {row.lastSeenAt ? (
        <span className="font-semibold tabular-nums text-text">{stamp(row.lastSeenAt)}</span>
      ) : (
        <span className="text-muted">{ut("ops.users.neverSeen")}</span>
      )}
      <small className="text-caption leading-4 text-muted tabular-nums">{fill(ut("oppu.since"), { d: numDay(row.createdAt) })}</small>
    </span>
  );
}

/** Сессии человека в подсказке — загружаются, только когда подсказку открыли */
function SessionsPeek({ userId }: { userId: string }) {
  const { ut } = useLang();
  const res = useResource(() => api.opsSessions({ userId, per: "10" }), [userId]);
  if (res.error) return <Loading error={res.error} onRetry={res.reload} bare />;
  if (!res.data) return <Loading rows={2} bare />;
  if (!res.data.items.length) return <p className="m-0 text-small text-muted">{ut("ops.users.noSessions")}</p>;
  return (
    <table className="w-full border-collapse text-small">
      <tbody>
        {res.data.items.map((s) => (
          <tr key={s.id} className="border-t border-divider first:border-t-0">
            <td className="py-1 pr-3 text-text-2">{fill(ut("oppu.sessionSince"), { t: stamp(s.startedAt) })}</td>
            <td className="py-1 text-right font-bold tabular-nums text-text">{stamp(s.lastUsedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Сесії: число; у кого есть — подсказка со списком и переходом к сессиям человека */
export function SessionsCell({ row, onOpen }: { row: OpsUserRow; onOpen: () => void }) {
  const { ut } = useLang();
  if (!row.sessions) return <span className="tabular-nums text-muted">0</span>;
  return (
    <Popover
      title={ut("ops.tab.sessions")}
      note={row.anonymous ? undefined : row.fullName}
      content={<SessionsPeek userId={row.id} />}
      actions={
        <Button size="xs" icon={<Ix.monitorSmartphone />} onClick={onOpen}>
          {ut("ops.users.sessionsOf")}
        </Button>
      }
      side="bottom"
      align="end"
      width={320}
    >
      <span className="cursor-default rounded-[4px] font-bold tabular-nums text-text underline decoration-dotted decoration-muted underline-offset-[3px]">
        {row.sessions}
      </span>
    </Popover>
  );
}

const BECAUSE: Record<"superadmin" | "ops", UiKey> = {
  superadmin: "ops.mfa.because.superadmin",
  ops: "ops.mfa.because.ops",
};

/** Другий фактор: так / немає (обов’язковий, янтарём) / ні (не обов’язковий) / — (пацієнт) */
export function FactorCell({ row }: { row: OpsUserRow }) {
  const { ut } = useLang();
  const f = rowFactor(row);
  if (f === "none")
    return (
      <Tooltip label={ut("oppu.mfaPatients")}>
        <span tabIndex={0} className="text-muted">
          —
        </span>
      </Tooltip>
    );
  if (f === "on")
    return (
      <span className="inline-flex items-center gap-1.5 font-semibold text-text-2">
        <Ic.shieldCheck size={15} className="text-good" />
        {ut("oppu.mfaYes")}
      </span>
    );
  if (f === "missing")
    return (
      <Tooltip label={fill(ut("oppu.mfaRequired"), { why: ut(BECAUSE[row.secondFactor!.required!]) })}>
        <span tabIndex={0} className="inline-flex rounded-pill">
          <Tag tone="attention" icon={<Ix.shieldAlert />}>
            {ut("oppu.mfaMissing")}
          </Tag>
        </span>
      </Tooltip>
    );
  return (
    <Tooltip label={ut("oppu.mfaOptional")}>
      <span tabIndex={0} className="inline-flex items-center gap-1.5 text-muted">
        <Ix.shield size={15} />
        {ut("oppu.mfaNo")}
      </span>
    </Tooltip>
  );
}

/** Стан: одно состояние словом и строка пояснения под ним */
export function StateCell({ row }: { row: OpsUserRow }) {
  const { ut } = useLang();
  const s = rowState(row);
  if (s === "disabled") {
    const tip = [
      fill(ut("oppu.disabledBy"), { d: numDay(row.disabledAt!), who: row.disabledByEmail ?? "—" }),
      row.disabledReason ? `«${row.disabledReason}»` : "",
    ]
      .filter(Boolean)
      .join(": ");
    return (
      <span className="flex min-w-0 flex-col items-start gap-[3px]">
        <Tag tone="done" icon={<Ic.ban />}>
          {fill(ut("oppu.disabledOn"), { d: numDay(row.disabledAt!).slice(0, 5) })}
        </Tag>
        {row.disabledReason ? (
          <Tooltip label={tip}>
            <small tabIndex={0} className="block max-w-full truncate text-caption leading-4 text-muted">
              «{row.disabledReason}»
            </small>
          </Tooltip>
        ) : null}
      </span>
    );
  }
  if (s === "locked")
    return (
      <span className="flex min-w-0 flex-col items-start gap-[3px]">
        <Tag tone="attention" icon={<Ic.lock />}>
          {ut("oppu.locked")}
        </Tag>
        <small className="text-caption leading-4 text-muted tabular-nums">
          {fill(ut("oppu.lockedSub"), { n: row.lock!.failures, t: clock(row.lock!.until) })}
        </small>
      </span>
    );
  if (s === "temp")
    return (
      <span className="flex min-w-0 flex-col items-start gap-[3px]">
        <Tag tone="attention" icon={<Ix.keyRound />}>
          {ut("ops.users.tempMark")}
        </Tag>
        {row.lastSeenAt ? null : <small className="text-caption leading-4 text-muted">{ut("ops.users.neverSeen")}</small>}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold text-text-2">
      <i aria-hidden className="size-2 rounded-full bg-good" />
      {ut("ops.users.activeOne")}
    </span>
  );
}

/**
 * Чип отбора с меню значений (.fchip набора): «Роль ⌄», выбранное —
 * тонированным со значением и крестиком «зняти». Первое значение списка —
 * «усі» (пустая строка). Один на техпанель: «Користувачі», «Сесії»,
 * «Аудит», «Тимчасові доступи» и правило «Підозрілої активності».
 */
export function ChoiceChip({
  label,
  choices,
  value,
  onChange,
  align,
  plateClassName = "min-w-[220px]",
}: {
  label: string;
  /** `code` — значение-идентификатор (код права): моноширинно, его ищут буква в букву */
  choices: { value: string; label: string; code?: boolean }[];
  value: string;
  onChange: (v: string) => void;
  /** Край, к которому прижато меню: у чипа в правом углу панели — правый */
  align?: "left" | "right";
  plateClassName?: string;
}) {
  const current = choices.find((c) => c.value === value && value);
  return (
    <MenuButton
      label={label}
      align={align}
      plateClassName={plateClassName}
      trigger={(p) => (
        <FilterChip
          label={label}
          value={current?.label}
          on={!!current}
          onClick={p.onClick}
          expanded={p["aria-expanded"]}
          onClear={current ? () => onChange("") : undefined}
        />
      )}
    >
      {(close) =>
        choices.map((c) => (
          <button
            key={c.value || "all"}
            type="button"
            role="menuitemradio"
            aria-checked={c.value === value}
            className={menuItemClass("left")}
            onClick={() => {
              close();
              onChange(c.value);
            }}
          >
            <span className={cx("min-w-0 flex-1 truncate", c.code && "font-mono text-[12px]")}>{c.label}</span>
            {c.value === value ? <Ic.check size={15} className="text-violet-ink" /> : null}
          </button>
        ))
      }
    </MenuButton>
  );
}
