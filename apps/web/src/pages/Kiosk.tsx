import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIdle, type IdleWatch } from "../kiosk/useIdle";
import { useParams } from "react-router-dom";
import { LangSwitch, useLang } from "../lang";
import {
  isAnswered,
  isQuestionVisible,
  type Answer,
  type AnswerEventInput,
  type KioskState,
  type Question,
  type SurveyFull,
} from "@quizzy/shared";
import { Button, Field, Input, Select, Textarea, Spacer, Toolbar } from "../ui/primitives";
import { Grid } from "../ui/layout";

/*
 * Кнопки-действия киоска крупнее любой кнопки в консоли — их видно от двери
 * и по ним бьют пальцем, не примеряясь. `Button` держит фиксированную высоту
 * ряда консоли (`h-9`), рассчитанную на текст в 13px, а не на кегль в 52px,
 * поэтому здесь она перебивается: `!important` нужен, потому что слой Tailwind
 * `utilities` и так сильнее `legacy`, но конфликтующие утилиты Tailwind между
 * собой порядок не гарантируют — только модификатор `!` решает спор однозначно.
 */
const heroBtn = "!h-auto !text-hero !font-semibold font-display tracking-[-0.02em]";
/** Поля ввода на киоске — крупнее, чем в консоли, но не размером с кнопку: их читают, а не бьют пальцем. */
const kioskField = "!h-14 !text-section";

/**
 * Киоск: один планшет — поток обследуемых.
 *
 * Цикл: стартовый экран → паспортная часть → методики батареи по порядку →
 * «передайте планшет следующему» → снова стартовый. Токен сеанса даёт только
 * это; полномочий оператора на устройстве нет. Бездействие возвращает киоск
 * на старт — забытый planшет не должен показывать чужие вопросы.
 */

const IDLE_LIMIT_MS = 4 * 60_000;

type Phase =
  | { kind: "loading" }
  | { kind: "invalid"; reason: string }
  | { kind: "idle" }
  | { kind: "join" }
  | { kind: "running"; participantId: string; stepIndex: number }
  | { kind: "finished"; safetyPlan: string | null };

export default function Kiosk() {
  const { token } = useParams<{ token: string }>();
  const { ut, lang } = useLang();
  const [state, setState] = useState<KioskState | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [lastSafetyPlan, setLastSafetyPlan] = useState<string | null>(null);

  /*
   * Возврат к началу: у планшета в коридоре нет оператора, который сменит
   * экран между двумя людьми.
   *
   * В середине прохождения — с предупреждением: человек мог задуматься над
   * вопросом, и сбросить его ответы молча было бы хамством. Полторы минуты
   * тишины плюс двадцать секунд на отклик.
   *
   * После завершения — молча и быстрее: спрашивать «вы ещё здесь» у пустого
   * стула незачем, а на экране может стоять план безопасности, который
   * показывается только при сработавшей тревоге. Самое чувствительное из
   * всего, что показывает планшет, не должно висеть дольше остального.
   */
  const backToStart = () => {
    setLastSafetyPlan(null);
    setPhase({ kind: "idle" });
  };
  const running = useIdle({
    active: phase.kind === "running" || phase.kind === "join",
    idleMs: 90_000,
    graceMs: 20_000,
    onReset: backToStart,
  });
  const finished = useIdle({
    active: phase.kind === "finished",
    idleMs: 45_000,
    graceMs: 0,
    onReset: backToStart,
  });
  void finished;

  useEffect(() => {
    if (!token) return;
    fetch(`/api/kiosk/state/${token}?lang=${lang}`)
      .then((r) => r.json())
      .then((s: KioskState) => {
        setState(s);
        setPhase(s.valid ? { kind: "idle" } : { kind: "invalid", reason: s.reason ?? "unknown" });
      })
      .catch(() => setPhase({ kind: "invalid", reason: "unknown" }));
  }, [token, lang]);

  // бездействие: на старт. Во время прохождения — тоже: брошенный планшет
  // с чужим недопройденным тестом хуже, чем потерянный прогресс
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const bumpIdle = useCallback(() => {
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      setPhase((p) => (p.kind === "running" || p.kind === "join" ? { kind: "idle" } : p));
    }, IDLE_LIMIT_MS);
  }, []);
  useEffect(() => {
    const events = ["pointerdown", "keydown", "touchstart"];
    events.forEach((e) => window.addEventListener(e, bumpIdle));
    bumpIdle();
    return () => events.forEach((e) => window.removeEventListener(e, bumpIdle));
  }, [bumpIdle]);

  // ловушка навигации назад: жест «назад» не должен выкидывать из теста
  useEffect(() => {
    history.pushState(null, "", location.href);
    const trap = () => history.pushState(null, "", location.href);
    window.addEventListener("popstate", trap);
    return () => window.removeEventListener("popstate", trap);
  }, []);

  if (phase.kind === "loading") return <Shell><p className="text-muted">{ut("common.loading")}</p></Shell>;

  if (phase.kind === "invalid") {
    const text: Record<string, string> = {
      expired: ut("kiosk.invalid.expired"),
      closed: ut("kiosk.invalid.closed"),
      unknown: ut("kiosk.invalid.unknown"),
    };
    return <Shell><h1>{ut("kiosk.invalid.title")}</h1><p className="text-muted">{text[phase.reason] ?? text.unknown}</p></Shell>;
  }

  if (!state?.valid) return null;
  const selfSteps = (state.steps ?? []).filter((s) => s.administration === "self");

  if (phase.kind === "idle") {
    return (
      <Shell>
        <h1>{state.title}</h1>
        <p className="text-section text-muted">
          «{state.batteryTitle}»: {selfSteps.length}{" "}
          {plural(selfSteps.length, ut("ksk.methodOne"), ut("ksk.methodFew"), ut("ksk.methodMany"))}
          , {selfSteps.reduce((n, s) => n + s.questionCount, 0)} {ut("surveys.questions")}.
        </p>
        <Button
          variant="primary"
          className={heroBtn}
          onClick={() => {
            document.documentElement.requestFullscreen?.().catch(() => {});
            setPhase({ kind: "join" });
          }}
        >
          {ut("common.start")}
        </Button>
      </Shell>
    );
  }

  if (phase.kind === "join") {
    return (
      <>
        {running.warning ? <StillHere watch={running} /> : null}
        <JoinForm token={token!} onJoined={(participantId) => setPhase({ kind: "running", participantId, stepIndex: 0 })} onCancel={() => setPhase({ kind: "idle" })} />
      </>
    );
  }

  // safety-план последней сдачи поднимается из раннера наверх
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (phase.kind === "running") {
    const step = selfSteps[phase.stepIndex];
    if (!step) return <Shell><h1>{ut("ks.done")}</h1></Shell>;
    return (
      <>
      {running.warning ? <StillHere watch={running} /> : null}
      <Runner
        key={step.surveyId}
        token={token!}
        participantId={phase.participantId}
        surveyId={step.surveyId}
        stepLabel={`${ut("ksk.methodWord")} ${phase.stepIndex + 1} ${ut("common.of")} ${selfSteps.length}`}
        onDone={(safetyPlan) => {
          if (safetyPlan) setLastSafetyPlan(safetyPlan);
          if (phase.stepIndex + 1 < selfSteps.length) {
            setPhase({ ...phase, stepIndex: phase.stepIndex + 1 });
          } else {
            setPhase({ kind: "finished", safetyPlan: safetyPlan ?? lastSafetyPlan });
          }
        }}
      />
      </>
    );
  }

  // finished
  return (
    <Shell>
      <h1>{ut("kiosk.thanks")}</h1>
      {phase.safetyPlan ? (
        <div className="kiosk-safety">
          <strong>{ut("kiosk.safetyNow")}</strong>
          <p className="mt-1.5 whitespace-pre-wrap">{phase.safetyPlan}</p>
        </div>
      ) : null}
      <p className="text-section text-muted">{ut("kiosk.passTablet")}</p>
      <Button
        variant="primary"
        className={heroBtn}
        onClick={backToStart}
      >
        {ut("kiosk.nextParticipant")}
      </Button>
    </Shell>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/**
 * «Вы ещё здесь?» поверх прохождения.
 *
 * Написано, что произойдёт и почему: не «сессия истекла», а «ответы этой
 * методики не сохранятся, чтобы они не попали в чужую карту». Человек в
 * коридоре имеет право знать, что планшет собирается сделать с тем, что он
 * уже успел ответить.
 */
function StillHere({ watch }: { watch: IdleWatch }) {
  const { ut } = useLang();
  return (
    <div className="kiosk-idle" role="alertdialog" aria-live="assertive">
      <div className="kiosk-idle-box">
        <h2 className="m-0 font-display text-section">{ut("kiosk.stillHere")}</h2>
        <p className="mt-2 text-muted">{ut("kiosk.stillHereWhy")}</p>
        <p className="mt-3 font-mono text-stat leading-none">
          {ut("kiosk.secondsLeft").replace("{n}", String(watch.secondsLeft))}
        </p>
        <Button variant="primary" className={heroBtn} onClick={watch.stay}>
          {ut("kiosk.continue")}
        </Button>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="kiosk-page">
      <div className="kiosk-lang"><LangSwitch /></div>
      <div className="kiosk-card">{children}</div>
    </div>
  );
}

/* ── Паспортная часть ── */

function JoinForm({ token, onJoined, onCancel }: { token: string; onJoined: (id: string) => void; onCancel: () => void }) {
  const { ut } = useLang();
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [sex, setSex] = useState<"male" | "female" | "">("");
  const [birthDate, setBirthDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/kiosk/state/${token}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lastName: lastName.trim(),
          firstName: firstName.trim(),
          middleName: middleName.trim() || null,
          sex: sex || null,
          birthDate: birthDate || null,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? ut("kiosk.cantStart"));
      onJoined(body.participantId);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("kiosk.cantStart"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h1>{ut("kiosk.introduce")}</h1>
      <Grid min={220} className="mt-3">
        <Field label={ut("person.lastName")} htmlFor="kiosk-lastName">
          <Input id="kiosk-lastName" value={lastName} onChange={(e) => setLastName(e.target.value)} autoFocus />
        </Field>
        <Field label={ut("person.firstName")} htmlFor="kiosk-firstName">
          <Input id="kiosk-firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </Field>
        <Field label={ut("person.middleName")} htmlFor="kiosk-middleName">
          <Input id="kiosk-middleName" value={middleName} onChange={(e) => setMiddleName(e.target.value)} />
        </Field>
      </Grid>
      <Grid min={220} className="mt-3">
        <Field label={ut("person.sex")} htmlFor="kiosk-sex">
          <Select id="kiosk-sex" value={sex} onChange={(e) => setSex(e.target.value as never)}>
            <option value="">—</option>
            <option value="male">{ut("person.sex.male")}</option>
            <option value="female">{ut("person.sex.female")}</option>
          </Select>
        </Field>
        <Field label={ut("person.birthDate")} htmlFor="kiosk-birthDate">
          <Input id="kiosk-birthDate" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
        </Field>
      </Grid>
      <p className="mt-3 text-caption text-muted">{ut("person.normsHint")}</p>
      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
      <Toolbar className="mt-2.5 gap-3">
        <Button variant="primary" className={heroBtn} disabled={busy || !lastName.trim() || !firstName.trim()} onClick={submit}>
          {busy ? ut("kiosk.momentPlease") : ut("common.continue")}
        </Button>
        <Button onClick={onCancel}>{ut("common.cancel")}</Button>
      </Toolbar>
    </Shell>
  );
}

/* ── Раннер методики ── */

function Runner({
  token,
  participantId,
  surveyId,
  stepLabel,
  onDone,
}: {
  token: string;
  participantId: string;
  surveyId: string;
  stepLabel: string;
  onDone: (safetyPlan: string | null) => void;
}) {
  const { ut, lang } = useLang();
  const [survey, setSurvey] = useState<SurveyFull | null>(null);
  const [answers, setAnswers] = useState<Map<string, Answer>>(new Map());
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startedAt = useRef(new Date().toISOString());
  const sessionStart = useRef(Date.now());
  const questionShownAt = useRef(Date.now());
  const meta = useRef(new Map<string, { durationMs: number; changeCount: number; visitCount: number }>());
  const events = useRef<AnswerEventInput[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    fetch(`/api/kiosk/state/${token}/surveys/${surveyId}?lang=${lang}`)
      .then((r) => r.json())
      .then(setSurvey)
      .catch(() => setError(ut("kiosk.cantLoad")));
  }, [token, surveyId, lang]);

  const visible = useMemo(() => {
    if (!survey) return [];
    return survey.questions.filter((q) => isQuestionVisible(q, survey.questions, answers));
  }, [survey, answers]);

  const current = visible[index];

  const pushEvent = useCallback((kind: AnswerEventInput["kind"], questionId: string, value?: unknown) => {
    events.current.push({
      questionId,
      sequence: seq.current++,
      kind,
      elapsedMs: Date.now() - sessionStart.current,
      at: new Date().toISOString(),
      value: value === undefined ? null : (value as never),
    });
  }, []);

  // показ вопроса: событие + учёт визита
  useEffect(() => {
    if (!current) return;
    questionShownAt.current = Date.now();
    const m = meta.current.get(current.id) ?? { durationMs: 0, changeCount: 0, visitCount: 0 };
    m.visitCount += 1;
    meta.current.set(current.id, m);
    pushEvent("shown", current.id);
    return () => {
      const mm = meta.current.get(current.id)!;
      mm.durationMs += Date.now() - questionShownAt.current;
      pushEvent("leave", current.id);
    };
  }, [current, pushEvent]);

  if (error && !survey) return <Shell><p role="alert" className="text-danger">{error}</p></Shell>;
  if (!survey || !current) return <Shell><p className="text-muted">{ut("common.loading")}</p></Shell>;

  const setAnswer = (a: Answer) => {
    const had = answers.get(current.id);
    const m = meta.current.get(current.id)!;
    if (had && isAnswered(current, had)) m.changeCount += 1;
    pushEvent(had ? "change" : "set", current.id, a.optionIds ?? a.number ?? a.text ?? null);
    const next = new Map(answers);
    next.set(current.id, a);
    setAnswers(next);
  };

  const canNext = current.type === "info" || !current.required || isAnswered(current, answers.get(current.id));

  async function next() {
    if (index + 1 < visible.length) {
      setIndex(index + 1);
      return;
    }
    // сдача
    setBusy(true);
    setError(null);
    try {
      const payload = {
        participantId,
        surveyId,
        status: "completed",
        startedAt: startedAt.current,
        durationMs: Date.now() - sessionStart.current,
        answers: [...answers.entries()].map(([questionId, a]) => ({
          ...a,
          questionId,
          durationMs: meta.current.get(questionId)?.durationMs ?? 0,
          changeCount: meta.current.get(questionId)?.changeCount ?? 0,
          visitCount: meta.current.get(questionId)?.visitCount ?? 1,
        })),
        events: events.current,
      };
      const res = await fetch(`/api/kiosk/state/${token}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? ut("kiosk.cantSubmit"));
      onDone(body?.safetyPlan ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("kiosk.cantSubmit"));
    } finally {
      setBusy(false);
    }
  }

  const asked = visible.filter((q) => q.type !== "info");
  const askedIndex = asked.indexOf(current);

  return (
    <div className="kiosk-page">
      <div className="kiosk-runner">
        <div className="kiosk-top">
          <span className="text-muted">{stepLabel} · {survey.title}</span>
          {current.type !== "info" ? (
            <span className="text-muted">{askedIndex + 1} / {asked.length}</span>
          ) : null}
        </div>
        {survey.showProgress && asked.length > 0 ? (
          <div className="kiosk-progress">
            {/* ширина полосы — рантайм-значение, единственное законное исключение для style */}
            <i style={{ width: `${Math.round(((askedIndex + 1) / asked.length) * 100)}%` }} />
          </div>
        ) : null}

        <h1 className="kiosk-question">{current.title}</h1>
        {current.help ? <p className="text-body text-muted">{current.help}</p> : null}

        <QuestionInput question={current} answer={answers.get(current.id)} onChange={setAnswer} />

        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
        <Toolbar className="mt-auto gap-3 pt-[18px]">
          {survey.allowBack && index > 0 ? (
            <Button className={heroBtn} onClick={() => setIndex(index - 1)}>{ut("common.back")}</Button>
          ) : null}
          <Spacer />
          <Button variant="primary" className={heroBtn} disabled={!canNext || busy} onClick={next}>
            {busy ? ut("common.sending") : index + 1 < visible.length ? ut("common.next") : ut("common.finish")}
          </Button>
        </Toolbar>
      </div>
    </div>
  );
}

function QuestionInput({
  question,
  answer,
  onChange,
}: {
  question: Question;
  answer: Answer | undefined;
  onChange: (a: Answer) => void;
}) {
  const { ut } = useLang();
  const base: Answer = { questionId: question.id };

  switch (question.type) {
    case "info":
      return null;

    case "yesno":
    case "single":
      return (
        <div className="kiosk-options">
          {question.options.filter((o) => o.kind === "option").map((o) => {
            const active = answer?.optionIds?.[0] === o.id;
            return (
              <button
                key={o.id}
                className={`kiosk-option ${active ? "active" : ""}`}
                onClick={() => onChange({ ...base, optionIds: [o.id] })}
              >
                {o.text}
              </button>
            );
          })}
        </div>
      );

    case "multiple":
      return (
        <div className="kiosk-options">
          {question.options.filter((o) => o.kind === "option").map((o) => {
            const set = new Set(answer?.optionIds ?? []);
            const active = set.has(o.id);
            return (
              <button
                key={o.id}
                className={`kiosk-option ${active ? "active" : ""}`}
                onClick={() => {
                  if (active) set.delete(o.id);
                  else set.add(o.id);
                  onChange({ ...base, optionIds: [...set] });
                }}
              >
                {active ? "✓ " : ""}{o.text}
              </button>
            );
          })}
        </div>
      );

    case "scale": {
      const min = question.minValue ?? 0;
      const max = question.maxValue ?? 10;
      const values = [];
      for (let v = min; v <= max; v += question.step ?? 1) values.push(v);
      return (
        <div>
          <div className="kiosk-scale">
            {values.map((v) => (
              <button
                key={v}
                className={`kiosk-option num ${answer?.number === v ? "active" : ""}`}
                onClick={() => onChange({ ...base, number: v })}
              >
                {v}
              </button>
            ))}
          </div>
          <div className="kiosk-scale-labels">
            <span className="text-muted">{question.minLabel}</span>
            <span className="text-muted">{question.maxLabel}</span>
          </div>
        </div>
      );
    }

    case "slider":
    case "number":
      return (
        <Input
          type="number"
          className={`${kioskField} max-w-xs`}
          min={question.minValue ?? undefined}
          max={question.maxValue ?? undefined}
          value={answer?.number ?? ""}
          onChange={(e) => onChange({ ...base, number: e.target.value === "" ? undefined : Number(e.target.value) })}
        />
      );

    case "text":
    case "longtext":
      return (
        <Textarea
          className="!text-section"
          rows={question.type === "longtext" ? 6 : 2}
          value={answer?.text ?? ""}
          onChange={(e) => onChange({ ...base, text: e.target.value })}
        />
      );

    case "date":
      return (
        <Input
          type="date"
          className={`${kioskField} max-w-xs`}
          value={answer?.date ?? ""}
          onChange={(e) => onChange({ ...base, date: e.target.value })}
        />
      );

    default:
      // matrix/ranking на киоске не поддержаны: честно говорим, а не молчим
      return (
        <p role="alert" className="text-danger">
          {ut("kiosk.unsupportedType")}
        </p>
      );
  }
}
