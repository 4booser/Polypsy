import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Issue } from "@quizzy/shared";
import type { SurveyGroupWithCounts } from "@quizzy/shared";
import { api } from "../../api";
import { Basics } from "./Basics";
import { Questions } from "./Questions";
import { Scales } from "./Scales";
import { EMPTY, toDraft, type Draft, type Tab } from "./model";

/**
 * Черновик живёт в localStorage: правка методики на 200 пунктов не должна
 * умирать от F5 или упавшей вкладки. Ключ включает id — черновики разных
 * методик не затирают друг друга.
 */
const draftKey = (id: string | undefined) => `quizzy.constructor.${id ?? "new"}`;

export default function Constructor() {
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
        setDraftRaw({ ...EMPTY, ...(JSON.parse(saved) as Draft) });
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
      const res = await api.validateSurvey(draft);
      setIssues(res.issues);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось проверить");
    } finally {
      setBusy(false);
    }
  }

  async function save(publish: boolean) {
    setBusy(true);
    setError(null);
    try {
      const survey = id
        ? await api.updateSurvey(id, { ...draft, versionNote: "Правка через конструктор" })
        : await api.createSurvey(draft);
      if (publish) await api.updateSurvey(survey.id, { status: "published" });
      localStorage.removeItem(draftKey(id));
      setDirty(false);
      navigate(`/surveys/${survey.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  function applyJson() {
    setError(null);
    try {
      const parsed = JSON.parse(json) as Draft;
      if (!parsed.title) throw new Error("В JSON нет поля title");
      setDraft({ ...EMPTY, ...parsed });
      setTab("basics");
    } catch (e) {
      setError(e instanceof Error ? `JSON не разобран: ${e.message}` : "JSON не разобран");
    }
  }

  if (!loaded) return <p className="muted">Загрузка…</p>;

  return (
    <>
      <h1>{id ? "Правка методики" : "Новая методика"}</h1>
      <p className="sub">
        {id ? (
          <>
            Правка создаёт новую версию — собранные прохождения останутся на прежней.{" "}
            <Link to={`/surveys/${id}`}>к аналитике</Link>
          </>
        ) : (
          "Заполните вручную или вставьте описание методики целиком во вкладке «JSON»"
        )}
      </p>

      <div className="row" style={{ alignItems: "flex-end" }}>
      <div className="tabs" style={{ flex: 1 }}>
        {([
          ["basics", "Основное"],
          ["questions", `Вопросы ${asked}`],
          ["scales", `Шкалы ${draft.scales.length}`],
          ["json", "JSON"],
        ] as [Tab, string][]).map(([v, label]) => (
          <button key={v} className={tab === v ? "active" : ""} onClick={() => setTab(v)}>
            {label}
          </button>
        ))}
      </div>
        <div className="row tight" style={{ paddingBottom: 6 }}>
          <button onClick={undo} disabled={!undoStack.current.length} title="Отменить (Ctrl+Z)">↶</button>
          <button onClick={redo} disabled={!redoStack.current.length} title="Вернуть (Ctrl+Shift+Z)">↷</button>
          {dirty ? <span className="hint">черновик сохраняется сам</span> : null}
        </div>
      </div>

      {restored ? (
        <div className="card" style={{ borderColor: "var(--sev-mild)" }}>
          <p style={{ margin: 0 }}>
            Восстановлен несохранённый черновик из этого браузера.{" "}
            <button
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
              Отбросить и загрузить серверную версию
            </button>
          </p>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      {issues ? (
        <div
          className="card"
          style={{
            borderColor: issues.some((i) => i.level === "error")
              ? "var(--sev-severe)"
              : issues.length
                ? "var(--sev-mild)"
                : "var(--sev-none)",
          }}
        >
          <h2>
            {issues.length === 0
              ? "Структурных замечаний нет"
              : `Замечаний: ${issues.filter((i) => i.level === "error").length} ошибок, ${issues.filter((i) => i.level === "warning").length} предупреждений`}
          </h2>
          <p className="hint">
            Проверка формальная: она ловит ошибки переноса ключей и норм, но не знает
            содержания методики
          </p>
          {issues.map((i, k) => (
            <p key={k} style={{ margin: "4px 0", fontSize: 13 }}>
              <span style={{ color: i.level === "error" ? "var(--sev-severe)" : "var(--sev-mild)" }}>
                {i.level === "error" ? "✖" : "⚠"}
              </span>{" "}
              <strong>{i.where}:</strong> <span className="muted">{i.message}</span>
            </p>
          ))}
        </div>
      ) : null}

      {tab === "basics" ? <Basics draft={draft} groups={groups} patch={patch} /> : null}
      {tab === "questions" ? <Questions draft={draft} setDraft={setDraft} /> : null}
      {tab === "scales" ? <Scales draft={draft} setDraft={setDraft} /> : null}
      {tab === "json" ? (
        <div className="card">
          <h2>Описание методики целиком</h2>
          <p className="hint">
            Для методик на сотни пунктов заполнять форму бессмысленно. Вставьте сюда описание
            в том же виде, какой принимает API — с ключами шкал, нормами и таблицами стенов.
          </p>
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={22}
            spellCheck={false}
            style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={applyJson}>Применить</button>
            <button onClick={() => navigator.clipboard?.writeText(json)}>Скопировать</button>
          </div>
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 18 }}>
        <button onClick={check} disabled={busy}>Проверить структуру</button>
        <button onClick={() => save(false)} disabled={busy}>Сохранить черновиком</button>
        <button className="primary" onClick={() => save(true)} disabled={busy}>
          {busy ? "Сохранение…" : "Сохранить и опубликовать"}
        </button>
      </div>
    </>
  );
}

/* ─────────── вкладки ─────────── */

