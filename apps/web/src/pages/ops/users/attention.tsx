import type { ReactNode } from "react";
import type { OpsAttentionGroup, OpsAttentionPerson, OpsUsersAttention } from "@quizzy/shared";
import { useAuth } from "../../../auth";
import { useLang } from "../../../lang";
import { AlertChip, AlertStrip } from "../../../ui";
import { Ic } from "../../../ui/icons";
import { Panel } from "../../../ui/layout";
import { ButtonLink, Button } from "../../../ui/primitives";
import { useToast } from "../../../ui/toast";
import { Ix } from "../people2/icons";
import { clock, fill, numDay, stamp } from "./parts";

/*
 * «Потребує уваги» над реестром (Polypsy 2.0): четыре группы записей, о
 * которых администратору стоит знать сейчас, — одной строкой пилюль, у
 * каждой подсказка «кого» с именами. Имя открывает запись в панели справа:
 * там и снять блок сбросом пароля, и выдать новый пароль, и выключить.
 *
 * Группы считает сервер (GET /api/ops/users/attention) теми же правилами,
 * что сторож входа и политика второго фактора. Пустая группа не рисуется;
 * когда пусто всё, панели нет вовсе — «всё в порядке» не требует внимания.
 */

const HOUR = 3_600_000;

function People({
  group,
  onOpen,
  aside,
}: {
  group: OpsAttentionGroup;
  onOpen: (id: string) => void;
  aside: (p: OpsAttentionPerson) => ReactNode;
}) {
  const { ut } = useLang();
  return (
    <div>
      <ul className="m-0 list-none p-0">
        {group.people.map((p) => (
          <li key={p.id} className="flex items-baseline gap-3 border-t border-divider py-1.5 first:border-t-0 first:pt-0">
            <button
              type="button"
              onClick={() => onOpen(p.id)}
              className="min-h-0 min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-small font-bold text-violet-ink hover:underline hover:underline-offset-[3px]"
            >
              {p.fullName || p.email}
            </button>
            <span className="ml-auto shrink-0 text-caption text-muted tabular-nums">{aside(p)}</span>
          </li>
        ))}
      </ul>
      {group.count > group.people.length ? (
        <p className="m-0 mt-1.5 text-caption text-muted">{fill(ut("oppu.attMore"), { n: group.count - group.people.length })}</p>
      ) : null}
    </div>
  );
}

export function AttentionPanel({ data, onOpen }: { data: OpsUsersAttention; onOpen: (id: string) => void }) {
  const { ut } = useLang();
  const { can } = useAuth();
  const toast = useToast();
  const { locked, mfaMissing, tempPassword, idleStaff } = data;
  if (!locked.count && !mfaMissing.count && !tempPassword.count && !idleStaff.count) return null;

  const now = Date.now();
  const firstUnlock = locked.people[0]?.at ?? null;
  const copyEmails = () => {
    const text = mfaMissing.people.map((p) => p.email).join(", ");
    if (!navigator.clipboard) {
      toast(ut("ops.users.copyFailed"), "err");
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => toast(fill(ut("oppu.emailsCopied"), { n: mfaMissing.people.length }), "ok"),
      () => toast(ut("ops.users.copyFailed"), "err"),
    );
  };

  return (
    <Panel title={ut("oppu.attTitle")} sub={ut("oppu.attSub")} icon={<Ix.bellRing />} tone="warn">
      <AlertStrip>
        {locked.count ? (
          <AlertChip
            kind="warn"
            icon={<Ic.lock />}
            label={fill(ut("oppu.attLocked"), { n: locked.count })}
            detail={firstUnlock ? fill(ut("oppu.untilT"), { t: clock(firstUnlock) }) : undefined}
            popTitle={ut("opsp.state.locked")}
            popNote={firstUnlock ? fill(ut("oppu.untilT"), { t: clock(firstUnlock) }) : undefined}
            pop={
              <>
                <p className="m-0 mb-2 text-small text-text-2">{ut("oppu.attLockedHint")}</p>
                <People
                  group={locked}
                  onOpen={onOpen}
                  aside={(p) => fill(ut("oppu.lockedSub"), { n: p.failures ?? 0, t: p.at ? clock(p.at) : "—" })}
                />
              </>
            }
          />
        ) : null}
        {mfaMissing.count ? (
          <AlertChip
            kind="warn"
            icon={<Ix.shieldAlert />}
            label={fill(ut("oppu.attMfa"), { n: mfaMissing.count })}
            detail={ut("oppu.required")}
            popTitle={ut("oppu.attMfaTitle")}
            popNote={ut("oppu.required")}
            pop={
              <>
                <p className="m-0 mb-2 text-small text-text-2">{ut("oppu.attMfaHint")}</p>
                <People
                  group={mfaMissing}
                  onOpen={onOpen}
                  aside={(p) => (p.because === "superadmin" ? ut("ops.mfa.because.superadmin") : ut("ops.mfa.because.ops"))}
                />
              </>
            }
            popActions={
              <>
                {can("ops.manage") ? (
                  <ButtonLink to="/ops/mfa" size="xs">
                    <Ix.shieldPlus />
                    {ut("ops.tab.mfa")}
                  </ButtonLink>
                ) : null}
                <Button size="xs" variant="quiet" icon={<Ix.copy />} onClick={copyEmails}>
                  {ut("oppu.copyEmails")}
                </Button>
              </>
            }
          />
        ) : null}
        {tempPassword.count ? (
          <AlertChip
            kind="warn"
            icon={<Ix.keyRound />}
            label={fill(ut("oppu.attTemp"), { n: tempPassword.count })}
            detail={fill(ut("oppu.overHours"), { n: data.tempHours })}
            popTitle={ut("ops.users.tempPassword")}
            popNote={fill(ut("oppu.overHours"), { n: data.tempHours })}
            pop={
              <>
                <p className="m-0 mb-2 text-small text-text-2">{ut("oppu.attTempHint")}</p>
                <People
                  group={tempPassword}
                  onOpen={onOpen}
                  aside={(p) => (p.at ? fill(ut("oppu.hoursAgo"), { n: Math.floor((now - Date.parse(p.at)) / HOUR) }) : "—")}
                />
              </>
            }
          />
        ) : null}
        {idleStaff.count ? (
          <AlertChip
            kind="neutral"
            icon={<Ix.moon />}
            label={fill(ut("oppu.attIdle"), { n: idleStaff.count, d: data.idleDays })}
            detail={ut("oppu.staffWord")}
            popTitle={fill(ut("oppu.attIdleTitle"), { d: data.idleDays })}
            popNote={ut("oppu.staffWord")}
            pop={
              <>
                <p className="m-0 mb-2 text-small text-text-2">{ut("oppu.attIdleHint")}</p>
                <People
                  group={idleStaff}
                  onOpen={onOpen}
                  aside={(p) =>
                    p.at ? (p.never ? fill(ut("oppu.neverSince"), { d: numDay(p.at) }) : stamp(p.at)) : "—"
                  }
                />
              </>
            }
          />
        ) : null}
      </AlertStrip>
    </Panel>
  );
}
