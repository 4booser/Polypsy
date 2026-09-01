import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  answers,
  appointments,
  conclusions,
  departments,
  responseScores,
  responses,
  scales,
  slots,
  specialistProfiles,
  users,
} from "../db/schema";
import { env } from "../env";
import { audit } from "../lib/audit";
import { badRequest, forbidden, langOf, notFound } from "../lib/http";
import { percentileOf } from "../lib/norms";
import { departmentReport, resolveDepartment } from "../lib/departmentReport";
import { assertPatientAccess, canAccessSurvey, isStaff } from "../lib/scope";
import { fullNameOf } from "../lib/auth";
import { decryptField } from "../lib/crypto";
import { ageAt } from "@quizzy/shared";
import { t } from "@quizzy/shared";
import { getSurveyForResponse } from "../lib/surveys";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

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
  if (!response) notFound("err.responseNotFound");

  const own = response.userId === user.id;
  if (!own && !isStaff(user)) forbidden("err.conclusionAccessDenied");
  if (!own && !(await canAccessSurvey(user, response.surveyId))) notFound("err.responseNotFound");

  const survey = await getSurveyForResponse(response.id);
  if (!survey) notFound("err.surveyNotFound");

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

  .letterhead { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 16px; }
  .letterhead .org { font-size: 14px; font-weight: 700; letter-spacing: .01em; }
  .letterhead .unit { font-size: 12px; color: #555; margin-top: 2px; }

  /* подпись не должна отрываться от документа переносом страницы */
  .sign { margin-top: 26px; break-inside: avoid; display: flex; gap: 32px; flex-wrap: wrap; }
  .sign-line { display: flex; align-items: flex-end; gap: 8px; font-size: 12px; color: #444; }
  .sign-line i { display: inline-block; width: 190px; border-bottom: 1px solid #111; }
  .sign-hint { font-size: 10px; color: #888; }

  .footer { margin-top: 18px; border-top: 1px solid #e3e3e3; padding-top: 8px; }
  /* таблицы не рвутся посреди строки при печати */
  tr { break-inside: avoid; }
  h2 { break-after: avoid; }
</style></head>
<body>
  ${
    /*
     * Шапка учреждения. Лист без неё — просто распечатка, а не документ,
     * который можно подшить в дело.
     */
    env.institutionName
      ? `<div class="letterhead">
    <div class="org">${esc(env.institutionName)}</div>
    ${env.institutionUnit ? `<div class="unit">${esc(env.institutionUnit)}</div>` : ""}
  </div>`
      : ""
  }
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

  ${
    /*
     * Место для подписи. Заключение может быть подписано в системе, но
     * бумажный экземпляр, который ложится в дело, всё равно подписывают
     * рукой — и место для этого должно быть предусмотрено, а не
     * дописываться поверх текста.
     */
    d.conclusion
      ? ""
      : `<div class="sign">
    <div class="sign-line">
      <span>Специалист</span>
      <i></i>
      <span class="sign-hint">подпись</span>
    </div>
    <div class="sign-line">
      <span>Дата</span>
      <i></i>
    </div>
  </div>`
  }

  <div class="meta footer">
    Распечатано: ${esc(d.printedBy)}, ${esc(d.printedAt.slice(0, 16).replace("T", " "))}
  </div>
</body></html>`;
}

/**
 * Справка о посещении.
 *
 * Административный факт, а не клиническое суждение: человек был на приёме
 * такого-то числа. Ни диагноза, ни содержания разговора здесь нет и быть не
 * может — справку человек несёт на работу или в часть, и всё, что в ней
 * написано, увидит тот, кому он её отдаст.
 */
reportRoutes.get("/visits/:id", async (c) => {
  const user = c.get("user");
  const appointment = await db.query.appointments.findFirst({
    where: eq(appointments.id, c.req.param("id")),
  });
  if (!appointment) notFound("err.appointmentNotFound");

  const own = appointment.patientId === user.id;
  if (!own) {
    if (!isStaff(user)) forbidden("err.conclusionAccessDenied");
    const { hasPermission } = await import("../lib/permissions");
    if (!(await hasPermission(user, "appointments.manage"))) {
      forbidden("err.permissionRequired", { permission: "appointments.manage" });
    }
    await assertPatientAccess(user, appointment.patientId);
  }

  /*
   * Справка выдаётся только о состоявшемся приёме.
   *
   * «Записан» — это намерение, а не посещение. Справка о нём была бы
   * документом о том, чего не было, и подписать её нельзя ни при каких
   * обстоятельствах.
   */
  if (!["arrived", "in_progress", "done"].includes(appointment.status)) {
    badRequest("err.visitNotHappened", { status: appointment.status });
  }

  const patient = (await db.query.users.findFirst({
    where: eq(users.id, appointment.patientId),
  }))!;

  /*
   * Без имени документа не бывает.
   *
   * Аккаунт под кодом анонимен для специалиста, но в справке по закону нужно
   * имя: «Респондент А-4821 был на приёме» — не документ. Отказ объясняет,
   * что делать, а не просто запрещает.
   */
  if (patient.anonymous) badRequest("err.certificateNeedsName");

  const specialist = (await db.query.users.findFirst({
    where: eq(users.id, appointment.specialistId),
  }))!;
  const [slot] = await db.select().from(slots).where(eq(slots.id, appointment.slotId));
  const profile = await db.query.specialistProfiles.findFirst({
    where: eq(specialistProfiles.userId, appointment.specialistId),
  });
  /* отделение нужно здесь только ради часового пояса: его названия в справке нет */
  const department = profile
    ? await db.query.departments.findFirst({ where: eq(departments.id, profile.departmentId) })
    : null;
  const tz = department?.timezone ?? "Europe/Kyiv";

  await audit(c, {
    action: "report.visit_certificate",
    resourceType: "appointment",
    resourceId: appointment.id,
    subjectUserId: appointment.patientId,
  });

  return c.html(
    visitCertificateHtml({
      fullName: fullNameOf(patient),
      unit: patient.unit,
      startsAt: slot!.startsAt,
      endsAt: slot!.endsAt,
      timezone: tz,
      specialistName: fullNameOf(specialist),
    }),
  );
});

/**
 * Разметка справки.
 *
 * Ни причины обращения, ни содержания разговора, ни НАЗВАНИЯ ОТДЕЛЕНИЯ здесь
 * нет. Первые два очевидны; третье — нет, и первая редакция его печатала:
 * строка «психологическое отделение» сообщает тому, кому справку отдадут, к
 * кому человек ходил, — а отдают её на работу или в часть. Название
 * учреждения в шапке остаётся: это обычный уровень раскрытия, и без него
 * документ перестаёт быть документом.
 *
 * Пояснение живёт здесь, а не HTML-комментарием внутри страницы. Комментарий
 * в разметке уезжает вместе с ней: объяснение того, чего в документе нет,
 * лежало бы в самом документе и читалось бы в исходном коде страницы. Это
 * тоже поймала проверка.
 */
function visitCertificateHtml(d: {
  fullName: string;
  unit: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  specialistName: string;
}): string {
  const date = new Date(d.startsAt).toLocaleDateString("uk-UA", { timeZone: d.timezone });
  const from = new Date(d.startsAt).toLocaleTimeString("uk-UA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: d.timezone,
  });
  const to = new Date(d.endsAt).toLocaleTimeString("uk-UA", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: d.timezone,
  });

  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<title>Довідка про відвідування</title>
<style>
  @page { margin: 20mm; }
  body { font: 14px/1.6 system-ui, -apple-system, sans-serif; color: #111; margin: 0; }
  .letterhead { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 24px; }
  .letterhead .org { font-size: 14px; font-weight: 700; }
  .letterhead .unit { font-size: 12px; color: #555; margin-top: 2px; }
  h1 { font-size: 18px; margin: 0 0 20px; text-align: center; }
  p { margin: 0 0 12px; }
  .sign { margin-top: 44px; display: flex; gap: 32px; flex-wrap: wrap; break-inside: avoid; }
  .sign-line { display: flex; align-items: flex-end; gap: 8px; font-size: 12px; color: #444; }
  .sign-line i { display: inline-block; width: 200px; border-bottom: 1px solid #111; }
  .issued { margin-top: 28px; font-size: 12px; color: #666; }
</style></head>
<body>
  ${
    env.institutionName
      ? `<div class="letterhead">
      <div class="org">${esc(env.institutionName)}</div>
      ${env.institutionUnit ? `<div class="unit">${esc(env.institutionUnit)}</div>` : ""}
    </div>`
      : ""
  }
  <h1>Довідка про відвідування</h1>
  <p>Видана ${esc(d.fullName)}${d.unit ? `, ${esc(d.unit)}` : ""} у тому, що ${esc(date)}
     з ${esc(from)} до ${esc(to)} він(вона) перебував(ла) на прийомі.</p>
  <p>Довідка видана для пред’явлення за місцем вимоги.</p>

  <div class="sign">
    <div class="sign-line">Фахівець <i></i></div>
    <div class="sign-line">${esc(d.specialistName)}</div>
  </div>
  <p class="issued">Дата видачі: ${esc(new Date().toLocaleDateString("uk-UA", { timeZone: d.timezone }))}</p>
</body></html>`;
}

/**
 * Печатный отчёт отделения.
 *
 * Тот же расчёт, что и на экране, но листом, который подшивают. Считает
 * маршрут отчёта, а не эта страница: два расчёта одного числа — это два
 * числа, которые однажды разойдутся, и разойдутся молча.
 */
reportRoutes.get("/department", requireStaff, requirePermission("unitReport.read"), async (c) => {
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    badRequest("err.reportPeriodRequired");
  }

  /*
   * Считает та же функция, что и экранный отчёт. Сходить к себе же по HTTP
   * было бы и лишним кругом, и кольцевым импортом; посчитать здесь заново —
   * завести второе число, которое однажды разойдётся с первым, а подпишут
   * бумажное.
   */
  const department = await resolveDepartment(c.get("user").id, c.req.query("departmentId"));
  if (!department) notFound("err.departmentNotFound");
  const data = await departmentReport(department.id, from, to, department.timezone);

  const row = await db.query.departments.findFirst({ where: eq(departments.id, department.id) });

  return c.html(
    departmentReportHtml({
      title: row ? t(row.title as never, langOf(c)) : "",
      from,
      to,
      rows: [
        ["Прийнято прийомів", data.received],
        ["Людей", data.people],
        ["Первинних", data.primary],
        ["Повторних", data.repeat],
        ["Неявок", data.noShow],
        ["Скасувань", data.cancelled],
        ["На обліку", data.attached],
      ],
      floor: data.floor,
    }),
  );
});

function departmentReportHtml(d: {
  title: string;
  from: string;
  to: string;
  rows: [string, number | null][];
  floor: number;
}): string {
  const rows = d.rows
    .map(
      ([label, value]) => `
      <tr>
        <td>${esc(label)}</td>
        <td class="num">${
          /*
           * Подавленное печатается словом, а не прочерком и не нулём.
           * Прочерк на бумаге читается как «не считали», ноль — как
           * «никого», а правда в том, что людей мало и назвать их число
           * нельзя.
           */
          value === null ? "мало" : value
        }</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<title>Звіт відділення</title>
<style>
  @page { margin: 18mm; }
  body { font: 13px/1.5 system-ui, -apple-system, sans-serif; color: #111; margin: 0; }
  .letterhead { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 16px; }
  .letterhead .org { font-size: 14px; font-weight: 700; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #555; font-size: 12px; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; max-width: 460px; }
  td { padding: 7px 8px; border-bottom: 1px solid #e3e3e3; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .note { margin-top: 18px; font-size: 11px; color: #666; max-width: 70ch; }
  .sign { margin-top: 36px; display: flex; gap: 32px; break-inside: avoid; }
  .sign-line { display: flex; align-items: flex-end; gap: 8px; font-size: 12px; color: #444; }
  .sign-line i { display: inline-block; width: 200px; border-bottom: 1px solid #111; }
</style></head>
<body>
  ${
    env.institutionName
      ? `<div class="letterhead"><div class="org">${esc(env.institutionName)}</div></div>`
      : ""
  }
  <h1>Звіт відділення${d.title ? `: ${esc(d.title)}` : ""}</h1>
  <p class="meta">Період: ${esc(d.from)} — ${esc(d.to)}</p>
  <table>${rows}</table>
  <p class="note">Числа, менші за ${d.floor}, не наводяться: за малим числом
     разом зі складом підрозділу людина впізнається. «Людей» і «прийомів» не
     додають — одна людина за період приходить кілька разів.</p>
  <div class="sign">
    <div class="sign-line">Завідувач відділення <i></i></div>
  </div>
</body></html>`;
}
