import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, lt } from "drizzle-orm";
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
  scales,
  slots,
  specialistProfiles,
  surveys,
  users,
} from "../db/schema";
import { env } from "../env";
import { audit } from "../lib/audit";
import { badRequest, forbidden, langOf, notFound, type ErrorInfo } from "../lib/http";
import { referencePercentile, reportReferenceSamples } from "../lib/referenceSample";
import { chartHistory } from "../lib/chartHistory";
import { printCalendarDay, printDay, printMoment, printTime } from "../lib/printDates";
import {
  esc,
  facts,
  icon,
  scaleSvg,
  section,
  sevPill,
  sheetDocument,
  sheetFoot,
  sheetHead,
  signs,
  stepOf,
  stepsOfBands,
  type IconName,
  type ScaleBandView,
} from "../lib/printSheet";
import { gonePage, linkPage, noticePage, panel, point, printButtons } from "../lib/printLink";
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
  serverText,
  t,
  uiText,
  type Lang,
  type ServerTextKey,
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
  noteKind: { intake: "note.intake", session: "note.session", observation: "note.observation", consult: "note.consult" },
};

/*
 * Состояние на бумаге — знаком и словом, а не цветом (монохромный принтер):
 * состоялся — галочка, не пришёл — перечёркнутый календарь, отменён —
 * крестик, впереди — календарь с часами. Цвет остаётся подсказкой экрана.
 */
const VISIT_MARK: Record<string, [cls: string, icon: IconName]> = {
  done: ["ok", "check"],
  arrived: ["ok", "userCheck"],
  in_progress: ["v", "dot"],
  no_show: ["wn", "calendarX"],
  cancelled: ["off", "x"],
  booked: ["v", "calendarClock"],
  confirmed: ["v", "calendarClock"],
};

const REFERRAL_MARK: Record<string, [cls: string, icon: IconName]> = {
  created: ["v", "send"],
  accepted: ["v", "calendarClock"],
  completed: ["ok", "check"],
  declined: ["off", "x"],
};

/** Состояние словом со знаком */
function stateMark(lang: Lang, table: "appointment" | "referralStatus", code: string): string {
  const [cls, ic] = (table === "appointment" ? VISIT_MARK : REFERRAL_MARK)[code] ?? ["", "dot"];
  return `<span class="ps-st ${cls}">${icon(ic, 12)}${esc(codeWord(lang, table, code))}</span>`;
}

/** День недели коротким словом языка листа, в поясе приёма */
function weekday(iso: string, lang: Lang, tz: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString(LOCALE_OF[lang], { weekday: "short", timeZone: tz });
}

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
  /*
   * Критический ответ помечается на листе только для сотрудника. Обследуемый
   * печатает тот же лист себе, а какие ответы поднимают тревогу, ему не
   * отдаётся и в самой методике (#141, ключ методики пациенту не отдаётся).
   */
  const staffView = isStaff(user);
  const riskOptions = new Set(
    staffView ? survey.questions.flatMap((q) => q.options.filter((o) => o.riskFlag).map((o) => o.id)) : [],
  );

  /*
   * Прежние замеры той же шкалы у того же человека — кольцами на шкале листа
   * и строкой «Заміри». Та же методика, тот же код шкалы и тот же размах:
   * балл другой версии с другим потолком на одной оси врал бы. Порядок —
   * от раннего к позднему, в листе — два последних перед этим.
   */
  const history =
    response.userId && response.submittedAt
      ? await db
          .select({
            code: scales.code,
            raw: responseScores.rawScore,
            corrected: responseScores.correctedScore,
            max: responseScores.maxScore,
            at: responses.submittedAt,
          })
          .from(responseScores)
          .innerJoin(responses, eq(responses.id, responseScores.responseId))
          .innerJoin(scales, eq(scales.id, responseScores.scaleId))
          .where(
            and(
              eq(responses.userId, response.userId),
              eq(responses.surveyId, response.surveyId),
              eq(responses.status, "completed"),
              lt(responses.submittedAt, response.submittedAt),
            ),
          )
          .orderBy(desc(responses.submittedAt))
          .limit(100)
      : [];

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
    surveyDescription: survey.description,
    versionNumber: survey.versionNumber,
    patientName: patient ? fullNameOf(patient) : say("print.anonymous"),
    sexAge: patient
      ? [
          patient.sex ? say(patient.sex === "male" ? "print.sexMale" : "print.sexFemale") : null,
          age !== null ? ageText(lang, age) : null,
        ]
          .filter(Boolean)
          .join(", ") || null
      : null,
    rank: patient?.rank ?? null,
    unit: patient?.unit ?? null,
    startedAt: response.startedAt,
    submittedAt: response.submittedAt,
    durationMs: response.durationMs,
    staffView,
    scores: scoreRows.map((s) => {
      const scale = scaleById.get(s.scaleId);
      /*
       * Полосы шкалы — только сотруднику, как и в самой методике (#141):
       * пороги полос обследуемому не отдаются. Его лист рисует шкалу без
       * зон — балл, прежние замеры и слово своей полосы.
       */
      const bandRows = staffView && scale?.normalization === "raw" ? [...scale.bands].sort((a, b) => a.minScore - b.minScore) : [];
      const bandSteps = stepsOfBands(bandRows);
      const own = bandRows.findIndex((b) => b.label === s.bandLabel);
      const earlier = scale
        ? history
            .filter((h) => h.code === scale.code && h.max === s.maxScore)
            .map((h) => ({ value: h.corrected ?? h.raw, at: h.at! }))
            .reverse()
        : [];
      /*
       * «Бал з максимуму» — балл ПОСЛЕ поправок (#133): от него считаются
       * процент и максимум (scoring.ts, scaleMaxScore), и с ним же
       * сравнивается выборка перцентиля (lib/referenceSample.ts). Сырой балл
       * без поправок у ЛАП МЛО — всегда 0: лист печатал «0 з 0 · 0 %» и
       * 50-й перцентиль у любого человека. У строк до волны 18 балла после
       * поправок нет (миграция 0118) — там он равен сырому, кроме шкал с
       * поправками, которые дописала миграция 0126.
       */
      const score = s.correctedScore ?? s.rawScore;
      return {
        title: scale?.title ?? "—",
        score,
        maxScore: s.maxScore,
        percent: s.percent,
        band: s.bandLabel,
        /* ступень своей полосы — с учётом соседних тяжёлых (s3/s4), иначе по выраженности */
        step: own >= 0 ? (bandSteps[own] ?? null) : stepOf(s.severity),
        bands: bandRows.map((b, i) => ({ min: b.minScore, max: b.maxScore, step: bandSteps[i] ?? null })),
        history: earlier,
        percentile: referencePercentile(score, sample.get(s.scaleId) ?? []),
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
          answered: !!a && !a.skipped,
          critical: !!a?.optionIds?.some((id) => riskOptions.has(id)),
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
    linked: !!via,
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

/** Мёртвая ссылка — страницей «Посилання вже недійсне» (lib/printLink.ts) */
function deadLink(c: Context<AppEnv>, lang: Lang) {
  return c.html(gonePage(lang), 410);
}

/** Страница отказа для браузера: одна фраза на языке ссылки */
function linkNotice(lang: Lang, text: string): string {
  return noticePage(lang, text);
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


/* ─────────── лист прохождения и заключение ─────────── */

/*
 * Выраженность на листе — слово в обводке ступени набора s0…s4 на белом
 * (SEVERITY_STEPS_SCREEN_LIGHT из palette.ts, через lib/printSheet.ts): та
 * же лестница, что у консоли в светлой теме, — лист и экран называют
 * ступень одним цветом. Прежде здесь стояла цветная точка заливки
 * SEVERITY_FILL: на монохромном принтере четыре точки становились одной
 * серой, и выраженность держалась только на подписи рядом.
 */

interface ScoreView {
  title: string;
  /** Балл после поправок — тот, от которого процент */
  score: number;
  maxScore: number;
  percent: number;
  band: string | null;
  /** Ступень набора своей полосы, 0…4 */
  step: number | null;
  /** Полосы шкалы для рисунка — только сотруднику (#141) */
  bands: ScaleBandView[];
  /** Прежние замеры той же шкалы, от раннего к позднему */
  history: { value: number; at: string }[];
  percentile: number | null;
}

interface ReportData {
  conclusion: { text: string; version: number; signedAt: string | null; signedBy: string } | null;
  printedBy: string;
  printedAt: string;
  surveyTitle: string;
  surveyDescription: string | null;
  versionNumber: number;
  patientName: string;
  sexAge: string | null;
  rank: string | null;
  unit: string | null;
  startedAt: string;
  submittedAt: string | null;
  durationMs: number;
  staffView: boolean;
  scores: ScoreView[];
  answers: { title: string; value: string; durationMs: number; answered: boolean; critical: boolean }[];
  /** Лист открыт одноразовой ссылкой: рамка гостевой страницы (lib/printLink.ts) */
  linked: boolean;
}

/** Балл в крупной цифре и на шкале: целый — как есть, дробный — до сотых */
function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** Изменение со знаком: «−8», «+3», «0» (минус — типографский, он есть в шрифте листа) */
function signedDelta(v: number): string {
  const r = Math.round(v * 100) / 100;
  return r > 0 ? `+${r}` : r < 0 ? `−${-r}` : "0";
}

/** Когда обследовали: начало и конец, без повтора даты в один день */
function assessedWhen(lang: Lang, d: ReportData): string {
  const say = sayer(lang);
  if (!d.submittedAt) return `${printMoment(d.startedAt, lang)}, ${say("print.notFinished")}`;
  if (d.startedAt === d.submittedAt) return printMoment(d.submittedAt, lang);
  return printDay(d.startedAt, lang) === printDay(d.submittedAt, lang)
    ? `${printMoment(d.startedAt, lang)}–${printTime(d.submittedAt)}`
    : `${printMoment(d.startedAt, lang)} – ${printMoment(d.submittedAt, lang)}`;
}

/**
 * Результат одношкальной методики крупно: балл из максимума, полоса словом,
 * шкала с прежними замерами, проценты и перцентиль сбоку. Многошкальная —
 * таблицей (ниже): двадцать карточек МЛО заняли бы лист целиком.
 */
function resultCard(lang: Lang, s: ScoreView): string {
  const say = sayer(lang);
  const has = s.maxScore > 0;
  const before = s.history.slice(-2).map((h) => h.value);
  const values = [...before, s.score].map(num).join(" → ");
  const mini: [string, string][] = [];
  if (before.length) mini.push([say("print.history"), values]);
  if (has) mini.push([say("print.colPercent"), `${s.percent}%`]);
  if (s.percentile !== null) mini.push([say("print.colPercentile"), say("print.percentileN", { n: s.percentile })]);
  const svg = has ? scaleSvg(s.maxScore, s.bands, s.score, before, say("print.scaleLabel", { scale: s.title, values })) : "";
  return `<div class="ps-res"><div class="ps-big"><span class="nm">${esc(s.title)}</span><div class="v"><b>${num(s.score)}</b>${
    has ? `<span>${esc(say("print.ofMax", { max: num(s.maxScore) }))}</span>` : ""
  }</div>${s.band ? sevPill(s.band, s.step, true) : ""}</div><div>${svg}</div><dl class="ps-mini">${mini
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join("")}</dl></div>`;
}

function renderReport(lang: Lang, d: ReportData): string {
  const say = sayer(lang);
  const at = d.submittedAt ?? d.startedAt;
  const c = d.conclusion;
  const title = c
    ? say("print.titleConclusion", { survey: d.surveyTitle })
    : say("print.titleResults", { survey: d.surveyTitle });

  /* дата справа вверху — дата документа: подписи у заключения, сдачи у листа без него */
  const head = c?.signedAt
    ? { primary: printDay(c.signedAt, lang), secondary: say("print.head.signedAt", { time: printTime(c.signedAt) }) }
    : { primary: printDay(at, lang), secondary: say("print.head.takenAt", { time: printTime(at) }) };

  /* описание методики — подзаголовком, пока это строка, а не страница инструкции */
  const description = d.surveyDescription && d.surveyDescription.length <= 200 ? d.surveyDescription.trim() : "";
  const sub = [description && !/[.!?…]$/.test(description) ? `${description}.` : description, say("print.subVersion", { n: d.versionNumber })]
    .filter(Boolean)
    .join(" ");

  const factGrid = facts([
    [say("print.fact.patient"), d.patientName],
    [say("print.fact.sexAge"), d.sexAge],
    [say("print.fact.rank"), d.rank],
    [say("print.fact.unit"), d.unit],
    [say("print.fact.assessed"), assessedWhen(lang, d)],
    [say("print.fact.duration"), formatDuration(d.durationMs, lang)],
  ]);

  const single = d.scores.length === 1 ? d.scores[0]! : null;
  const scoreRows = d.scores
    .map(
      (s) => `
      <tr>
        <td>${esc(s.title)}</td>
        <td class="num">${s.maxScore > 0 ? esc(say("print.scoreOf", { raw: s.score, max: s.maxScore })) : "—"}</td>
        <td class="num">${s.maxScore > 0 ? `${s.percent}%` : "—"}</td>
        <td>${s.band ? sevPill(s.band, s.step) : "—"}</td>
        <td class="num">${s.percentile === null ? "—" : esc(say("print.percentileN", { n: s.percentile }))}</td>
      </tr>`,
    )
    .join("");
  const results = !d.scores.length
    ? ""
    : single
      ? resultCard(lang, single)
      : section(
          say("print.scoresTitle"),
          `<table class="ps-tbl mid"><thead><tr><th>${say("print.colSubscale")}</th><th class="num">${say("print.colScore")}</th><th class="num">${say("print.colPercent")}</th><th>${say("print.colInterpretation")}</th><th class="num">${say("print.colPercentile")}</th></tr></thead><tbody>${scoreRows}</tbody></table>`,
        );

  /*
   * Ответы. На странице ссылки (телефон) — первые четыре и «показать все»:
   * переключатель — флажок без скрипта; на печать идут все строки.
   */
  const fold = d.linked && d.answers.length > 6;
  const answerRows = d.answers
    .map((a, i) => {
      const cls = [a.critical ? "crit" : "", fold && i >= 4 ? "more" : ""].filter(Boolean).join(" ");
      const mark = a.critical ? `<br><span class="ck">${icon("alert", 12)}${esc(say("print.criticalAnswer"))}</span>` : "";
      return `
      <tr${cls ? ` class="${cls}"` : ""}>
        <td class="no">${i + 1}</td>
        <td>${esc(a.title)}${mark}</td>
        <td class="ans">${esc(a.value)}</td>
        <td class="num">${esc(formatDuration(a.durationMs, lang))}</td>
      </tr>`;
    })
    .join("");
  const answered = d.answers.filter((a) => a.answered).length;
  const answersTable = `<table class="ps-tbl"><thead><tr><th class="no">${say("print.colNo")}</th><th>${say("print.colQuestion")}</th><th class="ans">${say("print.colAnswer")}</th><th class="num">${say("print.colTime")}</th></tr></thead><tbody>${answerRows}</tbody></table>`;
  const answersPart = section(
    say("print.answersTitle"),
    fold
      ? `<input type="checkbox" id="lk-all" class="lk-all" aria-controls="lk-answers">${answersTable.replace("<table", '<table id="lk-answers"')}<label for="lk-all" class="lk-more">${icon("chevrons", 14)}${esc(say("print.link.showAll", { n: d.answers.length }))}</label>`
      : answersTable,
    esc(say("print.answeredOf", { n: answered, total: d.answers.length })),
  );

  const conclusionPart = c
    ? section(
        say("print.conclusionTitle"),
        `<p class="ps-text">${esc(c.text)}</p>`,
        `${icon("badge", 13)} ${esc(
          say("print.signedElectronically", { who: c.signedBy, at: c.signedAt ? printMoment(c.signedAt, lang) : "—", n: c.version }),
        )}`,
      )
    : "";

  /*
   * Место для подписи — и у подписанного в системе заключения: бумажный
   * экземпляр, который ложится в дело, всё равно подписывают рукой, и место
   * для этого предусмотрено, а не дописывается поверх текста.
   */
  const signRow = signs(
    c
      ? [
          { name: c.signedBy, caption: say("print.signature") },
          { name: c.signedAt ? printDay(c.signedAt, lang) : "", caption: say("print.signDate") },
        ]
      : [
          { name: "", caption: `${say("print.clinician")}, ${say("print.signature")}` },
          { name: "", caption: say("print.date") },
        ],
    say("print.seal"),
  );

  const sheet = `<main class="ps">
${sheetHead(head)}
<h1 class="ps-t">${esc(title)}</h1>
<p class="ps-sub">${esc(sub)}</p>
${factGrid}
${results}
${answersPart}
${conclusionPart}
<p class="ps-note">${esc(say("print.disclaimer"))}</p>
<div class="ps-end">${signRow}${sheetFoot(
    [say("print.printedBy", { who: d.printedBy, at: printMoment(d.printedAt, lang) }), say("print.secrecy")],
    d.surveyTitle,
  )}</div>
</main>`;

  const docTitle = say("print.reportTitle", { survey: d.surveyTitle });
  const running = say("print.running", { doc: title, who: d.patientName });
  if (!d.linked) return sheetDocument({ lang, title: docTitle, running, body: sheet });
  return linkPage({ lang, title: docTitle, running, sheet, side: linkSide(lang, d) });
}

/**
 * Пояснения справа на странице ссылки: что с ссылкой, как сохранить, и
 * результат простыми словами — балл из максимума, полоса, сдвиг от первого
 * замера и кто объяснит. Оценок «лучше/хуже» здесь нет: направление шкалы
 * знает специалист, и лист не решает за него.
 */
function linkSide(lang: Lang, d: ReportData): string {
  const say = sayer(lang);
  const once = panel(
    say("print.link.onceHead"),
    "link",
    `<p>${esc(say("print.link.openedAt", { time: printTime(d.printedAt) }))}</p>${printButtons(lang)}<p class="lk-small">${esc(
      say("print.link.reopen", { section: uiText("tab.surveys", lang) }),
    )}</p>`,
    "wn",
  );
  const points = d.scores
    .filter((s) => s.maxScore > 0)
    .slice(0, 4)
    .map((s) =>
      point(
        "gauge",
        `${esc(say("print.link.readScore", { scale: s.title, score: num(s.score), max: num(s.maxScore) }))}${
          s.band ? ` ${esc(say("print.link.readBand", { band: s.band }))}` : ""
        }`,
      ),
    );
  const single = d.scores.length === 1 ? d.scores[0]! : null;
  const first = single?.history[0];
  if (single && first) {
    const delta = single.score - first.value;
    points.push(
      point(
        delta < 0 ? "trendDown" : delta > 0 ? "trendUp" : "gauge",
        esc(say("print.link.readChange", { date: printDay(first.at, lang), delta: signedDelta(delta) })),
      ),
    );
  }
  points.push(
    point(
      "help",
      esc(d.conclusion ? say("print.link.notDiagnosis", { who: d.conclusion.signedBy }) : say("print.link.notDiagnosisAny")),
      "n",
    ),
  );
  return `${once}${panel(say("print.link.howToRead"), "book", `<div class="lk-li">${points.join("")}</div>`)}`;
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
      birthDate: decryptField(patient.birthDate),
      startsAt: slot!.startsAt,
      endsAt: slot!.endsAt,
      timezone: tz,
      remote: appointment.mode === "remote",
      specialistName,
      issuedBy: fullNameOf(user),
    }),
  );
});

/**
 * Разметка справки.
 *
 * Ни причины обращения, ни содержания разговора, ни НАЗВАНИЯ ОТДЕЛЕНИЯ здесь
 * нет, ни должности специалиста. Первые два очевидны; третье — нет, и первая
 * редакция его печатала: строка «психологическое отделение» сообщает тому,
 * кому справку отдадут, к кому человек ходил, — а отдают её на работу или в
 * часть. Должность («психолог») сообщила бы то же самое, поэтому в справке
 * только имя специалиста. Название учреждения в шапке остаётся: это обычный
 * уровень раскрытия, и без него документ перестаёт быть документом.
 *
 * Корешок под линией отреза остаётся в учреждении: кому, когда, кто выдал и
 * подпись получившего. Проверочного кода и QR, как на макете, нет — проверки
 * справки по коду в системе нет, а код без проверки был бы украшением.
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
    birthDate: string | null;
    startsAt: string;
    endsAt: string;
    timezone: string;
    remote: boolean;
    specialistName: string;
    issuedBy: string;
  },
): string {
  const say = sayer(lang);
  const now = new Date().toISOString();
  const date = printDay(d.startsAt, lang, d.timezone);
  const from = printTime(d.startsAt, d.timezone);
  const to = printTime(d.endsAt, d.timezone);
  const issued = printDay(now, lang, d.timezone);
  const minutes = Math.max(0, Math.round((Date.parse(d.endsAt) - Date.parse(d.startsAt)) / 60_000));
  const day = new Date(d.startsAt).toLocaleDateString(LOCALE_OF[lang], { weekday: "long", timeZone: d.timezone });
  const time = [say("print.fact.minutes", { from, to, n: minutes }), d.remote ? uiText("day.remote", lang) : null]
    .filter(Boolean)
    .join(", ");
  const born = d.birthDate ? say("print.bornOn", { date: printCalendarDay(d.birthDate, lang) }) : null;

  /* имя и дату — жирным, сама фраза — словарная: метки подставляются и заменяются после экранирования */
  const lead = esc(say("print.certBody", { name: "\u00001", unit: d.unit ? `, ${d.unit}` : "", date: "\u00002", from, to }))
    .replace("\u00001", `<b>${esc(d.fullName)}</b>`)
    .replace("\u00002", `<b>${esc(date)}</b>`);

  const stub = `<div class="ps-stub"><dl>
<dt>${esc(say("print.stubTo"))}</dt><dd>${esc([d.fullName, born].filter(Boolean).join(", "))}</dd>
<dt>${esc(say("print.stubVisit"))}</dt><dd>${esc(`${date}, ${time}`)}</dd>
<dt>${esc(say("print.clinician"))}</dt><dd>${esc(d.specialistName)}</dd>
<dt>${esc(say("print.stubIssued"))}</dt><dd>${esc(`${d.issuedBy}, ${issued}`)}</dd>
</dl>${signs([{ caption: say("print.stubReceived") }], null)}</div>`;

  const sheet = `<main class="ps">
${sheetHead({ primary: issued, secondary: say("print.head.issued") }, { unit: false })}
<h1 class="ps-t">${esc(say("print.certTitle"))}</h1>
<p class="ps-sub">${esc(say("print.certSub"))}</p>
<p class="ps-lead">${lead}</p>
${facts([
  [say("print.fact.visitDate"), `${date}, ${day}`],
  [say("print.colTime"), time],
  [say("print.clinician"), d.specialistName],
])}
<div class="ps-plain">${icon("shield", 15)}<span>${esc(say("print.certNote"))}</span></div>
<p class="ps-text" style="margin-top:16px">${esc(say("print.certPurpose"))}</p>
<div style="margin-top:40px">${signs(
    [
      { name: d.specialistName, caption: say("print.signature") },
      { name: issued, caption: say("print.head.issued") },
    ],
    say("print.seal"),
  )}</div>
<div class="ps-end">
<div class="ps-cut">${icon("scissors", 14)}<i></i><span>${esc(say("print.cutLine"))}</span><i></i></div>
${section(say("print.stubTitle"), stub, esc(say("print.stubStays")), "ps-stubsec")}
${sheetFoot([say("print.printedBy", { who: d.issuedBy, at: printMoment(now, lang, d.timezone) }), say("print.certFoot")], say("print.certTitle"))}
</div>
</main>`;

  return sheetDocument({
    lang,
    title: say("print.certTitle"),
    running: say("print.running", { doc: say("print.certTitle"), who: d.fullName }),
    body: sheet,
    bodyAttrs: 'class="fit"',
  });
}

/* ─────────── приёмы в две колонки ─────────── */

/**
 * Приёмы строками в две колонки: дата с днём недели, вид и специалист,
 * состояние знаком и словом. Колонки — многоколоночной вёрсткой, а не двумя
 * таблицами рядом: на длинной истории страница заполняется слева направо и
 * продолжается на следующей, строка не рвётся.
 */
function visitRows(
  lang: Lang,
  visits: { at: string; timezone: string; specialist: string; status: string; kind?: string | null }[],
  /** Ведущий обращения: его имя не повторяется в каждой строке, чужое — пишется */
  lead: string | null = null,
): string {
  if (!visits.length) return `<p class="ps-empty">${esc(serverText("print.noVisits", lang))}</p>`;
  return `<div class="ps-cols">${visits
    .map(
      (v) =>
        `<div class="ps-row"><span><b>${esc(printDay(v.at, lang, v.timezone))}</b> <span class="mute">${esc(weekday(v.at, lang, v.timezone))}</span></span><span>${
          v.kind ? `${esc(codeWord(lang, "visitKind", v.kind))} ` : ""
        }${v.specialist === lead ? "" : `<span class="mute">${esc(v.specialist)}</span>`}</span>${stateMark(lang, "appointment", v.status)}</div>`,
    )
    .join("")}</div>`;
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

  /* методика заключения — названием рядом с текстом: «PHQ-9, підписано 08.10» */
  const signed = await db
    .select({ row: conclusions, author: users, survey: surveys.title })
    .from(conclusions)
    .leftJoin(users, eq(users.id, conclusions.signedBy))
    .leftJoin(responses, eq(responses.id, conclusions.responseId))
    .leftJoin(surveys, eq(surveys.id, responses.surveyId))
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

  const lang = langOf(c);
  return c.html(
    episodeExtractHtml(lang, {
      fullName: fullNameOf(patient),
      unit: patient.unit,
      birthDate: decryptField(patient.birthDate),
      openedAt: episode.openedAt,
      closedAt: episode.closedAt,
      reason: decryptField(episode.reasonEnc),
      outcome: decryptField(episode.outcomeEnc),
      outcomeKind: episode.outcomeKind,
      leadName: lead ? fullNameOf(lead) : null,
      visits: visits.map((v) => ({
        at: v.slot.startsAt,
        timezone: v.timezone ?? env.institutionTz,
        specialist: fullNameOf(v.specialist),
        status: v.a.status,
        kind: v.a.kind,
      })),
      conclusions: signed.map((s) => ({
        at: s.row.signedAt ?? s.row.createdAt,
        author: s.author ? fullNameOf(s.author) : "—",
        survey: s.survey ? t(s.survey as never, lang) : null,
        text: decryptField(s.row.text) ?? "",
      })),
      referrals: sent.map((r) => ({
        at: r.createdAt,
        destination: r.destination,
        status: r.status,
      })),
      printedBy: fullNameOf(c.get("user")),
    }),
  );
});

function episodeExtractHtml(
  lang: Lang,
  d: {
    fullName: string;
    unit: string | null;
    birthDate: string | null;
    openedAt: string;
    closedAt: string | null;
    reason: string | null;
    outcome: string | null;
    outcomeKind: string | null;
    leadName: string | null;
    visits: { at: string; timezone: string; specialist: string; status: string; kind: string }[];
    conclusions: { at: string; author: string; survey: string | null; text: string }[];
    referrals: { at: string; destination: string; status: string }[];
    printedBy: string;
  },
): string {
  const say = sayer(lang);
  /* моменты — днём учреждения, приём — днём своего отделения (lib/printDates.ts), как в карте */
  const day = (iso: string) => printDay(iso, lang);
  const now = new Date().toISOString();
  const period = `${day(d.openedAt)} — ${d.closedAt ? day(d.closedAt) : say("print.ongoing")}`;
  const outcome = d.outcome ?? (d.outcomeKind ? codeWord(lang, "outcome", d.outcomeKind) : null);

  /*
   * Только подписанные. Черновик — мысль вслух, и попасть в дело он не
   * должен: подшитый черновик потом не отличить от решения.
   */
  const conclusionsPart = d.conclusions.length
    ? `<table class="ps-tbl"><tbody>${d.conclusions
        .map(
          (x) =>
            `<tr><td class="nw"><b>${esc(day(x.at))}</b></td><td class="nw">${esc(x.survey ?? "—")}</td><td><span class="ps-text">${esc(x.text)}</span> <span class="mute">${esc(
              say("print.signedOn", { who: x.author, date: day(x.at) }),
            )}</span></td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="ps-empty">${esc(say("print.noConclusions"))}</p>`;

  const referralsPart = d.referrals.length
    ? section(
        say("print.referralsTitle"),
        `<table class="ps-tbl"><tbody>${d.referrals
          .map(
            (r) =>
              `<tr><td class="nw"><b>${esc(day(r.at))}</b></td><td>${esc(codeWord(lang, "destination", r.destination))}</td><td class="num">${stateMark(lang, "referralStatus", r.status)}</td></tr>`,
          )
          .join("")}</tbody></table>`,
      )
    : "";
  const outcomePart = outcome ? section(say("print.outcomeTitle"), `<p class="ps-text">${esc(outcome)}</p>`) : "";

  const sheet = `<main class="ps">
${sheetHead({ primary: day(now), secondary: say("print.head.asOf", { time: printTime(now) }) })}
<h1 class="ps-t">${esc(say("print.extractTitle"))}</h1>
<p class="ps-sub">${esc(say("print.extractSub", { date: day(d.openedAt) }))}</p>
${facts([
  [say("print.fact.patient"), d.fullName],
  [say("print.fact.born"), d.birthDate ? say("print.bornOn", { date: printCalendarDay(d.birthDate, lang) }) : null],
  [say("print.fact.unit"), d.unit],
  [say("print.fact.episode"), period],
  [say("print.colLead"), d.leadName],
])}
${d.reason ? section(say("print.reasonTitle"), `<p class="ps-text">${esc(d.reason)}</p>`) : ""}
${section(say("print.visitsTitle"), visitRows(lang, d.visits, d.leadName), esc(say("print.total", { n: d.visits.length })))}
${section(say("print.conclusionsTitle"), conclusionsPart, d.conclusions.length ? String(d.conclusions.length) : "")}
${referralsPart || outcomePart ? `<div class="ps-two">${referralsPart}${outcomePart}</div>` : ""}
<div class="ps-end">${signs(
    [
      { name: d.leadName ?? "", caption: say("print.signature") },
      { name: "", caption: say("print.date") },
    ],
    say("print.seal"),
  )}${sheetFoot([say("print.printedBy", { who: d.printedBy, at: printMoment(now, lang) }), say("print.secrecy")], say("print.extractTitle"))}</div>
</main>`;

  return sheetDocument({
    lang,
    title: say("print.extractTitle"),
    running: say("print.running", { doc: say("print.extractTitle"), who: d.fullName }),
    body: sheet,
  });
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
      printedBy: fullNameOf(c.get("user")),
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
    printedBy: string;
  },
): string {
  const say = sayer(lang);
  /*
   * Моменты — днём учреждения, приём — днём своего отделения, рождение — как
   * записано (lib/printDates.ts). Прежде всё шло через toLocaleDateString без
   * пояса, то есть по часам процесса (волна 15, внешний разбор, п. 21).
   */
  const day = (iso: string) => printDay(iso, lang);
  const now = new Date().toISOString();
  const empty = (key: ServerTextKey) => `<p class="ps-empty">${esc(say(key))}</p>`;

  const episodesPart = d.episodes.length
    ? `<table class="ps-tbl"><thead><tr><th>${say("print.colPeriod")}</th><th>${say("print.colReason")}</th><th>${say("print.colLead")}</th><th>${say("print.outcomeTitle")}</th></tr></thead><tbody>${d.episodes
        .map(
          (e) =>
            `<tr><td class="nw">${esc(day(e.openedAt))} — ${e.closedAt ? esc(day(e.closedAt)) : say("print.ongoing")}</td>` +
            `<td>${esc(e.reason ?? "—")}</td><td class="nw">${esc(e.lead ?? "—")}</td>` +
            `<td>${esc(e.outcome ?? codeWord(lang, "outcome", e.outcomeKind))}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : empty("print.noEpisodes");

  /*
   * Источник прохождения печатается рядом: «сам» и «за призначенням» — это
   * разные сведения о человеке, и в карте они значат разное.
   */
  const responsesPart = d.responses.length
    ? `<table class="ps-tbl"><thead><tr><th>${say("print.date")}</th><th>${say("print.colAssessment")}</th><th>${say("print.colSource")}</th></tr></thead><tbody>${d.responses
        .map(
          (r) =>
            `<tr><td class="nw"><b>${esc(day(r.at))}</b></td><td>${esc(r.title)}</td><td class="t2">${esc(codeWord(lang, "source", r.source))}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : empty("print.noAssessments");

  /*
   * Только подписанные. Черновик — рабочий текст, и в карте, которую
   * подшивают, он неотличим от решения.
   */
  const notesPart = d.notes.length
    ? `<table class="ps-tbl"><tbody>${d.notes
        .map(
          (n) =>
            `<tr><td class="nw"><b>${esc(day(n.at))}</b><br><span class="mute">${esc(codeWord(lang, "noteKind", n.kind))}</span></td><td><span class="ps-text">${esc(n.text)}</span> <span class="mute">— ${esc(n.author)}</span></td></tr>`,
        )
        .join("")}</tbody></table>`
    : empty("print.noNotes");

  const sheet = `<main class="ps">
${sheetHead({ primary: day(now), secondary: say("print.head.asOf", { time: printTime(now) }) })}
<h1 class="ps-t">${esc(say("print.chartTitle"))}</h1>
<p class="ps-sub">${esc(say("print.chartSub"))}</p>
${facts(
  [
    [say("print.fact.patient"), d.fullName],
    [say("print.fact.born"), d.birthDate ? say("print.bornOn", { date: printCalendarDay(d.birthDate, lang) }) : null],
    [say("print.fact.rank"), d.rank],
    [say("print.fact.unit"), d.unit],
  ],
  2,
)}
${section(say("print.episodesTitle"), episodesPart, d.episodes.length ? String(d.episodes.length) : "")}
${section(say("print.visitsTitle"), visitRows(lang, d.visits), esc(say("print.total", { n: d.visits.length })))}
${section(say("print.assessmentsTitle"), responsesPart, esc(say("print.total", { n: d.responses.length })))}
${section(say("print.notesTitle"), notesPart, esc(say("print.signedOnly")))}
<div class="ps-end">${signs(
    [
      { name: d.printedBy, caption: say("print.signature") },
      { name: day(now), caption: say("print.date") },
    ],
    say("print.seal"),
  )}${sheetFoot([say("print.printedBy", { who: d.printedBy, at: printMoment(now, lang) }), say("print.secrecy")], say("print.chartTitle"))}</div>
</main>`;

  return sheetDocument({
    lang,
    title: `${say("print.chartTitle")} — ${d.fullName}`,
    running: say("print.running", { doc: say("print.chartTitle"), who: d.fullName }),
    body: sheet,
  });
}
