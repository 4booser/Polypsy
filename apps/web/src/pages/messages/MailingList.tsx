import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { MailingListItem, PatientGroupWithCounts } from "@quizzy/shared";
import { api } from "../../api";
import { day, timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { DataTable, Empty, FilterBar, FilterChip, Ic, KbdHints, Loading, Modal, Tooltip, useAction, useHotkeys, useToast, type Column } from "../../ui";
import { cx } from "../../ui/cx";
import { Page, Panel } from "../../ui/layout";
import { MenuButton, menuItemClass } from "../../ui/menu";
import { Pager } from "../../ui/pager";
import { DEFAULT_PER, offsetPageCount, pageFrom, pageOffset, perFrom } from "../../ui/paging";
import { Button, ButtonLink, Tag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { AnswersDrawer } from "./answers";
import { Mi } from "./icons";
import { answerShares, mailingHref, mailingQuery, mailingViewFrom } from "./model";

/*
 * «Розсилки» — повідомлення групам пацієнтів (comms-mailings).
 *
 * Не переписка. Переписка пациент ↔ специалист — /messages (Messages.tsx),
 * «Листування» на рельсе; здесь — сообщения «одному многим» с вариантами
 * ответа, подраздел «Пацієнти».
 *
 * Таблица, а не список: розсилки сравнивают по колонкам — кому, сколько
 * ответили и как, в каком состоянии. Строка черновика ведёт в редактор,
 * строка отправленной открывает ответы в ящике справа — страница остаётся
 * на месте. Отправленное не меняется: его можно только скрыть и вернуть.
 *
 * Страницы, поиск, вид, группа и порядок — на сервере (limit/offset, q,
 * status, hidden, group, order): тема и текст лежат зашифрованными и
 * расшифровываются там. Состояние — в адресе: ссылку на «чернетки групи Х»
 * пересылают.
 */

/** Цвета вариантов ответа в полосе — ряды графиков набора по порядку */
const OPTION_TONES = ["bg-series-1", "bg-series-2", "bg-series-3", "bg-series-4", "bg-series-5"] as const;
export const optionTone = (i: number) => OPTION_TONES[i % OPTION_TONES.length]!;

/** Дата строки: «07.10, 10:00» */
const stamp = (iso: string) => `${day(iso)}, ${timeOfDay(iso)}`;

/**
 * Ячейка «Повідомлення»: тема ссылкой и начало текста.
 *
 * Имя ссылки — одна тема: перечень ссылок диктор читает темами, а не
 * абзацами. Начало текста лежит рядом со ссылкой и видно диктору как
 * содержимое ячейки — прятать его (aria-hidden) однажды уже пробовали.
 */
export function TitleCell({ m }: { m: Pick<MailingListItem, "id" | "title" | "preview"> }) {
  return (
    <div className="min-w-0 py-1">
      <Link
        to={mailingHref(m.id)}
        className="block text-[14px] font-extrabold leading-5 text-text no-underline hover:underline hover:decoration-violet-line hover:decoration-2 hover:underline-offset-[3px]"
      >
        {m.title}
      </Link>
      <p className="m-0 mt-0.5 line-clamp-2 max-w-[460px] text-small leading-[18px] text-text-2">{m.preview}</p>
    </div>
  );
}

/** Ячейка «Відповіді»: у черновика — варианты, у отправленной — полоса долей и легенда */
export function AnswersCell({ m }: { m: Pick<MailingListItem, "status" | "options" | "answers" | "answeredCount" | "recipientCount"> }) {
  const { ut } = useLang();
  if (!m.options.length) return <span className="text-small text-text-2">{ut("mlx.noOptions")}</span>;
  if (m.status === "draft") {
    return (
      <div className="py-1">
        <span className="flex flex-wrap gap-1">
          {m.options.map((o, i) => (
            <Tag key={i}>{o}</Tag>
          ))}
        </span>
        <small className="mt-1 block text-caption text-muted">{ut("mlx.optionsWord")}</small>
      </div>
    );
  }
  const shares = answerShares(m.answers, m.recipientCount);
  return (
    <div className="py-1">
      <span className="flex items-center gap-2.5">
        <span aria-hidden className="flex h-2.5 w-[150px] shrink-0 overflow-hidden rounded-[5px] bg-track">
          {shares.option.map((f, i) => (
            <i key={i} className={cx("block h-full", optionTone(i))} style={{ width: `${(f * 100).toFixed(2)}%` }} />
          ))}
        </span>
        <span className="whitespace-nowrap text-small font-bold tabular-nums text-text-2">
          {ut("mlx.answeredOf").replace("{n}", String(m.answeredCount)).replace("{total}", String(m.recipientCount))}
        </span>
      </span>
      <span className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-[3px] text-caption text-text-2">
        {m.options.map((o, i) => (
          <span key={i} className="inline-flex items-center gap-[5px] whitespace-nowrap">
            <i aria-hidden className={cx("block size-[9px] rounded-[3px]", optionTone(i))} />
            {o} <b className="font-extrabold tabular-nums text-text">{m.answers[i] ?? 0}</b>
          </span>
        ))}
      </span>
    </div>
  );
}

/** Ячейка «Стан»: черновик или отправлено, дата и охват */
export function StateCell({ m }: { m: Pick<MailingListItem, "status" | "at" | "readCount" | "recipientCount"> }) {
  const { ut } = useLang();
  return (
    <div className="py-1">
      {m.status === "draft" ? (
        <Tag icon={<Ic.pen />}>{ut("mlx.draft")}</Tag>
      ) : (
        <Tag tone="good" icon={<Mi.send />}>
          {ut("mlx.sentTag")}
        </Tag>
      )}
      <small className="mt-1 block whitespace-nowrap text-caption text-text-2">
        {m.status === "draft" ? ut("mlx.changed").replace("{d}", stamp(m.at)) : stamp(m.at)}
      </small>
      {m.status === "sent" ? (
        <small className="block whitespace-nowrap text-caption text-text-2">
          {ut("mlx.readOf").replace("{n}", String(m.readCount)).replace("{total}", String(m.recipientCount))}
        </small>
      ) : null}
    </div>
  );
}

export default function MailingList() {
  const { ut } = useLang();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, busy } = useAction();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const view = mailingViewFrom(params.get("view"));
  const group = params.get("group") ?? "";
  const order = params.get("order") === "old" ? "old" : "new";
  const page = pageFrom(params.get("page"));
  const per = perFrom(params.get("per"));
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<MailingListItem | null>(null);

  /* состояние — в адресе, как у каталога и групп: ссылку на «страницу 3» пересылают */
  const update = useCallback(
    (patch: Record<string, string | null>) => {
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
      );
    },
    [setParams],
  );

  /* поиск ждёт паузу в наборе: сервер расшифровывает список на каждый запрос */
  const [dq, setDq] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDq(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const list = useResource(
    // смещение — не дальше предела сервера (ui/paging.ts, #205): страница из закладки за ним — на последнюю
    () =>
      api.mailings({
        q: dq,
        ...mailingQuery(view),
        ...(group ? { group } : {}),
        ...(order === "old" ? { order } : {}),
        limit: per,
        offset: pageOffset(page, per),
      }),
    [dq, view, group, order, page, per],
  );
  const groups = useResource(() => api.patientGroups().catch(() => null), []);
  const groupBy = useMemo(() => new Map((groups.data ?? []).map((g) => [g.id, g])), [groups.data]);
  const pages = offsetPageCount(list.data?.total ?? 0, per);
  const counts = list.data?.counts;

  /* последняя страница может опустеть после удаления или поиска — возвращаемся на ближайшую */
  useEffect(() => {
    if (list.data && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [list.data, page, pages, update]);

  useHotkeys({ n: () => navigate("/mailings/new") }, open === null && removing === null);

  const hide = (m: MailingListItem) =>
    run(async () => {
      await api.hideMailing(m.id);
      list.reload();
      toast(ut("mail.hidden"), "ok", {
        action: {
          label: ut("mlx.unhide"),
          onClick: () =>
            void run(async () => {
              await api.unhideMailing(m.id);
              list.reload();
            }),
        },
      });
    });
  const unhide = (m: MailingListItem) =>
    run(async () => {
      await api.unhideMailing(m.id);
      list.reload();
    }, ut("mlx.unhidden"));
  const remove = (m: MailingListItem) =>
    run(async () => {
      await api.deleteMailing(m.id);
      setRemoving(null);
      list.reload();
    }, ut("mail.deleted"));

  const columns: Column<MailingListItem>[] = [
    { key: "title", header: ut("mlx.colMessage"), required: true, render: (m) => <TitleCell m={m} /> },
    {
      key: "to",
      required: true,
      header: ut("mlx.colTo"),
      width: 210,
      render: (m) => <ToCell m={m} group={m.patientGroupId ? (groupBy.get(m.patientGroupId) ?? null) : null} />,
    },
    { key: "answers", header: ut("mlx.colAnswers"), required: true, width: 270, render: (m) => <AnswersCell m={m} /> },
    { key: "state", header: ut("mlx.colState"), required: true, width: 170, render: (m) => <StateCell m={m} /> },
  ];

  const groupTitle = group ? (groupBy.get(group)?.title ?? null) : null;

  return (
    <Page
      title={ut("sn.mailings")}
      count={counts ? counts.all : null}
      actions={
        <Tooltip label={ut("mlx.newTip")} kbd="N" side="bottom" align="end">
          <ButtonLink to="/mailings/new" variant="primary" className="gap-2">
            <Ic.plus size={16} />
            {ut("mail.add")}
          </ButtonLink>
        </Tooltip>
      }
    >
      <Panel flush>
        <div className="px-4 pb-3 pt-3.5">
          <FilterBar
            search={{
              value: q,
              onChange: (v) => update({ q: v, page: null }),
              placeholder: ut("mail.search"),
              width: 260,
            }}
            views={{
              value: view,
              onChange: (k) => update({ view: k === "all" ? null : k, page: null }),
              items: [
                { key: "all", label: ut("mlx.viewAll"), count: counts?.all ?? null },
                { key: "draft", label: ut("mlx.viewDrafts"), count: counts?.draft ?? null },
                { key: "sent", label: ut("mlx.viewSent"), count: counts?.sent ?? null },
                { key: "hidden", label: ut("mlx.viewHidden"), count: counts?.hidden ?? null },
              ],
            }}
            chips={
              groups.data && groups.data.length ? (
                <GroupChip
                  groups={groups.data}
                  value={group}
                  label={groupTitle}
                  onChange={(id) => update({ group: id || null, page: null })}
                />
              ) : null
            }
            sort={{
              options: [
                { key: "new", label: ut("mlx.newFirst") },
                { key: "old", label: ut("mlx.oldFirst") },
              ],
              value: order,
              onChange: (k) => update({ order: k === "old" ? "old" : null, page: null }),
            }}
          />
        </div>
        {list.error && !list.data ? (
          <div className="px-4 pb-4">
            <Loading error={list.error} onRetry={list.reload} bare />
          </div>
        ) : !list.data ? (
          <div className="px-4 pb-4">
            <Loading rows={5} bare />
          </div>
        ) : (
          <DataTable
            label={ut("sn.mailings")}
            rows={list.data.items}
            columns={columns}
            rowKey={(m) => m.id}
            hotkeys={open === null && removing === null}
            isRowActive={(m) => m.id === open}
            onRowClick={(m) => (m.status === "sent" ? setOpen(m.id) : navigate(mailingHref(m.id)))}
            empty={
              <Empty
                compact
                title={dq.trim() || group || view !== "all" ? ut("mail.emptySearch") : ut("mail.empty")}
              />
            }
            rowActions={(m) =>
              view === "hidden" ? (
                <RowAction label={ut("mlx.unhide")} onClick={() => void unhide(m)} disabled={busy}>
                  <Ic.undo size={15} />
                </RowAction>
              ) : m.status === "draft" ? (
                <>
                  <RowAction label={ut("mlx.edit")} to={mailingHref(m.id)}>
                    <Mi.pencil size={15} />
                  </RowAction>
                  <RowAction label={ut("mlx.deleteDraft")} onClick={() => setRemoving(m)}>
                    <Mi.trash size={15} />
                  </RowAction>
                </>
              ) : (
                <>
                  <RowAction label={ut("mlx.openAnswers")} onClick={() => setOpen(m.id)} data-answers>
                    <Mi.panelRight size={15} />
                  </RowAction>
                  <RowAction label={ut("mlx.hide")} onClick={() => void hide(m)} disabled={busy}>
                    <Mi.eyeOff size={15} />
                  </RowAction>
                </>
              )
            }
          />
        )}
        <div className="border-t border-divider px-4 py-2.5">
          <Pager
            page={page}
            pages={pages}
            per={per}
            total={list.data?.total ?? null}
            onPer={(n) => update({ per: n === DEFAULT_PER ? null : String(n), page: null })}
            onPage={(n) => update({ page: n > 1 ? String(n) : null })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-divider px-4 py-3 text-small text-text-2">
          <span className="inline-flex items-center gap-1.5">
            <Ic.lock size={13} className="text-muted" />
            {ut("mlx.immutable")}
          </span>
          <KbdHints
            className="ml-auto"
            keys={[
              ["J K", ut("mlx.keyRows")],
              ["Enter", ut("mlx.keyOpen")],
              ["N", ut("mlx.keyNew")],
            ]}
          />
        </div>
      </Panel>

      <AnswersDrawer
        id={open}
        onClose={() => setOpen(null)}
        group={open ? (groupBy.get(list.data?.items.find((m) => m.id === open)?.patientGroupId ?? "") ?? null) : null}
        onHidden={() => {
          setOpen(null);
          list.reload();
        }}
      />

      {removing ? (
        <Modal
          title={ut("mail.confirmDelete")}
          onClose={() => setRemoving(null)}
          icon={<Mi.trash />}
          tone="warn"
          width={460}
          footer={
            <>
              <Button variant="danger" icon={<Mi.trash />} disabled={busy} onClick={() => void remove(removing)}>
                {ut("mail.delete")}
              </Button>
              <Button onClick={() => setRemoving(null)}>{ut("mlx.keep")}</Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">{ut("mlx.deleteBody").replace("{title}", removing.title)}</p>
        </Modal>
      ) : null}
    </Page>
  );
}

/** Ячейка «Кому»: группа пилюлей и сколько людей — получили (отправленная) или в группе сейчас (черновик) */
function ToCell({ m, group }: { m: MailingListItem; group: PatientGroupWithCounts | null }) {
  const { ut } = useLang();
  const people = m.status === "sent" ? m.recipientCount : (group?.memberCount ?? null);
  return (
    <div className="py-1">
      {m.patientGroupId ? (
        <Tag tone="primary" icon={<Ic.users />}>
          {group?.title ?? ut("mlx.someGroup")}
        </Tag>
      ) : (
        <span className="text-small text-muted">{ut("mlx.noGroup")}</span>
      )}
      {people !== null ? (
        <small className="mt-1.5 block text-caption text-text-2">{ut("mlx.people").replace("{n}", String(people))}</small>
      ) : null}
    </div>
  );
}

/** Значковое действие строки с подписью-подсказкой */
function RowAction({
  label,
  onClick,
  to,
  disabled,
  children,
  ...data
}: {
  label: string;
  onClick?: () => void;
  to?: string;
  disabled?: boolean;
  children: React.ReactNode;
} & { [k: `data-${string}`]: boolean | string }) {
  return (
    <Tooltip label={label}>
      {to ? (
        <ButtonLink to={to} variant="quiet" size="icon-sm" aria-label={label}>
          {children}
        </ButtonLink>
      ) : (
        <Button variant="quiet" size="icon-sm" aria-label={label} onClick={onClick} disabled={disabled} {...data}>
          {children}
        </Button>
      )}
    </Tooltip>
  );
}

/** Чип «Група»: меню групп автора, «усі» — снять отбор */
function GroupChip({
  groups,
  value,
  label,
  onChange,
}: {
  groups: PatientGroupWithCounts[];
  value: string;
  label: string | null;
  onChange: (id: string) => void;
}) {
  const { ut } = useLang();
  return (
    <MenuButton
      label={ut("mlx.group")}
      trigger={(p) => (
        <FilterChip
          label={ut("mlx.group")}
          value={label ?? ut("mlx.allGroups")}
          on={!!value}
          expanded={p["aria-expanded"]}
          onClick={p.onClick}
          onClear={value ? () => onChange("") : undefined}
        />
      )}
    >
      {(close) => (
        <>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!value}
            className={menuItemClass("left")}
            onClick={() => {
              close();
              onChange("");
            }}
          >
            <span className="min-w-0 flex-1 truncate">{ut("mlx.allGroups")}</span>
            {!value ? <Ic.check size={15} className="text-violet-ink" /> : null}
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              role="menuitemradio"
              aria-checked={g.id === value}
              className={menuItemClass("left")}
              onClick={() => {
                close();
                onChange(g.id);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{g.title}</span>
              <span className="text-caption font-bold tabular-nums text-muted">{g.memberCount}</span>
              {g.id === value ? <Ic.check size={15} className="text-violet-ink" /> : null}
            </button>
          ))}
        </>
      )}
    </MenuButton>
  );
}
