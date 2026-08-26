import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  isAnswered,
  isQuestionVisible,
  type Answer,
  type AnswerEventInput,
  type KioskState,
  type Question,
  type SurveyFull,
} from "@quizzy/shared";

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
  | { kind: "finished"; name: string };

export default function Kiosk() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<KioskState | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    if (!token) return;
    fetch(`/api/kiosk/state/${token}`)
      .then((r) => r.json())
      .then((s: KioskState) => {
        setState(s);
        setPhase(s.valid ? { kind: "idle" } : { kind: "invalid", reason: s.reason ?? "unknown" });
      })
      .catch(() => setPhase({ kind: "invalid", reason: "unknown" }));
  }, [token]);

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

  if (phase.kind === "loading") return <Shell><p className="muted">Загрузка…</p></Shell>;

  if (phase.kind === "invalid") {
    const text: Record<string, string> = {
      expired: "Срок сеанса истёк. Обратитесь к оператору.",
      closed: "Сеанс завершён оператором.",
      unknown: "Сеанс не найден. Проверьте ссылку.",
    };
    return <Shell><h1>Сеанс не действует</h1><p className="muted">{text[phase.reason] ?? text.unknown}</p></Shell>;
  }

  if (!state?.valid) return null;
  const selfSteps = (state.steps ?? []).filter((s) => s.administration === "self");

  if (phase.kind === "idle") {
    return (
      <Shell>
        <h1>{state.title}</h1>
        <p className="muted" style={{ fontSize: 17 }}>
          Обследование «{state.batteryTitle}»: {selfSteps.length}{" "}
          {plural(selfSteps.length, "методика", "методики", "методик")},{" "}
          {selfSteps.reduce((n, s) => n + s.questionCount, 0)} вопросов.
        </p>
        <button
          className="primary kiosk-big"
          onClick={() => {
            document.documentElement.requestFullscreen?.().catch(() => {});
            setPhase({ kind: "join" });
          }}
        >
          Начать
        </button>
      </Shell>
    );
  }

  if (phase.kind === "join") {
    return <JoinForm token={token!} onJoined={(participantId) => setPhase({ kind: "running", participantId, stepIndex: 0 })} onCancel={() => setPhase({ kind: "idle" })} />;
  }

  if (phase.kind === "running") {
    const step = selfSteps[phase.stepIndex];
    if (!step) return <Shell><h1>Готово</h1></Shell>;
    return (
      <Runner
        key={step.surveyId}
        token={token!}
        participantId={phase.participantId}
        surveyId={step.surveyId}
        stepLabel={`Методика ${phase.stepIndex + 1} из ${selfSteps.length}`}
        onDone={() => {
          if (phase.stepIndex + 1 < selfSteps.length) {
            setPhase({ ...phase, stepIndex: phase.stepIndex + 1 });
          } else {
            setPhase({ kind: "finished", name: "" });
          }
        }}
      />
    );
  }

  // finished
  return (
    <Shell>
      <h1>Спасибо, обследование завершено</h1>
      <p className="muted" style={{ fontSize: 17 }}>Передайте планшет следующему.</p>
      <button className="primary kiosk-big" onClick={() => setPhase({ kind: "join" })}>
        Следующий участник
      </button>
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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="kiosk-page">
      <div className="kiosk-card">{children}</div>
    </div>
  );
}

/* ── Паспортная часть ── */

function JoinForm({ token, onJoined, onCancel }: { token: string; onJoined: (id: string) => void; onCancel: () => void }) {
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
      if (!res.ok) throw new Error(body?.error ?? "Не удалось начать");
      onJoined(body.participantId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось начать");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h1>Представьтесь</h1>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <label className="field grow"><span>Фамилия</span>
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} autoFocus /></label>
        <label className="field grow"><span>Имя</span>
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} /></label>
        <label className="field grow"><span>Отчество</span>
          <input value={middleName} onChange={(e) => setMiddleName(e.target.value)} /></label>
      </div>
      <div className="form-grid">
        <label className="field"><span>Пол</span>
          <select value={sex} onChange={(e) => setSex(e.target.value as never)}>
            <option value="">—</option>
            <option value="male">мужской</option>
            <option value="female">женский</option>
          </select></label>
        <label className="field"><span>Дата рождения</span>
          <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} /></label>
      </div>
      <p className="hint">Пол и дата рождения нужны для расчёта норм по вашей группе.</p>
      {error ? <p className="error">{error}</p> : null}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary kiosk-big" disabled={busy || !lastName.trim() || !firstName.trim()} onClick={submit}>
          {busy ? "Секунду…" : "Продолжить"}
        </button>
        <button onClick={onCancel}>Отмена</button>
      </div>
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
  onDone: () => void;
}) {
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
    fetch(`/api/kiosk/state/${token}/surveys/${surveyId}`)
      .then((r) => r.json())
      .then(setSurvey)
      .catch(() => setError("Не удалось загрузить методику"));
  }, [token, surveyId]);

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

  if (error) return <Shell><p className="error">{error}</p></Shell>;
  if (!survey || !current) return <Shell><p className="muted">Загрузка…</p></Shell>;

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
      if (!res.ok) throw new Error(body?.error ?? "Не удалось отправить");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить");
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
          <span className="muted">{stepLabel} · {survey.title}</span>
          {current.type !== "info" ? (
            <span className="muted">{askedIndex + 1} / {asked.length}</span>
          ) : null}
        </div>
        {survey.showProgress && asked.length > 0 ? (
          <div className="kiosk-progress">
            <i style={{ width: `${Math.round(((askedIndex + 1) / asked.length) * 100)}%` }} />
          </div>
        ) : null}

        <h1 className="kiosk-question">{current.title}</h1>
        {current.help ? <p className="muted" style={{ fontSize: 16 }}>{current.help}</p> : null}

        <QuestionInput question={current} answer={answers.get(current.id)} onChange={setAnswer} />

        {error ? <p className="error">{error}</p> : null}
        <div className="row" style={{ marginTop: "auto", paddingTop: 18 }}>
          {survey.allowBack && index > 0 ? (
            <button className="kiosk-big" onClick={() => setIndex(index - 1)}>Назад</button>
          ) : null}
          <div className="spacer" />
          <button className="primary kiosk-big" disabled={!canNext || busy} onClick={next}>
            {busy ? "Отправляем…" : index + 1 < visible.length ? "Дальше" : "Завершить"}
          </button>
        </div>
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
            <span className="muted">{question.minLabel}</span>
            <span className="muted">{question.maxLabel}</span>
          </div>
        </div>
      );
    }

    case "slider":
    case "number":
      return (
        <input
          type="number"
          className="kiosk-number"
          min={question.minValue ?? undefined}
          max={question.maxValue ?? undefined}
          value={answer?.number ?? ""}
          onChange={(e) => onChange({ ...base, number: e.target.value === "" ? undefined : Number(e.target.value) })}
        />
      );

    case "text":
    case "longtext":
      return (
        <textarea
          className="kiosk-text"
          rows={question.type === "longtext" ? 6 : 2}
          value={answer?.text ?? ""}
          onChange={(e) => onChange({ ...base, text: e.target.value })}
        />
      );

    case "date":
      return (
        <input
          type="date"
          className="kiosk-number"
          value={answer?.date ?? ""}
          onChange={(e) => onChange({ ...base, date: e.target.value })}
        />
      );

    default:
      // matrix/ranking на киоске не поддержаны: честно говорим, а не молчим
      return (
        <p className="error">
          Тип вопроса «{question.type}» не поддерживается в киоске. Обратитесь к оператору —
          эту методику нужно проходить в мобильном приложении.
        </p>
      );
  }
}
