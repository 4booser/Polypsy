import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Issue } from "@quizzy/shared";
import type { SurveyGroupWithCounts } from "@quizzy/shared";
import { api } from "../../api";
import { Basics } from "./Basics";
import { Questions } from "./Questions";
import { Scales } from "./Scales";
import { EMPTY, toDraft, toPayload, withUids, type Draft, type Tab } from "./model";
import { Preview } from "./Preview";
import { Loading } from "../../ui";
import { Page, Panel } from "../../ui/layout";
import { Button, Textarea } from "../../ui/primitives";
import { cx } from "../../ui/cx";
import { useLang } from "../../lang";

/**
 * Черновик живёт в localStorage: правка методики на 200 пунктов не должна
 * умирать от F5 или упавшей вкладки. Ключ включает id — черновики разных
 * методик не затирают друг друга.
 */
const draftKey = (id: string | undefined) => `quizzy.constructor.${id ?? "new"}`;

export default function Constructor() {
  const { ut } = useLang();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [draft, setDraftRaw] = useState<Draft>(EMPTY);
  const [restored, setRestored] = useState(false);
  const [dirty, setDirty] = useState(false);

  /*
   * Undo/redo: стек снапшотов. Пишется на каждое изменение черновика —
   * дёшево (structured clone маленького объекта), а отмена случайного
   * «Удалить» на большой методике бесценна.
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
  const [groups, setGroups] = useState<SurveyGroupWithCounts[]>([]);
  const [tab, setTab] = useState<Tab>("basics");
  const [focused, setFocused] = useState(0);
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!id);
  const [issues, setIssues] = useState<Issue[] | null>(null);

  useEffect(() => {
    api.groups().then(setGroups).catch(() => setGroups([]));

    // сначала автосейв: несохранённая работа важнее серверной версии
    const saved = localStorage.getItem(draftKey(id));
    if (saved) {
      try {
        setDraftRaw(withUids({ ...EMPTY, ...(JSON.parse(saved) as Draft) }));
        setRestored(true);
        setLoaded(true);
        return;
      } catch {
        localStorage.removeItem(draftKey(id));
      }
    }

    if (!id) return;
    api
      .surveyRaw(id)
      .then((s) => {
        setDraftRaw(toDraft(s, []));
        setLoaded(true);
      })
      .catch((e) => {
        setError(e.message);
        setLoaded(true);
      });
  }, [id]);

  // автосейв с дебаунсом: каждое нажатие клавиши не должно дёргать диск
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => {
      localStorage.setItem(draftKey(id), JSON.stringify(draft));
    }, 800);
    return () => clearTimeout(timer);
  }, [draft, dirty, id]);

  // несохранённые правки: предупредить при закрытии вкладки
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Ctrl+S — черновик, Ctrl+Z/Ctrl+Shift+Z — отмена/возврат
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "s") {
        e.preventDefault();
        void save(false);
      } else if (e.key === "z" && !e.shiftKey) {
        // в полях ввода браузерная отмена полезнее нашей
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, undo, redo]);

  useEffect(() => {
    setJson(JSON.stringify(draft, null, 2));
  }, [tab === "json"]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const asked = useMemo(() => draft.questions.filter((q) => q.type !== "info").length, [draft.questions]);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.validateSurvey(toPayload(draft));
      setIssues(res.issues);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("co.checkFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function save(publish: boolean) {
    setBusy(true);
    setError(null);
    try {
      const survey = id
        ? await api.updateSurvey(id, { ...toPayload(draft), versionNote: ut("co.versionNote") })
        : await api.createSurvey(toPayload(draft));
      if (publish) await api.updateSurvey(survey.id, { status: "published" });
      localStorage.removeItem(draftKey(id));
      setDirty(false);
      navigate(`/surveys/${survey.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("co.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  function applyJson() {
    setError(null);
    try {
      const parsed = JSON.parse(json) as Draft;
      if (!parsed.title) throw new Error(ut("co.noTitleField"));
      setDraft(withUids({ ...EMPTY, ...parsed }));
      setTab("basics");
    } catch (e) {
      setError(e instanceof Error ? `${ut("co.jsonParseError")}: ${e.message}` : ut("co.jsonParseError"));
    }
  }

  if (!loaded) return <Loading rows={5} />;

  const tabs: [Tab, string][] = [
    ["basics", ut("co.basics")],
    ["questions", `${ut("co.questions")} ${asked}`],
    ["scales", `${ut("co.scales")} ${draft.scales.length}`],
    ["json", "JSON"],
  ];

  return (
    <Page
      title={id ? ut("co.editTitle") : ut("co.newTitle")}
      crumbs={id ? <Link to={`/surveys/${id}`}>{ut("back.toAnalytics")}</Link> : <Link to="/surveys">{ut("back.toSurveys")}</Link>}
      sub={id ? ut("co.editSub") : ut("co.newSub")}
      actions={
        <>
          <Button onClick={check} disabled={busy}>{ut("co.checkStructure")}</Button>
          <Button onClick={() => save(false)} disabled={busy}>{ut("co.saveDraft")}</Button>
          <Button variant="primary" onClick={() => save(true)} disabled={busy}>
            {busy ? ut("co.saving") : ut("co.savePublish")}
          </Button>
        </>
      }
      toolbar={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          {/* .tabs — тот же язык, что у остальных экранов: активная вкладка
              держится подчёркиванием бирюзой, а не янтарём */}
          <div className="tabs mb-0 border-b-0">
            {tabs.map(([v, label]) => (
              <button key={v} className={tab === v ? "active" : ""} onClick={() => setTab(v)}>
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {/*
              Отмена и возврат — обычные кнопки с рамкой, а не тихие.
              Тихий вариант оставлял на светлой полосе вкладок две едва
              заметные закорючки: в конструкторе отмена нужна чаще всего
              именно тогда, когда что-то пошло не так, и искать её в этот
              момент — последнее, чем стоит заниматься.
            */}
            {/*
              Значки нарисованы, а не набраны символами ↶ и ↷.

              Шрифты подключены подмножествами — только те диапазоны, что
              реально нужны, — и стрелок отмены в них нет. Браузер подставлял
              запасную гарнитуру, и на кнопке оказывалась не стрелка, а то,
              что нашлось. Заметно это стало ровно тогда, когда кнопки
              перестали быть бледными.
            */}
            <Button size="sm" onClick={undo} disabled={!undoStack.current.length} title={ut("co.undo")} aria-label={ut("co.undo")}>
              <IconUndo />
            </Button>
            <Button size="sm" onClick={redo} disabled={!redoStack.current.length} title={ut("co.redo")} aria-label={ut("co.redo")}>
              <IconUndo flip />
            </Button>
            {dirty ? <span className="text-caption text-muted">{ut("co.draftAutosaves")}</span> : null}
          </div>
        </div>
      }
    >
      {restored ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-accent-soft px-4 py-3">
          <p className="m-0 text-small text-text">
            {ut("co.draftRestored")}
          </p>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              localStorage.removeItem(draftKey(id));
              setRestored(false);
              setDirty(false);
              undoStack.current = [];
              if (id) {
                api.surveyRaw(id).then((s) => setDraftRaw(toDraft(s, [])));
              } else {
                setDraftRaw(EMPTY);
              }
            }}
          >
            {ut("co.discardDraft")}
          </Button>
        </div>
      ) : null}

      {error ? <p className="mb-3 text-small text-danger">{error}</p> : null}

      {issues ? (
        <div
          className={cx(
            "mb-4 rounded-md border p-4",
            issues.some((i) => i.level === "error")
              ? "border-[color-mix(in_srgb,var(--danger)_45%,transparent)] bg-danger-soft"
              : issues.length
                ? "border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-accent-soft"
                : "border-[color-mix(in_srgb,var(--sev-none)_45%,transparent)]",
          )}
        >
          <h2 className="m-0 font-display text-section font-medium leading-tight">
            {issues.length === 0
              ? ut("co.noIssues")
              : `${ut("co.issuesSummary")}: ${issues.filter((i) => i.level === "error").length} ${ut("co.errorsCount")}, ${issues.filter((i) => i.level === "warning").length} ${ut("co.warningsCount")}`}
          </h2>
          <p className="mt-1 text-caption text-muted">
            {ut("co.checkHint")}
          </p>
          {issues.map((i, k) => (
            <p key={k} className="my-1 text-small">
              <span className={i.level === "error" ? "text-danger" : "text-accent"}>
                {i.level === "error" ? "✖" : "⚠"}
              </span>{" "}
              <strong>{i.where}:</strong> <span className="text-muted">{i.message}</span>
            </p>
          ))}
        </div>
      ) : null}

      {tab === "basics" ? <Basics draft={draft} groups={groups} patch={patch} /> : null}
      {/*
        Пункты правятся рядом с тем, как они выглядят. Раньше вид пункта был
        виден только после публикации и прохождения: длинная формулировка,
        не влезающая в экран телефона, обнаруживалась на пациенте.
      */}
      {tab === "questions" ? (
        <div className="constructor-split">
          {/*
            Обёртка обязательна не только как контейнер: в CSS grid дочерний
            элемент по умолчанию не сжимается уже своего содержимого
            (min-width: auto), а таблица вариантов внутри Questions шире
            колонки. Без явного min-width: 0 на .constructor-main левая
            колонка раздвигала бы сетку и уводила страницу в горизонтальную
            прокрутку — что на этом экране запрещено отдельным правилом.
          */}
          <div className="constructor-main">
            <Questions draft={draft} setDraft={setDraft} onFocusQuestion={setFocused} />
          </div>
          <Preview draft={draft} at={focused} />
        </div>
      ) : null}
      {tab === "scales" ? <Scales draft={draft} setDraft={setDraft} /> : null}
      {tab === "json" ? (
        <Panel
          title={ut("co.wholeJson")}
          hint={ut("co.jsonHint")}
        >
          <Textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={22}
            spellCheck={false}
            className="font-mono text-caption"
          />
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={applyJson}>{ut("co.apply")}</Button>
            <Button onClick={() => navigator.clipboard?.writeText(json)}>{ut("co.copy")}</Button>
          </div>
        </Panel>
      ) : null}
    </Page>
  );
}

/* ─────────── вкладки ─────────── */

/** Стрелка отмены; `flip` разворачивает её в «вернуть». */
function IconUndo({ flip }: { flip?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={flip ? { transform: "scaleX(-1)" } : undefined}
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h9a7 7 0 0 1 0 14h-3" />
    </svg>
  );
}
