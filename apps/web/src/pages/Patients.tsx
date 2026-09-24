import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { PatientGroupWithCounts, Respondent, UiKey } from "@quizzy/shared";
import { api, openInTab } from "../api";
import { Chart, LineChart } from "../charts";
import { versionMarks } from "../charts/marks";
import { Hint } from "../components/Hint";
import { Radar, SeverityTag } from "../charts/advanced";
import { day, severityColor } from "../format";
import { IconSearchGlass, Loading, useAction, useToast } from "../ui";
import { cx } from "../ui/cx";
import { IconGear, IconPlusThick } from "../ui/glyphs";
import { Page } from "../ui/layout";
import { ActionMenu } from "../ui/menu";
import { Pager } from "../ui/pager";
import { DEFAULT_PER, pageCount, pageFrom, pagesOf, perFrom, slicePage } from "../ui/paging";
import { Input, Tabs } from "../ui/primitives";
import { PatientContext } from "../components/PatientContext";
import { useLang } from "../lang";
import { SavedViews } from "../ui/SavedViews";
import { usePagedResource, useResource } from "../useResource";
import { AssignSurveyDialog, PickGroupDialog } from "./patientGroups/dialogs";
import { keepPresent, matchesQuery, toggleIn, type PersonLike } from "./patientGroups/model";
import { PersonGrid, SelectionBar } from "./patientGroups/PersonGrid";

/*
 * Список пациентов — кадр f05 макета: реестр с вкладками-группами.
 *
 * Что на кадре и как это легло на код:
 *
 *   «Пацієнти» · поиск с лупой · «+»              → заголовок, ?q, ссылка на приглашения
 *   «елементів на сторінці · сторінка 1 з 10 ‹ ›»  → ?per и ?page, Pager
 *   вкладки «Моя група · Група ризику · …»          → ?group, Tabs (кнопочный вид)
 *   сетка карточек 3×9 с галочками                  → PersonGrid
 *   «18 вибрано»                                    → SelectionBar и действия над выборкой
 *
 * Откуда люди. Вкладка «Усі» — GET /api/dynamics/respondents: страница за
 * страницей курсором, поиск на сервере, пол и год рождения в строке. Вкладка
 * группы — состав из GET /api/patient-groups/:id: приходит целиком, поиск и
 * страницы на клиенте. Оба маршрута открыты правом patients.read, то есть
 * тем же, что и прежний список; GET /api/access/patients умеет фильтр
 * ?patientGroup=, но закрыт assignments.manage и отдаёт не больше ста
 * человек — экран, который открывают каждый день, на такое опирать нельзя
 * (см. api_gaps отчёта).
 *
 * Что было на глазах мимо кадра и куда ушло (сверка по f05):
 *
 * 1. Вкладка «Усі» первой. На кадре ряд начинается с группы, и признака
 *    «моя» на сервере нет: все группы в выдаче и так свои. Список без
 *    ?group никуда не делся — он открывается адресом и пунктом «Усі» в меню
 *    шестерёнки, где ключ pg.allTab и подписывает состояние «фильтр снят».
 * 2. Действия над выборкой («Додати до групи», «Призначити тест», на
 *    вкладке группы — «Прибрати з групи») и ссылка «Зняти вибір». На кадре
 *    под сеткой напечатано только «18 вибрано»; действия собраны в меню «⋯»
 *    рядом со счётчиком — выборка без действия была бы нарисованной
 *    кнопкой, а четыре кнопки в строке счётчика — не кадром.
 * 3. Панель контекста справа. На кадре колонка ровно 1200 и справа от неё
 *    чисто, а панель отъедала 336. Открывается пунктом меню шестерёнки
 *    («А це хто?»), и только тогда; нажатие по строке её больше не зовёт —
 *    у строки на кадре два действия, имя-ссылка и галочка, третьего там
 *    не нарисовано. Пока панель открыта, она следует за фокусом строки.
 * 4. Сохранённые виды (SavedViews). Строка чипсов стояла между вкладками и
 *    сеткой, а на кадре там 38 px чистого поля; вызывается пунктом меню
 *    шестерёнки. Виды лежат на сервере, у людей уже сохранены, а состояние
 *    экрана по-прежнему целиком в адресе — ?group, ?q, ?per.
 * 5. Подпись под заголовком «Ті, хто проходив методики ваших груп». На
 *    кадре под «Пацієнти» сразу вкладки. Текст остался ключом patients.sub
 *    и печатается в панели контекста: список показывает обследованных, а не
 *    всех заведённых, и молчать об этом нельзя.
 *
 * Шестерёнка в правом конце строки заголовка — с кадра (глиф 1370…1399,
 * y 153…182, прижат к правому краю колонки); всё перечисленное лежит в ней.
 *
 * Расхождение поведения, вынесенное заказчику: знак «+» рядом с поиском на
 * всех списках макета открывает создание, а здесь ведёт на приглашения
 * (/invites) — пациент попадает в систему по ссылке-приглашению, формы
 * «завести пациента» на сервере нет. Подпись глифа это и говорит
 * («Запросити пацієнта»), картинка кадра при этом сохранена.
 *
 * Что ушло вместе с прежней таблицей и почему не вернулось:
 *
 * - Выгрузка CSV. Если понадобится, ей место в том же меню шестерёнки.
 * - Колонки «Замірів» и «Останнє» и сортировка по ним. Строка макета — ПІБ и
 *   мета (e-mail, підрозділ, стать, рік); ни числа замеров, ни даты
 *   последнего в ней нет, а сортировать сетку без шапки не за что нажать.
 *   Порядок — серверный, по ПІБ; «кто давно не проходил» отвечает экран
 *   аналитики, а не реестр.
 * - Фасеты по подразделению, полу и активности. Они считались по уже
 *   приехавшим строкам («по завантажених N») и на большом списке врали;
 *   на кадре фильтр один — поиск, и он серверный.
 *
 * Страницы на вкладке «Усі» строятся поверх курсора: страница N — это
 * строки с (N−1)·per по N·per из того, что уже приехало; если их ещё нет и
 * сервер обещает ещё, следующая порция просится сама (см. эффект в
 * AllPatients). Общее число страниц известно без поиска; с поиском оно
 * растёт по мере листания — честнее, чем выдуманное (см. pagesOf).
 */

/** Что общего у обеих вкладок: адрес, группы, панель контекста */
interface FrameState {
  groups: PatientGroupWithCounts[];
  groupsError: string | null;
  reloadGroups: () => void;
  activeId: string | null;
  q: string;
  page: number;
  per: number;
  update: (patch: Record<string, string | null>) => void;
}

export function PatientList() {
  const [params, setParams] = useSearchParams();
  const groupId = params.get("group");
  const q = params.get("q") ?? "";
  const page = pageFrom(params.get("page"));
  const per = perFrom(params.get("per"));

  /* всё состояние — в адресе: «посмотри вечернюю группу» пересылают ссылкой */
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

  /*
   * Отказ по группам не прячет список: вкладки — способ посмотреть на своих
   * людей под другим углом, и без них экран остаётся списком «Усі».
   */
  const groups = useResource(() => api.patientGroups(), []);
  const list = groups.data ?? [];
  /* чужая или удалённая группа в адресе — это «Усі», а не пустой экран */
  const current = groupId && groups.data ? (list.find((g) => g.id === groupId) ?? null) : null;
  /*
   * Группа в адресе, а список групп ещё не приехал: ждём его, не рисуя
   * «Усі». Иначе по ссылке на группу экран сперва мигал бы чужой вкладкой
   * с её подписью и запрашивал бы список обследованных, который тут же
   * выбросит.
   */
  const pending = groupId !== null && !groups.data && !groups.error;

  const frame: FrameState = {
    groups: list,
    groupsError: groups.error,
    reloadGroups: groups.reload,
    /* пока ждём — активна не «Усі», а группа из адреса, хоть её вкладки ещё нет */
    activeId: current?.id ?? (pending ? groupId : null),
    q,
    page,
    per,
    update,
  };

  if (pending) {
    return (
      <Frame frame={frame} pages={1} focused={null}>
        <Loading rows={6} />
      </Frame>
    );
  }
  /* ключ — чтобы выбор и страницы не переезжали с одной группы на другую */
  return current ? <GroupPatients key={current.id} group={current} frame={frame} /> : <AllPatients key="all" frame={frame} />;
}

/* ─────────── рамка: строка над списком, вкладки, панель контекста ─────────── */

function Frame({
  frame,
  pages,
  focused,
  children,
}: {
  frame: FrameState;
  pages: number;
  focused: PersonLike | null;
  children: ReactNode;
}) {
  const { ut } = useLang();
  const { groups, groupsError, activeId, q, page, per, update } = frame;
  /*
   * Что открыто из шестерёнки. Оба — состояние экрана, а не адреса: строка
   * сохранённых видов и панель контекста ничего не меняют в том, ЧТО
   * показано, и ссылка на список с открытой панелью сбивала бы с толку
   * того, кому её прислали.
   */
  const [views, setViews] = useState(false);
  const [panel, setPanel] = useState(false);

  /*
   * Вкладки — кнопочный вид Tabs, а не ссылки. Вкладка живёт в параметре
   * адреса (?group=), а NavLink сравнивает только путь и параметров не
   * видит: ссылочные вкладки подсвечивались бы все разом. Сегмент пути
   * (/patients/group/:id) спорил бы с картой /patients/:userId. Кнопочный
   * вид даёт role="tablist" и aria-selected — и это точнее по смыслу:
   * вкладка переключает содержимое под собой, а не уводит на другой экран.
   */
  const tabs = groups.map((g) => ({
    label: g.title,
    active: g.id === activeId,
    onSelect: () => update({ group: g.id, page: null }),
    id: `pg-tab-${g.id}`,
    controls: "patients-panel",
  }));
  /*
   * Когда фильтр снят, выбранной вкладки нет вовсе: «Усі» на кадре не
   * нарисована, а подписывать панель вкладкой, которой нет, нельзя — idref
   * в пустоту диктор читает как ошибку разметки. Тогда панель называет
   * себя сама, именем экрана.
   */
  const activeTab = tabs.find((t) => t.active)?.id;

  return (
    <Page
      title={ut("patients.title")}
      /* блок страниц отодвинут от «+» на 74, как на кадре: см. wideActions */
      wideActions
      toolbar={
        /* зазор «поле → +» 14: на f05 поле кончается на 1022, «+» стоит 1036…1062 (13);
           f06 даёт 21 — тот же разнобой макета, что и с блоком страниц, см. wideActions */
        <div className="flex min-w-0 flex-1 items-center gap-[14px]">
          <div className="relative min-w-0 flex-1">
            {/* имя полю даёт aria-label: на макете поле пустое, без подписи внутри */}
            <Input
              look="outline"
              aria-label={ut("ui.search")}
              value={q}
              onChange={(e) => update({ q: e.target.value, page: null })}
              className="pr-[44px]"
              autoComplete="off"
              /* предел сервера (respondentQuery, search ≤ 120) */
              maxLength={120}
            />
            <span aria-hidden className="pointer-events-none absolute right-[12px] top-1/2 -translate-y-1/2 text-text-2 [&>svg]:size-[22px]">
              <IconSearchGlass />
            </span>
          </div>
          {/*
            «+» ведёт на приглашения: пациент попадает в систему по ссылке-
            приглашению, а не формой «завести». Ссылка, а не кнопка с
            переходом: диктор обязан слышать «ссылка», а средняя кнопка мыши —
            открывать её в новой вкладке. Классы — те же, что у Button
            size="glyph": видимые 27, нажимаемые 44.
          */}
          <Link
            to="/invites"
            aria-label={ut("pg.invite")}
            className={cx(
              "relative inline-grid size-[27px] shrink-0 place-items-center rounded-[5px] text-primary no-underline",
              "after:absolute after:left-1/2 after:top-1/2 after:size-[44px] after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
              "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2",
            )}
          >
            <IconPlusThick />
          </Link>
        </div>
      }
      actions={
        <>
          <Pager
            page={page}
            pages={pages}
            per={per}
            onPer={(n) => update({ per: n === DEFAULT_PER ? null : String(n), page: null })}
            onPage={(n) => update({ page: n > 1 ? String(n) : null })}
          />
          {/*
            Шестерёнка кадра: глиф 1370…1399 у правого края колонки, правее
            блока страниц. В ней — всё, чего на кадре нет на виду: список без
            фильтра, сохранённые виды, панель «А це хто?». Тот же ActionMenu,
            что у карточки пациента и у заключения, — меню в консоли одно.
          */}
          <ActionMenu
            label={ut("pt.listActions")}
            glyph={<IconGear />}
            entries={[
              {
                label: ut("pg.allTab"),
                onSelect: () => update({ group: null, page: null }),
                /* фильтр уже снят — пункт остаётся на месте, но вести ему некуда */
                disabled: activeId === null,
              },
              { label: ut("views.show"), onSelect: () => setViews((v) => !v) },
              { label: ut("pt.whoIsThis"), onSelect: () => setPanel((v) => !v) },
            ]}
          />
        </>
      }
      contextTitle={ut("pt.whoIsThis")}
      /*
        Панель — только когда её позвали: на кадре справа от колонки 1200
        чисто. Подпись под заголовком («Ті, хто проходив методики ваших
        груп») печатается здесь же: на кадре её нет, а сказать, что список
        показывает обследованных, а не всех заведённых, надо там, где об
        этом спрашивают.
      */
      context={
        panel ? (
          focused ? (
            <PatientContext person={focused} />
          ) : (
            <>
              <p className="m-0 text-caption text-muted">{ut("pt.pickRow")}</p>
              <p className="m-0 mt-[8px] text-caption text-muted">{ut("patients.sub")}</p>
            </>
          )
        ) : undefined
      }
    >
      {/* первый ребёнок — <nav>/<div role=tablist>: Page даёт ему 39px от строки, как на макете */}
      <Tabs label={ut("pg.tabsLabel")} items={tabs} />
      {groupsError ? <p className="m-0 mt-[12px] text-[13px] text-danger">{groupsError}</p> : null}
      {/*
        Сохранённые виды — не в потоке, а по вызову из шестерёнки: на кадре
        между полосой прокрутки вкладок и первой строкой сетки чистое поле.
        Убрать их совсем было бы дороже — виды хранятся на сервере
        (saved_views, scope «patients»), и уже сохранённые стали бы
        недостижимы при живом адресном состоянии.
      */}
      {views ? (
        <div className="mt-[16px]">
          <SavedViews scope="patients" />
        </div>
      ) : null}
      {/*
        24, а не 20: на кадре от низа полосы прокрутки (261) до верха литер
        первого имени (299) — 38, из которых 11 съедает воздух строки сетки
        (58 при содержимом 36) и ещё 3 — полусвинец строки имени.
      */}
      <div
        id="patients-panel"
        role="tabpanel"
        aria-labelledby={activeTab}
        aria-label={activeTab ? undefined : ut("patients.title")}
        className={views ? "mt-[20px]" : "mt-[24px]"}
      >
        {children}
      </div>
    </Page>
  );
}

/* ─────────── действия над выборкой ─────────── */

/**
 * «Призначити тест» выбранным — поимённо, через тот же маршрут, что и ручная
 * выдача с экрана доступа. Групповой маршрут здесь не годится: выборка —
 * это не группа, а несколько человек, отмеченных прямо сейчас.
 */
function useSelectionActions(chosen: ReadonlySet<string>, frame: FrameState) {
  const { ut } = useLang();
  const toast = useToast();
  const [dialog, setDialog] = useState<"group" | "assign" | null>(null);

  const addToGroup = async (groupId: string) => {
    /* по одному запросу на человека; повтор сервер читает как «уже там» */
    for (const userId of chosen) await api.addPatientGroupMember(groupId, userId);
    frame.reloadGroups();
  };

  const assign = async (surveyId: string, expiresAt: string | null) => {
    let done = 0;
    for (const userId of chosen) {
      await api.grant(surveyId, userId, undefined, expiresAt);
      done += 1;
    }
    return `${ut("pg.assigned")} — ${done}`;
  };

  const dialogs = (
    <>
      {dialog === "group" ? (
        <PickGroupDialog
          groups={frame.groups}
          count={chosen.size}
          onPick={async (groupId) => {
            await addToGroup(groupId);
            setDialog(null);
            toast(ut("pg.added"), "ok");
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "assign" ? (
        <AssignSurveyDialog title={ut("pg.assignTest")} onAssign={assign} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );

  return { dialogs, open: setDialog };
}

/* ─────────── вкладка «Усі» ─────────── */

function AllPatients({ frame }: { frame: FrameState }) {
  const { ut } = useLang();
  const { q, page, per, update } = frame;

  const list = usePagedResource<Respondent>(
    (cursor) => api.respondents({ search: q || undefined, cursor: cursor ?? undefined, limit: String(per) }),
    [q, per],
    { debounceMs: 300 },
  );
  const loaded = list.items ?? [];
  const need = page * per;

  /* страница просит недостающую порцию сама — одна порция за раз, пока сервер обещает ещё */
  useEffect(() => {
    if (list.items && loaded.length < need && list.hasMore && !list.loadingMore) list.loadMore();
  }, [list.items, loaded.length, need, list.hasMore, list.loadingMore, list.loadMore]);

  const pages = pagesOf(loaded.length, list.total, list.hasMore, per);
  const rows = slicePage(loaded, page, per);

  useEffect(() => {
    if (list.items && !list.hasMore && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [list.items, list.hasMore, page, pages, update]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const chosen = useMemo(() => keepPresent(selected, loaded), [selected, loaded]);
  const [focused, setFocused] = useState<PersonLike | null>(null);
  const actions = useSelectionActions(chosen, frame);

  return (
    <Frame frame={frame} pages={pages} focused={focused}>
      {list.error ? (
        <Loading error={list.error} onRetry={list.reload} />
      ) : !list.items || (rows.length === 0 && list.loadingMore) ? (
        <Loading rows={6} />
      ) : rows.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">{ut("pt.nobodyFound")}</p>
      ) : (
        <PersonGrid
          people={rows}
          selected={chosen}
          onToggle={(id) => setSelected((prev) => toggleIn(prev, id))}
          onFocus={setFocused}
          focusedId={focused?.userId ?? null}
        />
      )}
      <SelectionBar
        count={chosen.size}
        entries={[
          { label: ut("pg.addToGroup"), onSelect: () => actions.open("group") },
          { label: ut("pg.assignTest"), onSelect: () => actions.open("assign") },
          { label: ut("pg.clearSelection"), onSelect: () => setSelected(new Set()) },
        ]}
      />
      {actions.dialogs}
    </Frame>
  );
}

/* ─────────── вкладка группы ─────────── */

function GroupPatients({ group, frame }: { group: PatientGroupWithCounts; frame: FrameState }) {
  const { ut } = useLang();
  const { run } = useAction();
  const { q, page, per, update } = frame;

  const card = useResource(() => api.patientGroup(group.id), [group.id]);
  const members = useMemo(
    () => (card.data?.members ?? []).filter((m) => matchesQuery(q, m.fullName, m.email)),
    [card.data, q],
  );
  const pages = pageCount(members.length, per);
  const rows = slicePage(members, page, per);

  useEffect(() => {
    if (card.data && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [card.data, page, pages, update]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const chosen = useMemo(() => keepPresent(selected, card.data?.members ?? []), [selected, card.data]);
  const [focused, setFocused] = useState<PersonLike | null>(null);
  const actions = useSelectionActions(chosen, frame);

  const removeChosen = async () => {
    const ok = await run(async () => {
      for (const userId of chosen) await api.removePatientGroupMember(group.id, userId);
    }, ut("pg.removed"));
    setSelected(new Set());
    if (ok) {
      card.reload();
      frame.reloadGroups();
    }
  };

  return (
    <Frame frame={frame} pages={pages} focused={focused}>
      {card.error ? (
        <Loading error={card.error} onRetry={card.reload} />
      ) : !card.data ? (
        <Loading rows={6} />
      ) : rows.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">{q.trim() ? ut("pt.nobodyFound") : ut("pg.noMembers")}</p>
      ) : (
        <PersonGrid
          people={rows}
          selected={chosen}
          onToggle={(id) => setSelected((prev) => toggleIn(prev, id))}
          onFocus={setFocused}
          focusedId={focused?.userId ?? null}
        />
      )}
      <SelectionBar
        count={chosen.size}
        entries={[
          { label: ut("pg.addToGroup"), onSelect: () => actions.open("group") },
          { label: ut("pg.assignTest"), onSelect: () => actions.open("assign") },
          { label: ut("pg.removeFromGroup"), onSelect: () => void removeChosen() },
          { label: ut("pg.clearSelection"), onSelect: () => setSelected(new Set()) },
        ]}
      />
      {actions.dialogs}
    </Frame>
  );
}

/**
 * Вкладка «Динамика» карты пациента: как менялось.
 *
 * Была отдельным экраном со своим заголовком и кнопкой перехода на сводку.
 * Имя, подразделение и действия переехали в шапку карты — здесь остались
 * только графики, ради которых на неё и заходят.
 */
export function PatientDynamics() {
  const { ut } = useLang();
  const [equating, setEquating] = useState(false);
  const { userId } = useParams<{ userId: string }>();
  const { run } = useAction();
  const { data, error } = useResource(() => api.dynamics(userId!), [userId], { enabled: !!userId });

  if (error) return <p className="error">{error}</p>;
  if (!data) return <Loading rows={5} />;

  return (
    <>
      {data.surveys.length === 0 ? <p className="text-muted">{ut("pt.noCompleted")}</p> : null}

      {data.surveys.map((sv) => (
        <div key={sv.surveyId}>
          <div className="card">
            <h2>{sv.title}</h2>
            <p className="hint">
              {sv.responseCount} {ut("sum.measurements")} · {ut("ec.since")}{" "}
              {sv.firstAt ? day(sv.firstAt) : "—"} {ut("sch.to")}{" "}
              {sv.lastAt ? day(sv.lastAt) : "—"}
            </p>
          </div>

          {sv.scales.length >= 3 ? (
            <Chart title={ut("pt.profileBySubscales")} hint={ut("pt.lastVsFirst")}>
              <Radar
                axes={sv.scales.map((sc) => {
                  const p = sc.points.at(-1);
                  return { label: sc.title, value: p && p.maxScore > 0 ? p.rawScore / p.maxScore : 0 };
                })}
                compare={
                  sv.scales.some((sc) => sc.points.length > 1)
                    ? sv.scales.map((sc) => {
                        const p = sc.points[0];
                        return { label: sc.title, value: p && p.maxScore > 0 ? p.rawScore / p.maxScore : 0 };
                      })
                    : undefined
                }
              />
            </Chart>
          ) : null}

          <Hint id="stens" text="hint.stens" />

          {/*
            Сведение версий предлагается только там, где версии действительно
            разные, и никогда не включается само: оно опирается на допущение о
            сопоставимости выборок, а знает о нём человек, а не программа.
          */}
          {sv.scales.some((sc) => sc.equated?.length) ? (
            <div className="card">
              <label className="row tight">
                <input
                  type="checkbox"
                  checked={equating}
                  onChange={(e) => setEquating(e.target.checked)}
                />
                <strong>{ut("eq.title")}</strong>
              </label>
              <p className="hint" style={{ marginBottom: 0 }}>{ut("eq.hint")}</p>
            </div>
          ) : null}
          <div className="grid cols-2">
            {sv.scales.map((sc) => {
              const last = sc.points.at(-1);
              return (
                <Chart
                  key={sc.scaleId}
                  title={sc.title}
                  hint={rciHint(sc, ut)}
                >
                  <LineChart
                    /*
                     * Отметки смены версии методики. Скачок сразу после
                     * правки ключей — артефакт, а не динамика, и прочесть
                     * его как улучшение стоит дороже, чем лишний пунктир.
                     */
                    marks={versionMarks(sc.points)}
                    /*
                     * Полная шкала уходит в подпись, а не в ось. Ось,
                     * растянутая до максимума методики, прижимала все замеры к
                     * низу поля: на демонстрационной базе данные занимали
                     * пятую часть высоты, и динамика любой шкалы у любого
                     * человека выглядела одинаково — плоской чертой внизу.
                     */
                    fullRange={last?.maxScore}
                    series={[{
                      label: sc.title,
                      points: sc.points.map((p) => ({
                        x: day(p.submittedAt),
                        y: equating ? equatedValue(p, sc.equated) : p.rawScore,
                        tone: p.severity ? severityColor[p.severity] : undefined,
                        /*
                         * Полоса ошибки измерения. Без неё 62 и 65 выглядят
                         * как разные числа, хотя при SEM = 4 это одно и то же
                         * измерение. Если SEM посчитать не из чего, полоса не
                         * рисуется: придуманный интервал выглядит как знание.
                         */
                        err: sc.sem ?? null,
                      })),
                    }]}
                  />
                  {last ? (
                    <table style={{ marginTop: 10 }}>
                      <tbody>
                        <tr><td>{ut("pt.lastMeasure")}</td><td className="num">{last.rawScore} {ut("an.of")} {last.maxScore}</td></tr>
                        {last.severity ? <tr><td>{ut("pt.interpretation")}</td><td className="num"><SeverityTag severity={last.severity} label={last.bandLabel ?? undefined} /></td></tr> : null}
                        {sc.reliableChange ? (
                          <tr>
                            <td>{ut("pt.rciTitle")}</td>
                            <td className="num">
                              {sc.reliableChange.significant ? (
                                <strong style={{ color: "var(--accent)" }}>
                                  {ut("pt.reliable")} ({sc.reliableChange.direction === "up" ? ut("pt.growth") : ut("pt.decline")}, RCI {sc.reliableChange.rci})
                                </strong>
                              ) : (
                                <span className="muted">{ut("sum.withinError")} (RCI {sc.reliableChange.rci})</span>
                              )}
                            </td>
                          </tr>
                        ) : null}
                        <tr>
                          <td>{ut("pt.percentile")}</td>
                          <td className="num">
                            {last.percentile === null ? <span className="muted">{ut("mark.smallSample")}</span> : `${ut("pt.higherThanPct")} ${last.percentile}%`}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  ) : null}
                  {last ? (
                    <button style={{ marginTop: 10 }} onClick={() => run(() => openInTab(api.reportUrl(last.responseId)))}>
                      {ut("an.conclusion")}
                    </button>
                  ) : null}
                </Chart>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * Подпись под графиком: сырая дельта плюс вердикт достоверности.
 *
 * Дельта без RCI вводит в заблуждение: сдвиг на 13 T-баллов при широком
 * разбросе выборки — шум, а на 0.23 доли при α=0.92 — реальное изменение.
 */
/**
 * Балл, приведённый к версии последнего замера.
 *
 * Если для версии этой точки коэффициентов нет — балл остаётся своим. Это
 * лучше, чем прятать точку: пропуск в ряду читается как «замера не было», а
 * замер был, просто свести его не из чего.
 */
function equatedValue(
  point: { rawScore: number; versionNo?: number | null },
  rules: { fromVersion: number; slope: number; intercept: number }[] | null | undefined,
): number {
  const rule = rules?.find((r) => r.fromVersion === point.versionNo);
  if (!rule) return point.rawScore;
  return Math.round((rule.slope * point.rawScore + rule.intercept) * 100) / 100;
}

function rciHint(
  sc: {
    delta: number | null;
    reliableChange: { rci: number; significant: boolean; basis: { sd: number; alpha: number; sampleN: number } } | null;
  },
  // переводчик аргументом: функция чистая и живёт вне компонента
  ut: (k: UiKey) => string,
): string {
  if (sc.delta === null) return ut("pt.needSecond");
  const base = `${ut("pt.change")}: ${sc.delta > 0 ? "+" : ""}${sc.delta}`;
  const rc = sc.reliableChange;
  if (!rc) return `${base} · ${ut("pt.rciUnknown")}`;
  const verdict = rc.significant ? ut("pt.rciAbove") : ut("pt.rciWithin");
  return `${base} · ${verdict} (RCI ${rc.rci}, ${ut("pt.alpha")} ${rc.basis.alpha})`;
}
