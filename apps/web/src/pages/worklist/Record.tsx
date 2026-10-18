import type { ReactNode } from "react";
import type { RespondentDynamics, SafetyPlan, UiKey, WorkItem } from "@quizzy/shared";
import { api, type TimelineItem } from "../../api";
import { day, severityKey } from "../../format";
import { ActivityList, AlertChip, AlertStrip, Avatar, BigValue, BigValues, KbdHints, Loading, Skeleton, Tooltip, type ActivityEvent } from "../../ui";
import { cx } from "../../ui/cx";
import { Ic } from "../../ui/icons";
import { Panel } from "../../ui/layout";
import { Button, ButtonLink, Tag } from "../../ui/primitives";
import { TextAction } from "../../ui/records";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { reliableThreshold } from "../../charts/courseModel";
import { fill } from "../dashboard/model";
import { chipLabel, stamp, WorkIcon } from "../today/ActNow";
import { Di } from "../today/icons";
import { betterFromPoints, num } from "../today/Prep";
import { hhmm } from "../today/model";
import { workWhy } from "./model";

/**
 * Запись выбранного пункта очереди (правая часть «списка и записи»).
 *
 * Шапка — человек и строка открытого: все его пункты очереди пилюлями.
 * Ниже — «Що чекає» (почему пункт здесь, до чего, одно главное действие),
 * план безопасности, если он есть, «Що вже робили» — хронология человека, и
 * заміри — последние значения главных шкал с надёжностью изменения.
 *
 * Действия открываются в ящике (ответ, нотатка) или ведут туда, где с
 * пунктом работают (карта, направление). Отложить, передать коллеге и
 * «розібрано» в очереди нет: сервер их не знает, и пункт уходит из очереди
 * сам, когда сделано то, ради чего он здесь.
 */

/** Что сделать с пунктом — словами, как заголовок «Що чекає» */
const TASK_KEY: Record<WorkItem["kind"], string> = {
  message: "wlA.taskMessage",
  noshow: "wlA.taskNoshow",
  dispensary: "wlA.taskDispensary",
  followup: "wlA.taskFollowup",
  referral: "wlA.taskReferral",
  assignment: "wlA.taskAssignment",
};

/*
 * Строка хронологии человека: подписи и слова — здесь, сервер отдаёт факты
 * (вид, заголовок, код состояния). Коды состояний в текст не попадают:
 * «booked» на экране — это сбой, а не сведение.
 */
const VISIT_STATUS: Record<string, UiKey> = {
  booked: "day.statusBooked",
  confirmed: "day.statusConfirmed",
  arrived: "day.statusArrived",
  in_progress: "day.statusInProgress",
  done: "day.statusDone",
  no_show: "day.statusNoShow",
  cancelled: "day.statusCancelled",
};

const ASSIGNMENT_STATE: Record<string, UiKey> = {
  completed: "wlA.asgCompleted",
  cancelled: "wlA.asgCancelled",
  open: "wlA.asgOpen",
};

export function timelineEvent(t: TimelineItem, ut: (k: UiKey) => string): ActivityEvent {
  const kind = t.kind as TimelineItem["kind"] | "visit";
  const base = { date: day(t.at), time: hhmm(t.at) };
  switch (kind) {
    case "visit": {
      const st = t.detail ? VISIT_STATUS[t.detail] : undefined;
      return {
        ...base,
        icon: <Ic.calendar />,
        tone: t.detail === "no_show" ? "warn" : t.detail === "done" ? "good" : undefined,
        text: (
          <>
            <b>{ut("wlA.tlVisit")}</b> {t.title}
            {st ? <span className="text-text-2">, {ut(st)}</span> : null}
          </>
        ),
      };
    }
    case "alert":
      return {
        ...base,
        icon: <Ic.alert />,
        tone: "risk",
        text: (
          <>
            <b>{ut("wlA.tlSignal")}</b> {t.title}
            {t.detail ? <span className="text-text-2">, {t.detail}</span> : null}
          </>
        ),
      };
    case "response":
      return { ...base, icon: <Di.clipboardCheck />, text: <><b>{ut("wlA.tlResponse")}</b> {t.title}</> };
    case "referral":
      return {
        ...base,
        icon: <Di.arrows />,
        text: (
          <>
            <b>{ut("wlA.tlReferral")}</b> {ut(`dest.${t.title}` as UiKey)}
          </>
        ),
      };
    case "conclusion":
      return {
        ...base,
        icon: <Di.fileText />,
        tone: t.detail === "signed" ? "good" : undefined,
        text: (
          <>
            <b>{ut("wlA.tlConclusion")}</b>
            {t.detail === "signed" ? <span className="text-text-2"> {ut("dayA.noteSigned")}</span> : <span className="text-text-2"> {ut("dayA.noteDraftWord")}</span>}
          </>
        ),
      };
    default: {
      const st = t.detail ? ASSIGNMENT_STATE[t.detail] : undefined;
      return {
        ...base,
        icon: <Di.clipboardCheck />,
        tone: t.detail === "completed" ? "good" : undefined,
        text: (
          <>
            <b>{ut("wlA.tlAssignment")}</b>
            {st ? <span className="text-text-2"> {ut(st)}</span> : null}
          </>
        ),
      };
    }
  }
}

export function WorkRecord({
  item,
  all,
  onReply,
  onNote,
}: {
  item: WorkItem;
  /** Все пункты очереди этого человека — строка открытого */
  all: WorkItem[];
  onReply: () => void;
  onNote: () => void;
}) {
  const { ut } = useLang();
  const res = useResource(async () => {
    const [dyn, timeline, plans] = await Promise.all([
      api.dynamics(item.userId).catch((): RespondentDynamics | null => null),
      api.timeline(item.userId).catch((): TimelineItem[] | null => null),
      api.safetyPlans(item.userId).then((r) => r.versions).catch((): SafetyPlan[] | null => null),
    ]);
    return { dyn, timeline, plans };
  }, [item.userId]);
  const dyn = res.data?.dyn ?? null;
  const plan = res.data?.plans?.find((p) => p.active) ?? res.data?.plans?.[0] ?? null;

  const facts: ReactNode[] = [];
  if (dyn?.age !== null && dyn?.age !== undefined) facts.push(fill(ut("wlA.age"), { n: dyn.age }));
  if (item.unit) facts.push(item.unit);

  const primary =
    item.kind === "message" ? (
      <Button variant="primary" icon={<Ic.reply />} onClick={onReply}>
        {ut("dayA.replyBtn")}
      </Button>
    ) : item.kind === "noshow" ? (
      <Button variant="primary" icon={<Ic.message />} onClick={onReply}>
        {ut("dayA.write")}
      </Button>
    ) : (
      <ButtonLink to={item.href} variant="primary">
        <Di.outLink />
        {ut(item.kind === "referral" ? "wlA.openReferral" : "dayA.openCard")}
      </ButtonLink>
    );

  return (
    <div className="flex min-w-0 flex-col">
      {/* шапка человека: имя, факты, строка открытого, действия */}
      <header className="m-4 mb-0 rounded-[18px] border border-border bg-panel px-5 py-4 shadow-banner">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar name={item.userName} size={56} />
          <div className="min-w-0 flex-1">
            <h2 className="m-0 truncate text-[24px] font-extrabold leading-[30px] tracking-[-0.02em] text-text">{item.userName}</h2>
            {facts.length ? (
              <p className="m-0 mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-text-2">
                {facts.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5">
                    {i === 0 && dyn?.age != null ? <Ic.user size={14} className="text-muted" /> : <Di.building size={14} className="text-muted" />}
                    {f}
                  </span>
                ))}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Tooltip label={ut("wlA.writeTip")} kbd="M">
              <Button icon={<Ic.message />} onClick={onReply} aria-keyshortcuts="M">
                {ut("dayA.write")}
              </Button>
            </Tooltip>
            <Tooltip label={ut("dayA.noteBtn")} kbd="N">
              <Button icon={<Di.notebook />} onClick={onNote} aria-keyshortcuts="N">
                {ut("wlA.note")}
              </Button>
            </Tooltip>
            <Tooltip label={ut("dayA.openCard")}>
              <ButtonLink to={`/patients/${item.userId}`} size="icon" aria-label={ut("dayA.openCard")}>
                <Di.outLink />
              </ButtonLink>
            </Tooltip>
          </div>
        </div>
        <AlertStrip className="mt-3 gap-1.5" label={fill(ut("dayA.openOf"), { name: item.userName })}>
          {all.map((w) => (
            <AlertChip
              key={`${w.kind}-${w.id}`}
              kind={w.overdue || w.kind === "noshow" ? "warn" : w.kind === "message" ? "message" : "neutral"}
              icon={<WorkIcon kind={w.kind} />}
              label={chipLabel(w, ut)}
              detail={w.overdue ? ut("dayA.overdueWord") : stamp(w.since)}
              pressed={w.kind === item.kind && w.id === item.id}
              pop={workWhy(w, ut)}
              popTitle={chipLabel(w, ut)}
              to={w.kind === item.kind && w.id === item.id ? undefined : `/worklist?item=${encodeURIComponent(`${w.kind}-${w.id}`)}`}
            />
          ))}
        </AlertStrip>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-4 p-4 max-[1360px]:grid-cols-[minmax(0,1fr)_340px] max-[1180px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel
            title={ut("wlA.waits")}
            icon={item.overdue ? <Di.clockAlert /> : <WorkIcon kind={item.kind} />}
            tone={item.overdue ? "warn" : item.kind === "message" ? "info" : "violet"}
            sub={fill(ut("wlA.cameIn"), { d: day(item.since), t: hhmm(item.since) })}
          >
            <div className="flex flex-wrap items-center gap-2">
              {item.overdue ? (
                <Tag tone="attention" icon={<Di.clockAlert />}>
                  {(item.days ?? 0) > 0 ? fill(ut("dayA.overdueDays"), { n: item.days ?? 0 }) : ut("dayA.overdueWord")}
                </Tag>
              ) : (
                <Tag tone={item.kind === "message" ? "info" : "plain"} icon={<WorkIcon kind={item.kind} />}>
                  {chipLabel(item, ut)}
                </Tag>
              )}
            </div>
            <h3 className="m-0 mt-2.5 text-[18px] font-extrabold leading-6 tracking-[-0.01em] text-text">
              {fill(ut(TASK_KEY[item.kind] as never), { title: item.title })}
            </h3>
            <p className="m-0 mt-1 max-w-[70ch] text-body text-text-2">{workWhy(item, ut)}</p>
            <div className="mt-3.5 flex flex-wrap gap-2">
              {primary}
              <Button icon={<Di.notebook />} onClick={onNote}>
                {ut("wlA.note")}
              </Button>
            </div>
          </Panel>

          {plan ? <PlanPanel plan={plan} userId={item.userId} /> : null}

          <Panel flush>
            <KbdHints
              bar
              className="border-t-0"
              keys={[
                ["J K", ut("wlA.hintItems")],
                ["M", ut("wlA.hintWrite")],
                ["N", ut("wlA.hintNote")],
                ["Enter", ut("dayA.hintCard")],
                ["/", ut("wlA.hintSearch")],
              ]}
            />
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={ut("wlA.done")} icon={<Ic.history />} flush>
            {res.error ? (
              <div className="px-4 pb-4">
                <Loading bare error={res.error} onRetry={res.reload} />
              </div>
            ) : !res.data ? (
              <div className="px-4 pb-4" role="status" aria-label={ut("common.loading")}>
                <Skeleton lines={4} />
              </div>
            ) : (res.data.timeline ?? []).length === 0 ? (
              <p className="m-0 px-4 pb-4 text-small text-muted">{ut("wlA.noHistory")}</p>
            ) : (
              <ActivityList
                events={[...(res.data.timeline ?? [])]
                  .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
                  .slice(0, 7)
                  .map((t) => timelineEvent(t, ut))}
              />
            )}
          </Panel>
          <Measures dyn={dyn} loading={!res.data && !res.error} />
        </div>
      </div>
    </div>
  );
}

/** План безопасности по разделам: сколько пунктов в каждом и когда пересмотрен */
function PlanPanel({ plan, userId }: { plan: SafetyPlan; userId: string }) {
  const { ut } = useLang();
  const c = plan.content;
  const rows: { key: string; icon: ReactNode; label: string; n: number; tone?: "ok" | "warn" }[] = [
    { key: "signs", icon: <Ic.alert size={14} />, label: ut("wlA.planSigns"), n: c.warningSigns.length },
    { key: "coping", icon: <Ic.shieldCheck size={14} />, label: ut("wlA.planCoping"), n: c.copingStrategies.length },
    { key: "distract", icon: <Di.door size={14} />, label: ut("wlA.planDistract"), n: c.distractions.length },
    {
      key: "people",
      icon: <Ic.phone size={14} />,
      label: ut("wlA.planPeople"),
      n: c.people.length + c.professionals.length,
      tone: c.people.length + c.professionals.length > 0 ? "ok" : "warn",
    },
    {
      key: "means",
      icon: <Ic.lock size={14} />,
      label: ut("wlA.planMeans"),
      n: c.meansRestriction.trim() ? 1 : 0,
      tone: c.meansRestriction.trim() ? "ok" : "warn",
    },
  ];
  return (
    <Panel
      title={ut("wlA.plan")}
      icon={<Ic.shieldCheck />}
      sub={fill(ut("wlA.planVersion"), { v: plan.version, d: day(plan.reviewedAt ?? plan.createdAt) })}
      actions={<TextAction to={`/patients/${userId}/case`}>{ut("wlA.planAll")}</TextAction>}
      flush
    >
      <ul className="m-0 list-none px-4 pb-2 pt-0">
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0 border-t border-divider py-2.5 first:border-t-0">
            <span
              aria-hidden
              className={cx(
                "grid size-7 place-items-center rounded-[9px]",
                r.tone === "warn" ? "bg-warn-tint text-warn" : r.tone === "ok" ? "bg-good-tint text-good" : "bg-sunk text-muted",
              )}
            >
              {r.icon}
            </span>
            <span className="min-w-0 text-[13.5px] font-bold text-text">
              {r.label}
              <small className="block text-caption font-medium text-muted">{fill(ut("wlA.planItems"), { n: r.n })}</small>
            </span>
            {r.tone === "warn" ? (
              <Tag tone="attention">{ut("wlA.planEmpty")}</Tag>
            ) : r.tone === "ok" ? (
              <Tag tone="good" icon={<Ic.check />}>
                {ut("wlA.planFilled")}
              </Tag>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Заміри: главные шкалы двух свежих методик — значение, тяжесть словом, ход и надёжность */
function Measures({ dyn, loading }: { dyn: RespondentDynamics | null; loading: boolean }) {
  const { ut } = useLang();
  const surveys = (dyn?.surveys ?? [])
    .map((s) => ({ s, sc: s.scales.find((x) => x.points.length && x.points[x.points.length - 1]!.severity) ?? s.scales.find((x) => x.points.length) }))
    .filter((x): x is { s: RespondentDynamics["surveys"][number]; sc: NonNullable<typeof x.sc> } => !!x.sc)
    .sort((a, b) => Date.parse(b.s.lastAt ?? "") - Date.parse(a.s.lastAt ?? ""))
    .slice(0, 2);
  const first = surveys.length ? surveys.map((x) => x.s.firstAt).filter(Boolean).sort()[0] : null;
  const last = surveys.length ? surveys.map((x) => x.s.lastAt).filter(Boolean).sort().at(-1) : null;
  return (
    <Panel
      title={ut("dayA.cellMeasures")}
      icon={<Ic.clipboard />}
      sub={first && last ? fill(ut("wlA.measuresSub"), { a: day(first), b: day(last) }) : undefined}
      flush
    >
      {loading ? (
        <div className="px-4 pb-4" role="status" aria-label={ut("common.loading")}>
          <Skeleton lines={3} />
        </div>
      ) : surveys.length === 0 ? (
        <p className="m-0 px-4 pb-4 text-small text-muted">{ut("wlA.noMeasures")}</p>
      ) : (
        <BigValues className="border-t border-divider">
          {surveys.map(({ s, sc }) => {
            const pts = sc.points;
            const lastP = pts[pts.length - 1]!;
            const better = betterFromPoints(sc) ?? undefined;
            const rc = reliableThreshold(sc);
            const delta = pts.length > 1 && !sc.incomparable ? Math.round((lastP.rawScore - pts[0]!.rawScore) * 10) / 10 : null;
            return (
              <BigValue
                key={s.surveyId}
                code={s.title}
                measure={sc.title}
                better={better}
                value={num(lastP.rawScore)}
                severity={lastP.severity ? { word: lastP.bandLabel ?? ut(severityKey[lastP.severity]), level: lastP.severity } : undefined}
                history={pts.slice(-3, -1).map((p) => num(p.rawScore))}
                change={delta !== null && rc ? { delta, threshold: rc } : undefined}
              />
            );
          })}
        </BigValues>
      )}
    </Panel>
  );
}
