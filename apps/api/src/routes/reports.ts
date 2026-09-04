import { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  answers,
  appointments,
  conclusions,
  departments,
  episodes,
  patientNotes,
  referrals,
  responseScores,
  responses,
  scales,
  slots,
  specialistProfiles,
  surveys,
  users,
} from "../db/schema";
import { env } from "../env";
import { audit } from "../lib/audit";
import { badRequest, forbidden, langOf, notFound } from "../lib/http";
import { percentileOf } from "../lib/norms";
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
 * Выписка по обращению — печатным листом.
 *
 * То, ради чего эпизод и заводился: одно обращение целиком, от повода до
 * исхода, на одном листе. Раньше это собирали из четырёх экранов и держали
 * порядок событий в голове.
 *
 * В выписку идёт только подписанное: черновик заключения — рабочий текст, и
 * подшитый черновик потом не отличить от решения.
 */
reportRoutes.get("/episodes/:id", requireStaff, requirePermission("patients.read"), async (c) => {
  const episode = await db.query.episodes.findFirst({ where: eq(episodes.id, c.req.param("id")) });
  if (!episode) notFound("err.episodeNotFound");
  await assertPatientAccess(c.get("user"), episode.patientId);

  const patient = (await db.query.users.findFirst({ where: eq(users.id, episode.patientId) }))!;
  /*
   * Без имени документа не бывает — то же правило, что у справки. «Респондент
   * А-4821 обращался с 12.03 по 20.05» не подшивается в дело.
   */
  if (patient.anonymous) badRequest("err.certificateNeedsName");

  const lead = episode.leadSpecialistId
    ? await db.query.users.findFirst({ where: eq(users.id, episode.leadSpecialistId) })
    : null;

  const visits = await db
    .select({ a: appointments, slot: slots, specialist: users })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .innerJoin(users, eq(users.id, appointments.specialistId))
    .where(eq(appointments.episodeId, episode.id))
    .orderBy(asc(slots.startsAt));

  const signed = await db
    .select({ row: conclusions, author: users })
    .from(conclusions)
    .leftJoin(users, eq(users.id, conclusions.signedBy))
    .where(and(eq(conclusions.episodeId, episode.id), eq(conclusions.status, "signed")))
    .orderBy(asc(conclusions.signedAt));

  const sent = await db
    .select()
    .from(referrals)
    .where(eq(referrals.episodeId, episode.id))
    .orderBy(asc(referrals.createdAt));

  await audit(c, {
    action: "report.episode_extract",
    resourceType: "episode",
    resourceId: episode.id,
    subjectUserId: episode.patientId,
  });

  return c.html(
    episodeExtractHtml({
      fullName: fullNameOf(patient),
      unit: patient.unit,
      openedAt: episode.openedAt,
      closedAt: episode.closedAt,
      reason: decryptField(episode.reasonEnc),
      outcome: decryptField(episode.outcomeEnc),
      leadName: lead ? fullNameOf(lead) : null,
      visits: visits.map((v) => ({
        at: v.slot.startsAt,
        specialist: fullNameOf(v.specialist),
        status: v.a.status,
      })),
      conclusions: signed.map((s) => ({
        at: s.row.signedAt ?? s.row.createdAt,
        author: s.author ? fullNameOf(s.author) : "—",
        text: decryptField(s.row.text) ?? "",
      })),
      referrals: sent.map((r) => ({
        at: r.createdAt,
        destination: r.destination,
        status: r.status,
      })),
    }),
  );
});

function episodeExtractHtml(d: {
  fullName: string;
  unit: string | null;
  openedAt: string;
  closedAt: string | null;
  reason: string | null;
  outcome: string | null;
  leadName: string | null;
  visits: { at: string; specialist: string; status: string }[];
  conclusions: { at: string; author: string; text: string }[];
  referrals: { at: string; destination: string; status: string }[];
}): string {
  const day = (iso: string) => new Date(iso).toLocaleDateString("uk-UA");
  const rows = (items: string[]) => items.join("");

  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<title>Витяг за зверненням</title>
<style>
  @page { margin: 18mm; }
  body { font: 13px/1.55 system-ui, -apple-system, sans-serif; color: #111; margin: 0; }
  .letterhead { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 16px; }
  .letterhead .org { font-size: 14px; font-weight: 700; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 22px 0 6px; }
  .meta { color: #555; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e3e3e3; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #666; }
  .conclusion { white-space: pre-wrap; padding: 8px 10px; border: 1px solid #d8d8d4; border-radius: 6px; margin-top: 6px; }
  .sign { margin-top: 32px; display: flex; gap: 32px; break-inside: avoid; }
  .sign-line { display: flex; align-items: flex-end; gap: 8px; font-size: 12px; color: #444; }
  .sign-line i { display: inline-block; width: 200px; border-bottom: 1px solid #111; }
  tr { break-inside: avoid; }
  h2 { break-after: avoid; }
</style></head>
<body>
  ${
    env.institutionName
      ? `<div class="letterhead"><div class="org">${esc(env.institutionName)}</div></div>`
      : ""
  }
  <h1>Витяг за зверненням</h1>
  <p class="meta">${esc(d.fullName)}${d.unit ? `, ${esc(d.unit)}` : ""} ·
     ${esc(day(d.openedAt))} — ${d.closedAt ? esc(day(d.closedAt)) : "триває"}
     ${d.leadName ? ` · веде ${esc(d.leadName)}` : ""}</p>

  ${d.reason ? `<h2>Привід звернення</h2><p>${esc(d.reason)}</p>` : ""}

  <h2>Прийоми</h2>
  ${
    d.visits.length
      ? `<table><tr><th>Дата</th><th>Фахівець</th><th>Стан</th></tr>${rows(
          d.visits.map(
            (v) =>
              `<tr><td>${esc(day(v.at))}</td><td>${esc(v.specialist)}</td><td>${esc(v.status)}</td></tr>`,
          ),
        )}</table>`
      : "<p>Прийомів не було.</p>"
  }

  <h2>Висновки</h2>
  ${
    /*
     * Только подписанные. Черновик — мысль вслух, и попасть в дело он не
     * должен: подшитый черновик потом не отличити от рішення.
     */
    d.conclusions.length
      ? rows(
          d.conclusions.map(
            (x) =>
              `<div class="conclusion">${esc(x.text)}<div class="meta">${esc(x.author)}, ${esc(day(x.at))}</div></div>`,
          ),
        )
      : "<p>Підписаних висновків немає.</p>"
  }

  ${
    d.referrals.length
      ? `<h2>Направлення</h2><table><tr><th>Дата</th><th>Куди</th><th>Стан</th></tr>${rows(
          d.referrals.map(
            (r) =>
              `<tr><td>${esc(day(r.at))}</td><td>${esc(r.destination)}</td><td>${esc(r.status)}</td></tr>`,
          ),
        )}</table>`
      : ""
  }

  ${d.outcome ? `<h2>Результат</h2><p>${esc(d.outcome)}</p>` : ""}

  <div class="sign">
    <div class="sign-line">Фахівець <i></i></div>
    ${d.leadName ? `<div class="sign-line">${esc(d.leadName)}</div>` : ""}
  </div>
</body></html>`;
}

/**
 * Амбулаторная карта одним документом.
 *
 * Сейчас человек разложен по трём экранам: динамика, сводка, хронология. Это
 * удобно, пока смотришь с монитора, и бесполезно, когда карту надо подшить,
 * передать коллеге или показать на разборе — там нужен лист, а не три
 * вкладки.
 *
 * Собирается из того, что уже есть, и ничего не пересчитывает: карта обязана
 * показывать то же самое, что экраны, иначе она станет вторым источником
 * правды, и правды в ней будет меньше.
 */
reportRoutes.get("/patients/:userId/chart", requireStaff, requirePermission("patients.read"), async (c) => {
  const userId = c.req.param("userId");
  await assertPatientAccess(c.get("user"), userId);

  const patient = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!patient) notFound("err.patientNotFound");
  if (patient.anonymous) badRequest("err.certificateNeedsName");

  const lang = langOf(c);

  const eps = await db
    .select({ e: episodes, lead: users })
    .from(episodes)
    .leftJoin(users, eq(users.id, episodes.leadSpecialistId))
    .where(eq(episodes.patientId, userId))
    .orderBy(desc(episodes.openedAt));

  const visits = await db
    .select({ a: appointments, slot: slots, specialist: users })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .innerJoin(users, eq(users.id, appointments.specialistId))
    .where(eq(appointments.patientId, userId))
    .orderBy(desc(slots.startsAt))
    .limit(200);

  const signedNotes = await db
    .select({ n: patientNotes, author: users })
    .from(patientNotes)
    .leftJoin(users, eq(users.id, patientNotes.signedBy))
    .where(and(eq(patientNotes.userId, userId), eq(patientNotes.status, "signed")))
    .orderBy(desc(patientNotes.createdAt))
    .limit(100);

  const done = await db
    .select({ r: responses, title: surveys.title })
    .from(responses)
    .innerJoin(surveys, eq(surveys.id, responses.surveyId))
    .where(and(eq(responses.userId, userId), eq(responses.status, "completed")))
    .orderBy(desc(responses.submittedAt))
    .limit(200);

  await audit(c, {
    action: "report.patient_chart",
    resourceType: "user",
    resourceId: userId,
    subjectUserId: userId,
  });

  return c.html(
    chartHtml({
      fullName: fullNameOf(patient),
      unit: patient.unit,
      rank: patient.rank,
      birthDate: decryptField(patient.birthDate),
      episodes: eps.map((x) => ({
        openedAt: x.e.openedAt,
        closedAt: x.e.closedAt,
        reason: decryptField(x.e.reasonEnc),
        outcome: decryptField(x.e.outcomeEnc),
        outcomeKind: x.e.outcomeKind,
        lead: x.lead ? fullNameOf(x.lead) : null,
      })),
      visits: visits.map((v) => ({
        at: v.slot.startsAt,
        specialist: fullNameOf(v.specialist),
        kind: v.a.kind,
        status: v.a.status,
      })),
      notes: signedNotes.map((x) => ({
        at: x.n.createdAt,
        author: x.author ? fullNameOf(x.author) : "—",
        kind: x.n.kind,
        text: decryptField(x.n.text) ?? "",
      })),
      responses: done.map((x) => ({
        at: x.r.submittedAt ?? x.r.startedAt,
        title: t(x.title as never, lang),
        source: x.r.source,
      })),
    }),
  );
});

function chartHtml(d: {
  fullName: string;
  unit: string | null;
  rank: string | null;
  birthDate: string | null;
  episodes: {
    openedAt: string;
    closedAt: string | null;
    reason: string | null;
    outcome: string | null;
    outcomeKind: string | null;
    lead: string | null;
  }[];
  visits: { at: string; specialist: string; kind: string; status: string }[];
  notes: { at: string; author: string; kind: string; text: string }[];
  responses: { at: string; title: string; source: string | null }[];
}): string {
  const day = (iso: string) => new Date(iso).toLocaleDateString("uk-UA");

  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<title>Амбулаторна карта — ${esc(d.fullName)}</title>
<style>
  @page { margin: 16mm; }
  body { font: 12.5px/1.5 system-ui, -apple-system, sans-serif; color: #111; margin: 0; }
  .letterhead { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 14px; }
  .letterhead .org { font-size: 14px; font-weight: 700; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  h2 { font-size: 13px; margin: 20px 0 6px; text-transform: uppercase; letter-spacing: .05em; color: #555; }
  .meta { color: #555; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  td, th { text-align: left; padding: 5px 8px; border-bottom: 1px solid #e6e6e6; vertical-align: top; }
  th { font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; color: #666; }
  .note { white-space: pre-wrap; padding: 7px 9px; border: 1px solid #ddd; border-radius: 5px; margin-top: 5px; }
  .empty { color: #777; }
  tr, .note { break-inside: avoid; }
  h2 { break-after: avoid; }
</style></head>
<body>
  ${
    env.institutionName
      ? `<div class="letterhead"><div class="org">${esc(env.institutionName)}</div></div>`
      : ""
  }
  <h1>Амбулаторна карта</h1>
  <p class="meta">${esc(d.fullName)}${d.birthDate ? `, ${esc(day(d.birthDate))} р. н.` : ""}${
    d.unit ? ` · ${esc(d.unit)}` : ""
  }${d.rank ? ` · ${esc(d.rank)}` : ""}</p>

  <h2>Звернення</h2>
  ${
    d.episodes.length
      ? `<table><tr><th>Період</th><th>Привід</th><th>Веде</th><th>Результат</th></tr>${d.episodes
          .map(
            (e) =>
              `<tr><td>${esc(day(e.openedAt))} — ${e.closedAt ? esc(day(e.closedAt)) : "триває"}</td>` +
              `<td>${esc(e.reason ?? "—")}</td><td>${esc(e.lead ?? "—")}</td>` +
              `<td>${esc(e.outcome ?? e.outcomeKind ?? "—")}</td></tr>`,
          )
          .join("")}</table>`
      : '<p class="empty">Звернень не було.</p>'
  }

  <h2>Прийоми</h2>
  ${
    d.visits.length
      ? `<table><tr><th>Дата</th><th>Фахівець</th><th>Вид</th><th>Стан</th></tr>${d.visits
          .map(
            (v) =>
              `<tr><td>${esc(day(v.at))}</td><td>${esc(v.specialist)}</td>` +
              `<td>${v.kind === "primary" ? "перший" : "повторний"}</td><td>${esc(v.status)}</td></tr>`,
          )
          .join("")}</table>`
      : '<p class="empty">Прийомів не було.</p>'
  }

  <h2>Обстеження</h2>
  ${
    /*
     * Источник прохождения печатается рядом: «сам» и «за призначенням» — это
     * разные сведения о человеке, и в карте они значат разное.
     */
    d.responses.length
      ? `<table><tr><th>Дата</th><th>Методика</th><th>Звідки</th></tr>${d.responses
          .map(
            (r) =>
              `<tr><td>${esc(day(r.at))}</td><td>${esc(r.title)}</td><td>${esc(r.source ?? "—")}</td></tr>`,
          )
          .join("")}</table>`
      : '<p class="empty">Обстежень не було.</p>'
  }

  <h2>Записи прийому</h2>
  ${
    /*
     * Только подписанные. Черновик — рабочий текст, и в карте, которую
     * подшивают, он неотличим от решения.
     */
    d.notes.length
      ? d.notes
          .map(
            (n) =>
              `<div class="note">${esc(n.text)}<div class="meta">${esc(n.author)}, ${esc(day(n.at))}</div></div>`,
          )
          .join("")
      : '<p class="empty">Підписаних записів немає.</p>'
  }
</body></html>`;
}
