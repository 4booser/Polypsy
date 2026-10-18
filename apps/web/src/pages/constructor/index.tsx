import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { contentLangFor, type ContentLang, type Issue, type SurveyStatus } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { day, timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { useResource } from "../../useResource";
import { ShellIcon } from "../../shell/icons";
import { Callout, Ic, Loading, Tooltip, useToast } from "../../ui";
import { Count, Page, Panel } from "../../ui/layout";
import { ActionMenu, type MenuEntry } from "../../ui/menu";
import { Button, ErrorText, Textarea } from "../../ui/primitives";
import { AssignGroup } from "./AssignGroup";
import { MainSection, Settings } from "./Basics";
import { BulkPaste } from "./BulkPaste";
import { CheckDrawer, HistoryDrawer, issueTarget } from "./Check";
import { VersionConflict, saveThenPublish } from "./Conflict";
import { EditLangProvider } from "./fields";
import { CnIc } from "./icons";
import {
  EMPTY,
  createTarget,
  defaultAnswers,
  draftKey,
  moveQuestion,
  newUid,
  normalizeDraft,
  oneAtATime,
  removeQuestion,
  reorderQuestion,
  sharedOptions,
  switchMode,
  toDraft,
  toPayload,
  type Draft,
  type Mode,
} from "./model";
import { Preview } from "./Preview";
import { Questions, type Section } from "./Questions";
import { Answers, BandsSection, Scales, ScalesSummary } from "./Scales";
import { NewMethod, type ConstructorSeed } from "./Start";
import { editorShortcut } from "./shortcuts";
import { Structure } from "./Structure";

/*
 * Конструктор методики (макеты methods-new и methods-constructor).
 *
 *   /constructor          — старт новой методики: пять способов начать и
 *                           «куди створити» (Start.tsx);
 *   /constructor/new      — правка новой, ещё не сохранённой методики;
 *   /constructor/:id      — правка сохранённой.
 *
 * Правка — три колонки: «Структура» слева (разделы и пункты, Structure.tsx),
 * середина — выбранный раздел, справа — перегляд пункта и перевірка ключа
 * (Preview.tsx). Действия над методикой — в ящиках: перевірка структури,
 * історія змін, вставка пунктів, призначення групі.
 *
 * Граница прав: «Опублікувати» требует surveys.publish, «Створити» и
 * «Зберегти» — только surveys.edit. Поэтому кнопок две; у опубликованной
 * методики сохранение и есть публикация новой версии (сервер делает её
 * действующей сразу), и кнопка называет это прямо.
 */
export default function Constructor() {
  const { id } = useParams<{ id: string }>();
  const { pathname } = useLocation();
  if (!id && !pathname.startsWith("/constructor/new")) return <NewMethod />;
  return <Editor key={id ?? "new"} id={id} />;
}

/**
 * Показать раскрытый пункт в области прокрутки страницы.
 *
 * Не scrollIntoView: тот прокручивает каждого предка, в том числе рамку с
 * overflow: hidden, — и полоса приложения уезжала из окна вверх, оставляя
 * пустоту снизу. Здесь прокручивается только ближайшая область с
 * собственной прокруткой (содержимое Page).
 */
function reveal(id: string): void {
  requestAnimationFrame(() => {
    const el = document.getElementById(id)?.closest("section");
    if (!el) return;
    let box = el.parentElement;
    while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    if (!box) return;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
    box.scrollTo({ top, behavior: "smooth" });
  });
}

interface Saved {
  status: SurveyStatus;
  version: number;
  versionId: string | null;
  folderId: string | null;
}

function Editor({ id }: { id?: string }) {
  const { ut, lang } = useLang();
  const toast = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  /* автосохранение — своё у каждой учётки: чужой черновик здесь не восстанавливается (#176, model.ts) */
  const { user } = useAuth();
  const autosaveKey = draftKey(user?.id, id);
  const forgetAutosave = () => {
    try {
      if (autosaveKey) localStorage.removeItem(autosaveKey);
    } catch {
      /* хранилище закрыто — забывать нечего */
    }
  };
  /* что принёс старт новой методики: черновик и язык текста (Start.tsx) */
  const fromStart = (location.state ?? null) as ConstructorSeed | null;

  const [draft, setDraftRaw] = useState<Draft>(EMPTY);
  const [restored, setRestored] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  /*
   * Undo/redo: стек снапшотов. Пишется на каждое изменение черновика —
   * дёшево (structured clone маленького объекта), а отмена случайного
   * «Видалити» на большой методике бесценна.
   */
  const undoStack = useRef<Draft[]>([]);
  const redoStack = useRef<Draft[]>([]);

  const setDraft = useCallback((next: Draft | ((d: Draft) => Draft)) => {
    setDraftRaw((prev) => {
      const value = typeof next === "function" ? (next as (d: Draft) => Draft)(prev) : next;
      if (value !== prev) {
        undoStack.current.push(prev);
        if (undoStack.current.length > 50) undoStack.current.shift();
        redoStack.current = [];
        setDirty(true);
      }
      return value;
    });
  }, []);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    setDraftRaw((cur) => {
      redoStack.current.push(cur);
      return prev;
    });
  }, []);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    setDraftRaw((cur) => {
      undoStack.current.push(cur);
      return next;
    });
  }, []);

  /*
   * Группы — для настроек. Отказ не превращается в пустой список: пустой
   * показывал группу методики как «Без групи», хотя она в группе (Basics.tsx).
   */
  const groups = useResource(() => api.groups(), []);
  const [section, setSection] = useState<Section>(id ? "questions" : "main");
  const [open, setOpen] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  /* отказ 409: методику сохранили раньше нас — объяснение и выбор вместо строки ошибки (Conflict.tsx) */
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!id);
  const [drawer, setDrawer] = useState<null | "check" | "history" | "assign" | "paste">(null);
  /*
   * Язык, на котором правится текст теста, — не язык консоли. Начинается с
   * него (или с выбранного на старте), но переключается отдельно: специалист
   * с русской консолью вписывает украинский текст методики. Английская
   * консоль начинает с украинского: английского текста у методик нет.
   */
  const [editLang, setEditLang] = useState<ContentLang>(fromStart?.editLang ?? contentLangFor(lang));
  /* состояние сохранённой методики: статус, версия, папка — для шапки и кнопок */
  const [saved, setSaved] = useState<Saved | null>(null);
  const published = saved?.status === "published";

  /* куда заводить тест: «+ → Новий тест» из папки каталога */
  const target = useMemo(() => createTarget(location.search), [location.search]);

  /*
   * Методика с сервера — загрузкой, но черновик из неё заливается только по
   * явной просьбе: при открытии и по «перечитати з сервера» / «відкинути
   * чернетку». Черновик — живая правка человека, и перезалить его ответом,
   * пришедшим сам собой, значит стереть работу. Поэтому ответ сам не
   * перечитывается (manual), а каждая просьба — свой ключ (`ask`).
   */
  const [ask, setAsk] = useState<{ id: string; n: number } | null>(null);
  const server = useResource(() => api.surveyRaw(ask!.id), [ask?.id, ask?.n], {
    enabled: !!ask,
    manual: true,
    keep: false,
  });
  const seeded = useRef<typeof ask>(null);
  useEffect(() => {
    if (!ask || !server.data || seeded.current === ask) return;
    seeded.current = ask;
    setDraftRaw(toDraft(server.data, []));
    setLoaded(true);
  }, [ask, server.data]);
  /* статус и версия — из ответа сервера всегда, даже когда черновик восстановлен из автосохранения */
  const [meta, setMeta] = useState<{ id: string; n: number } | null>(null);
  const info = useResource(() => api.surveyRaw(id!), [id, meta?.n], { enabled: !!id, manual: true });
  useEffect(() => {
    if (!info.data) return;
    setSaved({
      status: info.data.status,
      version: info.data.versionNumber,
      versionId: info.data.versionId,
      folderId: info.data.folderId,
    });
  }, [info.data]);
  const loadError = server.error ?? (!loaded && info.error ? info.error : null);
  const askServer = () => {
    if (id) setAsk((prev) => ({ id, n: (prev?.n ?? 0) + 1 }));
  };

  useEffect(() => {
    /* старт новой методики принёс черновик — он и есть намерение, автосейв прежней новой уступает */
    if (!id && fromStart?.seed) {
      setDraftRaw(normalizeDraft({ ...EMPTY, ...fromStart.seed }));
      setDirty(true);
      setLoaded(true);
      // из истории — прочь: перезагрузка вкладки должна поднять автосейв, а не исходный черновик старта
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
      return;
    }
    // сначала автосейв: несохранённая работа важнее серверной версии
    let kept: string | null = null;
    try {
      kept = autosaveKey ? localStorage.getItem(autosaveKey) : null;
    } catch {
      kept = null;
    }
    if (kept) {
      try {
        const parsed = normalizeDraft({ ...EMPTY, ...(JSON.parse(kept) as Draft) });
        /*
         * Папка и группа — из адреса, если он их несёт: человек только что
         * пришёл из этой папки, и его намерение новее сохранённого черновика.
         */
        setDraftRaw(!id && target.groupId ? { ...parsed, groupId: target.groupId, folderId: target.folderId } : parsed);
        setRestored(true);
        setLoaded(true);
        setAsk(null);
        return;
      } catch {
        forgetAutosave();
      }
    }

    if (!id) {
      setDraftRaw({ ...EMPTY, answers: defaultAnswers(), groupId: target.groupId, folderId: target.folderId });
      setAsk(null);
      return;
    }
    // номер просьбы растёт и здесь: вернулись к той же методике — спрашиваем заново, а не берём минутный кэш
    askServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, autosaveKey]);

  // автосейв с дебаунсом: каждое нажатие клавиши не должно дёргать диск
  useEffect(() => {
    if (!dirty || !autosaveKey) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(autosaveKey, JSON.stringify(draft));
        setSavedAt(new Date().toISOString());
      } catch {
        /* хранилище закрыто или полно — правка живёт в памяти вкладки */
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [draft, dirty, autosaveKey]);

  // несохранённые правки: предупредить при закрытии вкладки
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  /*
   * Проверка структуры — сама, после паузы в правке: число замечаний стоит на
   * кнопке, точки — у разделов и пунктов. Тот же маршрут, что и по кнопке
   * (POST /api/surveys/validate, тот же validateSurvey, что держит публикацию);
   * ответ на устаревший черновик отбрасывается по номеру просьбы.
   */
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const checkSeq = useRef(0);
  const runCheck = useCallback(
    async (d: Draft) => {
      const seq = ++checkSeq.current;
      setChecking(true);
      try {
        const res = await api.validateSurvey(toPayload(d));
        if (seq === checkSeq.current) {
          setIssues(res.issues);
          setCheckError(null);
        }
      } catch (e) {
        if (seq === checkSeq.current) setCheckError(e instanceof Error ? e.message : ut("co.checkFailed"));
      } finally {
        if (seq === checkSeq.current) setChecking(false);
      }
    },
    [ut],
  );
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => void runCheck(draft), 1200);
    return () => clearTimeout(timer);
  }, [draft, loaded, runCheck]);

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const mode: Mode = draft.mode ?? "specific";
  const text = (v: Record<string, string> | null | undefined) => v?.[editLang] || v?.uk || v?.ru || "";

  /* одно сохранение за раз — и для кнопок, и для Ctrl+S (model.ts, oneAtATime) */
  const saving = useRef({ busy: false });

  function save(publish: boolean) {
    return oneAtATime(saving.current, async () => {
      setBusy(true);
      setError(null);
      setConflict(null);
      try {
        const payload = toPayload(draft);
        /*
         * Папка уходит только при заведении: правка методики папку не меняет,
         * для переноса есть свой маршрут (PUT /api/surveys/:id/folder).
         * baseVersionId — только правке: при заведении сверяться не с чем.
         */
        const { baseVersionId, ...content } = payload;
        const outcome = await saveThenPublish(
          () =>
            id
              ? api.updateSurvey(id, {
                  ...content,
                  ...(baseVersionId ? { baseVersionId } : {}),
                  versionNote: ut("co.versionNote"),
                })
              : api.createSurvey({ ...content, folderId: draft.folderId ?? undefined }),
          publish ? (surveyId) => api.updateSurvey(surveyId, { status: "published" }) : null,
          ut("co.saveFailed"),
        );
        if (outcome.kind === "conflict") {
          setConflict(outcome.message);
          return;
        }
        if (outcome.kind === "error") {
          setError(outcome.message);
          return;
        }
        /*
         * Записано — значит записано, даже если публикация отказала: автосейв
         * стирается, экран уходит к методике. Остаться здесь значило бы, что
         * следующее «Створити» заведёт вторую такую же (Conflict.tsx).
         * Отказ публикации — сообщением: оно переживает переход.
         */
        forgetAutosave();
        setDirty(false);
        if (outcome.publishError) toast(`${ut("uit.co.savedNotPublished")}: ${outcome.publishError}`, "err");
        navigate(`/surveys/${outcome.id}`);
      } finally {
        setBusy(false);
      }
    });
  }

  // Ctrl+S — черновик, Ctrl+Z/Ctrl+Shift+Z — отмена/возврат; по клавише, а не по знаку раскладки (shortcuts.ts)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const shortcut = editorShortcut(e);
      if (!shortcut) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (shortcut === "save") {
        e.preventDefault();
        void save(false);
        return;
      }
      // в полях ввода браузерная отмена полезнее нашей
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      if (shortcut === "undo") undo();
      else redo();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, undo, redo]);

  /*
   * Перечитать методику с сервера — со свежей версией и её versionId: свои
   * правки при этом уходят (и из автосейва тоже), поэтому рядом есть
   * «показать мои правки».
   */
  function reloadFromServer() {
    if (!id) return;
    forgetAutosave();
    setRestored(false);
    setDirty(false);
    setConflict(null);
    undoStack.current = [];
    askServer();
    setMeta((m) => ({ id, n: (m?.n ?? 0) + 1 }));
  }

  function discardDraft() {
    forgetAutosave();
    setRestored(false);
    setDirty(false);
    undoStack.current = [];
    if (id) askServer();
    else setDraftRaw({ ...EMPTY, answers: defaultAnswers(), groupId: target.groupId, folderId: target.folderId });
  }

  function applyJson() {
    setError(null);
    try {
      const parsed = JSON.parse(json) as Draft;
      if (!parsed.title) throw new Error(ut("co.noTitleField"));
      setDraft(normalizeDraft({ ...EMPTY, ...parsed }));
      toast(ut("ce.jsonApplied"), "ok");
    } catch (e) {
      setError(e instanceof Error ? `${ut("co.jsonParseError")}: ${e.message}` : ut("co.jsonParseError"));
    }
  }

  const goto = (s: Section) => {
    if (s === "json") setJson(JSON.stringify(draft, null, 2));
    setSection(s);
  };

  /* открыть пункт в середине и показать его: из колонки структуры, из клетки ключа, из замечания */
  const openItem = (i: number) => {
    const q = draft.questions[i];
    if (!q) return;
    setSection("questions");
    setOpen(q.uid);
    setFocused(i);
    reveal(`cn-q-${q.uid}`);
  };

  const addQuestion = () => {
    const uid = newUid();
    const at = draft.questions.length;
    setDraft((d) => ({
      ...d,
      questions: [
        ...d.questions,
        {
          uid,
          type: (d.mode ?? "specific") === "specific" ? "yesno" : "single",
          title: { uk: "", ru: "" },
          required: true,
          options: (d.mode ?? "specific") === "specific" ? sharedOptions(d.answers) : [],
        },
      ],
    }));
    setSection("questions");
    setOpen(uid);
    setFocused(at);
    reveal(`cn-q-${uid}`);
  };

  /* удаление — сразу, с «Скасувати» в сообщении: отмена надёжнее окна «ви впевнені» */
  const removeAt = (i: number) => {
    setOpen(null);
    setDraft((d) => removeQuestion(d, i));
    toast(`${ut("ce.removed")} ${i + 1}`, "info", { action: { label: ut("ce.undoAction"), onClick: undo } });
  };

  /* ── замечания проверки: по пункту, по разделу ── */
  const scaleCodes = draft.scales.map((s) => s.code);
  const located = useMemo(
    () => (issues ?? []).map((it) => ({ it, at: issueTarget(it, draft.questions.length, scaleCodes) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [issues, draft.questions.length, scaleCodes.join("\0")],
  );
  const itemIssues = useMemo(() => {
    const m = new Map<number, Issue[]>();
    for (const { it, at } of located) if (at?.kind === "item") m.set(at.n, [...(m.get(at.n) ?? []), it]);
    return m;
  }, [located]);
  const warnSections = useMemo(() => {
    const s = new Set<Section>();
    for (const { it, at } of located) {
      if (at?.kind === "scale") s.add(mode === "complex" || /band/i.test(it.code) ? "bands" : "scales");
      else s.add("questions");
    }
    return s;
  }, [located, mode]);
  const errors = (issues ?? []).filter((i) => i.level === "error").length;
  const warnings = (issues ?? []).length - errors;

  /* в комплексном тесте разделов «Відповіді» и «Шкали» нет — их работу делают «Результати» */
  const shownSection: Section = mode === "complex" && (section === "answers" || section === "scales") ? "bands" : section;

  if (loadError && !loaded) {
    return (
      <Page title={ut("cn.testTitle")} back={{ to: "/surveys", label: ut("cn.backToCatalogue") }}>
        <Loading error={loadError} onRetry={askServer} />
      </Page>
    );
  }
  if (!loaded) return <Loading rows={5} />;

  const backTo = (saved?.folderId ?? draft.folderId) ? `/surveys?folder=${encodeURIComponent((saved?.folderId ?? draft.folderId)!)}` : "/surveys";
  const name = text(draft.title);
  const versionDate = saved?.versionId && info.data ? day(info.data.updatedAt) : null;
  const nextVersion = (saved?.version ?? 0) + 1;
  const groupTitle = draft.groupId ? groups.data?.find((g) => g.id === draft.groupId)?.title : null;

  const metaLine: [string, string] = !id
    ? [ut("ce.draft"), ut("ce.newMeta")]
    : published
      ? [
          `${ut("ce.published")}, ${ut("ce.versionLower")} ${saved?.version ?? ""}`,
          `${versionDate ? `${ut("ce.changed")} ${versionDate}; ` : ""}${ut("ce.saveGoesLive")} ${nextVersion}`,
        ]
      : [
          `${ut("ce.draft")}, ${ut("ce.versionLower")} ${saved?.version ?? ""}`,
          `${versionDate ? `${ut("ce.changed")} ${versionDate}; ` : ""}${ut("ce.saveMakes")} ${nextVersion}`,
        ];

  const menu: MenuEntry[] = [
    ...(id
      ? [
          {
            key: "copy",
            label: ut("ce.copyMethod"),
            icon: <CnIc.copy size={15} />,
            onSelect: () => {
              void api
                .duplicateSurvey(id)
                .then((made) => {
                  toast(ut("cst.copied"), "ok");
                  navigate(`/constructor/${made.id}`);
                })
                .catch((e: unknown) => toast(e instanceof Error ? e.message : ut("cst.copyFailed"), "err"));
            },
          },
        ]
      : []),
    { key: "json", label: ut("cn.jsonSection"), icon: <ShellIcon name="braces" size={15} />, onSelect: () => goto("json") },
    ...(id ? [{ key: "history", label: ut("ce.history"), icon: <Ic.history size={15} />, onSelect: () => setDrawer("history") }] : []),
    ...(id && published
      ? [
          { key: "patient", label: ut("cn.assignPatient"), icon: <CnIc.userPlus size={15} />, to: `/surveys/${id}/access`, ruled: true },
          { key: "group", label: ut("cn.assignGroup"), icon: <ShellIcon name="users-round" size={15} />, onSelect: () => setDrawer("assign") },
        ]
      : []),
    ...(id
      ? [
          { key: "card", label: ut("ce.toMethod"), icon: <Ic.chart size={15} />, to: `/surveys/${id}`, ruled: true },
          { key: "reload", label: ut("co.conflictReload"), icon: <Ic.refresh size={15} />, onSelect: reloadFromServer },
        ]
      : [{ key: "back", label: ut("cn.backToCatalogue"), icon: <Ic.chevronLeft size={15} />, to: backTo, ruled: true }]),
  ];

  const publishLabel = published ? `${ut("ce.publishVersion")} ${nextVersion}` : ut("cn.publish");
  /* у опубликованной сохранение и есть публикация: сервер делает новую версию действующей сразу */
  const publishNow = () => void save(!published);
  const publishButton = (
    <Button variant="primary" icon={<CnIc.upload />} onClick={publishNow} disabled={busy}>
      {busy ? ut("co.saving") : publishLabel}
    </Button>
  );

  const content = (() => {
    switch (shownSection) {
      case "main":
        return <MainSection draft={draft} patch={patch} isNew={!id} onMode={(m) => setDraft((d) => switchMode(d, m))} />;
      case "settings":
        return <Settings draft={draft} groups={groups.data} groupsError={groups.error} patch={patch} />;
      case "answers":
        return <Answers draft={draft} setDraft={setDraft} />;
      case "scales":
        return <Scales draft={draft} setDraft={setDraft} />;
      case "bands":
        return <BandsSection draft={draft} setDraft={setDraft} />;
      case "json":
        return (
          <Panel title={ut("cn.jsonSection")} icon={<ShellIcon name="braces" />} hint={ut("co.jsonHint")}>
            <Textarea
              aria-label={ut("co.wholeJson")}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={22}
              spellCheck={false}
              className="font-mono text-caption leading-[18px]"
            />
            <div className="mt-3 flex gap-2">
              <Button variant="primary" onClick={applyJson}>
                {ut("co.apply")}
              </Button>
              <Button onClick={() => void navigator.clipboard?.writeText(json)}>{ut("co.copy")}</Button>
            </div>
          </Panel>
        );
      default:
        return (
          <div className="flex flex-col gap-2.5">
            {issues?.length ? (
              <Callout
                kind="warn"
                icon={<ShellIcon name="list-checks" />}
                title={`${ut("co.issuesSummary")}: ${errors} ${ut("co.errorsCount")}, ${warnings} ${ut("co.warningsCount")}`}
                actions={
                  <Button size="xs" onClick={() => setDrawer("check")}>
                    {ut("ce.allIssues")}
                  </Button>
                }
              >
                <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
                  {issues.slice(0, 3).map((it, k) => (
                    <li key={k}>
                      <b className="font-extrabold text-warn">{it.where}.</b> {it.message}
                    </li>
                  ))}
                </ul>
                <p className="m-0 mt-1 text-muted">{ut("co.checkHint")}</p>
              </Callout>
            ) : null}
            <Questions
              draft={draft}
              setDraft={setDraft}
              open={open}
              setOpen={setOpen}
              onFocusQuestion={setFocused}
              itemIssues={itemIssues}
              goto={goto}
              onRemove={removeAt}
              onAdd={addQuestion}
              onPaste={() => setDrawer("paste")}
            />
            {draft.questions.length ? (
              <div className="mt-1.5">
                <ScalesSummary draft={draft} setDraft={setDraft} goto={goto} />
              </div>
            ) : null}
          </div>
        );
    }
  })();

  const modeWord = mode === "specific" ? ut("ce.modeSpecific") : ut("ce.modeComplex");
  const autosaveWord = dirty
    ? savedAt
      ? `${ut("co.draftAutosaves")}, ${timeOfDay(savedAt)}`
      : ut("co.draftAutosaves")
    : id
      ? ut("ce.noChanges")
      : ut("co.draftAutosaves");

  return (
    <EditLangProvider value={editLang} onChange={setEditLang}>
      <Page
        title={name || (id ? ut("cn.testTitle") : ut("cst.title"))}
        meta={metaLine}
        back={{ to: backTo, label: ut("cn.backToCatalogue") }}
        actions={
          <>
            <Tooltip label={ut("co.undo")} kbd="Ctrl Z">
              <Button variant="quiet" size="icon" aria-label={ut("co.undo")} disabled={!undoStack.current.length} onClick={undo}>
                <CnIc.undo />
              </Button>
            </Tooltip>
            <Tooltip label={ut("co.redo")} kbd="Ctrl Shift Z">
              <Button variant="quiet" size="icon" aria-label={ut("co.redo")} disabled={!redoStack.current.length} onClick={redo}>
                <CnIc.redo />
              </Button>
            </Tooltip>
            <Button
              icon={<ShellIcon name="list-checks" />}
              aria-expanded={drawer === "check"}
              onClick={() => {
                setDrawer("check");
                void runCheck(draft);
              }}
            >
              {ut("co.checkStructure")}
              {issues?.length ? <Count n={issues.length} tone={errors ? "violet" : "tint"} /> : null}
            </Button>
            <Tooltip label={ut("ce.rename")}>
              <Button
                variant="quiet"
                size="icon"
                aria-label={ut("ce.rename")}
                onClick={() => {
                  setSection("main");
                  requestAnimationFrame(() => document.getElementById("cn-title")?.focus());
                }}
              >
                <ShellIcon name="pencil" />
              </Button>
            </Tooltip>
            <ActionMenu label={ut("cn.tools")} entries={menu} />
            {published ? null : (
              <Button onClick={() => void save(false)} disabled={busy}>
                {id ? ut("common.save") : ut("cn.create")}
              </Button>
            )}
            {publishButton}
          </>
        }
        below={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-small font-semibold text-text-2">
            <span className="inline-flex items-center gap-1.5">
              <CnIc.folder size={14} className="text-muted" />
              {groupTitle ?? ut("ce.noGroup")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CnIc.shapes size={14} className="text-muted" />
              {modeWord}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Ic.cloudCheck size={14} className="text-good" />
              {autosaveWord}
            </span>
          </div>
        }
      >
        {restored ? (
          <Callout
            kind="warn"
            className="mb-4"
            title={ut("co.draftRestored")}
            actions={
              <Button size="xs" variant="quiet" onClick={discardDraft}>
                {ut("co.discardDraft")}
              </Button>
            }
          />
        ) : null}
        {conflict ? <VersionConflict message={conflict} onReload={reloadFromServer} onShowMine={() => goto("json")} /> : null}
        {error ? <ErrorText className="mb-3">{error}</ErrorText> : null}

        <div className="grid grid-cols-[248px_minmax(0,1fr)_340px] items-start gap-4 max-[1360px]:grid-cols-[216px_minmax(0,1fr)_300px] max-[1180px]:grid-cols-[216px_minmax(0,1fr)] max-[900px]:grid-cols-1">
          <Structure
            draft={draft}
            section={shownSection}
            onSection={goto}
            open={open}
            onOpen={openItem}
            onReorder={(from, to) => setDraft((d) => reorderQuestion(d, from, to))}
            onMove={(i, delta) => setDraft((d) => moveQuestion(d, i, delta))}
            warnSections={warnSections}
            warnItems={new Set(itemIssues.keys())}
            onAdd={addQuestion}
            onPaste={() => setDrawer("paste")}
          />
          <div className="min-w-0">{content}</div>
          <div className="kit-scroll sticky top-3 max-h-[calc(100vh-var(--ah,56px)-150px)] min-w-0 overflow-y-auto max-[1180px]:static max-[1180px]:col-start-2 max-[1180px]:max-h-none max-[900px]:col-start-1">
            <Preview draft={draft} at={focused} onPick={openItem} />
          </div>
        </div>

        <CheckDrawer
          open={drawer === "check"}
          onClose={() => setDrawer(null)}
          issues={issues}
          checking={checking}
          error={checkError}
          sub={name || ut("cst.title")}
          items={draft.questions.length}
          scaleCodes={scaleCodes}
          onGoto={(t) => {
            setDrawer(null);
            if (t.kind === "item") openItem(t.n - 1);
            else goto(mode === "complex" ? "bands" : "scales");
          }}
          onRecheck={() => void runCheck(draft)}
          note={published ? `${ut("ce.publishNote")} ${nextVersion}` : ut("ce.publishNoteNew")}
          footer={
            <>
              {errors ? null : publishButton}
              <Button onClick={() => setDrawer(null)}>{ut("ui.close")}</Button>
            </>
          }
        />
        {id ? (
          <HistoryDrawer
            open={drawer === "history"}
            onClose={() => setDrawer(null)}
            surveyId={id}
            currentVersionId={saved?.versionId ?? null}
            sub={name}
          />
        ) : null}
        {id && published ? <AssignGroup surveyId={id} open={drawer === "assign"} onClose={() => setDrawer(null)} sub={name} /> : null}
        <BulkPaste
          open={drawer === "paste"}
          onClose={() => setDrawer(null)}
          onReturn={() => setDrawer("paste")}
          sub={name || ut("cst.title")}
          note={ut("ce.pasteAppends")}
          applyLabel={ut("ce.pasteApply")}
          defaultLang={editLang}
          onApply={(questions) => {
            setDraft((d) => ({ ...d, questions: [...d.questions, ...questions] }));
            setSection("questions");
          }}
        />
      </Page>
    </EditLangProvider>
  );
}
