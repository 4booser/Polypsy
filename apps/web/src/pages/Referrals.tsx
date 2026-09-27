
import { Link } from "react-router-dom";
import type { Referral, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { Avatar, DataTable, Empty, Loading, useAction, useUrlState } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button } from "../ui/primitives";
import { useLang } from "../lang";
import { SavedViews } from "../ui/SavedViews";
import { usePagedResource } from "../useResource";
import { listBody, shownNote } from "../ui/paging";
import { DESTINATION_KEY, STATUS_KEY, URGENCY_KEY, closedParam, referralSorts, showClosed } from "./referrals/model";

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
 * Реестр направлений.
 *
 * Смысл экрана — не в самих записях, а в том, что незакрытое направление
 * видно и через месяц: «отправили к психиатру» без обратной связи — самый
 * частый разрыв клинического контура.
 */
export default function ReferralsPage() {
  const [allParam, setAllParam] = useUrlState("all");
  const all = showClosed(allParam);
  const setAll = (v: boolean) => setAllParam(closedParam(v));
  const { run } = useAction();
  const { ut } = useLang();
  const sorts = referralSorts(ut);

  /*
   * Реестр приезжает страницами (волна 12): раньше он обрывался на двухсотом
   * направлении, и дальше было не пройти — строка советовала «сузить
   * выборку» переключателем, который её расширяет. Теперь за страницей есть
   * продолжение: строка над таблицей говорит, сколько показано из скольких,
   * кнопка под ней дозагружает следующую страницу.
   *
   * Сортировка и выгрузка таблицы работают по тому, что уже приехало, — и
   * строка «показано не всё» стоит ровно для того, чтобы это было видно.
   */
  const page = usePagedResource<Referral>((cursor) => api.referrals(all, cursor), [all]);
  const reload = page.reload;
  const rows = page.items;

  /*
   * Обрыв связи объявляет строка оболочки (ui/ConnectionLine.tsx); здесь —
   * скелет до первых строк, отказ на их месте, отказ поверх уже показанных —
   * строкой (listBody в ui/paging.ts); пусто — пустое состояние таблицы.
   */
  const body = listBody(rows, page.error);
  if (!rows) return <Loading rows={4} error={page.error} onRetry={page.reload} busy={page.loading} />;
  const note = shownNote(ut, rows.length, page.total, page.hasMore);

  return (
    <>
      {body.stale ? <p className="m-0 text-caption text-danger">{body.stale}</p> : null}
      <Page
        title={ut("ref.title")}
        sub={all ? ut("ref.allSub") : ut("ref.openSub")}
        count={page.total ?? rows.length}
        actions={
          <Button variant="ghost" onClick={() => setAll(!all)}>
            {all ? ut("ref.onlyOpen") : ut("ref.showClosed")}
          </Button>
        }
        toolbar={<SavedViews scope="referrals" />}
      >
        <Stack>
          {note ? <p className="m-0 text-caption text-muted">{note}</p> : null}
          <Panel flush>
            <DataTable
              rows={rows}
              csvName={ut("ref.csvName")}
              stateKey="referrals"
              initialSort={{ key: "createdAt", desc: true }}
              empty={
                <Empty
                  title={all ? ut("ref.none") : ut("ref.noneOpen")}
                  hint={ut("ref.noneHint")}
                />
              }
              columns={[
                {
                  key: "userName",
                  header: ut("ref.patient"),
                  render: (r: Referral) => (
                    <Link className="row tight" to={`/patients/${r.userId}`}>
                      <Avatar name={r.userName} />
                      {r.userName}
                    </Link>
                  ),
                  sort: sorts.userName,
                },
                {
                  key: "destination",
                  header: ut("ref.where"),
                  render: (r: Referral) => ut(DESTINATION_KEY[r.destination]),
                  sort: sorts.destination,
                },
                {
                  key: "urgency",
                  header: ut("ref.urgency"),
                  render: (r: Referral) => (
                    <span className={r.urgency === "immediate" ? "font-medium text-danger" : undefined}>
                      {ut(URGENCY_KEY[r.urgency])}
                    </span>
                  ),
                  /* порядок — ступенью срочности, в файл — подписью (referrals/model.ts) */
                  sort: sorts.urgency,
                  csv: (r: Referral) => ut(URGENCY_KEY[r.urgency]),
                },
                {
                  key: "status",
                  header: ut("ref.status"),
                  render: (r: Referral) => ut(STATUS_KEY[r.status]),
                  sort: sorts.status,
                  csv: (r: Referral) => ut(STATUS_KEY[r.status]),
                },
                {
                  key: "reason",
                  header: ut("ref.reason"),
                  render: (r: Referral) => <span className="text-muted">{r.reason ?? "—"}</span>,
                  sort: sorts.reason,
                },
                {
                  key: "createdAt",
                  header: ut("ref.issued"),
                  render: (r: Referral) => (
                    <span className="text-muted">
                      {day(r.createdAt)}, {r.createdByName}
                    </span>
                  ),
                  sort: sorts.createdAt,
                },
                {
                  key: "act",
                  header: "",
                  render: (r: Referral) => (
                    <div className="flex flex-wrap gap-1.5">
                      {(NEXT_STATUS[r.status] ?? []).map((n) => (
                        <Button
                          key={n.value}
                          variant="quiet"
                          size="sm"
                          onClick={() =>
                            run(async () => {
                              await api.updateReferral(r.id, n.value);
                              reload();
                            }, ut(n.key))
                          }
                        >
                          {ut(n.key)}
                        </Button>
                      ))}
                    </div>
                  ),
                },
              ]}
            />
          </Panel>
          {page.hasMore ? (
            <div className="flex justify-center">
              <Button variant="ghost" disabled={page.loadingMore} onClick={page.loadMore}>
                {page.loadingMore ? ut("ui.loadingMore") : ut("ui.loadMore")}
              </Button>
            </div>
          ) : null}
        </Stack>
      </Page>
    </>
  );
}
