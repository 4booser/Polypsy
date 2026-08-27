import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { answers, conclusions, responseScores, responses, scales, users } from "../db/schema";
import { audit } from "../lib/audit";
import { forbidden, notFound } from "../lib/http";
import { percentileOf } from "../lib/norms";
import { canAccessSurvey, isStaff } from "../lib/scope";
import { fullNameOf } from "../lib/auth";
import { decryptField } from "../lib/crypto";
import { ageAt } from "@quizzy/shared";
import { getSurveyForResponse } from "../lib/surveys";
import { requireAuth, type AppEnv } from "../middleware/auth";

export const reportRoutes = new Hono<AppEnv>();

reportRoutes.use("*", requireAuth);

/**
 * Печатное заключение по прохождению — самостоятельная HTML-страница.
 *
 * Отдаём разметку, а не готовый PDF: клиент печатает её системным механизмом,
 * и заключение одинаково открывается в мобилке, браузере и на печать,
 * без серверной зависимости на рендер PDF.
 */
reportRoutes.get("/responses/:id", async (c) => {
  const user = c.get("user");
  const response = await db.query.responses.findFirst({ where: eq(responses.id, c.req.param("id")) });
  if (!response) notFound("Прохождение не найдено");

  const own = response.userId === user.id;
  if (!own && !isStaff(user)) forbidden("Заключение доступно пациенту или сотруднику");
  if (!own && !(await canAccessSurvey(user, response.surveyId))) notFound("Прохождение не найдено");

  const survey = await getSurveyForResponse(response.id);
  if (!survey) notFound("Методика не найдена");

  // в отчёт идёт только ПОДПИСАННОЕ заключение: черновик — рабочий текст
  const [signedConclusion] = await db
    .select({ row: conclusions, author: users })
    .from(conclusions)
    .leftJoin(users, eq(users.id, conclusions.signedBy))
    .where(eq(conclusions.responseId, response.id))
    .orderBy(desc(conclusions.version))
    .limit(1);

  const [scoreRows, answerRows] = await Promise.all([
    db.select().from(responseScores).where(eq(responseScores.responseId, response.id)),
    db.select().from(answers).where(eq(answers.responseId, response.id)),
  ]);

  const patient = response.userId
    ? await db.query.users.findFirst({ where: eq(users.id, response.userId) })
    : null;

  // нормативная выборка по тем же субшкалам этой методики
  const sample = new Map<string, number[]>();
  if (scoreRows.length) {
    const rows = await db
      .select({ score: responseScores, code: scales.code })
      .from(responseScores)
      .innerJoin(responses, eq(responses.id, responseScores.responseId))
      .innerJoin(scales, eq(scales.id, responseScores.scaleId))
      .where(eq(responses.surveyId, response.surveyId));
    for (const r of rows) {
      const list = sample.get(r.code) ?? [];
      list.push(r.score.rawScore);
      sample.set(r.code, list);
    }
  }

  const scaleById = new Map(survey.scales.map((s) => [s.id, s]));
  const answerByQuestion = new Map(answerRows.map((a) => [a.questionId, a]));
  const optionText = new Map(survey.questions.flatMap((q) => q.options.map((o) => [o.id, o.text])));

  await audit(c, {
    action: "report.render",
    resourceType: "response",
    resourceId: response.id,
    subjectUserId: response.userId,
    details: { surveyId: survey.id, version: survey.versionNumber },
  });

  return c.html(
    renderReport({
      surveyTitle: survey.title,
      versionNumber: survey.versionNumber,
      patientName: patient ? fullNameOf(patient) : "Анонимный респондент",
    patientMeta: patient
      ? [
          patient.sex ? (patient.sex === "male" ? "муж." : "жен.") : null,
          ageAt(decryptField(patient.birthDate), response.submittedAt) !== null
            ? `${ageAt(decryptField(patient.birthDate), response.submittedAt)} лет на момент обследования`
            : null,
          patient.rank,
          patient.unit,
        ]
          .filter(Boolean)
          .join(" · ")
      : null,
      startedAt: response.startedAt,
      submittedAt: response.submittedAt,
      durationMs: response.durationMs,
      scores: scoreRows.map((s) => {
        const scale = scaleById.get(s.scaleId);
        return {
          title: scale?.title ?? "—",
          rawScore: s.rawScore,
          maxScore: s.maxScore,
          percent: s.percent,
          band: s.bandLabel,
          severity: s.severity,
          percentile: scale ? percentileOf(s.rawScore, sample.get(scale.code) ?? []) : null,
        };
      }),
      answers: survey.questions
        .filter((q) => q.type !== "info")
        .map((q) => {
          const a = answerByQuestion.get(q.id);
          return {
            title: q.title,
            value: formatValue(a, optionText),
            durationMs: a?.durationMs ?? 0,
          };
        }),
      conclusion:
        signedConclusion && signedConclusion.row.status === "signed"
          ? {
              text: decryptField(signedConclusion.row.text) ?? "",
              version: signedConclusion.row.version,
              signedAt: signedConclusion.row.signedAt,
              signedBy: signedConclusion.author ? fullNameOf(signedConclusion.author) : "—",
            }
          : null,
      printedBy: fullNameOf(user),
      printedAt: new Date().toISOString(),
    }),
  );
});

function formatValue(
  a: { optionIds?: string[] | null; text?: string | null; number?: number | null; date?: string | null; matrix?: Record<string, string> | null; ranking?: string[] | null; skipped?: boolean } | undefined,
  optionText: Map<string, string>,
): string {
  if (!a || a.skipped) return "— не отвечено";
  if (a.optionIds?.length) return a.optionIds.map((id) => optionText.get(id) ?? id).join(", ");
  if (a.matrix)
    return Object.entries(a.matrix)
      .map(([row, opt]) => `${optionText.get(row) ?? row}: ${optionText.get(opt) ?? opt}`)
      .join("; ");
  if (a.ranking?.length) return a.ranking.map((id) => optionText.get(id) ?? id).join(" → ");
  if (a.number !== null && a.number !== undefined) return String(a.number);
  if (a.date) return a.date;
  return decryptField(a.text) ?? "—";
}

const SEVERITY_COLOR: Record<string, string> = {
  none: "#0ca30c",
  mild: "#fab219",
  moderate: "#ec835a",
  severe: "#d03b3b",
};

interface ReportData {
  conclusion: { text: string; version: number; signedAt: string | null; signedBy: string } | null;
  printedBy: string;
  printedAt: string;
  surveyTitle: string;
  versionNumber: number;
  patientName: string;
  patientMeta: string | null;
  startedAt: string;
  submittedAt: string | null;
  durationMs: number;
  scores: {
    title: string;
    rawScore: number;
    maxScore: number;
    percent: number;
    band: string | null;
    severity: string | null;
    percentile: number | null;
  }[];
  answers: { title: string; value: string; durationMs: number }[];
}

function esc(v: string): string {
  return v.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

function renderReport(d: ReportData): string {
  const duration = d.durationMs >= 60000
    ? `${Math.floor(d.durationMs / 60000)} мин ${Math.round((d.durationMs % 60000) / 1000)} с`
    : `${(d.durationMs / 1000).toFixed(1)} с`;

  const scoreRows = d.scores
    .map(
      (s) => `
      <tr>
        <td>${esc(s.title)}</td>
        <td class="num">${s.rawScore} из ${s.maxScore}</td>
        <td class="num">${s.percent}%</td>
        <td>${
          s.band
            ? `<span class="dot" style="background:${SEVERITY_COLOR[s.severity ?? "none"] ?? "#888"}"></span>${esc(s.band)}`
            : "—"
        }</td>
        <td class="num">${s.percentile === null ? "—" : `${s.percentile}-й`}</td>
      </tr>`,
    )
    .join("");

  const answerRows = d.answers
    .map(
      (a, i) => `
      <tr>
        <td class="num">${i + 1}</td>
        <td>${esc(a.title)}</td>
        <td>${esc(a.value)}</td>
        <td class="num">${(a.durationMs / 1000).toFixed(1)} с</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Заключение — ${esc(d.surveyTitle)}</title>
<style>
  @page { margin: 18mm; }
  body { font: 13px/1.5 system-ui, -apple-system, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 26px 0 8px; }
  .meta { color: #555; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #e3e3e3; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #666; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; }
  .conclusion { white-space: normal; padding: 10px 12px; border: 1px solid #d8d8d4; border-radius: 6px; }
  .note { margin-top: 22px; padding: 10px 12px; background: #f5f5f3; border-radius: 6px; font-size: 12px; color: #444; }
</style></head>
<body>
  <h1>${esc(d.surveyTitle)}</h1>
  <div class="meta">
    ${esc(d.patientName)}${d.patientMeta ? ` · ${esc(d.patientMeta)}` : ""} · версия методики ${d.versionNumber} ·
    ${d.submittedAt ? esc(d.submittedAt.slice(0, 16).replace("T", " ")) : "не завершено"} ·
    время прохождения ${duration}
  </div>

  ${
    d.scores.length
      ? `<h2>Результаты по субшкалам</h2>
  <table>
    <tr><th>Субшкала</th><th class="num">Балл</th><th class="num">% от максимума</th><th>Интерпретация</th><th class="num">Перцентиль</th></tr>
    ${scoreRows}
  </table>`
      : ""
  }

  <h2>Ответы</h2>
  <table>
    <tr><th class="num">№</th><th>Вопрос</th><th>Ответ</th><th class="num">Время</th></tr>
    ${answerRows}
  </table>

  ${
    d.conclusion
      ? `<h2>Заключение специалиста</h2>
  <div class="conclusion">${esc(d.conclusion.text).replaceAll("\n", "<br>")}</div>
  <div class="meta" style="margin-top:6px">
    Подписано: ${esc(d.conclusion.signedBy)}${
      d.conclusion.signedAt ? `, ${esc(String(d.conclusion.signedAt).slice(0, 16).replace("T", " "))}` : ""
    } · версия ${d.conclusion.version}
  </div>`
      : ""
  }

  <div class="note">
    Результат скринингового обследования не является диагнозом. Интерпретацию
    выполняет специалист с учётом клинической картины и анамнеза.
    Перцентиль рассчитан относительно выборки, накопленной в этой системе,
    и не заменяет популяционные нормы методики.
  </div>

  <div class="meta" style="margin-top:18px; border-top: 1px solid #e3e3e3; padding-top: 8px;">
    Распечатано: ${esc(d.printedBy)}, ${esc(d.printedAt.slice(0, 16).replace("T", " "))}
  </div>
</body></html>`;
}
