import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { Referral, ReferralPage, UiKey } from "@quizzy/shared";
import { api, type SavedView } from "../api";
import { useLang } from "../lang";
import { Avatar, Drawer, DrawerSection, KbdHints, Loading, Modal, useAction, useToast } from "../ui";
import { cx } from "../ui/cx";
import { tableToCsv } from "../ui/DataTable";
import { FilterBar, FilterChip, ViewPills } from "../ui/filters";
import { Ic } from "../ui/icons";
import { useHotkeys } from "../ui/keys";
import { Page, Panel } from "../ui/layout";
import { MenuButton, menuItemClass, MenuSeparator } from "../ui/menu";
import { Tooltip } from "../ui/Popover";
import { Button, ButtonLink, ChoiceCard, Field, Input, Tag, Textarea, type TagTone } from "../ui/primitives";
import { useUrlState } from "../ui/urlState";
import { openView } from "../ui/viewParams";
import { usePagedResource, useResource } from "../useResource";
import { listBody } from "../ui/paging";
import { Pi } from "./patientGroups/icons";
import { fill, pluralOf, shortDate } from "./patientGroups/model";
import {
  DESTINATION_KEY,
  REFERRAL_VIEWS,
  STATUS_KEY,
  URGENCY_KEY,
  closedSinceOf,
  closedWithin,
  isOpen,
  matchesReferral,
  mergeReferrals,
  openMissing,
  sortReferrals,
  spanText,
  viewCount,
  viewFrom,
  waitOf,
  type ReferralSort,
  type ReferralView,
} from "./referrals/model";

/* подписи значений — в модели (по ним сортируются колонки); карта случая берёт их отсюда, как и раньше */
export { DESTINATION_KEY, STATUS_KEY, URGENCY_KEY };
export const NEXT_STATUS = {
  created: [
    { value: "accepted", key: "ref.accepted" },
    { value: "declined", key: "ref.declined" },
  ],
  accepted: [
    { value: "completed", key: "ref.completed" },
    { value: "declined", key: "ref.declined" },
  ],
  completed: [],
  declined: [],
} as const satisfies Record<string, readonly { value: string; key: UiKey }[]>;

/**
 * Реестр направлений (patients-referrals «Виразної»).
 *
 * Смысл экрана — не в самих записях, а в том, что незакрытое направление
 * видно и через месяц: «отправили к психиатру» без обратной связи — самый
 * частый разрыв клинического контура. Поэтому вид по умолчанию — «Відкриті»:
 * сверху «Чекають дії» (виписані и прийняті) со временем ожидания и
 * следующим шагом в строке, ниже — «Закриті за 30 днів» с ответом.
 *
 * Строка открывает ящик: подстава, ход статусов и смена статуса с
 * комментарием (он же «відповідь» направления, outcomeNote). Быстрый шаг —
 * кнопкой в строке и клавишей A: «Прийнято» / «Завершено».
 *
 * Реестр приезжает страницами по сотне (курсор): пилюли видов стоят по числам
 * сервера (ReferralPage.counts), отбор и порядок — по загруженным строкам, и
 * строка под таблицей говорит, сколько из скольких загружено. Отбор, вид и
 * порядок — в адресе: «Подання» сохраняет его как есть.
 */
export default function ReferralsPage() {
  const { ut, lang } = useLang();
  const { run, busy } = useAction();
  const [viewRaw, setViewRaw] = useUrlState("v");
  const [q, setQ] = useUrlState("q");
  const [dest, setDest] = useUrlState("dest");
  const [urg, setUrg] = useUrlState("urg");
  const [by, setBy] = useUrlState("by");
  const [sortRaw, setSort] = useUrlState("sort");
  const view = viewFrom(viewRaw);
  const sort: ReferralSort = sortRaw === "newest" || sortRaw === "oldest" ? sortRaw : "urgent";

  const page = usePagedResource<Referral, ReferralPage>((cursor) => api.referrals(true, cursor), []);
  /*
   * «Закриті за 30 днів» — своим отбором на сервере (?closedSince=), а не по
   * загруженным страницам: давнее направление, закрытое на днях, лежит по
   * дате выписки за ними, и группа его теряла. Отбор добирается целиком, как
   * и открытые; строки — вместе с загруженными, без повторов.
   */
  const [closedSince] = useState(() => closedSinceOf(Date.now()));
  const closed = usePagedResource<Referral, ReferralPage>((cursor) => api.referrals(true, cursor, { closedSince }), [closedSince]);
  const closedMore = closed.hasMore && !closed.loadingMore && !closed.error;
  const loadMoreClosed = closed.loadMore;
  useEffect(() => {
    if (closedMore) loadMoreClosed();
  }, [closedMore, loadMoreClosed]);
  const loaded = page.items;
  const closedItems = closed.items;
  const rows = useMemo(() => (loaded ? mergeReferrals(loaded, closedItems ?? []) : null), [loaded, closedItems]);
  const counts = page.head?.counts;
  /*
   * Открытые — все, а не те, что попали в первую сотню: пока их загружено
   * меньше, чем насчитал сервер, страницы добираются сами (referrals/model.ts,
   * openMissing). Отказ подгрузки останавливает добор — дальше кнопкой.
   */
  const missingOpen = openMissing(rows, counts);
  const { hasMore, loadingMore, error: pageError, loadMore } = page;
  useEffect(() => {
    if (missingOpen && hasMore && !loadingMore && !pageError) loadMore();
  }, [missingOpen, hasMore, loadingMore, pageError, loadMore]);
  /* «сейчас» — один на отрисовку: ожидание в строках и «за 30 днів» не расходятся */
  const now = Date.now();

  const filtered = useMemo(
    () => (rows ?? []).filter((r) => matchesReferral(r, { q, dest, urg, by })),
    [rows, q, dest, urg, by],
  );
  const groups = useMemo(() => {
    const sorted = sortReferrals(filtered, sort);
    if (view === "open") {
      return [
        { key: "open", title: ut("ref2.waiting"), rows: sorted.filter(isOpen) },
        { key: "closed", title: ut("ref2.closed30"), rows: sorted.filter((r) => closedWithin(r, now)) },
      ];
    }
    return [{ key: view, title: null, rows: sorted.filter((r) => (view === "all" ? true : r.status === view)) }];
  }, [filtered, sort, view, ut, now]);
  const shown = groups.flatMap((g) => g.rows);
  const authors = useMemo(() => [...new Set((rows ?? []).map((r) => r.createdByName))].sort(), [rows]);

  /* ─── ящик ─── */

  const [openId, setOpenId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const current = (rows ?? []).find((r) => r.id === openId) ?? null;
  const openRow = (r: Referral) => {
    setOpenId(r.id);
    setDrawerOpen(true);
  };

  /*
   * Перечитать и на отказе: 409 значит, что направление успел сдвинуть кто-то
   * другой (волна 15), и кнопки должны встать по его нынешнему состоянию, а
   * не по тому, на которое человек смотрел. Фраза отказа — от сервера.
   */
  const move = (r: Referral, status: string, note?: string) =>
    run(async () => {
      try {
        await api.updateReferral(r.id, status, note);
      } finally {
        page.reload();
        closed.reload();
      }
    }, ut(status === "accepted" ? "ref.accepted" : status === "declined" ? "ref.declined" : "ref.completed"));

  /* ─── клавиши ─── */

  const tableRef = useRef<HTMLTableElement>(null);
  const focusedRow = (): Referral | null => {
    const id = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("tr[data-ref]")?.dataset.ref;
    return shown.find((r) => r.id === id) ?? null;
  };
  const step = (dir: 1 | -1) => {
    const list = Array.from(tableRef.current?.querySelectorAll<HTMLElement>("tr[data-ref]") ?? []);
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = list[at < 0 ? 0 : Math.min(list.length - 1, Math.max(0, at + dir))];
    next?.focus();
    next?.scrollIntoView({ block: "nearest" });
  };
  const accept = () => {
    const r = focusedRow();
    const next = r ? NEXT_STATUS[r.status][0] : undefined;
    if (r && next) void move(r, next.value);
  };
  useHotkeys({ j: () => step(1), k: () => step(-1), о: () => step(1), л: () => step(-1), a: accept, ф: accept }, !drawerOpen);

  /* ─── выгрузка ─── */

  const exportCsv = () => {
    const text = tableToCsv(shown, [
      { key: "p", header: ut("ref.patient"), render: () => null, sort: (r) => r.userName },
      { key: "d", header: ut("ref.where"), render: () => null, sort: (r) => ut(DESTINATION_KEY[r.destination]) },
      { key: "u", header: ut("ref.urgency"), render: () => null, sort: (r) => ut(URGENCY_KEY[r.urgency]) },
      { key: "s", header: ut("ref.status"), render: () => null, sort: (r) => ut(STATUS_KEY[r.status]) },
      { key: "r", header: ut("ref.reason"), render: () => null, sort: (r) => r.reason ?? "" },
      { key: "a", header: ut("ref.answer"), render: () => null, sort: (r) => r.outcomeNote ?? "" },
      { key: "c", header: ut("ref.issued"), render: () => null, sort: (r) => r.createdAt },
      { key: "b", header: ut("ref2.issuedBy"), render: () => null, sort: (r) => r.createdByName },
    ]);
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${ut("ref.csvName")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /*
   * Обрыв связи объявляет строка оболочки (ui/ConnectionLine.tsx); здесь —
   * скелет до первых строк, отказ на их месте, отказ поверх уже показанных —
   * строкой (listBody в ui/paging.ts).
   */
  const body = listBody(rows, page.error ?? closed.error);
  if (!rows) return <Loading rows={4} error={page.error} onRetry={page.reload} busy={page.loading} />;

  const openN = viewCount(counts, "open") ?? rows.filter(isOpen).length;
  const immediate = rows.filter((r) => isOpen(r) && r.urgency === "immediate").length;
  const late = rows.filter((r) => waitOf(r, now).kind === "late").length;
  const done30 = rows.filter((r) => r.status === "completed" && closedWithin(r, now)).length;

  const facetChip = (
    label: string,
    value: string,
    set: (v: string) => void,
    options: { value: string; label: string }[],
  ) => (
    <MenuButton
      label={label}
      trigger={(p) => (
        <FilterChip
          label={label}
          value={value ? options.find((o) => o.value === value)?.label : undefined}
          on={!!value}
          onClick={p.onClick}
          expanded={p["aria-expanded"]}
          onClear={() => set("")}
        />
      )}
    >
      {(close) =>
        options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="menuitemradio"
            aria-checked={o.value === value}
            className={menuItemClass("left")}
            onClick={() => {
              close();
              set(o.value === value ? "" : o.value);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.value === value ? <Ic.check size={15} className="text-violet-ink" /> : null}
          </button>
        ))
      }
    </MenuButton>
  );

  return (
    <Page
      title={ut("ref.title")}
      meta={[
        fill(ut(`ref2.openN.${pluralOf(openN, lang)}`), { n: openN }),
        [
          immediate ? fill(ut("ref2.metaImmediate"), { n: immediate }) : null,
          late ? fill(ut("ref2.metaLate"), { n: late }) : null,
          fill(ut("ref2.metaDone"), { n: done30 }),
        ]
          .filter(Boolean)
          .join("; "),
      ]}
      sub={ut("ref2.lead")}
      actions={
        <>
          <ViewsMenu />
          <Button icon={<Ic.download />} onClick={exportCsv} disabled={!shown.length}>
            {ut("ref2.csv")}
          </Button>
        </>
      }
    >
      {body.stale ? <p className="m-0 mb-2 text-caption text-risk-ink">{body.stale}</p> : null}
      <Panel flush>
        <div className="flex flex-col gap-3 px-4 pb-3 pt-3.5">
          <FilterBar
            search={{ value: q, onChange: setQ, placeholder: ut("ref2.searchPh"), width: 240 }}
            chips={
              <>
                {facetChip(
                  ut("ref.where"),
                  dest,
                  setDest,
                  Object.entries(DESTINATION_KEY).map(([v, k]) => ({ value: v, label: capital(ut(k)) })),
                )}
                {facetChip(
                  ut("ref.urgency"),
                  urg,
                  setUrg,
                  Object.entries(URGENCY_KEY).map(([v, k]) => ({ value: v, label: ut(k) })),
                )}
                {authors.length > 1 || by
                  ? facetChip(
                      ut("ref2.issuedBy"),
                      by,
                      setBy,
                      authors.map((a) => ({ value: a, label: a })),
                    )
                  : null}
              </>
            }
            sort={{
              options: [
                { key: "urgent", label: ut("ref2.sortUrgent") },
                { key: "newest", label: ut("ref2.sortNewest") },
                { key: "oldest", label: ut("ref2.sortOldest") },
              ],
              value: sort,
              onChange: (k) => setSort(k === "urgent" ? "" : k),
            }}
          />
          <ViewPills
            label={ut("ref2.views")}
            items={REFERRAL_VIEWS.map((v) => ({ key: v, label: ut(VIEW_LABEL[v]), count: viewCount(counts, v) }))}
            value={view}
            onChange={(k) => setViewRaw(k === "open" ? "" : k)}
          />
        </div>

        <div className="overflow-x-auto">
          <table ref={tableRef} aria-label={ut("ref.title")} className="w-full min-w-[860px] border-separate border-spacing-0 text-body leading-[19px]">
            <thead>
              <tr>
                <th className={th} style={{ width: 196 }}>{ut("ref.patient")}</th>
                <th className={th} style={{ width: 140 }}>{ut("ref2.whereUrgency")}</th>
                <th className={th} style={{ width: 160 }}>{ut("ref.status")}</th>
                <th className={th}>{ut("ref2.reasonAnswer")}</th>
                <th className={th} style={{ width: 112 }}>{ut("ref.issued")}</th>
                <th className={cx(th, "w-0")} aria-label={ut("kit.rowActions")} />
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.key}>
                {g.title ? (
                  <tr>
                    <th colSpan={6} scope="rowgroup" className="h-10 border-b border-divider bg-panel-2 px-4 text-left text-small font-extrabold text-text">
                      {g.title}
                      <span className="ml-1.5 inline-grid h-5 min-w-5 place-items-center rounded-[10px] bg-sunk px-1.5 text-[11.5px] tabular-nums text-text-2">
                        {g.rows.length}
                      </span>
                    </th>
                  </tr>
                ) : null}
                {g.rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="border-b border-divider px-4 py-4 text-small text-muted">
                      {g.key === "open" ? ut("ref.noneOpen") : g.key === "closed" ? ut("ref2.noneClosed") : ut("ref.none")}
                    </td>
                  </tr>
                ) : (
                  g.rows.map((r) => (
                    <ReferralRow
                      key={r.id}
                      r={r}
                      now={now}
                      active={drawerOpen && r.id === openId}
                      busy={busy}
                      onOpen={() => openRow(r)}
                      onMove={(status) => void move(r, status)}
                    />
                  ))
                )}
              </tbody>
            ))}
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-divider px-4 py-3">
          <span className="text-small text-muted">
            {fill(ut("ref2.shown"), { n: shown.length, loaded: rows.length, total: page.total ?? rows.length })}
          </span>
          {page.hasMore ? (
            <Button variant="ghost" size="xs" className="ml-auto" disabled={page.loadingMore} onClick={page.loadMore}>
              {page.loadingMore ? ut("ui.loadingMore") : ut("ui.loadMore")}
            </Button>
          ) : view === "open" ? (
            <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setViewRaw("completed")}>
              {ut("ref2.allCompleted")}
            </Button>
          ) : null}
        </div>
        <KbdHints
          bar
          keys={[
            ["J K", ut("pg2.kRows")],
            ["Enter", ut("ref2.kOpen")],
            ["A", ut("ref2.kAccept")],
            ["/", ut("pg2.kSearch")],
          ]}
        />
      </Panel>

      <ReferralDrawer
        open={drawerOpen}
        referral={current}
        onClose={() => setDrawerOpen(false)}
        onReturn={() => setDrawerOpen(true)}
        onSaved={() => {
          page.reload();
          setDrawerOpen(false);
        }}
      />
    </Page>
  );
}

const VIEW_LABEL: Record<ReferralView, UiKey> = {
  open: "ref2.viewOpen",
  created: "ref2.viewCreated",
  accepted: "ref2.viewAccepted",
  completed: "ref2.viewCompleted",
  declined: "ref2.viewDeclined",
  all: "pg.allTab",
};

const th =
  "h-[38px] whitespace-nowrap border-b border-divider bg-panel-2 px-2.5 text-left align-middle text-caption font-bold text-muted first:pl-4 last:pr-4";
const td = "border-b border-divider px-2.5 py-3 align-top first:pl-4 last:pr-4";

/** «психіатр» → «Психіатр»: подписи словаря строчные, в ячейке «Куди» — с прописной */
function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const STATUS_TONE: Record<Referral["status"], { tone: TagTone; icon: ReactNode }> = {
  created: { tone: "info", icon: <Pi.send /> },
  accepted: { tone: "primary", icon: <Ic.check /> },
  completed: { tone: "good", icon: <Ic.checkCheck /> },
  declined: { tone: "plain", icon: <Ic.x /> },
};

export function StatusTag({ status }: { status: Referral["status"] }) {
  const { ut } = useLang();
  const s = STATUS_TONE[status];
  return (
    <Tag tone={s.tone} icon={s.icon}>
      {ut(STATUS_KEY[status])}
    </Tag>
  );
}

/** Терміновість: «негайно» — красным (риск для человека), «терміново» — янтарём, «планово» — нейтрально */
export function UrgencyTag({ urgency }: { urgency: Referral["urgency"] }) {
  const { ut } = useLang();
  return urgency === "immediate" ? (
    <Tag tone="danger" icon={<Pi.zap />}>
      {ut(URGENCY_KEY[urgency])}
    </Tag>
  ) : urgency === "urgent" ? (
    <Tag tone="attention" icon={<Ic.timer />}>
      {ut(URGENCY_KEY[urgency])}
    </Tag>
  ) : (
    <Tag>{ut(URGENCY_KEY[urgency])}</Tag>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  return `${shortDate(iso)}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ReferralRow({
  r,
  now,
  active,
  busy,
  onOpen,
  onMove,
}: {
  r: Referral;
  now: number;
  active: boolean;
  busy: boolean;
  onOpen: () => void;
  onMove: (status: string) => void;
}) {
  const { ut } = useLang();
  const wait = waitOf(r, now);
  const units = { min: ut("ref2.min"), hour: ut("ref2.hour"), day: ut("ref2.day") };
  const next = NEXT_STATUS[r.status];
  const forward = next.find((n) => n.value !== "declined");
  const open = isOpen(r);
  const tone = active ? "bg-violet-tint" : open && r.urgency === "immediate" ? "bg-risk-tint" : "group-hover/row:bg-panel-2";
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onOpen();
    }
  };
  return (
    <tr
      data-ref={r.id}
      tabIndex={0}
      aria-selected={active}
      onKeyDown={onKey}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, input")) return;
        onOpen();
      }}
      className="group/row cursor-pointer outline-offset-[-2px]"
    >
      <td className={cx(td, tone)}>
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={r.userName} size={34} />
          <Link to={`/patients/${r.userId}`} className="line-clamp-2 font-bold text-text no-underline hover:underline">
            {r.userName}
          </Link>
        </span>
      </td>
      <td className={cx(td, tone)}>
        <b className={cx("block font-extrabold", !open && "text-text-2")}>{capital(ut(DESTINATION_KEY[r.destination]))}</b>
        <span className="mt-1 inline-flex">
          <UrgencyTag urgency={r.urgency} />
        </span>
      </td>
      <td className={cx(td, tone)}>
        <StatusTag status={r.status} />
        {wait.kind === "late" ? (
          <small className="mt-1 flex items-center gap-1 whitespace-nowrap text-caption font-bold text-warn">
            <Pi.clockAlert size={12} />
            {fill(ut("ref2.noAnswerFor"), { span: spanText(wait.minutes, units) })}
          </small>
        ) : wait.kind === "issued" ? (
          <small className="mt-1 block whitespace-nowrap text-caption text-muted">{fill(ut("ref2.issuedAgo"), { span: spanText(wait.minutes, units) })}</small>
        ) : wait.kind === "accepted" ? (
          <small className="mt-1 block whitespace-nowrap text-caption text-muted">{fill(ut("ref2.acceptedIn"), { span: spanText(wait.minutes, units) })}</small>
        ) : null}
      </td>
      <td className={cx(td, tone)}>
        <span className={cx("line-clamp-2", !open && "text-text-2")}>{r.reason ?? "—"}</span>
        {r.outcomeNote ? (
          <small className="mt-0.5 line-clamp-2 text-caption text-muted">
            <b className={cx("font-bold", r.status === "declined" ? "text-text-2" : "text-good")}>{ut("ref.answer")}:</b> {r.outcomeNote}
          </small>
        ) : open ? (
          <small className="mt-0.5 block text-caption text-muted">{ut("ref2.noAnswer")}</small>
        ) : null}
      </td>
      <td className={cx(td, tone)}>
        <span className="block whitespace-nowrap tabular-nums">{when(r.createdAt)}</span>
        <small className="block truncate text-caption text-muted">{r.createdByName}</small>
      </td>
      <td className={cx(td, tone, "whitespace-nowrap")}>
        <span className="flex items-center justify-end gap-1">
          {forward ? (
            /* на 1280 подпись прячется (остаётся для диктора и в подсказке): иначе колонка «Підстава» сжимается до двух слов */
            <Tooltip label={ut(forward.key)} kbd="A">
              <Button
                size="xs"
                icon={forward.value === "completed" ? <Ic.checkCheck /> : <Ic.check />}
                disabled={busy}
                onClick={() => onMove(forward.value)}
                aria-label={`${ut(forward.key)}: ${r.userName}`}
                className="max-[1399px]:px-2"
              >
                <span className="max-[1399px]:sr-only">{ut(forward.key)}</span>
              </Button>
            </Tooltip>
          ) : null}
          {next.some((n) => n.value === "declined") ? (
            <Tooltip label={ut("ref.declined")}>
              <Button variant="quiet" size="icon-sm" aria-label={`${ut("ref.declined")}: ${r.userName}`} onClick={onOpen}>
                <Ic.x />
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip label={ut("pg2.openCase")}>
            <ButtonLink to={`/patients/${r.userId}/case`} variant="quiet" size="icon-sm" aria-label={`${ut("pg2.openCase")}: ${r.userName}`}>
              <Pi.folderOpen />
            </ButtonLink>
          </Tooltip>
        </span>
      </td>
    </tr>
  );
}

/* ─────────── ящик направления ─────────── */

/**
 * Направление в ящике: кто и зачем, ход статусов, смена статуса.
 *
 * «Відхилено» — только отсюда, с причиной в комментарии: отклонённое
 * направление возвращает человека его специалисту, и без слова «почему» это
 * тупик. Комментарий уходит в outcomeNote — ту же «відповідь», что видна в
 * строке реестра и в карте случая.
 */
function ReferralDrawer({
  open,
  referral,
  onClose,
  onReturn,
  onSaved,
}: {
  open: boolean;
  referral: Referral | null;
  onClose: () => void;
  onReturn: () => void;
  onSaved: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");
  const id = referral?.id ?? null;
  const at = referral?.status ?? null;
  useEffect(() => {
    setStatus("");
    setNote("");
  }, [id]);
  /*
   * Статус сменился — этим ящиком или коллегой (409, реестр перечитан):
   * выбранный переход к нему уже не относится. Прежде выбор переживал смену:
   * ящик того же направления открывался с невидимым выбором «Прийнято» и
   * живой кнопкой, и «Зберегти» уходило отказом о недопустимом переходе.
   * Набранный комментарий при отказе остаётся — его писали не зря.
   */
  useEffect(() => {
    setStatus("");
  }, [at]);

  if (!referral) {
    return <Drawer open={false} onClose={onClose} title={ut("ref.title")} />;
  }
  const r = referral;
  const next = NEXT_STATUS[r.status];
  const declining = status === "declined";
  const save = () =>
    void run(async () => {
      if (!status || (declining && !note.trim())) return false;
      try {
        await api.updateReferral(r.id, status, note.trim() || undefined);
        /* сохранённый комментарий — уже «відповідь» направления: следующий шаг начинается с пустой формы */
        setStatus("");
        setNote("");
      } finally {
        onSaved();
      }
    }, ut("ref2.statusSaved"));

  const steps: { at: string | null; text: ReactNode; done: boolean }[] = [
    { at: r.createdAt, text: <><b>{ut("ref2.stepIssued")}</b> {r.createdByName}</>, done: true },
  ];
  if (r.status === "created") {
    steps.push({ at: null, text: ut("ref2.stepAcceptPending"), done: false }, { at: null, text: ut("ref2.stepDonePending"), done: false });
  } else if (r.status === "accepted") {
    steps.push({ at: r.updatedAt, text: <b>{ut("ref.accepted")}</b>, done: true }, { at: null, text: ut("ref2.stepDonePending"), done: false });
  } else {
    steps.push({ at: r.updatedAt, text: <b>{ut(r.status === "completed" ? "ref.completed" : "ref.declined")}</b>, done: true });
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      onReturn={onReturn}
      title={fill(ut("ref2.drawerTitle"), { where: ut(DESTINATION_KEY[r.destination]) })}
      sub={`${r.userName}, ${ut(URGENCY_KEY[r.urgency])}, ${when(r.createdAt)}`}
      icon={<Pi.arrowRightLeft />}
      tone={r.urgency === "immediate" && isOpen(r) ? "risk" : "violet"}
      dirty={status !== "" || note !== ""}
      draftName={ut("ref2.draft")}
      note={next.length ? fill(ut("ref2.notify"), { name: r.createdByName }) : undefined}
      noteIcon={<Pi.bellRing />}
      footer={
        next.length ? (
          <>
            <Button variant="primary" disabled={busy || !status || (declining && !note.trim())} onClick={save}>
              {ut("ref2.saveStatus")}
            </Button>
            <Button onClick={onClose}>{ut("common.cancel")}</Button>
          </>
        ) : (
          <Button onClick={onClose}>{ut("bp.close")}</Button>
        )
      }
    >
      <DrawerSection>
        <div className="flex items-center gap-3 rounded-[12px] bg-sunk px-3 py-2.5">
          <Avatar name={r.userName} size={34} />
          <b className="min-w-0 flex-1 truncate font-bold">{r.userName}</b>
          <ButtonLink to={`/patients/${r.userId}/case`} size="xs">
            <Pi.folderOpen size={14} />
            {ut("ref2.case")}
          </ButtonLink>
        </div>
      </DrawerSection>
      <DrawerSection title={ut("ref.reason")} sub={ut(URGENCY_KEY[r.urgency])}>
        <p className="m-0 whitespace-pre-line text-body text-text">{r.reason ?? "—"}</p>
        {r.outcomeNote ? (
          <p className="m-0 mt-2.5 text-small text-text-2">
            <b className="font-bold text-text">{ut("ref.answer")}:</b> {r.outcomeNote}
          </p>
        ) : null}
      </DrawerSection>
      <DrawerSection title={ut("ref.status")} right={<StatusTag status={r.status} />}>
        <ol className="m-0 list-none p-0">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2.5 py-1.5 text-small">
              <span
                aria-hidden
                className={cx(
                  "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
                  s.done ? "bg-violet-tint text-violet-ink" : "shadow-[inset_0_0_0_1.5px_var(--ctl)]",
                )}
              >
                {s.done ? <Ic.check size={11} /> : null}
              </span>
              <span className={cx("min-w-0 flex-1", s.done ? "text-text" : "text-muted")}>{s.text}</span>
              {s.at ? <span className="whitespace-nowrap tabular-nums text-muted">{when(s.at)}</span> : null}
            </li>
          ))}
        </ol>
      </DrawerSection>
      {next.length ? (
        <DrawerSection title={ut("ref2.changeStatus")}>
          <div role="radiogroup" aria-label={ut("ref2.newStatus")} className="flex flex-col gap-1.5">
            {next.map((n) => (
              <ChoiceCard
                key={n.value}
                name={`ref-${r.id}`}
                value={n.value}
                checked={status === n.value}
                onChange={setStatus}
                title={ut(n.key)}
                sub={ut(NEXT_HINT[n.value])}
              />
            ))}
          </div>
          <div className="mt-3.5">
            <Field
              label={declining ? ut("ref2.declineReason") : ut("ref2.comment")}
              hint={declining ? ut("ref2.declineHint") : undefined}
            >
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} placeholder={ut("ref2.commentPh")} />
            </Field>
          </div>
        </DrawerSection>
      ) : null}
    </Drawer>
  );
}

const NEXT_HINT: Record<string, UiKey> = {
  accepted: "ref2.hintAccepted",
  completed: "ref2.hintCompleted",
  declined: "ref2.hintDeclined",
};

/* ─────────── подання ─────────── */

/**
 * «Подання» — сохранённые виды реестра меню в шапке: открыть, сохранить
 * нынешний отбор. Вид хранит адрес целиком (?v, ?q, ?dest, ?urg, ?by, ?sort)
 * и узнаётся открытым при любом порядке параметров (ui/viewParams.ts).
 */
function ViewsMenu() {
  const { ut } = useLang();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const res = useResource(() => api.views("referrals"), []);
  const views = res.data ?? [];
  const current = location.search.replace(/^\?/, "");
  const active = openView(views, current);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const { run, busy } = useAction();

  const apply = (v: SavedView) => navigate({ search: v.params ? `?${v.params}` : "" });

  return (
    <>
      <MenuButton
        label={ut("ref2.views2")}
        trigger={(p) => (
          <Button {...p} icon={<Pi.bookmark />}>
            {active ? fill(ut("ref2.viewsActive"), { name: active.name }) : ut("ref2.views2")}
          </Button>
        )}
      >
        {(close) => (
          <>
            {views.length === 0 ? (
              <p className="m-0 px-2.5 py-2 text-small text-muted">{res.error ? ut("uit.views.loadFailed") : ut("ref2.noViews")}</p>
            ) : (
              views.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active?.id === v.id}
                  className={menuItemClass("left")}
                  onClick={() => {
                    close();
                    apply(v);
                  }}
                >
                  <Pi.bookmark size={15} className="text-muted" />
                  <span className="min-w-0 flex-1 truncate">{v.mine ? v.name : `${v.name}, ${v.ownerName}`}</span>
                  {active?.id === v.id ? <Ic.check size={15} className="text-violet-ink" /> : null}
                </button>
              ))
            )}
            <MenuSeparator />
            <button
              type="button"
              role="menuitem"
              aria-disabled={!current || undefined}
              className={menuItemClass("left", current ? "normal" : "disabled")}
              onClick={() => {
                if (!current) return;
                close();
                setNaming(true);
              }}
            >
              <Pi.save size={15} className="text-muted" />
              <span className="min-w-0 flex-1 truncate">{ut("views.saveCurrent")}</span>
            </button>
          </>
        )}
      </MenuButton>
      {naming ? (
        <Modal
          title={ut("views.save")}
          onClose={() => setNaming(false)}
          footer={
            <>
              <Button
                variant="primary"
                disabled={busy || !name.trim()}
                onClick={() =>
                  void run(async () => {
                    await api.saveView({ scope: "referrals", name: name.trim(), params: current });
                    setNaming(false);
                    setName("");
                    res.reload();
                    toast(ut("views.saved"), "ok");
                  })
                }
              >
                {ut("common.save")}
              </Button>
              <Button onClick={() => setNaming(false)}>{ut("common.cancel")}</Button>
            </>
          }
        >
          <Field label={ut("f.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder={ut("views.namePlaceholder")} />
          </Field>
        </Modal>
      ) : null}
    </>
  );
}
