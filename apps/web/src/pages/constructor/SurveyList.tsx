import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { Issue, SurveyFolder, SurveyFolderWithCounts, SurveyGroupWithCounts, SurveyListItem } from "@quizzy/shared";
import { api } from "../../api";
import { useResource } from "../../useResource";
import { ConfirmByName, IconChevron, IconSearchGlass, Loading, isTopLayer, useAction, useFocusTrap, useToast } from "../../ui";
import { Page, Panel } from "../../ui/layout";
import { Button, Input, Select, Tabs, Tag } from "../../ui/primitives";
import { cx } from "../../ui/cx";
import { useLang } from "../../lang";
import { FolderForm, MoveForm } from "./CatalogueDialogs";
import {
  DEFAULT_PER,
  PER_PAGE,
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
 * Чего на кадре нет, а здесь есть, и почему это не самодеятельность:
 *
 * 1. Третья вкладка «Зняті з використання». Прежний экран умел показывать
 *    снятые методики и возвращать их в работу; на макете этого состояния нет,
 *    потому что там нет и самого снятия. Убрать вкладку — значит оставить
 *    снятую методику без дороги назад. Вкладка стоит третьей и не мешает
 *    двум нарисованным.
 * 2. Глиф «⋯» в конце строки. Действия строки (правка, ключи, доступ, копия,
 *    перенос, снятие) на макете не нарисованы, а в системе живут: ключи и
 *    доступ — единственное место, где решают, выдавать ли методику. Они
 *    убраны с глаз в меню, но не убраны.
 * 3. Импорт из файла — третий пункт меню «+»: макет читает «+» как «новый
 *    тест или новая папка», а импорт — тот же новый тест, только из файла.
 *
 * Чего здесь НЕТ и не будет: «Результат тесту» абзацем в каждой строке.
 * Результат в системе — полосы интерпретации, нормы и стены на самой методике
 * (/surveys/:id); в строке каталога печатается её описание, а под
 * «Статистика» — числа, по которым реально выбирают: сколько вопросов,
 * сколько прохождений, сверены ли ключи.
 */

/* ─────────── глифы ─────────── */

/**
 * Свои, а не из общего набора: набор в ui/index.tsx рисует штрихом 1.8 на
 * сетке 24, а «+» на макете — штрих 5 в квадрате 27, каретка — залитый
 * треугольник 9×5 (та же, что у селекта). Подгонять общий набор под два
 * знака одного экрана значило бы менять его на всех.
 */
function IconPlusThick() {
  return (
    <svg viewBox="0 0 27 27" width={27} height={27} aria-hidden focusable="false">
      <path d="M13.5 2.5v22M2.5 13.5h22" stroke="currentColor" strokeWidth={5} />
    </svg>
  );
}

function IconCaret() {
  return (
    <svg viewBox="0 0 9 5" width={9} height={5} aria-hidden focusable="false">
      <path d="M0 0h9L4.5 5Z" fill="currentColor" />
    </svg>
  );
}

function IconDots() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden focusable="false" fill="currentColor">
      <circle cx="5" cy="12" r="2.2" />
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="19" cy="12" r="2.2" />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

/* ─────────── всплывающее меню ─────────── */

/*
 * Пункт меню — обычная строка 13/400, а не Button: кнопка макета полужирная
 * и залитая, и шесть таких подряд в столбик читались бы как шесть главных
 * действий. Строка меню — как в бургере шапки (Topbar.tsx, rowClass).
 * `border-0 bg-transparent min-h-0` гасят правила наследия для <button>.
 */
const menuItem = cx(
  "flex w-full items-center gap-2 rounded-[4px] border-0 bg-transparent px-3 py-2 text-left",
  "h-auto min-h-0 text-[13px] leading-[19px] font-normal text-text no-underline",
  "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)]",
  "hover:bg-primary-soft hover:text-primary hover:no-underline",
  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
);
const dangerItem = "text-danger hover:bg-danger-soft hover:text-danger";

/**
 * Глиф, раскрывающий меню: «+» над списком, «⋯» в строке, «▾» у крошки.
 *
 * Ловушка фокуса — общая (useFocusTrap): она же уводит фокус внутрь и
 * возвращает его на глиф при закрытии, поэтому окно, открытое из пункта
 * меню, запоминает «открывшим» именно глиф, а не исчезнувший пункт.
 * Подложка отвечает на нажатие мимо меню — без неё щелчок «закрыть»
 * попадал бы в ссылку строки под меню.
 */
function MenuButton({
  label,
  glyph,
  className,
  children,
}: {
  label: string;
  glyph: ReactNode;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useFocusTrap<HTMLDivElement>(open);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    /* Esc закрывает верхний слой: окно поверх меню не должно гасить оба */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopLayer(ref)) close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close, ref]);

  return (
    <div className={cx("relative inline-flex", className)}>
      <Button
        size="glyph"
        variant="ghost"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {glyph}
      </Button>
      {open ? (
        <>
          <div aria-hidden onClick={close} className="fixed inset-0 z-40" />
          <div
            ref={ref}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            className={cx(
              "absolute right-0 top-[calc(100%+6px)] z-50 flex min-w-[220px] flex-col gap-0.5",
              "rounded-md border border-border bg-surface p-1 shadow-panel outline-none",
            )}
          >
            {children(close)}
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ─────────── страницы ─────────── */

/**
 * «елементів на сторінці [10 ▾] сторінка 1 з 10 ‹ ›» — правый край строки над
 * списком, замеры макета: подпись 10/400 в два рядка, селект 52×27, стрелки
 * глифами с областью нажатия 44 (Button size="glyph").
 */
function Pager({
  page,
  pages,
  per,
  onPer,
  onPage,
}: {
  page: number;
  pages: number;
  per: number;
  onPer: (per: number) => void;
  onPage: (page: number) => void;
}) {
  const { ut } = useLang();
  return (
    <div className="flex items-center gap-[8px]">
      {/* ширина колонки и есть перенос «елементів / на сторінці» — ключ один */}
      <span className="w-[56px] text-right text-[10px] leading-[12px] text-muted">{ut("cat.perPage")}</span>
      <Select
        aria-label={ut("cat.perPage")}
        value={String(per)}
        onChange={(e) => onPer(Number(e.target.value))}
        /*
         * Размер места — стилем, а не классом: у Select в списке классов уже
         * стоят h-9 и text-[17px], а cx конфликты не разрешает, и какой из
         * двух классов победит, решал бы порядок в собранном CSS. Стиль
         * побеждает всегда. Отступ справа сжат до 16: каретка селекта стоит в
         * 10–14,5px от края, и «100» при 13-м кегле должно уместиться до неё.
         */
        style={{ height: 27, width: 52, fontSize: 13, paddingRight: 16 }}
      >
        {PER_PAGE.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
      <span className="ml-[9px] whitespace-nowrap text-[10px] text-muted">
        {ut("cat.page")} {page} {ut("common.of")} {pages}
      </span>
      <Button
        size="glyph"
        variant="ghost"
        className="ml-[5px]"
        aria-label={ut("cat.prevPage")}
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <span className="rotate-180 [&>svg]:size-[14px]">
          <IconChevron />
        </span>
      </Button>
      <Button size="glyph" variant="ghost" aria-label={ut("cat.nextPage")} disabled={page >= pages} onClick={() => onPage(page + 1)}>
        <span className="[&>svg]:size-[14px]">
          <IconChevron />
        </span>
      </Button>
    </div>
  );
}

/* ─────────── крошки и папки ─────────── */

const crumbClass = "text-[15px] font-bold leading-[20px] text-primary no-underline hover:underline";

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
                className={cx(menuItem, dangerItem)}
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
    <div className="flex items-start gap-[40px] border-b border-hairline py-[24px] text-[15px] leading-[20px]">
      <div className="flex shrink-0 items-center gap-[12px] font-bold text-primary">
        <span aria-hidden className="[&>svg]:size-[30px]">
          <IconFolder />
        </span>
        {ut("cat.folders")}
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-x-[48px] gap-y-[10px] p-0">
        {folders.map((f) => (
          <li key={f.id} className="flex flex-col">
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

const cellLabel = "text-[10px] font-bold leading-[14px] text-text-2";
const cellText = "m-0 text-[10px] leading-[14px] text-muted";
/*
 * Ячейка переопределяет правила наследия для td: там высота строки задана
 * токеном плотности, отступы 0 12, линия снизу. На макете строка высотой
 * по содержимому, без линий между строками и без левого отступа у названия.
 */
const cell = "h-auto border-0 py-[14px] pl-0 align-top";

/**
 * Действия строки за глифом «⋯» — см. пункт 2 в заголовке файла.
 */
function RowMenu({
  survey,
  onDuplicate,
  onMove,
  onArchive,
  onRestore,
}: {
  survey: SurveyListItem;
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
            <button type="button" role="menuitem" className={cx(menuItem, dangerItem)} onClick={act(close, onArchive)}>
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
  menu,
}: {
  survey: SurveyListItem;
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
  const rightsUnclear = !s.rightsStatus || s.rightsStatus === "unclear";

  return (
    <tr>
      <td className={cx(cell, "w-[172px] pr-[24px]")}>
        <Link to={`/surveys/${s.id}`} className="text-[15px] font-bold leading-[20px] text-primary no-underline hover:underline">
          {s.title}
        </Link>
        {s.isDemo || rightsUnclear || s.archivedAt ? (
          <div className="mt-[6px] flex flex-wrap gap-1">
            {s.isDemo ? <Tag>{ut("mark.demo")}</Tag> : null}
            {/* правовой статус стоит у названия: это место, где решают, выдавать ли методику */}
            {rightsUnclear ? (
              <span title={ut("cl.rightsHint")}>
                <Tag tone="attention">{ut("cl.rightsUnclear")}</Tag>
              </span>
            ) : null}
            {s.archivedAt ? (
              <span title={`${ut("cl.retiredOn")} ${numericDate(s.archivedAt)}`}>
                <Tag>{ut("mark.retired")}</Tag>
              </span>
            ) : null}
          </div>
        ) : null}
      </td>
      <td className={cx(cell, "pr-[36px]")}>
        <div className={cellLabel}>{ut("cat.resultCol")}</div>
        <p className={cellText}>{s.description ? s.description : <span className="text-faint">{ut("cat.noDescription")}</span>}</p>
      </td>
      <td className={cx(cell, "pr-[12px]")}>
        <div className={cellLabel}>{ut("cat.statsCol")}</div>
        <p className={cellText}>{stats}</p>
      </td>
      <td className={cx(cell, "w-[44px] py-[10px] text-right")}>{menu}</td>
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

  const tabs = (["published", "drafts", "retired"] as const).map((t) => ({
    to: catalogueHref(t, { folder: folderId, q, per }),
    label: ut(t === "published" ? "cat.tabPublished" : t === "drafts" ? "cat.tabDrafts" : "cat.tabRetired"),
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
                {i.level === "error" ? "✖" : "⚠"}
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
        <table className="w-full table-auto border-collapse">
          {/*
            Шапки на макете нет — колонки подписаны внутри каждой строки. Для
            диктора шапка всё же есть, скрытая: без неё таблица из трёх
            безымянных колонок читается как три абзаца подряд.
          */}
          <thead className="sr-only">
            <tr>
              <th scope="col">{ut("cl.name")}</th>
              <th scope="col">{ut("cat.resultCol")}</th>
              <th scope="col">{ut("cat.statsCol")}</th>
              <th scope="col">{ut("cat.actionsCol")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.items.map((s) => (
              <Row
                key={s.id}
                survey={s}
                menu={
                  <RowMenu
                    survey={s}
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
