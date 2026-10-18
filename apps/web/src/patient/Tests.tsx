import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { SurveyListItem, SurveyResponse } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { locale } from "../format";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Callout, Ic, NotLoaded, loadView } from "../ui";
import { cx } from "../ui/cx";
import { Button, ButtonLink, Tag } from "../ui/primitives";
import { useResource, type Resource } from "../useResource";
import { Glyph } from "./icons";
import { drafts, type RunnerDraft } from "./outbox";
import { OutboxPanel } from "./OutboxStrip";
import type { PatientOutlet } from "./PatientApp";
import { Count } from "../ui/layout";
import { BandCard, Body, CodeTile, FactList, Hero, HelpLink, MetaLine, Pending, PtPanel, SideGrid, instrumentCode, instrumentName } from "./parts";
import { ResultCell, mainScore } from "./results";
import { dayOffset, dm, hm, localDayKey, whenSaid } from "./when";

type Loaded<T> = Pick<Resource<T>, "data" | "error" | "loading" | "reload" | "updatedAt">;

/**
 * «Мої тести»: что пройти и что уже пройдено (pt-tests «Виразної»).
 *
 * Список отдаёт сервер по тому, к чему у человека есть доступ, — и
 * общедоступные методики каталога сюда попадают наравне с назначенными.
 * Назначенное отделено от доступного: назначенное от человека ждут, и у
 * него бывает срок; доступное он проходит, если захочет. Одним списком без
 * различия назначенное терялось бы среди доступного, а доступное выглядело
 * бы обязательным.
 *
 * Пройденное не предлагается как новое. Сервер откажет в повторной сдаче
 * там, где методика этого не разрешает, — и отказ придёт ПОСЛЕ семидесяти
 * отвеченных пунктов. Пройденное — отдельной панелью, по дням, с
 * результатом там, где методика его показывает (showResultsToPatient), и
 * «Пройти ще раз», где повтор разрешён.
 *
 * Несданное (patient/outbox.ts) — первой панелью: ответы, которые ждут на
 * этом устройстве или которые сервер не принял, с решениями по каждой.
 */
export default function PatientTests() {
  const { user } = useAuth();
  const ctx = useOutletContext<PatientOutlet | undefined>();
  const surveys = useResource(() => api.surveys(), []);
  const responses = useResource(() => api.myResponses(), []);
  const local = user ? drafts.list(user.id) : [];
  return <TestsBody surveys={surveys} responses={responses} drafts={local} outbox={ctx?.outbox ?? null} />;
}

export function TestsBody({
  surveys,
  responses,
  drafts: local,
  outbox,
}: {
  surveys: Loaded<SurveyListItem[]>;
  responses: Loaded<{ items: SurveyResponse[] }>;
  drafts: RunnerDraft[];
  outbox: PatientOutlet["outbox"] | null;
}) {
  const { ut } = useLang();
  /* доступное всем — длинный каталог; сначала несколько, остальное по нажатию */
  const [allAnytime, setAllAnytime] = useState(false);
  /* «пройти ще раз»: null — по умолчанию (открыто, когда нового нет) */
  const [againOpen, setAgainOpen] = useState<boolean | null>(null);
  const view = loadView(surveys);
  const list = (surveys.data ?? []).filter((s) => s.status === "published");
  const draftOf = new Map(local.map((d) => [d.surveyId, d]));
  const queued = new Set((outbox?.waiting ?? []).map((i) => i.surveyId));
  const open = list.filter((s) => (!s.completedByMe || draftOf.has(s.id)) && !queued.has(s.id));
  /* спершу почате, далі назначенное по сроку, потом доступное — как сказано в подписи панели */
  const rank = (s: SurveyListItem) => (draftOf.has(s.id) ? 0 : s.assigned ? 1 : 2);
  const todo = [...open].sort(
    (a, b) => rank(a) - rank(b) || (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"),
  );
  const fromSpecialist = todo.filter((s) => rank(s) < 2);
  const anytime = todo.filter((s) => rank(s) === 2);
  /*
   * Пройденное не зовётся как новое, но и не прячется: где методика
   * разрешает повтор (allowRetake), её можно пройти ещё раз — последней
   * группой, с датой прошлого раза. Когда нового нет, группа открыта; когда
   * есть — свёрнута, чтобы назначенное не терялось в каталоге.
   */
  const again = list.filter((s) => s.completedByMe && s.allowRetake && !draftOf.has(s.id) && !queued.has(s.id));
  const lastTaken = new Map<string, string>();
  for (const r of responses.data?.items ?? []) {
    if (r.status !== "completed" || !r.submittedAt) continue;
    const seen = lastTaken.get(r.surveyId);
    if (!seen || seen < r.submittedAt) lastTaken.set(r.surveyId, r.submittedAt);
  }
  const showAgain = againOpen ?? todo.length === 0;
  const pending = outbox ? outbox.waiting.length + outbox.rejected.length : 0;

  const assigned = list.filter((s) => s.assigned);
  const assignedOpen = assigned.filter((s) => !s.completedByMe);
  const nearestDue = assignedOpen.map((s) => s.dueAt).filter((d): d is string => !!d).sort()[0] ?? null;

  const aside = assigned.length ? (
    <BandCard>
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-control bg-violet-tint text-violet-ink supports-[corner-shape:squircle]:rounded-[14px] supports-[corner-shape:squircle]:[corner-shape:squircle]"
        >
          <Ic.layers size={17} />
        </span>
        <b className="text-[16px] font-extrabold">{ut("ptw.fromSpecialist")}</b>
        <span className="ml-auto">
          <Tag tone={assignedOpen.length ? "primary" : "good"} icon={assignedOpen.length ? undefined : <Ic.check size={12} />}>
            {ut("qi.pointOf").replace("{n}", String(assigned.length - assignedOpen.length)).replace("{max}", String(assigned.length))}
          </Tag>
        </span>
      </div>
      <p className="m-0 mt-2 text-[15px] leading-[22px] text-text-2">
        {!assignedOpen.length
          ? ut("ptw.setAllDone")
          : nearestDue
            ? ut("ptw.setDue").replace("{d}", dm(nearestDue))
            : ut("ptw.setNoDue")}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {assigned.map((s) => (
          <span
            key={s.id}
            className={cx(
              "inline-flex h-8 items-center gap-1.5 rounded-[16px] px-3 text-[14px] font-bold",
              s.completedByMe ? "bg-good-tint text-good" : "bg-sunk text-text-2",
            )}
          >
            {s.completedByMe ? <Ic.check size={14} /> : null}
            {instrumentCode(s.title) ?? instrumentName(s.title)}
          </span>
        ))}
      </div>
    </BandCard>
  ) : null;

  return (
    <>
      <Hero
        title={ut("pt.titleTests")}
        lead={pending ? ut("ptw.testsLeadPending").replace("{n}", String(pending)) : ut("ptw.testsLead")}
        aside={aside}
      />
      <Body>
        <SideGrid
          side={
            pending && outbox ? (
              <>
                <PtPanel title={ut("ptw.howItWorks")} icon={<ShellIcon name="circle-help" size={16} />}>
                  <FactList
                    items={[
                      { key: "device", icon: <Glyph name="hard-drive" size={16} />, title: ut("ptw.obDevice"), text: ut("ptw.obDeviceText") },
                      { key: "auto", icon: <Ic.refresh size={16} />, title: ut("ptw.obAuto"), text: ut("ptw.obAutoText") },
                      { key: "exit", icon: <ShellIcon name="log-out" size={16} />, title: ut("ptw.obExit"), text: ut("ptw.obExitText") },
                      { key: "seen", icon: <Ic.eye size={16} />, title: ut("ptw.obSeen"), text: ut("ptw.obSeenText") },
                    ]}
                  />
                </PtPanel>
                <HelpLink />
              </>
            ) : (
              <>
                <PtPanel title={ut("ptw.afterTest")} icon={<Ic.sparkle size={16} />}>
                  <FactList
                    items={[
                      { key: "shown", icon: <Ic.eye size={16} />, title: ut("ptw.afterShown"), text: ut("ptw.afterShownText") },
                      { key: "hidden", icon: <Glyph name="message-more" size={16} />, title: ut("ptw.afterHidden"), text: ut("ptw.afterHiddenText") },
                      { key: "help", icon: <Glyph name="heart-handshake" size={16} />, title: ut("ptw.afterHelp"), text: ut("ptw.afterHelpText") },
                    ]}
                  />
                </PtPanel>
                <PtPanel title={ut("ptw.whoSees")} icon={<Glyph name="lock-keyhole" size={16} />}>
                  <p className="m-0 text-[15.5px] leading-[23px] text-text">{ut("ptw.whoSeesText")}</p>
                  <Callout kind="neutral" icon={<ShellIcon name="wifi-off" size={16} />} title={ut("ptw.noConnection")} className="mt-3 text-[15px] leading-[22px]">
                    {ut("ptw.noConnectionText")}
                  </Callout>
                </PtPanel>
              </>
            )
          }
        >
          {outbox ? <OutboxPanel outbox={outbox} /> : null}
          {view === "wait" || view === "failed" ? (
            <NotLoaded res={surveys} rows={4} />
          ) : (
            <PtPanel
              title={ut("ptw.toTake")}
              icon={<ShellIcon name="clipboard-list" size={16} />}
              count={todo.length}
              sub={pending ? ut("ptw.toTakeSubPending") : ut("ptw.toTakeSub")}
              flush
            >
              {todo.length === 0 ? (
                <p className="m-0 px-[18px] pb-[18px] text-[16px] text-muted">{ut("pt.noTests")}</p>
              ) : null}
              {todo.length === 0 ? null : (
                <>
                  {fromSpecialist.map((s, i) => (
                    <TodoRow key={s.id} survey={s} draft={draftOf.get(s.id) ?? null} primary={i === 0} />
                  ))}
                  {anytime.length ? (
                    <>
                      {fromSpecialist.length ? (
                        <div className="flex items-center gap-2 border-t border-divider bg-panel-2 px-[18px] py-2.5 text-[14px] font-extrabold text-text">
                          <Glyph name="infinity" size={16} className="text-muted" />
                          {ut("ptw.anytime")}
                          <span className="font-semibold text-muted">{ut("ptw.anytimeSub")}</span>
                        </div>
                      ) : null}
                      {(allAnytime ? anytime : anytime.slice(0, ANYTIME_SHOWN)).map((s, i) => (
                        <TodoRow key={s.id} survey={s} draft={null} primary={!fromSpecialist.length && i === 0} />
                      ))}
                      {anytime.length > ANYTIME_SHOWN ? (
                        <div className="border-t border-divider px-[18px] py-3">
                          <Button
                            variant="ghost"
                            aria-expanded={allAnytime}
                            icon={<Ic.chevronDown size={16} className={cx("transition-transform", allAnytime && "rotate-180")} />}
                            onClick={() => setAllAnytime(!allAnytime)}
                          >
                            {allAnytime
                              ? ut("ptw.showFewer")
                              : ut("ptw.showAll").replace("{n}", String(anytime.length - ANYTIME_SHOWN))}
                          </Button>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </>
              )}
              {again.length ? (
                <>
                  <button
                    type="button"
                    aria-expanded={showAgain}
                    onClick={() => setAgainOpen(!showAgain)}
                    className="flex w-full items-center gap-2 border-0 border-t border-solid border-divider bg-panel-2 px-[18px] py-2.5 text-left text-[14px] font-extrabold text-text transition-colors hover:bg-sunk focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
                  >
                    <Glyph name="rotate-ccw" size={16} className="shrink-0 text-muted" />
                    {ut("ptw.againGroup")}
                    <Count n={again.length} />
                    <span className="min-w-0 font-semibold text-muted max-[600px]:hidden">{ut("ptw.againGroupSub")}</span>
                    <Ic.chevronDown size={16} className={cx("ml-auto shrink-0 text-muted transition-transform", showAgain && "rotate-180")} />
                  </button>
                  {showAgain
                    ? again.map((s) => <TodoRow key={s.id} survey={s} draft={null} primary={false} again={lastTaken.get(s.id) ?? ""} />)
                    : null}
                </>
              ) : null}
            </PtPanel>
          )}
        </SideGrid>
        <DonePanel responses={responses} surveys={list} className="mt-5" />
      </Body>
    </>
  );
}

/** Сколько методик «коли захочете» видно сразу: каталог длинный, а назначенное не должно в нём теряться */
const ANYTIME_SHOWN = 4;

/** Строка «пройти»: плитка с кодом, название и почему здесь, действие справа */
function TodoRow({
  survey: s,
  draft,
  primary,
  again,
}: {
  survey: SurveyListItem;
  draft: RunnerDraft | null;
  primary: boolean;
  /** Пройдено раньше, повтор разрешён: когда проходили в последний раз («» — неизвестно) */
  again?: string;
}) {
  const { ut } = useLang();
  const action = again !== undefined ? ut("ptw.again") : draft ? ut("ptw.continue") : ut("pt.start");
  const meta = [
    { key: "n", icon: <ShellIcon name="list-checks" size={15} />, text: `${ut("ms.questions")}: ${s.questionCount}` },
    ...(again !== undefined
      ? again
        ? [{ key: "done", icon: <Ic.circleCheck size={15} />, text: `${ut("ptw.takenLast")} ${whenSaid(again, ut)}` }]
        : []
      : draft
      ? [
          { key: "start", icon: <Glyph name="clock" size={15} />, text: `${ut("ptw.startedWhen")} ${whenSaid(draft.startedAt, ut)}` },
          { key: "dev", icon: <Glyph name="hard-drive" size={15} />, text: ut("ptw.savedHere") },
        ]
      : s.assigned
        ? [{ key: "who", icon: <Glyph name="user-round" size={15} />, text: ut("ptw.assignedBySpecialist") }]
        : [{ key: "any", icon: <Glyph name="infinity" size={15} />, text: ut("ptw.noDeadline") }]),
  ];
  const left = s.dueAt ? dayOffset(s.dueAt) : null;
  return (
    <div
      className={cx(
        "grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-x-4 border-t border-divider px-[18px] py-4 first:border-t-0 max-[600px]:grid-cols-[48px_minmax(0,1fr)] max-[600px]:gap-y-3",
        draft && "bg-panel-2",
      )}
    >
      <CodeTile title={s.title} tone={draft || !s.assigned ? "neutral" : "violet"} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[17px] font-extrabold leading-6 tracking-[-0.01em] text-text">
          <span className="min-w-0">{instrumentName(s.title)}</span>
          {draft ? (
            <Tag icon={<Glyph name="hourglass" size={12} />}>{ut("ptw.started")}</Tag>
          ) : s.dueAt ? (
            <Tag tone={left !== null && left <= 1 ? "attention" : "primary"} icon={<Ic.calendar size={12} />}>
              {left !== null && left >= 0
                ? ut("ptw.dueLeft").replace("{d}", dm(s.dueAt)).replace("{n}", String(left))
                : `${ut("ptw.dueUntil")} ${dm(s.dueAt)}`}
            </Tag>
          ) : s.assigned ? (
            <Tag tone="primary">{ut("pt.assigned")}</Tag>
          ) : null}
        </div>
        <MetaLine items={meta} />
        {draft && draft.total > 0 ? (
          <div
            role="progressbar"
            aria-label={ut("pw.progress")}
            aria-valuemin={0}
            aria-valuemax={draft.total}
            aria-valuenow={draft.answered}
            aria-valuetext={`${draft.answered} ${ut("common.of")} ${draft.total}`}
            className="mt-2.5 h-2 w-[260px] max-w-full overflow-hidden rounded-[4px] bg-track"
          >
            <span
              className="block h-full rounded-[4px] bg-[var(--vring)]"
              style={{ width: `${Math.round((draft.answered / draft.total) * 100)}%` }}
            />
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 max-[600px]:col-span-2">
        <ButtonLink
          to={`/me/tests/${s.id}`}
          variant={primary ? "primary" : "secondary"}
          size="md"
          className="max-[600px]:w-full"
        >
          {draft ? <Glyph name="play" size={16} /> : null}
          {action}
          {/* чью методику — диктору и поиску по ссылке: кнопок «Пройти» в списке много */}
          <span className="sr-only">{`: ${s.title}`}</span>
          {primary && !draft ? <Ic.arrowRight size={17} /> : null}
        </ButtonLink>
      </div>
    </div>
  );
}

/**
 * «Пройдені» — по дням: последний день раскрыт, прежние свёрнуты строкой с
 * кодами методик. Результат — только где его прислал сервер; иначе —
 * «пояснить фахівець». У последнего прохождения методики, где повтор
 * разрешён, — «Пройти ще раз».
 */
function DonePanel({
  responses,
  surveys,
  className,
}: {
  responses: Loaded<{ items: SurveyResponse[] }>;
  surveys: SurveyListItem[];
  className?: string;
}) {
  const { ut } = useLang();
  const [openDays, setOpenDays] = useState<Set<string>>(new Set());
  const view = loadView(responses);
  const items = (responses.data?.items ?? [])
    .filter((r) => r.status === "completed" && r.submittedAt)
    .sort((a, b) => b.submittedAt!.localeCompare(a.submittedAt!));
  if (view === "ready" && !items.length) return null;
  if (view === "empty") return null;

  const byId = new Map(surveys.map((s) => [s.id, s]));
  const days: { key: string; rows: SurveyResponse[] }[] = [];
  for (const r of items) {
    const key = localDayKey(r.submittedAt!);
    const day = days.find((d) => d.key === key);
    if (day) day.rows.push(r);
    else days.push({ key, rows: [r] });
  }
  const before = (r: SurveyResponse) => {
    const prev = items.find((x) => x.surveyId === r.surveyId && x.submittedAt! < r.submittedAt! && mainScore(x.scores));
    return prev ? { at: prev.submittedAt!, score: mainScore(prev.scores)! } : null;
  };
  const dayTitle = (key: string, iso: string) => {
    const off = dayOffset(iso);
    if (off === 0) return `${ut("ptw.todayCap")}, ${dm(iso)}`;
    if (off === -1) return `${ut("ptw.yesterdayCap")}, ${dm(iso)}`;
    return new Date(`${key}T12:00:00`).toLocaleDateString(locale(), { day: "numeric", month: "long" });
  };

  return (
    <PtPanel
      title={ut("ptw.done")}
      icon={<Ic.circleCheck size={16} />}
      count={items.length || null}
      sub={ut("ptw.doneSub")}
      flush
      className={className}
    >
      {view === "wait" || view === "failed" ? (
        <div className="px-[18px] pb-[18px]">
          <Pending res={responses} />
        </div>
      ) : (
        days.map((day, i) => {
          const expanded = i === 0 || openDays.has(day.key);
          const title = dayTitle(day.key, day.rows[0]!.submittedAt!);
          const rows = day.rows.map((r) => {
            const s = byId.get(r.surveyId);
            const name = s?.title ?? ut("pt.outboxItem");
            const score = mainScore(r.scores);
            return (
              <div
                key={r.id}
                className="grid grid-cols-[40px_minmax(0,1fr)_minmax(0,330px)] items-center gap-x-3.5 border-t border-divider px-[18px] py-[13px] max-[760px]:grid-cols-[40px_minmax(0,1fr)] max-[760px]:gap-y-2"
              >
                <CodeTile title={name} tone="neutral" small />
                <div className="min-w-0">
                  <div className="truncate text-[15.5px] font-bold leading-[22px] text-text">{instrumentName(name)}</div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] leading-[19px] text-text-2">
                    <span className="inline-flex items-center gap-1.5">
                      <Ic.circleCheck size={15} className="text-good" />
                      {`${ut("ptw.sentAtLower")} ${i === 0 && dayOffset(r.submittedAt!) === 0 ? hm(r.submittedAt!) : whenSaid(r.submittedAt!, ut)}`}
                    </span>
                  </div>
                </div>
                <div className="max-[760px]:col-span-2 max-[760px]:pl-[54px]">
                  {score ? (
                    <ResultCell score={score} before={before(r)} className="max-[760px]:text-left" />
                  ) : s?.scoringEnabled !== false ? (
                    <div className="flex items-center justify-end gap-2 text-right text-[14px] leading-[19px] text-text-2 max-[760px]:justify-start max-[760px]:text-left">
                      <Glyph name="message-more" size={17} className="shrink-0 text-violet-ink" />
                      {ut("ptw.resultBySpecialist")}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          });
          if (i === 0) {
            return (
              <div key={day.key}>
                <div className="flex items-center gap-2 px-[18px] pb-2.5 pt-1 text-[14px] font-extrabold leading-5 text-text">
                  <Ic.calendar size={16} className="text-muted" />
                  {title}
                </div>
                {rows}
              </div>
            );
          }
          const codes = [...new Set(day.rows.map((r) => byId.get(r.surveyId)?.title ?? ""))].filter(Boolean);
          return (
            <div key={day.key}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() =>
                  setOpenDays((prev) => {
                    const next = new Set(prev);
                    if (next.has(day.key)) next.delete(day.key);
                    else next.add(day.key);
                    return next;
                  })
                }
                className="grid w-full grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-3.5 border-0 border-t border-solid border-divider bg-transparent px-[18px] py-[13px] text-left transition-colors hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus"
              >
                <span className="grid w-10 place-items-center text-muted">
                  <Ic.chevronRight size={18} className={cx("transition-transform", expanded && "rotate-90")} />
                </span>
                <span className="min-w-0">
                  <b className="block text-[15.5px] font-bold leading-[22px] text-text">{title}</b>
                  <small className="block text-[13.5px] leading-[19px] text-muted">
                    {`${ut("ptw.testsCount")}: ${day.rows.length}`}
                  </small>
                </span>
                <span className="flex flex-wrap justify-end gap-1.5 max-[600px]:hidden">
                  {codes.slice(0, 5).map((t) => (
                    <span
                      key={t}
                      className="inline-block h-[26px] max-w-[160px] truncate rounded-[13px] bg-sunk px-[9px] text-[12.5px] font-bold leading-[26px] text-text-2"
                    >
                      {instrumentCode(t) ?? instrumentName(t)}
                    </span>
                  ))}
                </span>
              </button>
              {expanded ? <div className="bg-panel-2">{rows}</div> : null}
            </div>
          );
        })
      )}
    </PtPanel>
  );
}
