import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { LANG_NAMES, type Issue, type Lang, type SurveyGroupWithCounts } from "@quizzy/shared";
import { api } from "../../api";
import { useResource } from "../../useResource";
import { AssignGroup } from "./AssignGroup";
import { Settings } from "./Basics";
import { EditLangProvider, Loc, Toggle } from "./fields";
import { Questions, SectionHead } from "./Questions";
import { Answers, Bands, Scales } from "./Scales";
import {
  EMPTY,
  createTarget,
  defaultAnswers,
  normalizeDraft,
  switchMode,
  toDraft,
  toPayload,
  totalScale,
  type Draft,
  type Mode,
} from "./model";
import { Preview } from "./Preview";
import { IconGroup, IconPatients, Loading } from "../../ui";
import { Page } from "../../ui/layout";
import { Button, Field, Select, Tabs, Textarea } from "../../ui/primitives";
import { cx } from "../../ui/cx";
import { useLang } from "../../lang";

/*
 * Конструктор теста — один свиток по кадрам заказчика.
 *
 * Порядок сверху вниз повторяет f24/f23: вкладки «Конкретний / Комплексний
 * тест» (только при создании — на кадрах правки f18/f29 их нет), «Назва
 * тесту», «Опис тесту», «Питання» аккордеоном (f12), затем либо «Відповіді»
 * и шкалы с таблицей баллов (f24_2/f30/f37), либо «Результати» (f23/f18),
 * внизу «Створити». Прежняя редакция делила ту же работу на четыре вкладки;
 * макет их не знает, и разбивка ушла вместе с ними.
 *
 * Что осталось от прежней редакции и почему: автосейв черновика, отмена и
 * возврат, проверка структуры до сохранения, предпросмотр пункта справа
 * (панель контекста, которую макет не запрещает), настройки прохождения и
 * психометрика — свёрнутыми блоками. Это возможности, а не украшения;
 * убрать их ради буквы кадра значило бы снять то, чем встроенные методики
 * (МЛО, Мини-мульт, СР-45) считаются.
 *
 * Границу прав макет тоже не видит, а она есть: «Опублікувати» требует
 * surveys.publish, «Створити»/«Зберегти» — только surveys.edit. Поэтому
 * кнопок две, как на f18 (публикация в шапке) и f23 (создание внизу).
 */

/**
 * Черновик живёт в localStorage: правка методики на 200 пунктов не должна
 * умирать от F5 или упавшей вкладки. Ключ включает id — черновики разных
 * методик не затирают друг друга.
 */
const draftKey = (id: string | undefined) => `quizzy.constructor.${id ?? "new"}`;

export default function Constructor() {
  const { ut, lang } = useLang();
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
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
  const [focused, setFocused] = useState(0);
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!id);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  /*
   * Язык, на котором правится текст теста, — не язык консоли. Начинается с
   * него, потому что чаще всего они совпадают, но переключается отдельно:
   * специалист с русской консолью вписывает украинский текст методики.
   */
  const [editLang, setEditLang] = useState<Lang>(lang);
  /* окно «призначити групі» — второй значок кадра f17 */
  const [assignGroup, setAssignGroup] = useState(false);

  /* куда заводить тест: «+ → Новий тест» из папки каталога */
  const target = useMemo(() => createTarget(location.search), [location.search]);

  useEffect(() => {
    api.groups().then(setGroups).catch(() => setGroups([]));

    // сначала автосейв: несохранённая работа важнее серверной версии
    const saved = localStorage.getItem(draftKey(id));
    if (saved) {
      try {
        const kept = normalizeDraft({ ...EMPTY, ...(JSON.parse(saved) as Draft) });
        /*
         * Папка и группа — из адреса, если он их несёт: человек только что
         * пришёл из этой папки, и его намерение новее сохранённого черновика.
         */
        setDraftRaw(!id && target.groupId ? { ...kept, groupId: target.groupId, folderId: target.folderId } : kept);
        setRestored(true);
        setLoaded(true);
        return;
      } catch {
        localStorage.removeItem(draftKey(id));
      }
    }

    if (!id) {
      setDraftRaw({ ...EMPTY, answers: defaultAnswers(), groupId: target.groupId, folderId: target.folderId });
      return;
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const mode: Mode = draft.mode ?? "specific";
  const text = (v: Record<string, string> | null | undefined) => v?.[editLang] || v?.uk || v?.ru || "";

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
      const payload = toPayload(draft);
      /*
       * Папка уходит только при заведении: правка методики папку не меняет,
       * для переноса есть свой маршрут со своей записью в журнале
       * (PUT /api/surveys/:id/folder).
       */
      const survey = id
        ? await api.updateSurvey(id, { ...payload, versionNote: ut("co.versionNote") })
        : await api.createSurvey({ ...payload, folderId: draft.folderId ?? undefined });
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
      setDraft(normalizeDraft({ ...EMPTY, ...parsed }));
    } catch (e) {
      setError(e instanceof Error ? `${ut("co.jsonParseError")}: ${e.message}` : ut("co.jsonParseError"));
    }
  }

  if (!loaded) return <Loading rows={5} />;

  const backTo = draft.folderId ? `/surveys?folder=${encodeURIComponent(draft.folderId)}` : "/surveys";

  const modePanel =
    mode === "specific" ? (
      <>
        <Answers draft={draft} setDraft={setDraft} />
        <Scales draft={draft} setDraft={setDraft} />
      </>
    ) : (
      <Results draft={draft} setDraft={setDraft} />
    );

  return (
    <Page
      /* на кадрах правки (f18, f29) заголовок экрана — название самого теста */
      title={id ? text(draft.title) || ut("cn.testTitle") : ut("cn.newTest")}
      crumbs={id ? <Link to={`/surveys/${id}`}>{ut("back.toAnalytics")}</Link> : <Link to={backTo}>{ut("back.toSurveys")}</Link>}
      actions={
        <>
          {/*
            Два значка кадра f17: «призначити пацієнту» и «призначити групі».
            Первый ведёт на экран назначений — он есть. Второй открывает окно
            здесь же: групповое назначение на сервере есть
            (POST /api/patient-groups/:id/surveys, разворачивается в
            поимённые), а экран группы пациентов делает другая волна — вести
            некуда, да и одно действие перехода не стоит. Кнопка, а не ссылка:
            адрес не меняется.
          */}
          {id ? (
            <>
              <Link
                to={`/surveys/${id}/access`}
                aria-label={ut("cn.assignPatient")}
                title={ut("cn.assignPatient")}
                className="inline-flex size-[44px] items-center justify-center rounded-[5px] text-primary hover:bg-primary-soft [&>svg]:size-6"
              >
                <IconPatients />
              </Link>
              <button
                type="button"
                onClick={() => setAssignGroup(true)}
                aria-label={ut("cn.assignGroup")}
                title={ut("cn.assignGroup")}
                className="inline-flex size-[44px] items-center justify-center rounded-[5px] border-0 bg-transparent p-0 text-primary hover:bg-primary-soft [&>svg]:size-6"
              >
                <IconGroup />
              </button>
            </>
          ) : null}
          <Button onClick={() => save(true)} disabled={busy}>
            {busy ? ut("co.saving") : ut("cn.publish")}
          </Button>
        </>
      }
      toolbar={
        <div className="flex flex-1 items-center justify-end gap-[8px]">
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
          {dirty ? <span className="text-[13px] text-muted">{ut("co.draftAutosaves")}</span> : null}
          {/*
            «Перевірити структуру» — здесь, а не внизу рядом со «Створити»: на
            кадре f23 внизу одна кнопка, а полоса инструментов — уже место
            того, чего на кадре нет (отмена, возврат). Проверка — инструмент
            редактора и стоит с ними; её отчёт по-прежнему выводится над формой.
          */}
          <Button variant="ghost" onClick={check} disabled={busy}>{ut("co.checkStructure")}</Button>
          <Button variant="ghost" onClick={undo} disabled={!undoStack.current.length} title={ut("co.undo")} aria-label={ut("co.undo")}>
            <IconUndo />
          </Button>
          <Button variant="ghost" onClick={redo} disabled={!redoStack.current.length} title={ut("co.redo")} aria-label={ut("co.redo")}>
            <IconUndo flip />
          </Button>
        </div>
      }
      /*
       * Предпросмотр — в панели контекста справа. На кадрах справа пусто, и
       * панель это место занимает, а не спорит с ним; убрать предпросмотр —
       * значит снова собирать методику вслепую.
       */
      context={<Preview draft={draft} at={focused} />}
      contextTitle={ut("co.preview")}
    >
      {assignGroup && id ? <AssignGroup surveyId={id} onClose={() => setAssignGroup(false)} /> : null}

      {restored ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[5px] border border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-accent-soft px-4 py-3">
          <p className="m-0 text-small text-text">{ut("co.draftRestored")}</p>
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
                setDraftRaw({ ...EMPTY, answers: defaultAnswers(), groupId: target.groupId, folderId: target.folderId });
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
            "mb-4 rounded-[5px] border p-4",
            issues.some((i) => i.level === "error")
              ? "border-[color-mix(in_srgb,var(--danger)_45%,transparent)] bg-danger-soft"
              : issues.length
                ? "border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-accent-soft"
                : "border-[color-mix(in_srgb,var(--sev-none)_45%,transparent)]",
          )}
        >
          <h2 className="m-0 text-[18px] font-bold leading-tight text-primary">
            {issues.length === 0
              ? ut("co.noIssues")
              : `${ut("co.issuesSummary")}: ${issues.filter((i) => i.level === "error").length} ${ut("co.errorsCount")}, ${issues.filter((i) => i.level === "warning").length} ${ut("co.warningsCount")}`}
          </h2>
          <p className="mt-1 text-[13px] text-muted">{ut("co.checkHint")}</p>
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

      {/* колонка формы по кадру: ~700px по центру, справа — язык текста */}
      <div className="mx-auto w-full max-w-[700px]">
        <div className="mb-[24px] flex items-start justify-between gap-[24px]">
          {!id ? (
            /* вкладки состояния: role="tab" и панель ниже (cn-mode-panel), см. Tabs */
            <Tabs
              label={ut("cn.testKind")}
              items={[
                {
                  id: "cn-mode-specific",
                  controls: "cn-mode-panel",
                  label: ut("cn.specific"),
                  active: mode === "specific",
                  onSelect: () => setDraft((d) => switchMode(d, "specific")),
                },
                {
                  id: "cn-mode-complex",
                  controls: "cn-mode-panel",
                  label: ut("cn.complex"),
                  active: mode === "complex",
                  onSelect: () => setDraft((d) => switchMode(d, "complex")),
                },
              ]}
            />
          ) : (
            <span />
          )}
          {/*
            Пояснение о двух языках — всплывающей подписью переключателя, а не
            строкой под ним: на кадре f24_1 под «Укр ▾» ничего нет. Хранение
            текста обоими языками от этого не меняется, а тот, кто не понял,
            зачем переключатель, наведёт на него и прочтёт.
          */}
          <Field label={ut("cn.editLang")} inline className="w-[150px] shrink-0">
            <Select value={editLang} onChange={(e) => setEditLang(e.target.value as Lang)} title={ut("cn.editLangHint")}>
              {(["uk", "ru"] as const).map((l) => (
                <option key={l} value={l}>{LANG_NAMES[l].full}</option>
              ))}
            </Select>
          </Field>
        </div>

        <EditLangProvider value={editLang}>
          <Loc label={ut("cn.testTitle")} value={draft.title} onChange={(v) => patch({ title: v })} />
          {/* четыре строки: поле описания на кадре f24_1 — 125px при 17/1.55 */}
          <Loc label={ut("cn.testDescription")} value={draft.description} onChange={(v) => patch({ description: v })} multiline rows={4} />

          <Questions draft={draft} setDraft={setDraft} onFocusQuestion={setFocused} />

          {/*
            Панель вкладок «Вид тесту» — то, что вкладка переключает целиком:
            общий набор ответов и шкалы против результатов (питання выше
            общие для обоих видов). При правке вкладок нет (f18/f29), и панель
            без списка вкладок диктору ни к чему — тогда это просто разметка.
          */}
          {id ? (
            modePanel
          ) : (
            <div
              id="cn-mode-panel"
              role="tabpanel"
              aria-labelledby={mode === "specific" ? "cn-mode-specific" : "cn-mode-complex"}
            >
              {modePanel}
            </div>
          )}

          <Disclosure title={ut("cn.settings")}>
            <Settings draft={draft} groups={groups} patch={patch} />
          </Disclosure>

          <Disclosure title={ut("cn.jsonSection")} onOpen={() => setJson(JSON.stringify(draft, null, 2))}>
            <p className="m-0 mb-[8px] pt-[12px] text-[13px] text-muted">{ut("co.jsonHint")}</p>
            <Textarea
              aria-label={ut("co.wholeJson")}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={22}
              spellCheck={false}
              className="font-mono text-caption"
            />
            <div className="mt-3 flex gap-2">
              <Button onClick={applyJson}>{ut("co.apply")}</Button>
              <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(json)}>{ut("co.copy")}</Button>
            </div>
          </Disclosure>
        </EditLangProvider>

        {/* «Створити» 215×45 из f23/f24 — одна кнопка, как на кадре; проверка структуры — в полосе инструментов */}
        <div className="mt-[28px] flex justify-end">
          <Button size="md" className="min-w-[215px]" onClick={() => save(false)} disabled={busy}>
            {busy ? ut("co.saving") : id ? ut("common.save") : ut("cn.create")}
          </Button>
        </div>
      </div>
    </Page>
  );
}

/**
 * «Результати» комплексного теста (f23/f18/f29): диапазоны суммы баллов.
 *
 * Полосы в модели принадлежат шкале, а не тесту, поэтому здесь они лежат на
 * единственной итоговой шкале — она заводится при первом диапазоне, а её
 * ключ на все вопросы проставляется при отправке (withTotalKey). Для автора
 * это «результаты теста», для движка — та же полоса той же шкалы.
 */
function Results({ draft, setDraft }: { draft: Draft; setDraft: (f: (d: Draft) => Draft) => void }) {
  const { ut } = useLang();
  const batteries = (useResource(() => api.batteries(), []).data ?? []).filter((b) => !b.archived);
  const [details, setDetails] = useState(false);
  const bands = draft.scales[0]?.bands ?? [];
  return (
    <section aria-labelledby="cn-results">
      <SectionHead id="cn-results" title={ut("cn.results")} />
      <Bands
        bands={bands}
        details={details}
        batteries={batteries}
        onChange={(next) =>
          setDraft((d) => {
            const first = d.scales[0] ?? totalScale();
            return { ...d, scales: [{ ...first, bands: next }, ...d.scales.slice(1)] };
          })
        }
      />
      <div className="mt-[8px]">
        <Toggle label={ut("cn.bandDetails")} value={details} onChange={setDetails} />
      </div>
    </section>
  );
}

/**
 * Свёрнутый блок под формой: то, чего нет на кадре, но есть у методики.
 * Нативный <details>: сворачивание не требует ни состояния, ни ARIA — браузер
 * сам сообщает диктору «свёрнуто/развёрнуто».
 */
function Disclosure({ title, onOpen, children }: { title: string; onOpen?: () => void; children: ReactNode }) {
  return (
    <details
      className="group mt-[28px] rounded-[5px] border border-hairline bg-[var(--bg)] px-[20px] py-[12px]"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) onOpen?.();
      }}
    >
      <summary className="cursor-pointer list-none text-[17px] font-bold text-primary [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="mr-1 inline-block transition-transform group-open:rotate-90">▸</span>
        {title}
      </summary>
      {children}
    </details>
  );
}

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
