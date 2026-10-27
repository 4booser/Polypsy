import type { ReactNode } from "react";
import type { AppointmentView, RespondentDynamics, ScaleDynamics, Severity } from "@quizzy/shared";
import { api, type NoteState } from "../../api";
import { day, locale, severityKey } from "../../format";
import { changeVerdict, reliableThreshold } from "../../charts/courseModel";
import { Avatar, Callout, Loading, Skeleton, Tooltip } from "../../ui";
import { cx } from "../../ui/cx";
import { Ic } from "../../ui/icons";
import { Panel } from "../../ui/layout";
import { Button, ButtonLink, SeverityTag, Tag } from "../../ui/primitives";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { fill } from "../dashboard/model";
import { Di } from "./icons";
import { hhmm, type Clash, type SessionState } from "./model";
import { ReadinessCells, useUntil } from "./Agenda";

/**
 * Підготовка до сесії — липкая панель справа: выбранная сессия (по
 * умолчанию идущая или следующая).
 *
 * Без явного действия панель показывает только то, что уже есть в расписании:
 * кто, когда, формат, кабинет, готовность из загруженного дня. Клинический
 * контекст — что изменилось с прошлого приёма, ключевые числа, последняя
 * запись — открывается кнопкой «Показати підготовку» (P): сервер пишет такое
 * открытие в журнал доступа (clinic.visit_open), и запись должна значить
 * «человек открыл», а не «курсор прошёл по строке». Выбор другой сессии
 * панель закрывает: чужой контекст на экране не остаётся.
 */

type Ctx = Awaited<ReturnType<typeof api.visitContext>>;

const SEV_RANK: Record<Severity, number> = { none: 0, mild: 1, moderate: 2, severe: 3 };

/** Балл в строке: целые — как есть, дробные — с одним знаком по языку экрана */
export function num(v: number): string {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(v);
}

/**
 * Куда лучше двигаться по шкале — по самим замерам: если более высокий балл
 * стоит в более тяжёлой полосе, лучше — вниз. Полос нет или замеры в одной
 * полосе — не знаем, и стрелки нет.
 */
export function betterFromPoints(scale: Pick<ScaleDynamics, "points">): "down" | "up" | null {
  const pts = scale.points.filter((p) => p.severity);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i]!;
      const b = pts[j]!;
      const ds = SEV_RANK[b.severity!] - SEV_RANK[a.severity!];
      const dv = b.rawScore - a.rawScore;
      if (ds !== 0 && dv !== 0) return ds * dv > 0 ? "down" : "up";
    }
  }
  return null;
}

export interface KeyRow {
  code: string;
  title: string;
  values: { v: number; at: string }[];
  severity: Severity | null;
  band: string | null;
  delta: number | null;
  verdict: ReturnType<typeof changeVerdict> | null;
  rc: number | null;
}

/**
 * Шкала, по которой методику читают на сессии: первая с клиническими
 * полосами (у последнего замера есть тяжесть), иначе первая с замерами.
 * Шкалы достоверности («L», «F») полос тяжести не имеют и сюда не встают.
 */
function mainScale(scales: readonly ScaleDynamics[]): ScaleDynamics | null {
  const measured = scales.filter((sc) => sc.points.length);
  return measured.find((sc) => sc.points[sc.points.length - 1]!.severity) ?? measured[0] ?? null;
}

/** Ключевые числа: главная шкала каждой методики, свежие сверху, не больше `limit` */
export function keyRows(d: RespondentDynamics | null, limit = 4): KeyRow[] {
  if (!d) return [];
  return d.surveys
    .filter((s) => mainScale(s.scales))
    .sort((a, b) => Date.parse(b.lastAt ?? "") - Date.parse(a.lastAt ?? ""))
    .slice(0, limit)
    .map((s) => {
      const sc = mainScale(s.scales)!;
      const pts = sc.points;
      const lastP = pts[pts.length - 1]!;
      const rc = reliableThreshold(sc);
      const better = betterFromPoints(sc);
      const delta = pts.length > 1 && !sc.incomparable ? Math.round((lastP.rawScore - pts[0]!.rawScore) * 10) / 10 : null;
      return {
        code: s.title,
        title: sc.title,
        values: pts.slice(-3).map((p) => ({ v: p.rawScore, at: p.submittedAt })),
        severity: lastP.severity,
        band: lastP.bandLabel,
        delta,
        verdict: delta === null ? null : changeVerdict(delta, rc, better),
        rc,
      };
    });
}

const CHANGE_ICON: Record<string, { tone: string; icon: ReactNode }> = {
  response: { tone: "bg-violet-tint text-violet-ink", icon: <Di.clipboardCheck size={14} /> },
  alert: { tone: "bg-risk-tint text-risk-ink", icon: <Ic.alert size={14} /> },
  referral: { tone: "bg-sunk text-muted", icon: <Di.arrows size={14} /> },
  noShow: { tone: "bg-warn-tint text-warn", icon: <Di.calendarX size={14} /> },
  conclusion: { tone: "bg-good-tint text-good", icon: <Di.fileText size={14} /> },
};

/**
 * Клинический контекст сессии — три запроса разом. Только отсюда панель
 * зовёт /api/clinic/appointments/:id/context, и только по явному открытию
 * (apps/web/test/todayPrep.test.tsx).
 */
export async function loadPrep(a: Pick<AppointmentView, "id" | "patientId">) {
  const [ctx, dyn, notes] = await Promise.all([
    api.visitContext(a.id).catch((): Ctx | null => null),
    api.dynamics(a.patientId).catch((): RespondentDynamics | null => null),
    api.notes(a.patientId).catch((): NoteState | null => null),
  ]);
  return { ctx, dyn, notes };
}

export function Prep({
  a,
  state,
  clash,
  now,
  open,
  onOpen,
  onNote,
}: {
  a: AppointmentView | null;
  state: SessionState | undefined;
  clash: Clash | undefined;
  now: number | null;
  /** Открыта ли подготовка этой сессии — явным действием, а не выбором строки */
  open: boolean;
  onOpen: () => void;
  onNote: (a: AppointmentView) => void;
}) {
  const { ut } = useLang();
  const until = useUntil();

  if (!a) {
    return (
      <Panel title={ut("dayA.prep")} icon={<Ic.clipboard />}>
        <p className="m-0 text-small text-text-2">{ut("dayA.prepNone")}</p>
      </Panel>
    );
  }

  const start = Date.parse(a.startsAt);
  const badge =
    state === "here" ? (
      <Tag tone="primary" icon={<Di.logIn />}>
        {ut("dayA.inRoomNow")}
      </Tag>
    ) : now !== null && start > now ? (
      <Tag tone="primary" icon={<Di.clock />}>
        {until((start - now) / 60_000)}
      </Tag>
    ) : state === "done" ? (
      <Tag tone="good" icon={<Ic.check />}>
        {ut("day.statusDone")}
      </Tag>
    ) : null;

  return (
    <Panel
      title={ut("dayA.prep")}
      icon={<Ic.clipboard />}
      actions={badge}
      flush
      footer={
        <div className="flex w-full flex-wrap gap-2">
          <ButtonLink to={`/patients/${a.patientId}`} variant="primary" className="min-w-[140px] flex-1">
            <Di.outLink />
            {ut("dayA.openCard")}
          </ButtonLink>
          <Tooltip label={ut("dayA.noteBtn")} kbd="N">
            <Button className="min-w-[140px] flex-1" icon={<Di.notebook />} onClick={() => onNote(a)} aria-keyshortcuts="N">
              {ut("dayA.noteBtn")}
            </Button>
          </Tooltip>
        </div>
      }
    >
      <div className="flex items-center gap-3 px-4 pb-3">
        <Avatar name={a.patientName} size={48} />
        <div className="min-w-0">
          <h3 className="m-0 truncate text-lead font-extrabold leading-[23px] tracking-[-0.02em] text-text">{a.patientName}</h3>
          {a.leadSpecialistId === null ? <span className="block truncate text-small text-muted">{ut("day.noLead")}</span> : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 px-4 pb-3.5">
        <Tag icon={<Di.clock />}>
          {hhmm(a.startsAt)}–{hhmm(a.endsAt)}
        </Tag>
        <Tag icon={<Di.repeat />}>{ut(a.kind === "primary" ? "day.primary" : "day.repeat")}</Tag>
        {a.mode === "remote" ? (
          <Tag tone="info" icon={<Di.video />}>
            {ut("dayA.online")}
          </Tag>
        ) : a.room ? (
          <Tag icon={<Di.door />}>
            {ut("day.room")} {a.room}
          </Tag>
        ) : null}
      </div>

      {clash && state !== "done" && state !== "noshow" ? (
        <div className="px-3 pb-3">
          <Callout kind="warn" title={fill(ut("dayA.clashTitle"), { t: hhmm(clash.from), name: clash.withName })}>
            {fill(ut("dayA.clashText"), { from: hhmm(clash.from), to: hhmm(clash.to) })}
          </Callout>
        </div>
      ) : a.pendingAssignments > 0 && state !== "done" ? (
        <div className="px-3 pb-3">
          <Callout kind="warn" title={fill(ut("dayA.pendingTitle"), { n: a.pendingAssignments })}>
            {ut("dayA.pendingText")}
          </Callout>
        </div>
      ) : null}

      {open ? (
        <PrepDetails a={a} />
      ) : (
        <>
          <section className="border-t border-divider px-4 pb-3 pt-3.5">
            <h3 className="m-0 mb-2 text-h3 font-extrabold text-text">{ut("dayA.readiness")}</h3>
            <ReadinessCells a={a} stacked />
          </section>
          {/* что откроется — подсказкой на кнопке; под ней одна строка: открытие пишется в журнал */}
          <section data-prep-closed className="border-t border-divider px-4 pb-4 pt-3.5">
            <Tooltip label={ut("home.prepWhat")} kbd="P">
              <Button icon={<Ic.eye />} onClick={onOpen} aria-keyshortcuts="P">
                {ut("dayA.prepShow")}
              </Button>
            </Tooltip>
            <p className="m-0 mt-2 text-caption text-text-2">{ut("dayA.prepShowHint")}</p>
          </section>
        </>
      )}
    </Panel>
  );
}

/**
 * Открытая подготовка: свой запрос, только пока она открыта. `keep: false` —
 * контекст прежнего человека не стоит на экране под именем следующего.
 */
function PrepDetails({ a }: { a: AppointmentView }) {
  const { ut } = useLang();
  const res = useResource(() => loadPrep(a), [a.id], { keep: false });
  const ctx = res.data?.ctx ?? null;
  const rows = keyRows(res.data?.dyn ?? null);
  const note = res.data?.notes?.current ?? null;
  const prev = ctx?.previous ?? null;
  const who = [ctx?.patient.unit, ctx?.patient.leadName ? fill(ut("dayA.leadBy"), { name: ctx.patient.leadName }) : null].filter(Boolean);

  return (
    <div data-prep-details>
      {who.length ? <p className="m-0 border-t border-divider px-4 py-2.5 text-small text-text-2">{who.join(", ")}</p> : null}
      {res.error ? (
        <div className="border-t border-divider p-4">
          <Loading bare error={res.error} onRetry={res.reload} />
        </div>
      ) : !res.data ? (
        <div className="border-t border-divider px-4 py-3.5" role="status" aria-label={ut("common.loading")}>
          <Skeleton lines={5} />
        </div>
      ) : (
        <>
          <Section
            title={prev ? ut("dayA.sinceLast") : ut("dayA.firstHere")}
            sub={prev ? fill(ut("dayA.prevVisit"), { d: day(prev.at), name: prev.specialistName }) : undefined}
          >
            {ctx && ctx.changes.length ? (
              <ul className="m-0 list-none p-0">
                {ctx.changes.slice(0, 5).map((c, i) => {
                  const look = CHANGE_ICON[c.kind] ?? CHANGE_ICON.referral!;
                  return (
                    <li
                      key={`${c.kind}-${c.at}-${i}`}
                      className="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-x-2 gap-y-0 border-t border-divider py-1.5 text-small text-text-2 first:border-t-0 first:pt-0"
                    >
                      <span aria-hidden className={cx("grid size-7 place-items-center rounded-[9px]", look.tone)}>
                        {look.icon}
                      </span>
                      <span className="min-w-0">
                        <span className="mr-1.5 font-bold text-muted tabular-nums">{day(c.at)}</span>
                        <b className="font-extrabold text-text">{c.title}</b>
                        {c.detail ? <span>: {c.detail}</span> : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="m-0 text-small text-muted">{prev ? ut("dayA.noChanges") : ut("dayA.firstHereText")}</p>
            )}
          </Section>

          {rows.length ? (
            <section className="border-t border-divider pt-3.5">
              <div className="mb-2 flex items-center gap-2 px-4">
                <h3 className="m-0 text-h3 font-extrabold text-text">{ut("dayA.keyNumbers")}</h3>
                <span className="text-small text-muted">{ut("dayA.keyNumbersSub")}</span>
              </div>
              <ul className="m-0 list-none p-0">
                {rows.map((r) => (
                  <li
                    key={r.code + r.title}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-divider px-4 py-2.5 first:border-t-0"
                  >
                    <span className="min-w-0">
                      <b className="block truncate text-small font-extrabold text-text" title={r.code}>
                        {r.code}
                      </b>
                      <span className="block truncate text-caption text-muted" title={r.title}>
                        {r.title}
                      </span>
                    </span>
                    <span className="whitespace-nowrap text-right tabular-nums text-text-2">
                      {r.values.map((p, i) => (
                        <span key={p.at}>
                          {i ? <span className="mx-0.5 text-muted">→</span> : null}
                          <span className={i === r.values.length - 1 ? "text-[17px] font-extrabold text-text" : undefined} title={day(p.at)}>
                            {num(p.v)}
                          </span>
                        </span>
                      ))}
                    </span>
                    <span className="min-w-0">
                      {r.severity ? (
                        <SeverityTag small level={r.severity} className="max-w-full">
                          <span className="truncate" title={r.band ?? undefined}>
                            {r.band ?? ut(severityKey[r.severity])}
                          </span>
                        </SeverityTag>
                      ) : null}
                    </span>
                    <span className="whitespace-nowrap text-right text-caption">
                      {r.delta === null ? (
                        <span className="text-muted">{ut("dayA.onlyStart")}</span>
                      ) : (
                        <>
                          <b
                            className={cx(
                              "font-extrabold tabular-nums",
                              r.verdict === "better" ? "text-good" : r.verdict === "worse" ? "text-warn" : "text-text",
                            )}
                          >
                            {r.delta > 0 ? `+${num(r.delta)}` : r.delta === 0 ? "0" : `−${num(Math.abs(r.delta))}`}
                          </b>{" "}
                          <span className={r.verdict === "better" ? "text-good" : "text-text-2"}>
                            {r.verdict === "better"
                              ? ut("course.v.better")
                              : r.verdict === "worse"
                                ? ut("course.v.worse")
                                : r.verdict === "changed"
                                  ? ut("course.v.changed")
                                  : r.verdict === "within"
                                    ? ut("kit.withinError")
                                    : ut("dayA.fromStart")}
                          </span>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {note ? (
            <Section
              title={fill(ut("dayA.lastNote"), { v: note.version })}
              sub={`${day(note.createdAt)}, ${note.authorName}`}
              right={<span className={cx("text-caption font-bold", note.status === "signed" ? "text-good" : "text-muted")}>{ut(note.status === "signed" ? "dayA.noteSigned" : "dayA.noteDraftWord")}</span>}
            >
              <p className="m-0 line-clamp-4 whitespace-pre-wrap text-small text-text-2">{note.text}</p>
            </Section>
          ) : null}
        </>
      )}
    </div>
  );
}

function Section({ title, sub, right, children }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-divider px-4 pb-3 pt-3.5">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="m-0 whitespace-nowrap text-h3 font-extrabold text-text">{title}</h3>
        {sub ? <span className="min-w-0 truncate text-small text-muted">{sub}</span> : null}
        {right ? <span className="ml-auto">{right}</span> : null}
      </div>
      {children}
    </section>
  );
}
