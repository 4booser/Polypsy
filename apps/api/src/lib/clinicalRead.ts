import type { Context } from "hono";
import type { Permission, User } from "@quizzy/shared";
import { audit } from "./audit";
import { forbidden, notFound } from "./http";
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
  if (!isStaff(user)) forbidden("err.responseOwnerOrStaffOnly");
  if (!(await hasPermission(user, CLINICAL_READ))) {
    await audit(c, {
      action: "access.denied",
      outcome: "denied",
      resourceType: "response",
      resourceId: response.id,
      subjectUserId: response.userId,
      details: { method: c.req.method, reason: "permission_required", permission: CLINICAL_READ },
    });
    forbidden("err.permissionRequired", { permission: CLINICAL_READ });
  }
  if (!(await canAccessSurvey(user, response.surveyId))) notFound("err.responseNotFound");
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
