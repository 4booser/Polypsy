/**
 * Справочник прав.
 *
 * Константа в коде, а не таблица в базе. Новое право всё равно требует новой
 * строки проверки в маршруте — то есть выкладки, — и таблица была бы вторым
 * источником истины: список в базе разъезжался бы с тем, что код умеет
 * проверять, и разъезд был бы не виден.
 *
 * Литеральный union даёт то, ради чего это и затевалось: опечатка в коде
 * права не доживает до боя, её находит компилятор.
 *
 * Роли и их наборы прав, наоборот, живут в базе: они меняются в учреждении,
 * а не в коде. Здесь только словарь того, что вообще бывает.
 */

export const PERMISSION_GROUPS = [
  {
    code: "clinic",
    title: { uk: "Клінічна робота", ru: "Клиническая работа" },
    permissions: [
      "patients.read",
      "notes.write",
      "conclusions.write",
      "conclusions.sign",
      "referrals.manage",
      "pathways.manage",
      "goals.manage",
      "safety.manage",
      "conferences.manage",
      "informants.manage",
    ],
  },
  {
    code: "risk",
    title: { uk: "Тривоги та чергування", ru: "Тревоги и дежурство" },
    permissions: ["alerts.review", "duty.take", "emergency.breakGlass"],
  },
  {
    code: "measure",
    title: { uk: "Вимірювання", ru: "Измерения" },
    permissions: [
      "surveys.read",
      "surveys.edit",
      "surveys.publish",
      "batteries.manage",
      "schedules.manage",
      "assignments.manage",
      "kiosk.manage",
      "invites.manage",
      "administer",
      "norms.manage",
    ],
  },
  {
    code: "analysis",
    title: { uk: "Розбір і вивантаження", ru: "Разбор и выгрузки" },
    permissions: [
      "analytics.read",
      "cohorts.read",
      "unitReport.read",
      "export.deidentified",
      "export.full",
    ],
  },
  {
    code: "admin",
    title: { uk: "Адміністрування", ru: "Администрирование" },
    permissions: ["users.manage", "groups.manage", "audit.read", "decisions.manage"],
  },
] as const;

export type PermissionGroupCode = (typeof PERMISSION_GROUPS)[number]["code"];
export type Permission = (typeof PERMISSION_GROUPS)[number]["permissions"][number];

/** Все права одним списком — для проверок полноты и бэкфилла. */
export const ALL_PERMISSIONS: readonly Permission[] = PERMISSION_GROUPS.flatMap(
  (g) => g.permissions as readonly Permission[],
);

/**
 * Права, которые осмысленно выдавать поштучно, отдельно от роли.
 *
 * Личное исключение — механизм на весь справочник, но осмысленных случаев
 * всего три, и экран прав показывает быстрыми кнопками именно их. Право,
 * которое просят единожды и оставляют навсегда, исключением быть не должно:
 * через год оно неотличимо от роли, а разбирать надо будет именно
 * исключения.
 *
 * — подпись заключений: стажёр ведёт приёмы, но не подписывает;
 * — редактор методик: ошибка в ключе портит ВСЕ будущие измерения;
 * — дежурство и разбитое стекло: временная нагрузка, а не свойство
 *   должности, и срок исключения совпадает со сменой.
 */
export const EXCEPTION_PERMISSIONS: readonly Permission[] = [
  "conclusions.sign",
  "surveys.edit",
  "duty.take",
  "emergency.breakGlass",
];

/** Пояснение к праву на двух языках: экран прав объясняет, а не перечисляет. */
export const PERMISSION_TITLES: Record<Permission, { uk: string; ru: string }> = {
  "patients.read": { uk: "Бачити пацієнтів і їхню динаміку", ru: "Видеть пациентов и их динамику" },
  "notes.write": { uk: "Вести записи прийому", ru: "Вести записи приёма" },
  "conclusions.write": { uk: "Готувати висновки", ru: "Готовить заключения" },
  "conclusions.sign": { uk: "Підписувати висновки", ru: "Подписывать заключения" },
  "referrals.manage": { uk: "Виписувати й вести направлення", ru: "Выписывать и вести направления" },
  "pathways.manage": { uk: "Вести маршрути допомоги", ru: "Вести маршруты помощи" },
  "goals.manage": { uk: "Ставити цілі лікування", ru: "Ставить цели лечения" },
  "safety.manage": { uk: "Складати план безпеки", ru: "Составлять план безопасности" },
  "conferences.manage": { uk: "Виносити на консиліум", ru: "Выносить на консилиум" },
  "informants.manage": { uk: "Запитувати погляд збоку", ru: "Запрашивать взгляд со стороны" },

  "alerts.review": { uk: "Розбирати випадки ризику", ru: "Разбирать случаи риска" },
  "duty.take": { uk: "Заступати на чергування", ru: "Заступать на дежурство" },
  "emergency.breakGlass": {
    uk: "Відкривати доступ поза своєю групою в невідкладній ситуації",
    ru: "Открывать доступ вне своей группы в неотложной ситуации",
  },

  "surveys.read": { uk: "Бачити методики", ru: "Видеть методики" },
  "surveys.edit": { uk: "Редагувати методики та ключі підрахунку", ru: "Редактировать методики и ключи подсчёта" },
  "surveys.publish": { uk: "Публікувати та знімати методики", ru: "Публиковать и снимать методики" },
  "batteries.manage": { uk: "Складати батареї", ru: "Составлять батареи" },
  "schedules.manage": { uk: "Вести розклад повторів", ru: "Вести расписание повторов" },
  "assignments.manage": { uk: "Призначати методики й давати доступ", ru: "Назначать методики и давать доступ" },
  "kiosk.manage": { uk: "Вести сеанси кіоску", ru: "Вести сеансы киоска" },
  "invites.manage": { uk: "Створювати запрошення", ru: "Создавать приглашения" },
  "administer": { uk: "Заповнювати методику за пацієнта", ru: "Заполнять методику за пациента" },
  "norms.manage": { uk: "Вести локальні норми", ru: "Вести локальные нормы" },

  "analytics.read": { uk: "Дивитися аналітику методик", ru: "Смотреть аналитику методик" },
  "cohorts.read": { uk: "Збирати когорти", ru: "Собирать когорты" },
  "unitReport.read": { uk: "Бачити стан підрозділу", ru: "Видеть состояние подразделения" },
  "export.deidentified": { uk: "Вивантажувати знеособлені дані", ru: "Выгружать обезличенные данные" },
  "export.full": { uk: "Вивантажувати дані з іменами", ru: "Выгружать данные с именами" },

  "users.manage": { uk: "Вести облікові записи", ru: "Вести учётные записи" },
  "groups.manage": { uk: "Вести групи та їхніх адміністраторів", ru: "Вести группы и их администраторов" },
  "audit.read": { uk: "Читати журнал доступу", ru: "Читать журнал доступа" },
  "decisions.manage": { uk: "Вмикати кризовий режим", ru: "Включать кризисный режим" },
};

/**
 * Набор прав встроенной роли «Психолог».
 *
 * Ровно то, что сегодня может администратор группы. Нужен, чтобы бэкфилл не
 * изменил поведение ни одной действующей учётной записи: сегодня «админ
 * группы» означает «всё, кроме суперадминских вещей», и роль обязана
 * означать то же самое — иначе переход на права начнётся с того, что у людей
 * пропадут возможности, которыми они пользовались вчера.
 */
export const PSYCHOLOGIST_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (p) => !["users.manage", "groups.manage", "audit.read", "decisions.manage"].includes(p),
);
