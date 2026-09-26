import { useCallback, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { dateTime } from "../../format";
import { useLang } from "../../lang";
import { Loading, useAction } from "../../ui";
import { Pager } from "../../ui/pager";
import { pageCount, pageFrom, perFrom } from "../../ui/paging";
import { Button } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { Cell, ColumnHead, SearchField, metaClass, nameClass, rowClass, useDebounced } from "./controls";
import { ROLE_KEY, personHref } from "./model";

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
 * как факт — об этом строка под отбором говорит прямо.
 *
 * Фильтр по человеку — ?user=<id> (так сюда ведёт меню строки
 * «Користувачі») или поиском по ФИО и почте.
 */

const GRID =
  "grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,1.2fr)_auto] gap-x-[20px]";

export default function OpsSessions() {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const userId = params.get("user") ?? "";
  const page = pageFrom(params.get("page"));
  const per = perFrom(params.get("per"));
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

  const res = useResource(
    () => api.opsSessions({ q: settledQ, userId: userId || undefined, page: String(page), per: String(per) }),
    [settledQ, userId, page, per],
  );
  const pages = pageCount(res.data?.total ?? 0, per);
  useEffect(() => {
    if (res.data && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [res.data, page, pages, update]);

  /* у человека из адреса имя берётся из первой же строки: отдельного запроса за ним не нужно */
  const who = userId ? res.data?.items[0] : undefined;

  return (
    <>
      <div className="mb-[12px] grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[12px] max-[900px]:grid-cols-1">
        <SearchField label={ut("ops.sessions.search")} value={q} onChange={(v) => update({ q: v, page: null })} />
        <Pager
          page={page}
          pages={pages}
          per={per}
          onPer={(n) => update({ per: String(n), page: null })}
          onPage={(p) => update({ page: p > 1 ? String(p) : null })}
        />
      </div>
      <div className="mb-[18px] flex flex-wrap items-center gap-[16px]">
        <span className="font-mono text-[13px] text-muted tabular-nums" aria-live="polite">
          {res.data ? `${ut("ppl.found")} ${res.data.total}` : ""}
        </span>
        {userId ? (
          <span className="flex flex-wrap items-center gap-[8px] text-[13px] text-text-2">
            {ut("ops.sessions.onlyOf")}: <strong className="[overflow-wrap:anywhere]">{who?.email ?? userId.slice(0, 8)}</strong>
            <Button variant="quiet" onClick={() => update({ user: null, page: null })}>
              {ut("ops.sessions.showAll")}
            </Button>
          </span>
        ) : null}
        <span className="text-[13px] text-muted">{ut("ops.sessions.noDevice")}</span>
      </div>

      {res.error ? (
        <Loading error={res.error} onRetry={res.reload} />
      ) : !res.data ? (
        <Loading rows={6} />
      ) : res.data.items.length === 0 ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">{ut("ops.sessions.none")}</p>
      ) : (
        <>
          <ColumnHead
            grid={GRID}
            labels={[
              ut("ops.users.account"),
              ut("adm.role"),
              ut("ops.sessions.started"),
              ut("ops.sessions.lastUsed"),
              ut("ops.sessions.expires"),
              null,
            ]}
          />
          <ul className="m-0 list-none p-0">
            {res.data.items.map((s) => (
              <li key={s.id} className={rowClass(GRID)}>
                <div className="min-w-0">
                  <Link to={personHref({ id: s.userId, role: s.role })} className={nameClass}>
                    {s.fullName || s.email}
                  </Link>
                  <span className={metaClass}>{s.email}</span>
                </div>
                <Cell label={ut("adm.role")}>{ut(ROLE_KEY[s.role])}</Cell>
                <Cell label={ut("ops.sessions.started")}>{dateTime(s.startedAt)}</Cell>
                <Cell label={ut("ops.sessions.lastUsed")}>{dateTime(s.lastUsedAt)}</Cell>
                <Cell label={ut("ops.sessions.expires")}>{dateTime(s.expiresAt)}</Cell>
                <div className="flex justify-end max-[900px]:justify-start">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    aria-label={`${ut("ops.sessions.end")}: ${s.fullName || s.email}`}
                    onClick={() =>
                      void run(async () => {
                        await api.revokeSession(s.id);
                        res.reload();
                      }, ut("ops.sessions.ended"))
                    }
                  >
                    {ut("ops.sessions.end")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
