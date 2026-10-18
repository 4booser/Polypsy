import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { RiskAlert } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { day, dayFull, dayKey, timeOfDay } from "../format";
import { Empty, Ic, KbdHints, NotLoaded, SearchField, Tooltip, ViewPills, loadView, useAction, useHotkeys, useUrlState, type LoadView } from "../ui";
import { cx } from "../ui/cx";
import { Count, Panel } from "../ui/layout";
import { Button, Field, Tag, Textarea } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource, type Resource } from "../useResource";
import { Mi } from "./messages/icons";
import {
  daysFrom,
  feedByDay,
  orderThreads,
  stepThread,
  threadInView,
  threadMatches,
  threadViewCounts,
  unansweredId,
  viewFrom,
  waitsForReply,
  type ThreadRow,
} from "./messages/model";
import { ComposeDrawer, MoveDrawer, RecordBanner, RecordSide, RiskCallout, visitShort } from "./messages/thread";

type ThreadPage = Awaited<ReturnType<typeof api.thread>>;
type ThreadItem = ThreadPage["items"][number];

/**
 * Разговор, открытый по адресу, — только из ответа на ЭТОТ разговор.
 *
 * Слой загрузки держит прежний ответ, пока едет новый (keepPreviousData), —
 * для таблиц это хорошо, для переписки нет: при переходе от одного
 * пациента к другому письма первого стояли под именем второго, пока не
 * приедет ответ, и по ним же уходила отметка «прочитано» с адресом чужого
 * разговора. Ответ несёт свой id; не тот — значит, своего ещё нет.
 */
export function ownThread(
  res: Pick<Resource<ThreadPage | null>, "data" | "error" | "updatedAt">,
  id: string | undefined,
): { view: LoadView; data: ThreadPage | null } {
  const data = id && res.data && res.data.id === id ? res.data : null;
  const view = loadView({ data, error: res.error, updatedAt: data ? res.updatedAt : null }, (d) => d.items.length === 0);
  return { view, data };
}

/**
 * Набранный ответ — свой у каждого разговора (#177).
 *
 * Поле было одно на экран: экран переписки не пересоздаётся при переходе
 * к другому разговору (тот же маршрут /messages/:id), и набранное пациенту
 * A оставалось в поле под разговором с B — и уходило B. Теперь черновики
 * лежат по id разговора: после перехода поле пусто или держит черновик
 * этого разговора, а вернувшись к A, человек находит своё. Ящик переноса
 * пишет в тот же черновик: ответ, начатый под лентой, продолжается там.
 */
export type ThreadDrafts = Readonly<Record<string, string>>;

/** Что стоит в поле открытого разговора */
export function draftIn(drafts: ThreadDrafts, id: string | undefined): string {
  return id ? (drafts[id] ?? "") : "";
}

/** Набранное — в черновик своего разговора */
export function withDraft(drafts: ThreadDrafts, id: string, text: string): ThreadDrafts {
  return { ...drafts, [id]: text };
}

/**
 * Письмо ушло — черновик его разговора стирается, если пока шла отправка
 * его не дописали; другие разговоры не трогаются.
 */
export function afterSent(drafts: ThreadDrafts, id: string, sent: string): ThreadDrafts {
  return drafts[id] === sent ? withDraft(drafts, id, "") : drafts;
}

/** «сьогодні» / «учора, 7 жовтня» / «пт, 25 вересня» — разделитель дня в ленте */
function useDayLabel() {
  const { ut } = useLang();
  return (iso: string) => {
    const d = daysFrom(iso, Date.now());
    if (d === 0) return ut("msx.today");
    if (d === -1) return `${ut("msx.yesterday")}, ${dayFull(iso).replace(/^[^,]*,\s*/, "")}`;
    return dayFull(iso);
  };
}

/**
 * Лента писем по состоянию загрузки. «Повідомлень ще немає» — только когда
 * сервер ответил пустым разговором; до ответа — скелет, на отказе — отказ с
 * «Повторити» (раньше на отказе стояло то же «ще немає»).
 *
 * Письма — пузырями, как в ящике разговора набора: свои справа на
 * фиолетовой тонировке с отметкой «прочитано», собеседника слева; дни
 * разделены строкой. Последнее письмо пациента, оставшееся без ответа,
 * обведено янтарём.
 */
export function ThreadFeed({
  view,
  items,
  res,
  who,
}: {
  view: LoadView;
  items: ThreadItem[];
  res: Pick<Resource<unknown>, "error" | "loading" | "reload">;
  /** Как подписать письма собеседника: имя без фамилии */
  who?: string;
}) {
  const { ut } = useLang();
  const dayLabel = useDayLabel();
  if (view === "wait" || view === "failed") return <NotLoaded res={res} />;
  if (items.length === 0) return <Empty title={ut("ms.empty")} compact />;
  const waiting = unansweredId(items);
  return (
    <>
      {feedByDay(items, (iso) => dayKey(iso)).map((group) => (
        <div key={group.key} className="flex flex-col gap-2.5">
          <div className="mt-1.5 flex items-center gap-2.5 text-caption font-bold text-muted before:h-px before:flex-1 before:bg-divider after:h-px after:flex-1 after:bg-divider">
            {dayLabel(group.items[0]!.sentAt)}
          </div>
          {group.items.map((m) => (
            <div
              key={m.id}
              className={cx(
                "max-w-[76%] rounded-[16px] px-3.5 py-2.5 text-body leading-5 text-text max-[700px]:max-w-[90%]",
                m.mine ? "self-end rounded-br-[6px] bg-violet-tint" : "self-start rounded-bl-[6px] bg-sunk",
                m.id === waiting && "shadow-[inset_0_0_0_1.5px_var(--warnline)]",
              )}
            >
              <p className="m-0 whitespace-pre-wrap break-words">{m.text}</p>
              <small
                className={cx(
                  "mt-[3px] flex items-center gap-1 text-[11.5px] leading-[15px] text-muted",
                  m.mine && "justify-end",
                )}
              >
                {m.mine ? (
                  <>
                    {ut("msx.you")}, {timeOfDay(m.sentAt)}
                    {m.readAt ? <Ic.checkCheck size={12} /> : <Ic.check size={12} />}
                    {m.readAt ? ut("ms.read") : ut("ms.sent")}
                  </>
                ) : (
                  <>
                    {who ? `${who}, ` : ""}
                    {timeOfDay(m.sentAt)}
                    {m.id === waiting ? `, ${ut("msx.noReply")}` : ""}
                  </>
                )}
              </small>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

/** «16:20» сегодня, «учора», иначе «7 жовт.» — время в строке списка */
function useWhen() {
  const { ut } = useLang();
  return (iso: string) => {
    const d = daysFrom(iso, Date.now());
    if (d === 0) return timeOfDay(iso);
    if (d === -1) return ut("msx.yesterday");
    return day(iso);
  };
}

/** Имя без фамилии — подпись писем собеседника: «Мельник Андрій Олегович» → «Андрій» */
const firstNameOf = (full: string) => full.trim().split(/\s+/)[1] ?? full.trim();

/**
 * Листування — список и запись (comms-messages).
 *
 * Слева разговоры: спершу ті, що чекають відповіді, с причиной в строке —
 * сигнал риска, «чекає відповіді», прочитал ли пациент ваш ответ, — и
 * ближайшим приёмом. Справа открытый разговор как запись о человеке:
 * карточка со строкой открытого, лента, ответ, ближайший приём, заміри.
 * Перенос приёма и новое сообщение — в ящике, страница остаётся на месте.
 *
 * Границы названы в самом окне, а не в правилах: ответ в рабочее время, это
 * не экстренная связь. Пациент видит ту же строку у себя — обещание
 * круглосуточного ответа в психологическом отделе опаснее отсутствия
 * переписки вовсе.
 */
export default function MessagesPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { ut } = useLang();
  const { user, can } = useAuth();
  const { run, busy } = useAction();
  const when = useWhen();
  const [drafts, setDrafts] = useState<ThreadDrafts>({});
  const text = draftIn(drafts, id);
  const [viewRaw, setView] = useUrlState("view");
  const view = viewFrom(viewRaw);
  const [q, setQ] = useState("");
  const [listHidden, setListHidden] = useState(false);
  const [drawer, setDrawer] = useState<"move" | "compose" | null>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  const list = useResource(() => api.threads(), []);
  const thread = useResource(() => (id ? api.thread(id) : Promise.resolve(null)), [id]);
  /*
   * Открытые сигналы риска — одним запросом на экран: по ним строка списка
   * получает пилюлю сигнала, а запись — красную заметку «розберіть до
   * відповіді». Нет права разбирать случаи — нет и пилюль, экран работает.
   */
  const alerts = useResource(() => api.alerts().catch(() => null), []);
  /*
   * Более ранние письма, подгруженные «Попередні повідомлення». Сервер отдаёт
   * последние письма и курсор назад (до волны 12 — первые пятьсот, и с пятьсот
   * первого новые письма пропадали с экрана).
   */
  const [older, setOlder] = useState<{ threadId: string; items: ThreadItem[]; before: string | null } | null>(null);
  const earlier = older && older.threadId === id ? older : null;
  const own = ownThread(thread, id);
  const shown = [...(earlier?.items ?? []), ...(own.data?.items ?? [])];
  const before = earlier ? earlier.before : (own.data?.hasMore ? own.data.nextBefore : null);

  /*
   * «Прочитано» — отдельным запросом и только по показанным письмам
   * собеседника: открытие разговора ничего не помечает само.
   */
  const unreadShown = shown.filter((m) => !m.mine && !m.readAt).map((m) => m.id);
  const unreadKey = unreadShown.join(",");
  useEffect(() => {
    if (!id || !unreadKey) return;
    void api
      .markRead(id, unreadKey.split(","))
      .then(() => list.reload())
      .catch(() => {});
    // перезапуск — только по набору непрочитанных показанных писем
  }, [id, unreadKey]);

  const items: ThreadRow[] = list.data?.items ?? [];
  const risksBy = useMemo(() => {
    const out = new Map<string, RiskAlert[]>();
    for (const a of alerts.data ?? []) {
      if (!a.userId) continue;
      const mine = out.get(a.userId);
      if (mine) mine.push(a);
      else out.set(a.userId, [a]);
    }
    return out;
  }, [alerts.data]);
  const risksOf = (pid: string | undefined) => (pid ? (risksBy.get(pid) ?? []) : []);
  const ordered = useMemo(() => orderThreads(items, (pid) => !!pid && risksBy.has(pid)), [items, risksBy]);
  const counts = threadViewCounts(items);
  const visible = ordered.filter((t) => threadInView(t, view) && threadMatches(t, q));
  const current = items.find((t) => t.id === id) ?? null;
  const patientId = current?.patientId;
  const canMove = can("appointments.manage") && !!current?.next;

  const card = useResource(() => api.patientCard(patientId!), [patientId], { enabled: !!patientId, keep: false });
  const safety = useResource(() => api.safetyPlans(patientId!).catch(() => null), [patientId], {
    enabled: !!patientId,
    keep: false,
  });
  const plan = safety.data?.versions.find((v) => v.active) ?? safety.data?.versions[0] ?? null;

  /* другой разговор — ящик переноса относится к прежнему, закрываем */
  useEffect(() => {
    setDrawer((d) => (d === "move" ? null : d));
  }, [id]);

  const go = (delta: 1 | -1) => {
    const target = stepThread(
      visible.map((t) => t.id),
      id,
      delta,
    );
    if (target) navigate(`/messages/${target}`);
  };
  useHotkeys(
    {
      j: () => go(1),
      k: () => go(-1),
      "[": () => setListHidden((v) => !v),
      c: () => setDrawer("compose"),
      m: () => replyRef.current?.focus(),
    },
    drawer === null,
  );

  const send = () => {
    if (!id || !current?.patientId) return;
    void run(async () => {
      // адресат и текст — этого разговора, сколько бы ни шла отправка
      const sent = text;
      await api.sendMessage({ patientId: current.patientId, text: sent });
      setDrafts((d) => afterSent(d, id, sent));
      await thread.reload();
      await list.reload();
    }, ut("msx.sent"));
  };

  const listView = loadView(list);
  /* имя экрана — одно на экран: заголовок колонки и подпись её областей */
  const title = ut("ms.title");

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/*
        Колонка разговоров (.plist набора): 340, своя прокрутка. На узком
        экране — во всю ширину, пока разговор не открыт; открыт — уступает
        место записи, назад ведёт шеврон в карточке.
      */}
      <aside
        aria-label={title}
        className={cx(
          "flex w-[340px] shrink-0 flex-col border-r border-border bg-panel",
          listHidden && "min-[1024px]:hidden",
          id ? "max-[1023px]:hidden" : "max-[1023px]:w-full max-[1023px]:border-r-0",
        )}
      >
        <div className="shrink-0 px-4 pt-3.5">
          <div className="flex h-9 items-center gap-2">
            <h1 className="m-0 whitespace-nowrap text-[18px] font-extrabold leading-none tracking-[-0.02em] text-text">{title}</h1>
            {list.data ? <Count n={items.length} /> : null}
            <span className="ml-auto flex gap-1">
              <Tooltip label={ut("msx.compose")} kbd="C" side="bottom">
                <Button variant="quiet" size="icon-sm" aria-label={ut("msx.compose")} onClick={() => setDrawer("compose")}>
                  <Mi.squarePen size={16} />
                </Button>
              </Tooltip>
              <Tooltip label={ut("msx.collapse")} kbd="[" side="bottom" align="end">
                <Button
                  variant="quiet"
                  size="icon-sm"
                  aria-label={ut("msx.collapse")}
                  onClick={() => setListHidden(true)}
                  className="max-[1023px]:hidden"
                >
                  <Mi.panelClose size={16} />
                </Button>
              </Tooltip>
            </span>
          </div>
          <SearchField value={q} onChange={setQ} placeholder={ut("msx.search")} slash width={0} className="mt-2.5 w-full" />
          <ViewPills
            className="mt-2.5"
            value={view}
            onChange={(k) => setView(k === "all" ? "" : k)}
            items={[
              { key: "all", label: ut("msx.viewAll"), count: list.data ? counts.all : null },
              { key: "unread", label: ut("msx.viewUnread"), count: list.data ? counts.unread : null },
              { key: "wait", label: ut("msx.viewWait"), count: list.data ? counts.wait : null },
            ]}
          />
          <p className="m-0 mt-1.5 flex h-9 items-center gap-[7px] text-small text-muted">
            <Mi.sortWait size={14} />
            {ut("msx.sortWait")}
          </p>
        </div>
        <div role="list" aria-label={title} className="kit-scroll min-h-0 flex-1 overflow-y-auto border-t border-divider pb-2.5 pt-1">
          {listView === "wait" || listView === "failed" ? (
            <div className="px-4 pt-2">
              <NotLoaded res={list} rows={4} />
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 pt-4">
              <Empty compact title={ut("ms.none")} />
            </div>
          ) : visible.length === 0 ? (
            <p className="m-0 px-5 pt-4 text-small text-muted">{ut("msx.notFound")}</p>
          ) : (
            visible.map((t) => {
              const selected = t.id === id;
              const risky = risksOf(t.patientId).length > 0;
              return (
                <div role="listitem" key={t.id}>
                  {/*
                    Link, а не <a href>: обычная ссылка перезагружала всю
                    консоль на каждое переключение переписки — заново вход,
                    заново боковая колонка, заново все запросы.

                    Имя — своей строкой и обрезается последним: собеседника в
                    переписке узнают по имени, а не по дате рядом с ним.
                  */}
                  <Link
                    to={`/messages/${t.id}`}
                    aria-current={selected ? "page" : undefined}
                    data-row
                    className={cx(
                      "relative mx-1.5 my-0.5 block rounded-[12px] pb-[11px] pl-5 pr-2.5 pt-2.5 no-underline outline-offset-[-2px] hover:no-underline",
                      "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
                      selected ? "bg-violet-tint shadow-[inset_0_0_0_1px_var(--vline)]" : "hover:bg-sunk",
                    )}
                  >
                    {t.unread > 0 ? (
                      <span title={ut("kit.unread")} className="absolute left-2 top-[17px] size-[7px] rounded-full bg-primary" />
                    ) : null}
                    <span className="flex items-baseline gap-2">
                      <span
                        className={cx(
                          "min-w-0 truncate text-[14px] leading-5 tracking-[-0.005em]",
                          selected ? "font-extrabold text-violet-ink" : t.unread > 0 ? "font-extrabold text-text" : "font-bold text-text",
                        )}
                      >
                        {t.withName}
                      </span>
                      {/*
                        Число непрочитанных, а не точка: одно письмо — обычная
                        работа, три подряд без ответа — другая история.
                      */}
                      {t.unread > 0 ? <Count n={t.unread} tone="violet" className="self-center" /> : null}
                      <span className="ml-auto whitespace-nowrap text-small font-bold text-muted">{when(t.lastMessageAt)}</span>
                    </span>
                    {t.preview ? (
                      <span
                        className={cx(
                          "mt-1 line-clamp-2 text-small leading-[18px]",
                          t.unread > 0 ? "font-semibold text-text" : "text-text-2",
                        )}
                      >
                        {t.lastMine ? `${ut("msx.you")}: ` : ""}
                        {t.preview}
                      </span>
                    ) : null}
                    <span className="mt-[7px] flex items-center gap-2.5 text-caption text-text-2">
                      <span className="flex min-w-0 flex-wrap gap-1">
                        {risky ? (
                          <Tag tone="danger" icon={<Ic.alert />}>
                            {ut("msx.signalShort")}
                          </Tag>
                        ) : null}
                        {waitsForReply(t) ? (
                          <Tag tone="attention" icon={<Mi.clock />}>
                            {ut("msx.waits")}
                          </Tag>
                        ) : t.lastMine ? (
                          t.lastReadAt ? (
                            <Tag tone="done" icon={<Ic.checkCheck />}>
                              {ut("ms.read")}
                            </Tag>
                          ) : (
                            <Tag icon={<Ic.check />}>{ut("msx.notRead")}</Tag>
                          )
                        ) : null}
                      </span>
                      <span className="ml-auto whitespace-nowrap text-muted">
                        {t.next ? visitShort(t.next.startsAt) : ut("msx.noVisit")}
                      </span>
                    </span>
                  </Link>
                </div>
              );
            })
          )}
        </div>
        <div className="flex h-[42px] shrink-0 items-center gap-3 border-t border-divider px-4 text-caption text-muted">
          <KbdHints
            keys={[
              ["J K", ut("msx.keyRows")],
              ["/", ut("msx.keySearch")],
              ["C", ut("msx.keyNew")],
            ]}
          />
          {list.data ? (
            <span className="ml-auto whitespace-nowrap font-bold tabular-nums text-text-2">
              {ut("msx.shownOf").replace("{n}", String(visible.length)).replace("{total}", String(items.length))}
            </span>
          ) : null}
        </div>
      </aside>

      <div className={cx("kit-scroll min-h-0 min-w-0 flex-1 overflow-y-auto bg-ground", !id && "max-[1023px]:hidden")}>
        {!id ? (
          /*
            «Оберіть листування», а не «Листування немає»: переписки есть,
            просто ни одна не открыта. Панель путала «ничего не выбрано» с
            «ничего нет» — и сообщала об отсутствии того, что стояло слева.
          */
          <div className="grid h-full place-items-center p-8">
            <Empty
              title={ut(items.length ? "ms.pick" : "ms.none")}
              action={
                <Button icon={<Mi.squarePen />} onClick={() => setDrawer("compose")}>
                  {ut("msx.compose")}
                </Button>
              }
            />
          </div>
        ) : (
          <>
            {current ? (
              <RecordBanner
                row={current}
                card={card.data}
                risks={risksOf(patientId)}
                canMove={canMove}
                onMove={() => setDrawer("move")}
                listHidden={listHidden}
                onShowList={() => setListHidden(false)}
              />
            ) : null}
            <div className="grid grid-cols-[minmax(0,1fr)_330px] items-start gap-4 p-5 max-[1360px]:grid-cols-[minmax(0,1fr)_300px] max-[1180px]:grid-cols-1 max-[1023px]:p-3">
              <Panel title={ut("msx.thread")} icon={<Ic.message />} flush>
                {current && risksOf(patientId).length ? (
                  <div className="px-4 pb-3">
                    <RiskCallout risks={risksOf(patientId)} patientId={patientId} />
                  </div>
                ) : null}
                <div className="flex flex-col gap-2.5 px-4 pb-4">
                  {before ? (
                    <Button
                      size="xs"
                      variant="quiet"
                      icon={<Ic.arrowUp />}
                      className="self-center"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const page = await api.thread(id, before);
                          setOlder({
                            threadId: id,
                            items: [...page.items, ...(earlier?.items ?? [])],
                            before: page.hasMore ? page.nextBefore : null,
                          });
                        })
                      }
                    >
                      {ut("msx.older")}
                    </Button>
                  ) : null}
                  <ThreadFeed
                    view={earlier?.items.length ? "ready" : own.view}
                    items={shown}
                    res={thread}
                    who={current ? firstNameOf(current.withName) : undefined}
                  />
                </div>
                {current?.patientId ? (
                  <>
                    <div className="border-t border-divider px-4 pb-3 pt-4">
                      <Field label={ut("msx.replyLabel")}>
                        <Textarea
                          ref={replyRef}
                          rows={4}
                          value={text}
                          onChange={(e) => {
                            const typed = e.target.value;
                            setDrafts((d) => withDraft(d, id, typed));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) {
                              e.preventDefault();
                              send();
                            }
                          }}
                          placeholder={ut("ms.placeholder")}
                          maxLength={4000}
                        />
                      </Field>
                    </div>
                    <div className="flex flex-wrap items-center gap-2.5 border-t border-divider px-4 pb-4 pt-3">
                      <span className="flex min-w-0 items-center gap-1.5 text-small font-semibold text-text-2">
                        <Mi.smartphone size={14} className="shrink-0 text-violet-ink" />
                        <span className="truncate">{ut("msx.channel")}</span>
                      </span>
                      <span className="ml-auto flex flex-wrap gap-2">
                        {canMove ? (
                          <Tooltip label={ut("msx.moveTip")}>
                            <Button icon={<Mi.calendarSync />} onClick={() => setDrawer("move")}>
                              {ut("msx.move")}
                            </Button>
                          </Tooltip>
                        ) : null}
                        <Button variant="primary" icon={<Mi.send />} disabled={busy || !text.trim()} onClick={send}>
                          {ut("msx.replySend")}
                        </Button>
                      </span>
                    </div>
                  </>
                ) : null}
              </Panel>
              {current ? (
                <RecordSide
                  row={current}
                  card={card.data}
                  cardError={card.error}
                  safety={plan}
                  canMove={canMove}
                  onMove={() => setDrawer("move")}
                />
              ) : null}
            </div>
          </>
        )}
      </div>

      <MoveDrawer
        open={drawer === "move"}
        onClose={() => setDrawer(null)}
        onReturn={() => setDrawer("move")}
        row={current}
        specialistId={user?.id}
        reply={text}
        onReply={(typed) => {
          if (id) setDrafts((d) => withDraft(d, id, typed));
        }}
        onDone={(sent) => {
          if (id && sent !== null) setDrafts((d) => afterSent(d, id, sent));
          list.reload();
          thread.reload();
        }}
      />
      <ComposeDrawer
        open={drawer === "compose"}
        onClose={() => setDrawer(null)}
        onReturn={() => setDrawer("compose")}
        onSent={(threadId) => {
          setDrawer(null);
          list.reload();
          navigate(`/messages/${threadId}`);
        }}
      />
    </div>
  );
}
