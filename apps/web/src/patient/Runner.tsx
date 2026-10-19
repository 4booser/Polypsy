import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  consentViewOf,
  contentLangNotice,
  isAnswered,
  isQuestionVisible,
  type ConsentAction,
  type ConsentView,
  type Question,
  type ScoreResult,
  type Survey,
  type SurveyFull,
} from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { duration } from "../format";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Ic, KbdHints, Screen, useAction } from "../ui";
import { cx } from "../ui/cx";
import { Button, ButtonLink, SeverityTag, Tag } from "../ui/primitives";
import { useResource } from "../useResource";
import {
  ChoiceInput,
  DateInput,
  InfoNote,
  MatrixInput,
  NumberInput,
  RankingInput,
  ScaleInput,
  TextInput,
  pickChoice,
  pickMatrix,
  type RunnerAnswer,
} from "./answerInputs";
import { ConsentAside, ConsentScreen } from "./ConsentGate";
import { Glyph } from "./icons";
import { drafts, type RunnerDraft } from "./drafts";
import { offlineSafetyPlan, outbox } from "./outbox";
import { PatientFrame } from "./PatientApp";
import { scoreValue } from "./results";
import { Body, COLUMN, CallRows, FactList, HelpLink, PtPanel, instrumentCode, instrumentName } from "./parts";
import { acceptAndResend, attemptClosed, cabinetIo, sendAnswers, type ConsentHold, type SendOutcome, type SubmitBody } from "./sendAnswers";
import { dm, hm, visitWhen, whenSaid } from "./when";

/**
 * Прохождение методики: один пункт на экран.
 *
 * Не список с прокруткой, и это главное решение здесь. У PCL-5 двадцать
 * пунктов, у «большой пятёрки» пятьдесят; списком человек видит, сколько
 * ещё осталось, и на десятом начинает отмечать не глядя — а движок как раз
 * и ловит такие протоколы как недостоверные. Один пункт на экран убирает и
 * ощущение бесконечности, и промахи по соседней кнопке.
 *
 * Вид — язык телефона «Виразної» (vivid_pt_survey, pt-runner-*): рамка
 * кабинета без вкладок, на полосе — выход, методика, «Збережено на цьому
 * пристрої» и «Питання N з M» сегментами; большие плитки ответа с клавишами
 * 1–9, «Назад» и «Далі» по 52, Enter — далі. «Допомога» — в шапке рамки.
 *
 * Время на каждый пункт замеряется отдельно: по нему считается
 * достоверность, и без него протокол выглядит пройденным мгновенно.
 */

/* матрица, ранжирование и дата — той же формы, что у мобилки и сервера (answerInputs.tsx, #168) */
type Answer = RunnerAnswer;

/** Больше пунктов — сплошная полоса: сотня сегментов читается шумом, а не счётом (как у мобилки) */
export const SEGMENTS_MAX = 24;

export default function Runner() {
  const { id } = useParams<{ id: string }>();
  /* методика не перечитывается посреди прохождения: пункты под пальцем не должны меняться */
  const res = useResource(() => api.survey(id!), [id], { enabled: !!id, manual: true });
  return (
    <PatientFrame focus>
      {res.data === null ? (
        <Body>
          <Screen res={res}>{() => null}</Screen>
        </Body>
      ) : (
        <Screen res={res}>{(survey: SurveyFull) => <RunnerFlow key={survey.id} survey={survey} />}</Screen>
      )}
    </PatientFrame>
  );
}

/** Черновик этой методики на устройстве — только той же версии: к обновлённым пунктам прежние ответы не подставляются */
function restoredDraft(userId: string | undefined, survey: SurveyFull): RunnerDraft | null {
  if (!userId) return null;
  const draft = drafts.get(userId, survey.id);
  return draft && draft.versionId === survey.versionId ? draft : null;
}

function RunnerFlow({ survey }: { survey: SurveyFull }) {
  const { ut, lang } = useLang();
  const navigate = useNavigate();
  const { run, busy } = useAction();
  const { user, logout } = useAuth();

  /* продолжение с того же пункта: ответы, время и место — из черновика на устройстве */
  const [resume] = useState(() => restoredDraft(user?.id, survey));
  const [answers, setAnswers] = useState<Map<string, Answer>>(
    () => new Map(Object.entries(resume?.answers ?? {}) as [string, Answer][]),
  );
  /* место — то же, но не дальше последнего видимого пункта: условия показа зависят от ответов */
  const [step, setStep] = useState(() => {
    if (!resume) return 0;
    const restored = new Map(Object.entries(resume.answers));
    const shown = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, restored as never)).length;
    return Math.max(0, Math.min(resume.step, shown - 1));
  });
  /* инструкция прочитана и нажато «Почати» — до этого на экране она, а не первый пункт (#170) */
  const [started, setStarted] = useState(false);
  const [startedAt, setStartedAt] = useState(() => resume?.startedAt ?? new Date().toISOString());
  const [enteredAt, setEnteredAt] = useState(() => Date.now());
  const times = useRef<Map<string, number>>(new Map(Object.entries(resume?.times ?? {})));
  const [saved, setSaved] = useState<{ at: string | null; failed: boolean }>({ at: resume?.savedAt ?? null, failed: false });
  /* queued — ответы легли ждать на устройстве (идут работы или нет сети), а не на сервер */
  const [done, setDone] = useState<{
    safetyPlan: string | null;
    queued: boolean;
    scores: ScoreResult[];
    id: string | null;
    at: string;
  } | null>(null);
  /*
   * Сдача, которую сервер не принял без новой редакции согласия (#171):
   * держится здесь целиком, пока человек читает текст на месте, и уходит
   * та же после «Погоджуюся». Свой вид поверх — отказ и возврат к тексту.
   */
  const [hold, setHold] = useState<ConsentHold | null>(null);
  const [consentOverride, setConsentOverride] = useState<ConsentView | null>(null);
  /* строка матрицы, куда идут клавиши 1–9: последняя тронутая */
  const [activeRow, setActiveRow] = useState<string | null>(null);

  /* что ещё назначено и до какого срока — для строки срока и «що далі» */
  const list = useResource(() => api.surveys(), []);
  const listed = list.data?.find((s) => s.id === survey.id) ?? null;

  /*
   * Фокус переезжает на заголовок нового пункта.
   *
   * Нажал «Далі» с клавиатуры — вопрос сменился, а фокус упал бы в body,
   * потому что нажатая кнопка на мгновение пропадает из разметки. Перевод
   * фокуса и называет диктору новый пункт (вместе с номером — см. ниже), и
   * продолжает табуляцию с него: следующий Tab попадает на первый вариант.
   */
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [step, started, done, hold]);

  /* id заголовка: им называются поля ввода, у которых своей подписи нет */
  const titleId = useId();
  const helpId = useId();

  const visible = useMemo(
    () => survey.questions.filter((q) => isQuestionVisible(q, survey.questions, answers as never)),
    [survey.questions, answers],
  );
  const asked = visible.filter((q) => q.type !== "info");
  const current: Question | undefined = visible[step];

  /*
   * Английский интерфейс, а пункты — на украинском (английского текста у
   * методик нет, см. CONTENT_LANGS). Тот же язык — атрибутом lang на тексте
   * методики: страница объявлена английской, и диктор читал бы украинские
   * пункты английским голосом (WCAG 3.1.2).
   */
  const foreign = contentLangNotice(lang, survey.contentLang);
  const partLang = foreign ?? undefined;

  /*
   * Черновик на устройстве — после каждого ответа и каждого шага. Пока
   * человек ничего не ответил, писать нечего: открытая и закрытая методика
   * не должна становиться «почато».
   */
  const answeredCount = asked.filter((q) => isAnswered(q as never, answers.get(q.id) as never)).length;
  useEffect(() => {
    if (!user || done || hold || !answers.size) return;
    const at = new Date().toISOString();
    const ok = drafts.save(user.id, {
      surveyId: survey.id,
      versionId: survey.versionId,
      title: survey.title,
      answers: Object.fromEntries(answers) as RunnerDraft["answers"],
      times: Object.fromEntries(times.current),
      step,
      total: asked.length,
      answered: answeredCount,
      startedAt,
      savedAt: at,
    });
    setSaved({ at: ok ? at : null, failed: !ok });
    /* пишется по ответам и шагу; остальное — производное от них */
  }, [answers, step]);

  const leave = () => navigate("/me/tests");

  /* в очередь — с названием: отвергнутую сдачу человек узнаёт в кабинете по методике (OutboxPanel, #172) */
  const io = cabinetIo(user ? (surveyId, body) => outbox.enqueue(user.id, surveyId, body, survey.title) : null);

  /* исход сдачи → экран; ложь — «надіслано» не показывать */
  const settle = (outcome: SendOutcome, body: SubmitBody): boolean => {
    if (outcome.kind === "consent") {
      setHold(outcome);
      setConsentOverride(null);
      return false;
    }
    setHold(null);
    /* сдано или легло в очередь — черновик больше не нужен и не должен всплыть «продолжением» */
    if (user) drafts.drop(user.id, survey.id);
    if (outcome.kind === "sent") {
      setDone({
        safetyPlan: outcome.safetyPlan,
        queued: false,
        scores: outcome.scores ?? [],
        id: outcome.id ?? null,
        at: outcome.submittedAt ?? new Date().toISOString(),
      });
      return true;
    }
    /* отложенная сдача: «надіслано» было бы неправдой; памятка — по тем же ответам, что легли ждать */
    setDone({
      safetyPlan: offlineSafetyPlan(survey, body.answers as never, user),
      queued: true,
      scores: [],
      id: null,
      at: new Date().toISOString(),
    });
    return false;
  };

  const consentView = hold ? (consentOverride ?? consentViewOf(hold.status)) : null;
  if (hold && consentView && consentView.kind !== "pass") {
    const held = hold;
    const onConsent: Record<ConsentAction, () => void> = {
      /* та же сдача — тем же телом и clientRequestId; не прошла — ответы снова на экране, отказ тостом */
      accept: () =>
        void run(async () => {
          try {
            return settle(await acceptAndResend(io, held, ut("common.error")), held.body);
          } catch (error) {
            setHold(null);
            throw error;
          }
        }, ut("pw.sent")),
      decline: () => {
        void api.declineConsent().catch(() => {});
        setConsentOverride({ kind: "declined" });
      },
      reconsider: () => setConsentOverride(null),
      retry: () =>
        void run(async () => {
          const status = await api.consentStatus();
          if (consentViewOf(status).kind === "pass") return settle(await sendAnswers(io, held.surveyId, held.body), held.body);
          setHold({ ...held, status, error: null });
          setConsentOverride(null);
          return false;
        }),
      signOut: () => logout(),
    };
    return (
      <ConsentScreen
        view={consentView}
        busy={busy}
        error={held.error}
        note={ut("pw.consentHeld")}
        version={held.status.version}
        onAction={(action) => onConsent[action]()}
        aside={<ConsentAside />}
        after={
          <Button variant="ghost" size="md" icon={<Ic.undo size={18} />} disabled={busy} onClick={() => setHold(null)}>
            {ut("pw.backToAnswers")}
          </Button>
        }
      />
    );
  }

  if (done) {
    return (
      <DoneView
        survey={survey}
        done={done}
        asked={asked.length}
        took={Date.now() - new Date(startedAt).getTime()}
        headingRef={headingRef}
        listed={list.data ?? []}
        onLeave={leave}
      />
    );
  }

  if (!current) {
    return (
      <>
        <RunnerBar title={survey.title} partLang={partLang} onLeave={leave} />
        <Body>
          <p className="m-0 text-muted">{ut("pw.empty")}</p>
        </Body>
      </>
    );
  }

  const due = listed?.assigned && listed.dueAt ? listed.dueAt : null;
  const resumable = !!resume && answeredCount > 0;

  if (!started && hasIntro(survey)) {
    return (
      <>
        <RunnerBar
          title={survey.title}
          partLang={partLang}
          onLeave={leave}
          status={due ? <Tag tone="primary" icon={<Ic.calendar size={12} />}>{`${ut("ptw.dueUntil")} ${dm(due)}`}</Tag> : null}
        />
        <RunnerIntro
          survey={survey}
          count={asked.length}
          partLang={partLang}
          foreign={foreign}
          headingRef={headingRef}
          resume={resumable ? { answered: answeredCount, savedAt: resume?.savedAt ?? null } : null}
          onLeave={leave}
          onRestart={() => {
            if (user) drafts.drop(user.id, survey.id);
            setAnswers(new Map());
            times.current = new Map();
            setStep(0);
            setSaved({ at: null, failed: false });
            setStartedAt(new Date().toISOString());
            setEnteredAt(Date.now());
            setStarted(true);
          }}
          onStart={() => {
            /* время ответа и длительность — с первого пункта, а не с чтения инструкции (как в мобилке); продолжение хранит своё начало */
            if (!resumable) setStartedAt(new Date().toISOString());
            setEnteredAt(Date.now());
            setStarted(true);
          }}
        />
      </>
    );
  }

  const a = answers.get(current.id);
  const choices = current.options.filter((o) => o.kind === "option");
  const answered = current.type === "info" || isAnswered(current as never, a as never);
  const canAdvance = !current.required || answered;
  const last = step === visible.length - 1;
  const askedIndex = asked.findIndex((q) => q.id === current.id);

  const remember = () => {
    times.current.set(current.id, (times.current.get(current.id) ?? 0) + (Date.now() - enteredAt));
    setEnteredAt(Date.now());
  };

  const set = (next: Answer) => {
    setAnswers((prev) => new Map(prev).set(current.id, { ...prev.get(current.id), ...next }));
  };

  /*
   * «Питання 7 з 20» — на полосе и диктору. Информационные пункты вопросами
   * не нумеруются: у них нет ответа, и назвать такой пункт вопросом значило
   * бы соврать. Так же считает мобильное приложение — строки те же самые.
   */
  const position =
    current.type === "info"
      ? ut("runner.info")
      : `${ut("runner.question")} ${askedIndex + 1} ${ut("common.of")} ${asked.length}`;

  const submit = () =>
    run(async () => {
      remember();
      const payload = visible
        .filter((q) => q.type !== "info")
        .map((q) => ({
          questionId: q.id,
          ...(answers.get(q.id) ?? {}),
          durationMs: times.current.get(q.id) ?? 0,
          changeCount: 0,
          visitCount: 1,
        }));
      const body: SubmitBody = {
        // версия, которую показали: очередь может досылать сдачу, когда действует уже другая
        versionId: survey.versionId,
        startedAt,
        durationMs: Date.now() - new Date(startedAt).getTime(),
        answers: payload as never,
        events: [],
        // id сдачи — с первой попытки: повтор из очереди сервер узнает как дубль
        clientRequestId: crypto.randomUUID(),
      };
      /*
       * Временный отказ (работы, перезапуск, нет сети) кладёт ответы в
       * очередь кабинета, отказ без новой редакции согласия держит их
       * здесь до принятия (sendAnswers.ts). Отказ по существу — тостом,
       * ответы остаются на экране; «вже проходили» ещё и стирает черновик:
       * сдать его больше нельзя.
       */
      try {
        return settle(await sendAnswers(io, survey.id, body), body);
      } catch (error) {
        if (user && attemptClosed(error)) drafts.drop(user.id, survey.id);
        throw error;
      }
    }, ut("pw.sent"));

  const goNext = () => {
    if (!canAdvance || busy) return;
    if (last) {
      void submit();
      return;
    }
    remember();
    setActiveRow(null);
    setStep(step + 1);
  };

  const goBack = () => {
    if (!canGoBack(survey, step)) return;
    remember();
    setActiveRow(null);
    setStep(step - 1);
  };

  const matrixRows = current.type === "matrix" ? current.options.filter((o) => o.kind === "row") : [];
  const matrixCols = current.type === "matrix" ? choices : [];
  const missingRows = matrixRows.filter((r) => !a?.matrix?.[r.id]);
  const flagMissing = current.type === "matrix" && missingRows.length > 0 && missingRows.length < matrixRows.length;

  return (
    <>
      <RunnerBar
        title={survey.title}
        partLang={partLang}
        onLeave={leave}
        status={<SaveState saved={saved} />}
        progress={
          survey.showProgress ? (
            <Progress
              label={position}
              number={current.type === "info" ? null : askedIndex + 1}
              total={asked.length}
              current={current.type === "info" ? -1 : askedIndex}
              isDone={(i) => isAnswered(asked[i] as never, answers.get(asked[i]!.id) as never)}
            />
          ) : null
        }
      />
      <QuestionKeys
        question={current}
        answer={a}
        choices={choices}
        rows={matrixRows.map((r) => r.id)}
        columns={matrixCols.map((c) => c.id)}
        activeRow={activeRow}
        setActiveRow={setActiveRow}
        onPick={set}
        onNext={goNext}
      />
      <div className={cx(COLUMN, "pb-14 pt-8 max-[600px]:pt-5")}>
        <div className={cx("mx-auto", current.type === "matrix" ? "max-w-[1000px]" : "max-w-[760px]")}>
          {foreign && step === 0 && !hasIntro(survey) ? (
            <p className="m-0 mb-3 text-[14px] text-muted">{ut(`contentLang.${foreign}`)}</p>
          ) : null}
          {sectionTitle(survey, current) ? (
            <p lang={partLang} className="m-0 mb-2.5 text-[17px] font-semibold leading-[25px] text-text-2">
              {sectionTitle(survey, current)}
            </p>
          ) : null}
          {/*
            tabIndex={-1} — чтобы сюда можно было увести фокус после смены
            пункта. Мышью на заголовок не попасть: -1 убирает его из
            табуляции, оставляя доступным программно.
          */}
          <h1
            ref={headingRef}
            id={titleId}
            tabIndex={-1}
            className="m-0 text-balance rounded-sm text-[32px] font-extrabold leading-10 tracking-[-0.025em] text-text outline-none max-[600px]:text-[25px] max-[600px]:leading-[33px]"
          >
            <span className="sr-only">{position}. </span>
            <span lang={partLang}>{current.title}</span>
          </h1>
          {current.help ? (
            <p id={helpId} lang={partLang} className="m-0 mt-2 text-[17px] font-medium leading-[25px] text-text-2">
              {current.help}
            </p>
          ) : null}

          <div className="mt-[26px]">
            {/* у матрицы и ранжирования тоже есть варианты — их ветки раньше общей кнопочной */}
            {current.type === "matrix" ? (
              <MatrixInput
                question={current}
                answer={a}
                onChange={set}
                partLang={partLang}
                flagMissing={flagMissing}
                onRowFocus={setActiveRow}
              />
            ) : current.type === "ranking" ? (
              <RankingInput question={current} answer={a} onChange={set} partLang={partLang} />
            ) : current.type === "date" ? (
              <DateInput answer={a} onChange={set} labelledBy={titleId} describedBy={current.help ? helpId : undefined} />
            ) : choices.length ? (
              <ChoiceInput
                question={current}
                answer={a}
                onChange={set}
                partLang={partLang}
                labelledBy={titleId}
                describedBy={current.help ? helpId : undefined}
              />
            ) : current.type === "scale" || current.type === "slider" ? (
              <ScaleInput
                question={current}
                answer={a}
                onChange={set}
                partLang={partLang}
                labelledBy={titleId}
                describedBy={current.help ? helpId : undefined}
              />
            ) : current.type === "number" ? (
              /*
                Имя поля — сам вопрос, через aria-labelledby: вопрос уже
                напечатан заголовком во весь экран, и вторая подпись под ним
                читалась бы как ошибка. Без ссылки диктор произносил «поле
                ввода» на экране, который весь состоит из одного вопроса.
              */
              <NumberInput
                question={current}
                answer={a}
                onChange={set}
                labelledBy={titleId}
                describedBy={current.help ? helpId : undefined}
              />
            ) : current.type === "info" ? (
              <InfoNote>{ut("ptw.infoStep")}</InfoNote>
            ) : (
              <TextInput answer={a} onChange={set} labelledBy={titleId} describedBy={current.help ? helpId : undefined} />
            )}
          </div>

          {flagMissing && current.required ? (
            <p role="status" className="m-0 mt-3.5 flex items-center gap-2 text-[15px] font-semibold leading-[21px] text-warn">
              <Glyph name="arrow-down-dot" size={18} className="shrink-0" />
              {missingRows.length === 1
                ? ut("ptw.mxOneLeft").replace("{row}", missingRows[0]!.text)
                : ut("ptw.mxLeft").replace("{n}", String(missingRows.length))}
            </p>
          ) : null}

          <div className="mt-7 flex items-stretch gap-2.5">
            {/* «Назад» — только где автор методики разрешил возврат (allowBack, #170); на первом пункте — выключена */}
            {survey.allowBack !== false ? (
              <Button
                size="lg"
                icon={<Ic.chevronLeft size={20} />}
                className="flex-1"
                disabled={!canGoBack(survey, step)}
                onClick={goBack}
              >
                {ut("common.back")}
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="lg"
              className="flex-[2]"
              disabled={busy || !canAdvance}
              onClick={goNext}
              iconEnd={
                <>
                  {last ? <Glyph name="send" size={18} /> : <Ic.chevronRight size={20} />}
                  <span aria-hidden className="ml-1.5 max-[760px]:hidden">
                    <kbd className={buttonKey}>Enter</kbd>
                  </span>
                </>
              }
            >
              {last ? ut("pw.finish") : ut("common.next")}
            </Button>
          </div>
          <KbdHints
            className="mt-4 justify-center text-[13px]"
            keys={
              current.type === "matrix"
                ? [
                    ["↑ ↓", ut("ptw.keyRow")],
                    [matrixCols.slice(0, 9).map((_, i) => i + 1).join(" "), ut("ptw.keyInRow")],
                    ["Enter", ut("ptw.keyNext")],
                  ]
                : choices.length && current.type !== "ranking"
                  ? [
                      [choices.slice(0, 9).map((_, i) => i + 1).join(" "), ut("ptw.keyPick")],
                      ...(current.type === "multiple" ? [] : ([["↑ ↓", ut("ptw.keyBetween")]] as [string, string][])),
                      ["Enter", ut("ptw.keyNext")],
                    ]
                  : [["Enter", ut("ptw.keyNext")]]
            }
          />
        </div>
      </div>
    </>
  );
}

/**
 * Клавиша на фиолетовой кнопке («Далі Enter»): чернилами заливки в обеих
 * темах. Клавиша подсказки (Kbd onTip) рассчитана на тёмную плашку и в тёмной
 * теме на фиолетовом читалась бы на 2:1.
 */
const buttonKey =
  "inline-grid h-5 min-w-5 place-items-center rounded-[6px] border border-b-2 border-onfill-muted bg-transparent px-[5px] font-sans text-[10.5px] font-bold not-italic leading-none text-onfill";

/** Заголовок раздела над пунктом — рамка ответа для нескольких пунктов подряд */
function sectionTitle(survey: SurveyFull, q: Question): string | null {
  if (!q.sectionId) return null;
  return survey.sections.find((s) => s.id === q.sectionId)?.title?.trim() || null;
}

/**
 * Клавиши пункта: 1–9 выбирают вариант (в матрице — в текущей строке),
 * ↑ ↓ в матрице ходят по строкам, Enter — далі. В полях ввода клавиши
 * принадлежат полю; кнопки и ссылки, кроме плиток ответа, Enter нажимает
 * сами. Открытый ящик или окно («Допомога») клавиш не отдаёт.
 */
function QuestionKeys({
  question,
  answer,
  choices,
  rows,
  columns,
  activeRow,
  setActiveRow,
  onPick,
  onNext,
}: {
  question: Question;
  answer: Answer | undefined;
  choices: { id: string }[];
  rows: string[];
  columns: string[];
  activeRow: string | null;
  setActiveRow: (row: string | null) => void;
  onPick: (next: Answer) => void;
  onNext: () => void;
}) {
  const handler = useRef<(e: KeyboardEvent) => void>(() => {});
  handler.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    if (document.querySelector("[aria-modal='true']")) return;
    const tile = !!target?.closest("[data-opt], [data-cell]");

    if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key) - 1;
      if (question.type === "matrix") {
        const row = (activeRow && rows.includes(activeRow) ? activeRow : null) ?? rows.find((r) => !answer?.matrix?.[r]) ?? rows[0];
        const col = columns[n];
        if (!row || !col) return;
        e.preventDefault();
        onPick(pickMatrix(answer, row, col));
        /* следующая строка без ответа — туда пойдёт следующая цифра */
        const nextRow = rows.find((r) => r !== row && !answer?.matrix?.[r]);
        setActiveRow(nextRow ?? row);
        return;
      }
      if (question.type === "ranking") return;
      const option = choices[n];
      if (!option) return;
      e.preventDefault();
      onPick(pickChoice(question, answer, option.id));
      return;
    }

    if (question.type === "matrix" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const at = Math.max(0, rows.indexOf(activeRow ?? rows[0] ?? ""));
      const next = rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
      if (!next) return;
      e.preventDefault();
      setActiveRow(next);
      const group = document.querySelector<HTMLElement>(`[data-row="${next}"]`);
      (group?.querySelector<HTMLElement>("[aria-checked='true']") ?? group?.querySelector<HTMLElement>("[data-cell]"))?.focus();
      return;
    }

    if (e.key === "Enter") {
      if (target?.closest("button, a") && !tile) return;
      e.preventDefault();
      onNext();
    }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => handler.current(e);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
  return null;
}

/* ─────────── полоса прохождения ─────────── */

/**
 * Полоса прохождения на сиреневой полосе рамки (runner_bar «Виразної»):
 * выход, методика с кодом, состояние сохранения и под ними ход.
 */
function RunnerBar({
  title,
  partLang,
  onLeave,
  status,
  progress,
}: {
  title: string;
  partLang?: string;
  onLeave: () => void;
  status?: ReactNode;
  progress?: ReactNode;
}) {
  const { ut } = useLang();
  const code = instrumentCode(title);
  return (
    <section className="border-b border-band-card-line bg-band">
      <div className={cx(COLUMN, "pb-5 pt-0.5")}>
        <div className="flex min-h-12 items-center gap-3.5 max-[600px]:gap-2">
          {/*
            Выход есть всегда: человек, открывший методику случайно или
            передумавший, не должен оставаться внутри — это читается как
            принуждение. Ответы при выходе не теряются: черновик на устройстве.
          */}
          <Button variant="ghost" icon={<Ic.x size={19} />} onClick={onLeave} className="-ml-3.5 max-[600px]:-ml-2">
            <span className="max-[600px]:sr-only">{ut("pw.leave")}</span>
          </Button>
          <span aria-hidden className="h-[26px] w-px shrink-0 bg-band-card-line" />
          <span className="flex min-w-0 items-center gap-3">
            <b lang={partLang} className="truncate text-[20px] font-extrabold leading-[26px] tracking-[-0.02em] text-text max-[600px]:text-[17px]">
              {instrumentName(title)}
            </b>
            {code ? (
              <span className="inline-flex h-[26px] shrink-0 items-center rounded-[13px] bg-band-card px-[9px] text-[12.5px] font-bold text-violet-ink shadow-[inset_0_0_0_1px_var(--bcardline)] max-[600px]:hidden">
                {code}
              </span>
            ) : null}
          </span>
          {status ? <span className="ml-auto shrink-0">{status}</span> : null}
        </div>
        {progress}
      </div>
    </section>
  );
}

/** «Збережено на цьому пристрої, 16:46» — или что сохранять ещё нечего, или что не вышло */
function SaveState({ saved }: { saved: { at: string | null; failed: boolean } }) {
  const { ut } = useLang();
  const text = saved.failed
    ? ut("ptw.saveFailed")
    : saved.at
      ? `${ut("ptw.savedOnDevice")}, ${hm(saved.at)}`
      : ut("ptw.savesOnPick");
  return (
    <span
      role="status"
      title={ut("ptw.savesOnPick")}
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-[14px] font-bold",
        saved.failed ? "text-warn" : "text-text-2",
      )}
    >
      {saved.failed ? (
        <Ic.cloudOff size={18} />
      ) : (
        <Ic.cloudCheck size={18} className={saved.at ? "text-good" : "text-muted"} />
      )}
      <span className="max-[760px]:sr-only">{text}</span>
    </span>
  );
}

/**
 * Ход: «Питання 3 з 7» и сегменты — по одному на вопрос: пройденные
 * залиты, текущий обведён, впереди — дорожка. Больше SEGMENTS_MAX — сплошная
 * полоса. Для диктора — роль progressbar с тем же «Питання 3 з 7».
 */
function Progress({
  label,
  number,
  total,
  current,
  isDone,
}: {
  label: string;
  number: number | null;
  total: number;
  current: number;
  isDone: (i: number) => boolean;
}) {
  const { ut } = useLang();
  const doneCount = Array.from({ length: total }, (_, i) => isDone(i)).filter(Boolean).length;
  return (
    <div className="mt-1 flex items-center gap-5 max-[600px]:gap-3">
      <span aria-hidden className="inline-flex shrink-0 items-baseline gap-1.5 whitespace-nowrap text-[16px] font-bold text-text-2">
        {number === null ? (
          ut("runner.info")
        ) : (
          <>
            {ut("runner.question")}
            <b className="text-[26px] font-extrabold leading-[30px] tracking-[-0.03em] text-text tabular-nums">{number}</b>
            {ut("common.of")} {total}
          </>
        )}
      </span>
      <div
        role="progressbar"
        aria-label={ut("pw.progress")}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={number ?? doneCount}
        aria-valuetext={label}
        className="flex min-w-0 flex-1 gap-1"
      >
        {total > SEGMENTS_MAX ? (
          <span className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-track">
            <span
              className="block h-full rounded-[3px] bg-[var(--vring)] transition-[width] duration-[var(--dur)]"
              style={{ width: `${Math.round((doneCount / Math.max(1, total)) * 1000) / 10}%` }}
            />
          </span>
        ) : (
          Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={cx(
                "h-1.5 flex-1 rounded-[3px] transition-colors duration-[var(--dur-fast)]",
                i === current
                  ? "bg-violet-line shadow-[inset_0_0_0_1.5px_var(--vring)]"
                  : isDone(i)
                    ? "bg-[var(--vring)]"
                    : "bg-track",
              )}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Есть ли у методики инструкция, которую надо показать до первого пункта.
 *
 * Рамка ответа живёт в инструкции, а не в пунктах: «за останні 2 тижні» у
 * PHQ-9 написано только там. Кабинет начинал сразу с первого пункта, и
 * человек отвечал про всю жизнь, а не про две недели (#170).
 */
export function hasIntro(survey: Pick<Survey, "instructions">): boolean {
  return !!survey.instructions?.trim();
}

/**
 * Можно ли вернуться к прошлому пункту. Методика, запрещающая возврат
 * (allowBack: false), — так задумано её автором: ответ «по первому
 * впечатлению», пересмотр которого меняет то, что меряется (#170).
 */
export function canGoBack(survey: Pick<Survey, "allowBack">, step: number): boolean {
  return survey.allowBack !== false && step > 0;
}

/**
 * Экран инструкции — до первого пункта, как в мобилке (app/survey/[id].tsx,
 * step -1): название, пояснение, инструкция панелью, сколько пунктов и что
 * будет с ответами, «Почати» (Enter). Начатое на этом устройстве —
 * «Продовжити» с того же места или «Почати заново».
 */
export function RunnerIntro({
  survey,
  count,
  partLang,
  foreign,
  headingRef,
  resume,
  onStart,
  onRestart,
  onLeave,
}: {
  survey: Pick<Survey, "title" | "instructions"> & Partial<Pick<Survey, "description" | "allowBack" | "showResultsToPatient">>;
  count: number;
  partLang?: string;
  foreign?: ReturnType<typeof contentLangNotice>;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  /** Начато на этом устройстве: сколько отвечено и когда сохранено */
  resume?: { answered: number; savedAt: string | null } | null;
  onStart: () => void;
  onRestart?: () => void;
  onLeave: () => void;
}) {
  const { ut } = useLang();
  /* Enter — «Почати» (или «Продовжити»), как подписано на кнопке; последняя onStart — через ссылку */
  const start = useRef(onStart);
  start.current = onStart;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, a")) return;
      if (document.querySelector("[aria-modal='true']")) return;
      e.preventDefault();
      start.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const facts = [
    { key: "count", icon: <ShellIcon name="list-checks" size={16} />, title: `${ut("ms.questions")}: ${count}`, text: ut("ptw.factOneScreen") },
    { key: "pause", icon: <Glyph name="save" size={16} />, title: ut("ptw.factPause"), text: ut("ptw.factPauseText") },
    ...(survey.allowBack !== false
      ? [{ key: "back", icon: <Ic.undo size={16} />, title: ut("ptw.factBack"), text: ut("ptw.factBackText") }]
      : []),
    survey.showResultsToPatient
      ? { key: "seen", icon: <Ic.eye size={16} />, title: ut("ptw.factResultShown"), text: ut("ptw.factResultShownText") }
      : { key: "seen", icon: <Ic.eye size={16} />, title: ut("ptw.factResultHidden"), text: ut("ptw.factResultHiddenText") },
  ];

  return (
    <Body>
      <div className="grid grid-cols-[minmax(0,1fr)_400px] items-start gap-8 max-[1099px]:grid-cols-1 max-[1099px]:gap-5">
        <div className="min-w-0">
          <h1
            ref={headingRef}
            tabIndex={-1}
            lang={partLang}
            className="m-0 text-balance rounded-sm text-[36px] font-extrabold leading-[42px] tracking-[-0.03em] text-text outline-none max-[600px]:text-[28px] max-[600px]:leading-[34px]"
          >
            {instrumentName(survey.title)}
          </h1>
          {survey.description?.trim() ? (
            <p lang={partLang} className="m-0 mt-2 max-w-[640px] text-[17px] font-semibold leading-[26px] text-text-2">
              {survey.description}
            </p>
          ) : null}
          {foreign ? <p className="m-0 mt-2 text-[14px] text-muted">{ut(`contentLang.${foreign}`)}</p> : null}
          {resume ? (
            <div className="mt-5 flex items-start gap-3 rounded-panel bg-violet-tint px-4 py-3.5 text-[15px] leading-[22px] text-text-2">
              <Glyph name="hard-drive" size={18} className="mt-0.5 shrink-0 text-violet-ink" />
              <span>
                <b className="block text-[16px] font-extrabold text-text">{ut("ptw.resumeTitle")}</b>
                {ut("ptw.resumeText")
                  .replace("{n}", String(resume.answered))
                  .replace("{total}", String(count))
                  .replace("{when}", resume.savedAt ? whenSaid(resume.savedAt, ut) : "")}
              </span>
            </div>
          ) : null}
          <PtPanel title={ut("ptw.instruction")} icon={<Glyph name="book" size={16} />} className="mt-6">
            <p lang={partLang} className="m-0 whitespace-pre-wrap text-[17px] leading-[27px] text-text">
              {survey.instructions}
            </p>
          </PtPanel>
          <div className="mt-6 flex items-stretch gap-2.5">
            {resume && onRestart ? (
              <Button size="lg" icon={<Glyph name="rotate-ccw" size={18} />} className="flex-1" onClick={onRestart}>
                {ut("ptw.restart")}
              </Button>
            ) : (
              <Button size="lg" icon={<ShellIcon name="log-out" size={18} />} className="flex-1" onClick={onLeave}>
                {ut("ptw.later")}
              </Button>
            )}
            <Button
              variant="primary"
              size="lg"
              className="flex-[2]"
              onClick={onStart}
              iconEnd={
                <>
                  <Ic.arrowRight size={19} />
                  <span aria-hidden className="ml-1.5 max-[760px]:hidden">
                    <kbd className={buttonKey}>Enter</kbd>
                  </span>
                </>
              }
            >
              {resume ? ut("ptw.continue") : ut("ms.start")}
            </Button>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <PtPanel title={ut("ptw.goodToKnow")} icon={<Ic.info size={16} />}>
            <FactList items={facts} />
          </PtPanel>
          <HelpLink />
        </div>
      </div>
    </Body>
  );
}

/* ─────────── завершено ─────────── */

/**
 * Экран «Дякуємо»: отправлено или отложено, памятка безопасности после
 * ответа с риском, результат — только у методик, которые его показывают
 * (showResultsToPatient: сервер у остальных баллов не отдаёт), что ещё
 * пройти и ближайший приём.
 */
function DoneView({
  survey,
  done,
  asked,
  took,
  headingRef,
  listed,
  onLeave,
}: {
  survey: SurveyFull;
  done: { safetyPlan: string | null; queued: boolean; scores: ScoreResult[]; id: string | null; at: string };
  asked: number;
  took: number;
  headingRef: RefObject<HTMLHeadingElement | null>;
  listed: { id: string; title: string; assigned?: boolean; completedByMe: boolean; status: string; dueAt?: string | null }[];
  onLeave: () => void;
}) {
  const { ut } = useLang();
  const shown = done.scores.filter((s) => s.kind === "clinical" || !s.kind);
  /* прошлые замеры той же методики — «було 16 на 11.09», только где результат показывают */
  const history = useResource(() => (shown.length ? api.myResponses() : Promise.resolve({ items: [] })), [shown.length]);
  const visits = useResource(() => api.myAppointments(), []);
  const next = (visits.data?.items ?? [])
    .filter((v) => v.status !== "cancelled" && new Date(v.startsAt).getTime() > Date.now())
    .sort((x, y) => x.startsAt.localeCompare(y.startsAt))[0];
  const more = listed.filter((s) => s.id !== survey.id && s.status === "published" && s.assigned && !s.completedByMe);
  const nextTest = more[0];

  return (
    <>
      <RunnerBar
        title={survey.title}
        onLeave={onLeave}
        status={
          done.queued ? (
            <span className="inline-flex items-center gap-1.5 text-[14px] font-bold text-warn">
              <Glyph name="hard-drive" size={18} />
              <span className="max-[760px]:sr-only">{ut("ptw.waitsOnDevice")}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[14px] font-bold text-text-2">
              <Glyph name="send" size={18} className="text-good" />
              <span className="max-[760px]:sr-only">{`${ut("ptw.sentAt")} ${hm(done.at)}`}</span>
            </span>
          )
        }
        progress={
          survey.showProgress ? (
            <Progress label={`${asked} ${ut("common.of")} ${asked}`} number={asked} total={asked} current={-1} isDone={() => true} />
          ) : null
        }
      />
      <Body>
        <div className="grid grid-cols-[minmax(0,1fr)_400px] items-start gap-8 max-[1099px]:grid-cols-1 max-[1099px]:gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-3.5">
              <span
                aria-hidden
                className="grid size-14 shrink-0 place-items-center rounded-[15px] bg-good-tint text-good shadow-[inset_0_0_0_1px_var(--goodline)] supports-[corner-shape:squircle]:rounded-[20px] supports-[corner-shape:squircle]:[corner-shape:squircle]"
              >
                <Ic.check size={28} />
              </span>
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="m-0 rounded-sm text-[36px] font-extrabold leading-[42px] tracking-[-0.03em] text-text outline-none max-[600px]:text-[28px]"
              >
                {ut("pw.thanks")}
              </h1>
            </div>
            {/*
              Отложенная сдача сказана прямо: «передано специалисту» было бы
              неправдой, пока ответы лежат на этом устройстве. Баллов, где
              методика их не показывает, нет — и сказано, почему.
            */}
            <p className="m-0 mt-3 max-w-[680px] text-[17px] font-semibold leading-[26px] text-text-2">
              {done.queued ? ut("pw.queued") : shown.length ? ut("ptw.handedShown") : ut("pw.handed")}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[15px] font-semibold text-text-2">
              {done.queued ? (
                <Tag tone="attention" icon={<Glyph name="hard-drive" size={12} />}>
                  {ut("ptw.waitsOnDevice")}
                </Tag>
              ) : (
                <Tag tone="good" icon={<Ic.cloudCheck size={12} />}>{`${ut("ptw.sentAt")} ${hm(done.at)}`}</Tag>
              )}
              <span>{`${ut("ms.questions")}: ${asked}, ${duration(took)}`}</span>
            </div>

            {done.safetyPlan ? (
              <PtPanel
                title={ut("ptw.ifHard")}
                icon={<Glyph name="heart-handshake" size={16} />}
                className="mt-6"
                flush
              >
                <p className="m-0 whitespace-pre-wrap px-[18px] pb-3.5 pt-1.5 text-[17px] leading-[26px] text-text">
                  {done.safetyPlan}
                </p>
                <CallRows framed={false} />
              </PtPanel>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {shown.length ? (
              <PtPanel title={ut("ptw.yourResult")} icon={<Glyph name="activity" size={16} />}>
                <div className="flex flex-col gap-5">
                  {shown.map((s) => {
                    const v = scoreValue(s, ut);
                    const before = (history.data?.items ?? [])
                      .filter((r) => r.surveyId === survey.id && r.id !== done.id && r.submittedAt)
                      .map((r) => ({ at: r.submittedAt!, score: r.scores.find((x) => x.scaleId === s.scaleId || x.scaleCode === s.scaleCode) }))
                      .filter((r) => r.score && new Date(r.at).getTime() < new Date(done.at).getTime() - 1000)
                      .sort((x, y) => y.at.localeCompare(x.at))
                      .slice(0, 2)
                      .reverse();
                    return (
                      <div key={s.scaleId}>
                        {shown.length > 1 ? <b className="block text-[15px] font-extrabold text-text">{s.scaleTitle}</b> : null}
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="text-[44px] font-extrabold leading-none tracking-[-0.04em] tabular-nums text-text">{v.big}</span>
                          {v.of ? <span className="text-[17px] font-bold text-muted">{v.of}</span> : null}
                          {s.band ? (
                            <SeverityTag level={s.band.severity} className="ml-1 self-center">
                              {s.band.label}
                            </SeverityTag>
                          ) : null}
                        </div>
                        {before.length ? (
                          <ol aria-label={ut("ptw.history")} className="m-0 mt-3 flex list-none items-stretch gap-1.5 p-0">
                            {before.map((b) => (
                              <li key={b.at} className="flex flex-1 flex-col gap-0.5 rounded-[14px] bg-sunk px-3 py-2.5 text-[14px] font-semibold leading-[18px] text-text-2">
                                <span className="text-muted">{dm(b.at)}</span>
                                <b className="text-[26px] font-extrabold leading-[30px] tabular-nums text-text">{scoreValue(b.score!, ut).big}</b>
                              </li>
                            ))}
                            <li className="flex flex-1 flex-col gap-0.5 rounded-[14px] bg-violet-tint px-3 py-2.5 text-[14px] font-semibold leading-[18px] text-violet-ink shadow-[inset_0_0_0_1px_var(--vline)]">
                              <span>{ut("ptw.today")}</span>
                              <b className="text-[26px] font-extrabold leading-[30px] tabular-nums">{v.big}</b>
                            </li>
                          </ol>
                        ) : null}
                      </div>
                    );
                  })}
                  <p className="m-0 text-[15px] leading-[22px] text-text-2">{ut("ptw.notDiagnosis")}</p>
                </div>
              </PtPanel>
            ) : null}

            {nextTest ? (
              <PtPanel title={ut("ptw.alsoAssigned")} icon={<Ic.layers size={16} />} count={more.length}>
                <p className="m-0 text-[15.5px] leading-[23px] text-text-2">{ut("ptw.alsoAssignedText")}</p>
                <div className="mt-3.5 flex flex-col gap-2">
                  <ButtonLink to={`/me/tests/${nextTest.id}`} variant="primary" size="lg" className="w-full">
                    <span className="truncate">{`${ut("ptw.nextTest")}: ${instrumentCode(nextTest.title) ?? nextTest.title}`}</span>
                    <Ic.arrowRight size={18} />
                  </ButtonLink>
                </div>
              </PtPanel>
            ) : null}

            {next ? (
              <PtPanel
                title={ut("pt.nextVisit")}
                icon={<ShellIcon name="calendar-days" size={16} />}
                actions={
                  <ButtonLink to={`/me/booking?move=${next.id}`} variant="ghost" size="xs">
                    {ut("ptw.move")}
                  </ButtonLink>
                }
              >
                <b className="block text-[17px] font-extrabold leading-6">{visitWhen(next.startsAt, next.endsAt)}</b>
                <span className="block text-[15px] leading-[22px] text-text-2">
                  {next.specialistName}
                  {next.mode === "remote" ? `, ${ut("pt.remote")}` : next.room ? `, ${ut("pt.room")} ${next.room}` : ""}
                </span>
              </PtPanel>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <ButtonLink to="/me/tests" variant={nextTest ? "ghost" : "primary"} size={nextTest ? "sm" : "md"}>
                <ShellIcon name="list-checks" size={16} />
                {ut("pw.backToTests")}
              </ButtonLink>
              <ButtonLink to="/me" variant="ghost">
                <ShellIcon name="house" size={16} />
                {ut("pt.home")}
              </ButtonLink>
            </div>
          </div>
        </div>
      </Body>
    </>
  );
}
