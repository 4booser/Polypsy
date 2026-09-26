import { useState } from "react";
import { Link } from "react-router-dom";
import { PERMISSION_TITLES, t, type Permission, type TemporaryGrant } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { dateTime, day } from "../../../format";
import { useLang } from "../../../lang";
import { Loading, Modal, useAction } from "../../../ui";
import { ActionMenu, type MenuEntry } from "../../../ui/menu";
import { IconDots } from "../../../ui/glyphs";
import { Button, Field, Select, Tag } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { Cell, ColumnHead, metaClass, rowClass } from "../controls";
import { ConfirmPlain } from "../dialogs";
import { EXTEND_CHOICES, timeLeft } from "./model";
import { Empty, Section } from "./parts";

/*
 * Техпанель → «Тимчасові доступи» (people2, пункт 19).
 *
 * Личные исключения со сроком: кто получил временный доступ, когда он
 * закончится, что истекло за последние тридцать дней. Бессрочные — числом со
 * ссылкой на экран прав: их разбирают там, по человеку, а здесь — то, что
 * кончается само и о чём надо вспомнить до того, как дежурный утром
 * обнаружит, что права на разбор случаев у него больше нет.
 *
 * Смотреть — users.manage (часть ведения учёток). Продлить и отозвать —
 * только суперадмину: личные исключения выдаёт он (routes/permissions.ts), и
 * продление — та же выдача на новый срок. Остальным пункты видны погашенными
 * с объяснением.
 *
 * «Закінчується через 2 год» — янтарём: последние сутки — это ровно
 * «требует внимания». Остальные сроки — просто текстом.
 */

const GRID = "grid grid-cols-[minmax(0,1.8fr)_minmax(0,2fr)_minmax(0,1.3fr)_44px] gap-x-[20px]";

export default function OpsGrants() {
  const { ut } = useLang();
  const { user } = useAuth();
  const isSuper = user?.role === "superadmin";
  const res = useResource(() => api.temporaryGrants(), []);
  const [extending, setExtending] = useState<TemporaryGrant | null>(null);
  const [revoking, setRevoking] = useState<TemporaryGrant | null>(null);
  const done = () => {
    setExtending(null);
    setRevoking(null);
    res.reload();
  };

  if (res.error) return <Loading error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading rows={5} />;
  const { active, expired, permanent } = res.data;
  const labels = [ut("ops.grants.person"), ut("ops.grants.permission"), ut("ops.grants.ends"), null];

  const menu = (g: TemporaryGrant, isActive: boolean): MenuEntry[] => [
    {
      label: ut("ops.grants.extend"),
      onSelect: () => setExtending(g),
      disabled: !isSuper,
      hint: ut("ops.users.superOnly"),
    },
    ...(isActive
      ? [
          {
            label: ut("ops.grants.revoke"),
            danger: true,
            onSelect: () => setRevoking(g),
            disabled: !isSuper,
            hint: ut("ops.users.superOnly"),
          },
        ]
      : []),
    { label: ut("ops.users.permissions"), to: `/permissions?user=${g.userId}` },
  ];

  return (
    <>
      <Section
        title={ut("ops.grants.active")}
        aside={
          <Link to="/permissions" className="text-[13px] text-muted no-underline hover:underline">
            {ut("ops.grants.permanent")}: <span className="font-mono tabular-nums">{permanent}</span>
          </Link>
        }
      >
        {active.length === 0 ? (
          <Empty>{ut("ops.grants.noneActive")}</Empty>
        ) : (
          <>
            <ColumnHead grid={GRID} labels={labels} />
            <ul className="m-0 list-none p-0">
              {active.map((g) => (
                <GrantRow key={g.id} g={g} active menu={menu(g, true)} />
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title={ut("ops.grants.expired")}>
        {expired.length === 0 ? (
          <Empty>{ut("ops.grants.noneExpired")}</Empty>
        ) : (
          <>
            <ColumnHead grid={GRID} labels={[labels[0]!, labels[1]!, ut("ops.grants.ended"), null]} />
            <ul className="m-0 list-none p-0">
              {expired.map((g) => (
                <GrantRow key={g.id} g={g} active={false} menu={menu(g, false)} />
              ))}
            </ul>
          </>
        )}
      </Section>

      {extending ? <ExtendDialog g={extending} onClose={() => setExtending(null)} onDone={done} /> : null}
      {revoking ? <RevokeDialog g={revoking} onClose={() => setRevoking(null)} onDone={done} /> : null}
    </>
  );
}

function GrantRow({
  g,
  active,
  menu,
}: {
  g: TemporaryGrant;
  active: boolean;
  menu: MenuEntry[];
}) {
  const { ut, lang } = useLang();
  const title = PERMISSION_TITLES[g.permission as Permission];
  const left = active ? timeLeft(g.expiresAt, Date.now()) : null;
  return (
    <li className={rowClass(GRID)}>
      <div className="min-w-0">
        <Link
          to={`/permissions?user=${g.userId}`}
          className="block text-[17px] font-bold leading-[22px] text-primary no-underline hover:no-underline [overflow-wrap:anywhere] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        >
          {g.userName || g.userEmail}
        </Link>
        <span className={metaClass}>{g.userEmail}</span>
      </div>
      <Cell label={ut("ops.grants.permission")}>
        <span className="block">
          {title ? t(title, lang) : g.permission}
          <span className="text-muted"> · {g.mode === "grant" ? ut("ops.grants.given") : ut("ops.grants.taken")}</span>
        </span>
        <span className={metaClass}>{g.reason}</span>
        <span className={metaClass}>
          {day(g.grantedAt)}
          {g.grantedByEmail ? ` · ${ut("ops.grants.by")} ${g.grantedByEmail}` : ""}
        </span>
      </Cell>
      <Cell label={active ? ut("ops.grants.ends") : ut("ops.grants.ended")}>
        <span className="block">{dateTime(g.expiresAt)}</span>
        {left ? (
          left.unit === "hours" ? (
            /* последние сутки — «требует внимания»: завтра утром доступа уже не будет */
            <Tag tone="attention">{ut("ops.grants.inHours").replace("{n}", String(left.n))}</Tag>
          ) : (
            <span className={metaClass}>{ut("ops.grants.inDays").replace("{n}", String(left.n))}</span>
          )
        ) : null}
      </Cell>
      <div className="flex justify-end max-[900px]:justify-start">
        <ActionMenu label={`${ut("ops.users.actions")}: ${g.userName || g.userEmail}`} glyph={<IconDots />} entries={menu} plateClassName="min-w-[260px]" />
      </div>
    </li>
  );
}

function ExtendDialog({ g, onClose, onDone }: { g: TemporaryGrant; onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [days, setDays] = useState(EXTEND_CHOICES[1]!);
  return (
    <Modal title={`${ut("ops.grants.extend")} · ${g.userName || g.userEmail}`} onClose={onClose}>
      <p className="m-0 mb-[12px] text-[15px] leading-[21px] text-text-2">{ut("ops.grants.extendHint")}</p>
      <Field label={ut("ops.grants.days")} labelClassName="mb-[6px] block text-[13px] font-bold text-muted">
        <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
          {EXTEND_CHOICES.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
      </Field>
      <div className="mt-[20px] flex justify-end gap-[14px]">
        <Button variant="ghost" onClick={onClose}>
          {ut("common.cancel")}
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.extendGrant(g.id, days);
              onDone();
            }, ut("ops.grants.extended"))
          }
        >
          {ut("ops.grants.extend")}
        </Button>
      </div>
    </Modal>
  );
}

/** Отозвать — штатным маршрутом экрана прав: второй путь к тому же действию разошёлся бы с первым */
function RevokeDialog({ g, onClose, onDone }: { g: TemporaryGrant; onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  return (
    <ConfirmPlain
      title={ut("ops.grants.revoke")}
      actionLabel={ut("ops.grants.revoke")}
      danger
      busy={busy}
      onClose={onClose}
      onConfirm={() =>
        void run(async () => {
          await api.revokeException(g.id);
          onDone();
        }, ut("ops.grants.revoked"))
      }
    >
      <p className="m-0 [overflow-wrap:anywhere]">
        {g.userEmail} · {g.permission}: {ut("ops.grants.revokeWarn")}
      </p>
    </ConfirmPlain>
  );
}
