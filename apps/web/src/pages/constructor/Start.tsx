import { useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  contentLangFor,
  type Administration,
  type ContentLang,
  type Issue,
  type SurveyGroupWithCounts,
  type SurveyListItem,
} from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { Callout, Ic, KV, Loading, useToast } from "../../ui";
import { cx } from "../../ui/cx";
import { IconTile, Page, Panel } from "../../ui/layout";
import { Button, ButtonLink, ErrorText, Field, Input, Segmented, Select, SeverityTag, Tag } from "../../ui/primitives";
import { ShellIcon } from "../../shell/icons";
import { BulkPaste, type PasteKind } from "./BulkPaste";
import { folderOptions } from "./catalogue";
import { Labeled } from "./fields";
import { CnIc } from "./icons";
import { EMPTY, createTarget, defaultAnswers, draftKey, switchMode, type Draft, type DraftQuestion } from "./model";

/*
 * Старт новой методики (макеты methods-new и methods-bulk-paste-dialog).
 *
 * Шесть способов начать на макете; здесь пять — те, что умеет приложение:
 *
 *   конкретный тест  — общий набор ответов и шкалы с таблицей баллов;
 *   комплексный тест — у каждого пункта свои ответы с баллом, итог — сумма;
 *   импорт из файла  — JSON экспорта методики (POST /api/surveys/import);
 *   вставка текстом  — пункты пособия по одному на строку (ящик BulkPaste);
 *   копия методики   — из своего каталога (POST /api/surveys/:id/duplicate).
 *
 * «З бібліотеки» макета не заведено: общий каталог стандартных методик
 * (apps/api/src/instruments/catalog.ts) ставится на выкате целиком, и
 * «методик, которых ещё нет в вашем каталоге» у учреждения не бывает —
 * все они уже в каталоге, и копия делает то же, что делал бы выбор из
 * библиотеки. Список библиотеки на макете отдан под каталог для копии.
 *
 * Конкретный, комплексный и вставка не пишут на сервер ничего: черновик
 * уходит в конструктор (/constructor/new) состоянием перехода и живёт в
 * автосохранении, пока его не создадут. Импорт и копия создают черновик на
 * сервере сразу — так они устроены — и ведут в его конструктор.
 */

type StartKind = "specific" | "complex" | "import" | "paste" | "copy";

/** Что передаёт старт конструктору новой методики (location.state) */
export interface ConstructorSeed {
  seed?: Draft;
  editLang?: ContentLang;
}

const STARTS: { key: StartKind; icon: ReactNode }[] = [
  { key: "specific", icon: <ShellIcon name="list-checks" size={18} /> },
  { key: "complex", icon: <CnIc.calculator size={18} /> },
  { key: "copy", icon: <CnIc.copy size={18} /> },
  { key: "import", icon: <CnIc.fileJson size={18} /> },
  { key: "paste", icon: <CnIc.paste size={18} /> },
];

export function NewMethod() {
  const { ut, lang } = useLang();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const target = useMemo(() => createTarget(location.search), [location.search]);

  const [start, setStart] = useState<StartKind>("specific");
  const [groupId, setGroupId] = useState<string | null>(target.groupId);
  const [folderId, setFolderId] = useState<string | null>(target.folderId);
  const [textLang, setTextLang] = useState<ContentLang>(contentLangFor(lang));
  const [administration, setAdministration] = useState<Administration>("self");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [source, setSource] = useState<SurveyListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importIssues, setImportIssues] = useState<Issue[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const groups = useResource(() => api.groups(), []);
  const folders = useResource(() => api.surveyFolders(), []);
  const living = (groups.data ?? []).filter((g) => !g.archivedAt || g.id === groupId);
  const groupTitle = (id: string | null) => (id ? (groups.data ?? []).find((g) => g.id === id)?.title : null) ?? null;
  const folderList = groupId ? folderOptions(folders.data ?? [], groupId) : [];

  const backTo = target.folderId ? `/surveys?folder=${encodeURIComponent(target.folderId)}` : "/surveys";

  /*
   * Несохранённая новая методика в автосохранении — её не теряем: старт
   * предлагает вернуться к ней, а не молча начинает новую поверх.
   */
  const autosaveKey = draftKey(user?.id, undefined);
  const [kept, setKept] = useState<{ title: string } | null>(() => readKept(autosaveKey));

  const choose = (next: StartKind) => {
    setStart(next);
    setError(null);
    setImportIssues(null);
    if (next === "paste") setPasteOpen(true);
  };

  /** Черновик с местом и видом — в конструктор новой методики */
  const openNew = (mode: "specific" | "complex", questions: DraftQuestion[] = [], editLang: ContentLang = textLang) => {
    const base: Draft = {
      ...EMPTY,
      answers: defaultAnswers(),
      administration,
      groupId,
      folderId: groupId ? folderId : null,
    };
    const shaped = mode === "complex" ? switchMode({ ...base, mode: "specific" }, "complex") : base;
    const seed: Draft = { ...shaped, questions };
    const state: ConstructorSeed = { seed, editLang };
    navigate("/constructor/new", { state });
  };

  async function importFile(file: File) {
    setError(null);
    setImportIssues(null);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await file.text()) as Record<string, unknown>;
    } catch {
      setError(ut("cl.badJson"));
      return;
    }
    setBusy(true);
    try {
      const res = await api.importSurvey(groupId ? { ...body, groupId } : body);
      /* импорт папку не принимает — кладём в неё отдельным переносом, как каталог */
      if (groupId && folderId) await api.moveSurvey(res.id, folderId).catch(() => null);
      toast(ut("cl.imported"), "ok");
      const state: ConstructorSeed = { editLang: textLang };
      navigate(`/constructor/${res.id}`, { state });
    } catch (e) {
      // 422: сервер вернул список структурных проблем — показываем целиком, чинить файл
      const issues = (e as { body?: { issues?: Issue[] } }).body?.issues;
      if (issues) setImportIssues(issues);
      setError(e instanceof Error ? e.message : ut("cl.importFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const made = await api.duplicateSurvey(source.id);
      /*
       * Копия ложится рядом с оригиналом (так её кладёт сервер). Выбранное
       * в «Куди створити» доводится отдельными шагами: группа — правкой
       * настроек (версию она не создаёт), папка — переносом каталога.
       */
      const sameGroup = (groupId ?? null) === (source.groupId ?? null);
      if (!sameGroup) await api.updateSurvey(made.id, { groupId });
      const landed = sameGroup ? (source.folderId ?? null) : null;
      if (groupId && (folderId ?? null) !== landed) await api.moveSurvey(made.id, folderId ?? null);
      toast(ut("cst.copied"), "ok");
      const state: ConstructorSeed = { editLang: textLang };
      navigate(`/constructor/${made.id}`, { state });
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("cst.copyFailed"));
    } finally {
      setBusy(false);
    }
  }

  const pickSource = (s: SurveyListItem) => {
    setSource(s);
    /* место копии по умолчанию — рядом с оригиналом */
    setGroupId(s.groupId ?? null);
    setFolderId(s.folderId ?? null);
  };

  const primary = (() => {
    switch (start) {
      case "specific":
        return { label: ut("cst.createDraft"), icon: <Ic.plus />, run: () => openNew("specific"), off: false };
      case "complex":
        return { label: ut("cst.createDraft"), icon: <Ic.plus />, run: () => openNew("complex"), off: false };
      case "paste":
        return { label: ut("co.bulkPaste"), icon: <CnIc.paste />, run: () => setPasteOpen(true), off: false };
      case "import":
        return { label: ut("cst.pickFile"), icon: <CnIc.upload />, run: () => fileRef.current?.click(), off: busy };
      case "copy":
        return {
          label: source ? `${ut("cst.makeCopy")} «${source.title}»` : ut("cst.pickSource"),
          icon: <CnIc.copy />,
          run: () => void copy(),
          off: busy || !source,
        };
    }
  })();

  const groupNote = groupId ? `${ut("cst.draftInGroup")} «${groupTitle(groupId) ?? ""}»` : ut("cst.draftNoGroup");

  return (
    <Page
      title={ut("cst.title")}
      meta={[ut("cst.createdAsDraft"), ut("cst.noPatientSees")]}
      back={{ to: backTo, label: ut("cn.backToCatalogue") }}
      actions={
        <ButtonLink variant="ghost" to={backTo} className="gap-1.5">
          <Ic.x size={15} />
          {ut("common.cancel")}
        </ButtonLink>
      }
    >
      {kept ? (
        <Callout
          kind="violet"
          className="mb-4"
          title={kept.title ? `${ut("cst.unsaved")} «${kept.title}»` : ut("cst.unsaved")}
          actions={
            <>
              <ButtonLink variant="primary" size="xs" to="/constructor/new">
                {ut("cst.continue")}
              </ButtonLink>
              <Button
                size="xs"
                variant="quiet"
                onClick={() => {
                  if (autosaveKey) forget(autosaveKey);
                  setKept(null);
                }}
              >
                {ut("co.discardDraft")}
              </Button>
            </>
          }
        >
          {ut("cst.unsavedHint")}
        </Callout>
      ) : null}

      <div role="radiogroup" aria-label={ut("cst.howToStart")} className="mb-4 grid grid-cols-3 gap-2.5 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
        {STARTS.map((s) => (
          <StartCard
            key={s.key}
            kind={s.key}
            icon={s.icon}
            checked={start === s.key}
            onChoose={() => choose(s.key)}
          />
        ))}
      </div>

      {start === "copy" ? <CopySource picked={source} onPick={pickSource} groups={groups.data} /> : null}

      {importIssues?.length ? (
        <Callout kind="warn" className="mb-4" title={ut("cst.importIssues")}>
          <ul className="m-0 mt-1 list-none p-0">
            {importIssues.map((i, k) => (
              <li key={k}>
                <b className="font-bold text-text">{i.where}:</b> {i.message}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <Panel
        title={ut("cst.where")}
        icon={<CnIc.folderPlus />}
        footer={
          <>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-small text-muted">
              <Ic.info size={14} />
              {start === "copy" ? ut("cst.copyWhereHint") : ut("cst.whereHint")}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {error ? <ErrorText>{error}</ErrorText> : null}
              <Button variant="primary" icon={primary.icon} disabled={primary.off} onClick={primary.run}>
                {primary.label}
              </Button>
            </span>
          </>
        }
      >
        <div className="grid grid-cols-4 items-start gap-x-3.5 max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1 [&>[data-field]]:mb-0">
          <Field
            label={ut("cst.group")}
            error={groups.error ? `${ut("net.loadFailed")}: ${groups.error}` : undefined}
          >
            <Select
              value={groupId ?? ""}
              disabled={!groups.data}
              onChange={(e) => {
                setGroupId(e.target.value || null);
                setFolderId(null);
              }}
            >
              <option value="">{ut("sel.noGroup")}</option>
              {living.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={ut("cst.folder")}>
            <Select value={folderId ?? ""} disabled={!groupId || !folders.data} onChange={(e) => setFolderId(e.target.value || null)}>
              <option value="">{ut("cat.rootOption")}</option>
              {folderList.map((o) => (
                <option key={o.id} value={o.id}>
                  {/* отступ глубины — длинным тире: пробелы селект схлопывает */}
                  {"— ".repeat(o.depth)}
                  {o.title}
                </option>
              ))}
            </Select>
          </Field>
          <Labeled label={ut("cn.editLang")}>
            <Segmented
              wide
              label={ut("cn.editLang")}
              value={textLang}
              onChange={setTextLang}
              items={[
                { key: "uk", label: ut("ce.langUk") },
                { key: "ru", label: ut("ce.langRu") },
              ]}
            />
          </Labeled>
          {start === "import" || start === "copy" ? (
            <Field label={ut("cb.whoFills")}>
              <Select value="" disabled onChange={() => {}}>
                <option value="">{start === "import" ? ut("cst.fromFile") : ut("cst.asOriginal")}</option>
              </Select>
            </Field>
          ) : (
            <Field label={ut("cb.whoFills")}>
              <Select value={administration} onChange={(e) => setAdministration(e.target.value as Administration)}>
                <option value="self">{ut("cb.selfAdmin")}</option>
                <option value="clinician">{ut("cb.clinicianAdmin")}</option>
                <option value="informant">{ut("cb.informantAdmin")}</option>
              </Select>
            </Field>
          )}
        </div>
      </Panel>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-label={ut("cst.pickFile")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importFile(file);
        }}
      />

      <BulkPaste
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        onReturn={() => setPasteOpen(true)}
        sub={ut("cst.pasteSub")}
        note={groupNote}
        applyLabel={ut("cst.createDraft")}
        defaultLang={textLang}
        onApply={(questions, kind: PasteKind) => {
          /* язык вставленного текста — и язык правки: пункты лягут в него, и показать их надо в нём */
          openNew(kind.type === "yesno" ? "specific" : "complex", questions, kind.lang);
        }}
      />
    </Page>
  );
}

/** Карточка способа начать: радио, квадрат значка, заголовок и пояснение (.starts .rd макета) */
function StartCard({
  kind,
  icon,
  checked,
  onChoose,
}: {
  kind: StartKind;
  icon: ReactNode;
  checked: boolean;
  onChoose: () => void;
}) {
  const { ut } = useLang();
  return (
    <label
      className={cx(
        "m-0 flex cursor-pointer items-start gap-3 rounded-panel py-3.5 pl-3 pr-3.5",
        "transition-[background-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease)]",
        checked ? "bg-violet-tint shadow-[inset_0_0_0_1.5px_var(--vring)]" : "bg-sunk hover:bg-sunk-2",
      )}
    >
      <input
        type="radio"
        name="cst-start"
        value={kind}
        checked={checked}
        onChange={onChoose}
        /* повторный выбор вставки снова открывает ящик: change на выбранном радио не приходит */
        onClick={() => {
          if (checked && kind === "paste") onChoose();
        }}
        className="kit-radio mt-[9px]"
      />
      <span
        aria-hidden
        className={cx(
          "inline-grid size-9 shrink-0 place-items-center rounded-[11px]",
          checked ? "bg-violet text-onfill" : "bg-panel text-violet-ink",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <b className={cx("block text-[14px] font-extrabold leading-5", checked ? "text-violet-ink" : "text-text")}>
          {ut(`cst.start.${kind}`)}
        </b>
        <small className="mt-[3px] block text-small leading-[18px] text-text-2">{ut(`cst.startSub.${kind}`)}</small>
      </span>
    </label>
  );
}

/**
 * Каталог для копии — на месте «Бібліотеки стандартних методик» макета:
 * поиск и список слева, сведения о выбранной справа. Список — свои
 * методики, без снятых: копию делают с того, что в работе.
 */
function CopySource({
  picked,
  onPick,
  groups,
}: {
  picked: SurveyListItem | null;
  onPick: (s: SurveyListItem) => void;
  groups: SurveyGroupWithCounts[] | null;
}) {
  const { ut } = useLang();
  const list = useResource(() => api.surveys(), []);
  const [q, setQ] = useState("");
  const all = list.data ?? [];
  const needle = q.trim().toLowerCase();
  const shown = needle ? all.filter((s) => s.title.toLowerCase().includes(needle)) : all;
  const groupTitle = (id: string | null) => (id ? groups?.find((g) => g.id === id)?.title : null) ?? ut("ce.noGroup");

  return (
    <Panel
      title={ut("cst.copyTitle")}
      icon={<CnIc.copy />}
      sub={list.data ? `${ut("cst.inCatalogue")}: ${all.length}` : undefined}
      flush
      className="mb-4"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_420px] max-[1180px]:grid-cols-[minmax(0,1fr)_340px] max-[900px]:grid-cols-1">
        <div className="min-w-0 border-r border-divider max-[900px]:border-r-0">
          <div className="px-4 pb-3">
            <Input
              look="fill"
              type="search"
              icon={<Ic.search />}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={ut("cst.searchCatalogue")}
              aria-label={ut("cst.searchCatalogue")}
            />
          </div>
          {list.error ? (
            <div className="px-4 pb-4">
              <Loading bare error={list.error} onRetry={list.reload} />
            </div>
          ) : !list.data ? (
            <div className="px-4 pb-4">
              <Loading bare rows={4} />
            </div>
          ) : (
            <ul className="m-0 max-h-[420px] list-none overflow-y-auto p-0" aria-label={ut("cst.copyTitle")}>
              {shown.map((s) => {
                const on = picked?.id === s.id;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => onPick(s)}
                      className={cx(
                        "grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border-0 border-t border-divider px-4 py-2.5 text-left",
                        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-ring",
                        on ? "bg-violet-tint" : "bg-transparent hover:bg-panel-2",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <b className={cx("truncate text-body font-bold", on ? "text-violet-ink" : "text-text")}>{s.title}</b>
                          {s.rightsStatus === "licensed" ? (
                            <Tag tone="attention">{ut("cst.rights.licensed")}</Tag>
                          ) : null}
                        </span>
                        <small className="block truncate text-caption text-muted">
                          {groupTitle(s.groupId)}, {ut("cst.itemsShort")}: {s.questionCount}
                        </small>
                      </span>
                      <Tag tone={s.status === "published" ? "good" : "plain"}>
                        {s.status === "published" ? ut("ce.published") : ut("ce.draft")}
                      </Tag>
                    </button>
                  </li>
                );
              })}
              {shown.length === 0 ? <li className="border-t border-divider px-4 py-3 text-small text-muted">{ut("cst.nothingFound")}</li> : null}
            </ul>
          )}
          <div className="flex items-center border-t border-divider px-4 py-2.5 text-small text-muted">
            {list.data ? `${shown.length} ${ut("ce.of")} ${all.length}` : null}
          </div>
        </div>
        <div className="min-w-0 px-[18px] pb-[18px] pt-1 max-[900px]:border-t max-[900px]:border-divider max-[900px]:pt-4">
          {picked ? <SourcePeek id={picked.id} /> : <p className="m-0 text-small text-muted">{ut("cst.pickSourceHint")}</p>}
        </div>
      </div>
    </Panel>
  );
}

/** Сведения о методике, с которой снимут копию: объём, шкалы, полосы первой шкалы, первые пункты */
function SourcePeek({ id }: { id: string }) {
  const { ut } = useLang();
  const s = useResource(() => api.survey(id), [id]);
  if (s.error) return <Loading bare error={s.error} onRetry={s.reload} />;
  if (!s.data) return <Loading bare rows={4} />;
  const m = s.data;
  const asked = m.questions.filter((x) => x.type !== "info");
  const first = m.scales[0];
  return (
    <div>
      <div className="flex items-start gap-3">
        <IconTile icon={<CnIc.copy size={18} />} size={40} />
        <div className="min-w-0">
          <h3 className="m-0 text-lead font-extrabold leading-6 tracking-[-0.015em] text-text">{m.title}</h3>
          {m.description ? <p className="m-0 mt-1 line-clamp-3 text-small text-text-2">{m.description}</p> : null}
        </div>
      </div>
      <KV
        className="mt-4"
        w={110}
        rows={[
          [ut("cst.volume"), `${ut("cst.itemsShort")}: ${asked.length}`],
          [ut("cst.scoring"), m.scales.length ? `${ut("cst.scalesShort")}: ${m.scales.length}` : ut("cst.noScoring")],
          [ut("cb.whoFills"), ut(m.administration === "self" ? "cb.selfAdmin" : m.administration === "clinician" ? "cb.clinicianAdmin" : "cb.informantAdmin")],
          [ut("ce.version"), String(m.versionNumber)],
          ...(m.rightsStatus ? [[ut("cst.rights"), ut(`cst.rights.${m.rightsStatus}`)] as [string, string]] : []),
        ]}
      />
      {first?.bands.length ? (
        <>
          <div className="mb-2 mt-4 text-caption font-bold text-muted">{ut("cst.bands")}</div>
          <div className="flex flex-col gap-1.5">
            {first.bands.map((b, k) => (
              <div key={k} className="flex min-w-0 items-center gap-2">
                <b className="w-[52px] shrink-0 text-small font-bold tabular-nums text-text">
                  {b.minScore}–{b.maxScore}
                </b>
                <SeverityTag level={b.severity} small className="min-w-0 truncate">
                  {b.label}
                </SeverityTag>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {asked.length ? (
        <>
          <div className="mb-2 mt-4 text-caption font-bold text-muted">{ut("cst.firstItems")}</div>
          <ol className="m-0 flex list-none flex-col gap-1 p-0 text-small text-text-2">
            {asked.slice(0, 2).map((x, k) => (
              <li key={x.id} className="flex gap-2">
                <b className="text-muted">{k + 1}</b>
                <span className="min-w-0">{x.title}</span>
              </li>
            ))}
            {asked.length > 2 ? <li className="text-muted">{`${ut("cst.andMore")} ${asked.length - 2}`}</li> : null}
          </ol>
        </>
      ) : null}
    </div>
  );
}

/** Название несохранённой новой методики из автосохранения; null — его нет */
function readKept(key: string | null): { title: string } | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    const t = d.title ?? {};
    return { title: (t.uk || t.ru || "").trim() };
  } catch {
    return null;
  }
}

function forget(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* хранилище закрыто — забывать нечего */
  }
}
