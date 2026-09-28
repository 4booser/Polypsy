import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq } from "drizzle-orm";
import { baseDb, db } from "../db";
import { systemContext, withRequestContext } from "../db/context";
import {
  answers,
  appointments,
  conclusions,
  departments,
  episodes,
  referrals,
  responseScores,
  responses,
  slots,
  specialistProfiles,
  users,
} from "../db/schema";
import { env } from "../env";
import { audit } from "../lib/audit";
import { badRequest, forbidden, langOf, notFound, type ErrorInfo } from "../lib/http";
import { referencePercentile, reportReferenceSamples } from "../lib/referenceSample";
import { chartHistory } from "../lib/chartHistory";
import { printCalendarDay, printDay, printStamp } from "../lib/printDates";
import { assertResponseRead } from "../lib/clinicalRead";
import { assertPatientAccess, isStaff } from "../lib/scope";
import { fullNameOf, toPublicUser } from "../lib/auth";
import { claimReportLink, issueReportLink, REPORT_LINK_PREFIX, REPORT_LINK_TTL_MS, type ReportLinkRow } from "../lib/reportLinks";
import { namesOf } from "../lib/names";
import { decryptField } from "../lib/crypto";
import {
  ageAt,
  formatDuration,
  LOCALE_OF,
  renderError,
  SEVERITY_FILL,
  serverText,
  t,
  uiText,
  type Lang,
  type ServerTextKey,
  type Severity,
  type TextParams,
  type UiKey,
  type User,
} from "@quizzy/shared";
import { getSurveyForResponse } from "../lib/surveys";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const reportRoutes = new Hono<AppEnv>();

reportRoutes.use("*", requireAuth);

/*
 * Язык документа — язык того, кто его открыл (волна 13).
 *
 * Печатное заключение было русским целиком, а справка, выписка и карта —
 * украинскими целиком, и ни то ни другое от интерфейса не зависело: текст
 * был набран прямо в разметке. Теперь все четыре листа собираются из
 * словаря сервера (serverStrings.ts, «print.*») на языке запроса — тот же
 * langOf, по которому сервер выбирает язык названий методик. Консоль шлёт
 * язык заголовком и при открытии листа во вкладке (apps/web/src/api.ts,
 * openInTab); без заголовка — украинский, язык учреждения.
 */
function sayer(lang: Lang) {
  return (key: ServerTextKey, params?: TextParams) => serverText(key, lang, params);
}

/*
 * Коды состояний на бумаге — словами, а не «done» и «assigned».
 *
 * Слова берутся из словаря оболочки: экраны называют те же состояния, и
 * лист, называющий их иначе, чем экран, заставлял бы сверять два словаря.
 * Незнакомый код печатается как есть — новое состояние в базе не должно
 * ронять печать.
 */
const CODE_WORDS: Record<string, Record<string, UiKey>> = {
  appointment: {
    booked: "day.statusBooked",
    confirmed: "day.statusConfirmed",
    arrived: "day.statusArrived",
    in_progress: "day.statusInProgress",
    done: "day.statusDone",
    no_show: "day.statusNoShow",
    cancelled: "day.statusCancelled",
  },
  visitKind: { primary: "day.primary", repeat: "day.repeat" },
  referralStatus: { created: "st.created", accepted: "st.accepted", completed: "st.completed", declined: "st.declined" },
  destination: {
    psychiatrist: "dest.psychiatrist",
    inpatient: "dest.inpatient",
    outpatient: "dest.outpatient",
    commander: "dest.commander",
    other: "dest.other",
  },
  source: {
    assigned: "visit.sourceAssigned",
    self: "visit.sourceSelf",
    kiosk: "visit.sourceKiosk",
    clinician: "visit.sourceClinician",
    informant: "visit.sourceInformant",
    intake: "visit.sourceIntake",
  },
  outcome: {
    improved: "ep.outImproved",
    stable: "ep.outStable",
    worse: "ep.outWorse",
    referred: "ep.outReferred",
    dropped: "ep.outDropped",
    transferred: "ep.outTransferred",
  },
};

function codeWord(lang: Lang, table: keyof typeof CODE_WORDS, code: string | null | undefined): string {
  if (!code) return "—";
  const key = CODE_WORDS[table]?.[code];
  return key ? uiText(key, lang) : code;
}

/** Возраст с согласованным существительным: «21 рік», «22 роки», «25 років» */
function ageText(lang: Lang, age: number): string {
  const form = new Intl.PluralRules(LOCALE_OF[lang]).select(age);
  const key: ServerTextKey = form === "one" ? "print.age.one" : form === "few" ? "print.age.few" : "print.age.many";
  return serverText(key, lang, { age });
}

/**
 * Прохождение, печатный лист которого этот человек вправе открыть, — или отказ.
 *
 * Одна проверка на три входа: лист по заголовку (консоль), выдача
 * одноразовой ссылки на него и открытие этой ссылки браузером (мобилка,
 * волна 14 — ниже). Копии разошлись бы на первой же правке, а расхождение
 * здесь означало бы, что ссылкой открывается то, что по заголовку закрыто.
 *
 * Кто вправе — решает не этот файл, а lib/clinicalRead.ts: своё прохождение
 * — сам обследуемый, чужое — сотрудник с правом читать данные пациентов в
 * зоне методики. Прежде здесь стояли роль и зона, без права, и сотрудник,
 * которому patients.read отняли исключением, печатал лист с ФИО и
 * подписанным заключением и выдавал на него ссылку — при том что само
 * заключение ему отвечало 403 (волна 15, внешний разбор, P1).
 */
async function reportable(c: Context<AppEnv>, user: User, responseId: string, lang: Lang) {
  const response = await db.query.responses.findFirst({ where: eq(responses.id, responseId) });
  if (!response) notFound("err.responseNotFound");

  await assertResponseRead(c, user, response);

  const survey = await getSurveyForResponse(response.id, lang);
  if (!survey) notFound("err.surveyNotFound");
  /*
   * Печатный отчёт — это баллы, полосы и нормативная выборка. Обследуемому
   * он положен, только если психолог включил показ результатов этой
   * методики (showResultsToPatient); иначе отчёт отдавался целиком и
   * обходил флаг, который уважала динамика (волна 12, клиническое ревью).
   * Отказ с причиной, а не 404: человек только что проходил эту методику, и
   * «не найдено» было бы неправдой; результаты он обсудит со специалистом.
   */
  if (!isStaff(user) && !survey.showResultsToPatient) forbidden("err.resultsWithSpecialist");
  return { response, survey };
}

/**
 * Печатное заключение по прохождению — самостоятельная HTML-страница.
 *
 * Отдаём разметку, а не готовый PDF: клиент печатает её системным механизмом,
 * и заключение одинаково открывается в мобилке, браузере и на печать,
 * без серверной зависимости на рендер PDF.
 */
reportRoutes.get("/responses/:id", async (c) =>
  c.html(await responseReport(c, c.get("user"), c.req.param("id"), langOf(c))),
);

/**
 * Лист по прохождению целиком: проверка, сборка, строка журнала.
 *
 * `via` — лист открыт одноразовой ссылкой (мобилка): строка журнала та же
 * report.render — это то же чтение тех же данных, — но с номером ссылки,
 * по которому её выдача (report.link_issue) и открытие находятся вместе.
 */
async function responseReport(
  c: Context<AppEnv>,
  user: User,
  responseId: string,
  lang: Lang,
  via?: { linkId: string },
): Promise<string> {
  const { response, survey } = await reportable(c, user, responseId, lang);
  const say = sayer(lang);

  // в отчёт идёт только ПОДПИСАННОЕ заключение: черновик — рабочий текст
  const [signedConclusion] = await db
    .select({ row: conclusions })
    .from(conclusions)
    .where(eq(conclusions.responseId, response.id))
    .orderBy(desc(conclusions.version))
    .limit(1);
  /*
   * Кто подписал — системной ролью (lib/names.ts), а не соединением с users:
   * отчёт открывает и сам обследуемый, а строку специалиста политика ему не
   * показывает — под ролью приложения в подписи стояло «—» (волна 13).
   */
  const signer = signedConclusion?.row.signedBy
    ? (await namesOf([signedConclusion.row.signedBy])).get(signedConclusion.row.signedBy)
    : undefined;

  const [scoreRows, answerRows] = await Promise.all([
    db.select().from(responseScores).where(eq(responseScores.responseId, response.id)),
    db.select().from(answers).where(eq(answers.responseId, response.id)),
  ]);

  const patient = response.userId
    ? await db.query.users.findFirst({ where: eq(users.id, response.userId) })
    : null;

  /*
   * Референтная выборка для перцентиля — lib/referenceSample.ts: совместимые
   * версии (та же или доказанно тот же ключ и размах), только достоверные,
   * только обследуемые, по одному значению на человека, от десяти людей.
   * Прежде здесь были все сырые баллы методики с тем же кодом шкалы — вместе
   * со старыми версиями другого размаха, проваленными протоколами и каждым
   * повтором одного человека (волна 15, внешний разбор). Системной ролью, как
   * и прежде: пациенту под ролью приложения видны только свои прохождения
   * (волна 13).
   */
  const sample = await reportReferenceSamples(response, survey, scoreRows);

  const scaleById = new Map(survey.scales.map((s) => [s.id, s]));
  const answerByQuestion = new Map(answerRows.map((a) => [a.questionId, a]));
  const optionText = new Map(survey.questions.flatMap((q) => q.options.map((o) => [o.id, o.text])));

  await audit(c, {
    action: "report.render",
    resourceType: "response",
    resourceId: response.id,
    subjectUserId: response.userId,
    details: {
      surveyId: survey.id,
      version: survey.versionNumber,
      ...(via ? { via: "link", linkId: via.linkId } : {}),
    },
  });

  /* возраст на день сдачи по календарю учреждения, а не по часам процесса (shared ageAt) */
  const age = patient ? ageAt(decryptField(patient.birthDate), response.submittedAt, env.institutionTz) : null;
  return renderReport(lang, {
    surveyTitle: survey.title,
    versionNumber: survey.versionNumber,
    patientName: patient ? fullNameOf(patient) : say("print.anonymous"),
    patientMeta: patient
      ? [
          patient.sex ? say(patient.sex === "male" ? "print.sexMale" : "print.sexFemale") : null,
          age !== null ? ageText(lang, age) : null,
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
        percentile: referencePercentile(s.rawScore, sample.get(s.scaleId) ?? []),
      };
    }),
    answers: survey.questions
      .filter((q) => q.type !== "info")
      .map((q) => {
        const a = answerByQuestion.get(q.id);
        return {
          title: q.title,
          value: formatValue(a, optionText, say("print.notAnswered")),
          durationMs: a?.durationMs ?? 0,
        };
      }),
    conclusion:
      signedConclusion && signedConclusion.row.status === "signed"
        ? {
            text: decryptField(signedConclusion.row.text) ?? "",
            version: signedConclusion.row.version,
            signedAt: signedConclusion.row.signedAt,
            signedBy: signer ?? "—",
          }
        : null,
    printedBy: fullNameOf(user),
    printedAt: new Date().toISOString(),
  });
}

/* ─────────── одноразовая ссылка на лист (мобилка, волна 14) ─────────── */

/**
 * Выдача одноразовой ссылки на лист по прохождению.
 *
 * Мобилка открывает лист браузером телефона, а браузер не пошлёт ни
 * заголовка Authorization, ни языка приложения: прежде приложение отдавало
 * ему голый адрес листа, и лист не открывался вовсе (401). Токен в адрес не
 * кладётся никогда — ни access, ни refresh: адрес оседает в истории
 * браузера, в логах прокси и в заголовке Referer. Вместо этого приложение
 * этим запросом — с токеном и языком в заголовках — получает ссылку на один
 * лист: минута жизни, одно открытие, только от имени выдавшего
 * (lib/reportLinks.ts, миграция 0109). Консоль этим путём не ходит: она
 * забирает лист запросом и открывает из памяти (apps/web/src/api.ts,
 * openInTab).
 *
 * Проверка — та же, что у самого листа (reportable), и ДО выдачи: пациент,
 * которому методика результатов не показывает, получает отказ
 * err.resultsWithSpecialist здесь, в приложении, на своём языке, а не
 * страницей отказа в браузере. При открытии ссылки проверка повторяется —
 * за минуту показ могли выключить.
 *
 * Язык листа — язык этого запроса (Accept-Language приложения), и он
 * запоминается в ссылке: список языков браузера, который её откроет, на
 * лист уже не влияет.
 *
 * Вход «от имени» ссылок не получает: он только смотрит (guardImpersonated
 * режет запись раньше), а ссылка открылась бы уже без пометки «от имени» —
 * под учёткой того, на кого смотрят. Отказ повторён здесь, чтобы не зависеть
 * от того, что сторож записи когда-нибудь пропустит этот путь.
 */
reportRoutes.post("/responses/:id/link", async (c) => {
  const user = c.get("user");
  if (user.impersonation) forbidden("err.impersonationReadOnly");
  const lang = langOf(c);
  const { response } = await reportable(c, user, c.req.param("id"), lang);
  const link = await issueReportLink({ userId: user.id, responseId: response.id, lang });
  await audit(c, {
    action: "report.link_issue",
    resourceType: "response",
    resourceId: response.id,
    subjectUserId: response.userId,
    details: { linkId: link.id, lang, ttlSeconds: REPORT_LINK_TTL_MS / 1000 },
  });
  return c.json({ path: `${REPORT_LINK_PREFIX}${link.raw}`, ttlSeconds: REPORT_LINK_TTL_MS / 1000 }, 201);
});

/**
 * Открытие одноразовой ссылки браузером — без входа: ссылка сама и есть
 * разрешение, на одну минуту и один лист.
 *
 * Отдельный набор маршрутов на своём пути (/api/report-links), потому что
 * весь /api/reports закрыт requireAuth, а браузер приходит без заголовка.
 *
 * Порядок:
 *   1. Гашение — системной ролью и своей транзакцией, ДО сборки листа:
 *      отказ при сборке (показ результатов выключили, прохождение удалено)
 *      откатывает транзакцию листа, но не должен оживлять ссылку.
 *   2. Учётная запись того, кому выдана: выключена или её сессии отозваны
 *      после выдачи (выход, смена пароля) — ссылка мертва так же, как
 *      access-токен, выданный до отзыва (middleware/auth.ts).
 *   3. Лист — той же responseReport, что по заголовку, в транзакции запроса
 *      от имени выдавшего: политики строк, зона видимости и правило показа
 *      результатов те же, что при обычном открытии.
 *
 * Отказы — страницей на языке ссылки, а не JSON: читает их человек в
 * браузере телефона. Мёртвая ссылка — 410 одним текстом на все причины
 * (незнакомая, открытая, просроченная, отозванная): причина нужна журналу,
 * а не тому, кто держит ссылку. Незнакомая ссылка в журнал не пишется: иначе
 * любой без входа мог бы заваливать журнал строками, перебирая адреса;
 * повтор НАСТОЯЩЕЙ ссылки пишется — это признак, что ссылка утекла.
 *
 * Ответ не кэшируется (no-store): лист с персональными данными не должен
 * оставаться в кэше браузера после закрытия вкладки. Referer наружу не
 * уходит и так — secureHeaders ставит Referrer-Policy: no-referrer всем.
 */
export const reportLinkRoutes = new Hono<AppEnv>();

reportLinkRoutes.get("/:token", async (c) => {
  c.header("Cache-Control", "no-store");
  /*
   * HEAD — не открытие: так ссылку трогают чужие роботы (проверка ссылки,
   * предзагрузка). Hono отвечает на HEAD обработчиком GET, и без этой
   * строки робот гасил бы ссылку раньше человека.
   */
  if (c.req.method === "HEAD") return c.body(null, 200);

  const claimed = await systemContext(baseDb, () => claimReportLink(c.req.param("token")));
  if (!claimed.ok) {
    if (claimed.link) await refuseLink(c, claimed.link, claimed.reason);
    return deadLink(c, claimed.link?.lang ?? langOf(c));
  }
  const link = claimed.link;

  const row = await systemContext(baseDb, () => db.query.users.findFirst({ where: eq(users.id, link.userId) }));
  if (!row || row.disabledAt || Date.parse(row.tokensValidFrom) > Date.parse(link.createdAt)) {
    await refuseLink(c, link, row && !row.disabledAt ? "revoked" : "disabled");
    return deadLink(c, link.lang);
  }

  const user = toPublicUser(row);
  c.set("user", user);
  let html = "";
  try {
    await withRequestContext(
      baseDb,
      { userId: user.id, role: user.role },
      async () => {
        html = await responseReport(c, user, link.responseId, link.lang, { linkId: link.id });
      },
      () => false,
      { readOnly: row.readOnly },
    );
  } catch (err) {
    if (!(err instanceof HTTPException)) throw err;
    const info = err.cause as ErrorInfo | undefined;
    const text = info?.key ? renderError(info.key, link.lang, info.params) : err.message;
    return c.html(linkNotice(link.lang, text), err.status);
  }
  return c.html(html);
});

/** Повтор настоящей ссылки — в журнал: ссылка утекла или открыта дважды */
async function refuseLink(c: Context<AppEnv>, link: ReportLinkRow, reason: string): Promise<void> {
  await audit(c, {
    action: "report.link_refused",
    outcome: "denied",
    resourceType: "response",
    resourceId: link.responseId,
    /*
     * Действующее лицо неизвестно — ссылку мог открыть кто угодно, в этом и
     * вопрос, — поэтому не выдавший, а пусто; кому выдана — в подробностях.
     */
    details: { linkId: link.id, issuedTo: link.userId, reason },
  });
}

function deadLink(c: Context<AppEnv>, lang: Lang) {
  return c.html(linkNotice(lang, renderError("err.reportLinkGone", lang)), 410);
}

/** Страница отказа для браузера: одна фраза на языке ссылки */
function linkNotice(lang: Lang, text: string): string {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(text)}</title>
<style>body { font: 16px/1.5 system-ui, -apple-system, sans-serif; color: #111; margin: 0; padding: 24px; max-width: 560px; }</style>
</head><body><p>${esc(text)}</p></body></html>`;
}

function formatValue(
  a: { optionIds?: string[] | null; text?: string | null; number?: number | null; date?: string | null; matrix?: Record<string, string> | null; ranking?: string[] | null; skipped?: boolean } | undefined,
  optionText: Map<string, string>,
  notAnswered: string,
): string {
  if (!a || a.skipped) return notAnswered;
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

/**
 * Цвет ступени на бумаге — из общей палитры, а не своей копией.
 *
 * Здесь лежали те же четыре хекса, переписанные руками. Пока они совпадали с
 * палитрой, копия выглядела безобидной; разошлись бы они молча — печать
 * продолжала бы выдавать старый оттенок ещё долго после того, как его
 * поправили в одном месте. Подложка у листа своя (белая), поэтому берётся
 * именно SEVERITY_FILL: экранные ступени подобраны под тёмную землю и на
 * бумаге не читаются.
 */
function severityColor(severity: string | null): string {
  return SEVERITY_FILL[(severity ?? "none") as Severity] ?? "#888";
}

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

function renderReport(lang: Lang, d: ReportData): string {
  const say = sayer(lang);
  /* длительность — общим форматом консоли: «4,2 с», «1 хв 12 с», «—» у неизмеренной */
  const duration = formatDuration(d.durationMs, lang);

  /*
   * Про стили листа: подпись (.sign) не отрывается от документа переносом
   * страницы, строки таблиц (tr) не рвутся посередине. Пояснение — здесь, а
   * не CSS-комментарием в <style>: комментарий в разметке уезжал вместе с
   * листом и читался по-русски в исходнике страницы на любом языке (то же
   * правило, что у справки ниже).
   *
   * Ширина экрана (viewport) — потому что с волны 14 лист открывает и
   * браузер телефона (мобилка, одноразовая ссылка): без неё телефон
   * раскладывал бы лист на 980 точек и показывал мелким шрифтом целиком.
   * На печать она не влияет — там ширину задаёт @page.
   */

  const scoreRows = d.scores
    .map(
      (s) => `
      <tr>
        <td>${esc(s.title)}</td>
        <td class="num">${esc(say("print.scoreOf", { raw: s.rawScore, max: s.maxScore }))}</td>
        <td class="num">${s.percent}%</td>
        <td>${
          s.band
            ? `<span class="dot" style="background:${severityColor(s.severity)}"></span>${esc(s.band)}`
            : "—"
        }</td>
        <td class="num">${s.percentile === null ? "—" : esc(say("print.percentileN", { n: s.percentile }))}</td>
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
        <td class="num">${esc(formatDuration(a.durationMs, lang))}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(say("print.reportTitle", { survey: d.surveyTitle }))}</title>
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

  .sign { margin-top: 26px; break-inside: avoid; display: flex; gap: 32px; flex-wrap: wrap; }
  .sign-line { display: flex; align-items: flex-end; gap: 8px; font-size: 12px; color: #444; }
  .sign-line i { display: inline-block; width: 190px; border-bottom: 1px solid #111; }
  .sign-hint { font-size: 10px; color: #888; }

  .footer { margin-top: 18px; border-top: 1px solid #e3e3e3; padding-top: 8px; }
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
    ${esc(d.patientName)}${d.patientMeta ? ` · ${esc(d.patientMeta)}` : ""} · ${esc(say("print.surveyVersion", { n: d.versionNumber }))} ·
    ${d.submittedAt ? esc(printStamp(d.submittedAt)) : esc(say("print.notFinished"))} ·
    ${esc(say("print.timeTaken", { duration }))}
  </div>

  ${
    d.scores.length
      ? `<h2>${say("print.scoresTitle")}</h2>
  <table>
    <tr><th>${say("print.colSubscale")}</th><th class="num">${say("print.colScore")}</th><th class="num">${say("print.colPercent")}</th><th>${say("print.colInterpretation")}</th><th class="num">${say("print.colPercentile")}</th></tr>
    ${scoreRows}
  </table>`
      : ""
  }

  <h2>${say("print.answersTitle")}</h2>
  <table>
    <tr><th class="num">${say("print.colNo")}</th><th>${say("print.colQuestion")}</th><th>${say("print.colAnswer")}</th><th class="num">${say("print.colTime")}</th></tr>
    ${answerRows}
  </table>

  ${
    d.conclusion
      ? `<h2>${say("print.conclusionTitle")}</h2>
  <div class="conclusion">${esc(d.conclusion.text).replaceAll("\n", "<br>")}</div>
  <div class="meta" style="margin-top:6px">
    ${esc(say("print.signedBy", { who: d.conclusion.signedBy }))}${
      d.conclusion.signedAt ? `, ${esc(printStamp(d.conclusion.signedAt))}` : ""
    } · ${esc(say("print.version", { n: d.conclusion.version }))}
  </div>`
      : ""
  }

  <div class="note">${say("print.disclaimer")}</div>

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
      <span>${say("print.clinician")}</span>
      <i></i>
      <span class="sign-hint">${say("print.signature")}</span>
    </div>
    <div class="sign-line">
      <span>${say("print.date")}</span>
      <i></i>
    </div>
  </div>`
  }

  <div class="meta footer">
    ${esc(say("print.printedBy", { who: d.printedBy, at: printStamp(d.printedAt) }))}
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

  /*
   * Имя специалиста — системной ролью (lib/names.ts). Справку берёт и сам
   * пациент, а строку специалиста политика users ему не показывает: под
   * ролью приложения выборка отдавала undefined, и справка о посещении
   * падала пятисоткой (волна 13, обход всех GET под ролью приложения).
   */
  const specialistName = (await namesOf([appointment.specialistId])).get(appointment.specialistId) ?? "—";
  const [slot] = await db.select().from(slots).where(eq(slots.id, appointment.slotId));
  const profile = await db.query.specialistProfiles.findFirst({
    where: eq(specialistProfiles.userId, appointment.specialistId),
  });
  /* отделение нужно здесь только ради часового пояса: его названия в справке нет */
  const department = profile
    ? await db.query.departments.findFirst({ where: eq(departments.id, profile.departmentId) })
    : null;
  /* без отделения — пояс учреждения (INSTITUTION_TZ), а не зашитый Киев: тот же, что у остальных листов */
  const tz = department?.timezone ?? env.institutionTz;

  await audit(c, {
    action: "report.visit_certificate",
    resourceType: "appointment",
    resourceId: appointment.id,
    subjectUserId: appointment.patientId,
  });

  return c.html(
    visitCertificateHtml(langOf(c), {
      fullName: fullNameOf(patient),
      unit: patient.unit,
      startsAt: slot!.startsAt,
      endsAt: slot!.endsAt,
      timezone: tz,
      specialistName,
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
function visitCertificateHtml(
  lang: Lang,
  d: {
    fullName: string;
    unit: string | null;
    startsAt: string;
    endsAt: string;
    timezone: string;
    specialistName: string;
  },
): string {
  const say = sayer(lang);
  const locale = LOCALE_OF[lang];
  const date = new Date(d.startsAt).toLocaleDateString(locale, { timeZone: d.timezone });
  const from = new Date(d.startsAt).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: d.timezone,
  });
  const to = new Date(d.endsAt).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: d.timezone,
  });

  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<title>${say("print.certTitle")}</title>
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
  <h1>${say("print.certTitle")}</h1>
  <p>${esc(say("print.certBody", { name: d.fullName, unit: d.unit ? `, ${d.unit}` : "", date, from, to }))}</p>
  <p>${say("print.certPurpose")}</p>

  <div class="sign">
    <div class="sign-line">${say("print.clinician")} <i></i></div>
    <div class="sign-line">${esc(d.specialistName)}</div>
  </div>
  <p class="issued">${esc(say("print.certIssued", { date: new Date().toLocaleDateString(locale, { timeZone: d.timezone }) }))}</p>
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
    .select({ a: appointments, slot: slots, specialist: users, timezone: departments.timezone })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .innerJoin(users, eq(users.id, appointments.specialistId))
    .leftJoin(departments, eq(departments.id, slots.departmentId))
    .where(eq(appointments.episodeId, episode.id))
    .orderBy(asc(slots.startsAt), asc(appointments.id));

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
    episodeExtractHtml(langOf(c), {
      fullName: fullNameOf(patient),
      unit: patient.unit,
      openedAt: episode.openedAt,
      closedAt: episode.closedAt,
      reason: decryptField(episode.reasonEnc),
      outcome: decryptField(episode.outcomeEnc),
      leadName: lead ? fullNameOf(lead) : null,
      visits: visits.map((v) => ({
        at: v.slot.startsAt,
        timezone: v.timezone ?? env.institutionTz,
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

function episodeExtractHtml(
  lang: Lang,
  d: {
    fullName: string;
    unit: string | null;
    openedAt: string;
    closedAt: string | null;
    reason: string | null;
    outcome: string | null;
    leadName: string | null;
    visits: { at: string; timezone: string; specialist: string; status: string }[];
    conclusions: { at: string; author: string; text: string }[];
    referrals: { at: string; destination: string; status: string }[];
  },
): string {
  const say = sayer(lang);
  /* моменты — днём учреждения, приём — днём своего отделения (lib/printDates.ts), как в карте */
  const day = (iso: string) => printDay(iso, lang);
  const rows = (items: string[]) => items.join("");

  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<title>${say("print.extractTitle")}</title>
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
  <h1>${say("print.extractTitle")}</h1>
  <p class="meta">${esc(d.fullName)}${d.unit ? `, ${esc(d.unit)}` : ""} ·
     ${esc(day(d.openedAt))} — ${d.closedAt ? esc(day(d.closedAt)) : say("print.ongoing")}
     ${d.leadName ? ` · ${esc(say("print.leadBy", { name: d.leadName }))}` : ""}</p>

  ${d.reason ? `<h2>${say("print.reasonTitle")}</h2><p>${esc(d.reason)}</p>` : ""}

  <h2>${say("print.visitsTitle")}</h2>
  ${
    d.visits.length
      ? `<table><tr><th>${say("print.date")}</th><th>${say("print.clinician")}</th><th>${say("print.colStatus")}</th></tr>${rows(
          d.visits.map(
            (v) =>
              `<tr><td>${esc(printDay(v.at, lang, v.timezone))}</td><td>${esc(v.specialist)}</td><td>${esc(codeWord(lang, "appointment", v.status))}</td></tr>`,
          ),
        )}</table>`
      : `<p>${say("print.noVisits")}</p>`
  }

  <h2>${say("print.conclusionsTitle")}</h2>
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
      : `<p>${say("print.noConclusions")}</p>`
  }

  ${
    d.referrals.length
      ? `<h2>${say("print.referralsTitle")}</h2><table><tr><th>${say("print.date")}</th><th>${say("print.colDestination")}</th><th>${say("print.colStatus")}</th></tr>${rows(
          d.referrals.map(
            (r) =>
              `<tr><td>${esc(day(r.at))}</td><td>${esc(codeWord(lang, "destination", r.destination))}</td><td>${esc(codeWord(lang, "referralStatus", r.status))}</td></tr>`,
          ),
        )}</table>`
      : ""
  }

  ${d.outcome ? `<h2>${say("print.outcomeTitle")}</h2><p>${esc(d.outcome)}</p>` : ""}

  <div class="sign">
    <div class="sign-line">${say("print.clinician")} <i></i></div>
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

  /*
   * История целиком, порциями (lib/chartHistory.ts). Прежде здесь стояли
   * лимиты — 200 приёмов, 100 подписанных записей, 200 обследований, — и
   * карта молча теряла начало истории, оставаясь на вид полной (волна 15,
   * внешний разбор, п. 20).
   */
  const { episodes: eps, visits, notes: signedNotes, responses: done } = await chartHistory(userId);

  await audit(c, {
    action: "report.patient_chart",
    resourceType: "user",
    resourceId: userId,
    subjectUserId: userId,
  });

  return c.html(
    chartHtml(lang, {
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
        timezone: v.timezone ?? env.institutionTz,
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

function chartHtml(
  lang: Lang,
  d: {
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
    visits: { at: string; timezone: string; specialist: string; kind: string; status: string }[];
    notes: { at: string; author: string; kind: string; text: string }[];
    responses: { at: string; title: string; source: string | null }[];
  },
): string {
  const say = sayer(lang);
  /*
   * Моменты — днём учреждения, приём — днём своего отделения, рождение — как
   * записано (lib/printDates.ts). Прежде всё шло через toLocaleDateString без
   * пояса, то есть по часам процесса (волна 15, внешний разбор, п. 21).
   */
  const day = (iso: string) => printDay(iso, lang);

  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<title>${say("print.chartTitle")} — ${esc(d.fullName)}</title>
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
  <h1>${say("print.chartTitle")}</h1>
  <p class="meta">${esc(d.fullName)}${d.birthDate ? `, ${esc(say("print.bornOn", { date: printCalendarDay(d.birthDate, lang) }))}` : ""}${
    d.unit ? ` · ${esc(d.unit)}` : ""
  }${d.rank ? ` · ${esc(d.rank)}` : ""}</p>

  <h2>${say("print.episodesTitle")}</h2>
  ${
    d.episodes.length
      ? `<table><tr><th>${say("print.colPeriod")}</th><th>${say("print.colReason")}</th><th>${say("print.colLead")}</th><th>${say("print.outcomeTitle")}</th></tr>${d.episodes
          .map(
            (e) =>
              `<tr><td>${esc(day(e.openedAt))} — ${e.closedAt ? esc(day(e.closedAt)) : say("print.ongoing")}</td>` +
              `<td>${esc(e.reason ?? "—")}</td><td>${esc(e.lead ?? "—")}</td>` +
              `<td>${esc(e.outcome ?? codeWord(lang, "outcome", e.outcomeKind))}</td></tr>`,
          )
          .join("")}</table>`
      : `<p class="empty">${say("print.noEpisodes")}</p>`
  }

  <h2>${say("print.visitsTitle")}</h2>
  ${
    d.visits.length
      ? `<table><tr><th>${say("print.date")}</th><th>${say("print.clinician")}</th><th>${say("print.colKind")}</th><th>${say("print.colStatus")}</th></tr>${d.visits
          .map(
            (v) =>
              `<tr><td>${esc(printDay(v.at, lang, v.timezone))}</td><td>${esc(v.specialist)}</td>` +
              `<td>${esc(codeWord(lang, "visitKind", v.kind))}</td><td>${esc(codeWord(lang, "appointment", v.status))}</td></tr>`,
          )
          .join("")}</table>`
      : `<p class="empty">${say("print.noVisits")}</p>`
  }

  <h2>${say("print.assessmentsTitle")}</h2>
  ${
    /*
     * Источник прохождения печатается рядом: «сам» и «за призначенням» — это
     * разные сведения о человеке, и в карте они значат разное.
     */
    d.responses.length
      ? `<table><tr><th>${say("print.date")}</th><th>${say("print.colAssessment")}</th><th>${say("print.colSource")}</th></tr>${d.responses
          .map(
            (r) =>
              `<tr><td>${esc(day(r.at))}</td><td>${esc(r.title)}</td><td>${esc(codeWord(lang, "source", r.source))}</td></tr>`,
          )
          .join("")}</table>`
      : `<p class="empty">${say("print.noAssessments")}</p>`
  }

  <h2>${say("print.notesTitle")}</h2>
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
      : `<p class="empty">${say("print.noNotes")}</p>`
  }
</body></html>`;
}
