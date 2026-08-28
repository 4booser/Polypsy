import { useState } from "react";
import type { CaseSummary as Summary } from "@quizzy/shared";
import { api, type TreatmentGoal } from "../api";
import { day } from "../format";
import { useAction } from "../ui";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/**
 * Цели лечения.
 *
 * «Стало полегче» нельзя ни проверить, ни передать коллеге; «доля выше 0.4 к
 * третьему месяцу» — можно. Прогресс считается из тех же замеров, что и вся
 * аналитика: отдельного «журнала успехов» нет и быть не должно — он разошёлся
 * бы с данными.
 *
 * Рядом с прогрессом показывается достоверность изменения. Это два разных
 * утверждения: «значение приблизилось к цели» и «изменение больше ошибки
 * измерения». Первое без второго — повод для осторожности, а не для отчёта.
 */
export function Goals({ userId, summary }: { userId: string; summary: Summary }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const res = useResource(() => api.goals(userId), [userId]);
  const [adding, setAdding] = useState(false);
  const [surveyId, setSurveyId] = useState("");
  const [scaleCode, setScaleCode] = useState("");
  const [direction, setDirection] = useState<"down" | "up">("down");
  const [target, setTarget] = useState("");

  const goals = res.data ?? [];
  const scalesOf = summary.surveys.find((s) => s.surveyId === surveyId)?.scales ?? [];

  const create = () =>
    void run(async () => {
      await api.createGoal(userId, {
        surveyId,
        scaleCode,
        direction,
        targetValue: Number(target.replace(",", ".")),
      });
      setAdding(false);
      setTarget("");
      res.reload();
    }, ut("goal.created"));

  return (
    <div className="card">
      <div className="card-head">
        <h2>{ut("goal.title")}</h2>
        <button onClick={() => setAdding((v) => !v)}>{adding ? ut("common.cancel") : ut("goal.add")}</button>
      </div>
      <p className="hint">{ut("goal.hint")}</p>

      {adding ? (
        <div className="fields" style={{ marginBottom: 12 }}>
          <div className="field">
            <label htmlFor="goal-survey">{ut("goal.survey")}</label>
            <select
              id="goal-survey"
              value={surveyId}
              onChange={(e) => {
                setSurveyId(e.target.value);
                setScaleCode("");
              }}
            >
              <option value="">—</option>
              {summary.surveys.map((s) => (
                <option key={s.surveyId} value={s.surveyId}>
                  {s.title}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="goal-scale">{ut("goal.scale")}</label>
            <select id="goal-scale" value={scaleCode} onChange={(e) => setScaleCode(e.target.value)}>
              <option value="">—</option>
              {scalesOf.map((sc) => (
                <option key={sc.code} value={sc.code}>
                  {sc.title} · {sc.lastValue}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="goal-dir">{ut("goal.direction")}</label>
            <select
              id="goal-dir"
              value={direction}
              onChange={(e) => setDirection(e.target.value as "down" | "up")}
            >
              <option value="down">{ut("goal.down")}</option>
              <option value="up">{ut("goal.up")}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="goal-target">{ut("goal.target")}</label>
            <input id="goal-target" value={target} onChange={(e) => setTarget(e.target.value)} />
          </div>
          <div className="field" style={{ alignSelf: "end" }}>
            <button
              className="primary"
              disabled={busy || !surveyId || !scaleCode || !target.trim()}
              onClick={create}
            >
              {ut("goal.set")}
            </button>
          </div>
        </div>
      ) : null}

      {goals.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>{ut("goal.empty")}</p>
      ) : (
        goals.map((g) => <GoalRow key={g.id} g={g} onChanged={res.reload} run={run} busy={busy} />)
      )}
    </div>
  );
}

function GoalRow({
  g,
  onChanged,
  run,
  busy,
}: {
  g: TreatmentGoal;
  onChanged: () => void;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
  busy: boolean;
}) {
  const { ut } = useLang();
  const open = g.status === "open";

  /*
   * Доля пути считается от точки отсчёта к цели, а не от нуля: цель «снизить
   * с 0.8 до 0.4» пройдена наполовину при 0.6, и именно это нужно видеть.
   */
  const share = (() => {
    if (g.baselineValue === null || g.currentValue === null) return 0;
    const span = g.targetValue - g.baselineValue;
    if (span === 0) return 100;
    const done = ((g.currentValue - g.baselineValue) / span) * 100;
    return Math.max(0, Math.min(100, Math.round(done)));
  })();

  return (
    <div className={`goal${open ? "" : " closed"}`}>
      <div className="grow">
        <div className="row tight">
          <strong>{g.scaleCode}</strong>
          <span className="muted">{g.surveyTitle}</span>
          {g.reached ? <span className="badge good">{ut("goal.reached")}</span> : null}
          {g.reliable === true ? (
            <span className="badge accent" title={`RCI ${g.rci}`}>
              {ut("goal.reliable")}
            </span>
          ) : g.reliable === false ? (
            <span className="badge" title={`RCI ${g.rci}`}>
              {ut("goal.withinError")}
            </span>
          ) : null}
          {!open ? <span className="badge">{ut(`goal.status.${g.status}` as never)}</span> : null}
        </div>
        <div className="hint" style={{ margin: 0 }}>
          {ut("goal.from")} {g.baselineValue ?? "—"} → {ut("goal.to")} {g.targetValue} ·{" "}
          {ut("goal.now")} {g.currentValue ?? "—"} · {ut("goal.measurements")} {g.measurements}
          {g.dueAt ? ` · ${ut("pw.due")} ${day(g.dueAt)}` : ""}
        </div>
        <span className="goal-bar">
          <i style={{ width: `${share}%` }} />
        </span>
      </div>

      {open ? (
        <div className="row tight">
          <button disabled={busy} onClick={() => void run(async () => { await api.closeGoal(g.id, "met"); onChanged(); }, ut("goal.closed"))}>
            {ut("goal.markMet")}
          </button>
          <button
            className="ghost"
            disabled={busy}
            onClick={() => void run(async () => { await api.closeGoal(g.id, "missed"); onChanged(); }, ut("goal.closed"))}
          >
            {ut("goal.markMissed")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
