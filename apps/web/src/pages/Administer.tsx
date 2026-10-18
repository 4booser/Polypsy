import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { Answer, RespondentDynamics, Severity, SurveyFull } from "@quizzy/shared";
import { isAnswered, isQuestionVisible } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { betterOf } from "../charts/courseModel";
import { useDecimal } from "../charts/kit";
import { administerPayload, blankVersion, loadAdminister, preliminary } from "./administerModel";
import { useResource } from "../useResource";
import { Callout, CourseDigits, Ic, Loading } from "../ui";
import { cx } from "../ui/cx";
import { Page, Panel } from "../ui/layout";
import { Button, ButtonLink, ErrorText, Input, Segmented, SeverityTag, Tag } from "../ui/primitives";
import { FastEntry, askedOf, choicesOf } from "../components/FastEntry";
import { PatientPicker } from "../components/PatientPicker";
import { day } from "../format";
import { useLang } from "../lang";
import { Rx } from "./response/icons";

/**
 * Заполнение методики специалистом за пациента (Polypsy 2.0, кадр
 * methods-administer).
 *
 * Клиницист работает не как респондент: он переносит уже собранные сведения
 * — со слов на приёме или с бумажного бланка, — и постраничный мастер тут
 * только мешает. Два способа на одном экране: быстрое введение с клавиатуры
 * (пункт за пунктом, цифра — ответ) и мышью (все пункты списком). Справа —
 * предварительный подсчёт, критические пункты и что будет после сохранения.
 */
type Mode = "fast" | "mouse";

export default function Administer() {
  const { ut } = useLang();
  const { can } = useAuth();
  const { id } = useParams<{ id: string }>();
  // код бумажного бланка ведёт сюда с версией: вводится и сдаётся она, а не действующая (#169)
  const [params] = useSearchParams();
  const version = blankVersion(params.get("v"));
  const [subject, setSubject] = useState("");
  const [answers, setAnswers] = useState<Map<string, Answer>>(new Map());
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.submitFor>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Быстрый ввод — не альтернативный экран, а переключатель здесь же.
   * Отдельный экран означал бы выбор до начала работы, а выбирать хочется
   * по ходу: длинную методику переносят с клавиатуры, короткую быстрее
   * ткнуть мышью.
   */
  const [mode, setMode] = useState<Mode>("fast");
  const [at, setAt] = useState(0);
  const [focusTick, setFocusTick] = useState(0);
  const [started, setStarted] = useState(() => new Date().toISOString());

  const res = useResource(() => loadAdminister(id!, version), [id, version], { enabled: !!id });
  const survey: SurveyFull | null = res.data?.survey ?? null;
  const history = useResource(
    () => api.dynamics(subject, id!).then((d): { d: RespondentDynamics | null } => ({ d }), () => ({ d: null })),
    [subject, id],
    { enabled: !!subject && !!id && can("patients.read"), keep: false },
  );

  // ошибка ниже — про сдачу, а не про загрузку: у них разные состояния
  if (!survey) return <Loading error={res.error} onRetry={res.reload} busy={res.loading} />;

  const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, answers));
  const unanswered = visible.filter((q) => q.required && q.type !== "info" && !isAnswered(q, answers.get(q.id)));
  const asked = askedOf(survey);
  const back = `/surveys/${survey.id}`;

  function set(questionId: string, patch: Partial<Answer>) {
    setAnswers((prev) => {
      const next = new Map(prev);
      next.set(questionId, { ...next.get(questionId), ...patch, questionId });
      return next;
    });
  }

  async function submit() {
    if (!id || !survey) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.submitFor(id, administerPayload(survey, { subject, startedAt: started, answers }));
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : ut("ad.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Saved
        survey={survey}
        result={result}
        onAgain={() => {
          setResult(null);
          setAnswers(new Map());
          setAt(0);
          setStarted(new Date().toISOString());
        }}
      />
    );
  }

  const header = {
    title: ut("adx.title"),
    back: { to: back, label: ut("back.toSurvey") },
    meta: [
      `${survey.title}, ${ut("rp.versionN").replace("{n}", String(survey.versionNumber))}`,
      ut("adx.itemsCount").replace("{n}", String(asked.length)),
    ] as [string, string],
    actions: (
      <>
        <ButtonLink to={`/surveys/${survey.id}/blank${version ? `?v=${version}` : ""}`}>
          <Rx.printer />
          {ut("adx.paper")}
        </ButtonLink>
        <ButtonLink to={back} variant="ghost">
          <Ic.x />
          {ut("common.cancel")}
        </ButtonLink>
      </>
    ),
    toolbar: (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-small text-text-2">
        <Tag tone="primary" icon={<Rx.filePlus />}>
          {ut("adx.newUnsaved")}
        </Tag>
        <span className="inline-flex items-center gap-1.5">
          <Rx.userRound size={14} />
          {ut("adn.byClinician")}
        </span>
      </div>
    ),
  };

  return (
    <Page {...header}>
      <div className="grid items-start gap-4 grid-cols-[minmax(0,1fr)_360px] max-[1360px]:grid-cols-[minmax(0,1fr)_320px] max-[1100px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={ut("adn.whoIsTested")} icon={<Rx.userRound />}>
            {/* поиск на сервере: первая сотня без поиска прятала остальных (#174) */}
            <PatientPicker
              value={subject}
              onChange={setSubject}
              label={ut("adn.whoIsTested")}
              emptyLabel={ut("adn.pickPatient")}
              className="grid grid-cols-2 gap-3 max-[900px]:grid-cols-1"
            />
            {survey.instructions ? (
              <Callout kind="neutral" icon={<Rx.quote />} title={ut("adx.instruction")} className="mt-4">
                <span className="whitespace-pre-line">{survey.instructions}</span>
              </Callout>
            ) : null}
          </Panel>

          <Panel
            title={mode === "fast" ? `${ut("fast.item")} ${at + 1} ${ut("fast.of")} ${asked.length}` : ut("adx.allItems")}
            icon={<Ic.keyboard />}
            sub={leftText(asked, answers, ut)}
            actions={
              <Segmented<Mode>
                label={ut("adx.mode")}
                value={mode}
                onChange={(m) => {
                  setMode(m);
                  if (m === "fast") setFocusTick((t) => t + 1);
                }}
                items={[
                  { key: "fast", label: ut("fast.mode") },
                  { key: "mouse", label: ut("fast.byMouse") },
                ]}
              />
            }
          >
            {mode === "fast" ? (
              <FastEntry survey={survey} answers={answers} onSet={set} at={at} setAt={setAt} focusTick={focusTick} />
            ) : (
              <MouseEntry survey={survey} visible={visible} answers={answers} onSet={set} />
            )}
          </Panel>

          {mode === "fast" ? <AllItems survey={survey} answers={answers} at={at} onGo={setAt} /> : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4 min-[1101px]:sticky min-[1101px]:top-0">
          <SummaryPanel survey={survey} answers={answers} history={history.data?.d ?? null} />
          {asked.some((q) => choicesOf(q).some((o) => o.riskFlag)) ? <CriticalNote survey={survey} /> : null}
          <Panel title={ut("adx.after")} icon={<Rx.listChecks />}>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              <li className="flex gap-2.5 py-1 text-small text-text-2">
                <Rx.table size={15} className="mt-px text-muted" />
                {ut("adx.afterTable")}
              </li>
              <li className="flex gap-2.5 py-1 text-small text-text-2">
                <Rx.filePlus size={15} className="mt-px text-muted" />
                {ut("adx.afterRecord")}
              </li>
            </ul>
            {error ? (
              <ErrorText className="mt-3" tone="risk">
                {error}
              </ErrorText>
            ) : null}
            <Button
              variant="primary"
              className="mt-3 w-full"
              icon={<Ic.check />}
              onClick={submit}
              disabled={!subject || unanswered.length > 0 || busy}
            >
              {busy ? ut("ad.saving") : ut("ad.save")}
            </Button>
            <p className="m-0 mt-2 text-center text-caption text-muted">
              {!subject
                ? ut("sel.pickPatient")
                : unanswered.length
                  ? `${ut("adn.unansweredRequired")} ${unanswered.length}`
                  : ut("adx.ready")}
            </p>
          </Panel>
        </div>
      </div>
    </Page>
  );
}

function leftText(asked: SurveyFull["questions"], answers: Map<string, Answer>, ut: ReturnType<typeof useLang>["ut"]): string {
  const left = asked.filter((q) => !isAnswered(q, answers.get(q.id))).length;
  return left === 0 ? ut("fast.done") : `${ut("fast.left")} ${left}`;
}

/** Мышью: все пункты списком, варианты — плитками */
function MouseEntry({
  survey,
  visible,
  answers,
  onSet,
}: {
  survey: SurveyFull;
  visible: SurveyFull["questions"];
  answers: Map<string, Answer>;
  onSet: (questionId: string, patch: Partial<Answer>) => void;
}) {
  const { ut } = useLang();
  let n = 0;
  return (
    <ol className="-mx-4 -mb-4 m-0 list-none p-0">
      {visible.map((q) => {
        if (q.type === "info") {
          return (
            <li key={q.id} className="border-t border-divider bg-panel-2 px-4 py-3">
              <b className="text-body font-extrabold text-text">{q.title}</b>
              {q.help ? <p className="m-0 mt-1 text-small text-muted">{q.help}</p> : null}
            </li>
          );
        }
        n += 1;
        const a = answers.get(q.id);
        const choices = choicesOf(q);
        return (
          <li key={q.id} className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-2 border-t border-divider px-4 py-3">
            <span className="text-small font-extrabold text-muted">{n}</span>
            <div className="min-w-0">
              <p className="m-0 text-body font-bold text-text">{q.title}</p>
              {q.help ? <p className="m-0 mt-0.5 text-small text-muted">{q.help}</p> : null}
              <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={q.title}>
                {choices.length ? (
                  choices.map((o) => {
                    const on = a?.optionIds?.includes(o.id) ?? false;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        aria-pressed={on}
                        className={cx(
                          "inline-flex min-h-8 cursor-pointer items-center gap-1.5 whitespace-normal rounded-[9px] border-0 px-3 py-1 text-left text-small font-bold",
                          on ? "bg-violet text-onfill" : "bg-sunk text-text-2 hover:bg-sunk-2 hover:text-text",
                        )}
                        onClick={() =>
                          onSet(q.id, {
                            optionIds:
                              q.type === "multiple"
                                ? (a?.optionIds ?? []).includes(o.id)
                                  ? (a?.optionIds ?? []).filter((x) => x !== o.id)
                                  : [...(a?.optionIds ?? []), o.id]
                                : [o.id],
                          })
                        }
                      >
                        {o.text}
                        {/* значок нем для диктора — подпись рядом, скрытая */}
                        {o.riskFlag ? (
                          <>
                            <Rx.siren size={13} className={on ? "" : "text-risk-ink"} />
                            <span className="sr-only">{ut("mark.critical")}</span>
                          </>
                        ) : null}
                      </button>
                    );
                  })
                ) : ["scale", "slider", "number"].includes(q.type) ? (
                  <Input
                    type="number"
                    aria-label={q.title}
                    className="w-40"
                    value={a?.number ?? ""}
                    onChange={(e) => onSet(q.id, { number: e.target.value === "" ? undefined : Number(e.target.value) })}
                  />
                ) : (
                  <Input
                    aria-label={q.title}
                    className="max-w-[520px]"
                    value={a?.text ?? ""}
                    onChange={(e) => onSet(q.id, { text: e.target.value })}
                  />
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** «Усі пункти»: таблица ответов; строка переводит к пункту */
function AllItems({
  survey,
  answers,
  at,
  onGo,
}: {
  survey: SurveyFull;
  answers: Map<string, Answer>;
  at: number;
  onGo: (i: number) => void;
}) {
  const { ut } = useLang();
  const asked = askedOf(survey);
  const scaled = new Set(survey.scales.flatMap((s) => s.items.map((i) => i.questionId)));
  return (
    <Panel title={ut("adx.allItems")} icon={<Rx.listOrdered />} sub={ut("adx.allItemsSub")} flush>
      <div role="table" aria-label={ut("adx.allItems")}>
        <div role="row" className="grid grid-cols-[48px_minmax(0,1fr)_auto_minmax(160px,220px)] gap-x-3 border-t border-divider bg-panel-2 px-4 py-2 text-[11.5px] font-bold text-muted">
          <span role="columnheader">№</span>
          <span role="columnheader">{ut("rp.item")}</span>
          <span role="columnheader" />
          <span role="columnheader">{ut("adx.answer")}</span>
        </div>
        {asked.map((q, i) => {
          const a = answers.get(q.id);
          const done = isAnswered(q, a);
          const choices = choicesOf(q);
          const pickedIdx = done && a?.optionIds?.length === 1 ? choices.findIndex((o) => o.id === a.optionIds![0]) : -1;
          const picked = pickedIdx >= 0 ? choices[pickedIdx]! : null;
          const critical = choices.some((o) => o.riskFlag);
          return (
            <button
              key={q.id}
              type="button"
              role="row"
              onClick={() => onGo(i)}
              aria-current={i === at ? "step" : undefined}
              className={cx(
                "grid w-full cursor-pointer grid-cols-[48px_minmax(0,1fr)_auto_minmax(160px,220px)] items-center gap-x-3 border-0 border-t border-divider px-4 py-2 text-left text-[13px] leading-[17px]",
                i === at ? "bg-violet-tint" : "bg-transparent hover:bg-sunk",
              )}
            >
              <span role="cell" className="font-extrabold text-muted">
                {i + 1}
              </span>
              <span role="cell" className="min-w-0 truncate font-semibold text-text">
                {q.title}
              </span>
              <span role="cell">
                {critical ? (
                  <Tag tone="danger" icon={<Rx.siren />}>
                    {ut("mark.critical")}
                  </Tag>
                ) : !scaled.has(q.id) && survey.scales.length ? (
                  <Tag>{ut("rp.notInSum")}</Tag>
                ) : null}
              </span>
              <span role="cell" className="flex min-w-0 items-center gap-2">
                {i === at && !done ? (
                  <span className="inline-flex items-center gap-1.5 font-extrabold text-violet-ink">
                    <Rx.cornerDownRight size={14} />
                    {ut("adx.now")}
                  </span>
                ) : picked ? (
                  <>
                    <span className="grid h-[22px] min-w-[22px] place-items-center rounded-[6px] bg-violet-tint px-1 text-[12px] font-extrabold text-violet-ink">
                      {pickedIdx + 1}
                    </span>
                    <span className="truncate text-text-2">{picked.text}</span>
                  </>
                ) : done ? (
                  <span className="truncate text-text-2">{a?.text ?? a?.number ?? <Ic.check size={14} />}</span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

/** «Попередній підсумок»: сумма по отвеченным, диапазон к концу, прежние замеры человека */
function SummaryPanel({
  survey,
  answers,
  history,
}: {
  survey: SurveyFull;
  answers: Map<string, Answer>;
  history: RespondentDynamics | null;
}) {
  const { ut } = useLang();
  const dec = useDecimal();
  const p = preliminary(survey, answers);
  const asked = askedOf(survey);
  const done = asked.filter((q) => isAnswered(q, answers.get(q.id))).length;
  const scale = history?.surveys.find((s) => s.surveyId === survey.id)?.scales.find((s) => (p ? s.code === p.code : true));
  const points = scale ? [...scale.points].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)).slice(-4) : [];
  const last = points[points.length - 1];
  const better = p
    ? betterOf((survey.scales.find((s) => s.code === p.code)?.bands ?? []).map((b) => ({ min: b.minScore, max: b.maxScore, label: b.label, severity: b.severity })))
    : null;
  return (
    <Panel title={ut("adx.preliminary")} icon={<Rx.sigma />}>
      {p ? (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span className="flex items-baseline gap-1.5">
              <b className="text-stat font-extrabold leading-none tracking-[-0.03em] text-text tabular-nums">{dec(p.sum)}</b>
              <span className="text-body font-bold text-muted">
                /{dec(p.top)} {ut("adx.soFar")}
              </span>
            </span>
            <Tag>{ut("rp.kv.answered").replace("{n}", String(done)).replace("{m}", String(asked.length))}</Tag>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-[4px] bg-track" aria-hidden>
            <i className="block h-full rounded-[4px] bg-violet" style={{ width: `${asked.length ? (done / asked.length) * 100 : 0}%` }} />
          </div>
          <p className="m-0 mt-3 text-small text-text-2">
            {ut("adx.serverCounts")}{" "}
            {p.answered < p.items ? ut("adx.range").replace("{min}", dec(p.min)).replace("{max}", dec(p.max)) : null}
          </p>
        </>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <b className="text-big font-extrabold text-text">{ut("rp.kv.answered").replace("{n}", String(done)).replace("{m}", String(asked.length))}</b>
          </div>
          <p className="m-0 mt-2 text-small text-text-2">{ut("adx.serverCounts")}</p>
        </>
      )}
      {points.length ? (
        <div className="mt-3 border-t border-divider pt-3">
          <p className="m-0 mb-2 text-caption font-bold text-muted">{ut("adx.before")}</p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CourseDigits code={scale!.code} values={points.map((x) => Math.round(x.rawScore * 100) / 100)} better={better ?? "down"} />
            {last?.bandLabel && last.severity ? (
              <SeverityTag level={last.severity as Severity} small>
                {last.bandLabel}
              </SeverityTag>
            ) : null}
          </div>
          <p className="m-0 mt-1.5 text-caption text-muted">{points.map((x) => day(x.submittedAt)).join(", ")}</p>
        </div>
      ) : null}
    </Panel>
  );
}

/** Критические пункты методики: что будет, если ответ их заденет */
function CriticalNote({ survey }: { survey: SurveyFull }) {
  const { ut } = useLang();
  const asked = askedOf(survey);
  const numbers = asked.map((q, i) => (choicesOf(q).some((o) => o.riskFlag) ? i + 1 : null)).filter((n): n is number => n !== null);
  return (
    <Callout
      kind="risk"
      icon={<Rx.siren />}
      title={(numbers.length === 1 ? ut("adx.criticalOne") : ut("adx.criticalMany")).replace("{n}", numbers.join(", "))}
    >
      {ut("adx.criticalWhat")}
    </Callout>
  );
}

/** Сохранено: результат по шкалам, протокол и заключение — дальше отсюда */
function Saved({
  survey,
  result,
  onAgain,
}: {
  survey: SurveyFull;
  result: Awaited<ReturnType<typeof api.submitFor>>;
  onAgain: () => void;
}) {
  const { ut } = useLang();
  const dec = useDecimal();
  const scores = result.scores as {
    scaleCode: string;
    scaleTitle: string;
    rawScore: number;
    value: number;
    band: { label: string; severity: Severity; recommendation: string | null } | null;
  }[];
  return (
    <Page
      title={ut("adn.saved")}
      back={{ to: `/surveys/${survey.id}`, label: ut("back.toSurvey") }}
      meta={[survey.title, ut("rp.versionN").replace("{n}", String(survey.versionNumber))]}
      actions={
        <>
          <ButtonLink to={`/surveys/${survey.id}/responses/${result.id}`}>
            <Ic.clipboard />
            {ut("adx.openProtocol")}
          </ButtonLink>
          <ButtonLink to={`/responses/${result.id}/conclusion`} variant="primary">
            <Rx.filePen />
            {ut("rsp.createConclusion")}
          </ButtonLink>
        </>
      }
    >
      <div className="flex max-w-[1080px] flex-col gap-4">
        {!result.reliable ? (
          <Callout kind="warn" title={ut("ad.unreliable")}>
            {result.warnings.map((w, i) => (
              <p key={i} className="m-0 mt-1">
                {w}
              </p>
            ))}
          </Callout>
        ) : null}
        <Panel title={ut("rch.result")} icon={<Ic.gauge />} flush>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-panel-2 text-left text-[11.5px] font-bold text-muted">
                  <th className="border-t border-divider px-4 py-2">{ut("ad.scale")}</th>
                  <th className="border-t border-divider px-4 py-2 text-right">{ut("ad.raw")}</th>
                  <th className="border-t border-divider px-4 py-2 text-right">{ut("ad.value")}</th>
                  <th className="border-t border-divider px-4 py-2">{ut("ad.interpretation")}</th>
                  <th className="border-t border-divider px-4 py-2">{ut("ad.recommendation")}</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((s) => (
                  <tr key={s.scaleCode}>
                    <td className="border-t border-divider px-4 py-2.5 font-bold text-text">{s.scaleTitle}</td>
                    <td className="border-t border-divider px-4 py-2.5 text-right tabular-nums">{dec(s.rawScore)}</td>
                    <td className="border-t border-divider px-4 py-2.5 text-right font-extrabold tabular-nums">{dec(s.value)}</td>
                    <td className="border-t border-divider px-4 py-2.5">
                      {s.band ? (
                        <SeverityTag level={s.band.severity} small>
                          {s.band.label}
                        </SeverityTag>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="border-t border-divider px-4 py-2.5 text-text-2">{s.band?.recommendation ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <div>
          <Button variant="ghost" icon={<Rx.filePlus />} onClick={onAgain}>
            {ut("adx.again")}
          </Button>
        </div>
      </div>
    </Page>
  );
}
