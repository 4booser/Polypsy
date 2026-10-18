import { Link, useParams } from "react-router-dom";
import type { SurveyFull } from "@quizzy/shared";
import { api, download, type KeySheet } from "../api";
import { useResource } from "../useResource";
import { Loading, useAction } from "../ui";
import { Button } from "../ui/primitives";
import { Page, Panel, Stack } from "../ui/layout";
import { useLang } from "../lang";
import {
  Facts,
  fill,
  SevPill,
  Sheet,
  SheetFoot,
  SheetHead,
  SheetSection,
  Signs,
  sheetDate,
  stepsOfBands,
  usePrintedBy,
} from "./printSheet";

/**
 * Печать ключей для сверки с пособием.
 *
 * Структурная проверка ловит форму ключа, но не содержание: если при переносе
 * перепутаны 47 и 74, она промолчит. Единственный способ поймать такое — сесть
 * с распечаткой и оригиналом, поэтому ключи выводятся в том же виде, в каком
 * они напечатаны в пособии.
 *
 * Экран — панель действий и сам лист (UI 3, print-key): на печать идёт только
 * лист (styles/legacy.css, `data-print-sheet`), его и видно заранее.
 */
export default function KeyPrint() {
  const { ut } = useLang();
  const { id } = useParams<{ id: string }>();
  const { run, busy } = useAction();
  const { data: sheet, error } = useResource(() => api.keySheet(id!), [id], { enabled: !!id });
  /* методика целиком — ради баллов вариантов, критических вариантов и ступеней полос */
  const { data: survey } = useResource(() => api.survey(id!), [id], { enabled: !!id });

  if (error)
    return (
      <p role="alert" className="text-danger">
        {error}
      </p>
    );
  if (!sheet) return <Loading rows={4} />;

  return (
    <Page
      title={ut("kp.title")}
      sub={
        <>
          <Link to={`/surveys/${sheet.surveyId}`}>{sheet.title}</Link> · {ut("ds.version")} {sheet.version} ·{" "}
          {sheet.questionCount} {ut("bt.items")}
        </>
      }
      // см. пояснение в BlankForm.tsx: подстраховка от печати только видимой прокрутки
      className="print:overflow-visible"
    >
      <Stack>
        <Panel className="no-print">
          <p className="m-0 text-small text-muted">{ut("key.checkInstructions")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => window.print()}>
              {ut("kp.print")}
            </Button>
            <Button disabled={busy} onClick={() => run(() => download(api.methodologyUrl(sheet.surveyId), "methodology.json"))}>
              {ut("key.exportJson")}
            </Button>
            <Link className="btn" to={`/surveys/${sheet.surveyId}/blank`}>
              {ut("kp.blank")}
            </Link>
          </div>
        </Panel>
        <KeyPaper sheet={sheet} survey={survey ?? null} />
      </Stack>
    </Page>
  );
}

type Q = SurveyFull["questions"][number];

/** Варианты ответа пункта — без строк матрицы */
const optionsOf = (q: Q) => q.options.filter((o) => o.kind !== "row");

/** Один набор вариантов на все пункты — тогда баллы встают колонками */
function sharedOptions(questions: Q[]): string[] | null {
  if (!questions.length || questions.some((q) => !optionsOf(q).length)) return null;
  const first = optionsOf(questions[0]!).map((o) => o.text);
  return questions.every((q) => {
    const opts = optionsOf(q);
    return opts.length === first.length && opts.every((o, i) => o.text === first[i]);
  })
    ? first
    : null;
}

function KeyPaper({ sheet, survey }: { sheet: KeySheet; survey: SurveyFull | null }) {
  const { ut } = useLang();
  const printedBy = usePrintedBy();
  const asked = (survey?.questions ?? []).filter((q) => q.type !== "info");
  const shared = sharedOptions(asked);
  /* колонки баллов нужны, только если ключ хоть где-то берёт балл варианта, а не совпадение с кодом */
  const byScore = sheet.scales.some((s) => s.scored);
  const critical = asked.filter((q) => optionsOf(q).some((o) => o.riskFlag));
  const versionLabel = `${ut("ds.version")} ${sheet.version}`;
  const normalization = (code: string) =>
    ({ raw: ut("kp.rawScore"), ratio: ut("kp.ratio"), tscore: ut("co.tScores"), sten: ut("kp.stens") })[code] ?? code;

  return (
    <Sheet running={`${fill(ut("kp.sheetTitle"), { title: sheet.title })} · ${versionLabel}`}>
      <SheetHead primary={versionLabel} secondary={sheetDate()} />
      <h1 className="ps-t">{fill(ut("kp.sheetTitle"), { title: sheet.title })}</h1>
      {survey?.description ? <p className="ps-sub">{survey.description}</p> : null}
      <Facts
        cols={4}
        items={[
          [ut("kp.items"), sheet.questionCount],
          [ut("kp.factScales"), sheet.scales.length],
          [ut("kp.factOptions"), shared ? shared.length : null],
          [ut("kp.factCritical"), critical.length ? critical.map((q) => q.position + 1).join(", ") : null],
        ]}
      />

      {sheet.scales.map((s) => {
        const bands = [...(survey?.scales.find((x) => x.code === s.code)?.bands ?? [])].sort((a, b) => a.minScore - b.minScore);
        const steps = stepsOfBands(bands);
        const rows: [string, string][] = [
          ...s.keys.filter((k) => k.items).map((k): [string, string] => [fill(ut("kp.answerCode"), { label: k.label }), k.items]),
          ...(s.scored ? [[ut("kp.byOptionScores"), s.scored] as [string, string]] : []),
          ...(s.corrections ? [[ut("kp.corrections"), s.corrections] as [string, string]] : []),
          ...(s.norms ? [[ut("kp.norms"), s.norms] as [string, string]] : []),
          ...(s.stens ? [[ut("cs.sten"), s.stens] as [string, string]] : []),
        ];
        return (
          <div className="ps-key" key={s.code}>
            <div>
              <div className="hd">
                <b>
                  {s.code} — {s.title}
                </b>
                <span className="r">
                  {s.kind === "validity" ? ut("kp.validityScale") : ut("kp.clinicalScale")} · {normalization(s.normalization)} ·{" "}
                  {ut("key.itemsInKey")} {s.itemCount}
                </span>
              </div>
              <dl className="ps-kv2">
                {rows.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div>
              <div className="hd">{ut("kp.interpretation")}</div>
              {bands.length ? (
                <table className="ps-tbl mid">
                  <tbody>
                    {bands.map((b, i) => (
                      <tr key={b.id}>
                        <td className="nw">
                          <b>
                            {b.minScore}–{b.maxScore}
                          </b>
                        </td>
                        <td>
                          <SevPill step={steps[i] ?? null}>{b.label}</SevPill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="ps-empty">{s.bands || "—"}</p>
              )}
            </div>
          </div>
        );
      })}

      {asked.length ? (
        <SheetSection title={byScore ? ut("kp.scoresTitle") : ut("kp.items")} right={ut("kp.itemsHint")}>
          <table className="ps-tbl mid">
            <thead>
              <tr>
                <th className="no">№</th>
                <th>{ut("kp.item")}</th>
                {byScore && shared
                  ? shared.map((o) => (
                      <th key={o} className="c ps-opt">
                        {o}
                      </th>
                    ))
                  : null}
                {byScore && !shared ? <th>{ut("kp.optionScores")}</th> : null}
              </tr>
            </thead>
            <tbody>
              {asked.map((q) => {
                const opts = optionsOf(q);
                const risky = opts.filter((o) => o.riskFlag);
                return (
                  <tr key={q.id} className={risky.length ? "crit" : undefined}>
                    <td className="no">{q.position + 1}</td>
                    <td>
                      {q.title}
                      {risky.length ? (
                        <span className="ck">
                          <svg className="ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
                            <path d="M12 9v4" />
                            <path d="M12 17h.01" />
                          </svg>
                          {ut("kp.criticalOptions")}: {risky.map((o) => o.text).join(", ")}
                        </span>
                      ) : null}
                    </td>
                    {byScore && shared
                      ? opts.map((o) => (
                          <td key={o.id} className="c">
                            <b>{o.score}</b>
                          </td>
                        ))
                      : null}
                    {byScore && !shared ? (
                      <td className="t2">{opts.map((o) => `${o.text} — ${o.score}`).join("; ")}</td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </SheetSection>
      ) : null}

      {critical.length ? (
        <div className="ps-box rk mt-3">
          <h4>{ut("kp.riskRuleTitle")}</h4>
          <p>{ut("kp.riskRule")}</p>
        </div>
      ) : null}

      <p className="ps-plain">
        <span>
          <b>{ut("kp.checkLead")}</b> {ut("key.checkInstructions")}
        </span>
      </p>

      <div className="ps-end">
        <Signs
          items={[
            { name: "", caption: ut("kp.reconciledBy") },
            { name: "", caption: ut("kp.reconcileDate") },
            { name: ut("kp.discrepancyChoice"), caption: ut("kp.discrepancies") },
          ]}
        />
        <SheetFoot lines={[printedBy, ut("kp.serviceDoc")]} right={`${sheet.title}, ${versionLabel}`} />
      </div>
    </Sheet>
  );
}
