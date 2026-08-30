import { useState } from "react";
import type { CaseSummary as Summary } from "@quizzy/shared";
import { api, type TreatmentGoal } from "../api";
import { day } from "../format";
import { useAction } from "../ui";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { Panel } from "../ui/layout";
import { Button, Field, Input, Select } from "../ui/primitives";

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
    <Panel
      title={ut("goal.title")}
      hint={ut("goal.hint")}
      actions={<Button onClick={() => setAdding((v) => !v)}>{adding ? ut("common.cancel") : ut("goal.add")}</Button>}
    >
      {adding ? (
        <div className="fields mb-3">
          <Field label={ut("goal.survey")}>
            <Select
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
            </Select>
          </Field>
          <Field label={ut("goal.scale")}>
            <Select value={scaleCode} onChange={(e) => setScaleCode(e.target.value)}>
              <option value="">—</option>
              {scalesOf.map((sc) => (
                <option key={sc.code} value={sc.code}>
                  {sc.title} · {sc.lastValue}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={ut("goal.direction")}>
            <Select value={direction} onChange={(e) => setDirection(e.target.value as "down" | "up")}>
              <option value="down">{ut("goal.down")}</option>
              <option value="up">{ut("goal.up")}</option>
            </Select>
          </Field>
          <Field label={ut("goal.target")}>
            <Input value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button
              variant="primary"
              disabled={busy || !surveyId || !scaleCode || !target.trim()}
              onClick={create}
            >
              {ut("goal.set")}
            </Button>
          </div>
        </div>
      ) : null}

      {goals.length === 0 ? (
        <p className="m-0 text-caption text-muted">{ut("goal.empty")}</p>
      ) : (
        goals.map((g) => <GoalRow key={g.id} g={g} onChanged={res.reload} run={run} busy={busy} />)
      )}
    </Panel>
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
          <span className="text-muted">{g.surveyTitle}</span>
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
        <div className="m-0 text-caption text-muted">
          {ut("goal.from")} {g.baselineValue ?? "—"} → {ut("goal.to")} {g.targetValue} ·{" "}
          {ut("goal.now")} {g.currentValue ?? "—"} · {ut("goal.measurements")} {g.measurements}
          {g.dueAt ? ` · ${ut("pw.due")} ${day(g.dueAt)}` : ""}
        </div>
        <span className="goal-bar">
          {/* ширина считается из данных на каждый рендер — не токен, инлайн-стиль оставлен намеренно */}
          <i style={{ width: `${share}%` }} />
        </span>
      </div>

      {open ? (
        <div className="row tight">
          <Button disabled={busy} onClick={() => void run(async () => { await api.closeGoal(g.id, "met"); onChanged(); }, ut("goal.closed"))}>
            {ut("goal.markMet")}
          </Button>
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => void run(async () => { await api.closeGoal(g.id, "missed"); onChanged(); }, ut("goal.closed"))}
          >
            {ut("goal.markMissed")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
