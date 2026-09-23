import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { makeUiT, type Issue, type Lang, type SurveyGroupWithCounts } from "@quizzy/shared";
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
import { Button, Select, Tabs, Textarea } from "../../ui/primitives";
import { cx } from "../../ui/cx";
import { useLang } from "../../lang";
import { IconCaution, IconCross, IconGear } from "../../ui/glyphs";
import { MenuButton, menuItemClass } from "../../ui/menu";

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
 * Чего на кадрах нет — и куда оно убрано с глаз (функции при этом живы,
 * см. меню шестерёнки рядом с «Створити»):
 *
 *   заголовок «Новий тест» и крошка над вкладками (f24_1: над вкладками пусто)
 *     → заголовок скрыт (titleHidden), крошки нет; возврат к каталогу и к
 *       карточке методики — пунктами того же меню;
 *   «чернетка зберігається сама», «Перевірити структуру», отмена и возврат
 *     → в меню шестерёнки; строка про автосейв — подписью самого меню;
 *   предпросмотр пункта (панель контекста справа; на всех кадрах справа пусто)
 *     → пунктом меню, раскрывается блоком под формой;
 *   «Налаштування проходження» и «Тест як JSON» (f23_2: между «Результати» и
 *   «Створити» пусто)
 *     → пунктами того же меню, раскрываются блоками под формой.
 *
 * Убрать их совсем было нельзя: это возможности, а не украшения, и без них
 * встроенные методики (МЛО, Мини-мульт, СР-45) перестают быть методиками.
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
  /*
   * Что развёрнуто из меню шестерёнки. Одно за раз: это блоки под формой, и
   * два открытых сразу увели бы «Створити» на два экрана вниз.
   */
  const [tool, setTool] = useState<null | "preview" | "settings" | "json">(null);
  /*
   * Опубликована ли методика. Кадр f17 — опубликованная: два значка
   * назначения и никакой кнопки. Кадр f18 — неопубликованная: «Опублікувати»
   * и никаких значков. Печатать и то и другое разом — значит показывать
   * «опубликовать» у того, что уже опубликовано.
   */
  const [published, setPublished] = useState(false);
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
        setPublished(s.status === "published");
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

  /*
   * Меню инструментов — приёмник всего, чего на кадрах нет: проверки
   * структуры, отмены и возврата, предпросмотра, настроек прохождения и
   * JSON. Подпись меню несёт строку «чернетка зберігається сама» — на кадре
   * её нет, а сказать о самосохранении надо.
   */
  const tools = (
    <MenuButton
      label={dirty ? `${ut("cn.tools")} — ${ut("co.draftAutosaves")}` : ut("cn.tools")}
      glyph={<IconGear />}
      align="right"
    >
      {(close) => (
        <>
          <button
            type="button"
            role="menuitem"
            className={menuItemClass("right")}
            disabled={busy}
            onClick={() => {
              close();
              void check();
            }}
          >
            {ut("co.checkStructure")}
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClass("right")}
            disabled={!undoStack.current.length}
            onClick={() => {
              close();
              undo();
            }}
          >
            {ut("co.undo")}
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClass("right")}
            disabled={!redoStack.current.length}
            onClick={() => {
              close();
              redo();
            }}
          >
            {ut("co.redo")}
          </button>
          <hr className="my-1 border-0 border-t border-hairline" />
          {(["preview", "settings", "json"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="menuitem"
              aria-pressed={tool === t}
              className={menuItemClass("right")}
              onClick={() => {
                close();
                setTool((cur) => (cur === t ? null : t));
                if (t === "json") setJson(JSON.stringify(draft, null, 2));
              }}
            >
              {ut(t === "preview" ? "co.preview" : t === "settings" ? "cn.settings" : "cn.jsonSection")}
            </button>
          ))}
          <hr className="my-1 border-0 border-t border-hairline" />
          {/* крошка кадра «До тестів» / «До аналітики» — сюда же: над вкладками на кадре пусто */}
          <Link role="menuitem" to={id ? `/surveys/${id}` : backTo} className={menuItemClass("right")} onClick={close}>
            {id ? ut("back.toAnalytics") : ut("cn.backToCatalogue")}
          </Link>
        </>
      )}
    </MenuButton>
  );

  return (
    <Page
      /* на кадрах правки (f18, f29) заголовок экрана — название самого теста */
      title={id ? text(draft.title) || ut("cn.testTitle") : ut("cn.newTest")}
      /*
       * При заведении заголовка на экране нет: кадр f24_1 начинается прямо
       * вкладками «Конкретний / Комплексний тест». При правке заголовок — имя
       * самого теста (f18/f29). Крошки нет ни там, ни там: обратные дороги
       * ушли в меню шестерёнки.
       */
      titleHidden={!id}
      actions={
        <>
          {/*
            Кадр f17 — опубликованная методика: два значка назначения,
            «Опублікувати» нет. Кадр f18 — неопубликованная: кнопка есть,
            значков нет. Показывать оба состояния разом значило бы предлагать
            опубликовать то, что опубликовано.
          */}
          {id && published ? (
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
          {!published ? (
            <Button onClick={() => save(true)} disabled={busy}>
              {busy ? ut("co.saving") : ut("cn.publish")}
            </Button>
          ) : null}
          {/*
            Переключатель языка текста — у правого края колонки, короткой
            подписью «Укр», как на кадрах f24_1, f31 и f37. Прежде он стоял
            полем «Мова тексту тесту» шириной 150 внутри колонки 700 и
            печатал на кнопке полное название языка.

            Третий пункт кадра — «English» — не заведён: Lang в модели
            содержит только uk и ru, и пустая строка в списке обещала бы язык,
            которого нет ни в одном поле теста.
          */}
          <label className="flex items-center gap-[8px]">
            <span className="sr-only">{ut("cn.editLang")}</span>
            <Select
              value={editLang}
              onChange={(e) => setEditLang(e.target.value as Lang)}
              title={ut("cn.editLangHint")}
              className="w-[110px] text-[17px] font-bold text-primary"
            >
              {(["uk", "ru"] as const).map((l) => (
                <option key={l} value={l}>{makeUiT(l)("top.lang")}</option>
              ))}
            </Select>
          </label>
          {tools}
        </>
      }
      toolbar={
        !id ? (
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
        ) : undefined
      }
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
                {i.level === "error" ? <IconCross /> : <IconCaution />}
              </span>{" "}
              <strong>{i.where}:</strong> <span className="text-muted">{i.message}</span>
            </p>
          ))}
        </div>
      ) : null}

      {/* колонка формы по кадру: ~700px по центру; переключатель языка ушёл в шапку */}
      <div className="mx-auto w-full max-w-[700px]">
        <EditLangProvider value={editLang}>
          {/* «Назва тесту» и «Опис тесту» — видимые подписи НАД пустыми полями (f23_1, f24_1) */}
          <Loc above label={ut("cn.testTitle")} value={draft.title} onChange={(v) => patch({ title: v })} />
          {/* четыре строки: поле описания на кадре f24_1 — 125px при 17/1.55 */}
          <Loc above label={ut("cn.testDescription")} value={draft.description} onChange={(v) => patch({ description: v })} multiline rows={4} />

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

          {/*
            Блоки, открытые из меню шестерёнки. На кадре f23_2 между
            «Результати» и «Створити» пусто, поэтому в потоке их нет: они
            появляются ровно тогда, когда их позвали, и закрываются тем же
            пунктом меню.
          */}
          {tool === "preview" ? (
            <ToolBlock title={ut("co.preview")} onClose={() => setTool(null)}>
              <Preview draft={draft} at={focused} />
            </ToolBlock>
          ) : null}
          {tool === "settings" ? (
            <ToolBlock title={ut("cn.settings")} onClose={() => setTool(null)}>
              <Settings draft={draft} groups={groups} patch={patch} />
            </ToolBlock>
          ) : null}
          {tool === "json" ? (
            <ToolBlock title={ut("cn.jsonSection")} onClose={() => setTool(null)}>
              <p className="m-0 mb-[8px] text-[13px] text-muted">{ut("co.jsonHint")}</p>
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
            </ToolBlock>
          ) : null}
        </EditLangProvider>

        {/* «Створити» 215×45 из f23/f24, отступ сверху 45 — замер кадра f23_2 */}
        <div className="mt-[45px] flex justify-end">
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
 * Блок, открытый из меню шестерёнки: то, чего нет на кадре, но есть у
 * методики. Заголовок и «закрити» — чтобы блок нельзя было принять за часть
 * формы и чтобы закрывался он не только тем же пунктом меню.
 */
function ToolBlock({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { ut } = useLang();
  return (
    <section className="mt-[28px] rounded-[5px] border border-hairline bg-[var(--bg)] px-[20px] py-[12px]">
      <div className="mb-[12px] flex items-center justify-between gap-[14px]">
        <h2 className="m-0 text-[17px] font-bold text-primary">{title}</h2>
        <Button variant="quiet" size="sm" onClick={onClose}>{ut("ui.close")}</Button>
      </div>
      {children}
    </section>
  );
}
