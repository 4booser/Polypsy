import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import type { Permission } from "@quizzy/shared";
import {
  assignBatterySchema,
  batteryInputSchema,
  changePasswordSchema,
  createInviteSchema,
  createReferralSchema,
  createSurveySchema,
  bookAppointmentSchema,
  cancelAppointmentSchema,
  createUserSchema,
  departmentSchema,
  draftSchema,
  grantAccessSchema,
  groupInputSchema,
  loginSchema,
  registerSchema,
  rescheduleAppointmentSchema,
  scheduleExceptionSchema,
  specialistProfileSchema,
  submitResponseSchema,
  updateProfileSchema,
  updateReferralSchema,
  updateSurveySchema,
} from "@quizzy/shared";

/**
 * Описание API. Строится из настоящей таблицы маршрутов Hono, а не пишется
 * руками рядом с ней: спека, которую надо помнить обновлять, устаревает за
 * месяц и начинает врать — а врущая документация хуже отсутствующей.
 *
 * Руками задаются только смысл маршрута и схема тела; всё остальное —
 * пути, методы, требуемая роль — выводится из приложения. Тест
 * `openapi.test.ts` падает, если появился маршрут без описания: забыть
 * задокументировать новый эндпоинт нельзя, сборка не пропустит.
 */

/** Роль, без которой маршрут недоступен */
type Access = "public" | "user" | "staff" | "superadmin";

interface RouteDoc {
  summary: string;
  access: Access;
  /**
   * Право, которым маршрут закрыт, если он уже переведён на права.
   *
   * Поле необязательное намеренно: перевод идёт по одному набору маршрутов, и
   * заполненное поле означает «переведён», а пустое — «пока по старой
   * проверке персонала». Второго реестра не заводим — этот уже есть и его
   * полнота уже проверяется.
   *
   * Само по себе поле ничего не закрывает: настоящая защита — строка
   * requirePermission в маршруте, и проверяется она поведенческим тестом.
   * Здесь оно нужно, чтобы описание API говорило правду о том, что кому
   * доступно.
   */
  permission?: Permission;
  /**
   * Почему маршрут не закрыт правом — если он и не должен быть.
   *
   * Не всякий маршрут персонала стоит закрывать правом. Список групп нужен
   * всем, кто вообще видит методики; сохранённый вид экрана — личная
   * настройка; присутствие на экране видно тем, кто на этом же экране.
   * Право на такое — бюрократия, а не защита: его выдали бы всем в первый же
   * день и забыли.
   *
   * Но и молчаливый пробел не годится: маршрут без права неотличим от
   * маршрута, где строку забыли. Поэтому здесь требуется не флаг, а
   * причина — её пишут один раз и читают, когда решают, закрывать ли
   * похожий маршрут. Проверка полноты требует ровно одного из двух полей.
   */
  whyNoPermission?: string;
  /**
   * Маршрут отдаёт поток, а не ответ.
   *
   * Проверке прав это нужно знать: убедиться, что без права приходит отказ,
   * на потоке можно, а вот «с правом проходит» повисло бы — поток и не
   * должен закрываться.
   */
  streaming?: true;
  body?: ZodTypeAny;
}

/** Ключ — `МЕТОД /путь` ровно в том виде, в каком его знает Hono */
export const ROUTE_DOCS: Record<string, RouteDoc> = {
  "GET /health": { summary: "Живо ли приложение", access: "public" },
  "GET /health/ready": { summary: "Готово ли принимать нагрузку (проверяет БД)", access: "public" },
  "GET /metrics": { summary: "Метрики Prometheus; закрыты METRICS_TOKEN, без него 404", access: "public" },

  /* ── вход и профиль ── */
  "POST /api/auth/register": { summary: "Регистрация обследуемого", access: "public", body: registerSchema },
  "POST /api/auth/login": { summary: "Вход", access: "public", body: loginSchema },
  "POST /api/auth/refresh": { summary: "Обновление пары токенов", access: "public" },
  "GET /api/auth/google/status": { summary: "Способы входа: Google и открытая регистрация", access: "public" },
  "GET /api/auth/google/start": { summary: "Начало входа через Google", access: "public" },
  "GET /api/auth/google/callback": { summary: "Возврат от Google", access: "public" },
  "POST /api/auth/google/exchange": { summary: "Обмен одноразового кода на пару токенов", access: "public" },
  "POST /api/auth/google/link": { summary: "Адрес для связывания с Google", access: "user" },
  "POST /api/auth/google/unlink": { summary: "Отвязать Google", access: "user" },
  "POST /api/auth/logout": { summary: "Отзыв refresh-токена", access: "user" },
  "GET /api/auth/me": { summary: "Текущий пользователь", access: "user" },
  "PATCH /api/auth/me": { summary: "Правка своей паспортной части", access: "user", body: updateProfileSchema },
  "POST /api/auth/password": { summary: "Смена собственного пароля", access: "user", body: changePasswordSchema },

  /* ── права ── */
  "GET /api/permissions/catalogue": { summary: "Справочник прав с пояснениями", access: "superadmin", whyNoPermission: "управление правами закрыто ролью, а не правом: право на раздачу прав позволило бы выдать себе всё остальное, и справочник перестал бы что-либо ограничивать" },
  "GET /api/permissions/roles": { summary: "Роли и их наборы прав", access: "superadmin", whyNoPermission: "управление правами закрыто ролью, а не правом: право на раздачу прав позволило бы выдать себе всё остальное, и справочник перестал бы что-либо ограничивать" },
  "POST /api/permissions/roles": { summary: "Новая роль", access: "superadmin", whyNoPermission: "управление правами закрыто ролью, а не правом: право на раздачу прав позволило бы выдать себе всё остальное, и справочник перестал бы что-либо ограничивать" },
  "PUT /api/permissions/roles/:id/permissions": {
    summary: "Набор прав роли; встроенная роль не правится вручную",
    access: "superadmin", whyNoPermission: "управление правами закрыто ролью, а не правом: право на раздачу прав позволило бы выдать себе всё остальное, и справочник перестал бы что-либо ограничивать",
  },
  "GET /api/permissions/users/:id": {
    summary: "Что человек может и из чего это сложилось: роли, исключения, итог",
    access: "superadmin", whyNoPermission: "управление правами закрыто ролью, а не правом: право на раздачу прав позволило бы выдать себе всё остальное, и справочник перестал бы что-либо ограничивать",
  },
  "PUT /api/permissions/users/:id/roles": { summary: "Роли человека", access: "superadmin", whyNoPermission: "управление правами закрыто ролью, а не правом: право на раздачу прав позволило бы выдать себе всё остальное, и справочник перестал бы что-либо ограничивать" },
  "POST /api/permissions/users/:id/exceptions": {
    summary: "Личное исключение: одно право, с причиной и сроком",
    access: "superadmin", whyNoPermission: "управление правами закрыто ролью, а не правом: право на раздачу прав позволило бы выдать себе всё остальное, и справочник перестал бы что-либо ограничивать",
  },
  "POST /api/permissions/exceptions/:id/revoke": { summary: "Отзыв исключения", access: "superadmin", whyNoPermission: "управление правами закрыто ролью, а не правом: право на раздачу прав позволило бы выдать себе всё остальное, и справочник перестал бы что-либо ограничивать" },
  "GET /api/permissions/exceptions": { summary: "Действующие исключения по всем", access: "superadmin", whyNoPermission: "управление правами закрыто ролью, а не правом: право на раздачу прав позволило бы выдать себе всё остальное, и справочник перестал бы что-либо ограничивать" },

  /* ── методики ── */
  "GET /api/surveys": { summary: "Список методик; ?archived=1 — снятые с использования", access: "user" },
  "POST /api/surveys": { summary: "Создание методики", access: "staff", permission: "surveys.edit", body: createSurveySchema },
  "POST /api/surveys/validate": { summary: "Структурная проверка черновика без сохранения", access: "staff", permission: "surveys.edit" },
  "POST /api/surveys/import": { summary: "Импорт методики из файла экспорта", access: "staff", permission: "surveys.edit" },
  "GET /api/surveys/:id": { summary: "Методика с содержимым; ?raw=1 — для конструктора", access: "user" },
  "PATCH /api/surveys/:id": { summary: "Правка методики — создаёт новую версию", access: "staff", permission: "surveys.edit", body: updateSurveySchema },
  "DELETE /api/surveys/:id": { summary: "Снятие методики с использования (данные сохраняются)", access: "staff", permission: "surveys.publish" },
  "POST /api/surveys/:id/restore": { summary: "Возврат методики в работу", access: "staff", permission: "surveys.publish" },
  "POST /api/surveys/:id/duplicate": { summary: "Копия методики", access: "staff", permission: "surveys.edit" },
  "GET /api/surveys/:id/export": { summary: "Выгрузка методики файлом", access: "staff", permission: "surveys.read" },
  "GET /api/surveys/:id/versions": { summary: "Версии методики", access: "staff", permission: "surveys.read" },
  "GET /api/surveys/:id/versions/:a/diff/:b": { summary: "Что изменилось между версиями и сопоставимы ли баллы", access: "staff", permission: "surveys.read" },
  "GET /api/surveys/:id/key": { summary: "Ключ методики для печати", access: "staff", permission: "surveys.read" },

  /* ── прохождения ── */
  "POST /api/surveys/:id/responses": { summary: "Сдача прохождения", access: "user", body: submitResponseSchema },
  "PUT /api/surveys/:id/draft": { summary: "Сохранение черновика", access: "user", body: draftSchema },
  "GET /api/surveys/:id/draft": { summary: "Свой незавершённый черновик", access: "user" },
  "GET /api/surveys/:id/responses": { summary: "Прохождения по методике", access: "staff", permission: "patients.read" },
  "GET /api/responses/:id": { summary: "Прохождение целиком", access: "staff", whyNoPermission: "своё прохождение открывает сам обследуемый; персоналу доступ ограничен областью ответственности" },
  "GET /api/me/responses": { summary: "Свои прохождения", access: "user" },
  "GET /api/me/dynamics": { summary: "Своя динамика — только по разрешённым методикам", access: "user" },
  "GET /api/reports/responses/:id": { summary: "Отчёт по прохождению для печати", access: "staff", whyNoPermission: "своё прохождение печатает сам обследуемый; персоналу доступ уже ограничен областью ответственности" },

  /* ── назначения ── */
  "GET /api/access/surveys/:id/grants": { summary: "Кому назначена методика", access: "staff", permission: "assignments.manage" },
  "POST /api/access/surveys/:id/grants": { summary: "Назначить методику", access: "staff", permission: "assignments.manage", body: grantAccessSchema },
  "DELETE /api/access/surveys/:id/grants/:userId": { summary: "Снять назначение", access: "staff", permission: "assignments.manage" },
  "GET /api/access/patients": { summary: "Обследуемые в зоне ответственности", access: "staff", permission: "assignments.manage" },

  /* ── группы ── */
  "GET /api/groups": { summary: "Группы методик", access: "staff", whyNoPermission: "список групп — это область ответственности, а не действие: его читает каждый, кто вообще видит методики, и ограничивает его assertGroupAccess" },
  "POST /api/groups": { summary: "Создание группы", access: "superadmin", permission: "groups.manage", body: groupInputSchema },
  "PATCH /api/groups/:id": { summary: "Правка группы", access: "superadmin", whyNoPermission: "переименовать можно только свою группу, и это проверяет область ответственности, а не право", body: groupInputSchema },
  "DELETE /api/groups/:id": { summary: "Удаление пустой группы", access: "superadmin", permission: "groups.manage" },
  "GET /api/groups/:id/admins": { summary: "Администраторы группы", access: "staff", whyNoPermission: "состав администраторов группы виден тем, кто с этой группой работает; кого именно видно — решает область ответственности" },
  "POST /api/groups/:id/admins": { summary: "Назначить администратора группы", access: "superadmin", permission: "groups.manage" },
  "DELETE /api/groups/:id/admins/:userId": { summary: "Снять администратора группы", access: "superadmin", permission: "groups.manage" },

  /* ── батареи ── */
  "GET /api/batteries": { summary: "Батареи методик", access: "staff", permission: "batteries.manage" },
  "POST /api/batteries": { summary: "Создание батареи", access: "staff", permission: "batteries.manage", body: batteryInputSchema },
  "PUT /api/batteries/:id": { summary: "Правка батареи и её состава", access: "staff", permission: "batteries.manage", body: batteryInputSchema },
  "DELETE /api/batteries/:id": { summary: "Удаление ни разу не назначавшейся батареи", access: "staff", permission: "batteries.manage" },
  "POST /api/batteries/:id/assign": { summary: "Назначить батарею", access: "staff", permission: "assignments.manage", body: assignBatterySchema },
  "GET /api/batteries/:id/assignments": { summary: "Назначения батареи и прогресс", access: "staff", permission: "assignments.manage" },
  "GET /api/batteries/mine": { summary: "Свои назначенные батареи", access: "user" },
  "POST /api/batteries/assignments/:assignmentId/cancel": { summary: "Отмена назначения", access: "staff", permission: "assignments.manage" },

  /* ── расписания ── */

  /* ── приглашения и киоск ── */
  "GET /api/invites": { summary: "Приглашения", access: "staff", permission: "invites.manage" },
  "POST /api/invites": { summary: "Создание приглашения", access: "staff", permission: "invites.manage", body: createInviteSchema },
  "POST /api/invites/:id/revoke": { summary: "Отзыв приглашения", access: "staff", permission: "invites.manage" },
  "GET /api/invites/preview/:token": { summary: "Что даёт приглашение — до регистрации", access: "public" },

  /* ── тревоги, направления, заключения ── */
  "GET /api/alerts": { summary: "Тревоги риска по пунктам; ?all=1 — вместе с разобранными", access: "staff", permission: "alerts.review" },
  "PUT /api/auth/me/workspace": { summary: "Настройки рабочего места: стартовый экран, тема, плотность", access: "user" },
  "GET /api/conclusions/batch": { summary: "Пакет подписанных заключений подразделения за период", access: "staff", permission: "patients.read" },
  "GET /api/spss/surveys/:id/manifest.json": { summary: "Снимок параметров выгрузки: версии, нормы, профиль обезличивания", access: "staff", permission: "export.deidentified" },
  "GET /api/spss/surveys/:id/load/:ext": { summary: "Готовый скрипт загрузки выгрузки в R или Python", access: "staff", permission: "export.deidentified" },
  "GET /api/data-quality/surveys/:id/items": { summary: "Тепловая карта пунктов: время ответа и серии одинаковых ответов", access: "staff", permission: "analytics.read" },
  "GET /api/missed": { summary: "Что произошло, пока меня не было: новые случаи, разобранные другими, направления, расписания", access: "staff", permission: "patients.read" },
  "GET /api/search/notes": { summary: "Поиск по записям приёма через слепой индекс; текст запроса в журнал не пишется", access: "staff", permission: "patients.read" },
  "POST /api/cohorts/preview": { summary: "Размер и распределения когорты; малые ячейки подавляются", access: "staff", permission: "cohorts.read" },
  "POST /api/cohorts/members": { summary: "Когорта поимённо — отдельное действие и отдельная запись в журнале", access: "staff", permission: "cohorts.read" },
  "GET /api/cohorts": { summary: "Свои сохранённые когорты", access: "staff", permission: "cohorts.read" },
  "POST /api/cohorts": { summary: "Сохранить правило отбора", access: "staff", permission: "cohorts.read" },
  "DELETE /api/cohorts/:id": { summary: "Удалить свою когорту", access: "staff", permission: "cohorts.read" },
  "POST /api/devices/checkin": { summary: "Отметка устройства; отвечает, надо ли стереть локальные данные", access: "user" },
  "POST /api/devices/wiped": { summary: "Подтверждение стирания устройством", access: "user" },
  "GET /api/devices": { summary: "Свои устройства; чужие — только суперадмину", access: "user" },
  "POST /api/devices/:id/wipe": { summary: "Запросить стирание: исполнится при следующем выходе на связь", access: "superadmin", whyNoPermission: "стирание устройства — крайняя мера, делегировать её мы не собираемся" },
  "GET /api/decisions/crisis": { summary: "Включён ли кризисный режим учреждения", access: "staff", permission: "alerts.review" },
  "POST /api/decisions/crisis": { summary: "Включить кризисный режим: плановые замеры стоп, очередь по тяжести", access: "superadmin", permission: "decisions.manage" },
  "DELETE /api/decisions/crisis": { summary: "Выключить кризисный режим", access: "superadmin", permission: "decisions.manage" },
  "GET /api/decisions/rules": { summary: "Правила поддержки решений", access: "staff", permission: "alerts.review" },
  "POST /api/decisions/rules": { summary: "Завести правило", access: "superadmin", permission: "decisions.manage" },
  "PATCH /api/decisions/rules/:id": { summary: "Правка правила: поднимает версию", access: "superadmin", permission: "decisions.manage" },
  "GET /api/decisions/hits": { summary: "Предложения правил, ждущие решения человека", access: "staff", permission: "alerts.review" },
  "PATCH /api/decisions/hits/:id": { summary: "Принять или отклонить предложение (отклонение — с объяснением)", access: "staff", permission: "alerts.review" },
  "POST /api/presence": { summary: "Пульс присутствия: я на этом экране", access: "staff", whyNoPermission: "пульс присутствия шлёт сам клиент за того, кто уже вошёл" },
  "GET /api/presence": { summary: "Кто ещё держит открытым этот экран", access: "staff", whyNoPermission: "кто ещё держит открытым этот экран — видно тем, кто на этом же экране; скрывать нечего" },
  "GET /api/worklist": { summary: "Что от меня ждут сегодня: случаи, направления, просроченные назначения", access: "staff", permission: "patients.read" },
  "GET /api/alert-cases": { summary: "Случаи риска: страница с курсором и фильтрами", access: "staff", permission: "alerts.review" },
  "GET /api/alert-cases/units": { summary: "Подразделения среди случаев — для фильтра", access: "staff", permission: "alerts.review" },
  "GET /api/alert-cases/:id/history": { summary: "Кто и что делал со случаем — выборка из журнала доступа", access: "staff", permission: "alerts.review" },
  "POST /api/alert-cases/:id/assign": { summary: "Взять случай на себя или отпустить", access: "staff", permission: "alerts.review" },
  "PATCH /api/alert-cases/:id": { summary: "Разбор случая: одно решение о человеке", access: "staff", permission: "alerts.review" },
  "GET /api/referrals": { summary: "Направления; ?all=1 — вместе с завершёнными", access: "staff", permission: "referrals.manage" },
  "POST /api/referrals": { summary: "Выписать направление", access: "staff", permission: "referrals.manage", body: createReferralSchema },
  "PATCH /api/referrals/:id": { summary: "Движение статуса направления (только вперёд)", access: "staff", permission: "referrals.manage", body: updateReferralSchema },
  "GET /api/referrals/summary/:userId": { summary: "Сводка для консилиума", access: "staff", permission: "referrals.manage" },
  "GET /api/conclusions/responses/:id/conclusion": { summary: "Заключение по прохождению", access: "staff", permission: "patients.read" },
  "GET /api/conclusions/responses/:id/conclusion/draft": { summary: "Черновик заключения из результатов: подставляет то, что и так есть в системе", access: "staff", permission: "conclusions.write" },
  "PUT /api/conclusions/responses/:id/conclusion": { summary: "Черновик заключения", access: "staff", permission: "conclusions.write" },
  "POST /api/conclusions/responses/:id/conclusion/sign": { summary: "Подпись заключения — фиксирует снапшот", access: "staff", permission: "conclusions.sign" },

  /* ── аналитика ── */
  "GET /api/analytics/overview": { summary: "Сводка по всем методикам", access: "staff", permission: "analytics.read" },
  "GET /api/analytics/surveys/:id": { summary: "Аналитика методики: распределения, психометрика, воронка", access: "staff", permission: "analytics.read" },
  "GET /api/analytics/surveys/:id/export": { summary: "Выгрузка прохождений методики", access: "staff", permission: "export.full" },
  "GET /api/dynamics/respondents": { summary: "Обследуемые с повторными замерами", access: "staff", permission: "patients.read" },
  "GET /api/dynamics/respondents/:userId": { summary: "Динамика обследуемого с метками RCI", access: "staff", permission: "patients.read" },
  "GET /api/facets/surveys/:id": { summary: "Срезы по полу и возрасту", access: "staff", permission: "analytics.read" },
  "GET /api/data-quality/surveys/:id": { summary: "Дрейф выборки, отсев по стратам, тест-ретест", access: "staff", permission: "analytics.read" },
  "GET /api/norms/surveys/:id/candidates": { summary: "Кандидатные локальные нормы по выборке", access: "staff", permission: "norms.manage" },
  "POST /api/norms/surveys/:id/apply": { summary: "Публикация локальных норм", access: "staff", permission: "norms.manage" },
  "GET /api/norms/surveys/:id/age-curves": { summary: "Возрастные кривые по шкалам", access: "staff", permission: "norms.manage" },

  /* ── выгрузка для статпакетов ── */
  "GET /api/spss/surveys/:id/data.csv": { summary: "Данные в широком формате", access: "staff", permission: "export.deidentified" },
  "GET /api/spss/surveys/:id/syntax.sps": { summary: "Синтаксис SPSS под выгрузку", access: "staff", permission: "export.deidentified" },
  "GET /api/spss/surveys/:id/codebook.csv": { summary: "Кодовая книга переменных", access: "staff", permission: "export.deidentified" },
  "GET /api/spss/surveys/:id/long.csv": { summary: "Данные в длинном формате для R и Python", access: "staff", permission: "export.deidentified" },

  /* ── администрирование ── */
  "GET /api/users": { summary: "Учётные записи", access: "superadmin", permission: "users.manage" },
  "POST /api/users": { summary: "Создание учётной записи", access: "superadmin", permission: "users.manage", body: createUserSchema },
  "PATCH /api/users/:id/role": { summary: "Смена роли", access: "superadmin", permission: "users.manage" },
  "GET /api/audit": { summary: "Журнал доступа", access: "superadmin", permission: "audit.read" },
  "GET /api/audit/summary": { summary: "Сводка по журналу", access: "superadmin", permission: "audit.read" },
  "GET /api/audit/verify": { summary: "Проверка хэш-цепочки журнала", access: "superadmin", permission: "audit.read" },
  "GET /api/stats/storage": { summary: "Размеры таблиц и рост журнала", access: "superadmin", whyNoPermission: "техническое состояние хранилища; делегировать его мы не собираемся, и право осталось бы навсегда только у суперадмина" },
  "GET /api/timeline/:userId": { summary: "Хронология пациента: всё на одной оси", access: "staff", permission: "patients.read" },
  "GET /api/events": { summary: "Поток событий (SSE): тревоги и изменения случаев", access: "staff", permission: "alerts.review", streaming: true },

  /* ── командная консоль ── */
  "GET /api/console/commands": { summary: "Список команд консоли с отметкой доступности", access: "staff", permission: "console.use" },
  "GET /api/meet/status": { summary: "Подключён ли календарь специалиста для встреч Meet", access: "staff", permission: "appointments.manage" },
  "POST /api/meet/connect": { summary: "Адрес согласия Google на создание встреч в календаре специалиста", access: "staff", permission: "appointments.manage" },
  "POST /api/meet/callback": { summary: "Возврат от Google: сохранить разрешение", access: "staff", permission: "appointments.manage" },
  "POST /api/meet/disconnect": { summary: "Отключить календарь", access: "staff", permission: "appointments.manage" },
  "POST /api/console/run": { summary: "Выполнить команду консоли; право проверяется отдельно на каждую команду", access: "staff", permission: "console.use" },
  "PATCH /api/surveys/:id/rights": { summary: "Правовой статус и отметка о сверке ключей", access: "superadmin", whyNoPermission: "правовой статус методики утверждает учреждение, а не тот, кто методику завёл; делегировать не собираемся" },
  "POST /api/push/register": { summary: "Зарегистрировать устройство для пушей", access: "user" },
  "POST /api/push/forget": { summary: "Забыть устройство", access: "user" },
  "GET /api/safety/me": { summary: "Свой план безопасности: пациент открывает сам", access: "user" },
  "GET /api/safety/patients/:userId": { summary: "План безопасности пациента по версиям", access: "staff", permission: "patients.read" },
  "PUT /api/safety/patients/:userId": { summary: "Сохранить план безопасности новой версией", access: "staff", permission: "safety.manage" },
  "GET /api/notes/patients/:userId": { summary: "Заметки приёма по пациенту", access: "staff", permission: "patients.read" },
  "PUT /api/notes/patients/:userId": { summary: "Сохранить заметку приёма", access: "staff", permission: "notes.write" },
  "POST /api/notes/patients/:userId/sign": { summary: "Подписать заметку приёма", access: "staff", permission: "notes.write" },
  "GET /api/views": { summary: "Сохранённые виды экрана: свои и общие", access: "staff", whyNoPermission: "сохранённый вид — личная настройка экрана; право на неё было бы бюрократией" },
  "POST /api/views": { summary: "Сохранить текущий срез экрана", access: "staff", whyNoPermission: "то же: человек сохраняет свой срез своего экрана" },
  "PATCH /api/views/:id": { summary: "Переименовать вид или открыть его коллегам", access: "staff", whyNoPermission: "правится только свой вид; чужой закрыт проверкой владельца" },
  "DELETE /api/views/:id": { summary: "Удалить свой вид", access: "staff", whyNoPermission: "удаляется только свой вид; чужой закрыт проверкой владельца, а не правом" },

  /* ── поликлиника: расписание и приёмы ── */
  "GET /api/clinic/departments": { summary: "Отделения, куда можно записаться", access: "user", whyNoPermission: "вывеска учреждения: не увидев её, пациент не сможет выбрать, куда записаться" },
  "PATCH /api/clinic/departments/:id": { summary: "Правка отделения, в том числе методика скрининга при записи", access: "staff", permission: "departments.manage" },
  "POST /api/clinic/departments": { summary: "Завести отделение", access: "staff", permission: "departments.manage", body: departmentSchema },
  "GET /api/clinic/specialists": { summary: "Кто принимает; свой специалист помечен и стоит первым", access: "user", whyNoPermission: "выбрать специалиста должен уметь любой записывающийся, иначе самозапись невозможна" },
  "PUT /api/clinic/specialists/:userId": { summary: "Профиль специалиста: отделение, кабинет, длительность приёма", access: "staff", permission: "departments.manage", body: specialistProfileSchema },
  "GET /api/clinic/schedule": { summary: "Обычная неделя и исключения", access: "staff", permission: "schedule.own" },
  "PUT /api/clinic/schedule": { summary: "Задать обычную неделю целиком; слоты пересобираются", access: "staff", permission: "schedule.own" },
  "POST /api/clinic/schedule/exceptions": { summary: "Отпуск, замена или дополнительный день", access: "staff", permission: "schedule.own", body: scheduleExceptionSchema },
  "DELETE /api/clinic/schedule/exceptions/:id": { summary: "Снять исключение", access: "staff", permission: "schedule.own" },
  "GET /api/clinic/slots": { summary: "Свободное время; повторные слоты видны прикреплённым", access: "user", whyNoPermission: "свободное время — не персональные данные, а расписание приёма; его смотрит и тот, кто ещё никуда не записан" },
  "POST /api/clinic/appointments": { summary: "Записаться; на первичном приёме создаётся прикрепление к отделению", access: "user", whyNoPermission: "себя записывает сам пациент; запись за другого проверяется правом внутри", body: bookAppointmentSchema },
  "GET /api/clinic/appointments/mine": { summary: "Свои приёмы", access: "user", whyNoPermission: "свои приёмы человек видит сам, и ограничивать это правом нечем" },
  "POST /api/clinic/appointments/:id/confirm": { summary: "Подтвердить приём одним нажатием", access: "user", whyNoPermission: "подтверждает тот, кого записали, и только за себя" },
  "POST /api/clinic/appointments/:id/reschedule": { summary: "Перенести: отмена и запись одним действием", access: "user", whyNoPermission: "свой приём переносит сам пациент; перенос чужого проверяется правом внутри", body: rescheduleAppointmentSchema },
  "POST /api/clinic/appointments/:id/cancel": { summary: "Отменить; позже чем за сутки — с пометкой", access: "user", whyNoPermission: "свой приём отменяет сам пациент; отмена чужого проверяется правом внутри", body: cancelAppointmentSchema },
  "POST /api/clinic/appointments/:id/status": { summary: "Явка, начало, завершение, неявка", access: "staff", permission: "appointments.manage" },
  "GET /api/clinic/appointments/:id/context": { summary: "Всё для экрана приёма одним запросом: хронология, что изменилось, протокол", access: "staff", permission: "patients.read" },
  "GET /api/episodes/patients/:userId": { summary: "Обращения человека со счётчиками приёмов, заключений и направлений", access: "staff", permission: "patients.read" },
  "GET /api/episodes/dispensary/:userId": { summary: "Состоит ли на учёте и когда следующий осмотр", access: "staff", permission: "patients.read" },
  "PUT /api/episodes/dispensary": { summary: "Поставить на учёт или изменить периодичность", access: "staff", permission: "episodes.manage" },
  "POST /api/episodes/dispensary/:userId/seen": { summary: "Отметить состоявшийся осмотр по учёту", access: "staff", permission: "episodes.manage" },
  "DELETE /api/episodes/dispensary/:userId": { summary: "Снять с учёта; строка остаётся", access: "staff", permission: "episodes.manage" },
  "POST /api/episodes": { summary: "Открыть обращение; одно открытое на человека", access: "staff", permission: "episodes.manage" },
  "POST /api/episodes/:id/close": { summary: "Закрыть обращение с исходом", access: "staff", permission: "episodes.manage" },
  "POST /api/episodes/:id/appointments/:appointmentId": { summary: "Привязать приём к обращению", access: "staff", permission: "episodes.manage" },
  "GET /api/recordings/:appointmentId": { summary: "Состояние записи приёма; обе стороны видят одно и то же", access: "user", whyNoPermission: "запись приёма видят только двое его участников, и это проверяется по самому приёму" },
  "POST /api/recordings/:appointmentId/consent": { summary: "Согласие на запись именно этого приёма", access: "user", whyNoPermission: "согласие даёт пациент; отметить его с его слов может ведущий приём" },
  "POST /api/recordings/:appointmentId/consent/revoke": { summary: "Отозвать согласие до начала записи", access: "user", whyNoPermission: "право передумать до того, как что-то сказано, не требует объяснений" },
  "POST /api/recordings/:appointmentId/start": { summary: "Начать запись; без согласия отказ", access: "user", whyNoPermission: "начинает ведущий приём, и проверка согласия стоит внутри" },
  "POST /api/recordings/:appointmentId/stop": { summary: "Остановить и передать аудио; остановить может любая сторона", access: "user", whyNoPermission: "это разговор двоих, и право прекратить запись есть у обоих" },
  "POST /api/recordings/:appointmentId/discard": { summary: "Удалить запись до расшифровки", access: "user", whyNoPermission: "сказанное сгоряча человек вправе забрать назад, пока оно не стало текстом" },
  "GET /api/messages": { summary: "Разговоры: у пациента один, у специалиста список", access: "user", whyNoPermission: "свою переписку человек видит сам; у специалиста список ограничен его же разговорами" },
  "GET /api/messages/:id": { summary: "Разговор целиком; открытие помечает чужие сообщения прочитанными", access: "user", whyNoPermission: "разговор видят только двое его участников, и это проверяется по самому разговору" },
  "POST /api/messages": { summary: "Написать: пациент своему специалисту, специалист — своему пациенту", access: "user", whyNoPermission: "пациент пишет своему и адресата не выбирает; отправка специалистом проверяется правом внутри" },
  "GET /api/clinic/patients/:userId/phone": { summary: "Показать телефон: отдельным действием и с записью в журнал", access: "staff", permission: "patients.read" },
  "POST /api/auth/me/reveal": { summary: "Раскрыть учётную запись под кодом: необратимо", access: "user", whyNoPermission: "своё имя называет сам человек, и только своё" },
  "GET /api/reports/patients/:userId/chart": { summary: "Амбулаторная карта одним документом: обращения, приёмы, обследования, подписанные записи", access: "staff", permission: "patients.read" },
  "GET /api/reports/episodes/:id": { summary: "Выписка по обращению: приёмы, подписанные заключения, направления, исход", access: "staff", permission: "patients.read" },
  "GET /api/reports/visits/:id": { summary: "Справка о посещении — печатная страница", access: "user", whyNoPermission: "свою справку берёт сам обследуемый; выдача чужой проверяется правом внутри" },
  "GET /api/clinic/today": { summary: "Приёмы дня: картина целиком, включая уже принятых", access: "staff", permission: "patients.read" },
  "POST /api/clinic/patients/:userId/lead": { summary: "Закрепить пациента за собой или отпустить", access: "staff", permission: "patients.read" },
  "GET /api/openapi.json": { summary: "Это описание", access: "staff", whyNoPermission: "описание самого API: что кому доступно, читает любой сотрудник, и скрывать состав маршрутов от своих же смысла нет" },

  /* ── согласие ── */
  "GET /api/consents/text": { summary: "Действующий текст согласия", access: "public", whyNoPermission: "действующий текст согласия читают до входа в систему" },
  "PUT /api/consents/text": { summary: "Новая версия текста согласия", access: "superadmin", whyNoPermission: "текст согласия — заявление учреждения, а не действие специалиста" },
  "GET /api/consents/me": { summary: "Своё согласие", access: "user" },
  "POST /api/consents/me/accept": { summary: "Принятие согласия", access: "user" },
};

/** Маршруты, которых в описании нет намеренно */
export const UNDOCUMENTED = new Set<string>([]);

const ACCESS_NOTE: Record<Access, string> = {
  public: "Без авторизации",
  user: "Любой вошедший",
  staff: "Сотрудник (админ группы или суперадмин)",
  superadmin: "Только суперадмин",
};

/** Hono-путь `/api/surveys/:id` → OpenAPI-путь `/api/surveys/{id}` */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function paramsOf(path: string) {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
    name: m[1]!,
    in: "path" as const,
    required: true,
    schema: { type: "string" as const },
  }));
}

export interface RuntimeRoute {
  method: string;
  path: string;
}

/**
 * Собирает документ OpenAPI 3.1 из таблицы маршрутов приложения.
 * Маршруты без описания попадают в документ с пометкой — молчать о них
 * значило бы выдавать неполную спеку за полную.
 */
export function buildOpenApi(routes: RuntimeRoute[], version: string) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const { method, path } of dedupe(routes)) {
    const key = `${method} ${path}`;
    if (UNDOCUMENTED.has(key)) continue;
    const doc = ROUTE_DOCS[key];

    const operation: Record<string, unknown> = {
      summary: doc?.summary ?? "Описание не задано",
      description: doc ? ACCESS_NOTE[doc.access] : "Маршрут не описан в ROUTE_DOCS",
      tags: [path.split("/")[2] ?? "root"],
      parameters: paramsOf(path),
      security: !doc || doc.access === "public" ? [] : [{ bearerAuth: [] }],
      responses: {
        "200": { description: "Успех" },
        "400": { description: "Некорректный запрос" },
        "401": { description: "Требуется авторизация" },
        "403": { description: "Недостаточно прав" },
        "404": { description: "Не найдено" },
      },
    };

    if (doc?.body) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: zodToJsonSchema(doc.body, { target: "openApi3" }),
          },
        },
      };
    }

    const openApiPath = toOpenApiPath(path);
    paths[openApiPath] ??= {};
    paths[openApiPath]![method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Quizzy API",
      version,
      description:
        "Психодиагностика: методики, прохождения, аналитика.\n\n" +
        "Пути и методы выведены из таблицы маршрутов приложения — спека не может " +
        "разойтись с кодом. Схемы тел взяты из zod-схем пакета @quizzy/shared.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
    paths,
  };
}

/** Hono перечисляет middleware отдельной строкой — метод+путь достаточно один раз */
export function dedupe(routes: RuntimeRoute[]): RuntimeRoute[] {
  const seen = new Set<string>();
  const out: RuntimeRoute[] = [];
  for (const r of routes) {
    if (r.method === "ALL") continue;
    // хвостовые wildcard-регистрации middleware маршрутами не являются
    if (r.path.endsWith("/*")) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
