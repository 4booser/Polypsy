import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import {
  assignBatterySchema,
  batteryInputSchema,
  changePasswordSchema,
  createInviteSchema,
  createKioskSessionSchema,
  createReferralSchema,
  createSurveySchema,
  createUserSchema,
  draftSchema,
  grantAccessSchema,
  groupInputSchema,
  kioskJoinSchema,
  loginSchema,
  registerSchema,
  scheduleInputSchema,
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
  "POST /api/auth/logout": { summary: "Отзыв refresh-токена", access: "user" },
  "GET /api/auth/me": { summary: "Текущий пользователь", access: "user" },
  "PATCH /api/auth/me": { summary: "Правка своей паспортной части", access: "user", body: updateProfileSchema },
  "POST /api/auth/password": { summary: "Смена собственного пароля", access: "user", body: changePasswordSchema },

  /* ── методики ── */
  "GET /api/surveys": { summary: "Список методик; ?archived=1 — снятые с использования", access: "user" },
  "POST /api/surveys": { summary: "Создание методики", access: "staff", body: createSurveySchema },
  "POST /api/surveys/validate": { summary: "Структурная проверка черновика без сохранения", access: "staff" },
  "POST /api/surveys/import": { summary: "Импорт методики из файла экспорта", access: "staff" },
  "GET /api/surveys/:id": { summary: "Методика с содержимым; ?raw=1 — для конструктора", access: "user" },
  "PATCH /api/surveys/:id": { summary: "Правка методики — создаёт новую версию", access: "staff", body: updateSurveySchema },
  "DELETE /api/surveys/:id": { summary: "Снятие методики с использования (данные сохраняются)", access: "staff" },
  "POST /api/surveys/:id/restore": { summary: "Возврат методики в работу", access: "staff" },
  "POST /api/surveys/:id/duplicate": { summary: "Копия методики", access: "staff" },
  "GET /api/surveys/:id/export": { summary: "Выгрузка методики файлом", access: "staff" },
  "GET /api/surveys/:id/versions": { summary: "Версии методики", access: "staff" },
  "GET /api/surveys/:id/versions/:a/diff/:b": { summary: "Что изменилось между версиями и сопоставимы ли баллы", access: "staff" },
  "GET /api/surveys/:id/key": { summary: "Ключ методики для печати", access: "staff" },

  /* ── прохождения ── */
  "POST /api/surveys/:id/responses": { summary: "Сдача прохождения", access: "user", body: submitResponseSchema },
  "PUT /api/surveys/:id/draft": { summary: "Сохранение черновика", access: "user", body: draftSchema },
  "GET /api/surveys/:id/draft": { summary: "Свой незавершённый черновик", access: "user" },
  "GET /api/surveys/:id/responses": { summary: "Прохождения по методике", access: "staff" },
  "GET /api/responses/:id": { summary: "Прохождение целиком", access: "staff" },
  "GET /api/me/responses": { summary: "Свои прохождения", access: "user" },
  "GET /api/me/dynamics": { summary: "Своя динамика — только по разрешённым методикам", access: "user" },
  "GET /api/reports/responses/:id": { summary: "Отчёт по прохождению для печати", access: "staff" },

  /* ── назначения ── */
  "GET /api/access/surveys/:id/grants": { summary: "Кому назначена методика", access: "staff" },
  "POST /api/access/surveys/:id/grants": { summary: "Назначить методику", access: "staff", body: grantAccessSchema },
  "DELETE /api/access/surveys/:id/grants/:userId": { summary: "Снять назначение", access: "staff" },
  "GET /api/access/patients": { summary: "Обследуемые в зоне ответственности", access: "staff" },

  /* ── группы ── */
  "GET /api/groups": { summary: "Группы методик", access: "staff" },
  "POST /api/groups": { summary: "Создание группы", access: "superadmin", body: groupInputSchema },
  "PATCH /api/groups/:id": { summary: "Правка группы", access: "superadmin", body: groupInputSchema },
  "DELETE /api/groups/:id": { summary: "Удаление пустой группы", access: "superadmin" },
  "GET /api/groups/:id/admins": { summary: "Администраторы группы", access: "staff" },
  "POST /api/groups/:id/admins": { summary: "Назначить администратора группы", access: "superadmin" },
  "DELETE /api/groups/:id/admins/:userId": { summary: "Снять администратора группы", access: "superadmin" },

  /* ── батареи ── */
  "GET /api/batteries": { summary: "Батареи методик", access: "staff" },
  "POST /api/batteries": { summary: "Создание батареи", access: "staff", body: batteryInputSchema },
  "PUT /api/batteries/:id": { summary: "Правка батареи и её состава", access: "staff", body: batteryInputSchema },
  "DELETE /api/batteries/:id": { summary: "Удаление ни разу не назначавшейся батареи", access: "staff" },
  "POST /api/batteries/:id/assign": { summary: "Назначить батарею", access: "staff", body: assignBatterySchema },
  "GET /api/batteries/:id/assignments": { summary: "Назначения батареи и прогресс", access: "staff" },
  "GET /api/batteries/mine": { summary: "Свои назначенные батареи", access: "user" },
  "POST /api/batteries/assignments/:assignmentId/cancel": { summary: "Отмена назначения", access: "staff" },

  /* ── расписания ── */
  "GET /api/schedules": { summary: "Расписания повторных замеров", access: "staff" },
  "POST /api/schedules": { summary: "Создание расписания", access: "staff", body: scheduleInputSchema },
  "PUT /api/schedules/:id": { summary: "Правка расписания", access: "staff", body: scheduleInputSchema },
  "DELETE /api/schedules/:id": { summary: "Удаление расписания", access: "staff" },
  "POST /api/schedules/:id/run": { summary: "Ручной прогон расписания", access: "staff" },
  "GET /api/schedules/units": { summary: "Подразделения для охвата расписанием", access: "staff" },

  /* ── приглашения и киоск ── */
  "GET /api/invites": { summary: "Приглашения", access: "staff" },
  "POST /api/invites": { summary: "Создание приглашения", access: "staff", body: createInviteSchema },
  "POST /api/invites/:id/revoke": { summary: "Отзыв приглашения", access: "staff" },
  "GET /api/invites/preview/:token": { summary: "Что даёт приглашение — до регистрации", access: "public" },
  "POST /api/kiosk/sessions": { summary: "Создание сеанса киоска", access: "staff", body: createKioskSessionSchema },
  "GET /api/kiosk/sessions": { summary: "Сеансы киоска и живой прогресс", access: "staff" },
  "POST /api/kiosk/sessions/:id/close": { summary: "Закрытие сеанса", access: "staff" },
  "GET /api/kiosk/state/:token": { summary: "Состояние сеанса для планшета", access: "public" },
  "POST /api/kiosk/state/:token/join": { summary: "Вход участника в сеанс", access: "public", body: kioskJoinSchema },
  "GET /api/kiosk/state/:token/surveys/:surveyId": { summary: "Методика для прохождения в киоске", access: "public" },
  "POST /api/kiosk/state/:token/submit": { summary: "Сдача прохождения из киоска", access: "public", body: submitResponseSchema },

  /* ── тревоги, направления, заключения ── */
  "GET /api/alerts": { summary: "Тревоги риска по пунктам; ?all=1 — вместе с разобранными", access: "staff" },
  "GET /api/unit-report": { summary: "Состояние подразделения за период; малые ячейки подавляются", access: "staff" },
  "GET /api/unit-report/units": { summary: "Подразделения для отчёта", access: "staff" },
  "GET /api/worklist": { summary: "Что от меня ждут сегодня: случаи, направления, просроченные назначения", access: "staff" },
  "GET /api/alert-cases": { summary: "Случаи риска: страница с курсором и фильтрами", access: "staff" },
  "GET /api/alert-cases/units": { summary: "Подразделения среди случаев — для фильтра", access: "staff" },
  "GET /api/alert-cases/:id/history": { summary: "Кто и что делал со случаем — выборка из журнала доступа", access: "staff" },
  "POST /api/alert-cases/:id/assign": { summary: "Взять случай на себя или отпустить", access: "staff" },
  "PATCH /api/alert-cases/:id": { summary: "Разбор случая: одно решение о человеке", access: "staff" },
  "GET /api/referrals": { summary: "Направления; ?all=1 — вместе с завершёнными", access: "staff" },
  "POST /api/referrals": { summary: "Выписать направление", access: "staff", body: createReferralSchema },
  "PATCH /api/referrals/:id": { summary: "Движение статуса направления (только вперёд)", access: "staff", body: updateReferralSchema },
  "GET /api/referrals/summary/:userId": { summary: "Сводка для консилиума", access: "staff" },
  "GET /api/conclusions/responses/:id/conclusion": { summary: "Заключение по прохождению", access: "staff" },
  "PUT /api/conclusions/responses/:id/conclusion": { summary: "Черновик заключения", access: "staff" },
  "POST /api/conclusions/responses/:id/conclusion/sign": { summary: "Подпись заключения — фиксирует снапшот", access: "staff" },

  /* ── аналитика ── */
  "GET /api/analytics/overview": { summary: "Сводка по всем методикам", access: "staff" },
  "GET /api/analytics/surveys/:id": { summary: "Аналитика методики: распределения, психометрика, воронка", access: "staff" },
  "GET /api/analytics/surveys/:id/export": { summary: "Выгрузка прохождений методики", access: "staff" },
  "GET /api/dynamics/respondents": { summary: "Обследуемые с повторными замерами", access: "staff" },
  "GET /api/dynamics/respondents/:userId": { summary: "Динамика обследуемого с метками RCI", access: "staff" },
  "GET /api/compare/surveys/:id": { summary: "Сравнение когорт по методике", access: "staff" },
  "GET /api/compare/surveys/:id/correlations": { summary: "Корреляции шкал", access: "staff" },
  "GET /api/facets/surveys/:id": { summary: "Срезы по полу и возрасту", access: "staff" },
  "GET /api/surveillance/surveys/:id": { summary: "Надзор: контрольные карты и стандартизованные показатели", access: "staff" },
  "GET /api/dif/surveys/:id": { summary: "Дифференциальное функционирование пунктов по полу", access: "staff" },
  "GET /api/calibration/surveys/:id": { summary: "Калибровка порогов по подтверждённым исходам (ROC)", access: "staff" },
  "GET /api/calibration/ppv": { summary: "Прогностическая ценность тревог", access: "staff" },
  "GET /api/data-quality/surveys/:id": { summary: "Дрейф выборки, отсев по стратам, тест-ретест", access: "staff" },
  "GET /api/norms/surveys/:id/candidates": { summary: "Кандидатные локальные нормы по выборке", access: "staff" },
  "POST /api/norms/surveys/:id/apply": { summary: "Публикация локальных норм", access: "staff" },
  "GET /api/norms/surveys/:id/age-curves": { summary: "Возрастные кривые по шкалам", access: "staff" },

  /* ── выгрузка для статпакетов ── */
  "GET /api/spss/surveys/:id/data.csv": { summary: "Данные в широком формате", access: "staff" },
  "GET /api/spss/surveys/:id/syntax.sps": { summary: "Синтаксис SPSS под выгрузку", access: "staff" },
  "GET /api/spss/surveys/:id/codebook.csv": { summary: "Кодовая книга переменных", access: "staff" },
  "GET /api/spss/surveys/:id/long.csv": { summary: "Данные в длинном формате для R и Python", access: "staff" },

  /* ── администрирование ── */
  "GET /api/users": { summary: "Учётные записи", access: "superadmin" },
  "POST /api/users": { summary: "Создание учётной записи", access: "superadmin", body: createUserSchema },
  "PATCH /api/users/:id/role": { summary: "Смена роли", access: "superadmin" },
  "GET /api/audit": { summary: "Журнал доступа", access: "superadmin" },
  "GET /api/audit/summary": { summary: "Сводка по журналу", access: "superadmin" },
  "GET /api/audit/verify": { summary: "Проверка хэш-цепочки журнала", access: "superadmin" },
  "GET /api/stats/storage": { summary: "Размеры таблиц и рост журнала", access: "superadmin" },
  "GET /api/timeline/:userId": { summary: "Хронология пациента: всё на одной оси", access: "staff" },
  "GET /api/events": { summary: "Поток событий (SSE): тревоги и изменения случаев", access: "staff" },
  "GET /api/pathways": { summary: "Шаблоны маршрутов помощи", access: "staff" },
  "POST /api/pathways": { summary: "Завести шаблон маршрута", access: "staff" },
  "POST /api/pathways/:id/start": { summary: "Поставить пациента на маршрут", access: "staff" },
  "GET /api/pathways/instances": { summary: "Кто на маршрутах: просроченные сверху", access: "staff" },
  "GET /api/pathways/instances/:id": { summary: "Маршрут пациента по шагам", access: "staff" },
  "POST /api/pathways/instances/:id/close": { summary: "Закрыть маршрут с исходом", access: "staff" },
  "PATCH /api/pathways/progress/:id": { summary: "Отметить шаг маршрута", access: "staff" },
  "GET /api/views": { summary: "Сохранённые виды экрана: свои и общие", access: "staff" },
  "POST /api/views": { summary: "Сохранить текущий срез экрана", access: "staff" },
  "PATCH /api/views/:id": { summary: "Переименовать вид или открыть его коллегам", access: "staff" },
  "DELETE /api/views/:id": { summary: "Удалить свой вид", access: "staff" },
  "GET /api/openapi.json": { summary: "Это описание", access: "staff" },

  /* ── согласие ── */
  "GET /api/consents/text": { summary: "Действующий текст согласия", access: "public" },
  "PUT /api/consents/text": { summary: "Новая версия текста согласия", access: "superadmin" },
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
