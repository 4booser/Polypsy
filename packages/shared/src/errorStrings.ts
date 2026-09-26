import type { Lang } from "./types";

/**
 * Тексты отказов сервера.
 *
 * Отдельный файл, а не общий словарь интерфейса: у них разная жизнь. Строки
 * интерфейса зовёт клиент и подставляет в разметку, эти — отдаёт сервер уже
 * готовым текстом, и на клиенте их никто не ищет по ключу. Держать их вместе
 * значило бы, что половина полуторатысячного словаря никогда не нужна тому,
 * кто в него смотрит.
 *
 * Почему перевод на сервере, а не коды наружу. Клиент всё равно показывает
 * отказ как есть — переформатировать его негде. Коды потребовали бы второй
 * словарь на клиенте и договор о наборе кодов между двумя приложениями;
 * выигрыш был бы только в теории. Язык сервер и так знает: он уже выбирает
 * по нему содержимое методик.
 *
 * Подстановки помечены фигурными скобками: «{title}». Их немного и они
 * всегда одного рода — название методики, имя шкалы, число, — поэтому
 * форматирования сложнее подстановки здесь нет и не нужно.
 *
 * Английский здесь обязателен с первого дня, в отличие от словаря оболочки
 * (там он необязателен на время перевода). Отказов двести, а не две с
 * половиной тысячи, — и именно отказ человек с английским интерфейсом
 * читает в самый неудобный момент: что-то не получилось, и надо понять что.
 * Украинский отказ на английском экране — ровно та половинчатость, от
 * которой этот файл когда-то и заводили (см. «Отказы сервера — на языке
 * того, кто их читает»).
 *
 * Словарь английских терминов, чтобы переводы не разъезжались:
 * методика — assessment; набор — battery; прохождение — response;
 * заключение — conclusion; направление — referral; случай (риска) — (risk)
 * case; обращение — episode of care; приём — appointment; справка —
 * certificate; специалист — clinician; учётная запись под кодом — coded
 * account; шкала — scale; полоса — band.
 */
export interface ErrorEntry {
  uk: string;
  ru: string;
  en: string;
}

export const ERRORS = {
  /* общее */
  "err.auth": { uk: "Потрібна авторизація", ru: "Требуется авторизация", en: "Please sign in" },
  "err.forbidden": { uk: "Недостатньо прав", ru: "Недостаточно прав", en: "You don’t have permission to do this" },
  "err.notFound": { uk: "Не знайдено", ru: "Не найдено", en: "Not found" },
  "err.routeNotFound": { uk: "Маршрут не знайдено", ru: "Маршрут не найден", en: "Route not found" },
  "err.internal": { uk: "Внутрішня помилка сервера", ru: "Внутренняя ошибка сервера", en: "Internal server error" },
  "err.tooLarge": { uk: "Занадто великий запит", ru: "Слишком большой запрос", en: "Request is too large" },
  "err.jsonExpected": {
    uk: "Очікується JSON-тіло запиту",
    ru: "Ожидается JSON-тело запроса",
    en: "Expected a JSON request body",
  },

  /* отказы маршрутов */
  "err.readOnlyAccount": {
    uk: "Обліковий запис працює лише на перегляд",
    ru: "Учётная запись работает только на просмотр",
    en: "This account is read-only",
  },
  "err.staffOnly": {
    uk: "Доступно лише співробітникам",
    ru: "Доступно только сотрудникам",
    en: "Available to staff only",
  },
  "err.superadminOnly": {
    uk: "Доступно лише суперадміністратору",
    ru: "Доступно только суперадминистратору",
    en: "Available to the super administrator only",
  },
  "err.tokenInvalid": {
    uk: "Токен недійсний або прострочений",
    ru: "Токен недействителен или истёк",
    en: "Token is invalid or has expired",
  },
  "err.userNotFound": { uk: "Користувача не знайдено", ru: "Пользователь не найден", en: "User not found" },

  /* отказы маршрутов */
  "err.alreadyTaken": {
    uk: "Ви вже проходили цю методику",
    ru: "Вы уже проходили эту методику",
    en: "You have already completed this assessment",
  },
  "err.anonymousNoDraft": {
    uk: "Анонімна методика не зберігає чернетки",
    ru: "Анонимная методика не сохраняет черновики",
    en: "Anonymous assessments don’t save drafts",
  },
  "err.batteryAccessDenied": {
    uk: "Немає доступу до набору",
    ru: "Нет доступа к набору",
    en: "You don’t have access to this battery",
  },
  "err.batteryArchived": { uk: "Набір в архіві", ru: "Набор в архиве", en: "This battery is archived" },
  "err.batteryNotFound": { uk: "Набір не знайдено", ru: "Набор не найден", en: "Battery not found" },
  "err.consentTextNotConfigured": {
    uk: "Текст згоди не налаштовано",
    ru: "Текст согласия не настроен",
    en: "The consent text hasn’t been set up",
  },
  "err.deviceNotFound": { uk: "Пристрій не знайдено", ru: "Устройство не найдено", en: "Device not found" },
  "err.deviceNotFoundOrWiped": {
    uk: "Пристрій не знайдено або вже стерто",
    ru: "Устройство не найдено или уже стёрто",
    en: "Device not found or already wiped",
  },
  "err.devicesNotFound": { uk: "Пристрої не знайдено", ru: "Устройства не найдены", en: "Devices not found" },
  "err.importParseFailed": {
    uk: "Файл не розібрано: {path}: {message}",
    ru: "Файл не разобран: {path}: {message}",
    en: "Couldn’t read the file: {path}: {message}",
  },
  "err.invalidDate": { uk: "Некоректна дата: {title}", ru: "Некорректная дата: {title}", en: "Invalid date: {title}" },
  "err.invalidMatrixOption": {
    uk: "Неприпустимий варіант у матриці: {title}",
    ru: "Недопустимый вариант в матрице: {title}",
    en: "Invalid option in the matrix: {title}",
  },
  "err.invalidMatrixRow": {
    uk: "Неприпустимий рядок матриці: {title}",
    ru: "Недопустимая строка матрицы: {title}",
    en: "Invalid matrix row: {title}",
  },
  "err.invalidOption": {
    uk: "Неприпустимий варіант відповіді: {title}",
    ru: "Недопустимый вариант ответа: {title}",
    en: "Invalid answer option: {title}",
  },
  "err.invalidRankingOption": {
    uk: "Неприпустимий варіант у ранжуванні: {title}",
    ru: "Недопустимый вариант в ранжировании: {title}",
    en: "Invalid option in the ranking: {title}",
  },
  "err.jsonExportExpected": {
    uk: "Очікується JSON файлу експорту",
    ru: "Ожидается JSON файла экспорта",
    en: "Expected a JSON export file",
  },
  "err.onBehalfPatientOnly": {
    uk: "Заповнювати можна лише за пацієнта",
    ru: "Заполнять можно только за пациента",
    en: "You can only fill this in on behalf of a patient",
  },
  "err.onBehalfRequired": {
    uk: "Для цієї методики потрібно вказати пацієнта, за якого вона заповнюється",
    ru: "Для этой методики нужно указать пациента, за которого она заполняется",
    en: "This assessment requires you to specify the patient it’s being filled in for",
  },
  "err.onBehalfStaffOnly": {
    uk: "Заповнювати за іншу людину може лише співробітник",
    ru: "Заполнять за другого может только сотрудник",
    en: "Only staff can fill this in on someone else’s behalf",
  },
  "err.patientOfAnotherDepartment": {
    uk: "Пацієнт прикріплений до іншого відділення — запис узгоджують із ним",
    ru: "Пациент прикреплён к другому отделению — запись согласуют с ним",
    en: "The patient is registered with another department — the booking needs its approval",
  },
  "err.patientNotFound": { uk: "Пацієнта не знайдено", ru: "Пациент не найден", en: "Patient not found" },
  "err.rankingDuplicates": {
    uk: "У ранжуванні є повтори: {title}",
    ru: "В ранжировании есть повторы: {title}",
    en: "The ranking has duplicates: {title}",
  },
  "err.requiredUnanswered": {
    uk: "Не дано відповідь на обов’язкове питання: {title}",
    ru: "Не отвечен обязательный вопрос: {title}",
    en: "A required question is unanswered: {title}",
  },
  "err.responseNotFound": { uk: "Проходження не знайдено", ru: "Прохождение не найдено", en: "Response not found" },
  "err.responseOwnerOrStaffOnly": {
    uk: "Доступно лише автору проходження або співробітнику",
    ru: "Доступно только автору прохождения или сотруднику",
    en: "Available only to the respondent or to staff",
  },
  "err.rightsSuperadminOnly": {
    uk: "Правовий статус змінює суперадміністратор",
    ru: "Правовой статус меняет суперадмин",
    en: "Only the super administrator can change the rights status",
  },
  "err.scaleGroupTooSmall": {
    uk: "Шкала «{code}»: жодна статева група не набрала {minGroup} спостережень — публікувати нема чого",
    ru: "Шкала «{code}»: ни одна половая группа не набрала {minGroup} наблюдений — публиковать нечего",
    en: "Scale “{code}”: no sex group has reached {minGroup} observations — nothing to publish",
  },
  "err.scaleNotFoundOrNotTscore": {
    uk: "Шкалу «{code}» не знайдено або вона не використовує T-бали",
    ru: "Шкала «{code}» не найдена или не использует T-баллы",
    en: "Scale “{code}” not found or doesn’t use T-scores",
  },
  "err.scriptNotFound": { uk: "Такого скрипту немає", ru: "Такого скрипта нет", en: "No such script" },
  "err.singleChoiceOnly": {
    uk: "Можна вибрати лише один варіант: {title}",
    ru: "Можно выбрать только один вариант: {title}",
    en: "Only one option can be selected: {title}",
  },
  "err.staffFillsOnly": {
    uk: "Методику заповнює фахівець, а не респондент",
    ru: "Методику заполняет специалист, а не респондент",
    en: "This assessment is completed by a clinician, not by the respondent",
  },
  "err.surveyAlreadyArchived": {
    uk: "Методику вже знято з використання",
    ru: "Методика уже снята с использования",
    en: "This assessment has already been retired",
  },
  "err.surveyArchived": {
    uk: "Методику знято з використання",
    ru: "Методика снята с использования",
    en: "This assessment has been retired",
  },
  "err.surveyNotArchived": {
    uk: "Методика і так у роботі",
    ru: "Методика и так в работе",
    en: "This assessment is already in use",
  },
  "err.surveyNotAvailable": { uk: "Методика недоступна", ru: "Методика недоступна", en: "Assessment not available" },
  "err.surveyNotAvailableToTake": {
    uk: "Методика недоступна для проходження",
    ru: "Методика недоступна для прохождения",
    en: "This assessment isn’t available to take",
  },
  "err.surveyNotFound": { uk: "Методику не знайдено", ru: "Методика не найдена", en: "Assessment not found" },
  "err.surveyPublishErrors": {
    uk: "Методику не можна опублікувати: {count} структурних помилок. {details}",
    ru: "Методику нельзя опубликовать: {count} структурных ошибок. {details}",
    en: "The assessment can’t be published: {count} structural errors. {details}",
  },
  "err.surveyVersionNotFound": { uk: "Версію не знайдено", ru: "Версия не найдена", en: "Version not found" },
  /*
   * Папки методик — полки каталога внутри группы. Отказы названы по папке,
   * а не по группе: «Групу не знайдено» на экране каталога отправило бы
   * специалиста искать группу методик, а дело в полке.
   */
  "err.surveyFolderNotFound": { uk: "Папку не знайдено", ru: "Папка не найдена", en: "Folder not found" },
  "err.surveyFolderNotEmpty": {
    uk: "Папка не порожня ({details}). Спочатку перенесіть вміст",
    ru: "Папка не пуста ({details}). Сначала перенесите содержимое",
    en: "The folder isn’t empty ({details}). Move its contents out first",
  },
  "err.surveyFolderCycle": {
    uk: "Папку не можна вкласти в саму себе чи у власну підпапку",
    ru: "Папку нельзя вложить в саму себя или в собственную подпапку",
    en: "A folder can’t be placed inside itself or one of its own subfolders",
  },
  "err.surveyFolderOtherGroup": {
    uk: "Папка і те, що в неї кладуть, мають належати одній групі методик",
    ru: "Папка и то, что в неё кладут, должны относиться к одной группе методик",
    en: "A folder and what goes into it must belong to the same assessment group",
  },
  "err.unknownFormatVersion": {
    uk: "Невідома версія формату: {version}. Ця збірка розуміє версію 1",
    ru: "Неизвестная версия формата: {version}. Эта сборка понимает версию 1",
    en: "Unknown format version: {version}. This build understands version 1",
  },
  "err.valueOutOfRange": {
    uk: "Значення поза діапазоном {min}–{max}: {title}",
    ru: "Значение вне диапазона {min}–{max}: {title}",
    en: "Value out of range {min}–{max}: {title}",
  },
  "err.viewDeleteOwnerOnly": {
    uk: "Чужий вигляд видаляє лише його власник",
    ru: "Чужой вид удаляет только его владелец",
    en: "Only the owner can delete this view",
  },
  "err.viewEditOwnerOnly": {
    uk: "Чужий вигляд редагує лише його власник",
    ru: "Чужой вид правит только его владелец",
    en: "Only the owner can edit this view",
  },
  "err.viewNameTaken": {
    uk: "Вигляд із такою назвою вже збережено",
    ru: "Вид с таким названием уже сохранён",
    en: "A view with this name is already saved",
  },
  "err.viewNotFound": { uk: "Вигляд не знайдено", ru: "Вид не найден", en: "View not found" },

  /* отказы маршрутов */
  "err.assignOnlyToPatient": {
    uk: "Призначати методику має сенс лише пацієнту — співробітники бачать її і так",
    ru: "Назначать методику имеет смысл только пациенту — сотрудники видят её и так",
    en: "Assessments only need to be assigned to patients — staff can already see them",
  },
  "err.assignStaffOnly": {
    uk: "Призначити можна лише співробітника — спочатку надайте роль адміністратора",
    ru: "Назначить можно только сотрудника — сначала выдайте роль администратора",
    en: "Only a staff member can be assigned — grant the administrator role first",
  },
  "err.assignmentNotFound": { uk: "Призначення не знайдено", ru: "Назначение не найдено", en: "Assignment not found" },
  "err.batteryEmpty": {
    uk: "У наборі немає методик",
    ru: "В наборе нет методик",
    en: "The battery contains no assessments",
  },
  "err.batteryHasAssignments": {
    uk: "Набір призначали {count} разів. Видалення стерло б історію призначень — здайте його в архів",
    ru: "Набор назначался {count} раз. Удаление стёрло бы историю назначений — сдайте его в архив",
    en: "This battery has been assigned {count} times. Deleting it would erase the assignment history — archive it instead",
  },
  "err.batteryStrictOrder": {
    uk: "У наборі «{battery}» встановлено суворий порядок: спочатку потрібно пройти «{title}»",
    ru: "В наборе «{battery}» задан строгий порядок: сначала нужно пройти «{title}»",
    en: "Battery “{battery}” has a strict order: complete “{title}” first",
  },
  "err.cannotChangeOwnRole": {
    uk: "Не можна змінити власну роль",
    ru: "Нельзя изменить собственную роль",
    en: "You can’t change your own role",
  },
  "err.caseAlreadyHandled": {
    uk: "Випадок вже розібрано",
    ru: "Случай уже разобран",
    en: "This case has already been reviewed",
  },
  "err.caseNotFound": { uk: "Випадок не знайдено", ru: "Случай не найден", en: "Case not found" },
  "err.caseTakenByOther": {
    uk: "Випадок вже взятий іншим фахівцем",
    ru: "Случай уже взят другим специалистом",
    en: "Another clinician has already taken this case",
  },
  "err.cohortNotFound": { uk: "Когорту не знайдено", ru: "Когорта не найдена", en: "Cohort not found" },
  "err.conclusionAccessDenied": {
    uk: "Висновок доступний пацієнту або співробітнику",
    ru: "Заключение доступно пациенту или сотруднику",
    en: "The conclusion is available to the patient or to staff",
  },
  "err.conclusionChanged": {
    uk: "Висновок змінився: зараз версія {current}, а правка велася поверх {base}. Оновіть текст.",
    ru: "Заключение изменилось: сейчас версия {current}, а правка велась поверх {base}. Обновите текст.",
    en: "The conclusion has changed: it’s now at version {current}, but you were editing version {base}. Refresh the text.",
  },
  "err.conclusionNotYet": { uk: "Висновку ще немає", ru: "Заключения ещё нет", en: "There’s no conclusion yet" },
  "err.conclusionTextChangedAfterOpen": {
    uk: "Текст змінився після відкриття: зараз версія {current}, підписувалася {signing}. Перечитайте висновок.",
    ru: "Текст изменился после открытия: сейчас версия {current}, подписывалась {signing}. Перечитайте заключение.",
    en: "The text changed after you opened it: it’s now at version {current}, but you were signing version {signing}. Read the conclusion again.",
  },
  "err.declineNeedsNote": {
    uk: "Відхилення пропозиції потрібно пояснити",
    ru: "Отклонение предложения нужно объяснить",
    en: "Please explain why you’re declining the suggestion",
  },
  "err.emailExists": {
    uk: "Користувач із такою поштою вже існує",
    ru: "Пользователь с таким email уже существует",
    en: "A user with this email already exists",
  },
  "err.examineeNotFound": { uk: "Обстежуваного не знайдено", ru: "Обследуемый не найден", en: "Examinee not found" },
  "err.forStaffOnly": { uk: "Лише для персоналу", ru: "Только для персонала", en: "Staff only" },
  "err.groupNotEmpty": {
    uk: "Група не порожня ({details}). Перенесіть вміст до іншої групи — видалення забрало б із собою набори разом з історією призначень",
    ru: "Группа не пуста ({details}). Перенесите содержимое в другую группу — удаление утащило бы за собой наборы вместе с историей назначений",
    en: "The group isn’t empty ({details}). Move its contents to another group — deleting it would take the batteries and their assignment history with it",
  },
  "err.groupNotFound": { uk: "Групу не знайдено", ru: "Группа не найдена", en: "Group not found" },
  "err.groupNotManaged": {
    uk: "Ви не керуєте цією групою",
    ru: "Вы не управляете этой группой",
    en: "You don’t manage this group",
  },
  /*
   * Отказы групп ПАЦИЕНТОВ. Названы иначе, чем отказы групп методик выше, и
   * это не педантизм: специалист, получивший «Группа не найдена» на экране
   * своих вкладок, пошёл бы искать её среди групп методик — а там её нет и
   * быть не может.
   *
   * «Не найдена» вместо «чужая» — по тому же правилу, что и у пациентов:
   * ответ «нельзя» подтвердил бы, что такая группа в системе есть, а по коду
   * отказа этого узнавать не следует.
   */
  "err.patientGroupNotFound": {
    uk: "Групу пацієнтів не знайдено",
    ru: "Группа пациентов не найдена",
    en: "Patient group not found",
  },
  "err.patientGroupMemberNotFound": {
    uk: "Цього пацієнта немає у складі групи",
    ru: "Этого пациента нет в составе группы",
    en: "This patient isn’t a member of the group",
  },
  "err.patientGroupEmpty": {
    uk: "У групі немає жодного пацієнта: призначати нема кому",
    ru: "В группе нет ни одного пациента: назначать некому",
    en: "The group has no patients: there’s no one to assign to",
  },
  /*
   * Отказы раздела «Статистика». «Не найдено» вместо «чужой» — по тому же
   * правилу, что у групп пациентов: пресет и модель личные, и 403
   * подтвердил бы, что коллега такое завёл.
   */
  "err.filterPresetNotFound": {
    uk: "Пресет фільтрів не знайдено",
    ru: "Пресет фильтров не найден",
    en: "Filter preset not found",
  },
  "err.filterPresetInUse": {
    uk: "Пресет використовують статистичні моделі ({count}). Спочатку відв’яжіть його від них",
    ru: "Пресет используют статистические модели ({count}). Сначала отвяжите его от них",
    en: "Statistical models use this filter preset ({count}). Detach it from them first",
  },
  "err.statModelNotFound": {
    uk: "Статистичну модель не знайдено",
    ru: "Статистическая модель не найдена",
    en: "Statistical model not found",
  },
  "err.statModelVersionNotFound": {
    uk: "Версія не належить цій методиці",
    ru: "Версия не принадлежит этой методике",
    en: "This version doesn’t belong to the assessment",
  },
  "err.statModelSurveyEmpty": {
    uk: "У методики ще немає жодної версії: рахувати нема по чому",
    ru: "У методики ещё нет ни одной версии: считать не по чему",
    en: "The assessment has no versions yet: there’s nothing to calculate from",
  },
  "err.statModelIndicatorUnknown": {
    uk: "Показника немає у цій версії методики: {what}",
    ru: "Показателя нет в этой версии методики: {what}",
    en: "This version of the assessment has no such measure: {what}",
  },
  /*
   * Не отказы, а причины пустых мест в отчёте: подавление — тот же отказ
   * печатать число, и живёт он там же, где остальные. Иначе пришлось бы
   * заводить второй словарь на две строки и второй порядок их перевода.
   */
  "err.statColumnSmall": {
    uk: "Замало респондентів: числа за цією вибіркою не показуємо",
    ru: "Слишком мало респондентов: числа по этой выборке не показываем",
    en: "Too few respondents: figures for this sample are not shown",
  },
  "err.statColumnClosed": {
    uk: "Числа цієї колонки разом із сусідніми відновлюють окремих людей — колонку закрито",
    ru: "Числа этой колонки вместе с соседними восстанавливают отдельных людей — колонка закрыта",
    en: "Together with the neighbouring columns, the figures in this column would identify individuals — the column is hidden",
  },
  "err.statFiguresHidden": {
    uk: "Приховано показників: {count} — інакше решта чисел звіту називає окремих людей",
    ru: "Скрыто показателей: {count} — иначе остальные числа отчёта называют отдельных людей",
    en: "Figures hidden: {count} — otherwise the remaining figures in the report would identify individuals",
  },
  "err.statModelQuestionType": {
    uk: "Показник за питанням можливий лише для питань із варіантами відповіді: «{title}»",
    ru: "Показатель по вопросу возможен только для вопросов с вариантами ответа: «{title}»",
    en: "A question-based measure is only possible for questions with answer options: “{title}”",
  },
  "err.hitAlreadyDecided": {
    uk: "Рішення щодо цієї пропозиції вже ухвалено",
    ru: "Решение по этому предложению уже принято",
    en: "A decision on this suggestion has already been made",
  },
  "err.hitNotFound": { uk: "Спрацьовування не знайдено", ru: "Срабатывание не найдено", en: "Rule trigger not found" },
  "err.invalidCredentials": {
    uk: "Неправильний email або пароль",
    ru: "Неверный email или пароль",
    en: "Incorrect email or password",
  },
  /* вход через Google */
  "err.googleDisabled": {
    uk: "Вхід через Google не налаштовано",
    ru: "Вход через Google не настроен",
    en: "Sign-in with Google isn’t set up",
  },
  "err.googleState": {
    uk: "Сеанс входу застарів — почніть спочатку",
    ru: "Сеанс входа устарел — начните заново",
    en: "The sign-in session has expired — please start again",
  },
  "err.googleExchange": {
    uk: "Google не підтвердив вхід",
    ru: "Google не подтвердил вход",
    en: "Google didn’t confirm the sign-in",
  },
  "err.googleUnverified": {
    uk: "Пошту в Google не підтверджено",
    ru: "Почта в Google не подтверждена",
    en: "The Google email address isn’t verified",
  },
  "err.googleDomain": {
    uk: "Цей поштовий домен не допущено",
    ru: "Этот почтовый домен не допущен",
    en: "This email domain isn’t allowed",
  },
  /*
   * Один и тот же текст и для «такого человека нет», и для «есть, но Google
   * не связан»: иначе по ответу можно перебирать, кто в учреждении есть.
   */
  "err.googleNotLinked": {
    uk: "Цей обліковий запис Google не прив’язано. Увійдіть паролем і прив’яжіть його в профілі.",
    ru: "Эта учётная запись Google не привязана. Войдите паролем и привяжите её в профиле.",
    en: "This Google account isn’t linked. Sign in with your password and link it in your profile.",
  },
  "err.googleTaken": {
    uk: "Цей обліковий запис Google вже прив’язано до іншого",
    ru: "Эта учётная запись Google уже привязана к другой",
    en: "This Google account is already linked to another account",
  },
  "err.googleAnonymous": {
    uk: "Обліковий запис під кодом не можна прив’язати до Google: це поверне до нього справжнє ім’я",
    ru: "Учётную запись под кодом нельзя привязать к Google: это вернёт в неё настоящее имя",
    en: "A coded account can’t be linked to Google: that would bring the real name back into it",
  },
  "err.invalidRole": {
    uk: "Допустимі ролі: superadmin, admin, user",
    ru: "Допустимые роли: superadmin, admin, user",
    en: "Allowed roles: superadmin, admin, user",
  },
  "err.inviteExhausted": {
    uk: "Запрошення вже використано",
    ru: "Приглашение уже использовано",
    en: "This invitation has already been used",
  },
  "err.inviteBatteryOrSurvey": {
    uk: "У запрошенні або набір, або методика — не одночасно",
    ru: "В приглашении либо набор, либо методика — не одновременно",
    en: "An invitation carries either a battery or an assessment — not both",
  },
  "err.specialistNotFound": { uk: "Фахівця не знайдено", ru: "Специалист не найден", en: "Clinician not found" },
  "err.inviteExpired": {
    uk: "Строк дії запрошення сплив — попросіть нове у свого фахівця",
    ru: "Срок приглашения истёк — попросите новое у своего специалиста",
    en: "This invitation has expired — ask your clinician for a new one",
  },
  "err.inviteInvalid": {
    uk: "Запрошення недійсне",
    ru: "Приглашение не действует",
    en: "This invitation is no longer valid",
  },
  "err.inviteNotFound": { uk: "Запрошення не знайдено", ru: "Приглашение не найдено", en: "Invitation not found" },
  "err.inviteRequired": {
    uk: "Реєстрація лише за запрошенням. Попросіть посилання у свого фахівця",
    ru: "Регистрация только по приглашению. Попросите ссылку у своего специалиста",
    en: "Registration is by invitation only. Ask your clinician for a link",
  },
  "err.lastVersionSigned": {
    uk: "Остання версія вже підписана",
    ru: "Последняя версия уже подписана",
    en: "The latest version is already signed",
  },
  "err.metricsTokenRequired": {
    uk: "Потрібен токен збору метрик",
    ru: "Нужен токен сбора метрик",
    en: "A metrics collection token is required",
  },
  "err.noRefreshToken": { uk: "Немає refresh-токена", ru: "Нет refresh-токена", en: "No refresh token" },
  "err.noteNotYet": { uk: "Запису ще немає", ru: "Заметки ещё нет", en: "There’s no note yet" },
  "err.noteTextChangedAfterOpen": {
    uk: "Текст змінився після відкриття: зараз версія {current}, підписувалася {signing}. Перечитайте запис.",
    ru: "Текст изменился после открытия: сейчас версия {current}, подписывалась {signing}. Перечитайте запись.",
    en: "The text changed after you opened it: it’s now at version {current}, but you were signing version {signing}. Read the note again.",
  },
  "err.notesChanged": {
    uk: "Запис змінився: зараз версія {current}, а правка велася поверх {base}. Оновіть текст.",
    ru: "Заметки изменились: сейчас версия {current}, а правка велась поверх {base}. Обновите текст.",
    en: "The notes have changed: they’re now at version {current}, but you were editing version {base}. Refresh the text.",
  },
  "err.outcomeRequired": {
    uk: "Потрібен результат розбору: підтверджено, не підтверджено або потребує спостереження",
    ru: "Нужен исход разбора: подтверждён, не подтверждён или требует наблюдения",
    en: "A review outcome is required: confirmed, not confirmed, or needs monitoring",
  },
  "err.referralNotFound": { uk: "Направлення не знайдено", ru: "Направление не найдено", en: "Referral not found" },
  "err.referralPatientOnly": {
    uk: "Направлення виписується пацієнту",
    ru: "Направление выписывается пациенту",
    en: "A referral is issued to a patient",
  },
  "err.referralTransitionInvalid": {
    uk: "Зі стану «{from}» не можна перейти в «{to}»: історія направлення не переписується",
    ru: "Из состояния «{from}» нельзя перейти в «{to}»: история направления не переписывается",
    en: "A referral can’t move from “{from}” to “{to}”: its history isn’t rewritten",
  },
  "err.retiredSurveys": {
    uk: "Знято з використання: {names}. Поверніть методику в роботу або приберіть її з набору",
    ru: "Снято с использования: {names}. Верните методику в работу или уберите её из набора",
    en: "Retired: {names}. Bring the assessment back into use or remove it from the battery",
  },
  "err.ruleNotFound": { uk: "Правило не знайдено", ru: "Правило не найдено", en: "Rule not found" },
  "err.safetyPlanNotFound": { uk: "План не знайдено", ru: "План не найден", en: "Plan not found" },
  "err.samePassword": {
    uk: "Новий пароль збігається з поточним",
    ru: "Новый пароль совпадает с текущим",
    en: "The new password is the same as the current one",
  },
  "err.searchTooShort": {
    uk: "Занадто короткі слова: шукаємо від трьох літер",
    ru: "Слишком короткие слова: ищем от трёх букв",
    en: "The words are too short: search needs at least three letters",
  },
  "err.sessionExpired": {
    uk: "Сесія закінчилася, увійдіть знову",
    ru: "Сессия истекла, войдите заново",
    en: "Your session has expired, please sign in again",
  },
  "err.staffAccessOnly": {
    uk: "Доступ лише для персоналу",
    ru: "Доступ только для персонала",
    en: "Staff access only",
  },
  "err.structureErrors": {
    uk: "Структурні помилки — методику не створено",
    ru: "Структурные ошибки — методика не создана",
    en: "Structural errors — the assessment wasn’t created",
  },
  "err.surveyOutOfScope": {
    uk: "Методика належить до групи, якою ви не керуєте",
    ru: "Методика относится к группе, которой вы не управляете",
    en: "The assessment belongs to a group you don’t manage",
  },
  "err.surveyUnavailable": { uk: "Методика недоступна", ru: "Методика недоступна", en: "Assessment not available" },
  "err.tooManyAttempts": {
    uk: "Забагато спроб. Зачекайте 15 хвилин",
    ru: "Слишком много попыток. Подождите 15 минут",
    en: "Too many attempts. Please wait 15 minutes",
  },
  "err.userIdRequired": { uk: "Не вказано userId", ru: "Не указан userId", en: "userId is missing" },
  "err.wrongCurrentPassword": {
    uk: "Поточний пароль не підходить",
    ru: "Текущий пароль не подходит",
    en: "The current password is incorrect",
  },

  /* отказы маршрутов */
  "err.dbUnavailable": { uk: "База даних недоступна", ru: "База данных недоступна", en: "The database is unavailable" },


  /* поликлиника: расписание, слоты, приёмы */
  "err.specialistMustBeStaff": {
    uk: "Профіль фахівця можна завести лише співробітникові",
    ru: "Профиль специалиста можно завести только сотруднику",
    en: "Only a staff member can have a clinician profile",
  },
  "err.scheduleExceptionNotFound": {
    uk: "Виняток у розкладі не знайдено",
    ru: "Исключение в расписании не найдено",
    en: "Schedule exception not found",
  },
  "err.alreadyNamed": {
    uk: "Обліковий запис вже під іменем",
    ru: "Учётная запись уже под именем",
    en: "This account already has a name",
  },
  "err.phoneInvalid": {
    uk: "Схоже, це не номер телефону. Перевірте цифри",
    ru: "Похоже, это не номер телефона. Проверьте цифры",
    en: "This doesn’t look like a phone number. Please check the digits",
  },
  "err.phoneExists": {
    uk: "Цей номер вже використовується",
    ru: "Этот номер уже используется",
    en: "This number is already in use",
  },
  "err.episodeAlreadyOpen": {
    uk: "У людини вже є відкрите звернення. Закрийте його, перш ніж відкривати нове",
    ru: "У человека уже есть открытое обращение. Закройте его, прежде чем открывать новое",
    en: "This person already has an open episode of care. Close it before opening a new one",
  },
  "err.dispensaryNotFound": {
    uk: "Людина не перебуває на обліку",
    ru: "Человек не состоит на учёте",
    en: "This person isn’t on the follow-up register",
  },
  "err.episodeNotFound": { uk: "Звернення не знайдено", ru: "Обращение не найдено", en: "Episode of care not found" },
  "err.episodeClosed": {
    uk: "Звернення вже закрито",
    ru: "Обращение уже закрыто",
    en: "The episode of care is already closed",
  },
  "err.episodeOtherPatient": {
    uk: "Прийом належить іншій людині",
    ru: "Приём принадлежит другому человеку",
    en: "The appointment belongs to another person",
  },
  "err.recordingNoConsent": {
    uk: "Запис не почнеться без згоди пацієнта на запис саме цього прийому",
    ru: "Запись не начнётся без согласия пациента на запись именно этого приёма",
    en: "Recording won’t start without the patient’s consent to record this particular appointment",
  },
  "err.recordingSpecialistOnly": {
    uk: "Запис прийому веде фахівець",
    ru: "Запись приёма ведёт специалист",
    en: "Only the clinician can record the appointment",
  },
  "err.recordingConsentAlready": {
    uk: "Згоду вже отримано",
    ru: "Согласие уже получено",
    en: "Consent has already been given",
  },
  "err.recordingInProgress": { uk: "Запис зараз іде", ru: "Запись сейчас идёт", en: "Recording is in progress" },
  "err.recordingNotRunning": { uk: "Запис не йде", ru: "Запись не идёт", en: "Nothing is being recorded" },
  "err.recordingAlready": {
    uk: "Прийом вже записано",
    ru: "Приём уже записан",
    en: "This appointment has already been recorded",
  },
  "err.recordingGone": {
    uk: "Запис вже не йде: його зупинили або видалили",
    ru: "Запись уже не идёт: её остановили или удалили",
    en: "The recording is no longer running: it was stopped or deleted",
  },
  "err.recordingTooLarge": { uk: "Файл завеликий", ru: "Файл слишком большой", en: "The file is too large" },
  "err.recordingTranscribed": {
    uk: "Розшифровку вже зроблено: видаляти запис пізно, текст у картці",
    ru: "Расшифровка уже сделана: удалять запись поздно, текст в карте",
    en: "The transcript is already done: it’s too late to delete the recording, the text is in the record",
  },
  "err.threadNotFound": { uk: "Листування не знайдено", ru: "Переписка не найдена", en: "Conversation not found" },
  "err.messageRecipientRequired": {
    uk: "Вкажіть, кому пишете",
    ru: "Укажите, кому пишете",
    en: "Choose who you’re writing to",
  },
  "err.noLeadSpecialist": {
    uk: "Постійного фахівця поки немає — листуватися нема з ким. Запишіться на прийом",
    ru: "Постоянного специалиста пока нет — переписываться не с кем. Запишитесь на приём",
    en: "You don’t have a regular clinician yet, so there’s no one to write to. Book an appointment",
  },
  /*
   * Рассылки — сообщение-объявление «одному многим», не переписка. «Не
   * найдена» вместо «чужая» — по тому же правилу, что у групп пациентов:
   * 403 подтвердил бы, что коллега такую рассылку завёл.
   */
  "err.mailingNotFound": { uk: "Повідомлення не знайдено", ru: "Сообщение не найдено", en: "Message not found" },
  "err.mailingAlreadySent": {
    uk: "Повідомлення вже відправлено: текст і варіанти відповіді більше не змінюються",
    ru: "Сообщение уже отправлено: текст и варианты ответа больше не меняются",
    en: "The message has already been sent: its text and answer options can no longer change",
  },
  "err.mailingSentNotDeletable": {
    uk: "Відправлене повідомлення не видаляється — його вже читали й відповідали. Його можна приховати",
    ru: "Отправленное сообщение не удаляется — его уже читали и отвечали. Его можно скрыть",
    en: "A sent message can’t be deleted — people have already read and answered it. You can hide it",
  },
  "err.mailingNoRecipients": {
    uk: "Немає жодного отримувача у вашій зоні відповідальності: відправляти нема кому",
    ru: "Нет ни одного получателя в вашей зоне ответственности: отправлять некому",
    en: "There are no recipients within your area of responsibility: no one to send to",
  },
  "err.mailingNoOptions": {
    uk: "Це повідомлення без варіантів відповіді — відповідати на нього не потрібно",
    ru: "Это сообщение без вариантов ответа — отвечать на него не нужно",
    en: "This message has no answer options — there’s nothing to answer",
  },
  "err.mailingBadAnswer": {
    uk: "Такого варіанта відповіді немає",
    ru: "Такого варианта ответа нет",
    en: "There’s no such answer option",
  },
  "err.mailingAlreadyAnswered": {
    uk: "Ви вже відповіли на це повідомлення",
    ru: "Вы уже ответили на это сообщение",
    en: "You’ve already answered this message",
  },
  "err.visitNotHappened": {
    uk: "Довідку видають про прийом, який відбувся; цей — «{status}»",
    ru: "Справку выдают о состоявшемся приёме; этот — «{status}»",
    en: "A certificate is issued only for an appointment that took place; this one is “{status}”",
  },
  "err.certificateNeedsName": {
    uk: "Щоб видати довідку, потрібно вказати ім’я: обліковий запис під кодом",
    ru: "Чтобы выдать справку, нужно указать имя: учётная запись под кодом",
    en: "To issue a certificate, add a name: this account is coded",
  },
  "err.attemptsSpent": {
    uk: "Спроби за цим призначенням вичерпано: дозволено {allowed}",
    ru: "Попытки по этому назначению исчерпаны: разрешено {allowed}",
    en: "No attempts left for this assignment: {allowed} allowed",
  },
  "err.departmentNotFound": { uk: "Відділення не знайдено", ru: "Отделение не найдено", en: "Department not found" },
  "err.screeningMustBePublished": {
    uk: "Методику скринінгу треба спершу опублікувати",
    ru: "Методику скрининга нужно сначала опубликовать",
    en: "Publish the screening assessment first",
  },
  "err.screeningMustHideResults": {
    uk: "Скринінг при записі не показує балів людині: пояснити їх поки нікому",
    ru: "Скрининг при записи не показывает баллов человеку: объяснить их пока некому",
    en: "Booking screening doesn’t show scores to the person: there’s no one to explain them yet",
  },
  "err.screeningMustBeSelf": {
    uk: "Скринінг при записі людина заповнює сама",
    ru: "Скрининг при записи человек заполняет сам",
    en: "Booking screening is filled in by the person themselves",
  },
  "err.slotNotFound": {
    uk: "Час прийому не знайдено",
    ru: "Время приёма не найдено",
    en: "Appointment slot not found",
  },
  "err.slotClosed": {
    uk: "Цей час закритий для запису",
    ru: "Это время закрыто для записи",
    en: "This slot is closed for booking",
  },
  "err.slotInPast": {
    uk: "Записатися на час, який вже минув, не можна",
    ru: "Записаться на время, которое уже прошло, нельзя",
    en: "You can’t book a slot that has already passed",
  },
  "err.slotTaken": {
    uk: "Цей час щойно зайняли. Оберіть інший",
    ru: "Это время только что заняли. Выберите другое",
    en: "This slot has just been taken. Please choose another",
  },
  "err.bookForSelfOnly": {
    uk: "Записатися можна лише самому",
    ru: "Записаться можно только самому",
    en: "You can only book for yourself",
  },
  "err.appointmentNotFound": { uk: "Прийом не знайдено", ru: "Приём не найден", en: "Appointment not found" },
  "err.appointmentNotPending": {
    uk: "Підтвердити можна лише прийом, який ще попереду",
    ru: "Подтвердить можно только приём, который ещё впереди",
    en: "Only an upcoming appointment can be confirmed",
  },
  "err.appointmentClosed": {
    uk: "Прийом вже завершено або скасовано",
    ru: "Приём уже завершён или отменён",
    en: "The appointment has already been completed or cancelled",
  },
  "err.appointmentBadTransition": {
    uk: "Так прийом не рухається: із «{from}» не переходять у «{to}»",
    ru: "Так приём не движется: из «{from}» не переходят в «{to}»",
    en: "An appointment can’t move that way: “{from}” doesn’t lead to “{to}”",
  },
  "err.confirmSelfOnly": {
    uk: "Підтвердити прийом може лише той, кого записано",
    ru: "Подтвердить приём может только тот, кто записан",
    en: "Only the person booked can confirm the appointment",
  },
  "err.rescheduleSelfOnly": {
    uk: "Перенести можна лише свій прийом",
    ru: "Перенести можно только свой приём",
    en: "You can only reschedule your own appointment",
  },
  "err.cancelSelfOnly": {
    uk: "Скасувати можна лише свій прийом",
    ru: "Отменить можно только свой приём",
    en: "You can only cancel your own appointment",
  },
  "err.leadNotYours": {
    uk: "Зняти закріплення може лише той фахівець, за яким людину закріплено",
    ru: "Снять закрепление может только тот специалист, за которым закреплён человек",
    en: "Only the clinician the person is assigned to can remove the assignment",
  },
  /* отказы маршрутов */
  "err.permissionRequired": {
    uk: "Недостатньо прав: потрібне «{permission}»",
    ru: "Недостаточно прав: нужно «{permission}»",
    en: "You don’t have permission: “{permission}” is required",
  },

  /* отказы маршрутов */
  "err.builtinRoleReadOnly": {
    uk: "Набір вбудованої ролі задається довідником і не змінюється вручну",
    ru: "Набор встроенной роли задаётся справочником и не меняется вручную",
    en: "A built-in role’s permissions come from the reference list and can’t be changed by hand",
  },
  "err.exceptionAlreadyRevoked": {
    uk: "Виняток вже відкликано",
    ru: "Исключение уже отозвано",
    en: "The exception has already been revoked",
  },
  "err.exceptionNotFound": { uk: "Виняток не знайдено", ru: "Исключение не найдено", en: "Exception not found" },
  "err.roleNotFound": { uk: "Роль не знайдено", ru: "Роль не найдена", en: "Role not found" },
  /*
   * Отказы цепочки назначения. Названы кодом роли, а не «недостаточно прав»:
   * разбирающий должен видеть, о какой именно ступени речь, иначе отказ
   * читается как поломка.
   */
  "err.notAnAssigner": {
    uk: "Призначати ролі може завідувач відділенням і вище",
    ru: "Назначать роли может заведующий отделением и выше",
    en: "Roles can be assigned by the head of department and above",
  },
  "err.roleAboveYours": {
    uk: "Призначити можна лише роль нижче за власну; «{role}» цьому не відповідає",
    ru: "Назначить можно только роль ниже собственной; «{role}» этому не отвечает",
    en: "You can only assign a role below your own; “{role}” isn’t one",
  },
  "err.roleNotInChain": {
    uk: "Роль «{role}» поза ланцюжком посад: її призначає технічний адміністратор",
    ru: "Роль «{role}» вне цепочки должностей: её назначает технический администратор",
    en: "Role “{role}” is outside the chain of positions: it’s assigned by the technical administrator",
  },
  "err.roleGrantsMoreThanYours": {
    uk: "Не можна видати право, якого немає в самого: «{permission}»",
    ru: "Нельзя выдать право, которого нет у самого: «{permission}»",
    en: "You can’t grant a permission you don’t have yourself: “{permission}”",
  },
  "err.googleNotConfigured": {
    uk: "Вхід через Google не налаштований на цьому сервері",
    ru: "Вход через Google не настроен на этом сервере",
    en: "Sign-in with Google isn’t configured on this server",
  },
  "err.googleBadCallback": {
    uk: "Повернення від Google не прийнято: підпис не збігається або строк вийшов",
    ru: "Возврат от Google не принят: подпись не совпадает или срок вышел",
    en: "The response from Google was rejected: the signature doesn’t match or it has expired",
  },
  "err.unknownPermission": {
    uk: "Невідоме право: {permission}",
    ru: "Неизвестное право: {permission}",
    en: "Unknown permission: {permission}",
  },
} as const satisfies Record<string, ErrorEntry>;

export type ErrorKey = keyof typeof ERRORS;

/** Подстановки: имена в фигурных скобках заменяются значениями. */
export type ErrorParams = Record<string, string | number>;

/**
 * Текст отказа на нужном языке.
 *
 * Неизвестный ключ не роняет ответ и не показывается как есть.
 *
 * Уронить нельзя: отказ и так означает, что что-то пошло не по плану, и
 * падать на подборе для него слов — худшее, что можно сделать в этот момент.
 * Показать ключ тоже нельзя: «err.surveyNotFound» на экране у специалиста
 * хуже, чем общая фраза, — он не поймёт ни что случилось, ни что делать.
 *
 * Дойти сюда с неизвестным ключом почти невозможно: помощники отказов
 * принимают типизированный ErrorKey, и опечатку ловит компилятор. Это
 * подстраховка на случай, когда ключ соберётся в рантайме.
 */
export function renderError(key: string, lang: Lang, params?: ErrorParams): string {
  const entry = (ERRORS as Record<string, ErrorEntry | undefined>)[key];
  let text = entry ? entry[lang] : ERRORS["err.internal"][lang];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}
