import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Answer, SurveyFull } from "@quizzy/shared";
import { isAnswered, isQuestionVisible } from "@quizzy/shared";
import { api, type Patient } from "../api";
import { useResource } from "../useResource";
import { SeverityTag } from "../charts/advanced";
import { Loading } from "../ui";
import { Page, Panel, Stack } from "../ui/layout";
import { Button } from "../ui/primitives";
import { useLang } from "../lang";

/**
 * Заполнение методики специалистом за пациента.
 *
 * Все пункты на одной странице: клиницист работает не как респондент, он
 * переносит уже собранные сведения, и постраничный мастер тут только мешает.
 */
export default function Administer() {
  const { ut } = useLang();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [subject, setSubject] = useState("");
  const [answers, setAnswers] = useState<Map<string, Answer>>(new Map());
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.submitFor>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useMemo(() => new Date().toISOString(), []);

  const res = useResource(
    async () => {
      const [survey, patients] = await Promise.all([
        api.survey(id!),
        api.patients().then((p) => p.items),
      ]);
      return { survey, patients };
    },
    [id],
    { enabled: !!id },
  );
  const survey: SurveyFull | null = res.data?.survey ?? null;
  const patients: Patient[] = res.data?.patients ?? [];

  // ошибка ниже — про сдачу, а не про загрузку: у них разные состояния
  if (!survey) return <Loading error={res.error} />;

  const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, answers));
  const unanswered = visible.filter((q) => q.required && q.type !== "info" && !isAnswered(q, answers.get(q.id)));

  function set(questionId: string, patch: Partial<Answer>) {
    setAnswers((prev) => {
      const next = new Map(prev);
      next.set(questionId, { ...next.get(questionId), ...patch, questionId });
      return next;
    });
  }

  async function submit() {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.submitFor(id, {
        onBehalfOf: subject,
        startedAt: started,
        durationMs: Date.now() - new Date(started).getTime(),
        status: "completed",
        events: [],
        answers: [...answers.values()],
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("ad.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const scores = result.scores as {
      scaleCode: string;
      scaleTitle: string;
      rawScore: number;
      value: number;
      band: { label: string; severity: "none" | "mild" | "moderate" | "severe"; recommendation: string | null } | null;
    }[];
    return (
      <Page title={ut("adn.saved")} sub={survey.title}>
        <Stack>
          {!result.reliable ? (
            <Panel className="border border-[var(--sev-severe)]">
              <strong>{ut("ad.unreliable")}</strong>
              {result.warnings.map((w, i) => (
                <p key={i} className="text-caption text-muted">{w}</p>
              ))}
            </Panel>
          ) : null}
          <Panel>
            <div className="scroll-x">
              <table>
                <thead><tr><th>{ut("ad.scale")}</th><th className="num">{ut("ad.raw")}</th><th className="num">{ut("ad.value")}</th><th>{ut("ad.interpretation")}</th><th>{ut("ad.recommendation")}</th></tr></thead>
                <tbody>
                  {scores.map((s) => (
                    <tr key={s.scaleCode}>
                      <td>{s.scaleTitle}</td>
                      <td className="num">{s.rawScore}</td>
                      <td className="num">{s.value}</td>
                      <td>{s.band ? <SeverityTag severity={s.band.severity} label={s.band.label} /> : "—"}</td>
                      <td className="text-muted">{s.band?.recommendation ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Button variant="primary" onClick={() => navigate(`/surveys/${survey.id}`)}>К аналитике методики</Button>
        </Stack>
      </Page>
    );
  }

  return (
    <Page
      title={survey.title}
      crumbs={<Link to={`/surveys/${survey.id}`}>← К методике</Link>}
      sub={`${ut("adn.byClinician")} · ${visible.filter((q) => q.type !== "info").length} ${ut("adn.items")}`}
    >
      <Stack>
        <Panel>
          <div className="field max-w-[460px] mb-0">
            <label>{ut("adn.whoIsTested")}</label>
            <select value={subject} onChange={(e) => setSubject(e.target.value)}>
              <option value="">{ut("adn.pickPatient")}</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>{p.fullName} · {p.email}</option>
              ))}
            </select>
          </div>
          {survey.instructions ? <p className="mt-3 text-caption text-muted">{survey.instructions}</p> : null}
        </Panel>

        {visible.map((q, i) => {
          if (q.type === "info") {
            return (
              <Panel key={q.id}>
                <strong>{q.title}</strong>
                {q.help ? <p className="mt-1 text-caption text-muted">{q.help}</p> : null}
              </Panel>
            );
          }
          const a = answers.get(q.id);
          const choices = q.options.filter((o) => o.kind === "option");
          return (
            <Panel key={q.id}>
              <div className="row items-start gap-3">
                <span className="text-muted min-w-[28px]">{i + 1}.</span>
                <div className="flex-1">
                  <div>{q.title}</div>
                  {q.help ? <p className="mb-1.5 text-caption text-muted">{q.help}</p> : null}
                  <div className="row mt-1.5">
                    {choices.length ? (
                      choices.map((o) => (
                        <button
                          key={o.id}
                          className={`chip ${a?.optionIds?.includes(o.id) ? "active" : ""}`}
                          onClick={() =>
                            set(q.id, {
                              optionIds: q.type === "multiple"
                                ? (a?.optionIds ?? []).includes(o.id)
                                  ? (a?.optionIds ?? []).filter((x) => x !== o.id)
                                  : [...(a?.optionIds ?? []), o.id]
                                : [o.id],
                            })
                          }
                        >
                          {o.text}
                          {o.riskFlag ? " ⚠" : ""}
                        </button>
                      ))
                    ) : ["scale", "slider", "number"].includes(q.type) ? (
                      <input
                        type="number"
                        className="w-40"
                        value={a?.number ?? ""}
                        onChange={(e) => set(q.id, { number: e.target.value === "" ? undefined : Number(e.target.value) })}
                      />
                    ) : (
                      <input
                        className="max-w-[520px]"
                        value={a?.text ?? ""}
                        onChange={(e) => set(q.id, { text: e.target.value })}
                      />
                    )}
                  </div>
                </div>
              </div>
            </Panel>
          );
        })}

        {error ? <p className="text-danger text-small">{error}</p> : null}
        <div className="row">
          <Button variant="primary" onClick={submit} disabled={!subject || unanswered.length > 0 || busy}>
            {busy ? ut("ad.saving") : ut("ad.save")}
          </Button>
          {unanswered.length ? <span className="text-muted">не заполнено обязательных: {unanswered.length}</span> : null}
          {!subject ? <span className="text-muted">выберите пациента</span> : null}
        </div>
      </Stack>
    </Page>
  );
}
