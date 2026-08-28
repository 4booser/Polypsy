import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Loc } from "./constructor/fields";
import { PageHead, useAction } from "../ui";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/**
 * Редактор шаблона маршрута.
 *
 * Шаблон описывает путь, а не одного человека: скрининг → углублённое
 * обследование → решение. Срок каждого шага считается от начала маршрута, и
 * это видно прямо в поле: «через сколько дней от старта», а не «через
 * сколько после предыдущего». Иначе просрочка одного шага незаметно сдвигает
 * все следующие.
 */

type Kind = "survey" | "battery" | "referral" | "action" | "decision";

interface DraftStep {
  title: Record<string, string>;
  kind: Kind;
  surveyId: string | null;
  dueDays: number | null;
  required: boolean;
}

const emptyStep = (): DraftStep => ({
  title: { uk: "", ru: "" },
  kind: "action",
  surveyId: null,
  dueDays: null,
  required: true,
});

export default function PathwayEditor() {
  const { ut } = useLang();
  const navigate = useNavigate();
  const { run } = useAction();
  const surveys = useResource(() => api.surveys(), []).data ?? [];

  const [title, setTitle] = useState<Record<string, string>>({ uk: "", ru: "" });
  const [description, setDescription] = useState<Record<string, string>>({ uk: "", ru: "" });
  const [steps, setSteps] = useState<DraftStep[]>([emptyStep()]);

  const patch = (i: number, next: Partial<DraftStep>) =>
    setSteps((prev) => prev.map((s, k) => (k === i ? { ...s, ...next } : s)));

  const move = (i: number, delta: number) =>
    setSteps((prev) => {
      const next = [...prev];
      const target = i + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[i], next[target]] = [next[target]!, next[i]!];
      return next;
    });

  const ready =
    (title.uk?.trim() || title.ru?.trim()) &&
    steps.length > 0 &&
    steps.every((s) => s.title.uk?.trim() || s.title.ru?.trim());

  const save = () =>
    void run(async () => {
      const created = await api.createPathway({
        title,
        description: description.uk?.trim() || description.ru?.trim() ? description : null,
        steps: steps.map((s) => ({
          title: s.title,
          kind: s.kind,
          surveyId: s.kind === "survey" ? s.surveyId : null,
          dueDays: s.dueDays,
          required: s.required,
        })),
      });
      navigate(`/pathways?created=${created.id}`);
    }, ut("pwe.saved"));

  return (
    <>
      <PageHead
        title={ut("pwe.title")}
        sub={ut("pwe.sub")}
        crumbs={<Link to="/pathways">← {ut("pw.title")}</Link>}
        actions={
          <button className="primary" disabled={!ready} onClick={save}>
            {ut("pwe.save")}
          </button>
        }
      />

      <div className="card">
        <Loc label={ut("cb.title")} value={title} onChange={setTitle} />
        <Loc label={ut("cb.description")} value={description} onChange={setDescription} />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{ut("pwe.steps")}</h2>
          <button onClick={() => setSteps((s) => [...s, emptyStep()])}>{ut("pwe.addStep")}</button>
        </div>
        <p className="hint">{ut("pwe.dueHint")}</p>

        {steps.map((s, i) => (
          <div className="pwe-step" key={i}>
            <div className="row tight">
              <span className="pwe-num">{i + 1}</span>
              <button className="ghost" onClick={() => move(i, -1)} aria-label={ut("cq.moveUp")}>
                ↑
              </button>
              <button className="ghost" onClick={() => move(i, 1)} aria-label={ut("cq.moveDown")}>
                ↓
              </button>
              <div className="spacer" />
              <button
                className="chip-x"
                aria-label={ut("ui.delete")}
                onClick={() => setSteps((prev) => prev.filter((_, k) => k !== i))}
              >
                ✕
              </button>
            </div>

            <Loc label={ut("pwe.stepTitle")} value={s.title} onChange={(v) => patch(i, { title: v })} />

            <div className="fields">
              <div className="field">
                <label htmlFor={`kind-${i}`}>{ut("pwe.kind")}</label>
                <select
                  id={`kind-${i}`}
                  value={s.kind}
                  onChange={(e) => patch(i, { kind: e.target.value as Kind })}
                >
                  {(["survey", "battery", "referral", "action", "decision"] as Kind[]).map((k) => (
                    <option key={k} value={k}>
                      {ut(`pw.kind.${k}` as never)}
                    </option>
                  ))}
                </select>
              </div>

              {s.kind === "survey" ? (
                <div className="field">
                  <label htmlFor={`survey-${i}`}>{ut("goal.survey")}</label>
                  <select
                    id={`survey-${i}`}
                    value={s.surveyId ?? ""}
                    onChange={(e) => patch(i, { surveyId: e.target.value || null })}
                  >
                    <option value="">—</option>
                    {surveys.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.title}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              <div className="field">
                <label htmlFor={`due-${i}`}>{ut("pwe.dueDays")}</label>
                <input
                  id={`due-${i}`}
                  inputMode="numeric"
                  value={s.dueDays ?? ""}
                  onChange={(e) =>
                    patch(i, { dueDays: e.target.value.trim() === "" ? null : Number(e.target.value) })
                  }
                  placeholder={ut("pw.noDue")}
                />
              </div>

              <div className="field" style={{ justifyContent: "end" }}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={s.required}
                    onChange={(e) => patch(i, { required: e.target.checked })}
                  />
                  {ut("pwe.required")}
                </label>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
