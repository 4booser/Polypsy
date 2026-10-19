import { type ReactNode, useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import type { OpsSession, OpsSessionPage, Role } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { locale } from "../../format";
import { useLang } from "../../lang";
import { Callout, DataTable, FilterBar, KbdHints, Loading, useAction, type Column } from "../../ui";
import { Ic } from "../../ui/icons";
import { Panel } from "../../ui/layout";
import { Tooltip } from "../../ui/Popover";
import { Pager } from "../../ui/pager";
import { listBody, pageCount } from "../../ui/paging";
import { Button, ErrorText, Tag } from "../../ui/primitives";
import { type Resource, useResource } from "../../useResource";
import { useDebounced } from "./controls";
import { SectionPage } from "./people2/frame";
import { Ix } from "./people2/icons";
import { SessionsSummary } from "./sessions/summary";
import { readSessionsFilters, sessionsEmptyKey, sessionsQuery } from "./sessionsModel";
import { AccountAvatar, ChoiceChip, clock, fill, numDay, RolePill, stamp } from "./users/parts";
import { accountOutOfReach } from "./usersModel";

/*
 * Техпанель → «Сесії»: кто сейчас держит вход в систему.
 *
 * Сессия — семья refresh-токенов: вход рождает её, каждое обновление токена
 * выдаёт в ней новый. Строка — человек, когда вошёл, когда последний раз
 * обновлял токен и до какого числа сессия проживёт без входа. «Завершити» —
 * отзыв семьи и сдвиг границы access-токенов: у этой сессии больше ничего
 * не откроется, остальные сессии человека незаметно обменяют токен.
 *
 * Устройства и адреса в строке нет, и это не недосмотр: у refresh-токена они
 * не хранятся. Подбирать их по журналу входов значило бы показывать догадку
 * как факт — об этом строка над таблицей говорит прямо.
 *
 * Polypsy 2.0 («Виразна»): сверху — кто держит вход по роли и сколько
 * сессиям от входа; в таблице — отбор по роли и возрасту (сессии пациентов
 * старше 30 дней отбираются из сводки одним нажатием). Фильтр по человеку —
 * ?user=<id> (так сюда ведёт меню строки «Користувачі») или поиском по ФИО и
 * почте.
 */

const MINUTE = 60_000;

/** «щойно», «12 хв тому», «3 год тому» — пока свежо; дальше — дата и время */
function ago(iso: string, ut: (k: "oppa.justNow" | "oppa.minAgo" | "oppa.hoursAgo") => string, now = Date.now()): string {
  const d = now - Date.parse(iso);
  if (d < 2 * MINUTE) return ut("oppa.justNow");
  if (d < 60 * MINUTE) return fill(ut("oppa.minAgo"), { n: Math.floor(d / MINUTE) });
  if (d < 12 * 60 * MINUTE) return fill(ut("oppa.hoursAgo"), { n: Math.floor(d / (60 * MINUTE)) });
  return stamp(iso);
}

export default function OpsSessions() {
  const { ut } = useLang();
  const { user } = useAuth();
  const { run, busy } = useAction();
  const [params, setParams] = useSearchParams();
  /*
   * Отбор — из адреса, но через разбор (sessionsModel.ts): человек не
   * идентификатором, страница за пределом сервера, абзац в поиске значат
   * «условия нет», а не «Невірний запит» на месте списка.
   */
  const filters = readSessionsFilters(params);
  const { q, userId, role, age, page, per } = filters;
  const settledQ = useDebounced(q);

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

  const query = sessionsQuery(filters, settledQ);
  const res = useResource(() => api.opsSessions(query), [query]);
  const summary = useResource(() => api.opsSessionsSummary(), []);
  const pages = pageCount(res.data?.total ?? 0, per);
  useEffect(() => {
    if (res.data && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [res.data, page, pages, update]);

  /* у человека из адреса имя берётся из первой же строки: отдельного запроса за ним не нужно */
  const who = userId ? res.data?.items[0] : undefined;
  const total = summary.data?.byRole.reduce<number | null>((s, r) => (s === null || r.sessions === null ? null : s + r.sessions), 0) ?? null;
  const staff = summary.data?.byRole.filter((r) => r.role !== "user").reduce((s, r) => s + (r.sessions ?? 0), 0) ?? null;
  const patients = summary.data?.byRole.find((r) => r.role === "user")?.sessions ?? null;

  const reload = () => {
    res.reload();
    summary.reload();
  };
  /* числа — в форме языка: «1 284», а не «1284» */
  const num = (v: number) => v.toLocaleString(locale());

  return (
    <SectionPage
      title={ut("ops.tab.sessions")}
      meta={
        summary.data
          ? [
              total !== null ? fill(ut("oppa.metaTotal"), { n: num(total) }) : fill(ut("oppa.metaStaff"), { n: num(staff ?? 0) }),
              fill(ut("oppu.metaSplit"), { s: staff === null ? "—" : num(staff), p: patients === null ? "—" : num(patients) }),
            ]
          : undefined
      }
      perm="users.manage"
      actions={
        <>
          {res.updatedAt ? (
            <span className="text-small text-muted tabular-nums">{fill(ut("oppa.updated"), { t: clock(new Date(res.updatedAt).toISOString()) })}</span>
          ) : null}
          <Button icon={<Ic.refresh />} onClick={reload}>
            {ut("oppa.refresh")}
          </Button>
        </>
      }
      lead={ut("oppa.lead")}
    >
      <div className="flex flex-col gap-4">
        {/*
          Сводка — над списком. По одному человеку (?user=) её нет: экран
          тогда про его сессии, и график всей системы над тремя строками был
          бы шумом.
        */}
        {userId ? null : (
          <SessionsSummary
            data={summary.data}
            error={summary.error}
            onRetry={summary.reload}
            onOlderPatients={() => update({ role: "user", age: "older", page: null })}
          />
        )}
        <Panel flush>
          <div className="px-4 pb-3 pt-3.5">
            <FilterBar
              search={{
                value: q,
                onChange: (v) => update({ q: v, page: null }),
                placeholder: ut("ops.sessions.search"),
                label: ut("ops.sessions.search"),
                width: 250,
              }}
              chips={
                <>
                  <ChoiceChip
                    label={ut("adm.role")}
                    value={role}
                    onChange={(v) => update({ role: v, page: null })}
                    choices={[
                      { value: "", label: ut("ops.users.allRoles") },
                      { value: "staff", label: ut("oppu.view.staff") },
                      { value: "superadmin", label: ut("adm.roleSuper") },
                      { value: "admin", label: ut("adm.roleAdmin") },
                      { value: "user", label: ut("adm.rolePatient") },
                    ]}
                  />
                  <ChoiceChip
                    label={ut("oppa.age")}
                    value={age}
                    onChange={(v) => update({ age: v, page: null })}
                    choices={[
                      { value: "", label: ut("oppa.anyAge") },
                      { value: "day", label: ut("opsp.age.day") },
                      { value: "week", label: ut("opsp.age.week") },
                      { value: "month", label: ut("opsp.age.month") },
                      { value: "older", label: ut("opsp.age.older") },
                    ]}
                  />
                  {userId ? (
                    <span className="inline-flex h-9 items-center gap-2 rounded-[18px] bg-violet-tint pl-3 pr-1.5 text-small font-semibold text-violet-ink">
                      {ut("ops.sessions.onlyOf")}: <b className="font-extrabold [overflow-wrap:anywhere]">{who?.email ?? userId.slice(0, 8)}</b>
                      <Button size="xs" variant="quiet" onClick={() => update({ user: null, page: null })}>
                        {ut("ops.sessions.showAll")}
                      </Button>
                    </span>
                  ) : null}
                </>
              }
              count={
                res.data ? (
                  <span className="whitespace-nowrap text-small text-muted" aria-live="polite">
                    {ut("ppl.found")} <b className="font-extrabold tabular-nums text-text">{num(res.data.total)}</b>
                  </span>
                ) : undefined
              }
            />
          </div>
          <div className="px-4 pb-3">
            <Callout kind="info" icon={<Ic.info />}>
              {ut("ops.sessions.noDevice")}
            </Callout>
          </div>
          <SessionsList
            res={res}
            empty={ut(sessionsEmptyKey({ q: settledQ, userId, role, age }))}
            me={user}
            busy={busy}
            onEnd={(s) =>
              void run(async () => {
                await api.revokeSession(s.id);
                res.reload();
                summary.reload();
              }, ut("ops.sessions.ended"))
            }
          />
          <div className="border-t border-divider py-2.5 pl-4 pr-3">
            <Pager
              page={page}
              pages={pages}
              per={per}
              total={res.data?.total ?? null}
              onPer={(n) => update({ per: String(n), page: null })}
              onPage={(p) => update({ page: p > 1 ? String(p) : null })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-divider px-4 py-2.5">
            <span className="inline-flex items-center gap-2 text-small text-muted">
              <Ic.lock size={14} />
              {ut("oppa.lockNote")}
            </span>
            <KbdHints className="ml-auto" label={ut("oppa.keys")} keys={[["J K", ut("oppu.kRows")], ["/", ut("hotkey.search")]]} />
          </div>
        </Panel>
      </div>
    </SectionPage>
  );
}

/**
 * Список сессий — всё, что он показывает, из загрузки и «идёт ли действие»:
 * без своих решений и без сети, поэтому его состояния проверяются без
 * браузера (test/opsSessions.test.tsx). Место списка — по общему правилу
 * (listBody, ui/paging.ts): отказ перечитывания после «Завершити» строки не
 * стирает.
 */
export function SessionsList({
  res,
  empty,
  me,
  busy,
  onEnd,
}: {
  res: Pick<Resource<OpsSessionPage>, "data" | "error" | "reload">;
  empty: string;
  /**
   * Кто смотрит. Сессии учётки на его ступени или выше — без «Завершити»
   * (#175): сервер ответил бы err.accountAtOrAboveYours и записал отказ в
   * журнал. Правило то же, что у меню строки «Користувачів»
   * (accountOutOfReach); своя сессия завершается — это выход.
   */
  me: { id: string; role: Role; ladderRank?: number | null } | null | undefined;
  /** Идёт завершение: кнопки «Завершити» погашены у всех строк — вторая сессия не уйдёт, пока не кончилась первая */
  busy: boolean;
  onEnd: (s: OpsSession) => void;
}) {
  const { ut } = useLang();
  const place = listBody(res.data?.items ?? null, res.error);
  if (place.body === "loading" || place.body === "failed")
    return (
      <div className="px-4 pb-4">
        <Loading rows={6} error={res.error} onRetry={res.reload} bare />
      </div>
    );

  const columns: Column<OpsSession>[] = [
    {
      key: "account",
      header: ut("ops.users.account"),
      required: true,
      width: 260,
      render: (s) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <AccountAvatar row={{ ...s, anonymous: false }} />
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <b className="truncate text-body font-bold leading-[18px] text-text">{s.fullName || s.email}</b>
              {s.userId === me?.id ? (
                <Tag tone="primary" className="h-[18px] px-1.5 text-[10.5px]">
                  {ut("oppu.you")}
                </Tag>
              ) : null}
            </span>
            <small className="truncate text-caption text-muted">{s.email}</small>
          </span>
        </span>
      ),
    },
    { key: "role", header: ut("adm.role"), required: true, width: 190, render: (s) => <RolePill role={s.role} /> },
    {
      key: "started",
      header: ut("ops.sessions.started"),
      required: true,
      width: 130,
      render: (s) => (
        <span className="flex flex-col gap-[3px]">
          <span className="font-semibold tabular-nums text-text">{stamp(s.startedAt)}</span>
          {Date.now() - Date.parse(s.startedAt) > 30 * 24 * 60 * MINUTE ? (
            <small className="text-caption font-bold leading-4 text-warn">{ut("oppa.over30")}</small>
          ) : null}
        </span>
      ),
    },
    {
      key: "last",
      header: ut("ops.sessions.lastUsed"),
      required: true,
      width: 150,
      render: (s) => <span className="tabular-nums text-text-2">{ago(s.lastUsedAt, ut)}</span>,
    },
    {
      key: "expires",
      header: ut("ops.sessions.expires"),
      required: true,
      width: 100,
      render: (s) => <span className="tabular-nums text-text-2">{numDay(s.expiresAt).slice(0, 5)}</span>,
    },
    {
      key: "end",
      header: "",
      required: true,
      width: 130,
      render: (s): ReactNode =>
        accountOutOfReach(me, { id: s.userId, role: s.role, ladderRank: s.ladderRank }) ? (
          <Tooltip label={ut("oppa.aboveTip")}>
            <span tabIndex={0} className="inline-flex items-center gap-1.5 text-small text-muted">
              <Ic.lock size={13} />
              {ut("oppa.above")}
            </span>
          </Tooltip>
        ) : (
          <Button
            size="xs"
            icon={<Ix.logOut />}
            disabled={busy}
            aria-label={`${ut("ops.sessions.end")}: ${s.fullName || s.email}`}
            onClick={() => onEnd(s)}
          >
            {ut("ops.sessions.end")}
          </Button>
        ),
    },
  ];

  return (
    <>
      {place.stale ? (
        <div role="alert" className="mx-4 mb-2.5 flex items-center gap-2.5">
          <ErrorText className="min-w-0 flex-1">{place.stale}</ErrorText>
          <Button size="xs" variant="quiet" onClick={res.reload}>
            {ut("common.retry")}
          </Button>
        </div>
      ) : null}
      {place.body === "empty" ? (
        <p className="m-0 px-4 pb-5 pt-2 text-small text-muted">{empty}</p>
      ) : (
        <DataTable rows={res.data!.items} columns={columns} rowKey={(s) => s.id} label={ut("opsp.sess.list")} hotkeys />
      )}
    </>
  );
}

