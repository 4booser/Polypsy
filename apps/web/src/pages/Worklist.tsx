import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { WorkItem, WorkKind } from "@quizzy/shared";
import { api } from "../api";
import { Empty, KbdHints, ListGroup, ListTile, Loading, SearchField, useUrlState, ViewPills } from "../ui";
import { Ic } from "../ui/icons";
import { Tag } from "../ui/primitives";
import { useLang } from "../lang";
import { useDebounced, useResource } from "../useResource";
import { useLiveReload } from "../events";
import { fill } from "./dashboard/model";
import { chipLabel, stamp, WorkIcon } from "./today/ActNow";
import { useDayDrawer } from "./today/drawers";
import { Di } from "./today/icons";
import { useCodeKeys } from "./today/keys";
import { WorkRecord } from "./worklist/Record";
import { FILTER_KEY, isWorkView, shownWork, stepWork, workGroups, workKey, workWhy, type WorkView } from "./worklist/model";

/**
 * «Черга роботи» — список и запись (кадр day-worklist Polypsy 2.0).
 *
 * Слева — всё входящее: каждая строка говорит, почему пункт здесь и что
 * дальше; группы «Прострочено» и «Нове й вхідне», давнее раньше. Справа —
 * выбранный пункт: что ждёт и до чего, план безопасности, что уже делали,
 * заміри. Ответ и нотатка — в ящике, страница стоит на месте.
 *
 * Экран не подменяет те, где с пунктом работают (случаи, карта,
 * направления): там разбирают, здесь видят, за что взяться. Выбранный пункт,
 * вид и поиск живут в адресе — «вот эти семь» отправляются коллеге как есть,
 * а плитки зведення ведут сразу в отобранный вид.
 */

/**
 * Сколько выбор пункта должен простоять, прежде чем запись грузит хронологию,
 * заміри и план безопасности: J/K не должны читать и писать в журнал доступа
 * каждого, мимо кого прошли (WorkRecord, settled).
 */
const RECORD_SETTLE_MS = 500;

const NEXT_KEY: Record<WorkKind, string> = {
  message: "wlA.nextMessage",
  noshow: "wlA.nextNoshow",
  dispensary: "wlA.nextDispensary",
  followup: "wlA.nextFollowup",
  referral: "wlA.nextReferral",
  assignment: "wlA.nextAssignment",
};

export default function WorklistPage() {
  const { ut } = useLang();
  const navigate = useNavigate();
  const [kindRaw, setKind] = useUrlState("kind");
  const [q, setQ] = useUrlState("q");
  const [picked, setPicked] = useUrlState("item");
  const res = useResource(() => api.worklist(), []);
  useLiveReload(["alert.created", "case.changed", "response.submitted", "schedule.run"], res.reload);
  const { drawer, openReply, openNote, isOpen } = useDayDrawer(res.reload);
  const listRef = useRef<HTMLDivElement>(null);

  const view: WorkView = isWorkView(kindRaw) ? kindRaw : "";
  const data = res.data;
  const why = (i: WorkItem) => workWhy(i, ut);
  const shown = useMemo(() => (data ? shownWork(data.items, view, q, (i) => workWhy(i, ut)) : []), [data, view, q, ut]);
  const groups = workGroups(shown);
  const ordered = groups.flatMap((g) => g.items);
  const keys = ordered.map(workKey);
  const current = ordered.find((i) => workKey(i) === picked) ?? data?.items.find((i) => workKey(i) === picked) ?? ordered[0] ?? null;
  const overdue = data ? data.items.filter((i) => i.overdue).length : 0;
  const currentKey = current ? workKey(current) : null;
  const settledKey = useDebounced(currentKey, RECORD_SETTLE_MS);

  const select = (key: string | null) => {
    if (!key) return;
    setPicked(key);
    requestAnimationFrame(() =>
      listRef.current?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" }),
    );
  };
  const reply = () => current && openReply({ patientId: current.userId, patientName: current.userName, threadId: current.kind === "message" ? current.id : null });
  const note = () => current && openNote({ patientId: current.userId, patientName: current.userName });

  useCodeKeys(
    {
      KeyJ: () => select(stepWork(keys, current ? workKey(current) : null, 1)),
      KeyK: () => select(stepWork(keys, current ? workKey(current) : null, -1)),
      KeyM: current ? reply : undefined,
      KeyN: current ? note : undefined,
    },
    !isOpen,
  );
  /* Enter без фокуса на кнопке или ссылке — карта выбранного */
  useEffect(() => {
    if (isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      if (current) navigate(`/patients/${current.userId}`);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, current, navigate]);

  /* виды — по тому, что в очереди есть: вкладка с нулём ведёт в пустоту */
  const views = data
    ? [
        { key: "", label: ut("work.all"), count: data.total },
        ...(overdue ? [{ key: "overdue", label: ut("wlA.viewOverdue"), count: overdue }] : []),
        ...(Object.keys(FILTER_KEY) as WorkKind[])
          .filter((k) => (data.byKind[k] ?? 0) > 0)
          .map((k) => ({ key: k, label: ut(FILTER_KEY[k]), count: data.byKind[k] })),
      ]
    : [];

  return (
    <div className="flex min-h-0 flex-1 max-[900px]:flex-col max-[900px]:overflow-y-auto">
      <aside
        aria-label={ut("work.title")}
        className="flex w-[380px] shrink-0 flex-col border-r border-border bg-panel max-[1180px]:w-[340px] max-[900px]:max-h-[60vh] max-[900px]:w-full max-[900px]:border-b max-[900px]:border-r-0"
      >
        <div className="shrink-0 px-4 pb-2 pt-4">
          <div className="flex items-baseline gap-2">
            <h1 className="m-0 text-[22px] font-extrabold tracking-[-0.02em] text-text">{ut("work.title")}</h1>
            {data ? <span className="text-[17px] font-bold text-muted tabular-nums">{data.total}</span> : null}
          </div>
          <SearchField value={q} onChange={setQ} placeholder={ut("wlA.searchPh")} width={0} slash className="mt-3" />
          {views.length > 1 ? (
            <ViewPills className="mt-3" items={views} value={view} onChange={(v) => setKind(v)} label={ut("wlA.views")} />
          ) : null}
          <p className="m-0 mt-2.5 flex items-center gap-1.5 text-caption text-muted">
            <Ic.sortDesc size={13} />
            {ut("wlA.order")}
          </p>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto border-t border-divider pb-3 pt-1">
          {res.error && !data ? (
            <div className="p-4">
              <Loading bare error={res.error} onRetry={res.reload} />
            </div>
          ) : !data ? (
            <div className="p-4">
              <Loading bare rows={6} />
            </div>
          ) : shown.length === 0 ? (
            <div className="p-4">
              <Empty compact title={data.total ? ut("wlA.nothingFound") : ut("work.done")} hint={data.total ? undefined : ut("work.doneHint")} />
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.key}>
                <ListGroup
                  label={ut(g.key === "overdue" ? "wlA.groupOverdue" : "wlA.groupNew")}
                  count={g.items.length}
                  mark={g.key === "overdue" ? "warn" : "violet"}
                  note={ut(g.key === "overdue" ? "wlA.groupOverdueNote" : "wlA.groupNewNote")}
                />
                {g.items.map((i) => (
                  <div key={workKey(i)} data-key={workKey(i)}>
                    <ListTile
                      title={i.userName}
                      meta={stamp(i.since)}
                      unread={i.kind === "message"}
                      selected={current ? workKey(current) === workKey(i) : false}
                      onClick={() => select(workKey(i))}
                      reason={
                        <Tag
                          tone={i.overdue || i.kind === "noshow" ? "attention" : i.kind === "message" ? "info" : "plain"}
                          icon={<WorkIcon kind={i.kind} size={12} />}
                        >
                          {chipLabel(i, ut)}
                        </Tag>
                      }
                      why={why(i)}
                      next={fill(ut(NEXT_KEY[i.kind] as never), { title: i.title })}
                      nextIcon={<Di.outLink />}
                      when={i.unit ?? undefined}
                    />
                  </div>
                ))}
              </div>
            ))
          )}
          {data?.truncated ? <p className="m-0 px-5 pt-3 text-caption text-muted">{ut("work.truncated")}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-3 border-t border-divider px-4 py-2.5">
          <KbdHints keys={[["J K", ut("wlA.hintRows")], ["Enter", ut("dayA.hintCard")]]} />
          {data ? (
            <span className="ml-auto text-caption font-semibold text-muted tabular-nums">
              {fill(ut("wlA.shownOf"), { n: shown.length, of: data.total })}
            </span>
          ) : null}
        </div>
      </aside>
      <section
        aria-label={current ? current.userName : ut("work.title")}
        className="min-w-0 flex-1 overflow-y-auto bg-ground pb-6 max-[900px]:flex-none max-[900px]:overflow-visible"
        tabIndex={-1}
      >
        {current ? (
          <WorkRecord
            key={workKey(current)}
            item={current}
            all={(data?.items ?? []).filter((i) => i.userId === current.userId)}
            onReply={reply}
            onNote={note}
            settled={settledKey === currentKey}
          />
        ) : data ? (
          <div className="p-8">
            <Empty title={ut("work.done")} hint={ut("work.doneHint")} />
          </div>
        ) : null}
      </section>
      {drawer}
    </div>
  );
}
