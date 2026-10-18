import { useState } from "react";
import type { OpsUsersRoleSummary, OpsUsersSummary, Role, UiKey } from "@quizzy/shared";
import { ShareBar, SeriesLegend, StackColumns, type SeriesKey, type StackColumn } from "../../../charts/clinical";
import { useLang } from "../../../lang";
import { Loading } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Ic } from "../../../ui/icons";
import { Panel } from "../../../ui/layout";
import { Ix } from "../people2/icons";
import { fill } from "./parts";

/*
 * «Зведення реєстру» над списком (Polypsy 2.0): весь реестр, без отбора
 * списка, — три панели в ряд: состояния учёток по ролям со вторым фактором,
 * новые учётки по неделям, входы по дням. Только числа; пациенты — через
 * порог малых чисел, как их отдал сервер (GET /api/ops/users/summary).
 *
 * Сводку можно свернуть: кто открывает реестр ради одного человека, листает
 * её каждый раз. Свёрнутость помнит браузер этого человека — это удобство,
 * а не данные.
 */

const HIDE_KEY = "quizzy.ops.users.summaryHidden";

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHidden(v: boolean): void {
  try {
    if (v) localStorage.setItem(HIDE_KEY, "1");
    else localStorage.removeItem(HIDE_KEY);
  } catch {
    /* приватное окно без хранилища: свёрнутость живёт до перезагрузки */
  }
}

/** Состояния — в постоянном порядке, своими цветами (как в легенде под панелью) */
const STATES: { key: OpsUsersRoleSummary["states"][number]["key"]; label: UiKey; color: string }[] = [
  { key: "active", label: "oppu.st.active", color: "var(--c1)" },
  { key: "never", label: "oppu.st.never", color: "var(--c2)" },
  { key: "locked", label: "oppu.st.locked", color: "var(--c3)" },
  { key: "disabled", label: "oppu.st.disabled", color: "var(--c5)" },
];

const ROLES_LABEL: Record<Role, UiKey> = {
  superadmin: "oppu.roles.superadmin",
  admin: "oppu.roles.admin",
  user: "oppu.roles.user",
};

/** «05.10» — подпись столбца; полная дата — в подсказке */
const dm = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
};

function RoleShare({ role, first }: { role: OpsUsersRoleSummary; first: boolean }) {
  const { ut } = useLang();
  const parts = STATES.map((s) => ({
    key: s.key,
    label: ut(s.label),
    value: role.states.find((x) => x.key === s.key)?.count ?? null,
    color: s.color,
  }));
  const mfa = role.mfa;
  return (
    <div className={cx("py-2.5", first ? "pt-0" : "border-t border-divider")}>
      <div className="flex items-baseline justify-between gap-3 text-small">
        <span className="font-semibold text-text-2">{ut(ROLES_LABEL[role.role])}</span>
        <b className="font-extrabold tabular-nums text-text">{role.total ?? "—"}</b>
      </div>
      <ShareBar parts={parts} legend={false} label={ut(ROLES_LABEL[role.role])} className="mt-1.5" />
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
        {parts.map((p) => (
          <span key={p.key} className="inline-flex items-center gap-1 tabular-nums">
            <i aria-hidden className="size-2 rounded-[2px]" style={{ background: p.color }} />
            <span className="sr-only">{p.label}</span>
            {p.value ?? "—"}
          </span>
        ))}
        <span className="ml-auto">
          {mfa ? (
            <span
              className={cx(
                "inline-flex items-center gap-1 font-semibold",
                mfa.enabled >= mfa.total ? "text-good" : "text-warn",
              )}
            >
              {mfa.enabled >= mfa.total ? <Ic.shieldCheck size={13} /> : <Ix.shieldAlert size={13} />}
              {fill(ut("oppu.sumMfa"), { n: mfa.enabled, of: mfa.total })}
            </span>
          ) : (
            ut("oppu.sumMfaNone")
          )}
        </span>
      </div>
    </div>
  );
}

export function SummaryPanels({ data }: { data: OpsUsersSummary }) {
  const { ut } = useLang();
  const accounts: SeriesKey[] = [
    { key: "staff", label: ut("opsp.series.staff"), color: "var(--c2)" },
    { key: "patients", label: ut("opsp.series.patients"), color: "var(--c1)" },
  ];
  const logins: SeriesKey[] = [
    { key: "success", label: ut("opsp.series.success"), color: "var(--c1)" },
    { key: "failed", label: ut("opsp.series.failed"), color: "var(--c2)" },
  ];
  /*
   * Неделя, где пациентов меньше порога: их часть столбца не рисуется, а
   * подсказка говорит, что число скрыто, — не ноль.
   */
  const weeks: StackColumn[] = data.newByWeek.map((w) => ({
    key: w.week,
    label: dm(w.week),
    tip:
      w.patients === null
        ? `${fill(ut("oppu.weekOf"), { d: dm(w.week) })}: ${fill(ut("oppu.weekHidden"), { n: data.smallCellFloor })}`
        : fill(ut("oppu.weekOf"), { d: dm(w.week) }),
    values: [w.staff, w.patients ?? 0],
  }));
  const days: StackColumn[] = data.loginsByDay.map((d) => ({ key: d.date, label: dm(d.date), values: [d.success, d.failed] }));
  const failed = data.loginsByDay.reduce((s, d) => s + d.failed, 0);
  const hiddenWeeks = data.newByWeek.some((w) => w.patients === null);

  return (
    <div className="grid grid-cols-3 gap-4 max-[1180px]:grid-cols-2 max-[860px]:grid-cols-1">
      <Panel title={ut("opsp.users.states")} sub={ut("oppu.byRoles")} icon={<Ic.users />}>
        {data.roles.map((r, i) => (
          <RoleShare key={r.role} role={r} first={i === 0} />
        ))}
        <SeriesLegend className="mt-2" items={STATES.map((s) => ({ key: s.key, label: ut(s.label), color: s.color }))} />
      </Panel>
      <Panel
        title={ut("opsp.users.newByWeek")}
        sub={fill(ut("oppu.weeksN"), { n: data.newByWeek.length })}
        icon={<Ix.userPlus />}
        footer={
          hiddenWeeks ? (
            <span className="inline-flex items-center gap-1.5 text-caption text-muted">
              <Ix.eyeOff size={13} />
              {fill(ut("oppu.hiddenNote"), { n: data.smallCellFloor })}
            </span>
          ) : undefined
        }
      >
        <StackColumns series={accounts} columns={weeks} height={210} label={ut("opsp.users.newByWeek")} />
      </Panel>
      <Panel
        title={ut("opsp.users.logins")}
        sub={fill(ut("oppu.loginsSub"), { n: data.loginsByDay.length, failed })}
        icon={<Ix.logIn />}
      >
        <StackColumns series={logins} columns={days} height={210} label={ut("opsp.users.logins")} />
      </Panel>
    </div>
  );
}

/** Шапка сводки со «Сховати зведення» и сами панели */
export function RegistrySummary({ data, error, onRetry }: { data: OpsUsersSummary | null; error: string | null; onRetry: () => void }) {
  const { ut } = useLang();
  const [hidden, setHidden] = useState(readHidden);
  const toggle = () => {
    writeHidden(!hidden);
    setHidden(!hidden);
  };
  return (
    <section aria-labelledby="ops-users-summary-h">
      <div className="mb-2.5 mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h2 id="ops-users-summary-h" className="m-0 text-section font-extrabold tracking-[-0.015em] text-text">
          {ut("opsp.users.section")}
        </h2>
        <span className="text-small text-muted">{ut("oppu.summarySub")}</span>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!hidden}
          aria-controls="ops-users-summary"
          className="ml-auto inline-flex h-9 min-h-0 cursor-pointer items-center gap-[7px] rounded-control border-0 bg-transparent px-3 text-small font-semibold text-muted hover:bg-sunk hover:text-text"
        >
          {hidden ? <Ic.chevronDown size={14} /> : <Ic.chevronDown size={14} className="rotate-180" />}
          {hidden ? ut("oppu.showSummary") : ut("oppu.hideSummary")}
        </button>
      </div>
      <div id="ops-users-summary" hidden={hidden}>
        {error ? (
          <Loading error={error} onRetry={onRetry} />
        ) : !data ? (
          <Loading rows={4} />
        ) : (
          <SummaryPanels data={data} />
        )}
      </div>
    </section>
  );
}
