import { useState, type ReactNode } from "react";
import { CourseChart } from "../../charts/course";
import type { CourseEvent, CoursePoint } from "../../charts/courseModel";
import type { Rung } from "../../charts/ladder";
import { useLang } from "../../lang";
import { ShellIcon } from "../../shell/icons";
import {
  AlertChip,
  AlertStrip,
  Avatar,
  BigValue,
  BigValues,
  CourseDigits,
  DrawerPane,
  DrawerSection,
  Ic,
  ListTile,
  PersonCell,
  RiskTimer,
} from "../../ui";
import { cx } from "../../ui/cx";
import { IconTile, Panel } from "../../ui/layout";
import { Button, ChoiceCard, Tag } from "../../ui/primitives";
import { AccessIcon } from "./accessIcons";
import { rich } from "./authParts";

/*
 * Куски продукта для лендинга (access-landing): каждый собран из тех же
 * деталей набора, что и консоль, — плитка «Дія зараз», строки очереди, график
 * курса, большие значения, панель разбора сигнала, телефон пациента.
 *
 * Люди и числа здесь — вымышленный пример, и подпись под первым куском так и
 * говорит: «Дані вигадані, інтерфейс справжній». Куски-картинки неактивны
 * (inert): кнопки в них ничего не делают, и Tab по ним не ходит, — у каждого
 * есть подпись словами для диктора. Живой оставлен один график курса: его
 * подсказка на наведении — то, что он показывает.
 */

/** Кусок продукта как иллюстрация: неактивный, с подписью для диктора */
export function Shot({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <figure aria-label={label} className={cx("m-0 min-w-0", className)}>
      <div inert className="select-none">
        {children}
      </div>
    </figure>
  );
}

/** «Дія зараз»: пациент, сигнал с таймером, письмо без ответа и строка открытого */
export function HeroPatientCard() {
  const { ut } = useLang();
  return (
    <div className="rounded-[24px] bg-band-card p-2.5 text-text shadow-banner">
      <div className="rounded-[18px] border border-border bg-panel p-3">
        <div className="flex items-center gap-3 px-1 pb-2.5 pt-0.5">
          <Avatar name={ut("lp.s.p1")} size={44} />
          <div className="min-w-0">
            <h3 className="m-0 truncate text-patient font-extrabold text-text">{ut("lp.s.p1")}</h3>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-small text-text-2">
              <span className="inline-flex items-center gap-1">
                <Ic.user size={13} className="text-muted" />
                {ut("lp.s.p1facts")}
              </span>
              <span className="inline-flex items-center gap-1">
                <AccessIcon name="repeat" size={13} className="text-muted" />
                {ut("lp.s.p1course")}
              </span>
              <span className="inline-flex items-center gap-1">
                <Ic.calendar size={13} className="text-muted" />
                {ut("lp.s.p1next")}
              </span>
            </span>
          </div>
        </div>
        <div className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] bg-risk-tint p-3 max-[520px]:grid-cols-[40px_minmax(0,1fr)]">
          <IconTile icon={<Ic.alert />} tone="risk" size={40} className="!bg-risk !text-onfill" />
          <div className="min-w-0 text-small leading-[17px] text-text-2">
            <b className="block text-body font-extrabold text-risk-ink">{ut("lp.s.signal")}</b>
            {ut("lp.s.signalText")}
          </div>
          <div className="flex items-center gap-2.5 max-[520px]:col-span-2">
            <RiskTimer elapsed="2:48" of={ut("lp.s.of4h")} pct={70} />
            <Button variant="risk" size="xs">
              {ut("lp.s.review")}
            </Button>
          </div>
        </div>
        <div className="mt-2 grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] border border-divider p-3 max-[520px]:grid-cols-[40px_minmax(0,1fr)]">
          <IconTile icon={<AccessIcon name="message-circle" />} tone="info" size={40} />
          <div className="min-w-0 text-small leading-[17px] text-text-2">
            <b className="block text-body font-extrabold text-text">{ut("lp.s.msgTitle")}</b>
            {ut("lp.s.msg")}
          </div>
          <Button size="xs" icon={<AccessIcon name="calendar-check" />} className="max-[520px]:hidden">
            {ut("lp.s.reply")}
          </Button>
        </div>
        <AlertStrip className="mt-2.5">
          <AlertChip kind="warn" icon={<AccessIcon name="calendar-x" />} label={ut("lp.s.noShow")} />
          <AlertChip icon={<ShellIcon name="file-pen-line" />} label={ut("lp.s.draft")} locked />
          <AlertChip icon={<Ic.clipboard />} label={ut("lp.s.isi")} />
          <AlertChip kind="good" icon={<ShellIcon name="shield-check" />} label={ut("lp.s.consent")} />
        </AlertStrip>
      </div>
    </div>
  );
}

/** Фахівцям: строки очереди — почему человек здесь сейчас и что дальше */
export function RoleWorklist() {
  const { ut } = useLang();
  return (
    <Panel title={ut("lp.r1")} sub={ut("lp.r1sub")} icon={<ShellIcon name="stethoscope" />} flush className="flex h-full flex-col">
      <Shot label={ut("lp.r1")} className="pb-2 pt-1">
        <ListTile
          title={ut("lp.s.p1")}
          meta={ut("lp.s.age38")}
          reason={
            <Tag tone="danger" icon={<Ic.timer />}>
              {ut("lp.s.t1reason")}
            </Tag>
          }
          aside={<CourseDigits code="PHQ-9" values={[19, 16, 14]} better="down" />}
          next={ut("lp.s.t1next")}
          nextIcon={<Ic.alert />}
          when={ut("lp.s.t1when")}
        />
        <ListTile
          title={ut("lp.s.p2")}
          meta={ut("lp.s.age52")}
          unread
          reason={
            <Tag tone="info" icon={<AccessIcon name="message-circle" />}>
              {ut("lp.s.t2reason")}
            </Tag>
          }
          aside={<CourseDigits code="PHQ-9" values={[15, 13, 13]} better="down" />}
          next={ut("lp.s.t2next")}
          nextIcon={<Ic.reply />}
          when={ut("lp.s.t2when")}
        />
        <ListTile
          title={ut("lp.s.p3")}
          meta={ut("lp.s.age50")}
          unread
          reason={
            <Tag tone="primary" icon={<Ic.clipboard />}>
              {ut("lp.s.t3reason")}
            </Tag>
          }
          aside={<CourseDigits code="GAD-7" values={[12, 13, 15]} better="down" />}
          next={ut("lp.s.t3next")}
          nextIcon={<Ic.eye />}
          when={ut("lp.s.t3when")}
        />
      </Shot>
    </Panel>
  );
}

/** Завідувачам: навантаження команди — пацієнти, сигнали, прострочене */
export function RoleTeam() {
  const { ut } = useLang();
  const dash = <span className="text-muted">—</span>;
  const rows: [string, string, number, ReactNode, ReactNode][] = [
    [
      ut("lp.s.st1"),
      ut("lp.s.st1r"),
      34,
      <Tag key="s" tone="danger" icon={<Ic.timer />}>
        {ut("lp.s.no214")}
      </Tag>,
      <Tag key="o" tone="attention" icon={<AccessIcon name="clock" />}>
        {ut("lp.s.safety")}
      </Tag>,
    ],
    [
      ut("lp.s.st2"),
      ut("lp.s.st2r"),
      41,
      <Tag key="s" tone="handover" icon={<ShellIcon name="phone" />}>
        {ut("lp.s.no213")}
      </Tag>,
      dash,
    ],
    [ut("lp.s.st3"), ut("lp.s.st3r"), 27, dash, dash],
    [ut("lp.s.st4"), ut("lp.s.st4r"), 22, dash, dash],
    [ut("lp.s.st5"), ut("lp.s.st5r"), 12, dash, dash],
  ];
  return (
    <Panel
      title={ut("lp.r2")}
      sub={ut("lp.r2sub")}
      icon={<AccessIcon name="building-2" />}
      flush
      footer={<span className="text-small text-text-2">{ut("lp.s.teamFoot")}</span>}
      className="flex h-full flex-col [&>div:last-child]:mt-auto"
    >
      <Shot label={ut("lp.r2")}>
        <table className="w-full border-collapse text-body">
          <thead>
            <tr className="border-y border-divider bg-panel-2 text-left text-caption font-bold text-muted">
              <th className="py-2.5 pl-4 font-bold">{ut("lp.t.staff")}</th>
              <th className="w-[84px] py-2.5 pr-3 text-right font-bold">{ut("lp.t.patients")}</th>
              <th className="w-[92px] py-2.5 pr-3 font-bold">{ut("lp.t.signals")}</th>
              <th className="w-[128px] py-2.5 pr-4 font-bold max-[640px]:hidden">{ut("lp.t.overdue")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, role, n, signals, overdue]) => (
              <tr key={name} className="border-b border-divider last:border-b-0">
                <td className="py-2.5 pl-4">
                  <PersonCell name={name} sub={role} avatar={<Avatar name={name} size={28} tone="soft" />} />
                </td>
                <td className="py-2.5 pr-3 text-right font-extrabold tabular-nums text-text">{n}</td>
                <td className="py-2.5 pr-3">{signals}</td>
                <td className="py-2.5 pr-4 max-[640px]:hidden">{overdue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Shot>
    </Panel>
  );
}

/** Рамка телефона: чёрный обод полосы приложения, вырез, строка состояния */
function PhoneShell({ time, children, className }: { time: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-[40px] bg-appbar p-[9px] shadow-banner", className)}>
      <div className="relative flex h-full flex-col overflow-hidden rounded-[31px] bg-ground">
        <span aria-hidden className="absolute left-1/2 top-2.5 z-10 h-5 w-[70px] -translate-x-1/2 rounded-[10px] bg-appbar" />
        <div className="flex h-10 shrink-0 items-end px-6 pb-1.5 text-[12px] font-extrabold tabular-nums text-text">{time}</div>
        {children}
      </div>
    </div>
  );
}

/** Пацієнтам: головна в застосунку — що пройти до прийому, «Допомога» під рукою */
export function RolePatientHome() {
  const { ut } = useLang();
  return (
    <Panel title={ut("lp.r3")} sub={ut("lp.r3sub")} icon={<ShellIcon name="smartphone" />} flush className="flex h-full flex-col">
      <Shot
        label={ut("lp.homeAlt")}
        className="flex min-h-[330px] flex-1 justify-center overflow-hidden rounded-b-panel bg-band px-4 pt-[18px]"
      >
        <PhoneShell time="17:00" className="h-[420px] w-[252px] rounded-b-none pb-0">
          <div className="flex flex-col bg-violet-tint px-4 pb-4 pt-2">
            <span className="self-end">
              <HelpPill />
            </span>
            <b className="mt-2 text-[19px] font-extrabold leading-6 text-text">{ut("lp.s.hello")}</b>
            <span className="mt-1 text-caption leading-4 text-text-2">{ut("lp.s.helloLead")}</span>
          </div>
          <div className="flex-1 px-3 pt-3">
            <div className="mb-2 flex items-center justify-between px-1">
              <b className="text-small font-extrabold text-text">{ut("home.toDo")}</b>
              <span className="grid h-[18px] min-w-[18px] place-items-center rounded-[9px] bg-violet-tint px-1 text-micro font-bold text-violet-ink">
                1
              </span>
            </div>
            <div className="overflow-hidden rounded-[14px] border border-border bg-panel">
              <PhoneRow
                icon={<Ic.clipboard />}
                title={ut("lp.s.isiName")}
                sub={ut("lp.s.isiSub")}
                tag={
                  <Tag tone="primary" icon={<Ic.calendar />} className="!h-5 !text-[10.5px]">
                    {ut("lp.s.isiDue")}
                  </Tag>
                }
              />
              <PhoneRow
                icon={<ShellIcon name="calendar-days" />}
                title={ut("lp.s.visit")}
                sub={ut("lp.s.visitSub")}
                tag={
                  <Tag tone="attention" icon={<ShellIcon name="circle-alert" />} className="!h-5 !text-[10.5px]">
                    {ut("lp.s.unconfirmed")}
                  </Tag>
                }
              />
            </div>
          </div>
        </PhoneShell>
      </Shot>
    </Panel>
  );
}

function HelpPill() {
  const { ut } = useLang();
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-pill bg-panel px-2.5 text-[11.5px] font-extrabold text-violet-ink shadow-[inset_0_0_0_1px_var(--ctl)]">
      <ShellIcon name="life-buoy" size={13} />
      {ut("pt.help")}
    </span>
  );
}

function PhoneRow({ icon, title, sub, tag }: { icon: ReactNode; title: string; sub: string; tag: ReactNode }) {
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)_12px] items-center gap-2.5 border-t border-divider px-3 py-2.5 first:border-t-0">
      <IconTile icon={icon} size={28} />
      <span className="min-w-0">
        <b className="block truncate text-caption font-extrabold leading-4 text-text">{title}</b>
        <small className="block truncate text-[10.5px] leading-[14px] text-muted">{sub}</small>
        <span className="mt-1 block">{tag}</span>
      </span>
      <Ic.chevronRight size={12} className="text-muted" />
    </div>
  );
}

/* ─────────── числа: курс и большие значения ─────────── */

const T0 = Date.UTC(2026, 7, 24, 11);
const DAY = 86_400_000;
const at = (days: number) => T0 + days * DAY;

/** Курс PHQ-9 Андрія: три замера, сессии и неявка, сигнал на последнем замере */
export function SampleCourse() {
  const { ut } = useLang();
  const rungs: Rung[] = [
    { min: 0, max: 4, label: ut("severity.none"), severity: "none" },
    { min: 5, max: 9, label: ut("severity.mild"), severity: "mild" },
    { min: 10, max: 14, label: ut("severity.moderate"), severity: "moderate" },
    { min: 15, max: 27, label: ut("severity.severe"), severity: "severe" },
  ];
  const points: CoursePoint[] = [
    { key: "a", t: at(0), label: "24.08", value: 19 },
    { key: "b", t: at(18), label: "11.09", value: 16 },
    { key: "c", t: at(45), label: "08.10", value: 14 },
  ];
  const events: CourseEvent[] = [
    { key: "s1", t: at(3), kind: "session", label: "27.08" },
    { key: "s2", t: at(10), kind: "session", label: "03.09" },
    { key: "s3", t: at(21), kind: "session", label: "14.09" },
    { key: "s4", t: at(28), kind: "session", label: "21.09" },
    { key: "n1", t: at(39), kind: "noshow", label: "02.10" },
    { key: "s5", t: at(42), kind: "session", label: "05.10" },
    { key: "sig", t: at(45), kind: "signal", label: "08.10", detail: ut("lp.s.no214") },
    { key: "p6", t: at(47), kind: "planned", label: "10.10" },
  ];
  return (
    <Panel title={ut("lp.courseT")} sub={ut("lp.courseSub")} icon={<ShellIcon name="chart-spline" />}>
      <CourseChart title={ut("lp.code.phq9")} points={points} rungs={rungs} rc={6} better="down" events={events} now={null} />
    </Panel>
  );
}

export function SampleValues() {
  const { ut } = useLang();
  return (
    <Panel
      title={ut("lp.bvT")}
      sub={ut("lp.bvSub")}
      icon={<Ic.clipboard />}
      flush
      footer={
        <span className="flex items-center gap-1.5 text-small text-muted">
          <Ic.info size={14} />
          {ut("lp.bvHint")}
        </span>
      }
    >
      <Shot label={ut("lp.bvT")}>
        <BigValues>
          <BigValue
            code="PHQ-9"
            measure={ut("lp.m.depression")}
            better="down"
            value={14}
            severity={{ word: ut("severity.moderate"), level: "moderate" }}
            history={[19, 16]}
            change={{ delta: -5, threshold: 6 }}
          />
          <BigValue
            code="GAD-7"
            measure={ut("lp.m.anxiety")}
            better="down"
            value={11}
            severity={{ word: ut("severity.moderate"), level: "moderate" }}
            history={[15, 13]}
            change={{ delta: -4, threshold: 5 }}
          />
          <BigValue
            code="PCL-5"
            measure={ut("lp.m.ptsd")}
            better="down"
            value={38}
            severity={{ word: ut("lp.m.aboveCut"), level: "modsevere" }}
            history={[52, 44]}
            change={{ delta: -14, threshold: 11 }}
          />
          <BigValue
            code="WHO-5"
            measure={ut("lp.m.wellbeing")}
            better="up"
            value={40}
            unit="%"
            severity={{ word: ut("lp.m.lowered"), level: "moderate" }}
            history={["24 %", "32 %"]}
            change={{ delta: 16, threshold: 14, unit: ut("lp.m.pp") }}
          />
        </BigValues>
      </Shot>
    </Panel>
  );
}

/* ─────────── сигнал: шаги и панель разбора ─────────── */

export function SignalSteps() {
  const { ut } = useLang();
  const steps: { t: string; icon: ReactNode; title: string; text: string; tone?: "risk" | "ok" }[] = [
    { t: "14:12", icon: <ShellIcon name="smartphone" size={16} />, title: ut("lp.rs1t"), text: ut("lp.rs1"), tone: "risk" },
    { t: "14:12", icon: <ShellIcon name="scan-eye" size={16} />, title: ut("lp.rs2t"), text: ut("lp.rs2") },
    { t: "14:12", icon: <ShellIcon name="bell-ring" size={16} />, title: ut("lp.rs3t"), text: ut("lp.rs3") },
    { t: "16:52", icon: <ShellIcon name="phone" size={16} />, title: ut("lp.rs4t"), text: ut("lp.rs4") },
    { t: ut("lp.rsBy"), icon: <ShellIcon name="file-signature" size={16} />, title: ut("lp.rs5t"), text: ut("lp.rs5"), tone: "ok" },
  ];
  return (
    <ol className="m-0 mt-[30px] max-w-[620px] list-none p-0">
      {steps.map((s) => (
        <li
          key={s.title}
          className={cx(
            "relative grid grid-cols-[72px_36px_minmax(0,1fr)] items-start gap-3.5 pb-[22px] text-[14px] leading-[21px] text-text-2 last:pb-0",
            "before:absolute before:bottom-0.5 before:left-[103px] before:top-[38px] before:w-0.5 before:rounded-[1px] before:bg-divider before:content-[''] last:before:hidden",
            "max-[520px]:grid-cols-[36px_minmax(0,1fr)] max-[520px]:before:left-[17px]",
          )}
        >
          <span
            className={cx(
              "whitespace-nowrap pt-2 text-right text-body font-extrabold leading-5 max-[520px]:hidden",
              s.tone === "risk" ? "text-risk-ink" : "text-text",
            )}
          >
            {s.t}
          </span>
          <span
            aria-hidden
            className={cx(
              "grid size-9 place-items-center rounded-full",
              s.tone === "risk"
                ? "bg-risk text-onfill shadow-[0_0_0_4px_var(--risktint)]"
                : s.tone === "ok"
                  ? "bg-good-tint text-good shadow-[inset_0_0_0_1.5px_var(--goodline)]"
                  : "bg-panel text-violet-ink shadow-[inset_0_0_0_1.5px_var(--vline)]",
            )}
          >
            {s.icon}
          </span>
          <span>
            <b className="block pt-[7px] text-h3 font-extrabold leading-[22px] text-text">{s.title}</b>
            {s.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Панель разбора сигнала — та же, что открывается справа в консоли */
export function SignalReview() {
  const { ut } = useLang();
  const hist: [string, number, string, boolean][] = [
    ["24.08", 0, ut("lp.d.notAtAll"), false],
    ["11.09", 0, ut("lp.d.notAtAll"), false],
    ["08.10", 1, ut("lp.d.several"), true],
  ];
  return (
    <Shot label={ut("lp.d.title")}>
      <div className="flex h-[640px] flex-col overflow-hidden rounded-drawer border border-border bg-panel shadow-banner">
        <DrawerPane
          title={ut("lp.d.title")}
          sub={ut("lp.d.sub")}
          icon={<Ic.alert />}
          tone="risk"
          headerExtra={
            <RiskTimer
              size="lg"
              elapsed="2:48"
              of={ut("lp.s.of4h")}
              pct={70}
              note={rich(ut("lp.d.note"), {
                time: <b className="font-extrabold text-text">18:12</b>,
                left: "1:12",
              })}
            />
          }
          saved={ut("lp.d.saved")}
          footer={
            <>
              <Button variant="primary">{ut("lp.d.save")}</Button>
              <Button>{ut("lp.d.c3")}</Button>
            </>
          }
        >
          <DrawerSection title={ut("lp.d.item")} sub={ut("lp.d.itemSub")}>
            <p className="m-0 rounded-panel bg-sunk px-3.5 py-3 text-[13px] leading-5 text-text-2">{ut("lp.d.q")}</p>
            <ol className="m-0 mt-3 grid list-none grid-cols-[1fr_14px_1fr_14px_1fr] items-center gap-1 p-0">
              {hist.map(([d, v, w, now], i) => (
                <li key={d} className="contents">
                  {i > 0 ? (
                    <span aria-hidden className="text-muted">
                      <Ic.chevronRight size={14} />
                    </span>
                  ) : null}
                  <span
                    className={cx(
                      "flex flex-col rounded-[12px] px-3 py-2.5",
                      now ? "bg-risk-tint shadow-[inset_0_0_0_1px_var(--riskline)]" : "bg-sunk",
                    )}
                  >
                    <span className="text-caption text-muted">{d}</span>
                    <b className={cx("text-[26px] font-extrabold leading-8", now ? "text-risk-ink" : "text-text")}>{v}</b>
                    <span className={cx("text-caption", now ? "font-bold text-risk-ink" : "text-text-2")}>{w}</span>
                  </span>
                </li>
              ))}
            </ol>
          </DrawerSection>
          <DrawerSection title={ut("lp.d.decision")} sub={ut("lp.d.decisionSub")}>
            <div className="flex flex-col gap-1.5">
              <ChoiceCard name="lp-dec" value="low" checked onChange={() => {}} title={ut("lp.d.c1")} sub={ut("lp.d.c1s")} />
              <ChoiceCard name="lp-dec" value="today" checked={false} onChange={() => {}} title={ut("lp.d.c2")} sub={ut("lp.d.c2s")} />
              <ChoiceCard name="lp-dec" value="duty" checked={false} onChange={() => {}} title={ut("lp.d.c3")} sub={ut("lp.d.c3s")} />
            </div>
          </DrawerSection>
        </DrawerPane>
      </div>
    </Shot>
  );
}

/* ─────────── застосунок: питання на телефоні ─────────── */

export function QuestionPhone() {
  const { ut } = useLang();
  const options = [ut("lp.ph.o1"), ut("lp.ph.o2"), ut("lp.ph.o3"), ut("lp.ph.o4")];
  return (
    <Shot label={ut("lp.phAlt")} className="justify-self-center">
      <PhoneShell time="14:10" className="h-[621px] w-[300px]">
        <div className="flex items-center justify-between bg-violet-tint px-4 pb-2 pt-1 text-small">
          <span className="font-bold text-violet-ink">{ut("lp.ph.later")}</span>
          <b className="font-extrabold text-text">{ut("lp.code.phq9")}</b>
          <HelpPill />
        </div>
        <div className="bg-violet-tint px-4 pb-3">
          <div className="flex items-center justify-between text-caption text-text-2">
            <span>{rich(ut("lp.ph.q"), { n: <b className="text-[17px] font-extrabold text-text">3</b>, of: "9" })}</span>
            <span className="inline-flex items-center gap-1">
              <Ic.cloudCheck size={13} className="text-good" />
              {ut("lp.ph.saved")}
            </span>
          </div>
          <div className="mt-2 flex gap-1" aria-hidden>
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <i
                key={i}
                className={cx(
                  "block h-1 flex-1 rounded-[2px]",
                  i < 2 ? "bg-violet" : i === 2 ? "bg-violet-tint-2 shadow-[inset_0_0_0_1.5px_var(--violet)]" : "bg-panel",
                )}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-1 flex-col px-4 pt-4">
          <p className="m-0 text-caption leading-4 text-text-2">{ut("lp.ph.stem")}</p>
          <b className="mt-1.5 text-[18px] font-extrabold leading-6 text-text">{ut("lp.ph.title")}</b>
          <div className="mt-4 flex flex-col gap-2">
            {options.map((o, i) => {
              const on = i === 3;
              return (
                <span
                  key={o}
                  className={cx(
                    "flex h-11 items-center gap-2.5 rounded-[12px] px-3 text-small font-bold",
                    on
                      ? "bg-violet-tint text-violet-ink shadow-[inset_0_0_0_1.5px_var(--vring)]"
                      : "bg-panel text-text shadow-[inset_0_0_0_1px_var(--border)]",
                  )}
                >
                  <span
                    className={cx(
                      "grid size-[18px] place-items-center rounded-full",
                      on ? "bg-violet text-onfill" : "shadow-[inset_0_0_0_1.5px_var(--ctl)]",
                    )}
                  >
                    {on ? <Ic.check size={11} /> : null}
                  </span>
                  {o}
                </span>
              );
            })}
          </div>
          <p className="m-0 mt-3 flex items-start gap-1.5 text-[11px] leading-[15px] text-muted">
            <Ic.cloudCheck size={13} className="mt-px shrink-0 text-good" />
            {ut("lp.ph.note")}
          </p>
          <div className="mt-auto flex gap-2 pb-5 pt-3">
            <span className="flex h-10 flex-1 items-center justify-center gap-1 rounded-[12px] bg-violet-tint text-small font-bold text-violet-ink">
              <Ic.chevronLeft size={14} />
              {ut("lp.ph.back")}
            </span>
            <span className="flex h-10 flex-[1.6] items-center justify-center gap-1 rounded-[12px] bg-violet text-small font-bold text-onfill shadow-primary">
              {ut("lp.ph.next")}
              <Ic.chevronRight size={14} />
            </span>
          </div>
        </div>
      </PhoneShell>
    </Shot>
  );
}

/* ─────────── безпека: журнал переглядів ─────────── */

export function AuditSample() {
  const { ut } = useLang();
  const rows: [string, string, string, string, string][] = [
    ["16:58", ut("lp.s.st1"), ut("lp.s.st1r"), ut("lp.au.a1"), ut("lp.au.r1")],
    ["16:52", ut("lp.s.st1"), ut("lp.s.st1r"), ut("lp.au.a2"), ut("lp.au.r1")],
    ["14:13", ut("lp.s.st2"), ut("lp.au.duty"), ut("lp.au.a3"), ut("lp.au.r3")],
    ["14:12", ut("lp.au.system"), ut("lp.au.rule"), ut("lp.au.a4"), ut("lp.au.r4")],
    ["09:05", ut("lp.s.st5"), ut("lp.s.st5r"), ut("lp.au.a3"), ut("lp.au.r5")],
  ];
  return (
    <Panel
      title={ut("lp.auditT")}
      sub={ut("lp.auditSub")}
      icon={<ShellIcon name="file-search" />}
      flush
      footer={
        <span className="flex items-center gap-1.5 text-small text-text-2">
          <AccessIcon name="link-2" size={14} className="text-good" />
          {ut("lp.f8")}
        </span>
      }
    >
      <Shot label={ut("lp.auditT")}>
        <table className="w-full border-collapse text-small">
          <thead>
            <tr className="border-y border-divider bg-panel-2 text-left text-caption text-muted">
              <th className="w-16 py-2 pl-4 font-bold">{ut("lp.au.time")}</th>
              <th className="py-2 pr-3 font-bold">{ut("lp.au.who")}</th>
              <th className="py-2 pr-3 font-bold">{ut("lp.au.what")}</th>
              <th className="py-2 pr-4 font-bold max-[640px]:hidden">{ut("lp.au.why")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([t, who, role, what, why]) => (
              <tr key={`${t}-${what}`} className="border-b border-divider last:border-b-0">
                <td className="py-2 pl-4 align-top font-extrabold tabular-nums text-text">{t}</td>
                <td className="py-2 pr-3 align-top">
                  <b className="block font-bold text-text">{who}</b>
                  <small className="text-caption text-muted">{role}</small>
                </td>
                <td className="py-2 pr-3 align-top text-text">{what}</td>
                <td className="py-2 pr-4 align-top text-text-2 max-[640px]:hidden">{why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Shot>
    </Panel>
  );
}

/* ─────────── запитання ─────────── */

export function Faq() {
  const { ut } = useLang();
  const [open, setOpen] = useState<number | null>(0);
  const qa: [string, string][] = [
    [ut("lp.q1"), ut("lp.a1q")],
    [ut("lp.q2"), ut("lp.a2q")],
    [ut("lp.q3"), ut("lp.a3q")],
    [ut("lp.q4"), ut("lp.a4q")],
    [ut("lp.q5"), ut("lp.a5q")],
  ];
  return (
    <div className="min-w-0 overflow-hidden rounded-panel border border-border bg-panel shadow-panel">
      {qa.map(([q, a], i) => {
        const on = open === i;
        return (
          <div key={q} className="border-t border-divider first:border-t-0">
            <h3 className="m-0">
              <button
                type="button"
                aria-expanded={on}
                aria-controls={`lp-faq-${i}`}
                onClick={() => setOpen(on ? null : i)}
                className={cx(
                  "flex min-h-[60px] w-full cursor-pointer items-center gap-4 border-0 bg-transparent py-3 pl-5 pr-[18px] text-left",
                  "text-h3 font-extrabold leading-[21px] text-text hover:bg-panel-2",
                  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus)]",
                )}
              >
                <span className="flex-1">{q}</span>
                <AccessIcon
                  name="chevron-down"
                  size={18}
                  className={cx("transition-transform duration-[var(--dur)]", on ? "rotate-180 text-violet-ink" : "text-muted")}
                />
              </button>
            </h3>
            <div id={`lp-faq-${i}`} role="region" hidden={!on} className="pb-[18px] pl-5 pr-14 text-[14px] leading-[22px] text-text-2">
              <p className="m-0">{a}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
