import { Hono } from "hono";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  ageAt,
  createReferralSchema,
  referralListQuery,
  t,
  updateReferralSchema,
  type CaseSummary,
  type Page,
  type Referral,
  type ScaleNormalization,
  type Severity,
  type Sex,
} from "@quizzy/shared";
import { db } from "../db";
import {
  conclusions,
  referrals,
  responseScores,
  responses,
  riskAlerts,
  scales,
  surveyVersions,
  surveys,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { afterCursor, decodeExactCursor, encodeCursor, exactAt } from "../lib/cursor";
import { fullNameOf } from "../lib/auth";
import { alphasOf, changeOverSeries, normativeSamples } from "../lib/changeBasis";
import { decryptField } from "../lib/crypto";
import { badRequest, conflict, langOf, notFound, parseBody, parseQuery } from "../lib/http";
import { round } from "../lib/stats";
import { accessiblePatientIds, assertPatientAccess, surveyScopeFilterFor } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const referralRoutes = new Hono<AppEnv>();

/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 *
 * Сегодня разницы в поведении нет — встроенная роль есть у каждого
 * администратора, — и это ровно то, чего мы хотим от перехода.
 */
referralRoutes.use("*", requireAuth, requireStaff, requirePermission("referrals.manage"));

/** Статусы движутся вперёд: принятое направление нельзя «отменить» задним числом */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  created: ["accepted", "declined"],
  accepted: ["completed", "declined"],
  completed: [],
  declined: [],
};

async function serialize(rows: (typeof referrals.$inferSelect)[]): Promise<Referral[]> {
  if (!rows.length) return [];
  const ids = [...new Set([...rows.map((r) => r.userId), ...rows.map((r) => r.createdBy)])];
  const people = await db.select().from(users).where(inArray(users.id, ids));
  const nameOf = new Map(people.map((u) => [u.id, fullNameOf(u)]));
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    userName: nameOf.get(r.userId) ?? "—",
    responseId: r.responseId,
    alertId: r.alertId,
    destination: r.destination,
    urgency: r.urgency,
    status: r.status,
    reason: r.reason,
    outcomeNote: r.outcomeNote,
    createdByName: nameOf.get(r.createdBy) ?? "—",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Реестр направлений: свежие сверху, страницами (`?limit=&cursor=`).
 *
 * Признак усечения — то, ради чего список отдаётся объектом, а не массивом:
 * двести первое направление когда-то просто исчезало, и экран выглядел
 * полным. Потом про обрыв стали говорить (`truncated`), но дальше двухсотого
 * всё равно было не пройти: экран советовал «сузить выборку» переключателем,
 * который её расширяет, а незакрытых направлений может быть и больше двухсот.
 * Теперь за страницей есть курсор, и экран дозагружает следующую.
 *
 * Общее число — на первой странице, как у очереди случаев: по нему стоит
 * счётчик в навигации, и считать его длиной страницы значило бы показать
 * «100», когда ждут ответа сто сорок.
 */
referralRoutes.get("/", async (c) => {
  const { all, limit, cursor: rawCursor } = parseQuery(c, referralListQuery);
  const cursor = decodeExactCursor(rawCursor);
  /*
   * Только люди своей зоны (волна 13, проверка под ролью приложения).
   * Реестр не спрашивал зону вовсе: в бою его резала политика строк, а
   * сюита, ходящая владельцем, видела у администратора чужой группы все
   * направления отделения — и считала это нормой. Правило видимости одно,
   * и живёт оно в lib/scope.ts; политика — страховка под ним, а не замена.
   */
  const zone = await accessiblePatientIds(c.get("user"));
  const filter = and(
    all ? undefined : ne(referrals.status, "completed"),
    zone === null ? undefined : zone.size ? inArray(referrals.userId, [...zone]) : sql`false`,
  );

  const rows = await db
    .select({ r: referrals, at: exactAt(referrals.createdAt) })
    .from(referrals)
    .where(and(filter, afterCursor(referrals.createdAt, referrals.id, cursor)))
    /* идентификатор вторым ключом: направления одной вставки делят одно время */
    .orderBy(desc(referrals.createdAt), desc(referrals.id))
    .limit(limit + 1);

  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);

  let total: number | undefined;
  if (!cursor) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(referrals).where(filter);
    total = Number(row?.n ?? 0);
  }

  await audit(c, {
    action: "referral.list",
    details: { count: page.length, all, truncated, ...(cursor ? { page: "next" } : {}) },
  });

  const last = page[page.length - 1];
  return c.json({
    items: await serialize(page.map((p) => p.r)),
    nextCursor: truncated && last ? encodeCursor(last.at, last.r.id) : null,
    truncated,
    total,
  } satisfies Page<Referral>);
});

referralRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, createReferralSchema);

  const target = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!target) notFound("err.patientNotFound");
  if (target.role !== "user") badRequest("err.referralPatientOnly");
  /*
   * Направить можно только своего пациента. Проверки не было: владельцем
   * базы направление на чужого человека заводилось (201, строка в чужой
   * зоне), а в бою политика строк отвергала вставку, и сотрудник получал
   * пятисотку «внутренняя ошибка» вместо ответа (найдено прогоном под ролью
   * приложения, волна 13). Ответ — «не найдено», как везде, где человек вне
   * зоны: 403 подтвердил бы, что такой пациент есть.
   */
  await assertPatientAccess(user, input.userId);

  const id = crypto.randomUUID();
  await db.insert(referrals).values({
    id,
    userId: input.userId,
    responseId: input.responseId ?? null,
    alertId: input.alertId ?? null,
    destination: input.destination,
    urgency: input.urgency ?? "routine",
    reason: input.reason ?? null,
    createdBy: user.id,
  });

  await audit(c, {
    action: "referral.create",
    resourceType: "referral",
    resourceId: id,
    subjectUserId: input.userId,
    details: { destination: input.destination, urgency: input.urgency ?? "routine" },
  });
  const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
  return c.json((await serialize([row!]))[0], 201);
});

referralRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await db.query.referrals.findFirst({ where: eq(referrals.id, id) });
  if (!existing) notFound("err.referralNotFound");
  /* чужое направление — то же «не найдено», что даёт в бою политика строк */
  const zone = await accessiblePatientIds(c.get("user"));
  if (zone && !zone.has(existing.userId)) notFound("err.referralNotFound");

  const input = await parseBody(c.req.raw, updateReferralSchema);
  if (!ALLOWED_TRANSITIONS[existing.status]?.includes(input.status)) {
    badRequest("err.referralTransitionInvalid", { from: existing.status, to: input.status });
  }

  /*
   * Переход — одним условием с записью (внешний разбор 2026-09-27, п. 4).
   *
   * Разрешённость решалась по прочитанному статусу, а UPDATE искал строку
   * только по id. Два одновременных PATCH из «створено» — «відхилити» и
   * «прийняти» — оба проходили проверку, оба записывали, оба получали 200, и
   * направление, которое только что отклонили, оказывалось принятым: второй
   * запрос решал по состоянию, которого уже не было.
   *
   * Теперь UPDATE записывает, только если статус всё ещё тот, по которому
   * решали. Второй запрос ждёт замка строки, после чужого коммита видит
   * новый статус, не находит строки и получает 409 — даже если его переход
   * из нового состояния формально разрешён: человек нажимал кнопку, глядя
   * на прежнее состояние, и решать за него по новому нельзя. Экран на 409
   * перечитывает реестр.
   */
  const [moved] = await db
    .update(referrals)
    .set({
      status: input.status,
      outcomeNote: input.outcomeNote ?? existing.outcomeNote,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(referrals.id, id), eq(referrals.status, existing.status)))
    .returning({ id: referrals.id });
  if (!moved) conflict("err.referralChanged");

  await audit(c, {
    action: "referral.update",
    resourceType: "referral",
    resourceId: id,
    subjectUserId: existing.userId,
    details: { from: existing.status, to: input.status },
  });
  const [row] = await db.select().from(referrals).where(eq(referrals.id, id));
  return c.json((await serialize([row!]))[0]);
});

/**
 * Сводка для консилиума (6.5).
 *
 * Всё о пациенте на одной странице: последние баллы с достоверностью сдвига,
 * открытые тревоги, подписанные заключения, направления. Собирается из уже
 * существующих кусков — новизна здесь не в данных, а в том, что их не надо
 * собирать по семи экранам за минуту до заседания.
 */
referralRoutes.get("/summary/:userId", async (c) => {
  // язык читателя: t() без него отдаёт украинский всегда
  const lang = langOf(c);
  const staff = c.get("user");
  const userId = c.req.param("userId");

  const patient = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!patient) notFound("err.patientNotFound");

  /*
   * Пациент должен быть в зоне ответственности сотрудника. Раньше здесь
   * стояла только проверка «есть ли у сотрудника хоть одна методика», и
   * админ чужой группы получал 200 с пустой сводкой на любой существующий
   * идентификатор — то есть маршрут отвечал на вопрос «есть ли такой
   * пациент», который задавать ему никто не разрешал.
   */
  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(userId)) notFound("err.patientNotFound");

  const scope = await surveyScopeFilterFor(staff, userId);
  const scoped = await db.select().from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) notFound("err.patientNotFound");

  const own = await db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.userId, userId),
        eq(responses.status, "completed"),
        inArray(responses.surveyId, surveyIds),
      ),
    )
    .orderBy(responses.submittedAt);

  const scoreRows = own.length
    ? await db
        .select({ score: responseScores, code: scales.code, title: scales.title, kind: scales.kind })
        .from(responseScores)
        .innerJoin(scales, eq(scales.id, responseScores.scaleId))
        .where(inArray(responseScores.responseId, own.map((r) => r.id)))
    : [];

  /*
   * Выборка для SD — по всем прохождениям методики, а не по замерам самого
   * пациента.
   *
   * Раньше SD считалась по тем же двум точкам, между которыми меряется
   * изменение. Арифметика такого расчёта вырождается: при двух значениях
   * sd = |Δ|/√2, и RCI выходит ровно ±2.24 всегда — для любой шкалы, любого
   * человека и любого сдвига. На экране это выглядело как уверенное
   * «достоверное возрастание» у каждой строки подряд, то есть как настоящий
   * клинический вывод, которым не являлось.
   *
   * И выборка, и надёжность, и правило сравнимости — те же, что в динамике
   * (lib/changeBasis.ts). Прежде сводка брала выборку по всем версиям и
   * нормировкам сразу, надёжность — константой 0,8, и сравнивала любые
   * версии: один и тот же человек выглядел «достоверно улучшившимся» на
   * консилиуме и «в пределах ошибки» в карте.
   */
  const ownSurveyIds = [...new Set(own.map((r) => r.surveyId))];
  const samples = await normativeSamples(ownSurveyIds);
  const alphas = await alphasOf(
    own
      .filter((r): r is typeof r & { versionId: string } => !!r.versionId)
      .map((r) => ({ surveyId: r.surveyId, versionId: r.versionId })),
  );
  const ownVersionIds = [...new Set(own.map((r) => r.versionId).filter((v): v is string => !!v))];
  const versionNoById = new Map(
    ownVersionIds.length
      ? (
          await db
            .select({ id: surveyVersions.id, version: surveyVersions.version })
            .from(surveyVersions)
            .where(inArray(surveyVersions.id, ownVersionIds))
        ).map((v) => [v.id, v.version] as const)
      : [],
  );

  const bySurvey = new Map<string, typeof own>();
  for (const r of own) {
    const list = bySurvey.get(r.surveyId) ?? [];
    list.push(r);
    bySurvey.set(r.surveyId, list);
  }

  const summarySurveys: CaseSummary["surveys"] = [...bySurvey.entries()].map(([surveyId, list]) => {
    const survey = scoped.find((s) => s.id === surveyId)!;
    const responseById = new Map(list.map((r) => [r.id, r]));
    const own2 = scoreRows.filter((s) => responseById.has(s.score.responseId) && s.kind === "clinical");

    const byCode = new Map<string, typeof own2>();
    for (const s of own2) {
      const arr = byCode.get(s.code) ?? [];
      arr.push(s);
      byCode.set(s.code, arr);
    }

    return {
      surveyId,
      title: t(survey.title as never, lang),
      lastAt: list[list.length - 1]?.submittedAt ?? null,
      count: list.length,
      scales: [...byCode.entries()].map(([code, rows]) => {
        // порядок замеров — по времени сдачи
        const ordered = rows
          .map((r) => ({ ...r, response: responseById.get(r.score.responseId)! }))
          .sort((a, b) => (a.response.submittedAt ?? "").localeCompare(b.response.submittedAt ?? ""));
        const last = ordered[ordered.length - 1]!;

        /*
         * RCI и причина, если его нет, — тем же правилом, что в динамике:
         * одна версия или приведение, одни единицы, оба протокола
         * достоверны; SD — по выборке версии и нормировки последнего замера
         * не меньше MIN_RCI_SAMPLE, альфа — фактическая альфа этой версии.
         * Лучше показать «недостаточно данных», чем вывод, которого нет.
         */
        const change = changeOverSeries(
          ordered.map((r) => ({
            value: r.score.value,
            versionId: r.response.versionId ?? null,
            versionNo: versionNoById.get(r.response.versionId ?? "") ?? null,
            normalized: r.score.normalized,
            normalization: r.score.normalization,
            reliable: r.response.reliable,
          })),
          { surveyId, code, samples, alphas },
        );
        const rc = change.reliableChange;

        return {
          code,
          title: t(last.title as never, lang),
          lastValue: round(last.score.value, 2),
          normalization: last.score.normalization as ScaleNormalization,
          bandLabel: last.score.bandLabel,
          severity: last.score.severity as Severity | null,
          reliableChange: rc ? { rci: rc.rci, significant: rc.significant, direction: rc.direction } : null,
          incomparable: change.incomparable,
        };
      }),
    };
  });

  const alertRows = await db
    .select({ alert: riskAlerts, surveyTitle: surveys.title })
    .from(riskAlerts)
    .innerJoin(surveys, eq(surveys.id, riskAlerts.surveyId))
    .where(and(eq(riskAlerts.userId, userId), inArray(riskAlerts.surveyId, surveyIds)))
    .orderBy(desc(riskAlerts.at))
    .limit(20);

  const conclusionRows = own.length
    ? await db
        .select({ row: conclusions, author: users, surveyId: responses.surveyId })
        .from(conclusions)
        .innerJoin(responses, eq(responses.id, conclusions.responseId))
        .leftJoin(users, eq(users.id, conclusions.signedBy))
        .where(
          and(
            inArray(conclusions.responseId, own.map((r) => r.id)),
            eq(conclusions.status, "signed"),
          ),
        )
        .orderBy(desc(conclusions.version))
    : [];

  const referralRows = await db
    .select()
    .from(referrals)
    .where(eq(referrals.userId, userId))
    .orderBy(desc(referrals.createdAt));

  const summary: CaseSummary = {
    userId,
    fullName: fullNameOf(patient),
    sex: patient.sex as Sex | null,
    age: ageAt(decryptField(patient.birthDate), new Date().toISOString()),
    unit: patient.unit,
    surveys: summarySurveys,
    openAlerts: alertRows
      .filter((a) => !a.alert.acknowledgedAt)
      .map((a) => ({
        id: a.alert.id,
        label: a.alert.label,
        severity: a.alert.severity,
        at: a.alert.at,
        surveyTitle: t(a.surveyTitle as never, lang),
      })),
    conclusions: conclusionRows.map((c2) => ({
      responseId: c2.row.responseId,
      surveyTitle: t(scoped.find((s) => s.id === c2.surveyId)?.title as never, lang),
      text: decryptField(c2.row.text) ?? "",
      signedAt: c2.row.signedAt,
      authorName: c2.author ? fullNameOf(c2.author) : "—",
    })),
    referrals: await serialize(referralRows),
  };

  // сводка — доступ ко всей карте пациента разом, самое чувствительное чтение
  await audit(c, {
    action: "response.read",
    resourceType: "respondent",
    resourceId: userId,
    subjectUserId: userId,
    details: { view: "case_summary", surveys: summary.surveys.length },
  });

  return c.json(summary);
});
