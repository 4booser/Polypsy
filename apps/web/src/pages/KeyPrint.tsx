import { useState } from "react";
import { useParams } from "react-router-dom";
import type { SurveyFull } from "@quizzy/shared";
import { api, download, type KeySheet } from "../api";
import { useAuth } from "../auth";
import { useResource } from "../useResource";
import { Loading, Modal, useAction } from "../ui";
import { Button, ButtonLink } from "../ui/primitives";
import { Page } from "../ui/layout";
import { Callout } from "../ui/states";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Mi } from "./methods/icons";
import { shortDate, splitCode } from "./methods/model";
import { useCount } from "./methods/useCount";
import { bandRange } from "../charts/ladder";
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
 * Экран (UI 3, «Виразна»): шапка с методикой, «Вивантажити JSON», «Порожній
 * бланк» и «Друк»; под ней — как сверять, и сам лист (print-key). На печать
 * идёт только лист (styles/legacy.css, `data-print-sheet`), шапка и заметка —
 * нет. Суперадмин после сверки ставит отметку «Ключі звірено» — её видно в
 * каталоге и в паспорте методики.
 */
export default function KeyPrint() {
  const { ut } = useLang();
  const count = useCount();
  const { user } = useAuth();
  const { id } = useParams<{ id: string }>();
  const { run, busy } = useAction();
  const [confirming, setConfirming] = useState(false);
  const { data: sheet, error } = useResource(() => api.keySheet(id!), [id], { enabled: !!id });
  /* методика целиком — ради баллов вариантов, критических вариантов и ступеней полос */
  const surveyRes = useResource(() => api.survey(id!), [id], { enabled: !!id });
  const survey = surveyRes.data;
  const verifiedAt = (survey as (SurveyFull & { keysVerifiedAt?: string | null }) | null)?.keysVerifiedAt ?? null;

  if (error)
    return (
      <p role="alert" className="m-5 text-risk-ink">
        {error}
      </p>
    );
  if (!sheet) return <Loading rows={4} />;

  const { code, name } = splitCode(sheet.title);
  const canVerify = user?.role === "superadmin";

  return (
    <Page
      back={{ to: `/surveys/${sheet.surveyId}`, label: ut("mc.backMethod") }}
      title={ut("kp.title")}
      meta={[code ? `${code}, ${name}` : name, `${ut("ant.versionN").replace("{n}", String(sheet.version))}, ${count(sheet.questionCount, "items")}`]}
      actions={
        <>
          <Button
            variant="secondary"
            icon={<Mi.fileJson />}
            disabled={busy}
            onClick={() => run(() => download(api.methodologyUrl(sheet.surveyId), "methodology.json"))}
          >
            {ut("key.exportJson")}
          </Button>
          <ButtonLink to={`/surveys/${sheet.surveyId}/blank`} variant="secondary">
            <Mi.printer size={15} />
            {ut("kp.blank")}
          </ButtonLink>
          <Button variant="primary" icon={<Mi.printer />} onClick={() => window.print()}>
            {ut("kp.print")}
          </Button>
        </>
      }
      // см. пояснение в BlankForm.tsx: подстраховка от печати только видимой прокрутки
      className="print:overflow-visible"
    >
      <div className="flex flex-col gap-4">
        <Callout
          kind={verifiedAt ? "good" : "warn"}
          icon={<ShellIcon name={verifiedAt ? "badge-check" : "key-round"} size={16} />}
          title={verifiedAt ? `${ut("cat.keysVerified")} ${shortDate(verifiedAt)}` : ut("mc.attKeysTitle")}
          actions={
            canVerify && survey ? (
              <Button size="xs" variant="secondary" icon={<ShellIcon name="badge-check" size={14} />} onClick={() => setConfirming(true)}>
                {verifiedAt ? ut("mc.kpVerifyAgain") : ut("mc.kpVerify")}
              </Button>
            ) : null
          }
        >
          {ut("key.checkInstructions")}
        </Callout>
        <KeyPaper sheet={sheet} survey={survey ?? null} />
      </div>
      {confirming ? (
        <Modal
          title={ut("mc.kpVerifyTitle").replace("{v}", String(sheet.version))}
          sub={code ? `${code}, ${name}` : name}
          icon={<ShellIcon name="badge-check" />}
          tone="good"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.surveyRights(sheet.surveyId, { keysVerified: true });
                    setConfirming(false);
                    surveyRes.reload();
                  }, ut("mc.kpVerified"))
                }
              >
                {ut("mc.kpVerifyConfirm")}
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)}>
                {ut("ui.cancel")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">{ut("mc.kpVerifyText")}</p>
        </Modal>
      ) : null}
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
                  <div key={`${k}:${v}`}>
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
                          <b>{bandRange({ min: b.minScore, max: b.maxScore })}</b>
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
