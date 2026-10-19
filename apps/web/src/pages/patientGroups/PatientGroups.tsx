import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { t, type PatientGroup, type PatientGroupWithCounts } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { Avatar, KbdHints, Loading, Empty, useToast } from "../../ui";
import { DataTable, type Column } from "../../ui/DataTable";
import { FilterBar } from "../../ui/filters";
import { Ic } from "../../ui/icons";
import { IconTile, Page, Panel } from "../../ui/layout";
import { Tooltip } from "../../ui/Popover";
import { Button, ButtonLink, Tag } from "../../ui/primitives";
import { useUrlState } from "../../ui/urlState";
import { useResource } from "../../useResource";
import { AssignDrawer } from "../../components/AssignDrawer";
import { GroupEditDrawer } from "./drawers";
import { useHotkeys } from "../../ui/keys";
import { HeartIcon, Pi } from "./icons";
import { pluralForm } from "../../ui/plural";
import {
  FAVORITES_KEY,
  favouritesToMove,
  fill,
  groupsSummary,
  inGroupView,
  matchesQuery,
  parseFavorites,
  shortDate,
  sortGroups,
  surveyCode,
  type GroupSort,
  type GroupView,
} from "./model";

/*
 * «Групи пацієнтів» — таблица групп (patients-groups «Виразної»).
 *
 * Не путать с /groups: там группы МЕТОДИК, единица разграничения доступа.
 * Здесь — рабочие списки специалиста: «Вечірня група», «Група ризику». Строка
 * таблицы отвечает на вопросы, ради которых группу открывают: кто в ней
 * (людей), что ей назначено (коды методик), кто уже прошёл назначенное, есть
 * ли в ней ризик, кто её ведёт и когда она менялась. Всё — одним ответом
 * GET /api/patient-groups (routes/patientGroups.ts).
 *
 * Обрані — первыми: закладка читателя на сервере. Отметки, поставленные в
 * браузере до того, как маршрут появился, переезжают туда один раз
 * (model.ts, favouritesToMove).
 *
 * Открыть группу — строка (Enter); правка, новая группа и назначение теста —
 * в ящике, таблица остаётся на месте. «Веде» и вид «Веду я» появляются, когда
 * в списке есть чужие группы (у суперадмина): у специалиста все группы —
 * его, и колонка из одного имени только занимала бы ширину на 1280.
 *
 * Отбор и порядок — в адресе (?view, ?q, ?sort): ссылку пересылают.
 */

type Drawer = { kind: "edit"; id: string | null } | { kind: "assign"; id: string } | null;

/**
 * Отметки «обрана», поставленные в браузере до серверной закладки, — на
 * сервер, и ключ браузера стирается. Повторный вызов после переноса ничего
 * не делает: ключа уже нет. Хранилище недоступно или сервер отказал —
 * список отдаётся как пришёл, перенос повторится при следующем открытии.
 */
async function moveLocalFavourites(groups: PatientGroupWithCounts[]): Promise<PatientGroupWithCounts[]> {
  let ids: string[];
  try {
    ids = favouritesToMove(parseFavorites(localStorage.getItem(FAVORITES_KEY)), groups);
  } catch {
    return groups;
  }
  try {
    for (const id of ids) await api.favouritePatientGroup(id, true);
    localStorage.removeItem(FAVORITES_KEY);
  } catch {
    return groups;
  }
  const moved = new Set(ids);
  return moved.size ? groups.map((g) => (moved.has(g.id) ? { ...g, favourite: true } : g)) : groups;
}

export default function PatientGroups() {
  const { ut, lang } = useLang();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [q, setQ] = useUrlState("q");
  const [viewRaw, setView] = useUrlState("view");
  const [sortRaw, setSort] = useUrlState("sort");
  const view: GroupView = (["fav", "mine", "notests"] as const).find((v) => v === viewRaw) ?? "all";
  const sort: GroupSort = (["title", "members", "risk"] as const).find((v) => v === sortRaw) ?? "fav";

  /* прежние отметки браузера переезжают на сервер в самой загрузке списка, один раз (moveLocalFavourites) */
  const list = useResource(async () => moveLocalFavourites(await api.patientGroups()), []);
  const groups = list.data;

  const owners = useMemo(() => new Set((groups ?? []).map((g) => g.ownerId)), [groups]);
  const othersToo = owners.size > 1 || (owners.size === 1 && !owners.has(user?.id ?? ""));

  const searched = useMemo(
    () => (groups ?? []).filter((g) => matchesQuery(q, g.title, g.description)),
    [groups, q],
  );
  const rows = useMemo(
    () => sortGroups(searched.filter((g) => inGroupView(g, view, user?.id ?? null)), sort),
    [searched, view, sort, user?.id],
  );
  const summary = groupsSummary(groups ?? []);

  /* ─── закладка ─── */

  const toggleFavourite = async (g: PatientGroupWithCounts) => {
    if (!groups) return;
    const next = !g.favourite;
    list.patch(groups.map((x) => (x.id === g.id ? { ...x, favourite: next } : x)));
    try {
      await api.favouritePatientGroup(g.id, next);
    } catch (e) {
      list.reload();
      toast(e instanceof Error ? e.message : ut("ui.actionFailed"), "err");
    }
  };

  /* ─── ящики ─── */

  const [drawer, setDrawer] = useState<Drawer>(null);
  const [lastDrawer, setLastDrawer] = useState<Drawer>(null);
  const open = (d: Drawer) => {
    setDrawer(d);
    if (d) setLastDrawer(d);
  };
  const editing = lastDrawer?.kind === "edit" ? (groups?.find((g) => g.id === lastDrawer.id) ?? null) : null;
  const assigning = lastDrawer?.kind === "assign" ? (groups?.find((g) => g.id === lastDrawer.id) ?? null) : null;

  /* строка в фокусе клавиатуры — ей адресованы F и E */
  const focused = (): PatientGroupWithCounts | null => {
    const key = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("tr[data-key]")?.dataset.key;
    return rows.find((g) => g.id === key) ?? null;
  };
  /* N — новая группа, E — правка, F — обрана: по месту клавиши, в любой раскладке (ui/keys.ts) */
  useHotkeys(
    {
      n: () => open({ kind: "edit", id: null }),
      e: () => {
        const g = focused();
        if (g) open({ kind: "edit", id: g.id });
      },
      f: () => {
        const g = focused();
        if (g) void toggleFavourite(g);
      },
    },
    drawer === null,
  );

  const viewItems = [
    { key: "all", label: ut("pg.allTab"), count: searched.length },
    { key: "fav", label: ut("pg2.viewFav"), count: searched.filter((g) => g.favourite).length },
    ...(othersToo ? [{ key: "mine", label: ut("pg2.viewMine"), count: searched.filter((g) => g.ownerId === user?.id).length }] : []),
    { key: "notests", label: ut("pg2.viewNoTests"), count: searched.filter((g) => g.surveyCount === 0).length },
  ];

  const columns: Column<PatientGroupWithCounts>[] = [
    {
      key: "fav",
      header: "",
      width: 52,
      required: true,
      render: (g) => (
        <Tooltip label={g.favourite ? ut("pg2.unfavourite") : ut("pg2.favourite")} kbd="F">
          <button
            type="button"
            aria-label={`${ut("pg.favorite")}: ${g.title}`}
            aria-pressed={g.favourite}
            onClick={() => void toggleFavourite(g)}
            className={
              g.favourite
                ? "inline-grid size-8 min-h-0 cursor-pointer place-items-center rounded-control border-0 bg-violet-tint p-0 text-violet-ink"
                : "inline-grid size-8 min-h-0 cursor-pointer place-items-center rounded-control border-0 bg-sunk p-0 text-muted hover:bg-sunk-2 hover:text-text"
            }
          >
            <HeartIcon size={15} filled={g.favourite} />
          </button>
        </Tooltip>
      ),
    },
    {
      key: "title",
      header: ut("pg2.colGroup"),
      required: true,
      sort: (g) => g.title,
      render: (g) => (
        <span className="flex min-w-0 items-center gap-3">
          <IconTile icon={<Pi.usersRound />} size={36} />
          <span className="flex min-w-0 flex-col">
            <Link
              to={`/patient-groups/${g.id}`}
              className="line-clamp-1 font-extrabold text-text no-underline hover:text-violet-ink"
            >
              {g.title}
            </Link>
            {g.description ? (
              <small className="line-clamp-1 text-caption text-muted" title={g.description}>
                {g.description}
              </small>
            ) : (
              <small className="line-clamp-1 text-caption font-semibold text-warn">{ut("pg2.noDescription")}</small>
            )}
          </span>
        </span>
      ),
    },
    {
      key: "members",
      header: ut("pg2.colPeople"),
      num: true,
      width: 76,
      required: true,
      sort: (g) => g.memberCount,
      render: (g) => <b className="text-[14px] font-extrabold">{g.memberCount}</b>,
    },
    {
      key: "tests",
      header: ut("pg2.colTests"),
      width: 150,
      required: true,
      render: (g) =>
        g.surveys.length ? (
          <span className="flex flex-wrap gap-1">
            {g.surveys.map((s) => {
              const title = t(s.title, lang);
              return (
                <span
                  key={s.surveyId}
                  title={title}
                  className="inline-block h-[22px] max-w-[132px] truncate rounded-[7px] bg-sunk px-[7px] text-[11.5px] font-extrabold leading-[22px] text-text-2"
                >
                  {surveyCode(title)}
                </span>
              );
            })}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-small font-semibold text-warn">
            <Pi.clipboardList size={14} />
            {ut("pg2.notAssigned")}
          </span>
        ),
    },
    {
      key: "done",
      header: ut("pg2.colDone"),
      width: 168,
      required: true,
      sort: (g) => (g.surveyCount && g.memberCount ? g.doneCount / g.memberCount : -1),
      render: (g) => <DoneBar done={g.doneCount} of={g.memberCount} tests={g.surveyCount} />,
    },
    {
      key: "risk",
      header: ut("pg2.colRisk"),
      width: 132,
      required: true,
      sort: (g) => g.riskCount,
      render: (g) =>
        g.riskCount ? (
          <Link to={`/alerts?patientGroup=${g.id}`} className="no-underline">
            <Tag tone="danger" icon={<Ic.alert />}>
              {fill(ut("pg2.withRisk"), { n: g.riskCount })}
            </Tag>
          </Link>
        ) : (
          <span className="text-small text-muted">{ut("pg2.noRisk")}</span>
        ),
    },
    ...(othersToo
      ? [
          {
            key: "owner",
            header: ut("pg2.colLead"),
            width: 150,
            required: true,
            sort: (g: PatientGroupWithCounts) => g.ownerName,
            render: (g: PatientGroupWithCounts) => (
              <span className="flex min-w-0 items-center gap-2 text-small text-text-2">
                <Avatar name={g.ownerName} size={24} tone={g.ownerId === user?.id ? "violet" : "neutral"} />
                <span className="line-clamp-1">{g.ownerName}</span>
              </span>
            ),
          },
        ]
      : []),
    {
      key: "changed",
      header: ut("pg2.colChanged"),
      width: 76,
      required: true,
      sort: (g) => g.changedAt,
      render: (g) => <span className="whitespace-nowrap text-small tabular-nums text-text-2">{shortDate(g.changedAt)}</span>,
    },
  ];

  const meta: [string, string] | undefined = groups
    ? [
        `${fill(ut(`pg2.groupsN.${pluralForm(summary.groups, lang)}`), { n: summary.groups })}, ${fill(
          ut(`pg2.membersN.${pluralForm(summary.members, lang)}`),
          { n: summary.members },
        )}`,
        [
          summary.risk
            ? fill(ut(`pg2.metaRisk.${pluralForm(summary.riskGroups, lang)}`), { n: summary.risk, g: summary.riskGroups }) : ut("pg2.metaNoRisk"),
          summary.assigned ? fill(ut("pg2.metaWaiting"), { n: summary.waiting, of: summary.assigned }) : null,
        ]
          .filter(Boolean)
          .join("; "),
      ]
    : undefined;

  return (
    <Page
      title={ut("sn.patientGroups")}
      meta={meta}
      sub={ut("pg2.lead")}
      actions={
        <Tooltip label={ut("pg.add")} kbd="N">
          <Button variant="primary" icon={<Ic.plus />} onClick={() => open({ kind: "edit", id: null })}>
            {ut("pg.add")}
          </Button>
        </Tooltip>
      }
    >
      {list.error ? (
        <Loading error={list.error} onRetry={list.reload} />
      ) : !groups ? (
        <Loading rows={6} />
      ) : groups.length === 0 ? (
        <Empty
          icon={<Pi.usersRound />}
          title={ut("pg2.emptyTitle")}
          hint={ut("pg2.emptyText")}
          action={
            <Button variant="primary" icon={<Ic.plus />} onClick={() => open({ kind: "edit", id: null })}>
              {ut("pg.add")}
            </Button>
          }
        />
      ) : (
        <Panel flush>
          <div className="px-4 pb-3 pt-3.5">
            <FilterBar
              search={{ value: q, onChange: setQ, placeholder: ut("pg2.searchPh"), width: 240 }}
              views={{ items: viewItems, value: view, onChange: (k) => setView(k === "all" ? "" : k), label: ut("pg2.views") }}
              count={{ shown: rows.length, total: groups.length }}
              sort={{
                options: [
                  { key: "fav", label: ut("pg2.sortFav") },
                  { key: "title", label: ut("pg2.sortTitle") },
                  { key: "members", label: ut("pg2.sortMembers") },
                  { key: "risk", label: ut("pg2.sortRisk") },
                ],
                value: sort,
                onChange: (k) => setSort(k === "fav" ? "" : k),
              }}
            />
          </div>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(g) => g.id}
            label={ut("sn.patientGroups")}
            onRowClick={(g) => navigate(`/patient-groups/${g.id}`)}
            hotkeys={drawer === null}
            empty={<p className="m-0 px-4 pb-5 pt-2 text-small text-muted">{q.trim() ? ut("pg.emptySearch") : ut("pg2.emptyView")}</p>}
            rowActions={(g) => (
              <>
                <Tooltip label={ut("pg2.openInRegistry")}>
                  <ButtonLink to={`/patients?group=${g.id}`} variant="quiet" size="icon-sm" aria-label={ut("pg2.openInRegistry")}>
                    <Pi.tableProps />
                  </ButtonLink>
                </Tooltip>
                <Tooltip label={ut("cn.assignGroup")}>
                  <Button
                    variant="quiet"
                    size="icon-sm"
                    aria-label={`${ut("cn.assignGroup")}: ${g.title}`}
                    disabled={g.memberCount === 0}
                    onClick={() => open({ kind: "assign", id: g.id })}
                  >
                    <Pi.clipboardPlus />
                  </Button>
                </Tooltip>
                <Tooltip label={ut("pg.edit")} kbd="E">
                  <Button
                    variant="quiet"
                    size="icon-sm"
                    aria-label={`${ut("pg.edit")}: ${g.title}`}
                    onClick={() => open({ kind: "edit", id: g.id })}
                  >
                    <Pi.pencilLine />
                  </Button>
                </Tooltip>
              </>
            )}
          />
          <KbdHints
            bar
            keys={[
              ["J K", ut("pg2.kRows")],
              ["Enter", ut("pg2.kOpen")],
              ["F", ut("pg2.kFav")],
              ["E", ut("pg2.kEdit")],
              ["/", ut("pg2.kSearch")],
              ["N", ut("pg2.kAdd")],
            ]}
          />
        </Panel>
      )}

      <GroupEditDrawer
        open={drawer?.kind === "edit"}
        group={editing}
        neighbours={{
          all: null,
          next: (() => {
            const others = (groups ?? []).filter((g) => g.id !== editing?.id);
            return others[0] ? { title: others[0].title, memberCount: others[0].memberCount } : null;
          })(),
        }}
        onClose={() => setDrawer(null)}
        onReturn={() => setDrawer(lastDrawer)}
        onSaved={(saved: PatientGroup) => {
          setDrawer(null);
          /* новая группа открывается сразу карточкой: её заводят, чтобы набрать людей, а набирают их там */
          if (!editing) navigate(`/patient-groups/${saved.id}`);
          else list.reload();
        }}
      />
      <AssignDrawer
        choose="test"
        open={drawer?.kind === "assign"}
        who={assigning ? fill(ut(`pg2.whoGroup.${pluralForm(assigning.memberCount, lang)}`), { name: assigning.title, n: assigning.memberCount }) : ""}
        whoNote={ut("pg2.assignGroupNote")}
        already={new Set(assigning?.surveys.map((s) => s.surveyId) ?? [])}
        onAssign={async (surveyId, expiresAt) => {
          if (!assigning) throw new Error(ut("ui.actionFailed"));
          const res = await api.assignSurveyToPatientGroup(assigning.id, { surveyId, expiresAt });
          list.reload();
          return `${ut("cn.assignedToGroup")} «${assigning.title}»: ${ut("cn.recipients")} — ${res.recipients}`;
        }}
        onClose={() => setDrawer(null)}
        onReturn={() => setDrawer(lastDrawer)}
      />
    </Page>
  );
}

/**
 * «Пройшли призначене»: «18 з 24» и «чекають 6» над полосой. Полная — зелёная
 * (сделано), неполная — фиолетовая; без методик — прочерк: проходить нечего.
 */
export function DoneBar({ done, of, tests }: { done: number; of: number; tests: number }) {
  const { ut } = useLang();
  if (!tests || !of) return <span className="text-small text-muted">—</span>;
  const full = done >= of;
  const pct = Math.round((done / of) * 100);
  return (
    <div className="w-full min-w-[120px]">
      <div className="mb-[5px] flex items-baseline justify-between gap-2 text-caption text-muted">
        <span className="whitespace-nowrap">
          <b className="text-[13px] font-extrabold text-text">{done}</b> {ut("common.of")} {of}
        </span>
        <span className="whitespace-nowrap">{full ? ut("pg2.all") : fill(ut("pg2.waiting"), { n: of - done })}</span>
      </div>
      <span aria-hidden className="relative block h-2 overflow-hidden rounded-[4px] bg-track">
        <i className={`absolute inset-y-0 left-0 rounded-[4px] ${full ? "bg-good" : "bg-violet"}`} style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}
