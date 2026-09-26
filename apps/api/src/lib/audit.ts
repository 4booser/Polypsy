import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { auditLog } from "../db/schema";
import type { User } from "@quizzy/shared";
import { currentRequestId, log } from "./log";
import { publish } from "./events";

/**
 * Действия журнала. Строковый союз, чтобы опечатка ловилась типами.
 *
 * Здесь ровно то, что код умеет записать, и ничего сверх. Тридцать одно имя
 * пережило свои возможности — киоск, консилиум, цели лечения, маршруты
 * помощи, отчёт по подразделению, дежурство, сравнение и калибровка, — и
 * лежало здесь после того, как маршруты, которые их писали, исчезли.
 * Мёртвое имя в этом союзе хуже, чем просто мусор: по нему ищут в журнале и
 * делают вывод «такого не случалось», хотя правильный вывод — «такого не
 * бывает».
 */
export type AuditAction =
  /* вход через Google: связывание — это выдача второго ключа от учётной
     записи, и оно обязано быть видно в журнале так же, как смена пароля */
  | "auth.google_linked"
  | "auth.google_unlinked"
  | "auth.google_denied"
  /* поликлиника: каждый переход приёма — событие журнала */
  | "clinic.department_create"
  | "clinic.department_update"
  | "clinic.specialist_profile"
  | "clinic.schedule_update"
  | "clinic.schedule_exception"
  | "clinic.schedule_exception_delete"
  | "clinic.book"
  | "clinic.today"
  | "clinic.confirm"
  | "clinic.reschedule"
  | "clinic.cancel"
  | "clinic.status"
  | "clinic.visit_open"
  | "clinic.phone_view"
  | "account.reveal"
  | "message.send"
  | "episode.open"
  | "episode.close"
  | "episode.attach"
  | "dispensary.set"
  | "dispensary.seen"
  | "dispensary.remove"
  | "recording.consent"
  | "recording.consent_revoke"
  | "recording.start"
  | "recording.stop"
  | "recording.discard"
  | "template.create"
  | "report.visit_certificate"
  | "report.episode_extract"
  | "report.patient_chart"
  | "clinic.lead_take"
  | "clinic.lead_release"
  /* права: кто кому что выдал — разбирается по журналу, а не по памяти */
  | "role.create"
  | "role.update"
  | "user.roles_change"
  | "permission.exception"
  | "permission.exception_revoke"
  | "conclusion.batch"
  | "quality.read"
  | "search.notes"
  | "cohort.preview"
  | "cohort.members"
  | "cohort.save"
  | "cohort.update"
  | "cohort.delete"
  /*
   * Раздел «Статистика»: пресеты фильтров и модели. Имена с filter_preset
   * и stat_model, чтобы в журнале не смешивались с cohort.* — контур
   * другой: когорта отдаёт людей поимённо, статистика — только доли.
   * Расчёт (stat_model.run) пишется как cohort.preview: это доступ к
   * агрегатам по людям с размером каждой выборки в подробностях, и подбор
   * фильтров, пока выборка не сожмётся до одного, должен быть виден.
   */
  | "filter_preset.create"
  | "filter_preset.update"
  | "filter_preset.delete"
  | "stat_model.create"
  | "stat_model.update"
  | "stat_model.delete"
  | "stat_model.run"
  | "device.wipe_requested"
  | "device.wiped"
  | "rule.hit"
  | "rule.decide"
  | "rule.save"
  | "auth.login"
  | "auth.login_failed"
  | "auth.password_change"
  | "auth.refresh_failed"
  | "auth.register"
  | "user.create"
  | "user.role_change"
  | "user.list"
  /*
   * Техпанель, учётные записи (волна 10). Каждое действие над чужой
   * учёткой — своим именем: «кто выключил», «кто сбросил пароль» и «кто
   * пытался удалить» ищут по журналу разными вопросами, и одно общее
   * user.update с пометкой в details отвечало бы на них подстрокой.
   */
  | "user.disable"
  | "user.enable"
  | "user.delete"
  | "user.password_reset"
  | "user.sessions_revoke"
  | "session.list"
  | "session.revoke"
  /* выгрузка журнала — сама строка журнала: журнал уезжает за пределы системы */
  | "audit.export"
  /*
   * Люди и безопасность (волна 10, участок people2).
   *
   * Вход «от имени»: начало и конец — своими именами, а каждый просмотр под
   * ним — impersonation.view (склеенный по пять минут, lib/impersonation.ts).
   * Второй фактор: включение, выключение и чужой сброс ищут разными
   * вопросами. Вход, ждущий кода, — auth.mfa_challenge; неверный код пишется
   * как auth.login_failed (с причиной mfa_*) — для счётчика неудачных входов
   * и правил подозрительной активности это одна и та же неудача.
   */
  | "impersonation.start"
  | "impersonation.end"
  | "impersonation.view"
  | "auth.mfa_challenge"
  | "mfa.setup"
  | "mfa.enable"
  | "mfa.disable"
  | "mfa.reset"
  | "security.policy_update"
  | "suspicious.read"
  | "suspicious.resolve"
  | "suspicious.scan"
  | "permission.exception_list"
  | "permission.exception_extend"
  /* массовое действие — сводкой; каждая затронутая учётка пишется ещё и своей строкой */
  | "user.bulk"
  | "user.import"
  /* отчёт «хто переглядав картку» — сам отчёт тоже чтение о пациенте */
  | "audit.subject_report"
  | "profile.update"
  | "survey.create"
  | "survey.catalog_update"
  /* установка общего каталога: заводит отделение по умолчанию */
  | "department.create"
  /* командная консоль: вызов команды пишется до выполнения */
  | "console.run"
  /*
   * Техпанель, эксплуатация (волна 10, участок maint). Включение и
   * выключение обслуживания — своими именами, а не ops.status_set с
   * пометкой: «кто закрыл запись в пятницу вечером» ищут подстрокой, и
   * ответ обязан найтись без разбора details. Чтение имён в аудиториях
   * флагов — данные о людях, пусть и о сотрудниках, поэтому тоже строка.
   */
  | "ops.maintenance_on"
  | "ops.maintenance_off"
  | "ops.status_set"
  | "ops.flag_set"
  | "ops.flags_read"
  | "ops.flag_audience_read"
  | "ops.release_rollback"
  /*
   * Техпанель, участок безопасности (routes/opsSec.ts). Префикс sec — чтобы
   * разбирающий журнал одной подстрокой собрал всё, что делалось с ключами,
   * проверками целостности и SQL-консолью.
   *
   * sec.sql_query — каждый запрос консоли с причиной, текстом и числом
   * строк, включая отказы разбора (outcome denied) и ошибки базы (error).
   * sec.secret_changed — система заметила новое значение секрета (актор
   * пуст: смену делал тот, кто правил окружение, и журналу он не известен).
   * sec.audit_chain_broken — разрыв цепочки журнала; по этому имени (и по
   * одноимённому событию лога) заводятся оповещения.
   */
  | "sec.reencrypt_start"
  | "sec.reencrypt_done"
  | "sec.phone_reindex"
  | "sec.secret_changed"
  | "sec.rls_check"
  | "sec.audit_check"
  | "sec.audit_chain_broken"
  | "sec.sql_query"
  /* календарь специалиста: подключение права создавать встречи Meet */
  | "meet.connect_start"
  | "meet.connected"
  | "meet.disconnected"
  | "survey.update"
  | "survey.archive"
  | "survey.restore"
  | "survey.purge"
  | "survey.duplicate"
  | "survey.publish"
  | "survey.key_print"
  | "survey.export"
  | "survey.import"
  /* перенос методики между папками каталога: меняется полка, не методика */
  | "survey.move"
  /*
   * Папки методик — полки каталога. Имена с survey_folder, чтобы в журнале
   * не смешивались ни с group.* (группы методик, то есть разграничение
   * доступа), ни с survey.* (сами методики): разбирающий ищет по подстроке.
   */
  | "survey_folder.create"
  | "survey_folder.update"
  | "survey_folder.delete"
  | "group.create"
  | "group.archive"
  | "group.restore"
  | "group.update"
  | "group.delete"
  | "group.admin_assign"
  | "group.admin_revoke"
  /*
   * Группы ПАЦИЕНТОВ — рабочие списки специалиста, не путать с group.* выше:
   * там группы методик, то есть разграничение доступа. Имена начинаются с
   * patient_group именно поэтому: разбирающий журнал ищет по подстроке и
   * обязан получить одно из двух, а не смесь.
   *
   * Чтение карточки группы пишется наравне с правкой: в карточке поимённый
   * состав, то есть персональные данные, — а «кто и когда смотрел список
   * людей» это ровно тот вопрос, ради которого журнал и ведётся.
   */
  | "patient_group.create"
  | "patient_group.update"
  | "patient_group.read"
  | "patient_group.member_add"
  | "patient_group.member_remove"
  /*
   * Назначение на всю группу — отдельное имя, а не набор access.grant.
   *
   * Массовая выдача обязана быть видна в журнале как одно решение с числом
   * адресатов, иначе она растворяется среди поимённых назначений и
   * перестаёт отличаться от обычной работы. Поимённые access.grant при этом
   * тоже пишутся: у каждого человека должна остаться своя строка.
   */
  | "patient_group.assign"
  /* закладка «обрана» — правка личной раскладки, но правка: журналу видно */
  | "patient_group.favourite"
  | "patient_group.unfavourite"
  /*
   * Карточка пациента (кадр f19): персональные данные, все результаты,
   * группы и заключения одним чтением. Своё имя, а не response.read с
   * пометкой в details: «кто открывал карточку человека» — вопрос, который
   * задают журналу чаще всего, и искать его подстрокой в details нельзя.
   */
  | "patient.card_read"
  /*
   * Рассылки — сообщение «одному многим». Отправка пишется дважды: сводкой
   * (mailing.send, с числом адресатов) и поимённо (mailing.deliver, с
   * subjectUserId) — тот же приём, что у patient_group.assign: сводка не даёт
   * массовому действию раствориться среди обычных, поимённые строки отвечают
   * на вопрос «что присылали этому человеку».
   */
  | "mailing.create"
  | "mailing.update"
  | "mailing.send"
  | "mailing.deliver"
  | "mailing.delete"
  | "mailing.hide"
  | "mailing.unhide"
  /* чтение карточки с ответами — поимённый список людей, как patient_group.read */
  | "mailing.read"
  | "mailing.answer"
  | "access.grant"
  | "access.revoke"
  | "access.grant_list"
  | "access.patient_list"
  | "response.submit"
  | "alert.list"
  /* чтение оснований тревоги — это доступ к ответам по пунктам, и в
     журнале оно обязано быть отличимо от «открыл очередь» */
  | "alert.signals"
  | "worklist.read"
  | "alert.acknowledge"
  | "alert.assign"
  | "alert.release"
  | "report.render"
  | "response.list"
  | "response.read"
  | "analytics.overview"
  | "analytics.severityTrend"
  /* состояние пациентов по направлениям на стартовом экране: обезличенные доли */
  | "dashboard.conditions"
  | "analytics.group"
  | "analytics.survey"
  | "analytics.export"
  | "battery.create"
  | "battery.update"
  | "battery.delete"
  | "battery.assign"
  | "battery.cancel"
  | "battery.assignment_list"
  | "schedule.run"
  | "invite.create"
  | "invite.revoke"
  | "invite.use"
  | "alert.notified"
  | "alert.escalated"
  | "conclusion.save"
  | "conclusion.sign"
  | "consent.accept"
  | "consent.text_update"
  | "retention.answer_events"
  /* техпанель: чтение логов и групп ошибок процесса — склеено по пять минут (routes/ops.ts) */
  | "ops.logs.read"
  | "ops.errors.read"
  /* техпанель, участок obs2b: правила оповещений, тестовое сообщение, ручной запуск, повтор расшифровки */
  | "ops.alerts.rule_update"
  | "ops.alerts.test"
  | "ops.job.run"
  | "ops.recording.retry"
  | "ops.client_errors.read"
  /* техпанель: трасса одного запроса (каждое чтение) и план медленного SQL по кнопке (routes/opsObs.ts) */
  | "ops.trace.read"
  | "ops.statements.explain"
  | "norms.publish"
  | "analytics.data_quality"
  /*
   * Техпанель, «Дані й продукт»: чтение проверок качества, использования,
   * мобильного приложения и пушей. Одно имя на четыре вида (вид — в
   * resourceId): это агрегаты по людям и голые идентификаторы записей, и
   * вопрос журналу один — «кто смотрел техпанель данных».
   */
  | "ops.data_read"
  | "analytics.facets"
  | "referral.list"
  /* личный план безопасности */
  | "safety.save"
  /* заметки приёма: запись о человеке вне привязки к прохождению */
  | "note.save"
  | "note.sign"
  | "referral.create"
  | "referral.update"
  | "cascade.assign"
  | "cascade.followup"
  | "audit.read"
  | "access.denied";

interface AuditInput {
  action: AuditAction;
  resourceType?: string;
  resourceId?: string;
  /** Чьи персональные данные затронуты */
  subjectUserId?: string | null;
  outcome?: "success" | "denied" | "error";
  details?: Record<string, unknown>;
  /** Актор, если он ещё не положен в контекст (например, при неудачном логине) */
  actor?: Pick<User, "id" | "email" | "role"> | null;
}

/**
 * Пишет запись в журнал.
 *
 * Дожидаемся записи намеренно: журнал доступа имеет доказательное значение,
 * и «выстрелил и забыл» означал бы, что при падении процесса событие пропадёт,
 * а ответ клиенту уже ушёл.
 *
 * Никогда не бросает: отказ журнала не должен ронять обслуживание пациента,
 * поэтому ошибка уходит в лог процесса.
 */
/**
 * Запись с хэш-цепочкой.
 *
 * seq и prevHash берутся под advisory-локом транзакции: без него две
 * параллельные записи взяли бы один prevHash и цепочка раздвоилась бы.
 * Канонизация — фиксированный порядок полей; details сериализуются с
 * отсортированными ключами, иначе один и тот же объект давал бы разные хэши.
 */
const AUDIT_CHAIN_LOCK = 7_154_301;

function canonical(row: Record<string, unknown>): string {
  const ordered = [
    row.id,
    // при чтении из БД метка приходит в другом текстовом виде — нормализуем
    row.at ? new Date(row.at as string).toISOString() : null,
    row.actorId, row.actorEmail, row.actorRole, row.action,
    row.resourceType, row.resourceId, row.subjectUserId, row.outcome,
    row.ip, row.userAgent,
    row.details ? JSON.stringify(row.details, Object.keys(row.details as object).sort()) : null,
  ];
  return JSON.stringify(ordered);
}

export function chainHash(prevHash: string | null, row: Record<string, unknown>): string {
  return new Bun.CryptoHasher("sha256").update((prevHash ?? "genesis") + canonical(row)).digest("hex");
}

async function writeChained(values: Record<string, unknown>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);
    /*
     * Голова цепочки — через audit_chain_head(), а не выборкой из таблицы.
     *
     * Журнал лежит под политикой строк, и читать его вправе персонал, а
     * писать обязаны все: запись пациента, сдавшего методику, — такое же
     * событие журнала. Обычная выборка из контекста пациента вернула бы
     * «цепочки нет», seq начался бы с единицы и упёрся в уникальный
     * индекс — то есть журнал перестал бы принимать записи ровно от тех,
     * чьи действия в нём важнее всего. Функция объявлена SECURITY DEFINER
     * и отдаёт только номер и хэш: ни одного поля из содержимого.
     *
     * Только цепные строки: у записей до внедрения цепочки seq NULL, а
     * NULLS FIRST у DESC-сортировки Postgres подсовывал бы их головой.
     */
    const [head] = await tx.execute<{ seq: number | null; entry_hash: string | null }>(
      sql`select seq, entry_hash from audit_chain_head()`,
    );
    const seq = (head?.seq ?? 0) + 1;
    const prevHash = head?.entry_hash ?? null;
    const at = new Date().toISOString();
    const row = { ...values, at };
    await tx.insert(auditLog).values({
      ...(row as object),
      seq,
      prevHash,
      entryHash: chainHash(prevHash, row),
    } as never);
  });
}

/** Подмешивает номер запроса в подробности события, не затирая своих полей */
function withRequestId(details: Record<string, unknown> | null | undefined) {
  const id = currentRequestId();
  if (!id) return details ?? null;
  return { ...(details ?? {}), requestId: id };
}

/**
 * Событие потока по записи журнала.
 *
 * Выпускается ЗДЕСЬ, а не вызовом рядом с каждым действием. Разница не в
 * удобстве: событие, которое надо не забыть выпустить, однажды забудут — и
 * узнать об этом будет неоткуда, потому что отсутствие события ничего не
 * ломает и ни на что не жалуется. Журнал же обязателен для каждого
 * изменяющего маршрута, и его полноту сторожит проверка по реестру
 * маршрутов. Привязав одно к другому, мы получаем полноту потока событий
 * даром: новое действие, попавшее в журнал, попадает и в поток.
 *
 * В событие идут только действие и адреса записей. `details` не идёт
 * НИКОГДА: там лежат причины отмены, заметки и прочий свободный текст, а
 * событие рассылается всем подписанным сотрудникам сразу, тогда как сам
 * журнал лежит под политиками строк и отдельным правом. Событие говорит
 * «вот это изменилось, перечитай, если тебе положено», а не рассказывает
 * содержимое.
 */
async function emit(input: AuditInput, actorId: string | null): Promise<void> {
  await publish(db, {
    kind: "action",
    action: input.action,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    actorId,
    // область видимости событию не сужаем: имён и содержимого в нём нет, а
    // сузить по методике здесь нечем — большинство действий к методике не
    // относится вовсе
    surveyIds: null,
    userId: input.subjectUserId ?? null,
    at: new Date().toISOString(),
  });
}

export async function audit(c: Context, input: AuditInput): Promise<void> {
  try {
    const ctxUser = c.get("user") as User | undefined;
    /*
     * Вход «от имени» (lib/impersonation.ts): в контексте запроса лежит тот,
     * ПОД КЕМ смотрят, а действующее лицо журнала — суперадмин, который
     * смотрит. «От чьего имени» — плоскими полями details (asUserId,
     * impersonation): вложенный объект канонизация хэша проверяла бы не
     * целиком (см. canonical выше и пояснение в lib/impersonation.ts).
     * Если у действия своего субъекта нет, субъект — тот, под кем смотрят.
     */
    const imp = !input.actor && ctxUser?.impersonation ? ctxUser.impersonation : null;
    const actor = input.actor ?? (imp ? { id: imp.actorId, email: imp.actorEmail, role: "superadmin" as const } : ctxUser) ?? null;
    const details = imp
      ? { ...(input.details ?? {}), asUserId: ctxUser!.id, asEmail: ctxUser!.email, impersonation: imp.sessionId }
      : input.details;
    const subjectUserId = input.subjectUserId ?? (imp ? ctxUser!.id : null);
    await writeChained({
      id: crypto.randomUUID(),
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      actorRole: actor?.role ?? null,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      subjectUserId,
      outcome: input.outcome ?? "success",
      ip: clientIp(c),
      userAgent: c.req.header("User-Agent") ?? null,
      /*
       * Идентификатор запроса кладём в details, а не отдельной колонкой:
       * колонка изменила бы канонизацию строки, по которой считается хэш, и
       * все прежние записи перестали бы проверяться. Цепочка важнее удобства
       * запроса — а найти по details Postgres умеет.
       */
      details: withRequestId(details),
    });

    /*
     * Чтение событием не становится. Различаются они не списком действий, а
     * методом запроса: GET и HEAD ничего не меняют по определению HTTP, и
     * список «какие действия читающие» пришлось бы вести руками — то есть
     * однажды разойтись с кодом. Без этого разделения открытая консоль
     * рассылала бы событие на каждый просмотр списка тревог, и поток,
     * заведённый ради срочного, утонул бы в обычном.
     */
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") await emit(input, actor?.id ?? null);
  } catch (err) {
    log.error("audit.write_failed", { action: input.action, error: String(err) });
  }
}

/**
 * Событие без человека-инициатора: сработало расписание, отработал фоновой
 * проход. Актор здесь пуст не по недосмотру, и в журнале это должно читаться
 * именно так, а не как «неизвестно кто».
 */
export async function auditSystem(input: Omit<AuditInput, "actor">): Promise<void> {
  try {
    await writeChained({
      id: crypto.randomUUID(),
      actorId: null,
      actorEmail: null,
      actorRole: null,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      subjectUserId: input.subjectUserId ?? null,
      outcome: input.outcome ?? "success",
      ip: null,
      userAgent: "система",
      details: input.details ?? null,
    });
    // фоновой проход читающим не бывает: он на то и проход, что что-то делает
    await emit(input, null);
  } catch (err) {
    log.error("audit.system_write_failed", { action: input.action, error: String(err) });
  }
}

function clientIp(c: Context): string | null {
  const forwarded = c.req.header("X-Forwarded-For");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return c.req.header("X-Real-IP") ?? null;
}
