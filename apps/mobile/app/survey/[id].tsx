import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import {
  contentLangNotice,
  isAnswered,
  isQuestionVisible,
  type Answer,
  type AnswerEvent,
  type BatteryAssignment,
  type Question,
  type ScoreResult,
  type SurveyFull,
} from "@quizzy/shared";
import * as Haptics from "expo-haptics";
import { api } from "@/api/client";
import { useAuth } from "@/auth/AuthContext";
import { codeOf, nextInSet, placeInSet } from "@/catalog/surveysTab";
import { draftRequestBody, drafts, pickDraft, type LocalDraft } from "@/offline/cache";
import { draftLaneKey, draftLanes } from "@/offline/draftLane";
import { mayStore } from "@/offline/owner";
import { useExit } from "@/nav/useExit";
import { finishFailureText, finishSubmission } from "@/runner/finish";
import { resultView } from "@/runner/resultView";
import { useOpenReport } from "@/report/useOpenReport";
import { missedBefore } from "@/runner/progress";
import { restoreDraft } from "@/runner/resume";
import { draftsToResume, dropOwnDraft } from "@/runner/ownDraft";
import { QuestionInput } from "@/components/QuestionInput";
import { ErrorText, Loader } from "@/components/ui";
import { Avatar } from "@/components/patient/Avatar";
import { CrisisStrip } from "@/components/patient/Crisis";
import { FactList, type Fact } from "@/components/patient/Facts";
import { BandCard, Hero, HeroMeta } from "@/components/patient/Hero";
import { ActionBar, Btn } from "@/ui/Button";
import { BigValue } from "@/ui/BigValue";
import { Icon } from "@/ui/Icon";
import { BackButton, HelpPill, NavBar, NavTextButton } from "@/ui/NavBar";
import { Callout, Panel, Squircle } from "@/ui/Panel";
import { Pill } from "@/ui/Pill";
import { ProgressSegments } from "@/ui/Progress";
import { CallRow } from "@/ui/Rows";
import { T } from "@/ui/Text";
import { useToast } from "@/ui/Toast";
import { formatDuration, useColors } from "@/theme";
import { useLang } from "@/lang";
import { useTextScale } from "@/textScale";

/** Телеметрия по одному вопросу, копится пока экран открыт */
interface Telemetry {
  durationMs: number;
  changeCount: number;
  visitCount: number;
}

export default function TakeSurveyScreen() {
  const c = useColors();
  const { scale, cycle } = useTextScale();
  const { ut, lang, locale } = useLang();
  const toast = useToast();
  const router = useRouter();
  const exit = useExit();
  // «Відкрити висновок» после сдачи — одноразовой ссылкой в браузере (src/report)
  const report = useOpenReport();
  const navigation = useNavigation();
  const { id, onBehalfOf } = useLocalSearchParams<{ id: string; onBehalfOf?: string }>();
  // чей черновик: локальная копия лежит под владельцем (offline/cache.ts)
  const owner = useAuth().user?.id ?? null;
  const [patient, setPatient] = useState<{ fullName: string; sex: "male" | "female" | null; age: number | null } | null>(null);

  const [survey, setSurvey] = useState<SurveyFull | null>(null);
  const [answers, setAnswers] = useState<Map<string, Answer>>(new Map());
  const [telemetry, setTelemetry] = useState<Map<string, Telemetry>>(new Map());
  const [step, setStep] = useState(-1); // -1 — экран инструкции
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScoreResult[] | null>(null);
  const [safetyPlan, setSafetyPlan] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [assigned, setAssigned] = useState<string[]>([]);
  const [responseId, setResponseId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [resumed, setResumed] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [draftSynced, setDraftSynced] = useState(true);
  /*
   * Черновик и обновлённая методика (runner/resume.ts): продолжаем в своей
   * версии — keptVersion; свою открыть не удалось — otherVersion, ответов на
   * экране нет, и человек решает, ждать или начать заново.
   */
  const [keptVersion, setKeptVersion] = useState(false);
  const [otherVersion, setOtherVersion] = useState(false);
  /**
   * Версия черновика, который заменит новое начало, — едет с автосохранением
   * как replacesVersionId, пока сервер его не примет. Без неё сервер черновик
   * с ответами другой версии не перезаписывает (и правильно).
   */
  const replacesVersion = useRef<string | null>(null);
  /** Батареи человека: место методики в наборе перед началом и «Далі: …» после сдачи */
  const [sets, setSets] = useState<BatteryAssignment[]>([]);
  /** Люди и службы из плана безопасности — в карточку «Якщо стане важко» после сдачи */
  const [contacts, setContacts] = useState<{ name: string; contact: string }[]>([]);
  /** «Пізніше» сохранило черновик — уход без вопроса «перервати?» */
  const leaving = useRef(false);
  const body = useRef<ScrollView>(null);

  const startedAt = useRef(new Date().toISOString());
  const sessionStart = useRef(Date.now());
  /** Момент входа на текущий вопрос — из него считается время ответа */
  const questionEnteredAt = useRef(Date.now());

  /**
   * Лента событий: показ вопроса, первый выбор, каждое переключение, уход.
   * Держим в ref, а не в состоянии — запись не должна вызывать перерисовку,
   * иначе каждый тап перерендеривал бы экран лишний раз.
   */
  const events = useRef<AnswerEvent[]>([]);
  /** Номер последней правки черновика; продолжает счёт с возобновлённого (offline/cache.ts, revision) */
  const draftRevision = useRef(0);
  const sequence = useRef(0);

  const pushEvent = useCallback((questionId: string, kind: AnswerEvent["kind"], value?: unknown) => {
    events.current.push({
      questionId,
      sequence: sequence.current++,
      kind,
      elapsedMs: Date.now() - questionEnteredAt.current,
      at: new Date().toISOString(),
      value,
    });
  }, []);

  /*
   * Шапку экран рисует сам: на каждом шаге своя — «‹ Назад» перед началом,
   * «Пізніше» и код методики на вопросе, одна «Допомога» после сдачи (как в
   * утверждённом экране). Шапка стека из корневой раскладки здесь не нужна.
   */
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, [navigation]);

  // место в наборе — только у своего прохождения: за пациента батареи специалиста не при чём
  useEffect(() => {
    if (onBehalfOf) return;
    void api
      .myBatteries()
      .then(setSets)
      .catch(() => {});
  }, [onBehalfOf, result]);

  // план безопасности при риске: люди и службы из своего плана, с кэша устройства без сети
  useEffect(() => {
    if (!safetyPlan || onBehalfOf) return;
    void api
      .mySafetyPlan()
      .then((res) => {
        const p = res.plan?.content;
        setContacts([...(p?.people ?? []), ...(p?.professionals ?? [])].filter((x) => /\d/.test(x.contact)));
      })
      .catch(() => {});
  }, [safetyPlan, onBehalfOf]);

  /*
   * Выход из незавершённого теста — потеря сессии измерения (тайминги
   * начнутся заново). Системный жест «назад» перехватываем и переспрашиваем.
   */
  /*
   * Кого заполняем в режиме обхода.
   *
   * Состояние было, а загрузки не было: на карточке стояло многоточие
   * вместо имени, а подсчёт уходил без пола и возраста. И то, и другое —
   * прямо против написанного рядом: карточка нужна, чтобы не перепутать
   * человека, когда заполняют подряд нескольких, а нормы методик
   * стратифицированы, и чужой профиль даёт у койки неверный результат.
   *
   * Отказ не рушит прохождение: без профиля баллы считаются как есть, а
   * имя остаётся многоточием — это хуже, чем с профилем, но лучше, чем
   * невозможность заполнить бланк у койки.
   */
  useEffect(() => {
    if (!onBehalfOf) return;
    let cancelled = false;
    api
      .roundsCard(onBehalfOf)
      .then(({ card }) => {
        if (cancelled) return;
        setPatient({ fullName: card.fullName, sex: card.sex, age: card.age });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [onBehalfOf]);

  useEffect(() => {
    const sub = navigation.addListener("beforeRemove", (e) => {
      if (result || answers.size === 0) return; // завершено или не начато
      if (leaving.current) return; // «Пізніше»: черновик сохранён, уход не теряет ответов
      // устройство стирают по команде (#125) — уход на вход не переспрашивается: беречь ответы негде
      if (!mayStore(owner)) return;
      e.preventDefault();
      Alert.alert(
        ut("ms.abortTitle"),
        ut("ms.abortBody"),
        [
          { text: ut("ms.continueTest"), style: "cancel" },
          {
            text: ut("ms.exit"),
            style: "destructive",
            onPress: () => navigation.dispatch(e.data.action),
          },
        ],
      );
    });
    return sub;
  }, [navigation, result, answers.size, owner]);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const loaded = await api.getSurvey(id);

        /*
         * Незавершённое прохождение — продолжаем с того же места. Берём то,
         * что новее: локальная копия свежее серверной ровно тогда, когда
         * человек отвечал без сети, и именно её терять нельзя. За пациента
         * черновика нет: свой специалиста ему не подставляется (runner/ownDraft.ts).
         */
        const { remote, local: stored } = await draftsToResume(id, { owner, onBehalfOf }, api.getDraft);
        draftRevision.current = Math.max(draftRevision.current, stored?.revision ?? 0);

        /*
         * И продолжаем в той версии, где даны ответы (волна 16, внешний
         * разбор, P1). Здесь экран показывал действующую версию, а ответы
         * брал из черновика прежней: на экране их не видел ни один вопрос, а
         * автосохранение отправляло их с новой версией, и сервер их
         * выбрасывал. Методика ставится на экран один раз — уже решённой
         * версией, чтобы число вопросов и заголовок не мигали.
         */
        const restored = await restoreDraft(loaded, pickDraft(stored, remote), (versionId, versionNumber) =>
          api.getSurveyVersion(id, versionId, versionNumber),
        );
        setSurvey(restored.survey);
        navigation.setOptions({ title: restored.survey.title });

        if (restored.kind === "resumed") {
          const draft = restored.draft;
          setAnswers(new Map((draft.answers as Answer[]).map((a) => [a.questionId, a])));
          startedAt.current = draft.startedAt;
          sessionStart.current = Date.now() - draft.durationMs;
          setResumed(true);
          setSavedAt(draft.lastSavedAt);
          setKeptVersion(restored.keptVersion);
          // начатое заново поверх другой версии, ещё не принятое сервером, — замена едет дальше
          replacesVersion.current = draft.replacesVersionId ?? null;
        } else if (restored.kind === "otherVersion") {
          // заменить можно только известную версию; у черновика без неё — та, что на сервере
          replacesVersion.current = restored.replacesVersionId ?? remote?.versionId ?? null;
          setOtherVersion(true);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : ut("ms.loadFailed"));
      }
    })();
  }, [id, navigation, owner, onBehalfOf]);

  // общий таймер: нужен и для лимита времени, и для показа затраченного
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Date.now() - sessionStart.current), 1000);
    return () => clearInterval(timer);
  }, []);

  /** Вопросы, прошедшие условную логику при текущих ответах */
  const visible = useMemo(() => {
    if (!survey) return [];
    return survey.questions.filter((q) => isQuestionVisible(q, survey.questions, answers));
  }, [survey, answers]);

  const current: Question | undefined = visible[step];
  const sectionOf = useCallback(
    (q: Question | undefined) => survey?.sections.find((s) => s.id === q?.sectionId) ?? null,
    [survey],
  );

  /** Закрывает замер времени по текущему вопросу и открывает по следующему */
  const commitTiming = useCallback(() => {
    if (!current) return;
    const spent = Date.now() - questionEnteredAt.current;
    pushEvent(current.id, "leave");
    setTelemetry((prev) => {
      const next = new Map(prev);
      const t = next.get(current.id) ?? { durationMs: 0, changeCount: 0, visitCount: 0 };
      next.set(current.id, { ...t, durationMs: t.durationMs + spent });
      return next;
    });
    questionEnteredAt.current = Date.now();
  }, [current, pushEvent]);

  /**
   * Автосохранение. Вызывается при каждом переходе между вопросами: обрыв связи
   * или разряженный телефон не должны стоить пациенту всего прохождения.
   *
   * Сначала на устройство, потом на сервер. Раньше был только сервер, и в
   * подвале без связи автосохранение молча ничего не делало — телефон, севший
   * на сто восьмидесятом пункте МЛО-200, стоил человеку всего прохождения.
   * Локальная запись атомарна, поэтому выключение посреди неё не портит то,
   * что уже было сохранено.
   */
  const autosave = useCallback(async () => {
    /*
     * За пациента черновики не сохраняются. Черновик на сервере привязан к
     * тому, кто его прислал, — то есть к специалисту: сохранив его, мы
     * положили бы ответы пациента в незавершённые прохождения врача, а при
     * следующем открытии методики предложили бы врачу их «продолжить».
     */
    if (!survey || survey.anonymous || onBehalfOf || !owner) return;
    const payload = [...answers.values()].map((a) => ({
      ...a,
      durationMs: telemetry.get(a.questionId)?.durationMs ?? 0,
      changeCount: telemetry.get(a.questionId)?.changeCount ?? 0,
      visitCount: telemetry.get(a.questionId)?.visitCount ?? 1,
    }));
    if (payload.length === 0) return;

    /*
     * Номер правки — порядок, в котором человек отвечал. По нему, а не по
     * тому, чей ответ сервера пришёл позже, решается, какая копия свежее
     * (offline/draftLane.ts, drafts.saveIfNewer / confirm).
     */
    const revision = ++draftRevision.current;
    const local: LocalDraft = {
      surveyId: survey.id,
      // версия на экране — черновик продолжают и сдают по ней; она же едет при досылке
      versionId: survey.versionId,
      versionNumber: survey.versionNumber,
      replacesVersionId: replacesVersion.current,
      answers: payload,
      startedAt: startedAt.current,
      durationMs: Date.now() - sessionStart.current,
      events: events.current,
      savedAt: new Date().toISOString(),
      synced: false,
      revision,
    };
    /*
     * Отметка «збережено тут» ставится, только если запись легла: хранилище
     * больше не глотает отказ (offline/writeError.ts), и молча показать
     * «сохранено» при переполненном диске значило бы обещать то, чего нет.
     */
    try {
      if (drafts.saveIfNewer(owner, local)) {
        setSavedAt(local.savedAt);
        setDraftSynced(false);
      }
    } catch {
      // места нет — остаётся сервер ниже; ответы при этом на экране
    }

    try {
      /*
       * На сервер — по дорожке: одно сохранение в пути, ждёт только самое
       * свежее. Параллельные запросы отвечали не по порядку, и запоздалая
       * старая правка затирала новую и на сервере, и на устройстве.
       */
      const sent = await draftLanes.submit(draftLaneKey(owner, survey.id), revision, () =>
        // то же тело, что у досылки: версия экрана и явная замена, если начали заново (offline/cache.ts)
        api.saveDraft(survey.id, draftRequestBody(local)),
      );
      if (sent.status === "superseded") return; // следом уже идёт правка новее — отметит она
      // замена принята — дальше черновик на сервере уже этой версии, называть прежнюю незачем
      if (local.replacesVersionId && replacesVersion.current === local.replacesVersionId) replacesVersion.current = null;
      try {
        drafts.confirm(owner, survey.id, revision, sent.value.lastSavedAt);
      } catch {
        // отметка не легла — правка дошлётся ещё раз, сервер получит ту же копию
      }
      if (draftRevision.current === revision) {
        setSavedAt(sent.value.lastSavedAt);
        setDraftSynced(true);
      }
    } catch {
      // сети нет — локальная копия (если легла) догонит при следующем проходе
    }
  }, [survey, answers, telemetry, onBehalfOf, owner]);

  function goTo(nextStep: number) {
    commitTiming();
    void autosave();
    const target = visible[nextStep];
    if (target) {
      questionEnteredAt.current = Date.now();
      pushEvent(target.id, "shown");
      setTelemetry((prev) => {
        const next = new Map(prev);
        const t = next.get(target.id) ?? { durationMs: 0, changeCount: 0, visitCount: 0 };
        next.set(target.id, { ...t, visitCount: t.visitCount + 1 });
        return next;
      });
    }
    setStep(nextStep);
  }

  function patchAnswer(question: Question, patch: Partial<Answer>) {
    const wasAnswered = isAnswered(question, answers.get(question.id));
    const next = { ...answers.get(question.id), ...patch, questionId: question.id } as Answer;
    const nowAnswered = isAnswered(question, next);

    // «set» — первый осмысленный ответ, «change» — переключение, «clear» — сброс
    pushEvent(
      question.id,
      !wasAnswered && nowAnswered ? "set" : wasAnswered && !nowAnswered ? "clear" : "change",
      patch.optionIds ?? patch.number ?? patch.matrix ?? patch.ranking ?? patch.date ?? undefined,
    );

    // лёгкая хаптика на выбор: уставший респондент чувствует, что нажатие
    // принято, и не давит повторно
    if (Platform.OS !== "web") void Haptics.selectionAsync().catch(() => {});

    setAnswers((prev) => {
      const next = new Map(prev);
      next.set(question.id, { ...next.get(question.id), ...patch, questionId: question.id });
      return next;
    });
    setTelemetry((prev) => {
      const next = new Map(prev);
      const t = next.get(question.id) ?? { durationMs: 0, changeCount: 0, visitCount: 1 };
      // первое касание ответом не считается правкой — считаем только смены
      const alreadyAnswered = isAnswered(question, answers.get(question.id));
      next.set(question.id, {
        ...t,
        changeCount: alreadyAnswered ? t.changeCount + 1 : t.changeCount,
      });
      return next;
    });
  }

  async function submit(status: "completed" | "abandoned" = "completed") {
    if (!survey) return;
    commitTiming();
    setBusy(true);
    setError(null);
    try {
      const payload = visible
        .filter((q) => q.type !== "info")
        .map((q) => {
          const a = answers.get(q.id);
          const t = telemetry.get(q.id);
          return {
            questionId: q.id,
            ...a,
            skipped: !isAnswered(q, a),
            durationMs: t?.durationMs ?? 0,
            changeCount: t?.changeCount ?? 0,
            visitCount: t?.visitCount ?? 1,
          } as Answer;
        });

      /*
       * Черновик стирается только после подтверждённой сдачи: сервером или
       * легшей на устройство очередью (runner/finish.ts). Не легла — ответы
       * остаются и на экране, и в черновике, а «Завершити» можно нажать ещё
       * раз.
       */
      const outcome = await finishSubmission({
        submit: () =>
          api.submitResponse(survey.id, {
            // версия на экране — по ней сервер проверит и посчитает, даже если методику уже обновили
            versionId: survey.versionId,
            answers: payload,
            startedAt: startedAt.current,
            durationMs: Date.now() - sessionStart.current,
            status,
            events: events.current,
            onBehalfOf: onBehalfOf ?? null,
            /*
             * Пол и возраст пациента едут вместе с ответами: без сети баллы
             * считаются на устройстве, а нормы методик стратифицированы. Считать
             * чужой профиль по своему полу значит показать у койки неверный
             * результат — и заметить это будет негде.
             */
            subject: patient ? { sex: patient.sex, age: patient.age } : null,
          }),
        // прохождение ушло (или встало в очередь) — свой черновик больше не нужен
        // и не должен всплыть «продолжением»; сдача за пациента черновик специалиста не трогает
        dropDraft: () => dropOwnDraft(survey.id, { owner, onBehalfOf }),
      });
      if (!outcome.ok) {
        setError(finishFailureText(outcome, ut));
        return;
      }
      const res = outcome.result;
      setResult(res.scores);
      setSafetyPlan(res.safetyPlan ?? null);
      setQueued(!!res.queued);
      setAssigned(res.cascade?.assignedBatteries ?? []);
      setResponseId(res.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("runner.submitFailed"));
    } finally {
      setBusy(false);
    }
  }

  /** Черновик сохраняется — те же условия, что в autosave: своё прохождение, не анонимная методика */
  const savesDraft = !!survey && !survey.anonymous && !onBehalfOf && !!owner;
  const askedNumber = visible.filter((q) => q.type !== "info").findIndex((q) => q.id === current?.id) + 1;
  /*
   * «Допомога» — на каждом шаге прохождения: методика может спросить о том,
   * после чего помощь нужна сразу, и искать её на другой вкладке некогда.
   */
  const patientHelp = <HelpPill />;

  /*
   * «Пізніше» на вопросе: черновик уже на устройстве (и, если есть сеть,
   * на сервере) — уходим без вопроса «перервати?», ответы не пропадут.
   * За пациента и у анонимной методики черновика нет: там уход по-прежнему
   * переспрашивает (beforeRemove выше), потому что ответы правда потеряются.
   */
  async function later() {
    if (savesDraft) {
      commitTiming();
      await autosave();
      leaving.current = true;
      toast.show(ut("mpt.rn.savedLater").replace("{n}", String(Math.max(1, askedNumber))), { icon: "cloud-check" });
    }
    exit();
  }

  if (error && !survey) {
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <NavBar flush left={<BackButton label={ut("common.back")} onPress={exit} />} right={patientHelp} />
        <View style={{ padding: 16, gap: 12 }}>
          <ErrorText>{error}</ErrorText>
          {/* назад, если есть куда; открыт первым (по ссылке) — к методикам, а не в пустоту */}
          <Btn title={ut("common.back")} onPress={exit} />
        </View>
      </View>
    );
  }
  if (!survey) return <Loader />;

  const code = codeOf(survey.title).code;
  const asked = visible.filter((q) => q.type !== "info");

  /* ─── экран результата ─── */
  if (result) {
    /*
     * Что из результата можно показать — решает методика (showResultsToPatient)
     * и то, кто у телефона (runner/resultView.ts). Баллы в состоянии экрана
     * есть в любом случае: запрет — про показ, а не про подсчёт.
     */
    const view = resultView({
      showResultsToPatient: survey.showResultsToPatient,
      scoringEnabled: survey.scoringEnabled,
      onBehalfOf: !!onBehalfOf,
      queued,
      scoresCount: result.length,
      responseId,
      safetyPlan,
    });
    const answeredTotal = asked.filter((q) => isAnswered(q, answers.get(q.id))).length;
    const doneAt = new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    const nextStep = onBehalfOf ? null : nextInSet(sets, survey.id);
    const toList = () => router.replace("/(app)/surveys");
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <NavBar flush right={patientHelp} />
        <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
          <Hero
            title={queued ? ut("mpt.rn.queuedTitle") : ut("mpt.rn.sentTitle")}
            mark={<OkMark queued={queued} />}
            lead={ut(view.tookKey).replace("{d}", formatDuration(Date.now() - sessionStart.current))}
          >
            <HeroMeta>
              <Pill
                kind={queued ? "n" : "good"}
                icon={queued ? "cloud-off" : "cloud-check"}
                label={queued ? ut("mpt.rn.waitsNet") : ut("mpt.rn.sentAt").replace("{t}", doneAt)}
              />
              <T v="sub" tone="text2">
                {[code, `${answeredTotal} ${ut("common.of")} ${asked.length} ${ut("surveys.questions")}`].filter(Boolean).join(", ")}
              </T>
            </HeroMeta>
          </Hero>

          {view.safetyPlan ? (
            /*
             * План безопасности при риске — первым и без условий: это не
             * результат, а помощь. Номера звонят сразу; 103 — красным.
             */
            <Panel title={ut("mpt.rn.ifHard")} icon="heart-handshake" pad={false} style={{ marginTop: 16, marginHorizontal: 16 }}>
              <T v="body" style={{ paddingHorizontal: 16, paddingTop: 2, paddingBottom: 12 }}>
                {view.safetyPlan}
              </T>
              <View style={{ borderTopWidth: 1, borderTopColor: c.divider }}>
                <CallRow first name={ut("home.hotline")} sub={ut("mui.hotlineSub")} number={ut("home.hotlineNumber")} />
                {contacts.map((x, i) => (
                  <CallRow key={`${x.name}-${i}`} name={x.name} number={x.contact} />
                ))}
                <CallRow name={ut("mui.emergency")} sub={ut("mui.emergencySub")} number={ut("mui.emergencyNumber")} tone="risk" />
              </View>
              {onBehalfOf ? null : (
                <View style={{ flexDirection: "row", gap: 8, padding: 14, borderTopWidth: 1, borderTopColor: c.divider }}>
                  <Btn title={ut("mpt.rn.myPlan")} icon="shield-check" size="m" flex={1} onPress={() => router.push("/safety")} />
                  <Btn title={ut("ms.write")} icon="message-square-text" size="m" flex={1} onPress={() => router.push("/messages")} />
                </View>
              )}
            </Panel>
          ) : null}

          {assigned.length ? (
            <View style={{ marginTop: 16, marginHorizontal: 16 }}>
              <Callout kind="v" icon="layers" text={ut("msv.alsoAssigned").replace("{list}", assigned.join(", "))} />
            </View>
          ) : null}

          {view.hiddenNote ? (
            <View style={{ marginTop: 16, marginHorizontal: 16 }}>
              <Callout kind="n" icon="info" text={ut("msv.scoresForSpecialist")} />
            </View>
          ) : null}

          {view.scores ? (
            <Panel title={ut("mpt.rn.result")} icon="activity" sub={code ?? undefined} style={{ marginTop: 16, marginHorizontal: 16 }}>
              {result.map((s, i) => (
                <View key={s.scaleId} style={{ gap: 6, paddingTop: i ? 14 : 0, marginTop: i ? 6 : 0, borderTopWidth: i ? 1 : 0, borderTopColor: c.divider }}>
                  {result.length > 1 ? <T v="headline">{s.scaleTitle}</T> : null}
                  <BigValue
                    value={formatScore(s.rawScore)}
                    of={s.maxScore}
                    severity={s.band?.severity ?? undefined}
                    severityLabel={s.band?.label ?? undefined}
                  />
                  {s.band?.description ? <T v="note">{s.band.description}</T> : null}
                </View>
              ))}
              <T v="note" style={{ marginTop: 8 }}>
                {ut("msv.notDiagnosis")}
              </T>
            </Panel>
          ) : null}

          {view.conclusion && responseId ? (
            <View style={{ marginTop: 16, marginHorizontal: 16 }}>
              <Btn
                title={ut("ms.openConclusion")}
                icon="file-text"
                size="m"
                full
                loading={report.opening}
                onPress={() => report.open(responseId)}
              />
            </View>
          ) : null}
        </ScrollView>
        <ActionBar>
          {nextStep ? (
            <>
              <Btn title={ut("mpt.later")} size="l" flex={1} onPress={toList} />
              <Btn
                title={ut("mpt.rn.nextStep").replace("{title}", codeOf(nextStep.title).code ?? nextStep.title)}
                kind="primary"
                size="l"
                flex={2}
                icon="arrow-right"
                iconEnd
                onPress={() => router.replace(`/survey/${nextStep.surveyId}`)}
              />
            </>
          ) : (
            <Btn title={ut("msv.toSurveys")} kind="primary" size="l" flex={1} onPress={toList} />
          )}
        </ActionBar>
      </View>
    );
  }

  /* ─── экран инструкции ─── */
  if (step === -1) {
    /*
     * Английский интерфейс, а пункты — на украинском: английского текста у
     * методик нет (CONTENT_LANGS в shared/types.ts). Одной строкой на экране
     * инструкции — до первого пункта, а не над каждым: дальше человек уже
     * знает.
     */
    const foreign = contentLangNotice(lang, survey.contentLang);
    const minutes = survey.timeLimitSec ? Math.round(survey.timeLimitSec / 60) : null;
    const inSet = onBehalfOf ? null : placeInSet(sets, survey.id);
    const factRows: (Fact | null)[] = [
      {
        icon: "list-checks",
        title: [
          `${asked.length} ${ut("surveys.questions")}`,
          minutes ? ut("mpt.rn.limit").replace("{n}", String(minutes)) : null,
        ]
          .filter(Boolean)
          .join(", "),
        text: survey.instructions,
      },
      onBehalfOf
        ? { icon: "user-round", title: ut("rounds.fillingFor").replace(/:\s*$/, ""), text: ut("rounds.noDraft") }
        : savesDraft
          ? { icon: "save", title: ut("mpt.rn.pause"), text: ut("mpt.rn.pauseText") }
          : null,
      survey.anonymous
        ? { icon: "eye-off", title: ut("mpt.rn.anon"), text: ut("mpt.rn.anonText") }
        : onBehalfOf
          ? null
          : { icon: "eye", title: ut("mpt.rn.whoSees"), text: ut("mpt.rn.whoSeesText") },
      inSet
        ? {
            icon: "layers",
            title: ut("mpt.rn.inSet")
              .replace("{i}", String(inSet.index + 1))
              .replace("{n}", String(inSet.total))
              .replace("{title}", inSet.title),
            text: inSet.next.length ? ut("mpt.rn.inSetNext").replace("{list}", inSet.next.join(", ")) : ut("mpt.rn.inSetLast"),
          }
        : null,
      /*
       * Описание методики пишет отделение для коллег — нормы, источник,
       * оговорки. Оно не прячется, но идёт последним: человеку перед
       * началом важнее, сколько это займёт и кто увидит ответы.
       */
      survey.description ? { icon: "info", tone: "n", title: ut("mpt.rn.about"), text: survey.description } : null,
    ];
    const facts = factRows.filter((f): f is Fact => f !== null);

    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <NavBar flush left={<BackButton label={ut("common.back")} onPress={exit} />} right={patientHelp} />
        <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
          <Hero title={codeOf(survey.title).name} lead={code ?? undefined}>
            {onBehalfOf ? (
              /*
               * За кого заполняем — самой заметной строкой на экране. У койки
               * заполняют подряд нескольких, и ошибиться человеком легче, чем
               * кажется; заметить такую ошибку потом будет негде.
               */
              <BandCard>
                <Avatar name={patient?.fullName ?? ""} size={44} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T v="sub" tone="text2">
                    {ut("rounds.fillingFor")}
                  </T>
                  <T v="headline" size={18}>
                    {patient?.fullName ?? "…"}
                  </T>
                </View>
              </BandCard>
            ) : resumed ? (
              <BandCard>
                <Squircle icon="history" />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T v="headline">{ut("ms.unfinishedFound")}</T>
                  <T v="note" tone="text2" style={{ marginTop: 2 }}>
                    {ut("msv.resumeAt").replace("{at}", savedAt ? ` ${formatWhen(savedAt, locale)}` : "")}
                  </T>
                  {keptVersion ? (
                    <T v="note" tone="text2" style={{ marginTop: 6 }}>
                      {ut("ms.draftKeptVersion")}
                    </T>
                  ) : null}
                </View>
              </BandCard>
            ) : otherVersion ? (
              /*
               * Ответов на экране нет не потому, что они пропали: они в другой
               * версии, и перенести их нечем. Уйти назад — черновик остаётся и
               * откроется, когда будет связь; «Почати заново» — явная замена.
               */
              <BandCard>
                <Squircle icon="circle-alert" tone="warn" />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T v="headline">{ut("ms.draftOtherVersion")}</T>
                  <T v="note" tone="text2" style={{ marginTop: 2 }}>
                    {ut("ms.draftOtherVersionHint")}
                  </T>
                </View>
              </BandCard>
            ) : null}
            {foreign ? (
              <T v="sub" tone="text2" style={{ marginTop: 12 }}>
                {ut(`contentLang.${foreign}`)}
              </T>
            ) : null}
          </Hero>
          <FactList facts={facts} />
          {onBehalfOf ? null : <CrisisStrip />}
        </ScrollView>
        <ActionBar>
          <Btn title={ut("mpt.later")} size="l" flex={1} onPress={exit} />
          <Btn
            title={resumed ? ut("ms.continue") : otherVersion ? ut("ms.startOver") : ut("ms.start")}
            kind="primary"
            size="l"
            flex={2}
            icon="arrow-right"
            iconEnd
            onPress={() => {
              if (!resumed) {
                sessionStart.current = Date.now();
                startedAt.current = new Date().toISOString();
                events.current = [];
                sequence.current = 0;
              }
              questionEnteredAt.current = Date.now();
              goTo(0);
            }}
          />
        </ActionBar>
      </View>
    );
  }

  if (!current) return <Loader />;

  const askedIndex = asked.findIndex((q) => q.id === current.id);
  /*
   * Сколько осталось: по собственному темпу, а не по медиане других. Пока
   * пройдено меньше трёх пунктов, темпа ещё нет и оценка была бы выдумкой —
   * тогда не показываем ничего.
   */
  const answeredCount = asked.filter((q) => isAnswered(q, answers.get(q.id))).length;
  const remainingMinutes =
    answeredCount >= 3 && elapsed > 0
      ? Math.max(1, Math.round(((elapsed / answeredCount) * (asked.length - answeredCount)) / 60_000))
      : null;

  /*
   * Пропущенные обязательные пункты считаются постоянно, а не только перед
   * сдачей: в опроснике на двести пунктов искать пропуск прокруткой — тупик,
   * и узнавать о нём в конце пути значит проходить его дважды. Правило — в
   * missedBefore.
   */
  const missedBehind = missedBefore(visible, answers, step);

  const canAdvance = !current.required || isAnswered(current, answers.get(current.id));
  const isLast = step === visible.length - 1;
  const section = sectionOf(current);
  const overtime = survey.timeLimitSec ? elapsed > survey.timeLimitSec * 1000 : false;
  const savedTime = savedAt ? new Date(savedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : null;
  const backAllowed = survey.allowBack && step > 0;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: c.ground }}>
      <NavBar
        flush
        title={code ?? survey.title}
        left={<NavTextButton label={ut("mpt.later")} onPress={() => void later()} />}
        right={patientHelp}
      />
      {/* номер пункта, сохранение и сегменты — на полосе шапки, под строкой навигации */}
      <View style={{ backgroundColor: c.band, paddingTop: 2, paddingHorizontal: 20, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: c.bcardline }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1, flexDirection: "row", alignItems: "baseline", gap: 6 }}>
            {current.type === "info" ? (
              <T v="body" weight={700} tone="text2">
                {ut("runner.info")}
              </T>
            ) : (
              <>
                <T v="body" weight={700} tone="text2" scale={false}>
                  {ut("runner.question")}
                </T>
                <T v="largeTitle" size={30} num>
                  {askedIndex + 1}
                </T>
                <T v="body" weight={700} tone="text2" scale={false} num>
                  {`${ut("common.of")} ${asked.length}`}
                </T>
              </>
            )}
          </View>
          {savedTime ? (
            /*
             * Разница между «сохранено на телефоне» и «сохранено на сервере»
             * человеку важна: во втором случае прохождение переживёт потерю
             * телефона, в первом — только его собственную память.
             */
            <View
              accessible
              accessibilityLabel={draftSynced ? ut("ms.answersSaved") : ut("ms.savedHereOnly")}
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <Icon name={draftSynced ? "cloud-check" : "cloud-off"} size={17} color={draftSynced ? c.good : c.muted} />
              <T v="sub" weight={700} tone="text2" scale={false} numberOfLines={1}>
                {(draftSynced ? ut("mpt.rn.savedAt") : ut("mpt.rn.savedPhone")).replace("{t}", savedTime)}
              </T>
            </View>
          ) : null}
          {/*
            Укрупнение текста прямо на экране прохождения: лезть в
            настройки телефона посреди обследования никто не будет.

            «A» на кнопке — знак, а не слово: так кнопку размера шрифта
            рисуют во всех редакторах, на любом языке. Буква латинская:
            кириллическая «А» на английском экране была бы единственным
            символом украинского алфавита (test/noRawStrings.test.ts). Имя
            кнопки для диктора — msv.textSize, из словаря; знак он не читает.
          */}
          <Pressable
            onPress={cycle}
            accessibilityRole="button"
            accessibilityLabel={ut("msv.textSize").replace("{n}", String(Math.round(scale * 100)))}
            hitSlop={6}
            style={({ pressed }) => ({
              width: 38,
              height: 38,
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: scale > 1 ? c.vtint : pressed ? c.vtint2 : c.bcard,
              borderWidth: 1,
              borderColor: scale > 1 ? c.vline : c.bcardline,
            })}
          >
            <T v="body" size={scale > 1 ? 19 : 16} weight={800} color={c.vink} scale={false}>
              A
            </T>
          </Pressable>
        </View>
        {survey.showProgress && asked.length ? (
          <ProgressSegments
            total={asked.length}
            current={current.type === "info" ? -1 : askedIndex}
            done={Math.max(0, askedIndex)}
            accessibilityLabel={`${ut("runner.question")} ${askedIndex + 1} ${ut("common.of")} ${asked.length}`}
          />
        ) : null}
        {missedBehind.length || remainingMinutes !== null || survey.timeLimitSec ? (
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 14, rowGap: 4, marginTop: 10 }}>
            {/*
              Пропущенные показываются только когда они позади: пункты
              впереди ещё не пропущены, и считать их пропусками значит пугать
              человека собственным будущим.
            */}
            {missedBehind.length ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${ut("runner.missedGoTo")}: ${missedBehind.length}`}
                onPress={() => goTo(missedBehind[0]!)}
                hitSlop={10}
                style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
              >
                <Icon name="circle-alert" size={16} color={c.warn} />
                <T v="sub" weight={700} color={c.warn} scale={false}>
                  {`${ut("runner.missed")} ${missedBehind.length}`}
                </T>
                <Icon name="arrow-right" size={15} color={c.warn} />
              </Pressable>
            ) : null}
            {/*
              Оценка оставшегося времени важнее прошедшего: человек с
              двухсотпунктовым опросником решает, успеет ли он сейчас, а не
              интересуется, сколько уже потратил.
            */}
            {remainingMinutes !== null ? (
              <T v="sub" tone="text2" scale={false}>
                {ut("msv.minutesLeft").replace("{n}", String(remainingMinutes))}
              </T>
            ) : null}
            {survey.timeLimitSec ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Icon name="timer" size={15} color={overtime ? c.riskink : c.muted} />
                <T v="sub" num color={overtime ? c.riskink : c.text2} scale={false}>
                  {`${formatDuration(elapsed)}${ut("msv.ofMinutes").replace("{n}", String(Math.round(survey.timeLimitSec / 60)))}`}
                </T>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

      <ScrollView ref={body} contentContainerStyle={{ paddingTop: 24, paddingHorizontal: 20, paddingBottom: 24 }}>
        {section ? (
          <View style={{ gap: 4, marginBottom: 8 }}>
            <T v="body" size={16} weight={600} tone="text2">
              {section.title}
            </T>
            {section.description ? <T v="note">{section.description}</T> : null}
          </View>
        ) : null}

        {/* формулировка пункта укрупняется вместе с вариантами: читать приходится и то и другое */}
        <T v="question" accessibilityRole="header">
          {current.title}
        </T>
        {current.help ? (
          <T v="note" style={{ marginTop: 8 }}>
            {current.help}
          </T>
        ) : null}
        {current.required && current.type !== "info" ? (
          <T v="sub" style={{ marginTop: 6 }}>
            {ut("ms.requiredQuestion")}
          </T>
        ) : null}

        <View style={{ marginTop: current.type === "info" ? 0 : 22 }}>
          <QuestionInput question={current} value={answers.get(current.id)} onChange={(patch) => patchAnswer(current, patch)} />
        </View>

        {current.type !== "info" ? (
          <View style={{ flexDirection: "row", gap: 8, marginTop: 16 }}>
            <View style={{ marginTop: 2 }}>
              <Icon name={savesDraft ? "cloud-check" : "info"} size={16} color={savesDraft ? c.good : c.muted} />
            </View>
            <T v="note" weight={600} tone="muted" style={{ flex: 1 }}>
              {savesDraft ? (survey.allowBack ? ut("mpt.rn.hint") : ut("mpt.rn.hintNoBack")) : onBehalfOf ? ut("rounds.noDraft") : ut("mpt.rn.hintNoDraft")}
            </T>
          </View>
        ) : null}

        {error ? (
          <View style={{ marginTop: 16 }}>
            <ErrorText>{error}</ErrorText>
          </View>
        ) : null}
      </ScrollView>

      <ActionBar>
        {survey.allowBack ? (
          <Btn
            title={ut("common.back")}
            icon="chevron-left"
            size="l"
            flex={1}
            disabled={!backAllowed}
            onPress={() => goTo(step - 1)}
          />
        ) : null}
        <Btn
          title={isLast ? ut("mpt.rn.send") : ut("common.next")}
          kind="primary"
          size="l"
          flex={2}
          icon={isLast ? "send" : "chevron-right"}
          iconEnd
          disabled={!canAdvance}
          loading={busy}
          onPress={() => {
            if (!isLast) {
              body.current?.scrollTo({ y: 0, animated: false });
              return goTo(step + 1);
            }
            /*
             * Перед сдачей возвращаем к первому пропущенному обязательному
             * пункту. Иначе человек упирается в отказ сервера и ищет
             * пропуск сам — в опроснике на двести пунктов это тупик.
             */
            const missing = visible.findIndex((q) => q.required && q.type !== "info" && !isAnswered(q, answers.get(q.id)));
            if (missing >= 0 && missing !== step) {
              setError(ut("runner.missingRequired"));
              return goTo(missing);
            }
            return submit();
          }}
        />
      </ActionBar>
    </KeyboardAvoidingView>
  );
}

/** Знак у заголовка «Відповіді надіслано»: зелёная галочка; у сохранённого на телефоне — облако */
function OkMark({ queued }: { queued: boolean }) {
  const c = useColors();
  return (
    <View
      style={{
        width: 48,
        height: 48,
        borderRadius: 15,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: queued ? c.sunk : c.goodtint,
        borderWidth: 1,
        borderColor: queued ? c.border : c.goodline,
      }}
    >
      <Icon name={queued ? "cloud-off" : "check"} size={26} color={queued ? c.text2 : c.good} />
    </View>
  );
}

/** Балл без хвоста: «14», а у среднего — «2,4» */
function formatScore(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}

function formatWhen(iso: string, locale: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" })}, ${d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`;
}
