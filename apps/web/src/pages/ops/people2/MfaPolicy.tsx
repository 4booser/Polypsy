import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { MfaCoverageRow, MfaPolicyView, UiKey } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { useLang } from "../../../lang";
import { Avatar, Callout, DataTable, Loading, Modal, useAction, useToast } from "../../../ui";
import { cx } from "../../../ui/cx";
import type { Column } from "../../../ui/DataTable";
import { ViewPills } from "../../../ui/filters";
import { Ic } from "../../../ui/icons";
import { IconTile, Panel } from "../../../ui/layout";
import { Button, ButtonLink, Switch, Tag, buttonClass } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { personHref } from "../model";
import { SectionPage } from "./frame";
import { Ix } from "./icons";
import { RolePill } from "../users/parts";
import { CodeChip, FootNote, Meter, Rich, Sx } from "./securityParts";
import {
  MFA_VIEWS,
  coverageGroups,
  fill,
  mfaViewRows,
  missingRequired,
  requiredBy,
  seenBeforePolicy,
  shortDay,
  stamp,
  type CoverageGroup,
  type MfaView,
} from "./securityModel";

/*
 * Техпанель → «Другий фактор» (people2, пункт 17) в «Виразній».
 *
 * Политика «обов’язково для …», кто упрётся в настройку завтра утром, доля с
 * фактором, как выглядит экран-барьер и список тех, кому фактор нужен, со
 * сбросом.
 *
 * Менять политику — ops.manage: требование меняет работу системы для всех
 * (как режим обслуживания). Покрытие стоит рядом с переключателями намеренно:
 * включают требование, глядя на то, сколько людей упрётся в настройку, — и
 * экран называет это число до сохранения.
 *
 * Правила сброса — сервера и прежние: чужой фактор сбрасывает только
 * суперадмин, свой так не сбрасывают (для этого — выключение паролем и
 * кодом в «Обліковому записі»); здесь кнопка стоит только там, где сброс
 * возможен, а у своей строки — «це ви».
 */

type Policy = { superadmins: boolean; ops: boolean };

export default function OpsMfaPolicy() {
  const { ut } = useLang();
  const { user } = useAuth();
  const toast = useToast();
  const isSuper = user?.role === "superadmin";
  /* источник черновика: сам не перечитывается — правку не затрёт (useResource, manual) */
  const res = useResource(() => api.mfaPolicy(), [], { manual: true });
  const { run, busy } = useAction();
  const [draft, setDraft] = useState<Policy | null>(null);
  const [resetting, setResetting] = useState<MfaCoverageRow | null>(null);
  const [view, setView] = useState<MfaView>("all");
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (res.data) setDraft({ superadmins: res.data.policy.superadmins, ops: res.data.policy.ops });
  }, [res.data]);

  const data = res.data;
  const missing = data ? missingRequired(data.coverage, data.policy) : [];
  const active = !!data && (data.policy.superadmins || data.policy.ops);

  const meta = data
    ? ([
        missing.length
          ? fill(ut("opps.mfa.metaMissing"), { n: missing.length })
          : active
            ? ut("opps.mfa.metaAll")
            : ut("opps.mfa.metaOff"),
        missing.length || active
          ? ut(missing.length ? "opps.mfa.metaMissingSub" : "opps.mfa.metaAllSub")
          : fill(ut("opps.mfa.metaOffSub"), {
              on: data.coverage.filter((r) => r.enabled && !r.disabled).length,
              total: data.coverage.filter((r) => !r.disabled).length,
            }),
      ] as [string, string])
    : undefined;

  const copyEmails = async () => {
    const list = missing.map((r) => r.email).join(", ");
    try {
      await navigator.clipboard.writeText(list);
      toast(fill(ut("opps.mfa.copied"), { n: missing.length }), "ok");
    } catch {
      toast(ut("opps.mfa.copyFailed"), "err");
    }
  };

  return (
    <SectionPage
      title={ut("ops.tab.mfa")}
      perm="ops.manage"
      meta={meta}
      lead={ut("opps.mfa.lead")}
      actions={
        <ButtonLink to="/account" className="gap-2">
          <Sx.circleUser />
          {ut("opps.mfa.mine")}
        </ButtonLink>
      }
    >
      {res.error && !data ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !data || !draft ? (
        <Loading rows={6} />
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          {missing.length ? (
            <Callout
              kind="warn"
              icon={<Ix.shieldAlert />}
              title={fill(ut("opps.mfa.missingTitle"), { n: missing.length })}
              actions={
                <>
                  <Button size="xs" variant="paper" icon={<Ix.copy />} onClick={() => void copyEmails()}>
                    {ut("opps.mfa.copyEmails")}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setView("missing");
                      tableRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
                    }}
                  >
                    {ut("opps.mfa.showInList")}
                  </Button>
                </>
              }
            >
              {fill(ut("opps.mfa.missingText"), { names: missing.map((r) => r.fullName || r.email).join(", ") })}
            </Callout>
          ) : null}

          <div className="grid items-start gap-4 grid-cols-[minmax(0,1fr)_400px] max-[1360px]:grid-cols-[minmax(0,1fr)_340px] max-[1100px]:grid-cols-1">
            <PolicyPanel
              data={data}
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              meId={user?.id}
              onSave={() =>
                void run(async () => {
                  await api.saveMfaPolicy(draft);
                  res.reload();
                }, ut("ops.mfa.saved"))
              }
            />
            <div className="flex min-w-0 flex-col gap-4">
              <CoveragePanel data={data} />
              <GatePanel />
            </div>
          </div>

          <div ref={tableRef} className="scroll-mt-4">
            <CoverageTable data={data} view={view} setView={setView} isSuper={isSuper} meId={user?.id} onReset={setResetting} />
          </div>
        </div>
      )}

      {resetting ? (
        <ResetModal
          row={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            setResetting(null);
            res.reload();
          }}
        />
      ) : null}
    </SectionPage>
  );
}

/** Доля группы пилюлей рядом с переключателем: полностью — зелёным, обязательно и неполно — янтарём */
function GroupPill({ g }: { g: CoverageGroup | undefined }) {
  const { ut } = useLang();
  if (!g) return null;
  const text = fill(ut("opps.mfa.ofTotal"), { on: g.on, total: g.total });
  if (g.tone === "good")
    return (
      <Tag tone="good" icon={<Ic.check />}>
        {text}
      </Tag>
    );
  if (g.tone === "warn")
    return (
      <Tag tone="attention" icon={<Ix.shieldAlert />}>
        {text}
      </Tag>
    );
  return <Tag>{text}</Tag>;
}

function OptionBox({
  checked,
  onChange,
  title,
  text,
  pill,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: ReactNode;
  text: ReactNode;
  pill: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-panel bg-sunk px-3.5 py-3">
      <Switch
        checked={checked}
        onChange={onChange}
        className="min-w-0 flex-1"
        label={<b className="text-body font-extrabold leading-[19px] text-text">{title}</b>}
        sub={<span className="mt-0.5 block text-small font-medium leading-[18px] text-text-2">{text}</span>}
      />
      {pill}
    </div>
  );
}

function PolicyPanel({
  data,
  draft,
  setDraft,
  busy,
  meId,
  onSave,
}: {
  data: MfaPolicyView;
  draft: Policy;
  setDraft: (p: Policy) => void;
  busy: boolean;
  meId?: string;
  onSave: () => void;
}) {
  const { ut, lang } = useLang();
  const { policy, coverage } = data;
  const changed = draft.superadmins !== policy.superadmins || draft.ops !== policy.ops;
  const groups = coverageGroups(coverage, undefined, draft);
  const wouldStop = missingRequired(coverage, draft);
  const stopsNew = wouldStop.filter((r) => !missingRequired([r], policy).length).length;
  const meStopped = wouldStop.some((r) => r.id === meId);

  const status = !changed
    ? ut("opps.mfa.noChanges")
    : wouldStop.length
      ? fill(ut("opps.mfa.willStop"), { n: wouldStop.length })
      : ut("opps.mfa.unsaved");

  return (
    <Panel
      title={ut("ops.mfa.policy")}
      icon={<Ic.shieldCheck />}
      sub={
        policy.updatedAt
          ? fill(ut("opps.mfa.changedAt"), { at: stamp(policy.updatedAt, lang), who: policy.updatedByEmail ?? ut("opps.mfa.system") })
          : undefined
      }
      footer={
        <>
          <span role="status" className={changed && stopsNew ? "text-small font-semibold text-warn" : "text-small text-muted"}>
            {status}
            {changed && meStopped ? ` ${ut("opps.mfa.youToo")}` : ""}
          </span>
          <span className="ml-auto flex gap-2">
            <Button variant="quiet" size="sm" disabled={!changed || busy} onClick={() => setDraft({ superadmins: policy.superadmins, ops: policy.ops })}>
              {ut("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" disabled={!changed || busy} onClick={onSave}>
              {ut("common.save")}
            </Button>
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <OptionBox
          checked={draft.superadmins}
          onChange={(v) => setDraft({ ...draft, superadmins: v })}
          title={ut("ops.mfa.forSuper")}
          text={ut("opps.mfa.forSuperText")}
          pill={<GroupPill g={groups.find((g) => g.key === "superadmin")} />}
        />
        <OptionBox
          checked={draft.ops}
          onChange={(v) => setDraft({ ...draft, ops: v })}
          title={<Rich text={ut("opps.mfa.forOps")} values={{ read: <CodeChip>ops.read</CodeChip>, manage: <CodeChip>ops.manage</CodeChip> }} />}
          text={ut("opps.mfa.forOpsText")}
          pill={<GroupPill g={groups.find((g) => g.key === "ops")} />}
        />
      </div>
      <Callout kind="info" className="mt-3">
        {ut("opps.mfa.softGate")}
      </Callout>
    </Panel>
  );
}

/** «Частка з другим фактором»: суперадміни, держатели ops.* и весь персонал для справки */
function CoveragePanel({ data }: { data: MfaPolicyView }) {
  const { ut } = useLang();
  const groups = coverageGroups(data.coverage, data.staff, data.policy);
  const name: Record<CoverageGroup["key"], UiKey> = {
    superadmin: "opps.mfa.groupSuper",
    ops: "opps.mfa.groupOps",
    staff: "opps.mfa.groupStaff",
  };
  return (
    <Panel title={ut("opsp.mfa.coverage")} icon={<Sx.chartBar />}>
      {groups.length ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {groups.map((g) => (
            <li key={g.key} className="border-t border-divider py-3 first:border-t-0 first:pt-0">
              <div className="flex items-baseline justify-between gap-3 text-small">
                <span className="font-semibold text-text-2">{ut(name[g.key])}</span>
                <span className="whitespace-nowrap">
                  <b className="text-[15px] font-extrabold tabular-nums text-text">{g.on}</b>{" "}
                  <span className="text-muted">{fill(ut("opps.mfa.of"), { total: g.total })}</span>
                </span>
              </div>
              <Meter
                className="mt-1.5"
                pct={g.total ? (g.on / g.total) * 100 : 0}
                tone={g.tone === "good" ? "good" : g.tone === "warn" ? "warn" : "plain"}
                label={`${ut(name[g.key])}: ${fill(ut("opps.mfa.ofTotal"), { on: g.on, total: g.total })}`}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-small text-muted">{ut("ops.mfa.nobody")}</p>
      )}
      <p className="m-0 mt-3 text-caption text-muted">{ut("opps.mfa.liveOnly")}</p>
    </Panel>
  );
}

/** Шаги экрана-барьера — те же и в том же порядке, что у MfaSetupGate */
const GATE_STEPS: readonly UiKey[] = ["ax.mg.s1", "ax.mg.s2", "acct.mfa.codesTitle"];

/**
 * «Що бачить людина без фактора»: экран-барьер в уменьшенном виде — тот же,
 * что настоящий (SecondFactor.tsx, MfaSetupGate), теми же словами: заголовок
 * с пометкой «обов’язковий крок», пояснение и три шага — QR-код или ключ,
 * проверка кодом, коды восстановления. Открыт первый шаг, его кнопка
 * показывает ключ; выйти можно всегда. Не нажимается — это показ.
 */
export function GatePanel() {
  const { ut } = useLang();
  return (
    <Panel title={ut("opps.mfa.gateTitle")} icon={<Ic.eye />}>
      <p className="m-0 mb-2.5 text-caption text-muted">{ut("opps.mfa.gateSub")}</p>
      <div inert aria-hidden className="rounded-panel bg-ground p-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
        <div className="rounded-[12px] border border-border bg-panel p-4 shadow-panel">
          <div className="flex items-center gap-2.5">
            <IconTile icon={<Ic.shieldCheck />} />
            <span className="flex min-w-0 flex-col">
              <b className="text-h3 font-extrabold leading-[19px] text-text">{ut("mfa.gate.title")}</b>
              <span className="text-caption text-text-2">
                <b className="font-bold text-text">{ut("ax.mg.required")}</b>, {ut("ax.mg.policy")}
              </span>
            </span>
          </div>
          <p className="m-0 mt-2 text-small text-text-2">{ut("mfa.gate.sub")}</p>
          <ol className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
            {GATE_STEPS.map((key, i) => (
              <li
                key={key}
                className={cx("flex min-w-0 items-center gap-2.5 rounded-control px-2.5 py-[7px]", i === 0 ? "bg-violet-tint" : "bg-sunk")}
              >
                <span
                  className={cx(
                    "inline-grid size-[22px] shrink-0 place-items-center rounded-full text-[11px] font-extrabold tabular-nums",
                    i === 0 ? "bg-violet text-onfill" : "bg-panel text-muted",
                  )}
                >
                  {i + 1}
                </span>
                <span className={cx("min-w-0 truncate text-small font-bold", i === 0 ? "text-violet-ink" : "text-text-2")}>{ut(key)}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex gap-2">
            <span className={buttonClass("primary", "xs")}>{ut("ax.mg.start")}</span>
            <span className={buttonClass("quiet", "xs")}>{ut("nav.logout")}</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function CoverageTable({
  data,
  view,
  setView,
  isSuper,
  meId,
  onReset,
}: {
  data: MfaPolicyView;
  view: MfaView;
  setView: (v: MfaView) => void;
  isSuper: boolean;
  meId?: string;
  onReset: (r: MfaCoverageRow) => void;
}) {
  const { ut, lang } = useLang();
  const { coverage, policy } = data;
  const rows = mfaViewRows(coverage, view);
  const viewLabel: Record<MfaView, UiKey> = {
    all: "ops.susp.all",
    missing: "ops.mfa.missing",
    superadmin: "opps.mfa.groupSuper",
    ops: "opps.mfa.viewOps",
  };
  const columns: Column<MfaCoverageRow>[] = [
    {
      key: "account",
      header: ut("ops.users.account"),
      required: true,
      width: 260,
      sort: (r) => r.fullName || r.email,
      /*
        Имя переносится, а не обрезается: обрезка держит колонку по всей длине
        имени, и на 1280 таблица выходила за панель вместе с «Скинути».
      */
      render: (r) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={r.fullName || r.email} size={28} tone={r.disabled ? "neutral" : "soft"} />
          <span className="flex min-w-0 flex-col">
            <Link
              to={personHref(r)}
              className="font-bold leading-[18px] text-text no-underline [overflow-wrap:anywhere] hover:underline hover:decoration-violet-line hover:decoration-2 hover:underline-offset-[3px]"
            >
              {r.fullName || r.email}
            </Link>
            <small className="truncate text-caption text-muted">{r.email}</small>
          </span>
        </span>
      ),
    },
    { key: "role", header: ut("adm.role"), required: true, width: 190, sort: (r) => r.role, render: (r) => <RolePill role={r.role} /> },
    {
      key: "because",
      header: ut("opps.mfa.because"),
      required: true,
      width: 190,
      render: (r) =>
        r.because === "superadmin" ? (
          <span className="text-text-2">{ut("ops.mfa.because.superadmin")}</span>
        ) : (
          <span className="flex flex-wrap items-center gap-1 text-text-2">
            <Rich text={ut("opps.mfa.hasOps")} values={{ read: <CodeChip>ops.read</CodeChip>, manage: <CodeChip>ops.manage</CodeChip> }} />
          </span>
        ),
    },
    {
      key: "state",
      header: ut("ops.users.state"),
      required: true,
      width: 230,
      sort: (r) => (r.disabled ? 2 : r.enabled ? 1 : 0),
      render: (r) => {
        if (r.disabled)
          return (
            <Tag tone="done" icon={<Ic.ban />}>
              {ut("opps.mfa.disabledAccount")}
            </Tag>
          );
        if (r.enabled)
          return (
            <span className="flex flex-col">
              <span className="inline-flex items-center gap-1.5 font-semibold text-text">
                <Ic.shieldCheck size={15} className="text-good" />
                {ut("ops.mfa.enabled")}
              </span>
              {r.confirmedAt ? <small className="text-caption tabular-nums text-muted">{fill(ut("opps.mfa.since"), { at: shortDay(r.confirmedAt, lang) })}</small> : null}
            </span>
          );
        const required = requiredBy(r, policy);
        const note = !required
          ? ut("opps.mfa.notRequired")
          : seenBeforePolicy(r.lastSeenAt, policy.updatedAt)
            ? ut("opps.mfa.seenBefore")
            : ut("opps.mfa.willStopOne");
        return (
          <span className="flex flex-col items-start gap-0.5">
            <Tag tone={required ? "attention" : "plain"} icon={<Ix.shieldAlert />}>
              {ut("ops.mfa.missing")}
            </Tag>
            <small className="text-caption text-muted">{note}</small>
          </span>
        );
      },
    },
    {
      key: "last",
      header: ut("opps.mfa.lastLogin"),
      required: true,
      width: 130,
      sort: (r) => r.lastSeenAt ?? null,
      render: (r) => <span className="whitespace-nowrap tabular-nums text-text-2">{r.lastSeenAt ? stamp(r.lastSeenAt, lang) : ut("opps.mfa.neverIn")}</span>,
    },
    {
      key: "act",
      header: "",
      required: true,
      render: (r) =>
        r.id === meId ? (
          <span className="block text-right text-caption text-muted">{ut("opps.mfa.itsYou")}</span>
        ) : isSuper && r.enabled && !r.disabled ? (
          <span className="flex justify-end">
            <Button variant="quiet" size="xs" icon={<Ix.rotateCcw />} onClick={() => onReset(r)}>
              {ut("opps.mfa.reset")}
            </Button>
          </span>
        ) : null,
    },
  ];
  return (
    <Panel
      title={ut("ops.mfa.coverage")}
      icon={<Ic.users />}
      count={coverage.length}
      flush
      actions={
        <ViewPills
          label={ut("opps.mfa.viewsLabel")}
          value={view}
          onChange={(k) => setView(k as MfaView)}
          items={MFA_VIEWS.map((v) => ({ key: v, label: ut(viewLabel[v]), count: mfaViewRows(coverage, v).length }))}
        />
      }
      footer={<FootNote>{ut("opps.mfa.resetNote")}</FootNote>}
    >
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        label={ut("ops.mfa.coverage")}
        sticky={false}
        empty={<p className="m-0 border-t border-divider px-4 py-3.5 text-small text-muted">{coverage.length ? ut("opps.mfa.noneInView") : ut("ops.mfa.nobody")}</p>}
      />
    </Panel>
  );
}

/** Сбросить чужой фактор — окном: необратимо, коды восстановления тоже уходят */
function ResetModal({ row, onClose, onDone }: { row: MfaCoverageRow; onClose: () => void; onDone: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const name = row.fullName || row.email;
  return (
    <Modal
      title={ut("ops.mfa.reset")}
      sub={`${name}, ${ut(row.because === "superadmin" ? "ops.mfa.because.superadmin" : "ops.mfa.because.ops")}`}
      icon={<Sx.smartphoneNfc />}
      tone="warn"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            icon={<Ix.rotateCcw />}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.resetUserMfa(row.id);
                onDone();
              }, ut("ops.mfa.resetDone"))
            }
          >
            {ut("opps.mfa.resetAction")}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <p className="m-0 pt-3.5 text-body text-text-2 [overflow-wrap:anywhere]">
        {row.email}: {ut("ops.mfa.resetWarn")}
      </p>
    </Modal>
  );
}
