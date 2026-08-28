import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import {
  isAnswered,
  isQuestionVisible,
  type Answer,
  type AnswerEvent,
  type Question,
  type ScoreResult,
  type SurveyFull,
} from "@quizzy/shared";
import * as Haptics from "expo-haptics";
import { api } from "@/api/client";
import { drafts, pickDraft, type LocalDraft } from "@/offline/cache";
import { QuestionInput } from "@/components/QuestionInput";
import { SeverityTag } from "@/components/charts";
import { Body, Button, Card, ErrorText, Loader, Row, Title } from "@/components/ui";
import { formatDuration, severityColor, spacing, useColors } from "@/theme";
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
  const { scale, cycle, fs } = useTextScale();
  const { ut } = useLang();
  const router = useRouter();
  const navigation = useNavigation();
  const { id } = useLocalSearchParams<{ id: string }>();

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
   * Выход из незавершённого теста — потеря сессии измерения (тайминги
   * начнутся заново). Системный жест «назад» перехватываем и переспрашиваем.
   */
  useEffect(() => {
    const sub = navigation.addListener("beforeRemove", (e) => {
      if (result || answers.size === 0) return; // завершено или не начато
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
  }, [navigation, result, answers.size]);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const loaded = await api.getSurvey(id);
        setSurvey(loaded);
        navigation.setOptions({ title: loaded.title });

        /*
         * Незавершённое прохождение — продолжаем с того же места. Берём то,
         * что новее: локальная копия свежее серверной ровно тогда, когда
         * человек отвечал без сети, и именно её терять нельзя.
         */
        const remote = await api.getDraft(id).catch(() => null);
        const draft = pickDraft(drafts.get(id), remote);

        if (draft) {
          setAnswers(new Map((draft.answers as Answer[]).map((a) => [a.questionId, a])));
          startedAt.current = draft.startedAt;
          sessionStart.current = Date.now() - draft.durationMs;
          setResumed(true);
          setSavedAt(draft.lastSavedAt);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : ut("ms.loadFailed"));
      }
    })();
  }, [id, navigation]);

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
    if (!survey || survey.anonymous) return;
    const payload = [...answers.values()].map((a) => ({
      ...a,
      durationMs: telemetry.get(a.questionId)?.durationMs ?? 0,
      changeCount: telemetry.get(a.questionId)?.changeCount ?? 0,
      visitCount: telemetry.get(a.questionId)?.visitCount ?? 1,
    }));
    if (payload.length === 0) return;

    const local: LocalDraft = {
      surveyId: survey.id,
      answers: payload,
      startedAt: startedAt.current,
      durationMs: Date.now() - sessionStart.current,
      events: events.current,
      savedAt: new Date().toISOString(),
      synced: false,
    };
    drafts.save(local);
    setSavedAt(local.savedAt);
    setDraftSynced(false);

    try {
      const res = await api.saveDraft(survey.id, {
        answers: payload,
        startedAt: local.startedAt,
        durationMs: local.durationMs,
        events: local.events as never,
      });
      drafts.save({ ...local, synced: true });
      setSavedAt(res.lastSavedAt);
      setDraftSynced(true);
    } catch {
      // сети нет — локальная копия уже лежит, догонит при следующем проходе
    }
  }, [survey, answers, telemetry]);

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

      const res = await api.submitResponse(survey.id, {
        answers: payload,
        startedAt: startedAt.current,
        durationMs: Date.now() - sessionStart.current,
        status,
        events: events.current,
      });
      // прохождение ушло (или встало в очередь) — локальный черновик больше
      // не нужен и не должен всплыть «продолжением» при следующем открытии
      drafts.drop(survey.id);
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

  if (error && !survey) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, padding: spacing.lg, gap: spacing.md }}>
        <ErrorText>{error}</ErrorText>
        <Button title={ut("common.back")} variant="secondary" onPress={() => router.back()} />
      </View>
    );
  }
  if (!survey) return <Loader />;

  /* ─── экран результата ─── */
  if (result) {
    return (
      <ScrollView
        style={{ backgroundColor: c.bg }}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
      >
        <Title>{ut("ms.done")}</Title>
        <Body muted>
          {queued
            ? `Прохождение заняло ${formatDuration(Date.now() - sessionStart.current)}. Сети нет — ответы сохранены на устройстве и уйдут сами, как только она появится. Баллы ниже посчитаны на устройстве тем же движком.`
            : `Прохождение заняло ${formatDuration(Date.now() - sessionStart.current)}. Ответы сохранены.`}
        </Body>
        {assigned.length ? (
          <Card>
            <Body>
              По результату назначено дополнительное обследование:{" "}
              {assigned.join(", ")}. Оно уже ждёт на главном экране.
            </Body>
          </Card>
        ) : null}
        {safetyPlan ? (
          <Card style={{ borderColor: severityColor.severe, borderWidth: 2 }}>
            <Text style={{ color: c.text, fontSize: 16, fontWeight: "700", marginBottom: 6 }}>
              Важно прямо сейчас
            </Text>
            <Text style={{ color: c.text, fontSize: 15, lineHeight: 22 }}>{safetyPlan}</Text>
          </Card>
        ) : null}
        {result.length > 0 ? (
          <Card>
            <Body>{ut("ms.subscaleResults")}</Body>
            {result.map((s) => (
              <View key={s.scaleId} style={{ gap: spacing.xs, marginTop: spacing.md }}>
                <Row>
                  <Body>{s.scaleTitle}</Body>
                  <View style={{ flex: 1 }} />
                  <Text style={{ color: c.muted, fontVariant: ["tabular-nums"] }}>
                    {s.rawScore} из {s.maxScore}
                  </Text>
                </Row>
                {s.band ? <SeverityTag severity={s.band.severity} label={s.band.label} /> : null}
                {s.band?.description ? <Body muted>{s.band.description}</Body> : null}
              </View>
            ))}
            <Body muted>
              Результат скрининга не является диагнозом — его интерпретирует специалист.
            </Body>
          </Card>
        ) : null}
        {responseId ? (
          <Button
            title={ut("ms.openConclusion")}
            variant="secondary"
            onPress={() => Linking.openURL(api.reportUrl(responseId))}
          />
        ) : null}
        <Button title="К списку методик" onPress={() => router.replace("/(app)/surveys")} />
      </ScrollView>
    );
  }

  /* ─── экран инструкции ─── */
  if (step === -1) {
    return (
      <ScrollView
        style={{ backgroundColor: c.bg }}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
      >
        <Title>{survey.title}</Title>
        {survey.description ? <Body muted>{survey.description}</Body> : null}
        {resumed ? (
          <Card>
            <Body>{ut("ms.unfinishedFound")}</Body>
            <Body muted>
              Ответы сохранены{savedAt ? ` ${savedAt.slice(0, 16).replace("T", " ")}` : ""} —
              продолжите с того места, где остановились.
            </Body>
          </Card>
        ) : null}
        {survey.instructions ? (
          <Card>
            <Body>{survey.instructions}</Body>
          </Card>
        ) : null}
        <Card>
          <Row>
            <Body muted>{ut("ms.questions")}</Body>
            <View style={{ flex: 1 }} />
            <Body>{visible.filter((q) => q.type !== "info").length}</Body>
          </Row>
          {survey.timeLimitSec ? (
            <Row>
              <Body muted>{ut("ms.timeLimit")}</Body>
              <View style={{ flex: 1 }} />
              <Body>{Math.round(survey.timeLimitSec / 60)} мин</Body>
            </Row>
          ) : null}
        </Card>
        <Button
          title={resumed ? ut("ms.continue") : ut("ms.start")}
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
      </ScrollView>
    );
  }

  if (!current) return <Loader />;

  const asked = visible.filter((q) => q.type !== "info");
  const askedIndex = asked.findIndex((q) => q.id === current.id);
  const progress = asked.length ? (askedIndex + 1) / asked.length : 1;
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

  const canAdvance = !current.required || isAnswered(current, answers.get(current.id));
  const isLast = step === visible.length - 1;
  const section = sectionOf(current);
  const overtime = survey.timeLimitSec ? elapsed > survey.timeLimitSec * 1000 : false;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: c.bg }}
      keyboardVerticalOffset={90}
    >
      {survey.showProgress ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.xs }}>
          <Row>
            <Text style={{ color: c.muted, fontSize: 12 }}>
              {current.type === "info" ? ut("runner.info") : `${ut("runner.question")} ${askedIndex + 1} ${ut("common.of")} ${asked.length}`}
            </Text>
            {/*
              Оценка оставшегося времени важнее прошедшего: человек с
              двухсотпунктовым опросником решает, успеет ли он сейчас, а не
              интересуется, сколько уже потратил. Считается по своему же
              темпу, а не по чужой медиане — так честнее.
             */}
            {remainingMinutes !== null ? (
              <Text style={{ color: c.muted, fontSize: 12 }}>
                ≈{remainingMinutes} мин осталось
              </Text>
            ) : null}
            <View style={{ flex: 1 }} />
            {savedAt ? (
              /*
               * Разница между «сохранено на телефоне» и «сохранено на сервере»
               * человеку важна: во втором случае прохождение переживёт потерю
               * телефона, в первом — только его собственную память.
               */
              <Text
                style={{ color: c.muted, fontSize: 12 }}
                accessibilityLabel={draftSynced ? ut("ms.answersSaved") : ut("ms.savedHereOnly")}
              >
                {draftSynced ? `✓ ${ut("ms.saved")}` : `⌁ ${ut("ms.savedHere")}`}
              </Text>
            ) : null}
            <Text style={{ color: overtime ? c.danger : c.muted, fontSize: 12 }}>
              {formatDuration(elapsed)}
              {survey.timeLimitSec ? ` / ${Math.round(survey.timeLimitSec / 60)} мин` : ""}
            </Text>
            {/*
              Укрупнение текста прямо на экране прохождения: лезть в
              настройки телефона посреди обследования никто не будет.
             */}
            <Pressable
              onPress={cycle}
              accessibilityRole="button"
              accessibilityLabel={`Размер текста, сейчас ${Math.round(scale * 100)} процентов`}
              hitSlop={12}
              style={{ paddingLeft: spacing.sm }}
            >
              <Text style={{ color: scale > 1 ? c.primary : c.muted, fontSize: 14, fontWeight: "700" }}>
                А{scale > 1 ? "+" : ""}
              </Text>
            </Pressable>
          </Row>
          {/* полоса без подписи для диктора — просто декорация; озвучиваем сам прогресс */}
          <View
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: asked.length, now: askedIndex + 1 }}
            style={{ height: 4, backgroundColor: c.border, borderRadius: 2 }}
          >
            <View
              style={{
                height: 4,
                width: `${Math.round(progress * 100)}%`,
                backgroundColor: c.primary,
                borderRadius: 2,
              }}
            />
          </View>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        {section ? (
          <View style={{ gap: 2 }}>
            <Text style={{ color: c.primary, fontSize: 12, fontWeight: "700", letterSpacing: 0.4 }}>
              {section.title.toUpperCase()}
            </Text>
            {section.description ? <Body muted>{section.description}</Body> : null}
          </View>
        ) : null}

        <View style={{ gap: spacing.xs }}>
          {/* формулировка пункта укрупняется вместе с вариантами: читать
              приходится и то и другое */}
          <Text style={{ color: c.text, fontSize: fs(19), fontWeight: "600", lineHeight: fs(26) }}>
            {current.title}
          </Text>
          {current.help ? <Body muted>{current.help}</Body> : null}
          {current.required && current.type !== "info" ? (
            <Text style={{ color: c.muted, fontSize: 12 }}>{ut("ms.requiredQuestion")}</Text>
          ) : null}
        </View>

        <QuestionInput
          question={current}
          value={answers.get(current.id)}
          onChange={(patch) => patchAnswer(current, patch)}
        />

        <ErrorText>{error}</ErrorText>
      </ScrollView>

      <View
        style={{
          flexDirection: "row",
          gap: spacing.md,
          padding: spacing.lg,
          borderTopWidth: 1,
          borderTopColor: c.border,
          backgroundColor: c.card,
        }}
      >
        {survey.allowBack && step > 0 ? (
          <View style={{ flex: 1 }}>
            <Button title={ut("common.back")} variant="secondary" onPress={() => goTo(step - 1)} />
          </View>
        ) : null}
        <View style={{ flex: 2 }}>
          <Button
            title={isLast ? ut("common.finish") : ut("common.next")}
            onPress={() => {
              if (!isLast) return goTo(step + 1);
              /*
               * Перед сдачей возвращаем к первому пропущенному обязательному
               * пункту. Иначе человек упирается в отказ сервера и ищет
               * пропуск сам — в опроснике на двести пунктов это тупик.
               */
              const missing = visible.findIndex(
                (q) => q.required && q.type !== "info" && !isAnswered(q, answers.get(q.id)),
              );
              if (missing >= 0 && missing !== step) {
                setError(ut("runner.missingRequired"));
                return goTo(missing);
              }
              return submit();
            }}
            disabled={!canAdvance}
            loading={busy}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
