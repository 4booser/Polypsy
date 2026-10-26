import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type {
  Issue,
  SurveyFolder,
  SurveyFolderWithCounts,
  SurveyGrant,
  SurveyGroupWithCounts,
  SurveyListItem,
} from "@quizzy/shared";
import { api, download } from "../../api";
import { useAuth } from "../../auth";
import { useResource } from "../../useResource";
import { eachOf, Loading, useAction, useToast } from "../../ui";
import { AlertChip, AlertStrip, KV } from "../../ui/records";
import { DataTable, type Column } from "../../ui/DataTable";
import { Drawer, DrawerSection } from "../../ui/Drawer";
import { BulkBar, FilterBar, ViewPills, type ViewItem } from "../../ui/filters";
import { Ic } from "../../ui/icons";
import { KbdHints } from "../../ui/kbd";
import { useHotkeys } from "../../ui/keys";
import { ActionMenu, MenuButton, menuItem, menuItemClass, type MenuEntry } from "../../ui/menu";
import { Pager } from "../../ui/pager";
import { Page, Panel } from "../../ui/layout";
import { Tooltip } from "../../ui/Popover";
import { Button, ButtonLink, SeverityTag, Tabs, Tag, type Severity } from "../../ui/primitives";
import { Callout, Empty } from "../../ui/states";
import { cx } from "../../ui/cx";
import { useLang } from "../../lang";
import { ShellIcon } from "../../shell/icons";
import { useMedia } from "../../shell/Rail";
import { ArchiveDialog } from "../methods/ArchiveDialog";
import { AssignDrawer, type ExistingAssignment } from "../../components/AssignDrawer";
import { ExportsDrawer } from "../methods/ExportsDrawer";
import { Mi } from "../methods/icons";
import { DOMAIN_KEY, domainKey, rightsKey } from "../methods/labels";
import { SourceNote } from "../methods/SourceNote";
import { attentionOf, fixedIn, grantState, keysPending, rightsPending, shortDate, splitCode } from "../methods/model";
import { num, useCount } from "../methods/useCount";
import { ArchiveManyDialog, codesLine, FolderForm, MoveForm, MoveManyForm } from "./CatalogueDialogs";
import {
  CATALOGUE_PER,
  assignPending,
  catalogueHref,
  cataloguePer,
  domainCounts,
  domainFrom,
  folderChildren,
  folderPath,
  listQuery,
  offsetPageCount,
  pageCount,
  pageFrom,
  retiredPage,
  tabFromPath,
  type CatalogueTab,
} from "./catalogue";

/*
 * Каталог методик — UI 3, «Виразна» (methods-catalog, methods-archive-dialog).
 *
 * Шапка: имя экрана, сколько методик и проходжень за 30 днів, «Нова папка»,
 * «Імпорт з файлу», «Нова методика» (N). Под ней — вкладки «Опубліковані /
 * Чернетки / Зняті з використання» с числами и строка внимания: черновики,
 * а суперадмину ещё несверенные ключи и невыясненные права на текст —
 * каждая пилюля с поповером и дверью к делу.
 *
 * В листе: папки текущего уровня («Мої тести» и крошки), поиск, группа,
 * чипы «Напрям» с числами (что измеряет методика: shared/domains.ts), таблица
 * и страницы. Строка: код и имя, признаки (лише за призначенням,
 * критичний пункт, заповнює фахівець, демо; права — суперадмину), група і
 * папка, шкали й смуги, проходження за 30 днів, версія (и ключи — суперадмину).
 * Действия строки всплывают
 * на наведении и фокусе (DataTable): «Призначити» (A) и «Коротко» — в
 * ящике, остальное в меню; «Зняти з використання» — окно (необратимо для
 * выдачи), «Перемістити в папку» (M) и папка — прежние окна.
 *
 * Состояние — в адресе, как и было: вкладка сегментом, папка, поиск,
 * группа, страница и её размер — параметрами (`replace`, не шаг истории).
 * Страницы считает сервер (catalogue.ts), поэтому сортировки по колонкам
 * здесь нет: она переставила бы одну страницу, а не каталог.
 */

/* ─────────── строки ─────────── */

/* место под пилюлю кода: самые длинные коды каталога («Brief COPE», «PC-PTSD-5», «SAD PERSONS») в 72 px резались */
const CODE_W = 96;

/**
 * Ячейка «Методика»: пилюля кода, имя, признаки и строка состава.
 * `domain` — подпись направления в начале строки состава («что измеряет», как
 * на макете); пусто, когда каталог и так отобран по направлению.
 */
function MethodCell({ s, flags, codes, domain }: { s: SurveyListItem; flags: ReactNode; codes: boolean; domain?: string | null }) {
  const { ut } = useLang();
  const count = useCount();
  const { code, name } = splitCode(s.title);
  const parts = [count(s.questionCount, "items"), s.description].filter(Boolean).join(", ");
  // подпись направления сама с запятыми («Настрій, тривога, дистрес») — отделяется точкой
  const line = [domain, parts].filter(Boolean).join(" · ");
  return (
    <span className="flex min-w-0 items-center gap-3">
      {/* место под код — только если на странице коды есть: пустой столбец без кодов был бы дырой */}
      {codes ? (
        <span className="shrink-0" style={{ width: CODE_W }}>
          {code ? (
            <span
              aria-hidden
              className="inline-grid h-6 max-w-full place-items-center truncate rounded-[7px] bg-sunk px-2 text-caption font-extrabold leading-none text-text"
            >
              {code}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1">
          {/* имя — ссылка на методику: её ищут сценарии (e2e) и открывают в новой вкладке */}
          <Link
            to={`/surveys/${s.id}`}
            title={s.title}
            className="min-w-0 truncate text-body font-bold leading-[18px] text-text no-underline hover:underline hover:decoration-violet-line hover:decoration-2 hover:underline-offset-[3px]"
          >
            {/* код — в имени ссылки: пилюля слева для глаза, а диктор и поиск по строке слышат «PHQ-9 Депресія» */}
            {code ? <span className="sr-only">{`${code} `}</span> : null}
            {name}
          </Link>
          {flags}
        </span>
        <small className="truncate text-caption text-muted" title={line}>
          {line || ut("cat.noDescription")}
        </small>
      </span>
    </span>
  );
}

/**
 * Значок-признак с подписью по наведению и фокусу. Роль img: имя
 * (aria-label) у безролевого span диктор вправе не прочесть, а признак
 * («критичний пункт», «лише за призначенням») — содержание строки.
 */
export function Flag({ label, children, warn }: { label: string; children: ReactNode; warn?: boolean }) {
  return (
    <Tooltip label={label}>
      <span
        role="img"
        tabIndex={0}
        aria-label={label}
        className={cx(
          "inline-grid size-5 shrink-0 place-items-center rounded-[6px] outline-offset-1",
          warn ? "text-warn hover:bg-warn-tint" : "text-muted hover:bg-sunk hover:text-text",
        )}
      >
        {children}
      </span>
    </Tooltip>
  );
}

/** Две строки ячейки: основная и приглушённая под ней */
function Two({ top, sub, warn }: { top: ReactNode; sub?: ReactNode; warn?: boolean }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">{top}</span>
      {sub ? <small className={cx("truncate text-caption", warn ? "font-bold text-warn" : "text-muted")}>{sub}</small> : null}
    </span>
  );
}

/** «знято 12.09» у снятой методики */
function RetiredLine({ at }: { at: string }) {
  const { ut } = useLang();
  return (
    <span className="inline-flex items-center gap-[5px] text-muted">
      <Ic.archive size={13} />
      {ut("mc.retiredOn").replace("{date}", shortDate(at))}
    </span>
  );
}

/**
 * «ключі звірено 12.09» / «ключі не звірено» / «без підрахунку балів» —
 * строка суперадмина: сверку ключей и права решает он (PATCH /rights), и
 * янтарь — его дело. Остальным это факт паспорта методики, не строка списка.
 */
function KeysLine({ s }: { s: Pick<SurveyListItem, "scoringEnabled" | "keysVerifiedAt" | "archivedAt"> }) {
  const { ut } = useLang();
  /* снятой методике ключи уже не долг — строка говорит, когда её сняли */
  if (s.archivedAt) return <RetiredLine at={s.archivedAt} />;
  if (!s.scoringEnabled) return <span className="text-muted">{ut("cat.scoringOff")}</span>;
  if (s.keysVerifiedAt) {
    return (
      <span className="inline-flex items-center gap-[5px] font-semibold text-muted">
        <Ic.circleCheck size={14} className="text-good" />
        {`${ut("cat.keysVerified")} ${shortDate(s.keysVerifiedAt)}`}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-[5px] font-bold text-warn">
      <ShellIcon name="key-round" size={14} />
      {ut("cat.keysUnverified")}
    </span>
  );
}

/* ─────────── папки ─────────── */

/**
 * Полка папок над таблицей: «Мої тести», крошки до текущей папки и папки
 * этого уровня чипами с числом методик. У текущей папки — меню: соседние
 * папки, переименовать, удалить (пустую; непустую сервер не даст).
 */
function Shelf({
  href,
  path,
  childFolders,
  siblings,
  groupNames,
  onRename,
  onDelete,
}: {
  /** Адрес папки этой вкладки; null — корень */
  href: (folder: string | null) => string;
  path: SurveyFolder[];
  childFolders: SurveyFolderWithCounts[];
  siblings: SurveyFolder[];
  /** Имена групп для подписи чипа; null — группа одна */
  groupNames: Map<string, string> | null;
  onRename: (f: SurveyFolder) => void;
  onDelete: (f: SurveyFolder) => void;
}) {
  const { ut } = useLang();
  const current = path.at(-1) ?? null;
  const crumb = "text-small font-bold no-underline hover:underline";
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pt-3.5">
      <nav aria-label={ut("cat.crumbsLabel")} className="mr-1 flex min-w-0 flex-wrap items-center gap-1.5 text-small">
        {current ? (
          <Link to={href(null)} className={cx(crumb, "text-violet-ink")}>
            {ut("cat.root")}
          </Link>
        ) : (
          <span aria-current="page" className="font-bold text-text-2">
            {ut("cat.root")}
          </span>
        )}
        {path.map((f, i) => (
          <span key={f.id} className="inline-flex items-center gap-1.5">
            <Ic.chevronRight size={13} className="text-muted" />
            {i === path.length - 1 ? (
              <span aria-current="page" className="font-extrabold text-text">
                {f.title}
              </span>
            ) : (
              <Link to={href(f.id)} className={cx(crumb, "text-violet-ink")}>
                {f.title}
              </Link>
            )}
          </span>
        ))}
        {current ? (
          <MenuButton label={ut("cat.folderMenu")} glyph={<Ic.chevronDown size={15} />} triggerSize="glyph-sm">
            {(close) => (
              <>
                {siblings.map((f) => (
                  <Link key={f.id} role="menuitem" to={href(f.id)} className={menuItem} onClick={close}>
                    <Mi.folder size={15} />
                    <span className="min-w-0 flex-1 truncate">{f.title}</span>
                  </Link>
                ))}
                {siblings.length ? <div role="separator" className="mx-1 my-1.5 h-px bg-divider" /> : null}
                <button
                  type="button"
                  role="menuitem"
                  className={menuItem}
                  onClick={() => {
                    close();
                    onRename(current);
                  }}
                >
                  <ShellIcon name="pencil" size={15} />
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
                  <Mi.trash size={15} />
                  {ut("cat.deleteFolder")}
                </button>
              </>
            )}
          </MenuButton>
        ) : null}
      </nav>
      {childFolders.map((f) => (
        <Link
          key={f.id}
          to={href(f.id)}
          title={groupNames?.get(f.groupId) ?? undefined}
          className="inline-flex h-8 items-center gap-1.5 rounded-2xl bg-sunk pl-2.5 pr-3 text-small font-semibold text-text-2 no-underline hover:bg-sunk-2 hover:text-text hover:no-underline"
        >
          <Mi.folder size={15} className="text-violet-ink" />
          {f.title}
          <small className="text-caption font-bold text-muted">{f.surveyCount}</small>
        </Link>
      ))}
    </div>
  );
}

/* ─────────── коротко о методике ─────────── */

const SEVERITY: Record<string, Severity> = { none: "none", mild: "mild", moderate: "moderate", severe: "severe" };

/**
 * «Коротко про методику» (mpeek): паспорт, ключи и смуги без перехода.
 * Смуги — из самой методики (api.survey), паспорт — из строки каталога.
 * Несверенные ключи — плашкой только суперадмину (`qa`): остальным это
 * строка паспорта, как в «Про методику».
 */
function PeekBody({
  s,
  groupTitle,
  folderTitle,
  qa,
}: {
  s: SurveyListItem;
  groupTitle: string | null;
  folderTitle: string | null;
  qa: boolean;
}) {
  const { ut, lang } = useLang();
  const count = useCount();
  const full = useResource(() => api.survey(s.id), [s.id]);
  const rights = rightsKey(s.rightsStatus);
  /* границы полос — с запятой в uk/ru, как везде */
  const bound = (v: number) => fixedIn(lang, v, 2, false);
  return (
    <>
      {qa && keysPending(s) && !s.archivedAt ? (
        <DrawerSection>
          <Callout
            kind="warn"
            icon={<ShellIcon name="key-round" size={16} />}
            title={ut("mc.attKeysTitle")}
            actions={
              <ButtonLink to={`/surveys/${s.id}/key`} size="xs" variant="secondary">
                {ut("mc.menuKeys")}
              </ButtonLink>
            }
          >
            {ut("mc.peekKeysText")}
          </Callout>
        </DrawerSection>
      ) : null}
      <DrawerSection title={ut("mc.peekPassport")}>
        <KV
          w={168}
          rows={[
            ...(s.description ? ([[ut("f.description"), s.description]] as [string, string][]) : []),
            [ut("dom.label"), ut(domainKey(s.domain) ?? "dom.none")],
            [
              ut("mc.peekVolume"),
              [count(s.questionCount, "items"), s.scaleCount ? count(s.scaleCount, "scales") : null].filter(Boolean).join(", "),
            ],
            ...(groupTitle
              ? ([[ut("f.group"), folderTitle ? `${groupTitle}, «${folderTitle}»` : groupTitle]] as [string, string][])
              : []),
            [ut("mc.peekVisibility"), s.visibility === "restricted" ? ut("mc.visRestricted") : ut("mc.visPublic")],
            [ut("mc.peekWho"), s.administration === "clinician" ? ut("bt.byClinician") : ut("mc.bySelf")],
            [ut("mc.peekRights"), rights ? ut(rights) : ut("mc.rightsUnclearValue")],
            ...(s.scoringEnabled
              ? ([
                  [
                    ut("mc.ovKeysChecked"),
                    s.keysVerifiedAt ? ut("mc.ovKeysCheckedOn").replace("{date}", shortDate(s.keysVerifiedAt)) : ut("mc.ovNo"),
                  ],
                ] as [string, string][])
              : []),
            ...(s.versionNumber
              ? ([[ut("mc.peekVersion"), `${s.versionNumber}, ${ut("mc.since").replace("{date}", shortDate(s.updatedAt))}`]] as [string, string][])
              : []),
            [
              ut("cl.responses"),
              s.recentResponseCount !== undefined
                ? ut("mc.peekResponses").replace("{recent}", num(s.recentResponseCount)).replace("{all}", num(s.responseCount))
                : num(s.responseCount),
            ],
          ]}
        />
        {/* откуда текст и пороги — там, где методику выбирают; описание выше читает и обследуемый */}
        <SourceNote text={s.sourceNote} className="mt-3 border-t border-divider pt-3" />
      </DrawerSection>
      <DrawerSection title={ut("mc.peekBands")}>
        {full.data ? (
          full.data.scales.some((sc) => sc.bands.length) ? (
            <div className="flex flex-col gap-3">
              {full.data.scales
                .filter((sc) => sc.bands.length)
                .map((sc) => (
                  <div key={sc.id}>
                    {full.data!.scales.length > 1 ? <b className="mb-1.5 block text-small font-extrabold text-text">{`${sc.code}, ${sc.title}`}</b> : null}
                    <div className="flex flex-col gap-1.5">
                      {[...sc.bands]
                        .sort((a, b) => a.minScore - b.minScore)
                        .map((b) => (
                          <div key={b.id} className="flex items-center gap-2.5 text-small">
                            <span className="min-w-14 shrink-0 whitespace-nowrap font-bold tabular-nums text-text-2">{`${bound(b.minScore)}–${bound(b.maxScore)}`}</span>
                            <SeverityTag small level={SEVERITY[b.severity] ?? "none"}>
                              {b.label}
                            </SeverityTag>
                          </div>
                        ))}
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <p className="m-0 text-small text-muted">{ut("mc.peekNoBands")}</p>
          )
        ) : (
          <Loading rows={2} error={full.error} onRetry={full.reload} bare />
        )}
      </DrawerSection>
    </>
  );
}

/* ─────────── экран ─────────── */

type Dialog =
  | { kind: "folder"; folder: SurveyFolder | null }
  | { kind: "move"; survey: SurveyListItem }
  | { kind: "archive"; survey: SurveyListItem }
  /* отмеченные строки: перенос в группу и папку, снятие с использования */
  | { kind: "moveMany" }
  | { kind: "archiveMany" };

const NOTHING_PICKED: ReadonlyMap<string, SurveyListItem> = new Map();

/** Отметка без ушедших: перенесённых, снятых, возвращённых */
function without(rows: ReadonlyMap<string, SurveyListItem>, gone: readonly SurveyListItem[]): Map<string, SurveyListItem> {
  const next = new Map(rows);
  for (const s of gone) next.delete(s.id);
  return next;
}

type Side = { kind: "assign" | "exports" | "peek"; survey: SurveyListItem };

export function SurveyList() {
  const { ut } = useLang();
  const count = useCount();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, busy } = useAction();
  const [params, setParams] = useSearchParams();
  const fileRef = useRef<HTMLInputElement>(null);
  /*
   * Несверенные ключи и невыясненные права — дела учреждения, и решает их
   * суперадмин (PATCH /api/surveys/:id/rights — только ему). Ему они —
   * янтарём в строке внимания и в строках; врачу янтарь на каждой из
   * семидесяти строк ничего не говорит, и ему это факт паспорта методики.
   */
  const { user, refreshUser } = useAuth();
  const qa = user?.role === "superadmin";

  /*
   * Всё состояние экрана — в адресе: вкладка сегментом, папка, поиск,
   * группа, страница — параметрами. Адрес каталога пересылают коллеге, и
   * открыться он обязан на том же, что видел отправитель.
   *
   * Строк на странице — исключение: это выбор врача, а не вид каталога, и
   * живёт он в профиле (workspace.catalogPer), как тема и плотность, —
   * сотрудник садится за разные машины. В адресе число остаётся, только
   * если пришло с ним (старая закладка): тогда оно и действует, и уходит в
   * ссылки вкладок и папок (linkPer). `chosen` — выбранное только что: профиль
   * перечитывается после сохранения, и до ответа экран не прыгает назад.
   */
  const tab = tabFromPath(pathname);
  const folderParam = params.get("folder");
  const q = params.get("q") ?? "";
  const group = params.get("group") ?? "";
  const domain = domainFrom(params.get("domain"));
  const page = pageFrom(params.get("page"));
  const [chosenPer, setChosenPer] = useState<number | null>(null);
  const per = cataloguePer(params.get("per"), chosenPer ?? user?.workspace?.catalogPer);
  const linkPer = params.get("per") !== null ? per : undefined;

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
   * Папки и группы живут дольше страницы: смена страницы или вкладки их не
   * трогает. Отказ по любому из двух не прячет каталог.
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
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g] as const)), [groups]);
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f] as const)), [folders]);
  const path = useMemo(() => (folderParam ? folderPath(folders, folderParam) : []), [folders, folderParam]);
  const current = path.at(-1) ?? null;
  const folderId = current?.id ?? null;
  const childFolders = useMemo(
    () => folderChildren(folders, folderId).filter((f) => !group || f.groupId === group),
    [folders, folderId, group],
  );
  const siblings = useMemo(
    () => (current ? folderChildren(folders, current.parentId).filter((f) => f.groupId === current.groupId && f.id !== current.id) : []),
    [folders, current],
  );
  const groupNames = useMemo(() => (groups.length > 1 ? new Map(groups.map((g) => [g.id, g.title] as const)) : null), [groups]);

  /*
   * Адрес вкладки или папки — с чипом направления и фильтром группы, если они
   * стоят: направление переживает смену вкладки и папки, как и группа;
   * catalogueHref о группе не знает.
   */
  const hrefOf = useCallback(
    (t: CatalogueTab, state: Parameters<typeof catalogueHref>[1]) => {
      const href = catalogueHref(t, { domain, ...state });
      if (!group) return href;
      const [pathPart, qs = ""] = href.split("?");
      const sp = new URLSearchParams(qs);
      sp.set("group", group);
      return `${pathPart}?${sp.toString()}`;
    },
    [group, domain],
  );

  /*
   * Весь каталог одним списком — для чисел вкладок, строки внимания и
   * шапки. Методик в учреждении сотни, не тысячи; страницы таблицы при этом
   * считает сервер, как и раньше.
   */
  const everything = useResource(() => api.surveys(true), []);
  const scoped = useMemo(
    () => (everything.data ?? []).filter((s) => !group || s.groupId === group),
    [everything.data, group],
  );
  const tabCounts = useMemo(() => {
    const live = scoped.filter((s) => !s.archivedAt);
    return {
      published: live.filter((s) => s.status === "published").length,
      drafts: live.filter((s) => s.status === "draft").length,
      retired: scoped.filter((s) => !!s.archivedAt).length,
      recent: live.reduce((sum, s) => sum + (s.recentResponseCount ?? 0), 0),
      groups: new Set(live.map((s) => s.groupId).filter(Boolean)).size,
    };
  }, [scoped]);
  const attention = useMemo(() => attentionOf(scoped), [scoped]);
  /* числа чипов «Напрям» — по вкладке и группе, как числа вкладок (catalogue.ts, domainCounts) */
  const domains = useMemo(() => domainCounts(everything.data ?? [], tab, group || null), [everything.data, tab, group]);

  /*
   * Список ждёт папки: неизвестная папка в адресе превращается в корень,
   * а до загрузки папок неизвестны все. С фильтром группы корень — вся
   * группа, а не только методики вне папок: «Методики групи» с экрана групп
   * ждут увидеть все её методики.
   */
  const query = useMemo(() => {
    const base = listQuery({ tab, folder: folderId, q: dq, page, per, domain });
    return group ? { ...base, groupId: group, folder: folderId ?? undefined } : base;
  }, [tab, folderId, dq, page, per, group, domain]);
  const list = useResource(() => api.surveyPage(query), [JSON.stringify(query)], { enabled: shelves.data !== null });
  const shown = useMemo(
    () => (list.data ? (tab === "retired" ? retiredPage(list.data.items, page, per) : list.data) : null),
    [list.data, tab, page, per],
  );
  // снятые приходят целиком и листаются здесь, остальное — смещением сервера, не дальше его предела
  const pages = (tab === "retired" ? pageCount : offsetPageCount)(shown?.total ?? 0, per);

  /* последняя страница может исчезнуть после снятия или переноса — возвращаемся на ближайшую */
  useEffect(() => {
    if (shown && page > pages) update({ page: pages > 1 ? String(pages) : null });
  }, [shown, page, pages, update]);

  const reloadAll = () => {
    list.reload();
    everything.reload();
    shelves.reload();
  };

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [side, setSide] = useState<Side | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importIssues, setImportIssues] = useState<Issue[] | null>(null);
  /* «Призначити» отмеченным — свой ящик: у строки он про одну методику */
  const [assignMany, setAssignMany] = useState(false);

  /*
   * Отметка строк живёт поверх страниц: «Вибрати всі 27» отмечает и те, что
   * на других страницах, а листание её не сбрасывает. Привязана к вкладке:
   * у опубликованных, черновиков и снятых свои действия, и отмеченное на
   * одной вкладке на другой не действует.
   */
  const [pick, setPick] = useState<{ tab: CatalogueTab; rows: ReadonlyMap<string, SurveyListItem> }>(() => ({
    tab,
    rows: NOTHING_PICKED,
  }));
  const picked = pick.tab === tab ? pick.rows : NOTHING_PICKED;
  const pickedKeys = useMemo(() => new Set(picked.keys()), [picked]);
  /*
   * Строки отмеченных — свежие из всего каталога, когда он перечитан: после
   * переноса, где группа сменилась, а папка нет, следующий шаг считается от
   * того, где методика лежит сейчас, а не где её отметили.
   */
  const freshById = useMemo(() => new Map((everything.data ?? []).map((s) => [s.id, s] as const)), [everything.data]);
  const pickedRows = useMemo(() => [...picked.values()].map((s) => freshById.get(s.id) ?? s), [picked, freshById]);
  const setPicked = (rows: ReadonlyMap<string, SurveyListItem>) => setPick({ tab, rows });
  const unpick = (gone: readonly SurveyListItem[]) => setPick((prev) => ({ tab: prev.tab, rows: without(prev.rows, gone) }));

  /* назначения строки — только когда открыт её ящик: сказать, у кого методика уже есть */
  const grants = useResource(() => api.grants(side!.survey.id).catch(() => [] as SurveyGrant[]), [side?.survey.id], {
    enabled: side?.kind === "assign",
  });
  const existing = useMemo(() => {
    const now = new Date();
    return new Map<string, ExistingAssignment>(
      (grants.data ?? [])
        .filter((g) => grantState(g, now) !== "late")
        .map((g) => [g.userId, { until: g.expiresAt, done: g.completed }] as const),
    );
  }, [grants.data]);

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
    if (await run(() => api.duplicateSurvey(s.id), ut("mc.copied"))) reloadAll();
  };
  const restore = async (s: SurveyListItem) => {
    if (await run(() => api.restoreSurvey(s.id), ut("cl.restored"))) reloadAll();
  };
  /* вернуть отмеченные — без окна, как и одну: шаг ничего не обрывает */
  const restoreMany = async () => {
    let outcome: Awaited<ReturnType<typeof eachOf<SurveyListItem>>> = { done: [], failed: [] };
    await run(async () => {
      outcome = await eachOf(pickedRows, (s) => api.restoreSurvey(s.id));
    });
    const { done, failed } = outcome;
    if (done.length) {
      toast(ut("mc.restoredN").replace("{n}", String(done.length)), "ok");
      unpick(done);
      reloadAll();
    }
    if (failed.length) {
      const first = failed[0]!;
      toast(`${ut("mc.bulkFailed").replace("{n}", String(failed.length))}: ${first.item.title}${first.reason ? ` (${first.reason})` : ""}`, "err");
    }
  };
  /*
   * «Вибрати всі N» — весь вид экрана без страниц: та же вкладка, папка,
   * поиск, группа и направление. Снятые и так пришли целиком (listQuery).
   */
  const selectAll = () =>
    void run(async () => {
      const all =
        tab === "retired"
          ? (list.data?.items ?? []).filter((s) => !!s.archivedAt)
          : (await api.surveyPage({ ...query, limit: undefined, offset: undefined })).items;
      setPicked(new Map(all.map((s) => [s.id, s] as const)));
    });

  const deleteFolder = async (f: SurveyFolder) => {
    /* пустую папку удалять не страшно, непустую сервер не даст; окно — от случайного нажатия в меню */
    if (!window.confirm(ut("cat.deleteFolderConfirm"))) return;
    if (await run(() => api.deleteSurveyFolder(f.id), ut("cat.folderDeleted"))) {
      shelves.reload();
      navigate(hrefOf(tab, { folder: f.parentId, per: linkPer }), { replace: true });
    }
  };

  const newHref = current ? `/constructor?folder=${current.id}&group=${current.groupId}` : group ? `/constructor?group=${group}` : "/constructor";
  const canAssign = (s: SurveyListItem) => !s.archivedAt && s.status === "published" && s.administration !== "clinician";
  /* отмеченные, которые можно назначить: заполняемые фахівцем назначаются не так — у них «Провести» */
  const assignable = pickedRows.filter(canAssign);
  /*
   * Назначение отмеченных одному адресату (человеку или группе) — каждой
   * методикой по очереди. Отказ по одной (её сняли, пока ящик был открыт)
   * не обрывает остальные; не прошедшие называются кодом и причиной, и ящик
   * оставляет адресата к повтору.
   *
   * Повтор выдаёт только не прошедшие пары (assignPending в catalogue.ts).
   * Пары помнятся, пока операция не закончена: адресат, которому дошло всё,
   * забывается сразу. Закрытый ящик операцию не заканчивает — он держит
   * черновик (адресатов, срок, комментарий), и открытый снова продолжает её,
   * в том числе с другим набором отмеченных. Заканчивается она вместе с
   * черновиком — когда ящик снят со страницы (отметка снята, другая
   * вкладка). В адресат входят срок и комментарий.
   */
  const assigned = useRef({ pairs: new Set<string>(), recipients: new Map<string, number>() });
  const assignOpen = tab === "published" && assignable.length > 0;
  useEffect(() => {
    if (!assignOpen) assigned.current = { pairs: new Set(), recipients: new Map() };
  }, [assignOpen]);
  const assignEachSurvey = async (target: string, act: (s: SurveyListItem) => Promise<unknown>) => {
    const { failed } = await assignPending(assignable, target, assigned.current.pairs, act);
    if (!failed.length) return;
    const list = failed.map((f) => `${splitCode(f.item.title).code ?? f.item.title}${f.reason ? `: ${f.reason}` : ""}`).join("; ");
    throw new Error(ut(failed.length < assignable.length ? "mc.assignManyPartly" : "mc.assignManyNone").replace("{list}", list));
  };

  /* строка в фокусе клавиатуры — для A, M, E */
  const focused = (): SurveyListItem | null => {
    const key = (document.activeElement as HTMLElement | null)?.closest("tr[data-key]")?.getAttribute("data-key");
    return key ? (shown?.items.find((s) => s.id === key) ?? null) : null;
  };
  useHotkeys(
    {
      n: () => navigate(newHref),
      a: () => {
        const s = focused();
        if (s && canAssign(s)) setSide({ kind: "assign", survey: s });
      },
      m: () => {
        const s = focused();
        if (s) setDialog({ kind: "move", survey: s });
      },
      e: () => {
        const s = focused();
        if (s) navigate(`/constructor/${s.id}`);
      },
    },
    !dialog,
  );

  const menuOf = (s: SurveyListItem): MenuEntry[] => {
    const retired = !!s.archivedAt;
    const entries: MenuEntry[] = [
      { label: ut("cl.editAction"), icon: <ShellIcon name="pencil" size={16} />, to: `/constructor/${s.id}`, kbd: "E" },
      { label: ut("mc.menuKeys"), icon: <ShellIcon name="key-round" size={16} />, to: `/surveys/${s.id}/key` },
      { label: ut("mc.menuAccess"), icon: <ShellIcon name="user-cog" size={16} />, to: `/surveys/${s.id}/access` },
    ];
    if (!retired && s.status === "published") {
      entries.push({ label: ut("mc.menuAdminister"), icon: <Ic.keyboard size={16} />, to: `/surveys/${s.id}/administer` });
    }
    entries.push(
      { label: ut("mc.menuBlank"), icon: <Mi.printer size={16} />, to: `/surveys/${s.id}/blank` },
      { label: ut("cl.duplicateAction"), icon: <Mi.copy size={16} />, ruled: true, onSelect: () => void duplicate(s) },
      { label: ut("cat.move"), icon: <Mi.folderInput size={16} />, kbd: "M", onSelect: () => setDialog({ kind: "move", survey: s }) },
      { label: ut("mc.menuExports"), icon: <Mi.fileDown size={16} />, onSelect: () => setSide({ kind: "exports", survey: s }) },
      {
        label: ut("key.exportJson"),
        icon: <Mi.fileJson size={16} />,
        onSelect: () => void run(() => download(api.methodologyUrl(s.id), "methodology.json")),
      },
    );
    entries.push(
      retired
        ? { label: ut("cl.restoreAction"), icon: <Mi.archiveRestore size={16} />, ruled: true, onSelect: () => void restore(s) }
        : { label: ut("cl.archive"), icon: <Ic.archive size={16} />, ruled: true, onSelect: () => setDialog({ kind: "archive", survey: s }) },
    );
    return entries;
  };

  const flagsOf = (s: SurveyListItem) => (
    <>
      {s.visibility === "restricted" ? (
        <Flag label={ut("mc.flagRestricted")}>
          <Ic.lock size={13} />
        </Flag>
      ) : null}
      {s.hasCriticalItem ? (
        <Flag label={ut("mc.flagCritical")}>
          <Mi.siren size={13} />
        </Flag>
      ) : null}
      {s.administration === "clinician" ? (
        <Flag label={ut("bt.byClinician")}>
          <ShellIcon name="stethoscope" size={13} />
        </Flag>
      ) : null}
      {qa && rightsPending(s) ? (
        <Flag label={ut("mc.flagRights")} warn>
          <Mi.scale size={13} />
        </Flag>
      ) : null}
      {s.isDemo ? (
        <Tag tone="attention" className="ml-1">
          {ut("mark.demo")}
        </Tag>
      ) : null}
    </>
  );

  /*
   * Ширина колонок — под 1440 и 1280. На 1280 и уже «Шкали» уходят из
   * таблицы (они есть в «Коротко про методику»): иначе имени методики
   * оставалось бы полтораста пикселей.
   */
  const narrow = useMedia("(max-width: 1366px)");
  const pageHasCodes = !!shown?.items.some((s) => splitCode(s.title).code);
  /*
   * «Група і папка» — только то, что различает строки. Группа — когда видно
   * несколько групп и фильтра группы нет; папка — у строки, лежащей не в
   * открытой папке (поиск и направление идут по поддереву). В корне без
   * поиска строки и так вне папок, и «Каталог методик / у корені групи» на
   * каждой из семидесяти строк ничего не говорило: место отдано названию.
   * Нечего различать — колонки нет вовсе.
   */
  const showGroups = groups.length > 1 && !group;
  const folderOf = (s: SurveyListItem) => (s.folderId && s.folderId !== folderId ? (folderById.get(s.folderId) ?? null) : null);
  const pageHasFolders = !!shown?.items.some((s) => folderOf(s));
  /* подпись направления в строке; отобрано по направлению — у всех строк она одна, и строка её не повторяет */
  const rowDomain = (s: SurveyListItem): string | null => {
    if (domain && domain !== "none") return null;
    const key = domainKey(s.domain);
    return key ? ut(key) : null;
  };
  const columns: Column<SurveyListItem>[] = [
    {
      key: "method",
      header: ut("mc.colMethod"),
      required: true,
      render: (s) => <MethodCell s={s} flags={flagsOf(s)} codes={pageHasCodes} domain={rowDomain(s)} />,
    },
    {
      key: "group",
      header: ut(showGroups ? (pageHasFolders ? "mc.colGroup" : "f.group") : "cst.folder"),
      required: true,
      width: narrow ? 150 : 176,
      render: (s) => {
        const f = folderOf(s);
        if (!showGroups) return f ? <Two top={f.title} /> : null;
        const g = s.groupId ? groupById.get(s.groupId) : null;
        return <Two top={g?.title ?? ut("mark.outsideGroups")} sub={f?.title ?? null} />;
      },
    },
    {
      key: "scales",
      header: ut("mc.colScales"),
      required: true,
      width: 100,
      render: (s) =>
        s.scaleCount === undefined ? (
          <span className="text-muted">—</span>
        ) : (
          <Two top={count(s.scaleCount, "scales")} sub={s.bandCount ? count(s.bandCount, "bands") : null} />
        ),
    },
    {
      key: "uses",
      header: ut("mc.colUses"),
      required: true,
      width: narrow ? 118 : 138,
      num: true,
      render: (s) => (
        <span className="flex flex-col items-end">
          <b className="font-extrabold tabular-nums text-text">{num(s.recentResponseCount ?? s.responseCount)}</b>
          {s.recentResponseCount !== undefined ? (
            <small className="text-caption text-muted">{ut("mc.usesAll").replace("{n}", num(s.responseCount))}</small>
          ) : null}
        </span>
      ),
    },
    {
      key: "version",
      /* ключи в колонке — у суперадмина; у остальных она о версии и о снятии */
      header: ut(qa ? "mc.colVersion" : "mc.peekVersion"),
      required: true,
      width: narrow ? 176 : 188,
      render: (s) => (
        <Two
          top={
            s.versionNumber ? (
              <>
                {ut("ant.versionN").replace("{n}", String(s.versionNumber))}{" "}
                <span className="text-muted">{ut("mc.since").replace("{date}", shortDate(s.updatedAt))}</span>
              </>
            ) : (
              <span className="text-muted">{ut("mc.noVersion")}</span>
            )
          }
          sub={qa ? <KeysLine s={s} /> : s.archivedAt ? <RetiredLine at={s.archivedAt} /> : null}
        />
      ),
    },
  ];

  const shownColumns = columns.filter(
    (c) => !(narrow && c.key === "scales") && !(c.key === "group" && !showGroups && !pageHasFolders),
  );

  const rowActions = (s: SurveyListItem) => (
    <>
      {s.archivedAt ? (
        <Button size="xs" variant="ghost" icon={<Mi.archiveRestore />} disabled={busy} onClick={() => void restore(s)}>
          {ut("cl.restoreAction")}
        </Button>
      ) : s.status === "draft" ? (
        <ButtonLink size="xs" variant="ghost" to={`/constructor/${s.id}`}>
          <ShellIcon name="pencil" size={14} />
          {ut("cl.editAction")}
        </ButtonLink>
      ) : canAssign(s) ? (
        <Button size="xs" variant="ghost" icon={<Mi.clipboardPlus />} onClick={() => setSide({ kind: "assign", survey: s })}>
          {ut("acc.grant")}
        </Button>
      ) : s.administration === "clinician" ? (
        <ButtonLink size="xs" variant="ghost" to={`/surveys/${s.id}/administer`}>
          <Ic.keyboard size={14} />
          {ut("mc.administerShort")}
        </ButtonLink>
      ) : null}
      <Tooltip label={ut("mc.peekTitle")}>
        <Button size="icon-sm" variant="quiet" aria-label={ut("mc.peekTitle")} onClick={() => setSide({ kind: "peek", survey: s })}>
          <Mi.panelRightOpen />
        </Button>
      </Tooltip>
      <ActionMenu label={ut("cat.rowActions")} entries={menuOf(s)} triggerSize="icon-sm" plateClassName="min-w-[260px]" />
    </>
  );

  const tabs = (["published", "drafts", "retired"] as const).map((t) => ({
    to: hrefOf(t, { folder: folderId, q, per: linkPer }),
    label: ut(t === "published" ? "mc.tabPublished" : t === "drafts" ? "sn.drafts" : "cat.tabRetired"),
    end: t === "published",
    count: everything.data ? tabCounts[t] : null,
  }));

  const pop = (items: SurveyListItem[], to: (s: SurveyListItem) => string) => (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {items.slice(0, 6).map((s) => (
        <li key={s.id} className="text-small">
          <Link to={to(s)} className="font-bold text-violet-ink">
            {splitCode(s.title).code ?? s.title}
          </Link>
          {splitCode(s.title).code ? <span className="text-muted">{` ${splitCode(s.title).name}`}</span> : null}
        </li>
      ))}
      {items.length > 6 ? <li className="text-caption text-muted">{ut("mc.andMore").replace("{n}", String(items.length - 6))}</li> : null}
    </ul>
  );
  /* последний черновик коротко: код или начало имени */
  const shortName = (s: SurveyListItem) => {
    const { code, name } = splitCode(s.title);
    return code ?? (name.length > 22 ? `${name.slice(0, 21)}…` : name);
  };
  /* подробность пилюли — коды первых двух; без кодов — просто сколько (имена целиком в поповере) */
  const firstCodes = (items: SurveyListItem[]) => {
    const codes = items.slice(0, 2).map((s) => splitCode(s.title).code);
    if (codes.some((c) => !c)) return String(items.length);
    return codes.join(", ") + (items.length > 2 ? ` +${items.length - 2}` : "");
  };

  /* ключи и права — пилюлями только суперадмину (см. qa); черновики — всем */
  const keysDue = qa ? attention.keys : [];
  const rightsDue = qa ? attention.rights : [];
  const strip =
    keysDue.length || rightsDue.length || (attention.drafts.length && tab !== "drafts") ? (
      <AlertStrip label={ut("mc.attentionLabel")} className="ml-auto max-w-full">
        {keysDue.length ? (
          <AlertChip
            kind="warn"
            icon={<ShellIcon name="key-round" />}
            label={ut("mc.attKeys")}
            detail={firstCodes(keysDue)}
            popTitle={ut("mc.attKeysTitle")}
            popNote={String(keysDue.length)}
            pop={
              <>
                {pop(keysDue, (s) => `/surveys/${s.id}/key`)}
                <p className="m-0 mt-2 text-caption text-muted">{ut("mc.attKeysNote")}</p>
              </>
            }
          />
        ) : null}
        {rightsDue.length ? (
          <AlertChip
            kind="warn"
            icon={<Mi.scale />}
            label={ut("mc.attRights")}
            detail={firstCodes(rightsDue)}
            popTitle={ut("mc.attRightsTitle")}
            popNote={String(rightsDue.length)}
            pop={
              <>
                {pop(rightsDue, (s) => `/surveys/${s.id}`)}
                <p className="m-0 mt-2 text-caption text-muted">{ut("cl.rightsHint")}</p>
              </>
            }
          />
        ) : null}
        {attention.drafts.length && tab !== "drafts" ? (
          <AlertChip
            icon={<ShellIcon name="file-pen-line" />}
            label={`${ut("sn.drafts")} ${attention.drafts.length}`}
            detail={shortName(attention.drafts[0]!)}
            to={hrefOf("drafts", { per: linkPer })}
            popTitle={ut("sn.drafts")}
            popNote={String(attention.drafts.length)}
            pop={pop(attention.drafts, (s) => `/constructor/${s.id}`)}
          />
        ) : null}
      </AlertStrip>
    ) : null;

  const groupChip =
    groups.length > 1 ? (
      <MenuButton
        label={ut("mc.filterGroup")}
        trigger={(p) => (
          <button
            type="button"
            {...p}
            className={cx(
              "inline-flex h-9 min-h-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[18px] border-0 pl-3 pr-2.5 text-small font-semibold",
              group ? "bg-violet-tint text-violet-ink hover:bg-violet-tint-2" : "bg-sunk text-text-2 hover:bg-sunk-2",
            )}
          >
            {ut("f.group")}
            <b className={cx("font-extrabold", group ? "text-violet-ink" : "text-text")}>
              {group ? (groupById.get(group)?.title ?? "…") : ut("mc.allGroups").replace("{n}", String(groups.length))}
            </b>
            <Ic.chevronDown size={13} />
          </button>
        )}
      >
        {(close) => (
          <>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!group}
              className={menuItem}
              onClick={() => {
                close();
                update({ group: null, page: null, folder: null });
              }}
            >
              <span className="min-w-0 flex-1 truncate">{ut("mc.allGroups").replace("{n}", String(groups.length))}</span>
              {!group ? <Ic.check size={15} className="text-violet-ink" /> : null}
            </button>
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                role="menuitemradio"
                aria-checked={group === g.id}
                className={menuItem}
                onClick={() => {
                  close();
                  update({ group: g.id, page: null, folder: null });
                }}
              >
                <span className="min-w-0 flex-1 truncate">{g.title}</span>
                {group === g.id ? <Ic.check size={15} className="text-violet-ink" /> : null}
              </button>
            ))}
          </>
        )}
      </MenuButton>
    ) : null;

  /*
   * Чипы «Напрям» — пилюли видов набора (ViewPills), как полка направлений
   * на макете бібліотеки (methods-new): «Усі» и направления, у которых на
   * вкладке есть методики, в порядке перечня; «Без напряму» — когда такие
   * есть. Выбранный чип с нулём не пропадает: иначе его нечем было бы снять.
   * Полки нет, пока на вкладке нет ни одного направления: один чип «Усі»
   * ничего не отбирает.
   */
  const presentDomains = domains.domains.filter((d) => d.count > 0 || d.domain === domain);
  const domainPills: ViewItem[] | null =
    everything.data && (presentDomains.length || domain)
      ? [
          { key: "all", label: ut("dom.all"), count: domains.all },
          ...presentDomains.map((d) => ({ key: d.domain, label: ut(DOMAIN_KEY[d.domain]), count: d.count })),
          ...(domains.none > 0 || domain === "none" ? [{ key: "none", label: ut("dom.none"), count: domains.none }] : []),
        ]
      : null;

  const emptyNode =
    dq.trim() || group || domain ? (
      <Empty compact title={ut("cat.emptySearch")} hint={ut("mc.emptySearchHint")} />
    ) : tab === "retired" ? (
      <Empty compact title={ut("mc.emptyRetired")} />
    ) : tab === "drafts" ? (
      <Empty compact title={ut("mc.emptyDrafts")} action={<ButtonLink to={newHref} size="xs">{ut("mc.newMethod")}</ButtonLink>} />
    ) : (
      <Empty compact title={current ? ut("cat.empty") : ut("mc.emptyCatalog")} action={<ButtonLink to={newHref} size="xs">{ut("mc.newMethod")}</ButtonLink>} />
    );

  const sideSurvey = side?.survey ?? null;
  const sideNames = sideSurvey ? splitCode(sideSurvey.title) : null;

  return (
    <Page
      title={ut("mc.catTitle")}
      meta={
        everything.data
          ? [
              count(tabCounts.published, "methods") + (tabCounts.groups > 1 ? ` ${ut("mc.inGroups").replace("{n}", String(tabCounts.groups))}` : ""),
              ut("mc.recentMeta").replace("{n}", count(tabCounts.recent, "responses")),
            ]
          : undefined
      }
      actions={
        <>
          <Tooltip label={ut("cat.newFolder")}>
            <Button variant="secondary" size="icon" aria-label={ut("cat.newFolder")} onClick={() => setDialog({ kind: "folder", folder: null })}>
              <Mi.folderPlus />
            </Button>
          </Tooltip>
          <Button variant="secondary" icon={<Mi.fileUp />} onClick={() => fileRef.current?.click()} title={ut("mc.importHint")}>
            {ut("cl.importFile")}
          </Button>
          <ButtonLink to={newHref} variant="primary" title={ut("mc.newMethod")}>
            <Ic.plus size={16} />
            {ut("mc.newMethod")}
          </ButtonLink>
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
        </>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Tabs label={ut("cat.tabsLabel")} items={tabs} />
          {strip}
        </div>
      }
    >
      {error ? (
        <Callout kind="warn" className="mb-3" role="alert">
          {error}
        </Callout>
      ) : null}
      {importIssues?.length ? (
        <Panel className="mb-3" title={ut("cl.fileIssues")} icon={<Ic.circleAlert />} tone="warn">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {importIssues.map((i, k) => (
              <li key={k} className="flex items-start gap-2 text-small">
                <span className={cx("mt-0.5 inline-flex", i.level === "error" ? "text-risk-ink" : "text-warn")}>
                  {i.level === "error" ? <Ic.circleX size={14} /> : <Ic.alert size={14} />}
                </span>
                <span>
                  <b className="text-text">{i.where}:</b> <span className="text-muted">{i.message}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel flush>
        {path.length || childFolders.length ? (
        <Shelf
          href={(folder) => hrefOf(tab, { folder, per: linkPer })}
          path={path}
          childFolders={childFolders}
          siblings={siblings}
          groupNames={groupNames}
          onRename={(f) => setDialog({ kind: "folder", folder: f })}
          onDelete={(f) => void deleteFolder(f)}
        />
        ) : null}
        <div className="px-4 pb-3 pt-3.5">
          <FilterBar
            search={{
              value: q,
              onChange: (v) => update({ q: v, page: null }),
              placeholder: ut("mc.searchPh"),
              label: ut("cat.search"),
              width: 300,
            }}
            chips={groupChip}
            count={shown ? { shown: shown.items.length, total: shown.total } : undefined}
          />
          {domainPills ? (
            <ViewPills
              className="mt-2.5"
              label={ut("dom.filterLabel")}
              items={domainPills}
              value={domain ?? "all"}
              onChange={(key) => update({ domain: key === "all" ? null : key, page: null })}
            />
          ) : null}
          <BulkBar
            className="mt-2.5"
            count={picked.size}
            total={shown?.total}
            things
            onSelectAll={selectAll}
            onClear={() => setPicked(NOTHING_PICKED)}
          >
            {tab === "published" && assignable.length ? (
              <Button variant="panel" size="xs" icon={<Mi.clipboardPlus />} disabled={busy} onClick={() => setAssignMany(true)}>
                {ut("acc.grant")}
              </Button>
            ) : null}
            <Button variant="panel" size="xs" icon={<Mi.folderInput />} disabled={busy} onClick={() => setDialog({ kind: "moveMany" })}>
              {ut("mc.bulkMove")}
            </Button>
            {tab === "retired" ? (
              <Button variant="panel" size="xs" icon={<Mi.archiveRestore />} disabled={busy} onClick={() => void restoreMany()}>
                {ut("cl.restoreAction")}
              </Button>
            ) : (
              <Button
                variant="panel"
                size="xs"
                icon={<Ic.archive />}
                disabled={busy}
                onClick={() =>
                  /* одну снимают прежним окном — с подтверждением кодом */
                  setDialog(pickedRows.length === 1 ? { kind: "archive", survey: pickedRows[0]! } : { kind: "archiveMany" })
                }
              >
                {ut("cl.archive")}
              </Button>
            )}
          </BulkBar>
        </div>
        {shelves.error ? (
          <Loading error={shelves.error} onRetry={shelves.reload} bare />
        ) : list.error && !shown ? (
          <Loading error={list.error} onRetry={list.reload} bare />
        ) : !shown ? (
          <Loading rows={6} bare />
        ) : shown.items.length === 0 ? (
          <div className="border-t border-divider px-4">{emptyNode}</div>
        ) : (
          /*
           * Колонка «Методика» забирает остаток ширины и режет длинное по
           * многоточию: max-width 0 при ширине 100 % у её ячеек — иначе
           * таблица растягивается по самому длинному описанию. Она вторая:
           * первая — отметка строки.
           */
          <div className="[&_td:nth-child(2)]:w-full [&_td:nth-child(2)]:max-w-0 [&_th:nth-child(2)]:w-full">
          <DataTable
            rows={shown.items}
            columns={shownColumns}
            rowKey={(s) => s.id}
            label={ut("mc.catTitle")}
            selectable
            selected={pickedKeys}
            onSelectedChange={(keys) => {
              /* отмеченные с других страниц — из прежней отметки, с этой — из строк страницы */
              const onPage = new Map(shown.items.map((s) => [s.id, s] as const));
              const next = new Map<string, SurveyListItem>();
              for (const k of keys) {
                const row = picked.get(k) ?? onPage.get(k);
                if (row) next.set(k, row);
              }
              setPicked(next);
            }}
            onRowClick={(s) => navigate(s.status === "draft" ? `/constructor/${s.id}` : `/surveys/${s.id}`)}
            isRowActive={(s) => side?.survey.id === s.id}
            rowActions={rowActions}
            hotkeys={!side && !dialog}
          />
          </div>
        )}
        {shown && (pages > 1 || per !== CATALOGUE_PER) ? (
          <div className="border-t border-divider py-2.5 pl-4 pr-3">
            <Pager
              page={page}
              pages={pages}
              per={per}
              total={shown.total}
              onPer={(n) => {
                /* выбор — в профиль, а не в адрес: на другой машине каталог откроется так же */
                setChosenPer(n);
                update({ per: null, page: null });
                void api
                  .saveWorkspace({ catalogPer: n as 10 | 20 | 50 | 100 })
                  .then(refreshUser)
                  .catch(() => {});
              }}
              onPage={(n) => update({ page: n > 1 ? String(n) : null })}
            />
          </div>
        ) : null}
        <KbdHints
          bar
          keys={[
            ["J K", ut("mc.keyRows")],
            ["X", ut("mc.keyPick")],
            ["Enter", ut("mc.keyOpen")],
            ["A", ut("mc.keyAssign")],
            ["M", ut("mc.keyMove")],
            ["E", ut("mc.keyEdit")],
            ["N", ut("mc.newMethod")],
            ["/", ut("mc.keySearch")],
          ]}
        />
      </Panel>

      {sideSurvey && sideNames ? (
        <>
          <AssignDrawer
            choose="recipients"
            key={`assign-${sideSurvey.id}`}
            open={side?.kind === "assign"}
            onClose={() => setSide(null)}
            onReturn={() => setSide({ kind: "assign", survey: sideSurvey })}
            title={ut("mc.assignTitle").replace("{code}", sideNames.code ?? sideNames.name)}
            sub={
              sideNames.code
                ? `${sideNames.name}${sideSurvey.versionNumber ? `, ${ut("ant.versionN").replace("{n}", String(sideSurvey.versionNumber))}` : ""}`
                : undefined
            }
            note={count(sideSurvey.questionCount, "items")}
            draftName={ut("mc.assignDraft").replace("{code}", sideNames.code ?? sideNames.name)}
            existing={existing}
            assignOne={(userId, due, note) => api.grant(sideSurvey.id, userId, note ?? undefined, due)}
            assignGroup={(groupId, due, note) =>
              api.assignSurveyToPatientGroup(groupId, { surveyId: sideSurvey.id, expiresAt: due, note })
            }
            onAssigned={() => grants.reload()}
          />
          <ExportsDrawer
            key={`exports-${sideSurvey.id}`}
            open={side?.kind === "exports"}
            onClose={() => setSide(null)}
            surveyId={sideSurvey.id}
            sub={ut("mc.exSub").replace("{code}", sideNames.code ?? sideNames.name)}
            scope={`${sideNames.code ?? sideNames.name}, ${count(sideSurvey.responseCount, "responses")}`}
          />
          <Drawer
            open={side?.kind === "peek"}
            onClose={() => setSide(null)}
            title={sideNames.code ?? sideNames.name}
            sub={
              sideNames.code
                ? `${sideNames.name}${sideSurvey.versionNumber ? `, ${ut("ant.versionN").replace("{n}", String(sideSurvey.versionNumber))}` : ""}`
                : undefined
            }
            icon={<ShellIcon name="clipboard-list" />}
            footer={
              <>
                <ButtonLink to={sideSurvey.status === "draft" ? `/constructor/${sideSurvey.id}` : `/surveys/${sideSurvey.id}`} variant="primary">
                  <Ic.external size={15} />
                  {sideSurvey.status === "draft" ? ut("cl.editAction") : ut("mc.openMethod")}
                </ButtonLink>
                {canAssign(sideSurvey) ? (
                  <Button variant="secondary" icon={<Mi.clipboardPlus />} onClick={() => setSide({ kind: "assign", survey: sideSurvey })}>
                    {ut("acc.grant")}
                  </Button>
                ) : null}
              </>
            }
          >
            <PeekBody
              s={sideSurvey}
              groupTitle={sideSurvey.groupId ? (groupById.get(sideSurvey.groupId)?.title ?? null) : null}
              folderTitle={sideSurvey.folderId ? (folderById.get(sideSurvey.folderId)?.title ?? null) : null}
              qa={qa}
            />
          </Drawer>
        </>
      ) : null}

      {/*
        «Призначити» отмеченным: каждому выбранному человеку — каждая методика
        (повтор выдачи только переставляет срок, routes/access.ts), группе — так
        же по одной методике. Смонтирован, пока есть что назначать: закрытый с
        набранными людьми ящик остаётся черновиком и открывается снова.
      */}
      {assignOpen ? (
        <AssignDrawer
          choose="recipients"
          open={assignMany}
          onClose={() => setAssignMany(false)}
          onReturn={() => setAssignMany(true)}
          title={
            assignable.length === 1
              ? ut("mc.assignTitle").replace("{code}", splitCode(assignable[0]!.title).code ?? splitCode(assignable[0]!.title).name)
              : ut("mc.assignManyTitle").replace("{what}", count(assignable.length, "methods"))
          }
          sub={codesLine(assignable, ut("mc.andMore"))}
          note={
            assignable.length < pickedRows.length
              ? ut("mc.assignManySkipped").replace("{n}", String(pickedRows.length - assignable.length))
              : undefined
          }
          draftName={ut("mc.assignManyDraft")}
          assignOne={(userId, due, note) =>
            assignEachSurvey(`u:${userId}|${due ?? ""}|${note ?? ""}`, (s) => api.grant(s.id, userId, note ?? undefined, due))
          }
          assignGroup={async (groupId, due, note) => {
            const target = `g:${groupId}|${due ?? ""}|${note ?? ""}`;
            /* сколько людей получило — и от прошлой попытки: повтор выдаёт только оставшиеся методики */
            const { recipients } = assigned.current;
            await assignEachSurvey(target, async (s) => {
              const res = await api.assignSurveyToPatientGroup(groupId, { surveyId: s.id, expiresAt: due, note });
              recipients.set(target, Math.max(recipients.get(target) ?? 0, res.recipients));
            });
            // дошло всё — операция для группы закончена: число отдаётся и забывается
            const n = recipients.get(target) ?? 0;
            recipients.delete(target);
            return { recipients: n };
          }}
          onAssigned={() => undefined}
        />
      ) : null}

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
            reloadAll();
          }}
        />
      ) : null}
      {dialog?.kind === "archive" ? (
        <ArchiveDialog
          survey={dialog.survey}
          onClose={() => setDialog(null)}
          onDone={() => {
            unpick([dialog.survey]);
            setDialog(null);
            setSide(null);
            reloadAll();
          }}
        />
      ) : null}
      {dialog?.kind === "moveMany" && pickedRows.length ? (
        <MoveManyForm
          surveys={pickedRows}
          folders={folders}
          groups={groups}
          onClose={() => setDialog(null)}
          onMoved={(moved) => {
            unpick(moved);
            reloadAll();
          }}
        />
      ) : null}
      {dialog?.kind === "archiveMany" && pickedRows.length ? (
        <ArchiveManyDialog
          surveys={pickedRows}
          onClose={() => setDialog(null)}
          onDone={(archived) => {
            unpick(archived);
            setSide(null);
            reloadAll();
          }}
        />
      ) : null}
    </Page>
  );
}
