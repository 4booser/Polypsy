import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  DecisionRule,
  ResponseDetail,
  ResponseDetailAnswer,
  RuleHit,
  Scale,
  ScoreResult,
  SurveyFull,
} from "@quizzy/shared";
import { api, openInTab, type ConclusionState } from "../api";
import { ConclusionEditor, buildDraft } from "../components/ConclusionEditor";
import { useLang } from "../lang";
import { Loading, OfflineBar, useAction, useToast } from "../ui";
import { cx } from "../ui/cx";
import { IconGear } from "../ui/glyphs";
import { Page } from "../ui/layout";
import { Button, Field, Input } from "../ui/primitives";
import { useResource } from "../useResource";

/*
 * Экран «Заключення» — кадры макета f38 (три части) и f39 (две части).
 *
 * Два кадра — один экран. f39 рисует его для одного теста: название, описание,
 * вопросы с баллами, лестница результатов, «опитувальник спостереження»,
 * выводы. f38 — тот же экран, но полнее: сверху добавлены название документа,
 * список применённых аналитических моделей с вердиктами и список тестов с
 * набранными баллами. Взят f38 как более полный; из f39 не пропало ничего —
 * его блоки входят в f38 целиком. Где кадры расходятся мелочью (в f39 над
 * описанием стоит подпись «Опис тесту», в f38 — нет), выбран f38.
 *
 * Прежде заключение жило раскрывающейся строкой в таблице прохождений на
 * экране аналитики методики (SurveyAnalytics.tsx): текст без протокола
 * ответов, без лестницы результатов, без баллов вариантов. Разбирающий читал
 * «12 из 30 — умеренная» и, чтобы понять, из чего сложились 12, открывал
 * печатный отчёт. Здесь всё это на одном свитке, как и нарисовано, а печать
 * осталась печатью — за шестерёнкой.
 *
 * Чего на экране нет и почему (подробно — у каждого места ниже):
 *   · «Опитувальник спостереження за пацієнтом» вторым протоколом нарисован,
 *     но пуст: заключение привязано к ОДНОМУ прохождению
 *     (conclusions.responseId), второго источника у него нет. Блок стоит на
 *     своём месте с кадра и честно говорит, чего ждёт от сервера, — иначе
 *     половина кадра f38_2/f39_1 просто исчезла бы без следа;
 *   · «Надіслати поштою»: см. DocumentMenu.
 */

export default function ConclusionPage() {
  const { ut } = useLang();
  const { id } = useParams<{ id: string }>();
  const responseId = id!;

  /*
   * Прохождение и методика грузятся одной загрузкой, а не двумя ресурсами.
   *
   * Методика нужна ради того, чего в прохождении нет: баллов вариантов и
   * лестницы полос. Без неё экран показать нечего — половина свитка пустая,
   * — поэтому «прохождение есть, методики нет» не является состоянием, в
   * котором экран должен что-то рисовать. Одна загрузка даёт одно состояние
   * «готово» и одну ошибку.
   */
  const res = useResource(async () => {
    const detail = await api.responseDetail(responseId);
    const survey = await api.survey(detail.survey.id);
    return { detail, survey };
  }, [responseId]);

  const conclusion = useResource(() => api.conclusion(responseId), [responseId]);

  /*
   * Название документа — поле «Назва заключення» с кадра f38.
   *
   * Живёт здесь, а не в редакторе: поле стоит первым на экране, редактор —
   * последним, а сохраняются они одной записью. Из ответа сервера название
   * берётся только когда оно там есть строкой: столбца title на сервере пока
   * нет (см. api.ts, ConclusionVersion.title), и «нет поля» не должно
   * затирать то, что человек набрал.
   */
  const [title, setTitle] = useState("");
  useEffect(() => {
    const t = conclusion.data?.current?.title;
    if (typeof t === "string") setTitle(t);
  }, [conclusion.data]);

  /*
   * Текст заключения, поле ввода и то, что открыто из меню шестерёнки, живут
   * здесь, а не в редакторе: на кадре f39_2 полоса над текстом занята
   * форматированием, и инструменты редактора (сборка из фактов, библиотека
   * формулировок, история версий, «Зберегти чернетку») ушли в меню документа.
   * Меню стоит в шапке экрана — значит, и текст должен лежать там, откуда его
   * видят оба.
   */
  const [text, setText] = useState("");
  const [tool, setTool] = useState<null | "templates" | "history">(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  /*
   * Черновик подставляется в поле один раз на загрузку. Делать это на каждый
   * рендер значило бы затирать то, что специалист печатает прямо сейчас.
   */
  useEffect(() => {
    const current = conclusion.data?.current;
    setText(current?.status === "draft" ? current.text : "");
  }, [conclusion.data]);

  const surveyId = res.data?.detail.survey.id;
  const models = useResource(() => loadModels(responseId, surveyId!), [responseId, surveyId], {
    enabled: !!surveyId,
  });

  return (
    <Page
      title={ut("cn3.title")}
      actions={
        <DocumentMenu
          responseId={responseId}
          text={text}
          setText={setText}
          tool={tool}
          setTool={setTool}
          state={conclusion.data}
          title={title}
          onState={conclusion.patch}
        />
      }
    >
      {res.offline ? <OfflineBar onRetry={res.reload} busy={res.refreshing} /> : null}
      {!res.data ? (
        <Loading rows={8} error={res.error} onRetry={res.reload} />
      ) : (
        <>
          {/* 605px — ширина поля на кадре; подпись, как везде на макете, внутри поля */}
          <Field label={ut("cn3.name")} className="max-w-[605px]">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </Field>

          <ModelList models={models.data} error={models.error} />

          <TestList detail={res.data.detail} survey={res.data.survey} />

          <TestBody detail={res.data.detail} survey={res.data.survey} />

          <Observation />

          <ConclusionEditor
            responseId={responseId}
            state={conclusion.data}
            error={conclusion.error}
            onState={conclusion.patch}
            title={title}
            text={text}
            setText={setText}
            areaRef={areaRef}
            tool={tool}
            setTool={setTool}
          />
        </>
      )}
    </Page>
  );
}

/* ─────────── шестерёнка ─────────── */

/**
 * Меню документа: «Зберегти як PDF» и «Надіслати поштою», как на макете.
 *
 * PDF — это печатный отчёт GET /api/reports/responses/:id, открытый в новой
 * вкладке: сервер отдаёт разметку, а PDF делает печать браузера. Так решено
 * в reports.ts намеренно (нет серверной зависимости на рендер PDF), и здесь
 * пункт меню ведёт ровно туда, куда вела кнопка «Друк».
 *
 * Почта остаётся пунктом меню, но не действием: маршрута отправки нет, а
 * почтовый транспорт системы по решению в lib/notify.ts не носит
 * персональных данных вовсе. Нажатие честно говорит об этом сообщением, а не
 * молчит и не делает вид. Убрать пункт значило бы спрятать от заказчика, что
 * вопрос об отправке заключения за контур учреждения ещё не решён.
 */
export function DocumentMenu({
  responseId,
  text,
  setText,
  tool,
  setTool,
  state,
  title,
  onState,
}: {
  responseId: string;
  /** Текст черновика: инструменты редактора живут в этом меню, см. ConclusionEditor */
  text?: string;
  setText?: (next: string) => void;
  tool?: null | "templates" | "history";
  setTool?: (next: null | "templates" | "history") => void;
  state?: ConclusionState | null;
  title?: string;
  onState?: (next: ConclusionState) => void;
}) {
  const { ut } = useLang();
  const { run } = useAction();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    /* нажатие мимо меню закрывает его; фокус при этом никуда не возвращается — он ушёл туда, куда нажали */
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  /*
   * Стрелки ходят по пунктам: у role="menu" диктор обещает пользователю
   * именно такое поведение, и Tab, уводящий из меню на страницу, его бы
   * обманул.
   */
  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        ref={buttonRef}
        size="glyph"
        aria-label={ut("cn3.actions")}
        aria-haspopup="menu"
        aria-expanded={open}
        /* ссылка на меню — только пока оно есть: закрытое не в разметке, а idref в пустоту — ошибка ARIA */
        aria-controls={open ? "conclusion-menu" : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <IconGear />
      </Button>
      {open ? (
        <div
          id="conclusion-menu"
          role="menu"
          aria-label={ut("cn3.actions")}
          onKeyDown={onMenuKey}
          /*
            Белая плашка с тенью, пункты прижаты к правому краю — как на кадре.
            Тень — токен, а не число: в тёмной теме плашка белой не будет.
          */
          className="absolute right-0 top-[calc(100%+8px)] z-30 flex min-w-[165px] flex-col items-stretch rounded-[5px] bg-[var(--bg)] py-[8px] shadow-pop"
        >
          <MenuItem
            autoFocus
            onClick={() => {
              setOpen(false);
              void run(() => openInTab(api.reportUrl(responseId)));
            }}
          >
            {ut("cn3.savePdf")}
          </MenuItem>
          <MenuItem
            onClick={() => {
              setOpen(false);
              toast(ut("cn3.mailUnavailable"), "info");
            }}
          >
            {ut("cn3.sendMail")}
          </MenuItem>
          {/*
            Инструменты редактора заключения: на кадре f39_2 полоса над
            текстом занята форматированием, и они ушли сюда — «Зібрати з
            результатів», библиотека формулировок, история версий и
            «Зберегти чернетку». Меню принимает их пунктами, а открывают они
            блоки под полем текста (см. ConclusionEditor).
          */}
          {setText && setTool && state ? (
            <>
              <hr className="my-1 border-0 border-t border-hairline" />
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  void run(async () => {
                    if (text?.trim() && !window.confirm(ut("cn.draftReplaced"))) return false;
                    setText(await buildDraft(responseId, ut as unknown as (k: never) => string));
                  });
                }}
              >
                {ut("cn.fromResults")}
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  setTool(tool === "templates" ? null : "templates");
                }}
              >
                {ut("tpl.insert")}
              </MenuItem>
              {state.versions.length > 1 ? (
                <MenuItem
                  onClick={() => {
                    setOpen(false);
                    setTool(tool === "history" ? null : "history");
                  }}
                >
                  {tool === "history" ? ut("cn.hideHistory") : `${ut("cnc.showHistory")} (${state.versions.length})`}
                </MenuItem>
              ) : null}
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  void run(async () => {
                    onState?.(await api.saveConclusion(responseId, text ?? "", state.current?.version ?? 0, title ?? ""));
                  }, ut("cn.draftSaved"));
                }}
              >
                {ut("cnc.saveDraft")}
              </MenuItem>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({ children, onClick, autoFocus }: { children: ReactNode; onClick: () => void; autoFocus?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      autoFocus={autoFocus}
      onClick={onClick}
      /* `min-h-0` и `border-0` гасят рамку и высоту глобального правила для button из наследия */
      className={cx(
        "min-h-0 rounded-[4px] border-0 bg-transparent px-[16px] py-[6px] text-right text-[15px] text-text-2",
        "transition-colors duration-[var(--dur-fast)] hover:bg-primary-soft hover:text-primary",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
      )}
    >
      {children}
    </button>
  );
}

/* ─────────── список моделей ─────────── */

export interface AppliedModel {
  id: string;
  title: string;
  /** Описание модели: пояснение к правилу, а для сработавшей — объяснение движка */
  description: string;
  matched: boolean;
}

/**
 * Аналитические модели экрана — это правила поддержки решений (decision_rules)
 * с вердиктом по этому прохождению.
 *
 * Вердикт собирается из двух списков, потому что третьего нет: сервер пишет
 * rule_hits только для сработавших правил, «не сработало» не записывается
 * нигде. Значит: правило есть в списке правил и есть срабатывание по этому
 * прохождению — «відповідає умовам»; правило есть, срабатывания нет — «не
 * відповідає». Это честно ровно настолько, насколько правило существовало в
 * момент сдачи: заведённое позже правило покажется «не відповідає», хотя его
 * никто не проверял. Маршрут «модели и вердикты по прохождению» закрыл бы
 * эту дыру, и он назван в отчёте как нехватка сервера.
 *
 * Сопоставление по названию, а не по идентификатору: в срабатывании нет
 * ruleId, только ruleTitle. Два правила с одним названием сольются — цена
 * известна и тоже названа в отчёте.
 *
 * Правила, чьи условия смотрят на шкалу другой методики, к этому прохождению
 * не относятся и в список не попадают; выключенные — тоже.
 */
export function applicableModels(
  rules: (DecisionRule & { note: string | null })[],
  hits: RuleHit[],
  responseId: string,
  surveyId: string,
): AppliedModel[] {
  const mine = hits.filter((h) => h.responseId === responseId);
  const hitByTitle = new Map(mine.map((h) => [h.ruleTitle, h]));
  return rules
    .filter((r) => r.enabled)
    .filter((r) => r.conditions.every((c) => c.kind !== "scale" || !c.surveyId || c.surveyId === surveyId))
    .map((r) => {
      const hit = hitByTitle.get(r.title);
      return {
        id: r.id,
        title: r.title,
        description: r.note ?? hit?.explanation.because.map((b) => b.text).join("; ") ?? "",
        matched: hit !== undefined,
      };
    });
}

async function loadModels(responseId: string, surveyId: string): Promise<AppliedModel[]> {
  /*
   * Срабатывания читаются по всем трём состояниям: принятое и отклонённое
   * предложение — всё равно срабатывание, модель условиям соответствовала.
   */
  const [rules, suggested, accepted, declined] = await Promise.all([
    api.decisionRules(),
    api.ruleHits("suggested"),
    api.ruleHits("accepted"),
    api.ruleHits("declined"),
  ]);
  return applicableModels(rules, [...suggested, ...accepted, ...declined], responseId, surveyId);
}

/**
 * Заголовок раздела свитка — 18/700 фиолетовым, вторая ступень макета, — и
 * при нём действие («+»).
 *
 * Действие стоит РЯДОМ с h2, а не внутри него. Имя заголовка для диктора
 * собирается из его содержимого, и ссылка внутри h2 приклеивала бы свою
 * подпись к имени раздела: «Список тестів Додати тест: призначити батарею» —
 * так назывались бы и заголовок, и секция, которая ссылается на него через
 * aria-labelledby. Картинка при этом та же: ряд из заголовка и глифа.
 */
export function SectionHead({ id, action, children }: { id: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-[14px]">
      <h2 id={id} className="m-0 text-[18px] font-bold leading-tight text-primary">
        {children}
      </h2>
      {action}
    </div>
  );
}

function ModelList({ models, error }: { models: AppliedModel[] | null; error: string | null }) {
  const { ut } = useLang();
  return (
    <section aria-labelledby="cn-models" className="mt-[50px]">
      {/*
        «+» у заголовка — как на кадре f38_1, тем же глифом, что у «Списку
        тестів». В первой редакции его здесь не было: считалось, что экрана
        моделей в консоли нет и вести некуда. Экран есть — /analytics/new
        (App.tsx), — и «+» ведёт туда: завести аналитическую модель.
      */}
      <SectionHead id="cn-models" action={<AddGlyph to="/analytics/new" label={ut("cn3.models")} />}>
        {ut("cn3.models")}
      </SectionHead>
      {/*
        Отказ показывается словами, а не пустотой: у специалиста без права
        alerts.review список правил закрыт, и «моделей нет» было бы неправдой.
        Сначала человеческая подпись, за ней — текст сервера с номером
        запроса: подпись говорит, что случилось, номер даёт найти запись в
        логе (см. api.ts).
      */}
      {error ? (
        <p className="m-0 mt-[20px] text-[13px] text-muted">
          {ut("cn3.modelsUnavailable")}: {error}
        </p>
      ) : models === null ? (
        <p className="m-0 mt-[20px] text-[13px] text-muted">{ut("common.loading")}</p>
      ) : models.length === 0 ? (
        <p className="m-0 mt-[20px] text-[13px] text-muted">{ut("cn3.modelsNone")}</p>
      ) : (
        /*
          Шаг строк с кадра: 60 у моделей (имя в две строки — 40) и 54 у
          тестов (описание в две строки — 34), то есть высота строки плюс 20.
        */
        <ul className="m-0 mt-[30px] flex list-none flex-col gap-[20px] p-0">
          {models.map((m) => (
            <li
              key={m.id}
              /* три колонки кадра: имя 200, описание по остатку, вердикт 196 */
              className="grid grid-cols-[200px_1fr_196px] items-center gap-x-[18px] max-[900px]:grid-cols-1 max-[900px]:gap-y-[6px]"
            >
              {/* кадр f38_1: cap имени и вердикта 12 px → 17/700, описание 9 px → 13/400 */}
              <span className="text-[17px] font-bold leading-[22px] text-primary">{m.title}</span>
              <span className="text-[13px] leading-[17px] text-muted">{m.description}</span>
              {/*
                Вердикт — пилюля 195×30 с заливкой, текст 17/700. Оба вердикта
                выглядят одинаково и отличаются словами, не цветом: на кадре
                так, и для дальтоника так лучше.
              */}
              <span
                data-verdict={m.matched ? "matched" : "not-matched"}
                className="flex h-[30px] items-center justify-center rounded-[5px] bg-primary-soft px-[10px] text-[17px] font-bold leading-none text-primary"
              >
                {m.matched ? ut("cn3.matched") : ut("cn3.notMatched")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ─────────── список тестов ─────────── */

/**
 * Список тестов заключения. Строка одна: заключение привязано к одному
 * прохождению. Когда связь «заключение → несколько прохождений» появится на
 * сервере, здесь будет map по ним — разметка строки уже на это рассчитана.
 */
function TestList({ detail, survey }: { detail: ResponseDetail; survey: SurveyFull }) {
  const { ut } = useLang();
  /*
   * «+» ведёт к батареям: состав обследования в системе задаётся
   * назначением батареи, а не набирается внутри документа. Это ссылка,
   * а не кнопка, — переход на другой экран, который можно открыть в
   * новой вкладке. Видимый квадрат 27, нажимается 44: тот же приём, что у
   * Button size="glyph" (см. пояснение там), повторён здесь потому, что
   * ссылка кнопкой быть не может.
   */
  return (
    <section aria-labelledby="cn-tests" className="mt-[50px]">
      <SectionHead id="cn-tests" action={<AddGlyph to="/batteries" label={ut("cn3.addTest")} />}>
        {ut("cn3.tests")}
      </SectionHead>
      {/* тот же шаг 20, что у списка моделей */}
      <ul className="m-0 mt-[30px] flex list-none flex-col gap-[20px] p-0">
        <li className="grid grid-cols-[200px_1fr_205px] items-start gap-x-[18px] max-[900px]:grid-cols-1 max-[900px]:gap-y-[6px]">
          <span className="text-[17px] font-bold leading-[22px] text-primary">{survey.title}</span>
          <span className="text-[13px] leading-[17px] text-muted">{survey.description ?? ""}</span>
          <span className="flex flex-col gap-[6px]">
            {detail.scores.map((s) => (
              <span key={s.scaleId} className="flex flex-col">
                {/* кадр f38_1: «набраний бал 72» 11/400 серым, подпись диапазона 13/700 фиолетовым */}
                <span className="text-[11px] leading-[15px] text-muted">
                  {/* у многошкальной методики балл без имени шкалы ничего не значит */}
                  {detail.scores.length > 1 ? `${s.scaleTitle}: ` : ""}
                  {ut("cn3.scored")} <span className="tabular-nums">{s.rawScore}</span>
                </span>
                {s.band ? (
                  <span className="text-[13px] font-bold leading-[17px] text-primary">{s.band.label}</span>
                ) : null}
              </span>
            ))}
          </span>
        </li>
      </ul>
    </section>
  );
}

/**
 * «+» у заголовка раздела: ссылка-глиф, одна на «Список примінених
 * аналітичних моделей» и «Список тестів» — на кадре f38_1 они нарисованы
 * одинаково. Видимый квадрат 27, нажимается 44 (тот же приём, что у Button
 * size="glyph"), повторён здесь потому, что ссылка кнопкой быть не может.
 */
function AddGlyph({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      aria-label={label}
      className={cx(
        "relative inline-flex size-[27px] items-center justify-center rounded-[5px] no-underline",
        "after:absolute after:left-1/2 after:top-1/2 after:size-[44px] after:content-['']",
        "after:-translate-x-1/2 after:-translate-y-1/2",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
      )}
    >
      <PlusGlyph />
    </Link>
  );
}

/** «+» штрихом 5 в квадрате 27 — как нарисован на кадре */
function PlusGlyph() {
  return (
    <svg viewBox="0 0 27 27" aria-hidden focusable="false" className="size-[27px]" stroke="currentColor" strokeWidth={5} strokeLinecap="butt">
      <path d="M13.5 2v23M2 13.5h23" />
    </svg>
  );
}

/**
 * «Опитувальник спостереження за пацієнтом» — второй протокол кадров f38_2 и
 * f39_1: тот же каркас «Питання №N — варианты с баллами — Результати», только
 * заполненный наблюдением специалиста, а не ответами пациента.
 *
 * Источника у него нет. Заключение на сервере держится на одном прохождении
 * (conclusions.responseId), связи «заключення → кілька проходжень» в модели
 * нет, и собрать второй протокол не из чего. Блок нарисован на своём месте с
 * кадра и говорит об этом одной строкой: пустое место под заголовком честнее,
 * чем исчезнувший раздел, — по нему видно, чего экран ждёт от сервера.
 */
function Observation() {
  const { ut } = useLang();
  return (
    <section aria-labelledby="cn-observation" className="mt-[50px]">
      <SectionHead id="cn-observation">{ut("cn3.observation")}</SectionHead>
      <p className="m-0 mt-[20px] text-[13px] text-muted">{ut("cn3.observationNone")}</p>
    </section>
  );
}

/* ─────────── тело теста ─────────── */

/**
 * Тест целиком: название, описание, вопросы с вариантами и баллами,
 * лестница результатов. Вопросы стоят колонкой 700 по центру — так на кадре:
 * протокол у́же описания, и это отделяет его глазом от текста вокруг.
 */
function TestBody({ detail, survey }: { detail: ResponseDetail; survey: SurveyFull }) {
  /*
   * Баллы вариантов берутся из методики по идентификатору варианта.
   *
   * Прохождение (GET /api/responses/:id) отдаёт варианты той версии, которую
   * человек видел, но без баллов; методика (GET /api/surveys/:id) — баллы, но
   * действующей версии. У совпадающих версий идентификаторы те же, и балл
   * находится у каждого варианта. У прохождения на старой версии — не
   * найдётся ни одного: тогда балл известен только у выбранного (он записан
   * в самом ответе — см. QuestionSheet, когда это так), а у остальных
   * печатается прочерк. Прочерк, а не ноль: ноль — это балл, прочерк — его
   * отсутствие.
   */
  const scoreByOption = new Map(survey.questions.flatMap((q) => q.options.map((o) => [o.id, o.score] as const)));
  const scoreOf = (optionId: string) => scoreByOption.get(optionId) ?? null;

  return (
    <article aria-labelledby="cn-test" className="mt-[50px]">
      {/* кадр f38_1: «Тест номер 1» cap 12 px → 17/700, описание под ним 13/400 */}
      <h2 id="cn-test" className="m-0 text-[17px] font-bold leading-[22px] text-primary">
        {survey.title}
      </h2>
      {survey.description ? (
        <p className="m-0 mt-[10px] text-[13px] leading-[17px] text-text-2">{survey.description}</p>
      ) : null}
      <div className="mx-auto mt-[40px] w-full max-w-[700px]">
        {detail.answers.map((a, i) => (
          <QuestionSheet key={a.questionId} n={i + 1} answer={a} scoreOf={scoreOf} />
        ))}
        <ResultLadder scores={detail.scores} scales={survey.scales} />
      </div>
    </article>
  );
}

/**
 * Ячейка протокола: силуэт поля с кадра — 36px, радиус 5, кегль 17.
 *
 * Это НЕ Input и не Textarea. В протоколе нечего вводить: варианты и полосы
 * показываются, а не заполняются. Поле только для чтения осталось бы полем
 * для диктора («редактируемый текст, только чтение» сорок раз подряд) и
 * остановкой для Tab на каждой строке. Поэтому силуэт нарисован на span, а
 * два начертания — те же, что у поля: залитое для выбранного, контурное для
 * остальных.
 *
 * Выбранное отличается не только заливкой: начертание полужирное (так и на
 * кадре) и для диктора рядом стоит скрытая пометка. Заливка одна не прошла
 * бы правило «не только цветом».
 */
function Cell({ on, num, children }: { on: boolean; num?: boolean; children: ReactNode }) {
  return (
    <span
      className={cx(
        "flex min-h-9 items-center rounded-[5px] text-[17px] leading-[20px] text-primary",
        num ? "justify-center px-[6px] tabular-nums" : "px-[12px] py-[6px]",
        on ? "bg-primary-soft font-bold" : "border border-border bg-[var(--bg)]",
      )}
    >
      {children}
    </span>
  );
}

const WITH_OPTIONS = new Set(["single", "multiple", "yesno"]);

/** Ответ, у которого нет вариантов: число, дата, текст, порядок, матрица */
function freeValue(a: ResponseDetailAnswer): string {
  const text = new Map(a.options.map((o) => [o.id, o.text]));
  if (a.ranking?.length) return a.ranking.map((id) => text.get(id) ?? id).join(" → ");
  if (a.matrix)
    return Object.entries(a.matrix)
      .map(([row, opt]) => `${text.get(row) ?? row}: ${text.get(opt) ?? opt}`)
      .join("; ");
  if (a.number !== null) return String(a.number);
  if (a.date) return a.date;
  if (a.optionIds?.length) return a.optionIds.map((id) => text.get(id) ?? id).join(", ");
  return a.text ?? "";
}

/**
 * Один вопрос протокола: заголовок «Питання №N …», под ним строки
 * «вариант | балл». Строка выбранного — залитая, остальные — контурные.
 */
export function QuestionSheet({
  n,
  answer,
  scoreOf,
}: {
  n: number;
  answer: ResponseDetailAnswer;
  scoreOf: (optionId: string) => number | null;
}) {
  const { ut } = useLang();
  const chosen = new Set(answer.optionIds ?? []);
  /*
   * Балл в самом ответе — балл пункта целиком, а не варианта. Вариантом он
   * становится только когда выбран один: у вопроса с несколькими ответами
   * сумма, напечатанная у каждого выбранного, читалась бы как балл каждого.
   */
  const ownScore = chosen.size === 1 ? answer.score : null;
  const withOptions = WITH_OPTIONS.has(answer.type) && answer.options.length > 0;
  const headId = `cn-q-${answer.questionId}`;

  return (
    <section aria-labelledby={headId} className="mb-[40px]">
      {/* кадр f38_2: от заголовка питання до первой строки варианта 20 px */}
      <h3 id={headId} className="m-0 mb-[20px] text-[18px] font-bold leading-[22px] text-primary">
        {ut("cn3.question")}
        {n} {answer.title}
      </h3>
      {withOptions ? (
        <ul className="m-0 list-none p-0">
          {answer.options.map((o) => {
            const on = chosen.has(o.id);
            const score = scoreOf(o.id) ?? (on ? ownScore : null);
            return (
              <li
                key={o.id}
                data-chosen={on ? "yes" : "no"}
                /* 604 + 16 + 80 — замер кадра; шаг строк 51 = 36 + 15 */
                className="mb-[15px] grid grid-cols-[1fr_80px] gap-x-[16px] last:mb-0"
              >
                <Cell on={on}>
                  {o.text}
                  {on ? <span className="sr-only">, {ut("cn3.chosen")}</span> : null}
                </Cell>
                <Cell on={on} num>
                  {score ?? "—"}
                </Cell>
              </li>
            );
          })}
        </ul>
      ) : (
        <div data-chosen={answer.answered ? "yes" : "no"} className="grid grid-cols-[1fr_80px] gap-x-[16px]">
          <Cell on={answer.answered}>{answer.answered ? freeValue(answer) : ut("qh.missing")}</Cell>
          <Cell on={answer.answered} num>
            {answer.score ?? "—"}
          </Cell>
        </div>
      )}
    </section>
  );
}

/** Попала ли полоса — по тому же правилу, что и движок подсчёта (scoring.ts) */
function bandHit(score: ScoreResult, band: Scale["bands"][number]): boolean {
  return score.band !== null && score.value >= band.minScore && score.value <= band.maxScore;
}

/** Числа полос печатаются как заданы: 0.35 — не «0.350000» и не «0» */
const num = (v: number) => String(Math.round(v * 100) / 100);

/**
 * Лестница результатов: все полосы шкалы, попавшая — залитая и полужирная.
 *
 * На кадре лестница одна — методика с одной шкалой. У многошкальной их
 * несколько, и без имени шкалы над каждой они неразличимы; имя печатается
 * только тогда, когда лестниц больше одной, — на одношкальной кадр
 * повторяется буквально.
 *
 * Попадание считается по значению, а не по совпадению подписи: подпись
 * полосы хранится в прохождении на языке момента сдачи, а полосы методики
 * приходят на языке интерфейса, и на русской консоли подписи не совпали бы
 * ни разу.
 */
export function ResultLadder({ scores, scales }: { scores: ScoreResult[]; scales: Scale[] }) {
  const { ut } = useLang();
  const byId = new Map(scales.map((s) => [s.id, s]));
  const rows = scores
    .map((score) => ({ score, scale: byId.get(score.scaleId) }))
    .filter((r): r is { score: ScoreResult; scale: Scale } => !!r.scale && r.scale.bands.length > 0);
  if (!rows.length) return null;

  return (
    <section aria-labelledby="cn-results">
      <h3 id="cn-results" className="m-0 mb-[14px] text-[18px] font-bold leading-[22px] text-primary">
        {ut("cn3.results")}
      </h3>
      {rows.map(({ score, scale }) => (
        <div key={scale.id} className="mb-[24px] last:mb-0">
          {rows.length > 1 ? <p className="m-0 mb-[8px] text-[13px] text-muted">{scale.title}</p> : null}
          <ol className="m-0 list-none p-0">
            {[...scale.bands]
              .sort((a, b) => a.minScore - b.minScore)
              .map((b) => {
                const hit = bandHit(score, b);
                return (
                  <li
                    key={b.id}
                    data-hit={hit ? "yes" : "no"}
                    /* «від [87] до [87] [подпись]» — замер кадра f38_3; шаг строк 51 */
                    className="mb-[15px] grid grid-cols-[auto_87px_auto_87px_1fr] items-center gap-x-[12px] last:mb-0"
                  >
                    <span className="text-[13px] text-muted">{ut("cn3.from")}</span>
                    <Cell on={hit} num>
                      {num(b.minScore)}
                    </Cell>
                    <span className="text-[13px] text-muted">{ut("cn3.to")}</span>
                    <Cell on={hit} num>
                      {num(b.maxScore)}
                    </Cell>
                    <Cell on={hit}>
                      {b.label}
                      {hit ? <span className="sr-only">, {ut("cn3.hit")}</span> : null}
                    </Cell>
                  </li>
                );
              })}
          </ol>
        </div>
      ))}
    </section>
  );
}
