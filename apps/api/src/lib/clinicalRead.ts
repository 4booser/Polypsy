import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { Permission, User } from "@quizzy/shared";
import { db } from "../db";
import { responses, riskAlerts } from "../db/schema";
import { audit } from "./audit";
import { badRequest, forbidden, notFound } from "./http";
import { hasPermission } from "./permissions";
import { canAccessSurvey, isStaff } from "./scope";

/**
 * Право, которым закрыто чтение клинических данных чужого человека.
 *
 * То самое, что закрывает список прохождений методики и заключение
 * (requirePermission на маршрутах): здесь оно названо один раз, чтобы
 * проверка ниже и строки requirePermission не могли разойтись в том,
 * какое право что значит.
 */
export const CLINICAL_READ: Permission = "patients.read";

/** Что проверке нужно знать о прохождении: чьё оно и какой методики */
export interface ResponseRef {
  id: string;
  userId: string | null;
  surveyId: string;
}

/**
 * Сотрудник читает клинические данные по прохождению — или отказ.
 *
 * Одна проверка на все представления одного прохождения: заключение и его
 * черновик (routes/conclusions.ts), прохождение по id (routes/responses.ts),
 * печатный лист, выдача одноразовой ссылки на него и открытие этой ссылки
 * (routes/reports.ts). Волна 15, внешний разбор, P1: у сотрудника личным
 * исключением отняли patients.read — список прохождений и заключение
 * отвечали 403, а то же прохождение по известному id, лист с ФИО и
 * подписанным заключением и ссылка на лист — 200. Каждый вход проверял роль
 * и зону методики по-своему, и право читать данные пациента не проверял ни
 * один: запрет, которым учреждение закрывает человеку карты, обходился
 * печатью. Правило одно — и функция одна, чтобы следующий вход не проверял
 * «почти то же самое».
 *
 * Три условия, все обязательны и именно в этом порядке:
 *  1. Сотрудник. Обследуемый чужое не читает ни при каком праве.
 *  2. Право CLINICAL_READ — с личными исключениями (lib/permissions.ts):
 *     отнятое исключением действует со следующего запроса, как у
 *     requirePermission. Отказ — тем же текстом «нужно patients.read» и той
 *     же строкой журнала access.denied: для читающего журнал и экран это
 *     один и тот же запрет, каким бы входом в него ни упёрлись.
 *  3. Методика в зоне ответственности (canAccessSurvey). Отказ — «не
 *     найдено», а не «нельзя»: так отвечали заключения и печать, и так же
 *     в бою отвечает политика строк, которая чужое прохождение прячет, — 403
 *     подтверждал бы, что у человека такое прохождение есть.
 *
 * Своё прохождение сюда не приходит — оно отдельным условием в
 * assertResponseRead ниже: это не чтение чужих клинических данных, и право
 * на чужие для него ни при чём.
 */
export async function assertClinicalRead(c: Context, user: User, response: ResponseRef): Promise<void> {
  await assertClinicalRecordRead(c, user, { ...response, kind: "response" });
}

/** Что проверке нужно знать о тревоге: чья она и по какой методике */
export interface AlertRef {
  id: string;
  userId: string | null;
  surveyId: string;
}

/**
 * Тревога — тем же правилом, что прохождение, из которого она поднята
 * (волна 16). Зона тревоги — зона методики: так её режет список тревог
 * (routes/alerts.ts, surveyScopeFilter) и политика строк risk_alerts. Отказ
 * «не найдено» — своим словом: читающий журнал должен видеть, во что
 * упёрлись, а экран — что именно не нашлось.
 */
export async function assertAlertRead(c: Context, user: User, alert: AlertRef): Promise<void> {
  await assertClinicalRecordRead(c, user, { ...alert, kind: "alert" });
}

async function assertClinicalRecordRead(
  c: Context,
  user: User,
  record: ResponseRef & { kind: "response" | "alert" },
): Promise<void> {
  if (!isStaff(user)) forbidden("err.responseOwnerOrStaffOnly");
  if (!(await hasPermission(user, CLINICAL_READ))) {
    await audit(c, {
      action: "access.denied",
      outcome: "denied",
      resourceType: record.kind,
      resourceId: record.id,
      subjectUserId: record.userId,
      details: { method: c.req.method, reason: "permission_required", permission: CLINICAL_READ },
    });
    forbidden("err.permissionRequired", { permission: CLINICAL_READ });
  }
  if (!(await canAccessSurvey(user, record.surveyId))) {
    notFound(record.kind === "alert" ? "err.alertNotFound" : "err.responseNotFound");
  }
}

/**
 * Ссылки направления — на записи того же пациента, доступные сотруднику и
 * согласованные между собой (волна 16, внешний разбор, P2).
 *
 * POST /referrals проверял пациента и доступ к нему, а responseId и alertId
 * переносил в строку как есть. Внешние ключи подтверждали лишь, что записи
 * существуют: направление пациента A заводилось с прохождением и тревогой
 * пациента B — из группы методик, в которую сотруднику и заглянуть нельзя
 * (GET /responses/:id отвечал ему 404). Клиническая связь при этом вполне
 * настоящая: adoptDraftAlerts переносит такую ссылку на итоговую сдачу B, а
 * карта A показывает направление «по прохождению», которого у A не было.
 *
 * Три условия на каждую ссылку, в этом порядке:
 *  1. Доступность — той же проверкой, что открывает саму запись
 *     (assertResponseRead / assertAlertRead): недоступное — «не найдено»,
 *     как при прямом чтении, и несуществующее — тоже оно, а не пятисотка
 *     внешнего ключа, по которой можно было перебирать идентификаторы.
 *  2. Владелец — тот же пациент, что у направления. Доступная, но чужая
 *     запись — 400 с причиной: запрос собран неверно, и сотруднику надо
 *     понять, какая из ссылок не сходится.
 *  3. Согласованность — тревога от указанного прохождения, если названы обе.
 *
 * Проверяется до вставки, а не ограничением базы: составного ключа
 * (пациент, прохождение) у responses нет, а тревога без пациента (user_id
 * NULL у анонимных) на направление и не годится.
 */
export async function assertReferralLinks(
  c: Context,
  user: User,
  link: { userId: string; responseId?: string | null; alertId?: string | null },
): Promise<void> {
  if (link.responseId) {
    const response = await db.query.responses.findFirst({
      where: eq(responses.id, link.responseId),
      columns: { id: true, userId: true, surveyId: true },
    });
    if (!response) notFound("err.responseNotFound");
    await assertResponseRead(c, user, response);
    if (response.userId !== link.userId) badRequest("err.referralResponseOtherPatient");
  }
  if (link.alertId) {
    const alert = await db.query.riskAlerts.findFirst({
      where: eq(riskAlerts.id, link.alertId),
      columns: { id: true, userId: true, surveyId: true, responseId: true },
    });
    if (!alert) notFound("err.alertNotFound");
    await assertAlertRead(c, user, alert);
    if (alert.userId !== link.userId) badRequest("err.referralAlertOtherPatient");
    if (link.responseId && alert.responseId !== link.responseId) badRequest("err.referralAlertOtherResponse");
  }
}

/**
 * Кто открывает прохождение: сам обследуемый или сотрудник по правилу выше.
 *
 * Своё — отдельным условием и первым: пациент открывает и печатает своё
 * прохождение без всяких прав (кабинет, мобилка по одноразовой ссылке), а
 * сотрудник, прошедший методику на себя, читает своё, даже если данные
 * пациентов ему закрыты. Всё остальное — assertClinicalRead.
 *
 * Возвращает основание: вызывающему оно нужно — пациенту, например, лист
 * закрыт ещё и выключенным показом результатов.
 */
export async function assertResponseRead(c: Context, user: User, response: ResponseRef): Promise<"own" | "staff"> {
  if (response.userId !== null && response.userId === user.id) return "own";
  await assertClinicalRead(c, user, response);
  return "staff";
}
