
import { Link } from "react-router-dom";
import type { Referral, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { day } from "../format";
import { Avatar, DataTable, Empty, Loading, OfflineBar, useAction, useUrlState } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button } from "../ui/primitives";
import { useLang } from "../lang";
import { SavedViews } from "../ui/SavedViews";
import { usePagedResource } from "../useResource";
import { shownNote } from "../ui/paging";

export const DESTINATION_KEY = {
  psychiatrist: "dest.psychiatrist",
  inpatient: "dest.inpatient",
  outpatient: "dest.outpatient",
  commander: "dest.commander",
  other: "dest.other",
} as const;
export const URGENCY_KEY = {
  routine: "urg.routine",
  urgent: "urg.urgent",
  immediate: "urg.immediate",
} as const;
export const STATUS_KEY = {
  created: "st.created",
  accepted: "st.accepted",
  completed: "st.completed",
  declined: "st.declined",
} as const;
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
  const all = allParam === "1";
  const setAll = (v: boolean) => setAllParam(v ? "1" : "");
  const { run } = useAction();
  const { ut } = useLang();

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

  if (!rows) {
    return page.offline ? (
      <>
        <OfflineBar onRetry={page.reload} busy={page.loading} />
        <Loading rows={4} />
      </>
    ) : (
      <Loading rows={4} error={page.error} onRetry={page.reload} busy={page.loading} />
    );
  }
  const note = shownNote(ut, rows.length, page.total, page.hasMore);

  return (
    <>
      {page.offline ? <OfflineBar onRetry={page.reload} busy={page.loadingMore} /> : null}
      {page.error ? <p className="m-0 text-caption text-danger">{page.error}</p> : null}
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
                  sort: (r: Referral) => r.userName,
                },
                {
                  key: "destination",
                  header: ut("ref.where"),
                  render: (r: Referral) => ut(DESTINATION_KEY[r.destination]),
                  sort: (r: Referral) => r.destination,
                },
                {
                  key: "urgency",
                  header: ut("ref.urgency"),
                  render: (r: Referral) => (
                    <span className={r.urgency === "immediate" ? "font-medium text-danger" : undefined}>
                      {ut(URGENCY_KEY[r.urgency])}
                    </span>
                  ),
                  sort: (r: Referral) => r.urgency,
                },
                {
                  key: "status",
                  header: ut("ref.status"),
                  render: (r: Referral) => ut(STATUS_KEY[r.status]),
                  sort: (r: Referral) => r.status,
                },
                {
                  key: "reason",
                  header: ut("ref.reason"),
                  render: (r: Referral) => <span className="text-muted">{r.reason ?? "—"}</span>,
                  sort: (r: Referral) => r.reason ?? "",
                },
                {
                  key: "createdAt",
                  header: ut("ref.issued"),
                  render: (r: Referral) => (
                    <span className="text-muted">
                      {day(r.createdAt)}, {r.createdByName}
                    </span>
                  ),
                  sort: (r: Referral) => r.createdAt,
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
