import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { Issue, SurveyFolder, SurveyFolderWithCounts, SurveyGroupWithCounts, SurveyListItem } from "@quizzy/shared";
import { api } from "../../api";
import { useResource } from "../../useResource";
import { ConfirmByName, IconChevron, IconSearchGlass, Loading, useAction, useToast } from "../../ui";
import { IconCaret, IconCaution, IconCross, IconDots, IconPlusThick } from "../../ui/glyphs";
import { MenuButton, menuItem, menuItemClass } from "../../ui/menu";
import { Pager } from "../../ui/pager";
import { Page, Panel } from "../../ui/layout";
import { Input, Tabs } from "../../ui/primitives";
import { cx } from "../../ui/cx";
import { useLang } from "../../lang";
import { FolderForm, MoveForm } from "./CatalogueDialogs";
import {
  DEFAULT_PER,
  catalogueHref,
  folderChildren,
  folderPath,
  listQuery,
  numericDate,
  pageCount,
  pageFrom,
  perFrom,
  retiredPage,
  tabFromPath,
  type CatalogueTab,
} from "./catalogue";

/*
 * Каталог тестов — кадр f11 макета.
 *
 * Что на кадре и как это легло на код:
 *
 *   вкладки «Опубліковані / Неопубліковані тести»  → сегмент адреса, Tabs
 *   «елементів на сторінці · сторінка 1 з 10 ‹ ›»  → ?per и ?page, Pager
 *   поле поиска с лупой и «+»                       → ?q, меню «+»
 *   крошки «Мої тести › Тести за 2023 › … ▾»        → ?folder, плоский список
 *                                                      папок с сервера
 *   строка «Папки» с датами                         → дети текущей папки
 *   список: название | Результат тесту | Статистика → таблица без видимой
 *                                                      шапки
 *
 * Чего на кадре нет — и куда оно убрано с глаз (функция при этом жива):
 *
 * 1. Третья вкладка «Зняті з використання». На кадре вкладок ровно две, и
 *    третья ушла пунктом в меню «+» — туда же, где «Новий тест», «Нова
 *    папка» и «Імпорт з файлу». Маршрут /surveys/retired и tabFromPath
 *    остались: пункт ведёт на прежний адрес, и пересланная ссылка на снятые
 *    работает как работала.
 * 2. Метки «демо · права незрозумілі · знято» под названием теста. На кадре
 *    под названием пусто; метки ушли в меню «⋯» строки — первой строкой,
 *    как заголовок меню, — и в title ссылки, чтобы их было видно наведением
 *    без открытия меню.
 * 3. Глиф «⋯» в конце строки. Действия строки (правка, ключи, доступ, копия,
 *    перенос, снятие) на макете не нарисованы, а в системе живут: ключи и
 *    доступ — единственное место, где решают, выдавать ли методику. Глиф
 *    выведен из потока колонок (absolute у правого края строки) и проявлен
 *    только на наведении и на фокусе: колонка «Статистика» идёт до правого
 *    края содержимого, как на кадре, а клавиатура глиф не теряет.
 * 4. Импорт из файла — пункт меню «+»: макет читает «+» как «новый тест или
 *    новая папка», а импорт — тот же новый тест, только из файла.
 *
 * Чего здесь НЕТ и не будет: «Результат тесту» абзацем в каждой строке.
 * Результат в системе — полосы интерпретации, нормы и стены на самой методике
 * (/surveys/:id); в строке каталога печатается её описание, а под
 * «Статистика» — числа, по которым реально выбирают: сколько вопросов,
 * сколько прохождений, сверены ли ключи.
 */

/* ─────────── глифы ─────────── */

/**
 * Папка — своя: в общем наборе ui/index.tsx её нет, а «+», каретка и «⋯»
 * с кадра живут в ui/glyphs.tsx — один набор на каталог, заключение и
 * аналитику.
 */
function IconFolder() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

/* ─────────── крошки и папки ─────────── */

/* кадр f11: cap «М» крошки 12 px → 17/700, шаг строки 22 */
const crumbClass = "text-[17px] font-bold leading-[22px] text-primary no-underline hover:underline";

/**
 * «Мої тести › Тести за 2023 › Тести за лютий 2023 ▾».
 *
 * Каретка у последней крошки открывает соседние папки того же уровня — на
 * макете это «перейти к другим папкам этого уровня» — и, заодно, правку и
 * удаление текущей папки: другого места у папки на экране нет, а заводить
 * ради двух действий ещё один глиф значило бы добавить на кадр то, чего там
 * нет. В корне каретки нет: у корня нет соседей и его не переименовать.
 */
function Crumbs({
  tab,
  per,
  path,
  siblings,
  onRename,
  onDelete,
}: {
  tab: CatalogueTab;
  per: number;
  path: SurveyFolder[];
  siblings: SurveyFolder[];
  onRename: (f: SurveyFolder) => void;
  onDelete: (f: SurveyFolder) => void;
}) {
  const { ut } = useLang();
  const current = path.at(-1) ?? null;
  return (
    <nav
      aria-label={ut("cat.crumbsLabel")}
      className="mt-[40px] flex flex-wrap items-center gap-x-[12px] gap-y-[6px] border-b border-hairline pb-[24px]"
    >
      {current ? (
        <Link to={catalogueHref(tab, { per })} className={crumbClass}>
          {ut("cat.root")}
        </Link>
      ) : (
        <span className={crumbClass} aria-current="page">
          {ut("cat.root")}
        </span>
      )}
      {path.map((f, i) => (
        <Fragment key={f.id}>
          <span aria-hidden className="text-primary [&>svg]:size-[12px]">
            <IconChevron />
          </span>
          {i === path.length - 1 ? (
            <span className={crumbClass} aria-current="page">
              {f.title}
            </span>
          ) : (
            <Link to={catalogueHref(tab, { folder: f.id, per })} className={crumbClass}>
              {f.title}
            </Link>
          )}
        </Fragment>
      ))}
      {current ? (
        <MenuButton label={ut("cat.folderMenu")} glyph={<IconCaret />} className="-ml-[4px]">
          {(close) => (
            <>
              {siblings.map((f) => (
                <Link
                  key={f.id}
                  role="menuitem"
                  to={catalogueHref(tab, { folder: f.id, per })}
                  className={menuItem}
                  onClick={close}
                >
                  {f.title}
                </Link>
              ))}
              {siblings.length ? <hr className="my-1 border-0 border-t border-hairline" /> : null}
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  close();
                  onRename(current);
                }}
              >
                {ut("cat.renameFolder")}
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItemClass("left", "danger")}
                onClick={() => {
                  close();
                  onDelete(current);
                }}
              >
                {ut("cat.deleteFolder")}
              </button>
            </>
          )}
        </MenuButton>
      ) : null}
    </nav>
  );
}

/**
 * Строка «Папки»: название полужирным фиолетовым, дата тёмным обычным —
 * ровно как на макете. Строки нет вовсе, когда папок на уровне нет: пустая
 * полка с подписью «Папки» была бы вопросом без ответа.
 *
 * Папки стоят по колонкам списка под ними, а не в ряд через зазор: на
 * кадре «Папки» занимает первую колонку (ту же ширину 172, что и название
 * теста), первая папка начинается там же, где «Результат тесту», вторая —
 * где «Статистика». Третья и дальше идут следующим рядом в те же две
 * колонки — кадр с тремя папками не нарисован, и это единственное
 * продолжение, при котором колонки не разъезжаются.
 *
 * В корне папки разных групп стоят вперемешку — так и должно быть, корень
 * «Мої тести» общий. Чтобы «Тести за 2023» двух отделений не слились, при
 * нескольких группах под названием печатается имя группы.
 */
function FolderRow({
  tab,
  per,
  folders,
  groupNames,
}: {
  tab: CatalogueTab;
  per: number;
  folders: SurveyFolderWithCounts[];
  /** Имена групп для подписи; null — группа одна, подписывать нечего */
  groupNames: Map<string, string> | null;
}) {
  const { ut } = useLang();
  if (!folders.length) return null;
  return (
    /* колонки те же, что у списка: 169 · 534 · 496 — замер кадра f11 */
    <div className="flex items-start border-b border-hairline py-[24px] text-[17px] leading-[22px]">
      <div className="flex w-[169px] shrink-0 items-center gap-[12px] pr-[24px] font-bold text-primary">
        <span aria-hidden className="[&>svg]:size-[30px]">
          <IconFolder />
        </span>
        {ut("cat.folders")}
      </div>
      <ul className="m-0 grid min-w-0 flex-1 list-none grid-cols-[534px_minmax(0,1fr)] gap-y-[10px] p-0">
        {folders.map((f) => (
          <li key={f.id} className="flex min-w-0 flex-col">
            <span className="flex items-baseline gap-[14px]">
              <Link to={catalogueHref(tab, { folder: f.id, per })} className="font-bold text-primary no-underline hover:underline">
                {f.title}
              </Link>
              <span className="text-text-2">{numericDate(f.startsOn)}</span>
            </span>
            {groupNames ? <span className="text-[10px] leading-[12px] text-muted">{groupNames.get(f.groupId) ?? ""}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─────────── строки списка ─────────── */

/*
 * Кадр f11: cap «Р» подписи колонки 9 px → 13/700, тело абзаца 13/400. Шаг
 * строк 14 у обеих — подпись и абзац идут одной лесенкой, замер по строкам
 * второй колонки: 432 → 446 → 460 → 474.
 *
 * Цвет подписи на кадре — #666666, то есть тот же серый, что у даты папки и
 * у тела абзаца; --text-2 (#333333) стоял здесь на ступень темнее
 * назначенного макетом и без основания (про --muted вместо #666666 см.
 * tokens.css: там отступление объяснено контрастом).
 */
const cellLabel = "text-[13px] font-bold leading-[14px] text-muted";
const cellText = "m-0 text-[13px] leading-[14px] text-muted";
/*
 * Ячейка переопределяет правила наследия для td: там высота строки задана
 * токеном плотности, отступы 0 12, линия снизу. На макете строка высотой
 * по содержимому, без линий между строками и без левого отступа у названия.
 */
/*
 * Шаг строк кадра — 82: верх подписи первой строки 432, второй 514. Высоту
 * задаёт вторая колонка: подпись и три строки абзаца по 14 = 56, и на отступы
 * сверху и снизу остаётся по 13.
 */
const cell = "h-auto border-0 py-[13px] pl-0 align-top";

/**
 * Действия строки за глифом «⋯» — см. пункты 2 и 3 в заголовке файла.
 *
 * Первой строкой меню — метки теста («демо», «права незрозумілі», «знято»),
 * которые на кадре под названием не напечатаны. Это подпись, а не пункт:
 * нажимать в ней нечего, и role="menuitem" на ней был бы обещанием действия.
 */
function RowMenu({
  survey,
  marks,
  onDuplicate,
  onMove,
  onArchive,
  onRestore,
}: {
  survey: SurveyListItem;
  /** Метки теста строкой — то, что ушло с глаз из-под названия */
  marks: string[];
  onDuplicate: (s: SurveyListItem) => void;
  onMove: (s: SurveyListItem) => void;
  onArchive: (s: SurveyListItem) => void;
  onRestore: (s: SurveyListItem) => void;
}) {
  const { ut } = useLang();
  const act = (close: () => void, fn: (s: SurveyListItem) => void) => () => {
    close();
    fn(survey);
  };
  return (
    <MenuButton label={ut("cat.rowActions")} glyph={<IconDots />}>
      {(close) => (
        <>
          {marks.length ? (
            <>
              <p className="m-0 px-[16px] py-[6px] text-[13px] text-muted">
                <span className="sr-only">{ut("cat.marks")}: </span>
                {marks.join(" · ")}
              </p>
              <hr className="my-1 border-0 border-t border-hairline" />
            </>
          ) : null}
          <Link role="menuitem" to={`/constructor/${survey.id}`} className={menuItem} onClick={close}>
            {ut("cl.editAction")}
          </Link>
          <Link role="menuitem" to={`/surveys/${survey.id}/key`} className={menuItem} onClick={close}>
            {ut("cl.keysAction")}
          </Link>
          <Link role="menuitem" to={`/surveys/${survey.id}/access`} className={menuItem} onClick={close}>
            {ut("cl.accessAction")}
          </Link>
          <button type="button" role="menuitem" className={menuItem} onClick={act(close, onDuplicate)}>
            {ut("cl.duplicateAction")}
          </button>
          <button type="button" role="menuitem" className={menuItem} onClick={act(close, onMove)}>
            {ut("cat.move")}
          </button>
          <hr className="my-1 border-0 border-t border-hairline" />
          {survey.archivedAt ? (
            <button type="button" role="menuitem" className={menuItem} onClick={act(close, onRestore)}>
              {ut("cl.restoreAction")}
            </button>
          ) : (
            <button type="button" role="menuitem" className={menuItemClass("left", "danger")} onClick={act(close, onArchive)}>
              {ut("cl.archiveButton")}
            </button>
          )}
        </>
      )}
    </MenuButton>
  );
}

function Row({
  survey,
  marks,
  menu,
}: {
  survey: SurveyListItem;
  /** Метки теста: на экране их нет, они живут в title ссылки и в меню «⋯» */
  marks: string[];
  menu: ReactNode;
}) {
  const { ut } = useLang();
  const s = survey;
  /*
   * Ключи упоминаются только там, где есть что сверять: у методики без
   * подсчёта баллов ключа нет, и «ключі не звірено» читалось бы как долг.
   */
  const keys = !s.scoringEnabled
    ? ut("cat.scoringOff")
    : s.keysVerifiedAt
      ? `${ut("cat.keysVerified")} ${numericDate(s.keysVerifiedAt)}`
      : ut("cat.keysUnverified");
  const stats = [`${ut("cl.questions")} ${s.questionCount}`, `${ut("cl.responses")} ${s.responseCount}`, keys].join(" · ");

  return (
    /*
     * Наведение заливает строку целиком — кадр f11, третья строка: #f7f5fa на
     * всю колонку содержимого. Это 5 % фиолетового на листе; --primary-soft
     * (10 %) дал бы заметно темнее. `relative` держит «⋯»: см. ниже.
     */
    <tr className="group hover:bg-[color-mix(in_srgb,var(--primary)_5%,transparent)]">
      <td className={cx(cell, "pr-[24px]")}>
        {/* метки ушли в title и в меню «⋯»: на кадре под названием пусто */}
        <Link
          to={`/surveys/${s.id}`}
          title={marks.length ? marks.join(" · ") : undefined}
          /*
           * Межстрочник имени — 20, а не 22. Замер кадра f11, столбец имени:
           * базовые линии двух строк «Назва тесту / можливо велика» стоят на
           * 52 и 72 от верха вырезки — ровно 20. 22 брались от заголовков
           * экрана и в двухстрочном имени расталкивали строки заметно.
           */
          className="text-[17px] font-bold leading-[20px] text-primary no-underline hover:underline"
        >
          {s.title}
        </Link>
      </td>
      <td className={cx(cell, "pr-[36px]")}>
        <div className={cellLabel}>{ut("cat.resultCol")}</div>
        <p className={cellText}>{s.description ? s.description : <span className="text-faint">{ut("cat.noDescription")}</span>}</p>
      </td>
      {/*
        На устройстве без наведения «⋯» виден всегда, и «Статистика» не должна
        уходить под него: правый отступ колонки там 44 (размер цели нажатия),
        а на кадре — 12, как нарисовано.
      */}
      <td className={cx(cell, "relative pr-[12px] [@media(hover:none)]:pr-[44px]")}>
        <div className={cellLabel}>{ut("cat.statsCol")}</div>
        <p className={cellText}>{stats}</p>
        {/*
          «⋯» вынесен из потока: на кадре четвёртой колонки нет, и «Статистика»
          идёт до правого края содержимого. Глиф всегда в разметке — не
          `hidden` и не `display:none`, иначе он выпал бы из порядка обхода
          клавиатурой вместе с меню.

          Прятать его насовсем нельзя было и раньше, но пряталось: `opacity-0`
          стоял безусловно, а возвращали глиф только `group-hover` и
          `group-focus-within`. На планшете и телефоне наведения нет, фокус
          мышью тоже не приходит — и действия строки становились недостижимы
          с пальца вовсе. Поэтому невидимость убрана внутрь
          `@media (hover: hover)`: где наведение есть — вид кадра сохранён
          (глиф проявляется наведением и фокусом), где его нет — глиф просто
          нарисован.

          Все три класса стоят ПОД одним медиазапросом намеренно. Оставь
          `group-hover:opacity-100` снаружи — и порядок в собранном CSS решал
          бы спор двух правил равной специфичности: у Tailwind медиа-варианты
          идут после псевдоклассовых, и безусловная невидимость перебила бы
          проявление наведением.
        */}
        <span
          className={cx(
            "absolute right-0 top-[10px] transition-opacity duration-[var(--dur-fast)]",
            "[@media(hover:hover)]:opacity-0",
            "[@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100",
          )}
        >
          {menu}
        </span>
      </td>
    </tr>
  );
}

/* ─────────── экран ─────────── */

type Dialog = { kind: "folder"; folder: SurveyFolder | null } | { kind: "move"; survey: SurveyListItem };

export function SurveyList() {
  const { ut } = useLang();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { run } = useAction();
  const [params, setParams] = useSearchParams();
  const fileRef = useRef<HTMLInputElement>(null);

  /*
   * Всё состояние экрана — в адресе: вкладка сегментом, папка, поиск,
   * страница и её размер — параметрами. Адрес каталога пересылают коллеге
   * («посмотри неопубликованные за февраль»), и открыться он обязан на том
   * же, что видел отправитель. `replace`, а не push: ввод каждой буквы в
   * поиск не должен становиться шагом в истории браузера.
   */
  const tab = tabFromPath(pathname);
  const folderParam = params.get("folder");
  const q = params.get("q") ?? "";
  const page = pageFrom(params.get("page"));
  const per = perFrom(params.get("per"));

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

  /* поиск ждёт паузу в наборе: сервер не должен получать запрос на каждую букву */
  const [dq, setDq] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDq(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  /*
   * Папки и группы грузятся один раз и живут дольше страницы списка: смена
   * страницы или вкладки их не трогает. Отказ по любому из двух не прячет
   * каталог: без папок он показывает корень, без групп — не даёт завести
   * папку (и говорит почему), а сам список методик приходит своим запросом.
   */
  const shelves = useResource(async () => {
    const [folders, groups] = await Promise.all([
      api.surveyFolders().catch(() => [] as SurveyFolderWithCounts[]),
      api.groups().catch(() => [] as SurveyGroupWithCounts[]),
    ]);
    return { folders, groups };
  }, []);
  const folders = shelves.data?.folders ?? [];
  const groups = shelves.data?.groups ?? [];
  const path = useMemo(() => (folderParam ? folderPath(folders, folderParam) : []), [folders, folderParam]);
  const current = path.at(-1) ?? null;
  const folderId = current?.id ?? null;
  const children = useMemo(() => folderChildren(folders, folderId), [folders, folderId]);
  const siblings = useMemo(
    () => (current ? folderChildren(folders, current.parentId).filter((f) => f.groupId === current.groupId && f.id !== current.id) : []),
    [folders, current],
  );
  const groupNames = useMemo(
    () => (groups.length > 1 ? new Map(groups.map((g) => [g.id, g.title] as const)) : null),
    [groups],
  );

  /*
   * Список ждёт папки: неизвестная папка в адресе превращается в корень,
   * а до загрузки папок неизвестны все — запрос ушёл бы за корнем и тут же
   * повторился за папкой.
   */
  const list = useResource(
    () => api.surveyPage(listQuery({ tab, folder: folderId, q: dq, page, per })),
    [tab, folderId, dq, page, per],
    { enabled: shelves.data !== null },
  );
  const shown = useMemo(
    () => (list.data ? (tab === "retired" ? retiredPage(list.data.items, page, per) : list.data) : null),
    [list.data, tab, page, per],
  );
  const pages = pageCount(shown?.total ?? 0, per);

  /* последняя страница может исчезнуть после снятия или переноса — возвращаемся на ближайшую */
  useEffect(() => {
    if (shown && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [shown, page, pages, update]);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [confirming, setConfirming] = useState<SurveyListItem | null>(null);
  // ошибка импорта — про действие, а не про загрузку списка: состояния разные
  const [error, setError] = useState<string | null>(null);
  const [importIssues, setImportIssues] = useState<Issue[] | null>(null);

  /**
   * Импорт файла экспорта. Ошибочный файл методику не создаёт — сервер
   * возвращает 422 со списком проблем, и он показывается целиком: чинить
   * нужно файл, а не половину методики в базе.
   */
  async function importFile(file: File) {
    setImportIssues(null);
    setError(null);
    let draft: unknown;
    try {
      draft = JSON.parse(await file.text());
    } catch {
      setError(ut("cl.badJson"));
      return;
    }
    try {
      const res = await api.importSurvey(draft);
      if (res.issues.length) setImportIssues(res.issues);
      toast(ut("cl.imported"), "ok");
      navigate(`/constructor/${res.id}`);
    } catch (e) {
      // 422: сервер вернул список структурных проблем — показываем целиком
      const body = (e as { body?: { issues?: Issue[] } }).body;
      if (body?.issues) setImportIssues(body.issues);
      setError(e instanceof Error ? e.message : ut("cl.importFailed"));
    }
  }

  const duplicate = async (s: SurveyListItem) => {
    if (await run(() => api.duplicateSurvey(s.id))) list.reload();
  };
  const restore = async (s: SurveyListItem) => {
    if (await run(() => api.restoreSurvey(s.id), ut("cl.restored"))) {
      list.reload();
      shelves.reload();
    }
  };
  const deleteFolder = async (f: SurveyFolder) => {
    /* пустую папку удалять не страшно, непустую сервер не даст; окно — от случайного нажатия в меню */
    if (!window.confirm(ut("cat.deleteFolderConfirm"))) return;
    if (await run(() => api.deleteSurveyFolder(f.id), ut("cat.folderDeleted"))) {
      shelves.reload();
      navigate(catalogueHref(tab, { folder: f.parentId, per }), { replace: true });
    }
  };

  /*
   * Вкладок ровно две — как на кадре f11. Снятые с использования никуда не
   * делись: вход к ним стоит пунктом в меню «+», адрес /surveys/retired
   * прежний, и tabFromPath его по-прежнему узнаёт (вкладка тогда не
   * подсвечена ни одна — снятых на кадре нет вовсе).
   */
  /*
   * Метки теста одной строкой. На кадре под названием их нет, поэтому здесь
   * они только собираются: строка уходит в title ссылки и первым пунктом в
   * меню «⋯». Дата снятия входит в саму метку — в меню ей место есть.
   */
  const marksOf = (s: SurveyListItem) => {
    const out: string[] = [];
    if (s.isDemo) out.push(ut("mark.demo"));
    if (!s.rightsStatus || s.rightsStatus === "unclear") out.push(`${ut("cl.rightsUnclear")} — ${ut("cl.rightsHint")}`);
    if (s.archivedAt) out.push(`${ut("mark.retired")}: ${ut("cl.retiredOn")} ${numericDate(s.archivedAt)}`);
    return out;
  };

  const tabs = (["published", "drafts"] as const).map((t) => ({
    to: catalogueHref(t, { folder: folderId, q, per }),
    label: ut(t === "published" ? "cat.tabPublished" : "cat.tabDrafts"),
    end: t === "published",
  }));

  return (
    <Page
      title={ut("cat.title")}
      titleHidden
      toolbar={<Tabs label={ut("cat.tabsLabel")} items={tabs} />}
      actions={
        <Pager
          page={page}
          pages={pages}
          per={per}
          onPer={(n) => update({ per: n === DEFAULT_PER ? null : String(n), page: null })}
          onPage={(n) => update({ page: n > 1 ? String(n) : null })}
        />
      }
    >
      {/* поле поиска тянется на всю строку, «+» прижат к правому краю — как на макете */}
      <div className="flex items-center gap-[19px]">
        <div className="relative min-w-0 flex-1">
          {/*
            Имя полю даёт aria-label, а не Field: на макете поле поиска пустое,
            без подписи-плейсхолдера, а Field печатал бы подпись внутри поля.
            Лупа — украшение, не кнопка: поиск идёт по мере набора.
          */}
          <Input
            look="outline"
            aria-label={ut("cat.search")}
            value={q}
            onChange={(e) => update({ q: e.target.value, page: null })}
            className="pr-[44px]"
            autoComplete="off"
            /* предел сервера (surveyListQuery, q ≤ 200): длиннее — не «нет результатов», а 400 */
            maxLength={200}
          />
          <span aria-hidden className="pointer-events-none absolute right-[12px] top-1/2 -translate-y-1/2 text-text-2 [&>svg]:size-[22px]">
            <IconSearchGlass />
          </span>
        </div>
        <MenuButton label={ut("cat.add")} glyph={<IconPlusThick />}>
          {(close) => (
            <>
              {/*
                Папка и группа уходят конструктору параметрами: новый тест из
                папки «лютий 2023» должен в ней и появиться. Конструктор
                переписывается своей волной и читает их сам.
              */}
              <Link
                role="menuitem"
                to={current ? `/constructor?folder=${current.id}&group=${current.groupId}` : "/constructor"}
                className={menuItem}
                onClick={close}
              >
                {ut("cat.newTest")}
              </Link>
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  close();
                  setDialog({ kind: "folder", folder: null });
                }}
              >
                {ut("cat.newFolder")}
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  close();
                  fileRef.current?.click();
                }}
              >
                {ut("cl.importFile")}
              </button>
              <hr className="my-1 border-0 border-t border-hairline" />
              {/* третья вкладка кадра, убранная с глаз: см. пункт 1 в заголовке файла */}
              <Link role="menuitem" to={catalogueHref("retired", { folder: folderId, q, per })} className={menuItem} onClick={close}>
                {ut("cat.tabRetired")}
              </Link>
            </>
          )}
        </MenuButton>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = "";
          }}
        />
      </div>

      {error ? <p className="mb-0 mt-4 text-[13px] text-danger">{error}</p> : null}
      {importIssues?.length ? (
        <Panel
          className={cx(
            "mt-4",
            importIssues.some((i) => i.level === "error")
              ? "border border-[color-mix(in_srgb,var(--danger)_45%,transparent)]"
              : "border border-[color-mix(in_srgb,var(--accent)_45%,transparent)]",
          )}
          title={ut("cl.fileIssues")}
        >
          {importIssues.map((i, k) => (
            <p key={k} className="my-1 text-small">
              <span className={i.level === "error" ? "text-danger" : "text-accent"}>
                {i.level === "error" ? <IconCross /> : <IconCaution />}
              </span>{" "}
              <strong>{i.where}:</strong> <span className="text-muted">{i.message}</span>
            </p>
          ))}
        </Panel>
      ) : null}

      {confirming ? (
        /*
         * Ничего не удаляется: методика перестаёт выдаваться и проходиться, но
         * все собранные прохождения остаются. Формулировка обязана это
         * отражать — «удалить» здесь было бы враньём. Название всё равно
         * просим напечатать: в списке однотипных методик легко снять соседнюю.
         */
        <div className="mt-4">
          <ConfirmByName
            title={ut("cl.archiveConfirm")}
            name={confirming.title}
            actionLabel={ut("cl.archive")}
            warning={
              <>
                <p className="m-0 mb-1.5">{ut("cl.archiveWarnBody")}</p>
                <p className="m-0 text-muted">
                  {ut("cl.responsesKeptPrefix")} ({confirming.responseCount}) {ut("cl.responsesKeptSuffix")}
                </p>
              </>
            }
            onCancel={() => setConfirming(null)}
            onConfirm={async () => {
              await api.archiveSurvey(confirming.id);
              setConfirming(null);
              list.reload();
              shelves.reload();
              toast(ut("cl.archived"), "ok");
            }}
          />
        </div>
      ) : null}

      <Crumbs
        tab={tab}
        per={per}
        path={path}
        siblings={siblings}
        onRename={(f) => setDialog({ kind: "folder", folder: f })}
        onDelete={(f) => void deleteFolder(f)}
      />
      <FolderRow tab={tab} per={per} folders={children} groupNames={groupNames} />

      {shelves.error ? (
        <Loading error={shelves.error} onRetry={shelves.reload} />
      ) : list.error ? (
        <Loading error={list.error} onRetry={list.reload} />
      ) : !shown ? (
        <Loading rows={5} />
      ) : shown.items.length === 0 ? (
        <p className="m-0 py-[24px] text-[13px] text-muted">{dq.trim() ? ut("cat.emptySearch") : ut("cat.empty")}</p>
      ) : (
        /* колонки кадра f11: 169 · 534 · 496 при содержимом 1199 */
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[169px]" />
            <col className="w-[534px]" />
            <col />
          </colgroup>
          {/*
            Шапки на макете нет — колонки подписаны внутри каждой строки. Для
            диктора шапка всё же есть, скрытая: без неё таблица из трёх
            безымянных колонок читается как три абзаца подряд.
          */}
          <thead className="sr-only">
            <tr>
              <th scope="col">{ut("cl.name")}</th>
              <th scope="col">{ut("cat.resultCol")}</th>
              {/* действия лежат в третьей колонке: своей у них на кадре нет */}
              <th scope="col">
                {ut("cat.statsCol")} · {ut("cat.actionsCol")}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.items.map((s) => (
              <Row
                key={s.id}
                survey={s}
                marks={marksOf(s)}
                menu={
                  <RowMenu
                    survey={s}
                    marks={marksOf(s)}
                    onDuplicate={(x) => void duplicate(x)}
                    onMove={(x) => setDialog({ kind: "move", survey: x })}
                    onArchive={setConfirming}
                    onRestore={(x) => void restore(x)}
                  />
                }
              />
            ))}
          </tbody>
        </table>
      )}

      {dialog?.kind === "folder" ? (
        <FolderForm
          folder={dialog.folder}
          parent={dialog.folder ? null : current}
          groups={groups}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            shelves.reload();
          }}
        />
      ) : null}
      {dialog?.kind === "move" ? (
        <MoveForm
          survey={dialog.survey}
          folders={folders}
          onClose={() => setDialog(null)}
          onMoved={() => {
            setDialog(null);
            list.reload();
            shelves.reload();
          }}
        />
      ) : null}
    </Page>
  );
}
