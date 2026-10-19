import type { OpsSessionsSummary, Role, SessionAgeBucket, UiKey } from "@quizzy/shared";
import { HBars, SeriesLegend, ShareBar } from "../../../charts/clinical";
import { useLang } from "../../../lang";
import { Callout, Loading } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Panel } from "../../../ui/layout";
import { Button } from "../../../ui/primitives";
import { Ix } from "../people2/icons";
import { fill } from "../users/parts";

/*
 * Сводка «Сесій» (Polypsy 2.0): кто держит вход прямо сейчас — по роли — и
 * сколько сессиям лет от входа, у персонала и у пациентов порознь. Только
 * числа, пациенты — через порог малых чисел (GET /api/ops/sessions/summary).
 *
 * «Звідки» (клиента входа) здесь нет: у refresh-токена ни устройства, ни
 * адреса, а подбирать клиента по журналу входов значило бы выдавать догадку
 * за факт — так решено и для списка, и для сводки (lib/peopleStats.ts).
 */

const ROLE_PLURAL: Record<Role, UiKey> = {
  superadmin: "oppu.roles.superadmin",
  admin: "oppu.roles.admin",
  user: "oppu.roles.user",
};

/** Корзины возраста — лестницей одного фиолетового: от свежих к давним темнее */
const AGES: { key: SessionAgeBucket; label: UiKey; color: string }[] = [
  { key: "day", label: "opsp.age.day", color: "var(--h2)" },
  { key: "week", label: "opsp.age.week", color: "var(--h3)" },
  { key: "month", label: "opsp.age.month", color: "var(--h4)" },
  { key: "older", label: "opsp.age.older", color: "var(--h5)" },
];

const GROUP: Record<"staff" | "patients", UiKey> = { staff: "opsp.series.staff", patients: "opsp.series.patients" };

export function SessionsSummaryPanels({
  data,
  onOlderPatients,
}: {
  data: OpsSessionsSummary;
  /** Отобрать в списке сессии пациентов старше 30 дней */
  onOlderPatients: () => void;
}) {
  const { ut } = useLang();
  const olderPatients = data.byAge.find((g) => g.group === "patients")?.buckets.find((b) => b.key === "older")?.count ?? null;
  return (
    <div className="grid grid-cols-2 gap-4 max-[980px]:grid-cols-1">
      <Panel title={ut("oppa.whoTitle")} sub={ut("oppa.whoSub")} icon={<Ix.monitorSmartphone />}>
        <HBars
          floor={data.smallCellFloor}
          items={data.byRole.map((r) => ({ key: r.role, label: ut(ROLE_PLURAL[r.role]), value: r.sessions }))}
        />
      </Panel>
      <Panel title={ut("opsp.sess.byAge")} sub={ut("oppa.ageSub")} icon={<Ix.hourglass />}>
        {data.byAge.map((g, i) => {
          const parts = AGES.map((a) => ({
            key: a.key,
            label: ut(a.label),
            value: g.buckets.find((b) => b.key === a.key)?.count ?? null,
            color: a.color,
          }));
          return (
            <div key={g.group} className={cx("py-2.5", i ? "border-t border-divider" : "pt-0")}>
              <div className="flex items-baseline justify-between gap-3 text-small">
                <span className="font-semibold text-text-2">{ut(GROUP[g.group])}</span>
                <b className="font-extrabold tabular-nums text-text">{g.total ?? "—"}</b>
              </div>
              <ShareBar parts={parts} legend={false} label={ut(GROUP[g.group])} className="mt-1.5" />
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
                {parts.map((p) => (
                  <span key={p.key} className="inline-flex items-center gap-1 tabular-nums">
                    <i aria-hidden className="size-2 rounded-[2px]" style={{ background: p.color }} />
                    <span className="sr-only">{p.label}</span>
                    {p.value ?? "—"}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
        <SeriesLegend className="mt-2" items={AGES.map((a) => ({ key: a.key, label: ut(a.label), color: a.color }))} />
        {olderPatients ? (
          <Callout
            kind="warn"
            className="mt-3"
            icon={<Ix.hourglass />}
            title={fill(ut("oppa.olderTitle"), { n: olderPatients })}
            actions={
              <Button size="xs" icon={<Ix.filter />} onClick={onOlderPatients}>
                {ut("oppa.pick")}
              </Button>
            }
          >
            {ut("oppa.olderText")}
          </Callout>
        ) : null}
      </Panel>
    </div>
  );
}

export function SessionsSummary({
  data,
  error,
  onRetry,
  onOlderPatients,
}: {
  data: OpsSessionsSummary | null;
  error: string | null;
  onRetry: () => void;
  onOlderPatients: () => void;
}) {
  if (error) return <Loading error={error} onRetry={onRetry} />;
  if (!data) return <Loading rows={4} />;
  return <SessionsSummaryPanels data={data} onOlderPatients={onOlderPatients} />;
}
