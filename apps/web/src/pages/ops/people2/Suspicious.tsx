import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { SuspiciousFinding, SuspiciousPage, UiKey } from "@quizzy/shared";
import { api } from "../../../api";
import { useAuth } from "../../../auth";
import { StackColumns } from "../../../charts/clinical";
import { useLang } from "../../../lang";
import { Callout, Drawer, DrawerSection, Empty, Loading, Modal, useAction, useToast } from "../../../ui";
import { FilterBar } from "../../../ui/filters";
import { Ic } from "../../../ui/icons";
import { useHotkeys } from "../../../ui/keys";
import { Panel } from "../../../ui/layout";
import { Tooltip } from "../../../ui/Popover";
import { Button, ButtonLink, Field, Segmented, Tag, Textarea } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { ChoiceChip } from "../users/parts";
import { SectionPage } from "./frame";
import { Ix } from "./icons";
import { RULES, journalLink, ruleBars, ruleExplanation, ruleKey } from "./model";
import { FactChip, RULE_ICON, Sx } from "./securityParts";
import {
  clock,
  fill,
  findingChips,
  findingCounts,
  findingMatches,
  findingText,
  findingWho,
  findingsInWindow,
  pluralForm,
  shortDay,
  stamp,
} from "./securityModel";

/*
 * Техпанель → «Підозріла активність» (people2, пункт 18) в «Виразній».
 *
 * Правила над журналом доступа (lib/suspicious.ts на сервере, проверка раз в
 * пять минут) отмечают то, что стоит разобрать человеку. Нерозібране стоит
 * сверху карточками с действиями: разобрать (в ящике, с пояснением словами —
 * через год разбирают по журналу, и «ок» там не отвечает ни на что), открыть
 * строки журнала, открыть учётку, завершить сессии человека. Ниже —
 * розібрані с тем, кто и что выяснил. Справа — сколько и каких срабатываний
 * и как работают правила, числами порогов с сервера.
 *
 * Отбор — в адресе (?status=, ?rule=): «нерозібрані масові перегляди»
 * пересылают коллеге ссылкой. Список приходит одним ответом (status=all) —
 * одна строка журнала на одно открытие раздела, — а «нерозібрані / розібрані»
 * делит экран.
 *
 * Пороги правил задаёт сервер (THRESHOLDS): правки их с экрана нет, поэтому
 * и кнопки «Пороги» нет — экран говорит, откуда числа.
 */

type Status = "open" | "resolved" | "all";
const STATUSES: readonly Status[] = ["open", "resolved", "all"];
/** Сколько срабатываний брать одним ответом: нерозібраних столько не бывает, а разобранных хватает на месяц с запасом */
const LIMIT = 500;

export default function OpsSuspicious() {
  const { ut, lang } = useLang();
  const { can } = useAuth();
  const toast = useToast();
  const { run, busy } = useAction();
  const [params, setParams] = useSearchParams();
  const raw = params.get("status");
  const status: Status = STATUSES.includes(raw as Status) ? (raw as Status) : "all";
  const rule = params.get("rule") ?? "";
  const [q, setQ] = useState("");

  /* ящик разбора: черновик пояснения — свой у каждого срабатывания */
  const [target, setTarget] = useState<SuspiciousFinding | null>(null);
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [ending, setEnding] = useState<SuspiciousFinding | null>(null);

  const update = useCallback(
    (patch: Record<string, string | null>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  const res = useResource(() => api.suspicious({ status: "all", rule: rule || undefined, limit: String(LIMIT) }), [rule]);
  const data = res.data;

  const shown = useMemo(() => (data ? data.items.filter((f) => findingMatches(f, q)) : []), [data, q]);
  const openItems = shown.filter((f) => !f.resolvedAt);
  const doneItems = shown.filter((f) => f.resolvedAt);
  const canUsers = can("users.manage");

  const startResolve = (f: SuspiciousFinding) => {
    setTarget(f);
    setOpen(true);
  };
  /* R — разобрать первое нерозібране; не под окном «завершити сесії»: ящик открылся бы под ним */
  useHotkeys(
    { r: () => (openItems[0] && !open ? startResolve(openItems[0]) : undefined) },
    !!openItems.length && status !== "resolved" && !ending,
  );

  const scan = () =>
    void run(async () => {
      await api.scanSuspicious();
      res.reload();
    }, ut("ops.susp.scanned"));

  const comment = target ? (drafts[target.id] ?? "") : "";
  const ready = comment.trim().length >= 3;
  const resolve = () =>
    void run(async () => {
      if (!target || !ready) return false;
      await api.resolveFinding(target.id, comment.trim());
      const done = target.id;
      setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => id !== done)));
      setOpen(false);
      res.reload();
    }, ut("ops.susp.resolvedDone"));

  const counts = data ? findingCounts(data) : null;
  const meta = data
    ? ([
        counts!.open
          ? fill(ut(`opps.susp.metaOpen.${pluralForm(counts!.open, lang)}` as UiKey), { n: counts!.open })
          : ut("opps.susp.metaNone"),
        fill(ut("opps.susp.metaWindow"), {
          findings: fill(ut(`opps.n.finding.${pluralForm(findingsInWindow(data.stats.byDay), lang)}` as UiKey), {
            n: findingsInWindow(data.stats.byDay),
          }),
          days: data.stats.days,
        }),
      ] as [string, string])
    : undefined;

  const lastScan = data ? (
    <Tooltip label={ut("opps.susp.scanEvery")}>
      <span tabIndex={0} className="whitespace-nowrap rounded-[4px] text-small text-muted outline-none focus-visible:ring-2 focus-visible:ring-violet-ring">
        {data.lastScanAt
          ? fill(ut("opps.susp.lastScan"), {
              at: shortDay(data.lastScanAt, lang) === shortDay(new Date().toISOString(), lang) ? clock(data.lastScanAt, lang) : stamp(data.lastScanAt, lang),
            })
          : ut("opps.susp.noScan")}
      </span>
    </Tooltip>
  ) : null;

  return (
    <SectionPage
      title={ut("ops.tab.suspicious")}
      perm="audit.read"
      meta={meta}
      lead={ut("opps.susp.lead")}
      actions={
        <>
          {lastScan}
          <Button variant="primary" icon={<Sx.radar />} disabled={busy} onClick={scan}>
            {ut("ops.susp.scan")}
          </Button>
        </>
      }
    >
      {res.error && !data ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !data || !counts ? (
        <Loading rows={6} />
      ) : (
        <div className="grid items-start gap-4 grid-cols-[minmax(0,1fr)_360px] max-[1360px]:grid-cols-[minmax(0,1fr)_320px] max-[1100px]:grid-cols-1">
          <div className="flex min-w-0 flex-col gap-4">
            <FilterBar
              search={{ value: q, onChange: setQ, placeholder: ut("opps.susp.search"), width: 240 }}
              chips={
                <>
                  <Segmented
                    label={ut("opps.susp.statusLabel")}
                    value={status}
                    onChange={(v) => update({ status: v === "all" ? null : v })}
                    items={[
                      { key: "open", label: <CountLabel text={ut("ops.susp.open")} n={counts.open} /> },
                      { key: "resolved", label: <CountLabel text={ut("ops.susp.resolvedMany")} n={counts.resolved} /> },
                      { key: "all", label: <CountLabel text={ut("ops.susp.all")} n={counts.total} /> },
                    ]}
                  />
                  <RuleFilter value={rule} onChange={(v) => update({ rule: v || null })} />
                </>
              }
            />
            {data.items.length >= LIMIT && openItems.length < counts.open ? (
              <Callout kind="warn">{fill(ut("opps.susp.truncated"), { shown: data.items.length, total: counts.total })}</Callout>
            ) : null}

            {status !== "resolved" ? (
              openItems.length ? (
                openItems.map((f, i) => (
                  <OpenFinding
                    key={f.id}
                    f={f}
                    data={data}
                    first={i === 0}
                    active={open && target?.id === f.id}
                    canUsers={canUsers}
                    onResolve={() => startResolve(f)}
                    onEnd={() => setEnding(f)}
                  />
                ))
              ) : (
                <Panel>
                  <Empty
                    compact
                    title={counts.open || q ? ut("ops.susp.none") : ut("opps.susp.noneOpen")}
                    hint={counts.open || q ? undefined : ut("opps.susp.noneOpenHint")}
                  />
                </Panel>
              )
            ) : null}

            {status !== "open" ? (
              <Panel
                title={ut("ops.susp.resolvedMany")}
                icon={<Ic.checkCheck />}
                count={doneItems.length}
                sub={ut("opps.susp.resolvedSub")}
                flush
              >
                {doneItems.length ? (
                  <ul className="m-0 list-none p-0">
                    {doneItems.map((f) => (
                      <ResolvedFinding key={f.id} f={f} data={data} />
                    ))}
                  </ul>
                ) : (
                  <div className="px-4 pb-2">
                    <Empty compact title={ut("opps.susp.noneResolved")} />
                  </div>
                )}
              </Panel>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <FindingsChart data={data} />
            <RulesPanel data={data} />
          </div>
        </div>
      )}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        onReturn={() => setOpen(true)}
        title={ut("opps.susp.resolveTip")}
        sub={target ? [ut(ruleKey(target.rule)), findingWho(target), stamp(target.detectedAt, lang)].filter(Boolean).join(", ") : undefined}
        icon={<Ic.checkCheck />}
        tone="warn"
        kbd="R"
        dirty={comment.trim().length > 0}
        draftName={ut("opps.susp.draftName")}
        note={ut("opps.susp.drawerNote")}
        noteIcon={<Ix.fileSearch />}
        footer={
          <>
            <Button variant="primary" icon={<Ic.checkCheck />} disabled={busy || !ready} onClick={resolve}>
              {ut("ops.susp.resolve")}
            </Button>
            <Button variant="quiet" onClick={() => setOpen(false)}>
              {ut("common.cancel")}
            </Button>
          </>
        }
      >
        {target && data ? (
          <>
            <DrawerSection title={ut("opps.susp.whatHappened")}>
              <FindingBody f={target} data={data} />
              <p className="m-0 mt-3 text-small text-muted">{ruleExplanation(target.rule, data.thresholds, ut)}</p>
            </DrawerSection>
            <DrawerSection title={ut("opps.susp.explain")} sub={ut("opps.susp.explainSub")}>
              <Field label={ut("opps.susp.explain")} inline>
                <Textarea
                  data-autofocus
                  rows={5}
                  maxLength={1000}
                  value={comment}
                  placeholder={ut("opps.susp.explainPh")}
                  onChange={(e) => setDrafts((d) => ({ ...d, [target.id]: e.target.value }))}
                />
              </Field>
            </DrawerSection>
          </>
        ) : null}
      </Drawer>

      {ending ? (
        <EndSessions
          f={ending}
          onClose={() => setEnding(null)}
          onDone={(n) => {
            setEnding(null);
            toast(fill(ut("opps.susp.endDone"), { n }), "ok");
          }}
        />
      ) : null}
    </SectionPage>
  );
}

function CountLabel({ text, n }: { text: string; n: number }) {
  return (
    <>
      {text} <span className="font-extrabold tabular-nums">{n}</span>
    </>
  );
}

/**
 * «Правило ⌄» — отбор одним правилом; выбранное снимается крестиком. Чип
 * стоит у левого края области: меню раскрывается вправо, а не влево под
 * колонку подразделов, где область прокрутки обрезала названия правил.
 */
function RuleFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { ut } = useLang();
  return (
    <ChoiceChip
      label={ut("ops.susp.rule")}
      value={RULES.some((r) => r === value) ? value : ""}
      onChange={onChange}
      align="right-out"
      plateClassName="min-w-[300px]"
      choices={[{ value: "", label: ut("ops.susp.allRules") }, ...RULES.map((r) => ({ value: r, label: ut(ruleKey(r)) }))]}
    />
  );
}

/** Кто и что — фразой, под ней пилюли фактов: окно, счёт, порог, клиент, адрес */
function FindingBody({ f, data }: { f: SuspiciousFinding; data: SuspiciousPage }) {
  const { ut, lang } = useLang();
  const who = findingWho(f);
  return (
    <>
      <p className="m-0 text-body leading-[20px] text-text [overflow-wrap:anywhere]">
        {who ? <b className={f.rule === "failedLoginsIp" ? "font-mono text-[13px] font-bold" : "font-extrabold"}>{who}</b> : null}
        {who ? " — " : null}
        {findingText(f, data.thresholds, ut, lang)}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {findingChips(f, data.thresholds, ut, lang).map((c) => (
          <FactChip
            key={c.key}
            tone={c.tone}
            mono={c.mono}
            icon={c.icon === "clock" ? <Ix.clock /> : c.icon === "monitor" ? <Ix.monitor /> : undefined}
          >
            {c.text}
          </FactChip>
        ))}
      </div>
    </>
  );
}

function OpenFinding({
  f,
  data,
  first,
  active,
  canUsers,
  onResolve,
  onEnd,
}: {
  f: SuspiciousFinding;
  data: SuspiciousPage;
  first: boolean;
  active: boolean;
  canUsers: boolean;
  onResolve: () => void;
  onEnd: () => void;
}) {
  const { ut, lang } = useLang();
  const RuleIcon = RULE_ICON[f.rule];
  const person = f.actorName || f.actorEmail || "";
  const endLabel = fill(ut("opps.susp.endSessions"), { name: person });
  return (
    <Panel
      title={ut(ruleKey(f.rule))}
      icon={<RuleIcon />}
      tone="warn"
      sub={fill(ut("opps.susp.detected"), { at: stamp(f.detectedAt, lang) })}
      actions={
        <>
          <Tag tone="attention" icon={<Sx.circleDot />}>
            {ut("ops.susp.new")}
          </Tag>
          {f.notified ? (
            <Tooltip label={ut("opps.susp.notifiedTip")}>
              <span tabIndex={0} className="inline-flex items-center gap-1 rounded-[4px] text-caption font-semibold text-muted outline-none focus-visible:ring-2 focus-visible:ring-violet-ring">
                <Ix.bellRing size={13} />
                {ut("opps.susp.notified")}
              </span>
            </Tooltip>
          ) : null}
        </>
      }
    >
      <FindingBody f={f} data={data} />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Tooltip label={ut("opps.susp.resolveTip")} kbd={first ? "R" : undefined}>
          <Button variant="primary" icon={<Ic.checkCheck />} aria-expanded={active} onClick={onResolve}>
            {ut("ops.susp.resolve")}
          </Button>
        </Tooltip>
        <ButtonLink to={journalLink(f)} className="gap-2">
          <Ix.fileSearch />
          {ut("ops.susp.inLog")}
        </ButtonLink>
        {canUsers && f.actorId ? (
          <ButtonLink to={`/ops/users?user=${f.actorId}`} className="gap-2">
            <Ix.userRound />
            {ut("opps.susp.account")}
          </ButtonLink>
        ) : null}
        {canUsers && f.actorId ? (
          <Tooltip label={endLabel}>
            <Button variant="quiet" size="icon" aria-label={endLabel} icon={<Ix.logOut />} onClick={onEnd} />
          </Tooltip>
        ) : null}
      </div>
    </Panel>
  );
}

/** Разобранное — строкой: правило, «розібрано», когда виявлено, фраза, пилюли и пояснение того, кто разбирал */
function ResolvedFinding({ f, data }: { f: SuspiciousFinding; data: SuspiciousPage }) {
  const { ut, lang } = useLang();
  const RuleIcon = RULE_ICON[f.rule];
  return (
    <li className="grid grid-cols-[36px_minmax(0,1fr)] gap-x-3 border-t border-divider px-4 pb-4 pt-3.5">
      <span aria-hidden className="grid size-9 place-items-center rounded-[11px] bg-sunk text-muted [&>svg]:size-[17px]">
        <RuleIcon />
      </span>
      <div className="min-w-0">
        <div className="flex min-h-6 flex-wrap items-center gap-2">
          <b className="text-[14px] font-extrabold leading-5 text-text">{ut(ruleKey(f.rule))}</b>
          <Tag tone="good" icon={<Ic.check />}>
            {ut("ops.susp.resolvedOne")}
          </Tag>
          <span className="ml-auto whitespace-nowrap text-caption text-muted">
            {fill(ut("opps.susp.detected"), { at: stamp(f.detectedAt, lang) })}
          </span>
        </div>
        <div className="mt-1">
          <FindingBody f={f} data={data} />
        </div>
        {f.resolution ? (
          <div className="mt-2.5 flex gap-2 rounded-control bg-sunk px-2.5 py-2 text-small text-text-2">
            <span className="mt-px inline-flex shrink-0 text-muted" aria-hidden>
              <Ix.messageText size={15} />
            </span>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              «{f.resolution}»{" "}
              <span className="text-muted">
                — {[f.resolvedByEmail, f.resolvedAt ? stamp(f.resolvedAt, lang) : null].filter(Boolean).join(", ")}
              </span>
            </span>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** «Спрацювання»: за дни окна — разобранные и нет, за всё время — по правилам */
function FindingsChart({ data }: { data: SuspiciousPage }) {
  const { ut, lang } = useLang();
  const { byDay, byRule, days } = data.stats;
  const series = [
    { key: "resolved", label: ut("opsp.series.resolved"), color: "var(--c1)" },
    { key: "open", label: ut("opsp.series.open"), color: "var(--warn)" },
  ];
  return (
    <Panel title={ut("opsp.susp.list")} icon={<Ix.chartColumn />}>
      <p className="m-0 mb-2 text-caption text-muted">{fill(ut("opps.susp.chartSub"), { days, n: findingsInWindow(byDay) })}</p>
      <StackColumns
        series={series}
        columns={byDay.map((d) => ({ key: d.date, label: shortDay(`${d.date}T12:00:00`, lang), values: [d.resolved, d.open] }))}
        height={170}
        label={ut("opsp.susp.byDay")}
        total={ut("opps.susp.total")}
      />
      <p className="m-0 mb-2 mt-4 text-caption font-bold text-muted">{ut("opps.susp.byRuleAll")}</p>
      {byRule.length ? <RuleRows bars={ruleBars(byRule, ut)} /> : <Empty compact title={ut("opps.susp.noRules")} />}
    </Panel>
  );
}

/** «Як працюють правила»: каждое — своими числами с сервера */
function RulesPanel({ data }: { data: SuspiciousPage }) {
  const { ut } = useLang();
  return (
    <Panel title={ut("ops.susp.rulesTitle")} icon={<Ix.listChecks />}>
      <ul className="m-0 flex list-none flex-col p-0">
        {RULES.map((r) => {
          const RuleIcon = RULE_ICON[r];
          return (
            <li key={r} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-2.5 border-t border-divider py-2 first:border-t-0 first:pt-0">
              <span aria-hidden className="grid size-7 place-items-center rounded-[9px] bg-sunk text-muted [&>svg]:size-[14px]">
                <RuleIcon />
              </span>
              <span className="min-w-0">
                <b className="block text-[13px] font-extrabold leading-[18px] text-text">{ut(ruleKey(r))}</b>
                <span className="block text-caption leading-4 text-muted">{ruleExplanation(r, data.thresholds, ut)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <Callout kind="info" className="mt-3">
        {ut("opps.susp.thresholdsNote")}
      </Callout>
    </Panel>
  );
}

/** Завершить все сесії человека — подтверждением: он выйдет на всех устройствах */
function EndSessions({ f, onClose, onDone }: { f: SuspiciousFinding; onClose: () => void; onDone: (n: number) => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const name = f.actorName || f.actorEmail || "";
  return (
    <Modal
      title={ut("opps.susp.endTitle")}
      sub={name}
      icon={<Ix.logOut />}
      tone="warn"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            icon={<Ix.logOut />}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await api.revokeUserSessions(f.actorId!);
                onDone(r.revokedTokens);
              })
            }
          >
            {ut("opps.susp.endAction")}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
        </>
      }
    >
      <p className="m-0 pt-3.5 text-body text-text-2">{fill(ut("opps.susp.endText"), { name })}</p>
    </Modal>
  );
}

/**
 * Срабатывания по правилам — строками в боковой колонке: имя правила целиком
 * (в узкой колонке на 1280 подпись полосы обрезалась бы до «Невдалі в…»),
 * под ним полоса; с нерозібраними — фиолетовым, остальные — «прочим».
 */
function RuleRows({ bars }: { bars: ReturnType<typeof ruleBars> }) {
  const top = Math.max(1, ...bars.map((b) => b.value ?? 0));
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {bars.map((b) => (
        <li key={b.key} className="min-w-0">
          <div className="flex items-baseline gap-3 text-small">
            <span className={b.strong ? "min-w-0 font-bold text-text" : "min-w-0 text-text-2"}>{b.label}</span>
            <span className="ml-auto shrink-0 font-bold tabular-nums text-text">{b.text ?? b.value}</span>
          </div>
          <div aria-hidden className="mt-1 h-1.5 overflow-hidden rounded-full bg-track">
            <i
              className={b.strong ? "block h-full rounded-full bg-violet" : "block h-full rounded-full bg-series-5"}
              style={{ width: `${Math.round(((b.value ?? 0) / top) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
