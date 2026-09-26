/**
 * superadmin — видит все группы и назначает их администраторов.
 * admin      — работает только со своими группами.
 * user       — проходит методики.
 */
/**
 * Языки интерфейса — перечнем, а тип выводится из перечня.
 *
 * Не наоборот: пока тип был написан руками (`"uk" | "ru"`), а списки для
 * перебора — отдельно (`["uk", "ru"]` в переключателях, в схемах, в
 * мобилке), добавить язык значило найти их все, и хотя бы один нашёлся бы
 * уже в бою. Теперь перечень один, и переключатель, перебирающий LANGS,
 * узнаёт о новом языке без правки. Порядок — порядок показа в
 * переключателях: государственный язык первым.
 *
 * Английский добавлен по просьбе заказчика (2026-09-26: «тут має бути вибір
 * не тільки між укр і рус, а й англ»). Это язык ОБОЛОЧКИ. Текстов методик
 * на английском нет, и без отдельного решения не будет — см. CONTENT_LANGS.
 */
export const LANGS = ["uk", "ru", "en"] as const;
export type Lang = (typeof LANGS)[number];

/** Пришедшее снаружи (хранилище, заголовок, параметр) — один из наших языков? */
export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

/**
 * Языки, на которых написано СОДЕРЖИМОЕ методик: пункты, варианты, полосы.
 *
 * Английского здесь нет намеренно, и это не недоделка. Свой английский
 * текст пунктов означал бы инструмент, который считает людей по нормам,
 * снятым с другого текста (docs/INSTRUMENTS.md, «Перевод не официальный»;
 * решение волны 22 в docs/REWRITE-PLAN.md; оговорка WORKING_TRANSLATION в
 * apps/api/src/instruments/common.ts). Поэтому английский интерфейс
 * показывает методики на украинском, конструктор правит текст только на
 * этих двух языках, а схема записи (localizedSchema) английского текста не
 * принимает.
 */
export const CONTENT_LANGS = ["uk", "ru"] as const;
export type ContentLang = (typeof CONTENT_LANGS)[number];

/**
 * На каком языке ПРАВИТЬ содержимое, если интерфейс на `lang`.
 *
 * Конструктор открывается на языке интерфейса — так было и остаётся. У
 * английского интерфейса своего языка содержимого нет, и он открывает
 * украинский — тот же, что t() покажет ему первым запасным.
 */
export function contentLangFor(lang: Lang): ContentLang {
  return lang === "ru" ? "ru" : "uk";
}

/**
 * Локализованный текст. Хранится как объект языков, а не как строка:
 * пособия дают каждую методику и на украинском, и на русском, и это один
 * и тот же пункт, а не две разные методики.
 *
 * Английский в типе допустим (Partial по всем языкам), в данных его нет —
 * см. CONTENT_LANGS. Тип не запрещает его затем, чтобы t() и чтение
 * работали без переделки в день, когда решение о содержимом переменится.
 */
export type LocalizedText = Partial<Record<Lang, string>>;

/**
 * Названия языков — каждое на своём языке, и переводу не подлежат.
 *
 * «Українська» по-русски — это способ не найти украинский, когда интерфейс
 * уже переключился на непонятный. Поэтому здесь, а не в словаре: словарь по
 * определению возвращает одну строку на выбранном языке, а тут нужны все
 * сразу.
 *
 * Данными, а не литералом в разметке: иначе оба приложения держат свои
 * подписи, и проверке «строки только через словарь» приходится делать для
 * них исключение — а исключение на файл прячет и всё остальное в этом файле.
 *
 * «ENG», а не «АНГ»: язык называется на себе самом — по тому же правилу
 * «Русский» здесь не пишут «Російська». Прописными, как соседи.
 */
export const LANG_NAMES: Record<Lang, { full: string; short: string }> = {
  uk: { full: "Українська", short: "УКР" },
  ru: { full: "Русский", short: "РУС" },
  en: { full: "English", short: "ENG" },
};

/**
 * Как называется сам орган выбора языка — на всех языках сразу.
 *
 * Имя для диктора у сегментированного переключателя (lang.tsx) и хвост имени
 * у подписи-переключателя в полосе (Topbar.tsx). Причина многоязычия та же,
 * что у LANG_NAMES выше: тот, кто уже переключился на непонятный язык, ищет
 * обратную дорогу по слову, которое читает. С английским это стало
 * буквальным: человек, не читающий кириллицу, находит переключатель по
 * «Language» — и только по нему.
 *
 * Здесь, а не в uiStrings: словарь отдаёт одну строку на выбранном языке, а
 * тут нужны все разом, и русское слово в украинском поле словаря — ровно то,
 * что ловит проверка «украинский не сползает в русский». Одной записью, а не
 * литералом в двух разметках: до сверки публичных кадров их и было два.
 *
 * «Мова / Язык» осталось началом строки, а «Language» встало хвостом, а не
 * наоборот: сценарии e2e ищут переключатель по этому началу
 * (e2e/helpers.ts, langToggle), и голосовое управление у тех, кто им уже
 * пользуется, называет его так же.
 */
export const LANG_SELF_LABEL = "Мова / Язык / Language";

/**
 * В базе контент хранится локализованно, а API отдаёт его уже разрешённым
 * на запрошенном языке. Так потребители — мобилка, консоль, заключения —
 * работают с обычными строками и ничего не знают о языках,
 * а мультиязычность живёт в одном слое.
 */

/**
 * В каком порядке искать текст, если на запрошенном языке его нет.
 *
 * Украинский и русский подменяют друг друга — так было всегда. Английский
 * берёт украинский первым: учреждение украинское, и методики каталога все
 * есть на украинском; русский — только если украинского нет вовсе (такое
 * бывает у заведённых строкой, см. normalizeLocalized). Английский стоит в
 * хвосте у двух других на день, когда он появится у какой-нибудь методики,
 * а украинского у неё не окажется.
 */
export const LANG_FALLBACK: Record<Lang, readonly Lang[]> = {
  uk: ["uk", "ru", "en"],
  ru: ["ru", "uk", "en"],
  en: ["en", "uk", "ru"],
};

/** Достаёт текст на нужном языке, откатываясь на любой доступный */
export function t(text: LocalizedText | string | null | undefined, lang: Lang = "uk"): string {
  if (text === null || text === undefined) return "";
  if (typeof text === "string") return text;
  /*
   * «Текст есть» — это «не null и не undefined», а не «непустая строка»:
   * тот же смысл, что у прежней цепочки `??`. Пустая строка на запрошенном
   * языке осталась пустой строкой — поведение для двух прежних языков не
   * изменилось ни в одном случае.
   */
  for (const l of LANG_FALLBACK[lang]) {
    const v = text[l];
    if (v !== undefined && v !== null) return v;
  }
  return Object.values(text)[0] ?? "";
}

/**
 * На каком языке t() на самом деле отдаст этот текст.
 *
 * Нужен там, где важен не текст, а его язык: прохождение записывает язык
 * предъявления (психометрический фактор), а экран прохождения говорит
 * человеку с английским интерфейсом, что пункты перед ним — на украинском.
 * У строки без языков (текст, заведённый до двуязычия) язык неизвестен, и
 * честнее назвать запрошенный, чем угадывать по буквам.
 */
export function presentedLang(text: LocalizedText | string | null | undefined, lang: Lang): Lang {
  if (text === null || text === undefined || typeof text === "string") return lang;
  for (const l of LANG_FALLBACK[lang]) {
    const v = text[l];
    if (v !== undefined && v !== null) return l;
  }
  return lang;
}

/**
 * Надо ли сказать человеку, что пункты перед ним не на языке интерфейса, —
 * и если надо, на каком они языке.
 *
 * Только для английского интерфейса. Расхождение украинского с русским
 * (методика, заведённая на одном языке) было всегда и молча: в Украине
 * читают оба, и строка «питання російською» над каждой такой методикой была
 * бы шумом, а не помощью. Английский выбирает тот, кто, скорее всего, не
 * читает ни того, ни другого свободно, — ему это знать нужно.
 */
export function contentLangNotice(lang: Lang, contentLang: Lang | undefined): ContentLang | null {
  if (lang !== "en" || contentLang === undefined || contentLang === "en") return null;
  return contentLang;
}

export type Role = "superadmin" | "admin" | "user";

/** Администратор, назначенный на группу */
export interface GroupAdmin {
  userId: string;
  fullName: string;
  email: string;
  addedAt: string;
  addedBy: string | null;
}

/** Типы вопросов. info — не вопрос, а информационный блок между вопросами. */
export type QuestionType =
  | "single"
  | "multiple"
  | "scale"
  | "slider"
  | "matrix"
  | "ranking"
  | "yesno"
  | "number"
  | "text"
  | "longtext"
  | "date"
  | "info";

export type SurveyStatus = "draft" | "published" | "closed";

/** Как складываются вклады пунктов в сырой балл субшкалы */
export type ScaleAggregation = "sum" | "average" | "count";

/**
 * Во что превращается сырой балл.
 * raw    — остаётся как есть;
 * ratio  — доля от максимума (Sr = N/35, L = N/10);
 * tscore — T-балл по норме пола и возраста: 50 + 10·(X − M)/δ;
 * sten   — стен по таблице перевода.
 */
export type ScaleNormalization = "raw" | "ratio" | "tscore" | "sten";

/**
 * clinical — содержательная шкала;
 * validity — шкала достоверности: её результат не интерпретируется сам по себе,
 *            а решает, можно ли доверять профилю целиком.
 */
export type ScaleKind = "clinical" | "validity";

/** Направление, в котором значение шкалы достоверности делает профиль недостоверным */
export type ValidityDirection = "above" | "below";

/**
 * Вклад пункта в шкалу.
 *
 * matchKey задан — работает «ключ»: пункт даёт weight баллов, если выбран вариант
 * с этим кодом («Да» или «Нет»). Так устроены СР-45, МЛО, Мини-мульт.
 * matchKey не задан — берётся балл выбранного варианта или числовой ответ.
 */
export interface ScaleItem {
  questionId: string;
  matchKey: string | null;
  weight: number;
}

/** Поправка одной шкалы на другую: Hs = Hs + 0,5·K в Мини-мульте */
export interface ScaleCorrection {
  sourceScaleCode: string;
  coefficient: number;
}

/** Норма для перевода в T-баллы: среднее и стандартное отклонение по выборке */
export interface ScaleNorm {
  sex: Sex | null;
  ageMin: number | null;
  ageMax: number | null;
  mean: number;
  sd: number;
  /** Происхождение: «пособие НПС, 2016» или «локальная выборка, N=213» */
  source: string | null;
}

/** Строка таблицы перевода сырых баллов в стены */
export interface StenRow {
  sex: Sex | null;
  ageMin: number | null;
  ageMax: number | null;
  rawMin: number;
  rawMax: number;
  sten: number;
}

/**
 * Степень выраженности признака в интерпретационной норме.
 * Ровно четыре ступени: они ложатся один-в-один на зарезервированные статусные
 * роли дизайн-системы (good / warning / serious / critical), поэтому цвет
 * выраженности никогда не конкурирует с цветами серий на графиках.
 */
export type Severity = "none" | "mild" | "moderate" | "severe";

export type ResponseStatus = "in_progress" | "completed" | "abandoned";

export type LogicOperator =
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "contains"
  | "answered"
  | "not_answered";

export type LogicAction = "show" | "hide";

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  /** Готовое отображаемое имя — собирается на сервере, чтобы не разъезжалось */
  fullName: string;

  /** Псевдонимизированный аккаунт: ФИО не хранится, показывается код */
  anonymous: boolean;
  pseudonym: string | null;

  /**
   * Кто ведёт человека. Закрепляется явно, а не выводится из последнего
   * приёма: иначе визит к коллеге на замене молча переназначал бы ведущего.
   */
  leadSpecialistId?: string | null;

  /** Паспортная часть: нужна для норм по полу и возрасту и для заключения */
  sex: Sex | null;
  birthDate: string | null;
  unit: string | null;
  position: string | null;
  specialty: string | null;
  rank: string | null;
  /** Населённый пункт — фильтр выборок в «Статистиці»; открытым текстом, см. миграцию 0086 */
  locality: string | null;

  role: Role;
  createdAt: string;
  /** Учётная запись работает только на просмотр: любые изменения запрещены */
  readOnly: boolean;
  /**
   * Связана ли учётная запись с Google.
   *
   * Только факт, без идентификатора: экрану нужно решить, показывать
   * «привязать» или «отвязать», а сам идентификатор ему для этого не нужен.
   */
  googleLinked: boolean;
  /**
   * Настройки рабочего места. Приходят вместе с профилем: отдельный запрос за
   * ними означал бы, что консоль на мгновение открывается не в той теме.
   */
  workspace?: WorkspacePrefs | null;
  /**
   * Ступень лестницы должностей: 0 — вне лестницы, выше — главнее.
   *
   * По ней консоль решает, показывать ли пункт «Права»: назначает только
   * тот, у кого есть кому назначать. Ограничением это не является —
   * правило живёт на маршрутах назначения и проверяется там.
   */
  ladderRank?: number;
  /**
   * Можно ли выписывать пригласительные ссылки.
   *
   * Такая же подсказка меню, как ступень выше: по ней консоль решает,
   * показывать ли вкладку «Приглашения» на главном экране. Право живёт на
   * маршрутах приглашений и проверяется там; здесь оно только для того,
   * чтобы вкладка не обещала того, чего сервер не даст.
   */
  canInvite?: boolean;
}

/**
 * Где сотрудник принимает — профиль приёма (specialist_profiles):
 * відділення из справочника отделений и посада в нём.
 *
 * Отдельным объектом, а не ещё двумя полями User: у пациента профиля не
 * бывает, у сотрудника без расписания — тоже, и «нет профиля» (null) — не то
 * же, что «профиль без посады» (position: null). Название отделения уже на
 * языке запроса: справочник хранит его парой {uk, ru}, а списку нужна строка.
 */
export interface StaffPlacement {
  department: string;
  position: string | null;
}

/**
 * Строка справочника сотрудников (GET /api/users?directory=1): учётная
 * запись и то, что нужно разделу «Лікарі» сверх неё, — телефон и профиль
 * приёма. Телефон расшифрован; чтение такого списка пишется в журнал с
 * пометкой `phones` (см. docs/REWRITE-PLAN.md §14).
 */
export interface StaffDirectoryUser extends User {
  phone: string | null;
  placement: StaffPlacement | null;
}

/**
 * Строка «кого я вправе назначать» (GET /api/permissions/staff).
 *
 * Без анкеты — пола, даты рождения, специальности: заведующему список коллег
 * нужен, а полного реестра ему не положено. Подразделение и посада из
 * анкеты — рабочие сведения, а не личные, и лежат в той же строке таблицы,
 * поэтому приходят всегда. Профиль приёма (второй запрос) и телефон — только
 * в режиме справочника (`?directory=1`), и тогда чтение пишется в журнал.
 */
export interface AssignableStaff {
  id: string;
  email: string;
  role: string;
  fullName: string;
  unit?: string | null;
  position?: string | null;
  placement?: StaffPlacement | null;
  phone?: string | null;
}

export type Sex = "male" | "female";

/** Возраст на конкретную дату — считается на момент обследования */
/** Возрастная полоса для стратификации: "<25" | "25-34" | "35-44" | "45+" */
export function ageBandOf(age: number | null): string | null {
  if (age === null) return null;
  if (age < 25) return "<25";
  if (age < 35) return "25-34";
  if (age < 45) return "35-44";
  return "45+";
}

export function ageAt(birthDate: string | null, at: string | null): number | null {
  if (!birthDate || !at) return null;
  const born = new Date(birthDate);
  const when = new Date(at);
  if (Number.isNaN(born.getTime()) || Number.isNaN(when.getTime())) return null;
  let age = when.getFullYear() - born.getFullYear();
  const monthDiff = when.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && when.getDate() < born.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

/** Кому выдан доступ к методике */
export interface SurveyGrant {
  userId: string;
  fullName: string;
  email: string;
  grantedBy: string | null;
  grantedByName: string | null;
  grantedAt: string;
  expiresAt: string | null;
  note: string | null;
  /** Сколько попыток выдано; null — не ограничивали */
  attemptsAllowed: number | null;
  attemptsUsed: number;
  /** Проходил ли уже */
  completed: boolean;
}

/** Группа опросов — батарея методик (например «Приёмное отделение») */
export interface SurveyGroup {
  id: string;
  title: string;
  description: string | null;
  color: string | null;
  position: number;
  createdBy: string;
  createdAt: string;
  /**
   * Снята с использования: остаётся в списках и в аналитике, но не
   * предлагается при выборе группы для новой методики или батареи.
   */
  archivedAt: string | null;
}

export interface SurveyGroupWithCounts extends SurveyGroup {
  surveyCount: number;
  publishedCount: number;
  responseCount: number;
  /** Сколько людей вообще прошло хоть одну методику группы */
  patientCount: number;
  /** Сколько случаев риска по методикам группы сейчас не разобрано */
  openCaseCount: number;
  /** Кто ведёт группу. Приходит по доступным группам — чужих в списке нет */
  admins: GroupAdmin[];
  /**
   * Может ли читатель вести эту группу: заводить, снимать, назначать
   * администраторов.
   *
   * Считает сервер, а не экран. Экран проверял роль суперадмина — а право
   * `groups.manage` с тех пор стало выдаваемым, и заведующий отделением,
   * ради которого его заводили, кнопок не видел вовсе, хотя сервер его
   * пропускал. Роль на клиенте известна, состав прав — нет, поэтому ответ
   * приходит вместе с самой группой.
   */
  manageable: boolean;
}

/* ─────────── Папки МЕТОДИК ───────────
 *
 * Полка внутри группы методик: «Мої тести › Тести за 2023 › Тести за лютий
 * 2023». Не `SurveyGroup` и не `PatientGroup`: группа методик разграничивает
 * доступ, папка — только раскладывает уже видимое. Кому видна папка,
 * решает её группа; правит её тот, кто правит методики (surveys.edit).
 */

/** Папка каталога методик */
export interface SurveyFolder {
  id: string;
  /** Группа методик, в которой папка живёт. Между группами папка не переезжает */
  groupId: string;
  /** Родительская папка; null — корень каталога группы */
  parentId: string | null;
  title: string;
  /**
   * Дата папки с макета («Лютий 2023 початок 05.02.2023»), ГГГГ-ММ-ДД.
   * Правится руками, это не дата создания.
   */
  startsOn: string;
  position: number;
  /** Кто завёл. Авторство для журнала, а не право: права даёт группа */
  createdBy: string | null;
  createdAt: string;
}

export interface SurveyFolderWithCounts extends SurveyFolder {
  /** Методик в работе прямо в папке, без вложенных: то, что увидят, открыв её */
  surveyCount: number;
  /** Вложенных папок */
  childCount: number;
}

/**
 * Страница каталога методик.
 *
 * `total` считается по тем же условиям, что и страница, и приходит всегда,
 * даже когда страниц не просили: тогда он равен длине списка, и клиенту не
 * нужно различать два вида ответа.
 */
export interface SurveyListPage {
  items: SurveyListItem[];
  total: number;
}

/* ─────────── Группы ПАЦИЕНТОВ ───────────
 *
 * Не то же, что `SurveyGroup` выше, и названы так, чтобы их нельзя было
 * спутать. `SurveyGroup` — группа МЕТОДИК: единица разграничения доступа, на
 * неё назначают администраторов, от неё считается зона ответственности
 * сотрудника. `PatientGroup` — рабочий список людей, собранный специалистом
 * руками: «Моя група», «Група ризику», «Вечірня група». Он ничего не
 * открывает и ничего не закрывает — только раскладывает уже видимых людей по
 * вкладкам и позволяет назначить методику сразу всем.
 */

/** Группа пациентов: название, описание, владелец */
export interface PatientGroup {
  id: string;
  title: string;
  /** «Опис групи (питання до групи)»: зачем группа собрана и что у неё спрашивают */
  description: string | null;
  /** Цвет вкладки на экране пациентов */
  color: string | null;
  position: number;
  /** Кто собрал список. Чужие группы в выдаче не появляются вовсе */
  ownerId: string;
  createdAt: string;
}

/** Человек в составе группы — «Пацієнти Групи» */
export interface PatientGroupMember {
  userId: string;
  fullName: string;
  email: string;
  /** Подразделение: в списке из тридцати однофамильцев это единственный ориентир */
  unit: string | null;
  sex: Sex | null;
  /**
   * Только год, не дата: различить тёзок в составе — год, а полная дата
   * рождения в списке — та мелочь, из которой складывается опознание.
   */
  birthYear: number | null;
  /**
   * Телефон — открытым текстом, как на кадрах f05/f13/f14: заказчик решил
   * показывать его в списках и карточке «как на макете» (2026-09-25).
   * В базе он по-прежнему шифрован; расшифровка — на сервере, чтение списка
   * записывается в журнал с пометкой, что телефоны в нём были.
   */
  phone: string | null;
  addedAt: string;
  addedBy: string | null;
}

/** Методика, назначенная на группу целиком — «Тести Групи» */
export interface PatientGroupSurvey {
  surveyId: string;
  title: LocalizedText;
  /** Описание методики — «Тести Групи» на карточке показывают его рядом с названием */
  description: LocalizedText | null;
  assignedAt: string;
  assignedBy: string | null;
  /** Срок и число попыток, с которыми методика выдаётся участникам группы */
  expiresAt: string | null;
  attemptsAllowed: number | null;
  /** Сколько участников группы уже прошли её хотя бы раз */
  completedCount: number;
}

export interface PatientGroupWithCounts extends PatientGroup {
  /**
   * Сколько участников видно ЧИТАТЕЛЮ.
   *
   * Не «сколько в группе»: человек, выбывший из зоны ответственности, из
   * состава пропадает, и считать его значило бы сообщать, что в группе есть
   * кто-то, кого показать нельзя. Число и список обязаны говорить одно и то
   * же, иначе экран выглядит сломанным.
   */
  memberCount: number;
  /** Сколько методик назначено на группу целиком */
  surveyCount: number;
  /**
   * «Обрана» ЧИТАТЕЛЕМ. Признак личный, а не свойство группы: суперадмин,
   * разбирающий чужие вкладки, видит свои закладки, а не закладки владельца.
   */
  favourite: boolean;
}

/** Карточка группы: описание, состав и назначенные методики на одном экране */
export interface PatientGroupCard extends PatientGroup {
  members: PatientGroupMember[];
  surveys: PatientGroupSurvey[];
}

/* ─────────── Пациенты зоны видимости и карточка пациента ─────────── */

/**
 * Строка списка «Пацієнти»: те, кого сотрудник вправе видеть, — все, а не
 * только обследованные (то отдаёт /api/dynamics/respondents). Телефона нет
 * намеренно: он открывается отдельным журналируемым действием.
 */
export interface PatientListItem {
  id: string;
  name: string;
  email: string;
  unit: string | null;
  sex: Sex | null;
  /** Только год — различить тёзок; полная дата в списке лишняя */
  birthYear: number | null;
  /**
   * Телефон — открытым текстом, как на кадрах f05/f13/f14: заказчик решил
   * показывать его в списках и карточке «как на макете» (2026-09-25).
   * В базе он по-прежнему шифрован; расшифровка — на сервере, чтение списка
   * записывается в журнал с пометкой, что телефоны в нём были.
   */
  phone: string | null;
  /**
   * Населённый пункт. Поля в учётной записи нет — на карточке макета ячейка
   * есть, и признак объявлен, чтобы экрану было куда его положить, когда
   * поле появится; до тех пор его просто нет в ответе.
   */
  locality?: string | null;
  leadSpecialistId: string | null;
  /** Когда сдавал методику в последний раз; null — ещё ни разу */
  lastResponseAt: string | null;
}

export interface PatientListPage {
  items: PatientListItem[];
  total: number;
}

/** Одна сданная методика на карточке: баллы по шкалам и полоса каждой */
export interface PatientCardResponse {
  responseId: string;
  surveyId: string;
  surveyTitle: string;
  submittedAt: string | null;
  /** Достоверен ли протокол по шкалам достоверности */
  reliable: boolean;
  scales: {
    code: string;
    title: string;
    value: number;
    normalization: ScaleNormalization;
    percent: number;
    bandLabel: string | null;
    severity: Severity | null;
  }[];
}

/** Заключение на карточке: подписанное — любого автора, черновик — только свой */
export interface PatientCardConclusion {
  id: string;
  responseId: string;
  surveyId: string;
  surveyTitle: string;
  version: number;
  status: "draft" | "signed";
  text: string;
  createdAt: string;
  signedAt: string | null;
  authorName: string;
}

/** Группа, в которой человек состоит, — из групп читателя */
export interface PatientCardGroup {
  id: string;
  title: string;
  description: string | null;
  color: string | null;
  /** Сколько участников видно читателю — то же число, что на вкладке */
  memberCount: number;
  surveyCount: number;
}

/**
 * Карточка пациента (кадр f19): персональные данные, «Тести», «Групи»,
 * «Заключення» и ведущий специалист одним ответом.
 *
 * Телефона здесь нет: он шифруется и открывается отдельным действием с
 * записью в журнал (GET /api/clinic/patients/:userId/phone). Плашка на
 * карточке обошла бы эту запись.
 */
export interface PatientCard {
  id: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  fullName: string;
  anonymous: boolean;
  pseudonym: string | null;
  email: string;
  sex: Sex | null;
  birthDate: string | null;
  /** Телефон — как на кадре f13, по решению заказчика; чтение карточки журналируется с пометкой */
  phone: string | null;
  unit: string | null;
  position: string | null;
  specialty: string | null;
  rank: string | null;
  createdAt: string;
  /**
   * Ведущий специалист. `mine` — закреплён за читателем: по нему экран
   * решает, показывать «Підписатись» или «Відписатись». Меняется тем же
   * маршрутом, что и на экране приёма: POST /api/clinic/patients/:userId/lead.
   */
  lead: { specialistId: string; name: string; mine: boolean } | null;
  responses: PatientCardResponse[];
  groups: PatientCardGroup[];
  conclusions: PatientCardConclusion[];
}

/* ─────────── Рассылки ───────────
 *
 * Сообщение-объявление «одному многим»: название, текст и варианты ответа
 * получателя. Не переписка (`/api/messages` — разговор двоих) и не методика:
 * у вариантов нет баллов, они не считаются, а фиксируются.
 */

export type MailingStatus = "draft" | "sent";

export interface Mailing {
  id: string;
  authorId: string;
  title: string;
  body: string;
  /** Варианты ответа получателя; пусто — просто уведомление, отвечать нечем */
  options: string[];
  status: MailingStatus;
  /** Адресаты черновика: группа пациентов и/или поимённый список */
  patientGroupId: string | null;
  patientIds: string[];
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  /** Скрыта у автора: отправленную не удалить, но с глаз убрать можно */
  hiddenAt: string | null;
}

/** Строка списка: тема, начало текста, дата — как на кадре f09 */
export interface MailingListItem {
  id: string;
  title: string;
  /** Первые строки текста, без хвоста: список — не место для всего письма */
  preview: string;
  status: MailingStatus;
  /** Дата строки: отправки — у отправленных, последней правки — у черновиков */
  at: string;
  sentAt: string | null;
  recipientCount: number;
  answeredCount: number;
}

export interface MailingListPage {
  items: MailingListItem[];
  total: number;
}

/** Получатель на карточке отправленной рассылки — из зоны видимости читателя */
export interface MailingRecipient {
  userId: string;
  fullName: string;
  deliveredAt: string;
  readAt: string | null;
  /** Номер выбранного варианта в `options`; null — ещё не ответил */
  answer: number | null;
  answeredAt: string | null;
}

/**
 * Карточка рассылки: у отправленной — счётчики по вариантам и получатели.
 *
 * Счётчики — по ВСЕМ получателям: «сколько ответили „Так“» — факт о
 * рассылке, и он не меняется оттого, что одного из ответивших перевели в
 * другое отделение. Имена — только те, кто сейчас в зоне видимости читателя:
 * на них действует та же зона, что на составе группы пациентов. Поэтому
 * `recipients.length` может быть меньше `counts.recipients`.
 */
export interface MailingCard extends Mailing {
  /** Получили, открыли, ответили — по всем, кому доставлено */
  counts: { recipients: number; read: number; answered: number } | null;
  /** По каждому варианту — сколько выбрали; в порядке `options` */
  answers: { index: number; text: string; count: number }[] | null;
  /** Получатели из зоны видимости читателя; у черновика — null */
  recipients: MailingRecipient[] | null;
}

/** Рассылка глазами получателя — «Повідомлення» в приложении пациента */
export interface MailingInboxItem {
  id: string;
  title: string;
  body: string;
  options: string[];
  authorName: string;
  sentAt: string;
  readAt: string | null;
  answer: number | null;
  answeredAt: string | null;
}

export interface MailingInbox {
  items: MailingInboxItem[];
  total: number;
  /** Непрочитанных — для счётчика в меню */
  unread: number;
}

/**
 * Аналитика группы: сколько людей, сколько прохождений, как распределены
 * степени выраженности.
 *
 * Отдельно от аналитики методики: заведующему нужен ответ про отделение
 * целиком, а не про один опросник, и складывать его из десяти запросов на
 * экране значит считать одно и то же разными способами.
 */
export interface GroupAnalytics {
  groupId: string;
  title: string;
  archivedAt: string | null;
  surveyCount: number;
  publishedCount: number;
  /** Начатых прохождений, включая брошенные */
  startedCount: number;
  /** Завершённых прохождений */
  responseCount: number;
  /** Разных людей среди завершённых прохождений */
  patientCount: number;
  /** Доля доведённых до конца, в процентах */
  completionRate: number;
  avgDurationMs: number;
  openCaseCount: number;
  /** Распределение по степеням выраженности — по содержательным шкалам */
  severityBreakdown: { severity: Severity; count: number }[];
  /** Разбивка по методикам группы: где именно набралось */
  surveys: {
    surveyId: string;
    title: string;
    status: SurveyStatus;
    archived: boolean;
    responseCount: number;
    patientCount: number;
    severityBreakdown: { severity: Severity; count: number }[];
  }[];
  /** Прохождения по дням — для линии динамики */
  timeline: { date: string; count: number }[];
}

export type RiskSeverity = "moderate" | "severe";

export interface Option {
  id: string;
  questionId: string;
  text: string;
  /**
   * Код варианта для ключа: «yes» / «no» у методик с ответами да/нет.
   * Ключ ссылается на код, а не на порядок вариантов — порядок может
   * перемешиваться, а смысл ответа нет.
   */
  keyCode: string | null;
  /** Балл, который даёт этот вариант при подсчёте субшкалы */
  score: number;
  position: number;
  /** row — строка матричного вопроса, option — вариант ответа */
  kind: "option" | "row";
  /** Выбор поднимает тревогу немедленно */
  riskFlag: boolean;
  riskLabel: string | null;
  riskSeverity: RiskSeverity | null;
}

export interface SurveyVersion {
  id: string;
  surveyId: string;
  version: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  /** Сколько прохождений собрано на этой версии */
  responseCount: number;
}

/** Тревога по критическому пункту */
export interface RiskAlert {
  id: string;
  responseId: string;
  surveyId: string;
  surveyTitle: string;
  /** Пункт, поднявший тревогу; null у сигнала по полосе шкалы */
  questionId: string | null;
  /** Заголовок пункта, а у сигнала по шкале — название шкалы */
  questionTitle: string;
  userId: string | null;
  respondent: string | null;
  label: string;
  severity: RiskSeverity;
  at: string;
  acknowledgedBy: string | null;
  /** Клинический исход разбора; null — разобрана до внедрения исходов */
  outcome: "confirmed" | "not_confirmed" | "needs_followup" | null;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  note: string | null;
  /** Сколько минут тревога висит неразобранной */
  minutesOpen: number;
  /** Просрочена ли по правилу эскалации методики */
  overdue: boolean;
}

/** Условие показа вопроса, зависящее от ответа на другой вопрос */
export interface LogicRule {
  id: string;
  questionId: string;
  sourceQuestionId: string;
  operator: LogicOperator;
  /** JSON: id варианта, число или строка — зависит от оператора */
  value: unknown;
  action: LogicAction;
}

export interface Question {
  id: string;
  surveyId: string;
  sectionId: string | null;
  type: QuestionType;
  title: string;
  /** Пояснение под заголовком */
  help: string | null;
  required: boolean;
  position: number;

  /** Субшкала, в которую идёт балл за этот вопрос */
  scaleId: string | null;
  /** Обратный ключ: балл инвертируется относительно максимума шкалы */
  reverseScored: boolean;

  /** scale / slider / number */
  minValue: number | null;
  maxValue: number | null;
  step: number | null;
  minLabel: string | null;
  maxLabel: string | null;

  randomizeOptions: boolean;
  /** Лимит времени на вопрос, секунды */
  timeLimitSec: number | null;

  /** Для числовых вопросов: значение не ниже порога поднимает тревогу */
  riskThreshold: number | null;
  riskLabel: string | null;
  riskSeverity: RiskSeverity | null;

  options: Option[];
  logic: LogicRule[];
}

export interface Section {
  id: string;
  surveyId: string;
  title: string;
  description: string | null;
  position: number;
}

/** Интерпретационная норма: диапазон баллов → вывод */
export interface ScaleBand {
  id: string;
  scaleId: string;
  minScore: number;
  maxScore: number;
  label: string;
  severity: Severity;
  description: string | null;
  /**
   * Порядковая оценка методики. Отдельно от severity, потому что у части
   * методик шкала оценок перевёрнута: у СР-45 «1» — худший результат, «5» — лучший.
   */
  grade: number | null;
  /** Что делать: от амбулаторного наблюдения до обязательной госпитализации */
  recommendation: string | null;
  /** Каскад: попадание в полосу назначает эту батарею */
  cascadeBatteryId: string | null;
  cascadeDueDays: number | null;
  /** Протокол наблюдения: «7,30» — повторы через неделю и месяц */
  followUpDays: string | null;
  position: number;
}

/** Субшкала методики (тревога, депрессия, соматизация...) */
export interface Scale {
  id: string;
  surveyId: string;
  code: string;
  title: string;
  description: string | null;
  aggregation: ScaleAggregation;
  position: number;

  kind: ScaleKind;
  normalization: ScaleNormalization;
  /** Знаменатель для ratio: 35 у Sr, 10 у шкалы лжи */
  ratioDenominator: number | null;
  /** Порог недостоверности и сторона, с которой он нарушается */
  validityThreshold: number | null;
  validityDirection: ValidityDirection | null;
  validityMessage: string | null;

  bands: ScaleBand[];
  items: ScaleItem[];
  corrections: ScaleCorrection[];
  norms: ScaleNorm[];
  stenTable: StenRow[];
}

/**
 * Порог «слишком быстрого» ответа по умолчанию, мс, — когда у методики свой
 * (Survey.tooFastMs) не задан.
 *
 * Жил в apps/api/src/lib/psychometrics.ts, и пока его читала только
 * аналитика на сервере, этого хватало. Графики прохождения выделяют быстрые
 * ответы на клиенте по той же мерке, и вторая копия числа в вебе разошлась
 * бы с первой при первой же правке: аналитика методики называла бы ответ
 * быстрым, а экран прохождения — нет. Поэтому число здесь, а сервер берёт
 * его отсюда.
 */
export const TOO_FAST_MS = 1500;

export interface Survey {
  id: string;
  groupId: string | null;
  /**
   * Папка каталога; null — корень каталога группы.
   *
   * Папка всегда из той же группы, что и методика: это держит составной
   * ключ в базе, а не договорённость. Методика без группы папки не имеет.
   */
  folderId: string | null;
  title: string;
  description: string | null;
  /** Инструкция, показывается перед первым вопросом */
  instructions: string | null;
  /**
   * Кто заполняет: сам респондент или специалист за него.
   * SAD PERSONS, шкалы Бека и структурированные интервью заполняет клиницист.
   */
  administration: Administration;
  /** Порог «слишком быстрого» ответа, мс. null — берётся значение по умолчанию (TOO_FAST_MS) */
  tooFastMs: number | null;
  /** Через сколько минут неразобранная тревога просрочена. null — эскалации нет */
  alertEscalateMinutes: number | null;
  /** Немедленные действия при критическом ответе; показывается после сдачи при тревоге */
  safetyPlan: string | null;
  /** Пациент видит свою динамику по этой методике */
  showResultsToPatient: boolean;
  /** Демонстрационная: не для клинического применения */
  isDemo: boolean;
  /**
   * Правовой статус текста методики. README честно фиксировал, что тексты
   * требуют очистки прав перед клиническим применением, — но README не
   * мешает выдать методику пациенту.
   */
  rightsStatus?: "own" | "licensed" | "public_domain" | "unclear";
  status: SurveyStatus;

  timeLimitSec: number | null;
  randomizeQuestions: boolean;
  allowBack: boolean;
  showProgress: boolean;
  /** Не связывать прохождение с пользователем */
  anonymous: boolean;
  /** public — видна всем пациентам, restricted — только по персональному назначению */
  visibility: "public" | "restricted";
  /** Разрешить повторные прохождения — нужно для отслеживания динамики */
  allowRetake: boolean;
  scoringEnabled: boolean;

  createdBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  /**
   * Методика снята с использования: не выдаётся, не проходится, не попадает
   * в батареи и киоск — но остаётся во всех уже собранных записях.
   */
  archivedAt?: string | null;
  archivedByName?: string | null;
}

export interface SurveyFull extends Survey {
  sections: Section[];
  questions: Question[];
  scales: Scale[];
  /** Версия, содержимое которой отдано в этом ответе */
  versionId: string | null;
  versionNumber: number;
  /**
   * На каком языке на самом деле отдан текст (см. presentedLang).
   *
   * Совпадает с запрошенным почти всегда — кроме английского интерфейса:
   * английского текста у методик нет (CONTENT_LANGS), и отдаётся украинский.
   * По этому полю прохождение записывает язык предъявления, а экран
   * прохождения предупреждает человека одной строкой. Необязательное: его
   * нет у черновика конструктора и у сырой выдачи (raw), где язык не
   * выбирался вовсе.
   */
  contentLang?: Lang;
}

/** Точка динамики пациента по одной субшкале */
export interface DynamicsPoint {
  responseId: string;
  submittedAt: string;
  rawScore: number;
  maxScore: number;
  percent: number;
  bandLabel: string | null;
  severity: Severity | null;
  percentile: number | null;
  /**
   * Номер версии методики, которую человек реально видел.
   *
   * Скачок сразу после смены версии — часто артефакт правки ключей, а не
   * изменение состояния. Без этой отметки его читают как динамику.
   */
  versionNo?: number | null;
}

export interface ScaleDynamics {
  scaleId: string;
  code: string;
  title: string;
  points: DynamicsPoint[];
  /** Изменение между первым и последним замером */
  delta: number | null;
  /** Направление: улучшение зависит от того, что шкала измеряет */
  direction: "up" | "down" | "flat" | null;
  /**
   * Стандартная ошибка одного измерения — полуширина полосы на графике.
   *
   * null, когда считать её не из чего: мала выборка для SD или не считается
   * альфа. Тогда полоса не рисуется вовсе — придуманный интервал хуже, чем
   * его отсутствие, потому что выглядит как знание.
   */
  sem?: number | null;
  /**
   * Коэффициенты приведения баллов старых версий к версии последнего замера.
   *
   * null — приводить нельзя или не нужно: одна версия, малая выборка,
   * нулевой разброс. Отдаются именно коэффициенты и размеры выборок, а не
   * готовые приведённые баллы: приведение опирается на допущение о
   * сопоставимости выборок, и решать, выполняется ли оно, должен человек.
   */
  equated?:
    | {
        fromVersion: number;
        toVersion: number;
        slope: number;
        intercept: number;
        fromN: number;
        toN: number;
      }[]
    | null;
  /**
   * Достоверность сдвига первый↔последний (Jacobson–Truax).
   * null — посчитать нельзя: мало выборки для SD или альфы. Это честный
   * ответ, а не ноль: без ошибки измерения сдвиг не интерпретируем.
   */
  reliableChange: {
    rci: number;
    significant: boolean;
    direction: "up" | "down" | "flat";
    /** На чём основан расчёт — видно в подсказке */
    basis: { sd: number; alpha: number; sampleN: number };
  } | null;
}

/** Строка списка «кто проходил повторно» */
export interface Respondent {
  userId: string;
  fullName: string;
  email: string;
  /** Сколько завершённых прохождений */
  count: number;
  /** Дата последнего замера; null у прохождений без даты сдачи */
  last: string | null;
  /** Подразделение и пол — для фасетов списка */
  unit: string | null;
  sex: "male" | "female" | null;
  /** Год рождения — им различают тёзок; null, если дата не заполнена */
  birthYear: number | null;
  /**
   * Телефон — открытым текстом, как на кадрах f05/f13/f14: заказчик решил
   * показывать его в списках и карточке «как на макете» (2026-09-25).
   * В базе он по-прежнему шифрован; расшифровка — на сервере, чтение списка
   * записывается в журнал с пометкой, что телефоны в нём были.
   */
  phone: string | null;
}

export interface RespondentDynamics {
  userId: string;
  fullName: string;
  email: string;
  /**
   * Пол и возраст — для подсчёта норм на устройстве в режиме обхода.
   *
   * Возраст числом, а не датой рождения: для норм достаточно числа, а дата
   * рождения на планшете, который носят по отделению, — лишние сведения о
   * человеке без единого сценария, которому они нужны.
   */
  sex: Sex | null;
  age: number | null;
  surveys: {
    surveyId: string;
    title: string;
    responseCount: number;
    firstAt: string | null;
    lastAt: string | null;
    scales: ScaleDynamics[];
  }[];
}

export interface SurveyListItem extends Survey {
  questionCount: number;
  responseCount: number;
  /** Проходил ли текущий пользователь */
  completedByMe: boolean;
  /**
   * Назначена лично, а не просто доступна.
   *
   * Общедоступную методику человек проходит, если захочет; назначенную от
   * него ждут, и у неё есть срок. Одним списком без различия не видно ни
   * того ни другого.
   */
  assigned?: boolean;
  /** Срок назначения; null — не ограничивали */
  dueAt?: string | null;
  /** Когда ключи сверены с пособием */
  keysVerifiedAt?: string | null;
}

/** Ответ на один вопрос вместе с телеметрией */
export interface Answer {
  questionId: string;
  optionIds?: string[];
  text?: string;
  number?: number;
  date?: string;
  /** matrix: { rowId: optionId } */
  matrix?: Record<string, string>;
  /** ranking: упорядоченный список id вариантов */
  ranking?: string[];
  skipped?: boolean;

  /** Телеметрия, снимается на клиенте */
  durationMs?: number;
  /** Сколько раз респондент менял ответ перед отправкой */
  changeCount?: number;
  /** Сколько раз возвращался к вопросу */
  visitCount?: number;
}

export interface AnswerEvent {
  questionId: string;
  sequence: number;
  kind: "shown" | "set" | "change" | "clear" | "leave";
  elapsedMs: number;
  at: string;
  value?: unknown;
}

export interface SubmitResponsePayload {
  answers: Answer[];
  startedAt: string;
  durationMs: number;
  status?: "completed" | "abandoned";
  events: AnswerEvent[];
}

/** Рассчитанный балл по субшкале для конкретного прохождения */
export interface ScoreResult {
  scaleId: string;
  scaleCode: string;
  scaleTitle: string;
  kind: ScaleKind;
  /** Сумма вкладов пунктов до поправок и нормирования */
  rawScore: number;
  /** После поправок от других шкал (K-коррекция) */
  correctedScore: number;
  /** Итоговое значение: доля, T-балл или стен — по нормировке шкалы */
  value: number;
  /**
   * Удалось ли применить нормировку, объявленную шкалой.
   *
   * Ложь означает, что в `value` лежит сырой балл: нормы для этого пола нет,
   * балл вне таблицы стенов, знаменатель доли нулевой. Полосы интерпретации
   * и пороги достоверности заданы в единицах нормировки и к такому значению
   * не применяются — `band` будет null, а шкала достоверности объявит
   * протокол непроверяемым.
   */
  normalized: boolean;
  normalization: ScaleNormalization;
  maxScore: number;
  /** Процент от максимума, 0–100 */
  percent: number;
  band: {
    label: string;
    severity: Severity;
    description: string | null;
    grade: number | null;
    recommendation: string | null;
  } | null;
  /** Для шкал достоверности: нарушен ли порог */
  validityFailed?: boolean;
}

/** Итог по прохождению целиком с учётом шкал достоверности */
export interface ProfileResult {
  scores: ScoreResult[];
  /**
   * Можно ли доверять профилю. Если шкала достоверности вышла за порог,
   * содержательные шкалы всё равно считаются, но помечаются как ненадёжные —
   * решение об исключении принимает специалист, а не программа.
   */
  reliable: boolean;
  warnings: string[];
}

export interface SurveyResponse {
  id: string;
  surveyId: string;
  versionNumber?: number;
  userId: string | null;
  userName: string | null;
  status: ResponseStatus;
  startedAt: string;
  submittedAt: string | null;
  durationMs: number;
  scores: ScoreResult[];
}

/**
 * Прохождение целиком: ответы по пунктам, баллы, телеметрия.
 *
 * Варианты пункта приходят вместе с ответом, а не отдельным запросом за
 * методикой. Иначе читающий видит `optionIds` — набор идентификаторов, — и
 * чтобы узнать, что человек ответил, должен догрузить методику той версии,
 * которую тот проходил, и сопоставить руками. Ровно этого ему делать и не
 * следует: разбирающий смотрит на прохождение, чтобы прочитать ответы, а не
 * чтобы собрать их из двух источников.
 */
export interface ResponseDetail {
  id: string;
  /**
   * Обследуемый — чьё это прохождение. null у анонимной методики и у
   * заполненного со слов другого (informant): там прохождение намеренно не
   * связано с человеком.
   *
   * Нужен графикам прохождения: динамика — это все замеры ЭТОГО человека по
   * этой методике, и без идентификатора их не у кого спросить. Раньше экран
   * о человеке не знал ничего — он открывался из карточки, где человек уже
   * известен, но адрес прохождения его не несёт, и пересланная ссылка
   * должна работать сама по себе.
   */
  userId: string | null;
  survey: {
    id: string;
    title: string;
    scoringEnabled: boolean;
    /** Номер версии, которую человек проходил, — её и просят у GET /api/surveys/:id?version=N */
    versionNumber: number;
  };
  status: ResponseStatus;
  startedAt: string;
  submittedAt: string | null;
  durationMs: number;
  scores: ResponseDetailScore[];
  answers: ResponseDetailAnswer[];
}

/**
 * Балл по шкале вместе с лестницей полос.
 *
 * Одной попавшей полосы экрану мало: макет рисует все ступени «від — до» и
 * подсвечивает ту, куда лёг балл. Раньше лестницу собирали из действующей
 * методики, а человек мог проходить прежнюю версию с другими границами;
 * здесь полосы берутся из той же версии, что и ответы.
 */
export interface ResponseDetailScore extends ScoreResult {
  bands: ResponseDetailBand[];
}

export interface ResponseDetailBand {
  id: string;
  minScore: number;
  maxScore: number;
  label: string;
  severity: Severity;
  description: string | null;
  grade: number | null;
  recommendation: string | null;
  /** В эту полосу лёг балл: не больше одной на шкалу и ни одной, если балл не нормирован */
  hit: boolean;
}

export interface ResponseDetailAnswer {
  questionId: string;
  title: string;
  type: QuestionType;
  position: number;
  answered: boolean;
  optionIds: string[] | null;
  /** Варианты пункта в том виде, в каком их видел проходивший */
  options: {
    id: string;
    text: string;
    /** Выбор этого варианта поднимает тревогу немедленно */
    riskFlag: boolean;
    riskSeverity: RiskSeverity | null;
    /**
     * Вес варианта при подсчёте. Только персоналу: тот же маршрут открывает
     * своё прохождение сам обследуемый, а вес подсказывает, какой ответ
     * «правильный», — ему здесь null.
     */
    score: number | null;
  }[];
  text: string | null;
  number: number | null;
  date: string | null;
  matrix: Record<string, string> | null;
  ranking: string[] | null;
  score: number | null;
  durationMs: number;
  changeCount: number;
  visitCount: number;
  events: { kind: string; elapsedMs: number; at: string; value: string | null }[];
}

/**
 * Печатный лист ключей методики.
 *
 * Колонки ключа — по кодам ответов, которые встречаются в вариантах методики
 * (`keyCodes`), а не «да/нет»: у методики с третьим ответом («не знаю») ключ
 * на него иначе выпадал бы из печати, а сверка с пособием ради него и
 * затевалась. Поля `yes`, `no`, `scored` оставлены прежней странице печати.
 */
export interface SurveyKeySheet {
  surveyId: string;
  title: string;
  version: number;
  questionCount: number;
  questions: { n: number; title: string }[];
  /** Коды ответов в порядке появления в вариантах; label — текст первого варианта с этим кодом */
  keyCodes: { code: string; label: string }[];
  scales: SurveyKeySheetScale[];
}

export interface SurveyKeySheetScale {
  code: string;
  title: string;
  kind: ScaleKind;
  normalization: ScaleNormalization;
  itemCount: number;
  /** Номера пунктов по каждому коду из `keyCodes`, в том же порядке; пусто — код в этой шкале не ждут */
  keys: { code: string; label: string; items: string }[];
  yes: string;
  no: string;
  /** Пункты, которые дают балл выбранного варианта, а не совпадение с кодом */
  scored: string;
  corrections: string;
  norms: string;
  stens: string;
  bands: string;
}

/* ─────────────── Аналитика ─────────────── */

export interface QuestionAnalytics {
  questionId: string;
  title: string;
  type: QuestionType;
  position: number;

  shown: number;
  answered: number;
  skipped: number;
  skipRate: number;

  /** Время на вопрос, миллисекунды */
  avgDurationMs: number;
  medianDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  /**
   * Квартили времени ответа.
   *
   * Нужны потому, что min и max — это один самый быстрый и один самый
   * медленный человек, а не разброс: одного отвлёк телефон, и максимум по
   * пункту вырастает вчетверо. График, построенный по краям, показывает
   * выброс, а не то, сколько времени пункт занимает у людей.
   */
  p25DurationMs: number;
  p75DurationMs: number;
  /** Среднее число смен ответа — маркер сложных/неоднозначных формулировок */
  avgChangeCount: number;
  /** Среднее время до первого выбора: сколько думали, прежде чем ответить */
  avgTimeToFirstAnswerMs: number;
  /** Доля респондентов, менявших ответ хотя бы раз */
  changedShare: number;
  /** Доля ответов быстрее порога — признак небрежного заполнения */
  tooFastShare: number;

  /**
   * Распределение по вариантам.
   * percent для single/multiple/yesno — доля респондентов, для matrix — доля от всех
   * заполненных ячеек (респондент отвечает на каждую строку, поэтому база другая).
   * Для ranking вместо доли осмысленна средняя позиция в ранжировании.
   */
  options?: {
    optionId: string;
    text: string;
    count: number;
    percent: number;
    avgRank?: number;
    /**
     * Вес варианта при подсчёте; null — у варианта веса нет.
     *
     * Нужен экрану, чтобы отличить упорядоченный ряд («ніколи» → «майже
     * щодня», 0…3) от набора равноправных вариантов: первый рисуется
     * ступенями одного тона, второй — без порядка. Угадывать порядок по
     * тексту варианта нельзя, а по весу — это ровно то, как методика сама
     * его понимает. Маршрут закрыт правом аналитики, пациенту веса не уходят.
     */
    score?: number | null;
  }[];
  /** Числовые вопросы: scale/slider/number */
  numeric?: {
    average: number;
    median: number;
    min: number;
    max: number;
    /** Гистограмма: значение → количество */
    distribution: { value: number; count: number }[];
  };
  /** Свободные ответы */
  texts?: string[];
}

/** Психометрика одного пункта относительно его субшкалы */
export interface ItemStat {
  questionId: string;
  title: string;
  /** Корреляция пункта с суммой остальных пунктов шкалы (исправленная) */
  itemTotalCorrelation: number;
  /**
   * Альфа шкалы без этого пункта: рост означает, что пункт вредит согласованности.
   * null для шкалы из двух пунктов — там величина не определена.
   */
  alphaIfDeleted: number | null;
  variance: number;
  /**
   * Доля прохождений, где пункт сработал (вклад выше собственного минимума).
   * null — прохождений меньше тридцати: доля на такой выборке шумит сильнее,
   * чем различия, ради которых её смотрят. Доли по каждому варианту ответа —
   * в разборе вопроса, questions[].options.
   */
  endorsement: number | null;
  /**
   * Пункт различает людей: корреляция с суммой остальных не ниже 0.2.
   * null — выборки не хватает, чтобы отличить 0.2 от нуля.
   */
  discriminating: boolean | null;
}

/** Надёжность субшкалы */
export interface Reliability {
  /** Альфа Кронбаха: внутренняя согласованность, 0–1 */
  alpha: number;
  itemCount: number;
  items: ItemStat[];
  /** Сколько полных профилей легло в расчёт — без этого числа альфа не читается */
  sampleN: number;
  /**
   * Омега Макдональда по однофакторной модели — ВЕРХНЯЯ оценка надёжности.
   *
   * Стоит рядом с альфой, потому что альфа занижает надёжность разновесных
   * пунктов, и по ней списывают годные шкалы. Нагрузки взяты из главной
   * компоненты, а не из факторного анализа, поэтому ω завышена; верить ей
   * стоит, когда она подтверждает альфу, и не стоит, когда она одна
   * вытягивает шкалу выше порога. null — пунктов меньше трёх или
   * прохождений меньше пятидесяти.
   */
  omega: number | null;
  /** Сколько пунктов не различают людей; null — выборки не хватает для решения */
  weakItems: number | null;
}

/** Признаки небрежного заполнения у одного прохождения */
export interface QualityFlags {
  responseId: string;
  respondent: string | null;
  submittedAt: string | null;
  durationMs: number;
  /** Доля вопросов, отвеченных быстрее порога */
  tooFastShare: number;
  /** Самая длинная серия одинаковых ответов подряд */
  longestStraightLine: number;
  /**
   * Нормированные ошибки Гуттмана (7.1): 0 — профиль согласован с трудностью
   * пунктов, ~0.5 — как случайный, ближе к 1 — инвертирован. null — шкала не
   * ключевая или профиль крайний (всё «да» / всё «нет»), где метрика слепа.
   */
  personFit: number | null;
  flagged: boolean;
  reasons: string[];
}

/** Пол и потолок шкалы: сколько прохождений упёрлось в её края */
export interface FloorCeiling {
  n: number;
  /** null — прохождений меньше пятидесяти, доля на такой выборке шумит на 6 п.п. */
  floorPercent: number | null;
  ceilingPercent: number | null;
  /** Край не различает людей: доля выше 15% (Terwee, 2007) */
  floorProblem: boolean | null;
  ceilingProblem: boolean | null;
}

/** Форма распределения шкалы по накопленной выборке */
export interface ScaleShape {
  /** Число прохождений — единственное, что отдаётся при выборке ниже порога малых ячеек */
  n: number;
  mean: number | null;
  median: number | null;
  sd: number | null;
  /** null при n < 50: на меньшей выборке величина не отличима от нуля */
  skewness: number | null;
  kurtosis: number | null;
  /** null при n < 20: хвосты были бы одним наблюдением, выданным за квантиль */
  percentiles: { p5: number; p10: number; p25: number; p50: number; p75: number; p90: number; p95: number } | null;
}

/**
 * Ошибка измерения шкалы в её собственных единицах.
 *
 * Отдаётся рядом с распределением, чтобы специалист видел, какая разница
 * вообще что-то значит: mdc95 — минимальная перемена, которую нельзя
 * объяснить погрешностью инструмента.
 */
export interface ScaleMeasurement {
  sem: number;
  sdiff: number;
  mdc95: number;
  /** На чём посчитано: SD накопленной выборки и фактическая альфа */
  basis: { sd: number; alpha: number; sampleN: number };
}

export interface ScaleAnalytics {
  scaleId: string;
  code: string;
  title: string;
  /**
   * Содержательная шкала или шкала достоверности.
   *
   * Экрану нужно, чтобы «загальний стан» не смешивал состояние людей с
   * качеством протоколов: полоса шкалы лжи говорит о заполнении, а не о
   * человеке, и в общей картине её ставят отдельно.
   */
  kind: ScaleKind;
  average: number;
  median: number;
  min: number;
  max: number;
  /**
   * Квартили итогового значения.
   *
   * Ящик с усами раньше строился из min/среднего/медианы/max, то есть его
   * коробка была квартилями четырёх сводных чисел, а не выборки. Рисунок
   * получался правдоподобным и неверным: коробка означала «между средним и
   * медианой», хотя читается она как «половина обследованных».
   */
  p25: number;
  p75: number;
  maxPossible: number;
  /** Сколько прохождений попало в каждую интерпретационную полосу */
  /*
   * Границы полосы (min/max) — те же, что у ScaleBand версии: без них экран
   * не может нарисовать лестницу, на которой ходит среднее по неделям, и
   * пришлось бы догружать методику ради четырёх чисел на полосу.
   */
  bands: { label: string; severity: Severity; count: number; percent: number; min: number; max: number }[];
  /** null, если пунктов меньше двух или нет разброса ответов */
  reliability: Reliability | null;
  /** Форма распределения по накопленной выборке; при малой выборке — только n */
  shape: ScaleShape;
  /** Доля упёршихся в края шкалы; null — границы шкалы неизвестны */
  floorCeiling: FloorCeiling | null;
  /** SEM и MDC95; null — нечем посчитать: мала выборка или не считается альфа */
  measurement: ScaleMeasurement | null;
}

export interface SurveyAnalytics {
  surveyId: string;
  title: string;
  /** Версия, по которой посчитаны срезы */
  versionId: string | null;
  versionNumber: number;
  /** Все версии с числом прохождений — для переключателя */
  versions: { id: string; version: number; responseCount: number; note: string | null }[];
  /** Кто прямо сейчас в процессе: черновики со свежим автосохранением */
  inProgressNow: { userName: string | null; startedAt: string; lastSavedAt: string; answered: number }[];

  started: number;
  completed: number;
  abandoned: number;
  completionRate: number;

  avgDurationMs: number;
  medianDurationMs: number;

  /**
   * На каком вопросе люди бросают прохождение.
   *
   * reached/lost — воронка «сколько досюда дошло»; endedHere — сколько
   * прохождений этим пунктом ЗАКОНЧИЛОСЬ, то есть он был последним
   * отвеченным. Второе находит пункт, с которого уходят: воронка проседает и
   * от логики показа, а обрыв — только от пункта. null у endedHere и его
   * доли — порог малых ячеек: один ушедший опознаётся в малой группе.
   */
  dropOff: {
    questionId: string;
    title: string;
    position: number;
    reached: number;
    lost: number;
    endedHere: number | null;
    endedHerePercent: number | null;
    /** Среднее время на пункте — рядом с обрывом: длинный пункт и есть причина */
    avgDurationMs: number;
  }[];

  questions: QuestionAnalytics[];
  scales: ScaleAnalytics[];
  /** Прохождения с признаками небрежного заполнения */
  quality: QualityFlags[];
  /** Порог «слишком быстрого» ответа, миллисекунды */
  tooFastThresholdMs: number;
  /** Прохождения по дням для графика динамики */
  timeline: { date: string; count: number }[];
  /**
   * Сколько разных людей среди завершённых прохождений.
   *
   * «Проходжень» и «пацієнтів» отвечают на разные вопросы: сорок замеров
   * бывают и у сорока человек, и у восьми, прошедших пять раз. Это объём
   * работы, а не сведение о ком-то, и порогу малых ячеек не подлежит — как и
   * число прохождений рядом.
   */
  respondentCount: number;
  /**
   * Среднее итоговое значение шкалы по неделям — «общее состояние» во времени.
   *
   * Неделя, а не день: за день в отделении проходят единицы, и среднее по
   * трём людям — это три человека, а не состояние. По той же причине неделя
   * с числом прохождений меньше порога малых ячеек отдаёт mean: null — «мало
   * данных», а не ноль: ноль на лестнице тяжести читался бы как «всем
   * хорошо». n отдаётся всегда: это объём, как и timeline.
   *
   * Считается по однородным значениям (comparableScores): T-балл одного
   * человека без нормы в сыром виде сдвинул бы среднее недели на десятки.
   */
  scaleTimeline: { scaleId: string; weeks: { week: string; n: number; mean: number | null }[] }[];
  /**
   * Распределение общей длительности прохождения — корзины по времени.
   *
   * Корзина — полуоткрытый отрезок [fromMs, toMs); у последней toMs = null
   * («і довше»): хвост из одного человека, забывшего вкладку открытой на
   * ночь, растянул бы шкалу на весь экран. count — через порог малых ячеек:
   * «один человек проходил два часа» в маленьком отделении называет
   * человека.
   */
  durationBins: { fromMs: number; toMs: number | null; count: number | null }[];
  /**
   * Ответы одного человека по его прохождениям — только при фильтре по
   * человеку (?userId), иначе null.
   */
  answerMatrix: AnswerMatrix | null;
}

/**
 * «Як змінювались відповіді»: матрица «пункт × прохождение» одного человека.
 *
 * Отдельный ответ, а не шесть запросов протоколов: протокол везёт ленту
 * событий каждого пункта, и на методике в двести пунктов шесть протоколов —
 * это мегабайты ради одной клетки на пункт. Здесь на клетку ровно то, что
 * рисуется: выбранный вариант и его вес.
 *
 * Прохождения — одной версии (той, что выбрана в аналитике): пункты разных
 * версий — разные строки базы, и склеивать их по номеру значило бы
 * поставить рядом ответы на, возможно, разные вопросы.
 */
export interface AnswerMatrix {
  /** По времени, старые слева; не больше шести последних завершённых */
  responses: { id: string; submittedAt: string | null; durationMs: number }[];
  rows: {
    questionId: string;
    position: number;
    title: string;
    type: QuestionType;
    /** Наибольший вес варианта пункта; null — у пункта весов нет */
    maxScore: number | null;
    /**
     * Клетка на прохождение, в порядке `responses`. null — пункт этому
     * прохождению не показывался. label null при ответе — ответ есть, но
     * печатать его в клетке нельзя или нечего (свободный текст, матрица,
     * ранжирование): свободный текст — персональные данные, и в сетку он не
     * уходит.
     */
    cells: ({ label: string | null; score: number | null; skipped: boolean; changed: boolean; durationMs: number } | null)[];
  }[];
}

/** Кто заполняет методику: сам обследуемый или специалист */
/**
 * Кто заполняет методику.
 *
 * `informant` — короткая форма для командира, сослуживца или родственника.
 * Отдельный вид, а не второй способ заполнить ту же методику: смешивать
 * самоотчёт и наблюдение со стороны в одной выборке значит испортить и нормы,
 * и оценку надёжности.
 */
export type Administration = "self" | "clinician" | "informant";

/** Батарея: набор методик, назначаемый целиком */
export interface BatteryItem {
  surveyId: string;
  title: string;
  position: number;
  required: boolean;
  /**
   * Кто заполняет. Батарея может смешивать режимы: скрининг заполняет
   * клиницист, основной опросник — обследуемый. Обследуемому такой шаг видно,
   * но открыть его он не может, поэтому режим обязан доезжать до экрана.
   */
  administration: Administration;
  questionCount: number;
  /** Ориентировочная длительность по фактическим прохождениям, минут */
  medianMinutes: number | null;
}

export interface Battery {
  id: string;
  title: string;
  description: string | null;
  groupId: string | null;
  groupTitle: string | null;
  strictOrder: boolean;
  archived: boolean;
  createdAt: string;
  items: BatteryItem[];
  /** Сколько активных назначений висит на батарее */
  activeAssignments: number;
}

export type BatteryProgressState = "done" | "current" | "locked" | "available";

export interface BatteryStep extends BatteryItem {
  state: BatteryProgressState;
  responseId: string | null;
  submittedAt: string | null;
}

export interface BatteryAssignment {
  id: string;
  batteryId: string;
  batteryTitle: string;
  userId: string;
  userName: string;
  assignedAt: string;
  dueAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  note: string | null;
  /** Просрочено: срок прошёл, а обязательные методики не пройдены */
  overdue: boolean;
  doneRequired: number;
  totalRequired: number;
  steps: BatteryStep[];
}

/** Приглашение: вход пациента по ссылке или короткому коду */
export interface Invite {
  id: string;
  /** Короткий код для ручного ввода (показывается только при создании и в списке staff) */
  code: string;
  batteryId: string | null;
  batteryTitle: string | null;
  /** Одна методика вместо набора: взаимоисключающи, заполнено не больше одного */
  surveyId: string | null;
  surveyTitle: string | null;
  /** Врач, за которым закрепится вошедший по ссылке */
  specialistId: string | null;
  specialistName: string | null;
  unit: string | null;
  note: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  createdByName: string;
  /** Кто вошёл по приглашению */
  uses: { userId: string; fullName: string; usedAt: string }[];
}

/** Что видит человек, открывший ссылку, до регистрации */
export interface InvitePreview {
  valid: boolean;
  reason?: "expired" | "revoked" | "exhausted" | "unknown";
  batteryTitle?: string | null;
  /** Название одной методики, если ссылка привязана к ней, а не к набору */
  surveyTitle?: string | null;
  unit?: string | null;
}

/** Направление (6.4) */
export type ReferralDestination = "psychiatrist" | "inpatient" | "outpatient" | "commander" | "other";
export type ReferralUrgency = "routine" | "urgent" | "immediate";
export type ReferralStatus = "created" | "accepted" | "completed" | "declined";

export interface Referral {
  id: string;
  userId: string;
  userName: string;
  responseId: string | null;
  alertId: string | null;
  destination: ReferralDestination;
  urgency: ReferralUrgency;
  status: ReferralStatus;
  reason: string | null;
  outcomeNote: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string | null;
}

/** Сводка для консилиума (6.5): всё о пациенте на одной странице */
export interface CaseSummary {
  userId: string;
  fullName: string;
  sex: Sex | null;
  age: number | null;
  unit: string | null;
  surveys: {
    surveyId: string;
    title: string;
    lastAt: string | null;
    count: number;
    scales: {
      code: string;
      title: string;
      lastValue: number;
      normalization: ScaleNormalization;
      bandLabel: string | null;
      severity: Severity | null;
      /** Достоверность сдвига между первым и последним замером */
      reliableChange: { rci: number; significant: boolean; direction: "up" | "down" | "flat" } | null;
    }[];
  }[];
  openAlerts: { id: string; label: string; severity: string; at: string; surveyTitle: string }[];
  conclusions: { responseId: string; surveyTitle: string; text: string; signedAt: string | null; authorName: string }[];
  referrals: Referral[];
}

/** Динамика самого пациента — то, что он видит о себе */
export interface MyDynamics {
  surveys: {
    surveyId: string;
    title: string;
    scales: {
      code: string;
      title: string;
      points: { submittedAt: string; value: number; bandLabel: string | null; severity: Severity | null }[];
    }[];
  }[];
}

/** Сводка по всем опросам — для главного экрана аналитики */
export interface OverviewAnalytics {
  surveyCount: number;
  publishedCount: number;
  responseCount: number;
  respondentCount: number;
  avgDurationMs: number;
  completionRate: number;
  /** Топ методик по числу прохождений */
  topSurveys: { surveyId: string; title: string; responseCount: number; avgDurationMs: number }[];
  /** Распределение по степени выраженности across всех шкал */
  severityBreakdown: { severity: Severity; count: number }[];
  timeline: { date: string; count: number }[];
  /**
   * Кто проходит методику прямо сейчас — черновики свежее получаса.
   * По методике такой список уже есть (`inProgressNow`); здесь он сводный,
   * чтобы дежурный видел всю картину не заходя в каждую методику.
   */
  inProgress: {
    responseId: string;
    userId: string | null;
    surveyId: string;
    surveyTitle: string;
    startedAt: string;
    lastSavedAt: string;
  }[];
}

/**
 * Степени выраженности по неделям — для области с накоплением.
 *
 * Неделя, а не день: результаты приходят неровно, и по дням ряд состоит из
 * нулей с одиночными всплесками — по такому графику не видно ни уровня, ни
 * направления. Неделя — самый короткий шаг, на котором в поликлинике
 * набирается осмысленное число обследований.
 *
 * Счётчики — по прохождениям, а не по шкалам: у методики с восемью
 * субшкалами одно обследование дало бы восемь отметок и перевесило бы
 * восемь обследований по короткому скринингу. Степень прохождения — самая
 * тяжёлая из его шкал: обследование, где хоть что-то тяжёлое, — это срочный
 * случай, а не «в среднем спокойный».
 */
export interface SeverityTrend {
  /** Понедельник недели, YYYY-MM-DD */
  week: string;
  none: number;
  mild: number;
  moderate: number;
  severe: number;
}

export interface SeverityTrendResult {
  weeks: SeverityTrend[];
  /** Сколько прохождений осталось без интерпретации: у шкал нет норм */
  unbanded: number;
}

/**
 * Клиническое направление сводки: к какому вопросу о человеке относится шкала.
 *
 * Направление — не методика и не шкала, а то, что спрашивают на планёрке:
 * «как у нас с депрессией». Отвечают на него разные методики (PHQ-9, PHQ-8,
 * депрессивная часть PHQ-4, CESD-R…), и баллы их в одних единицах не
 * складываются — поэтому сводятся они только через собственные полосы
 * каждой методики, а средний балл считается по одной, основной
 * (apps/api/src/lib/conditions.ts).
 */
export type ConditionDomain =
  | "depression"
  | "anxiety"
  | "stress"
  | "ptsd"
  | "wellbeing"
  | "burnout"
  | "alcohol";

/**
 * Люди по ступеням выраженности — уже через порог малых ячеек.
 *
 * `null` везде значит «не показываем», а не «ноль»: ноль приходит нулём.
 * Три состояния различаются по `banded`: 0 — у методик направления нет
 * полос вовсе (PSS-10, DASS-42), null — людей с полосой меньше порога,
 * число — раскладка есть, но отдельные ячейки в ней могут быть скрыты.
 */
export interface BandSpread {
  banded: number | null;
  /** Помірна + виражена по полосам самой методики: число и доля от banded */
  clinical: { count: number | null; percent: number | null };
  bands: Record<Severity, number | null>;
}

export interface ConditionSummary {
  domain: ConditionDomain;
  /**
   * Куда смотрит балл: у благополучия (WHO-5) больше — лучше. Доля в
   * клинических полосах от этого не зависит — полосы методики уже повёрнуты
   * как надо, — а средний балл без этого флага читался бы наоборот.
   */
  higherIsWorse: boolean;
  /** Людей с замером за период; null — меньше порога («замало даних») */
  people: number | null;
  spread: BandSpread;
  /**
   * Основная методика направления — та, по которой за период замерено больше
   * всего людей. Средний балл — только по ней: проценты разных методик
   * в одно среднее не сводятся.
   */
  primary: {
    surveyId: string;
    title: string;
    people: number | null;
    /** Средний балл последних замеров, % от максимума шкалы; null — скрыто */
    meanPercent: number | null;
  } | null;
  /** Ход среднего балла основной методики по неделям; null — неделя под порогом */
  weeks: { week: string; meanPercent: number | null }[];
  /** Методики, чьи замеры вошли в направление, — словами */
  sources: { surveyId: string; title: string }[];
}

export interface ConditionsResult {
  days: number;
  /** Начало периода, ISO */
  since: string;
  /** Направления, по которым за период есть хоть один замер */
  domains: ConditionSummary[];
  /** Направления без единого замера — одной строкой, без пустых блоков */
  empty: ConditionDomain[];
  /**
   * Все методики разом: каждый человек — один раз, по самой тяжёлой из
   * последних оценок каждой его шкалы.
   */
  overall: { people: number | null; spread: BandSpread };
}

export interface AuthPayload {
  /** Одноразовый refresh-токен: хранить в защищённом хранилище */
  refreshToken: string;
  token: string;
  user: User;
}

/* ─────────── техпанель: наблюдаемость (/api/ops) ─────────── */

/*
 * Всё, что ниже, живёт в памяти одного процесса API и обнуляется при его
 * перезапуске (apps/api/src/lib/opsBuffer.ts). Поэтому почти у каждого
 * ответа есть `since` — момент запуска процесса: экран обязан говорить «с
 * такого-то времени», а не выдавать короткую память за полную историю.
 *
 * Перечисления приходят кодами, а не фразами: фразу собирает консоль из
 * словаря на языке того, кто смотрит.
 */

export type OpsLevel = "debug" | "info" | "warn" | "error";

/** Окно графика нагрузки */
export type OpsWindow = "1h" | "6h" | "24h";

/** Состояние подключения к базе — коды pg_stat_activity.state без пробелов */
export type OpsConnState =
  | "active"
  | "idle"
  | "idle_in_transaction"
  | "idle_in_transaction_aborted"
  | "fastpath"
  | "disabled"
  /** Сессия чужой роли: без pg_read_all_stats её состояние не видно */
  | "hidden";

export interface OpsConnections {
  total: number;
  byState: { state: OpsConnState; count: number }[];
  /** max_connections сервера базы */
  max: number | null;
}

/** Сводка запросов за окно: число, ошибки, время ответа */
export interface OpsWindowStats {
  requests: number;
  errors4xx: number;
  errors5xx: number;
  /** Доля 5xx от 0 до 1; null — запросов не было, делить не на что */
  share5xx: number | null;
  avgMs: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  maxMs: number | null;
}

export type OpsHealthStatus = "ok" | "warn" | "fail";

export type OpsHealthKey =
  | "db"
  | "rls"
  | "migrations"
  | "scheduler"
  | "encryption"
  | "errorReport"
  | "metricsToken"
  | "errorRate";

/**
 * Проверка здоровья: статус и код причины, по которому консоль берёт фразу.
 * `value` — число для подстановки (мс, минуты, штуки, проценты). Значения
 * секретов сюда не попадают никогда: про ключи отвечается только «задан /
 * не задан».
 */
export interface OpsHealthCheck {
  key: OpsHealthKey;
  status: OpsHealthStatus;
  reason: string;
  value?: number | null;
}

export interface OpsOverview {
  since: string;
  build: {
    /** QUIZZY_VERSION выкатки; null — переменная не задана (сборка на месте) */
    version: string | null;
    /** QUIZZY_BUILD — коммит или номер сборки CI */
    commit: string | null;
    packageVersion: string;
    env: "production" | "development";
    runtime: string;
    startedAt: string;
  };
  process: {
    uptimeSec: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    /** Средняя нагрузка ОС за 1, 5 и 15 минут */
    loadAvg: [number, number, number];
    cpus: number;
    /** Задержка цикла событий за последнюю минуту; null — замеров ещё нет */
    eventLoopLagMs: { mean: number | null; max: number | null };
  };
  db: {
    bytes: number | null;
    latencyMs: number | null;
    connections: OpsConnections | null;
    lastMigration: { tag: string | null; idx: number | null } | null;
    pendingMigrations: number | null;
  };
  scheduler: { enabled: boolean; lastTickAt: string | null };
  openCases: number | null;
  /** Учётки по ролям — только числа */
  accounts: { superadmin: number; admin: number; user: number } | null;
  traffic: { m5: OpsWindowStats; h1: OpsWindowStats; h24: OpsWindowStats };
  health: OpsHealthCheck[];
}

export interface OpsTrafficBucket {
  /** Начало корзины */
  at: string;
  requests: number;
  errors4xx: number;
  errors5xx: number;
  avgMs: number | null;
  maxMs: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface OpsTraffic {
  since: string;
  window: OpsWindow;
  /** Ширина корзины, секунды */
  stepSec: number;
  buckets: OpsTrafficBucket[];
}

/** Маршрут шаблоном («GET /api/responses/:id»), а не конкретный адрес */
export interface OpsRouteStat extends OpsWindowStats {
  method: string;
  route: string;
}

export interface OpsRoutes {
  since: string;
  items: OpsRouteStat[];
}

export interface OpsSlowRequest {
  at: string;
  method: string;
  route: string;
  /** HTTP-код ответа */
  code: number;
  ms: number;
  role: Role | null;
  requestId: string;
}

export interface OpsSlow {
  since: string;
  thresholdMs: number;
  capacity: number;
  items: OpsSlowRequest[];
}

export interface OpsErrorGroup {
  fingerprint: string;
  /** request — необработанное исключение запроса; log — запись log.error вне него */
  origin: "request" | "log";
  name: string;
  /** Сообщение без данных: литералы, идентификаторы, почта и телефоны вычищены */
  message: string;
  method: string | null;
  route: string | null;
  code: number | null;
  count: number;
  firstAt: string;
  lastAt: string;
  lastRequestId: string | null;
  /** Кадры стека: файл, строка, функция — без сообщения и без данных */
  frames: string[];
}

export interface OpsErrors {
  since: string;
  capacity: number;
  /** Сколько групп вытеснено, когда их стало больше вместимости */
  dropped: number;
  items: OpsErrorGroup[];
}

export interface OpsLogLine {
  seq: number;
  at: string;
  level: OpsLevel;
  message: string;
  requestId: string | null;
  fields: Record<string, unknown>;
}

export interface OpsLogs {
  since: string;
  capacity: number;
  /** С какого уровня процесс вообще пишет (LOG_LEVEL) */
  threshold: OpsLevel;
  /** Номер последней записи буфера: его клиент присылает в `after` */
  cursor: number;
  /** Самая старая запись, ещё лежащая в буфере; null — буфер пуст */
  oldestSeq: number | null;
  /** Курсор клиента выпал из буфера: часть строк вытеснена, пока лента стояла */
  gap: boolean;
  /** Совпавших строк было больше, чем отдано */
  truncated: boolean;
  items: OpsLogLine[];
}

export interface OpsTableStat {
  table: string;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  liveRows: number | null;
  deadRows: number | null;
  seqScan: number | null;
  idxScan: number | null;
  lastAutovacuum: string | null;
  lastAutoanalyze: string | null;
}

export interface OpsLongQuery {
  pid: number;
  seconds: number;
  state: OpsConnState | null;
  waitEvent: string | null;
  /** Обрезан до 200 знаков, литералы в кавычках заменены на «?» */
  query: string;
}

export interface OpsLockWait {
  pid: number;
  seconds: number;
  lockType: string;
  lockMode: string;
  relation: string | null;
  blockedBy: number[];
  query: string;
}

export interface OpsMigration {
  idx: number | null;
  tag: string | null;
  /** Метка миграции из журнала (`when`), а не момент применения: его drizzle не хранит */
  at: string;
}

/**
 * Почему раздел пуст: не хватило прав роли приложения или запрос не
 * прошёл. Коды, а не фразы — фразу берёт консоль.
 */
export type OpsDbNote =
  | "activityDenied"
  | "activityPartial"
  | "tablesFailed"
  | "locksFailed"
  | "migrationsDenied"
  | "sizeFailed";

export interface OpsDb {
  bytes: number | null;
  tables: OpsTableStat[] | null;
  connections: OpsConnections | null;
  longQueries: OpsLongQuery[] | null;
  locks: OpsLockWait[] | null;
  migrations: { applied: OpsMigration[]; appliedCount: number; known: number; pending: number } | null;
  notes: OpsDbNote[];
}

export type OpsJobResult = "ok" | "error" | "skipped" | "running";

export interface OpsJob {
  name: string;
  intervalSec: number;
  runs: number;
  failures: number;
  skipped: number;
  lastStartAt: string | null;
  lastEndAt: string | null;
  lastDurationMs: number | null;
  lastResult: OpsJobResult | null;
  lastError: string | null;
  lastErrorAt: string | null;
  nextAt: string | null;
}

export interface OpsJobs {
  since: string;
  /** SCHEDULER_ENABLED: на этом экземпляре фоновые задачи вообще идут */
  schedulerEnabled: boolean;
  items: OpsJob[];
  /** Последние срабатывания расписаний из базы — они переживают перезапуск */
  scheduleRuns: { at: string; assigned: number; skipped: number; note: string | null }[] | null;
}

/** Запись журнала доступа */
export interface AuditEntry {
  id: string;
  at: string;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: Role | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  subjectUserId: string | null;
  outcome: "success" | "denied" | "error";
  ip: string | null;
  userAgent: string | null;
  details: Record<string, unknown> | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  total: number;
  /** Сколько записей пропущено — для постраничной выдачи */
  offset: number;
  limit: number;
}


/* ─────────── случаи риска ─────────── */

/**
 * Откуда взялся сигнал.
 *
 * Два вида, и путать их нельзя: `option` — человек отметил помеченный
 * вариант ответа, `band` — суммарный балл шкалы попал в полосу. У первого
 * есть пункт и отмеченный вариант, у второго — шкала, значение и границы
 * полосы. Общего поля «заголовок» им хватало ровно до вопроса «на каком
 * основании», который и задаёт разбирающий.
 */
export type AlertSignalKind = "option" | "band";

/** Один сигнал внутри случая: какой пункт сработал */
export interface AlertSignal {
  id: string;
  responseId: string;
  /**
   * Откуда сигнал. Приходит явно, а не выводится из `questionId`: экран
   * подписывает строку словом «пункт» или «шкала», и вычислять это из
   * пустоты соседнего поля значит однажды подписать неверно.
   */
  kind: AlertSignalKind;
  /** Пункт, поднявший тревогу; null у сигнала по полосе шкалы */
  questionId: string | null;
  /** Заголовок пункта, а у сигнала по шкале — название шкалы */
  questionTitle: string;
  label: string;
  severity: RiskSeverity;
  at: string;
}

/**
 * Основание сигнала целиком: по какой методике и какому ответу или полосе
 * шкалы система решила, что у человека риск.
 *
 * Приходит отдельным запросом, а не вместе с очередью: очередь показывает
 * тридцать случаев, а основание читают у одного, и тянуть ответы, варианты
 * и баллы на все тридцать значило бы платить за то, чего никто не смотрит.
 */
export interface AlertSignalBasis {
  id: string;
  kind: AlertSignalKind;
  responseId: string;
  /** Методика, по которой поднят сигнал — у случая их может быть несколько */
  surveyId: string;
  surveyTitle: string;
  /** Готовая подпись, записанная в момент срабатывания */
  label: string;
  severity: RiskSeverity;
  at: string;
  /** Прохождение целиком доступно только если методика в зоне ответственности */
  responseSubmittedAt: string | null;

  /* ── kind === "option" ── */
  questionId: string | null;
  /** Номер пункта в методике: по нему пункт ищут в бланке */
  questionNumber: number | null;
  questionTitle: string | null;
  /** Что человек отметил: тексты выбранных вариантов */
  pickedOptions: string[];
  /** Числовой ответ, если сигнал поднял порог по числу */
  answeredNumber: number | null;

  /* ── kind === "band" ── */
  scaleId: string | null;
  scaleCode: string | null;
  scaleTitle: string | null;
  /** Значение в единицах нормировки: стены, T-баллы, доля */
  scaleValue: number | null;
  scaleRawScore: number | null;
  normalization: ScaleNormalization | null;
  bandLabel: string | null;
  /** Границы полосы — чтобы видеть, насколько значение зашло внутрь */
  bandMin: number | null;
  bandMax: number | null;
  bandDescription: string | null;
  bandRecommendation: string | null;
}

/**
 * Случай риска — единица разбора.
 *
 * Тревога поднимается на пункт, но решение принимается о человеке: пять
 * отмеченных пунктов одного обследуемого — один случай.
 */
export interface AlertCase {
  id: string;
  userId: string;
  userName: string;
  unit: string | null;
  surveyId: string;
  surveyTitle: string;

  severity: RiskSeverity;
  openedAt: string;
  lastAlertAt: string;
  /** Сколько сигналов внутри */
  signalCount: number;
  /** Сигналы: приходят с самим случаем — их немного, и без них он бессмыслен */
  signals: AlertSignal[];

  /** Минут в открытом состоянии; для разобранных — сколько провисел */
  minutesOpen: number;
  /** Просрочен по настройке эскалации методики */
  overdue: boolean;

  assignedTo: string | null;
  assignedToName: string | null;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  note: string | null;
  outcome: AlertOutcome | null;
  /** Собран автоматически при переходе со старой модели, а не решением специалиста */
  mergedFromLegacy: boolean;
}

export type AlertOutcome = "confirmed" | "not_confirmed" | "needs_followup";

/** Страница списка: курсор вместо номера — список меняется прямо во время разбора */
export interface Page<T> {
  items: T[];
  /** null — больше ничего нет */
  nextCursor: string | null;
  /** Всего подходящих под фильтр; считается отдельно и только на первой странице */
  total?: number;
}

export interface AlertCaseFilters {
  /** Разобранные тоже */
  all?: boolean;
  severity?: RiskSeverity;
  unit?: string;
  /** "me" — мои, "none" — ничьи */
  assigned?: string;
  surveyId?: string;
  search?: string;
}


/** Одна строка очереди работы специалиста */
/**
 * Виды работы в очереди.
 *
 * Отдельный тип, а не строчный union внутри WorkItem: маршрут объявлял свой
 * список видов, клиент — свой, и разошлись они молча. Появилась неявка —
 * сервер начал её слать, а консоль не знала такого вида и рисовала строку
 * без названия. Теперь список один на обе стороны, и добавить вид только с
 * одной из них нельзя.
 */
export type WorkKind =
  | "noshow"
  | "message"
  | "dispensary"
  | "assignment"
  | "referral"
  | "followup";

export interface WorkItem {
  kind: WorkKind;
  id: string;
  userId: string;
  userName: string;
  unit: string | null;
  /** Для случая — название методики, для направления — его статус */
  title: string;
  /** Факты, а не готовая строка: отображение принадлежит клиенту */
  severity?: "moderate" | "severe";
  signals?: number;
  days?: number;
  destination?: string;
  overdue: boolean;
  assignedTo: string | null;
  since: string;
  href: string;
}

export interface Worklist {
  items: WorkItem[];
  total: number;
  truncated: boolean;
  /* полный перебор видов: вкладка забытого вида не нарисуется, а сумма разойдётся с total */
  byKind: Record<WorkKind, number>;
  mine: number;
  /**
   * Очередь построена по кризисному правилу: сначала тяжесть, потом всё
   * остальное. Флаг отдаётся, чтобы экран мог сказать об этом прямо —
   * изменившийся порядок без объяснения читается как сбой.
   */
}


/**
 * Личный план безопасности (Стэнли–Браун).
 *
 * Порядок разделов не произвольный: он воспроизводит порядок действий в
 * кризисе. Сначала то, что человек может сделать один, потом отвлечение,
 * потом люди, и лишь затем профессиональная помощь — так план работает даже
 * тогда, когда сил на звонок ещё нет. Ограничение доступа к средствам стоит
 * последним пунктом, но обсуждается всегда: это единственная часть плана,
 * которая снижает риск, а не помогает его пережить.
 */
export interface SafetyPlanContent {
  /** Признаки, по которым человек узнаёт приближение кризиса */
  warningSigns: string[];
  /** Что он может сделать сам */
  copingStrategies: string[];
  /** Занятия и места, которые отвлекают */
  distractions: string[];
  /** Люди, к которым можно обратиться: имя и как связаться */
  people: { name: string; contact: string }[];
  /** Специалисты и дежурные службы */
  professionals: { name: string; contact: string }[];
  /** Что сделано, чтобы ограничить доступ к средствам */
  meansRestriction: string;
  /** Ради чего стоит жить — своими словами */
  reasonsToLive: string[];
}

export interface SafetyPlan {
  id: string;
  version: number;
  content: SafetyPlanContent;
  active: boolean;
  createdAt: string;
  reviewedAt: string | null;
  authorName: string;
}

/* ═══════════ Поддержка решений ═══════════ */

export interface RuleHit {
  id: string;
  ruleTitle: string;
  ruleVersion: number;
  userId: string;
  userName: string;
  surveyId: string;
  responseId: string;
  status: "suggested" | "accepted" | "declined";
  explanation: {
    title: string;
    because: { met: boolean; text: string }[];
    actions: import("./rules").RuleAction[];
  };
  createdAt: string;
}

/* ═══════════ Рабочее место ═══════════ */

/**
 * Настройки рабочего места.
 *
 * Живут на сервере, а не в браузере: сотрудник садится за разные машины в
 * отделении, и «моя настройка» не должна означать «настройка этого
 * компьютера». Все поля необязательны — отсутствие значит «как по умолчанию»,
 * а не «выключено».
 */
export interface WorkspacePrefs {
  /** Куда попадать после входа */
  startScreen?: "dashboard" | "worklist" | "alerts" | "patients";
  density?: "cozy" | "compact";
  /*
   * Движение: следовать системе или всегда меньше. Включить его вопреки
   * системной настройке нельзя — см. схему в schemas.ts.
   */
  motion?: "system" | "reduced";
  theme?: "dark" | "light";
  /*
   * Язык в профиле. Схема его принимает давно, но ни консоль, ни мобилка
   * его пока не пишут и не читают: язык живёт на устройстве (localStorage,
   * хранилище мобилки) и уходит в каждый запрос заголовком. Фоновым текстам
   * (пуш) язык берётся с устройства, на которое они уходят, — push_tokens.lang.
   */
  lang?: Lang;
  /**
   * Закрытые подсказки.
   *
   * Список закрытых, а не показанных: подсказка по умолчанию видна, и человек,
   * впервые открывший экран на новой машине, увидит её снова — это и нужно.
   * Хранить «показанные» значило бы, что забытая запись навсегда прячет
   * объяснение.
   */
  dismissedHints?: string[];
  /**
   * Убранные с глаз пункты рельсы — по ключу названия.
   *
   * Хранится список СКРЫТЫХ, а не показанных: новый раздел должен появляться
   * у всех сам. Список показанных означал бы, что человек, настроивший рельсу
   * однажды, больше никогда не увидит ничего нового — и узнает о возможности
   * от коллеги, если узнает вовсе.
   *
   * Скрытый пункт не отнимает доступа: экран открывается по ссылке и из
   * палитры команд, а правило доступа живёт на маршруте. Это настройка того,
   * что стоит перед глазами, а не прав.
   */
  railHidden?: string[];
  /**
   * Когда человек последний раз смотрел сводку «пока меня не было».
   *
   * В профиле, а не в браузере: смена вернулась с другой машины — и сводка
   * должна показать смену, а не «всё с начала времён».
   */
  eventsSeenAt?: string | null;
}

/* ═══════════ Когорты ═══════════ */

/**
 * Правило отбора когорты.
 *
 * Все условия соединяются «и». Пустое правило — вся доступная выборка, и это
 * осмысленное начало работы: человек сужает, а не собирает с нуля.
 */
export interface CohortSpec {
  sex?: "male" | "female" | null;
  /**
   * Возраст на момент прохождения, полных лет, обе границы включительно.
   * Считается от даты рождения, а не по полосе-снимку: полоса «25–34»
   * ответила бы на «від 27 до 29» всеми десятью годами.
   */
  ageMin?: number | null;
  ageMax?: number | null;
  units?: string[];
  /** Населённые пункты — любой из перечисленных, без учёта регистра */
  localities?: string[];
  /** Методика, по которой смотрим баллы и период */
  surveyId?: string | null;
  /** Период проходження, ГГГГ-ММ-ДД, оба конца — календарные дни включительно */
  from?: string | null;
  to?: string | null;
  /** Условия по шкалам выбранной методики */
  scales?: { code: string; op: ">=" | "<=" | ">" | "<"; value: number }[];
  /**
   * Выраженность не ниже: хоть одна шкала хоть одного прохождения выборки
   * лежит в этой полосе или тяжелее. «none» здесь нет — «не ниже нормы»
   * значит «все», и такое условие ничего не сужает.
   */
  minSeverity?: Exclude<Severity, "none"> | null;
  /** Только те, у кого есть повторный замер: без него динамики нет */
  repeatedOnly?: boolean;
  /** Только те, у кого поднималась тревога риска */
  riskOnly?: boolean;
}

/** Ячейка разбивки: ключ — значение из базы, число — null, если скрыто порогом */
export interface CohortCell {
  key: string;
  count: number | null;
}

export interface CohortPreview {
  /** Сколько человек подходит; null — когорта слишком мала, чтобы назвать число */
  size: number | null;
  /** Можно ли показывать разбивки: у малой когорты они указывают на людей */
  breakdownAllowed: boolean;
  smallCellFloor: number;
  bySex: CohortCell[];
  byUnit: CohortCell[];
  /** По населённым пунктам; «—» — пункт не указан */
  byLocality: CohortCell[];
  /** По возрастной полосе последнего прохождения выборки: «<25», «25-34», «35-44», «45+» */
  byAge: CohortCell[];
  /**
   * По самой тяжёлой полосе человека среди прохождений выборки — каждый
   * человек в одной ячейке, доли складываются в целое. «—» — ни одна шкала
   * его прохождений полос не имеет.
   */
  bySeverity: CohortCell[];
}

/**
 * Человек когорты в поимённом списке. Телефона нет намеренно: подбор —
 * про «кто это», а позвонить — из карточки, где чтение телефона и так
 * журналируется своим порядком.
 */
export interface CohortMember {
  userId: string;
  fullName: string;
  email: string;
  unit: string | null;
  locality: string | null;
  sex: "male" | "female" | null;
  birthYear: number | null;
  /** Последнее прохождение выборки и его самая тяжёлая полоса */
  last: { responseId: string; surveyId: string; submittedAt: string | null; severity: Severity | null } | null;
}

export interface CohortMembers {
  items: CohortMember[];
  /** Когорта найдена, но ниже порога: имён не будет — это не «никого нет» */
  suppressed: boolean;
  smallCellFloor: number;
  /** Список обрезан потолком выдачи: людей больше, чем в items */
  truncated: boolean;
}

/**
 * Из чего выбирать в подборе: подразделения и населённые пункты людей в
 * зоне ответственности. Только названия, без чисел.
 */
export interface CohortOptions {
  units: string[];
  localities: string[];
}

export interface CohortRow {
  id: string;
  title: string;
  note: string | null;
  spec: CohortSpec;
  createdAt: string;
}

/* ─────────── Раздел «Статистика»: пресеты фильтров и модели ───────────
 *
 * Не то же, что когорты выше. Когорта — правило отбора, которое умеет
 * отдать людей поимённо; статистика имён не отдаёт никогда: только доли
 * по выборке, и каждая ячейка меньше порога малых чисел подавляется
 * (см. StatCell). Поэтому и типы свои, а не расширение CohortSpec.
 */

/**
 * Строки-критерии выборки с кадра f25. Отсутствующий ключ — отсутствующая
 * строка формы: «—» на макете убирает критерий, а не обнуляет его.
 *
 * Возраст — на момент прохождения, от даты рождения, а не от нынешней даты
 * и не от полосы: полоса «25–34» ответила бы на «від 27 до 29» всеми
 * десятью годами.
 */
export interface SampleFilters {
  /** Период сдачи, ГГГГ-ММ-ДД, оба конца включительно, в поясе учреждения */
  from?: string | null;
  to?: string | null;
  ageMin?: number | null;
  ageMax?: number | null;
  sex?: Sex | null;
  /** Населённый пункт из паспортной части, без учёта регистра */
  locality?: string | null;
  /** Своя группа пациентов; чужая — «не найдено» */
  patientGroupId?: string | null;
  /** Один человек — выборка из одного всегда ниже порога и отдаётся подавленной */
  patientId?: string | null;
}

/** Сохранённый пресет фильтров — «Назва пресету фільтрів» */
export interface FilterPreset {
  id: string;
  title: string;
  criteria: SampleFilters;
  /** Кто собрал. Чужие пресеты в выдаче не появляются вовсе */
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Строка списка пресетов: сколько моделей на него ссылаются. Экран
 * показывает это до нажатия «—», а не узнаёт из отказа после.
 */
export interface FilterPresetListItem extends FilterPreset {
  modelCount: number;
}

/**
 * Показатель «Варіант результату»: полоса шкалы. `highRisk` — пометка
 * «ВШР» (високий ступінь ризику) с кадров f07/f14/f21/f28: попадание в этот
 * показатель аналитик считает признаком риска.
 */
export interface StatModelBandIndicator {
  scaleId: string;
  bandId: string;
  highRisk: boolean;
}

/** Показатель «Текст відповіді» с той же пометкой «ВШР» */
export interface StatModelOptionIndicator {
  optionId: string;
  highRisk: boolean;
}

/** «Текст питання» с перечнем показываемых вариантов ответа */
export interface StatModelQuestionIndicator {
  questionId: string;
  options: StatModelOptionIndicator[];
}

/**
 * Колонка-выборка модели: свои фильтры либо пресет, своя методика и версия,
 * свои показатели. На кадре f28 таких колонок две, «+» добавляет ещё.
 *
 * Версия хранится всегда: идентификаторы полос и вариантов принадлежат ей,
 * и модель без версии после первой правки методики ссылалась бы в пустоту.
 * Во входной схеме версию можно не задавать — тогда берётся действующая
 * на момент сохранения и записывается сюда.
 */
export interface StatModelColumn {
  /** Метка колонки для экрана — «Group 1», «Чоловіки 25–45»; необязательна */
  title: string | null;
  /** Пресет или собственные фильтры — одно из двух */
  presetId: string | null;
  filters: SampleFilters | null;
  surveyId: string;
  versionId: string;
  bands: StatModelBandIndicator[];
  questions: StatModelQuestionIndicator[];
}

export interface StatModel {
  id: string;
  title: string;
  /** «Короткий опис статистичної моделі» из списка на кадре f26 */
  description: string | null;
  ownerId: string;
  columns: StatModelColumn[];
  createdAt: string;
  updatedAt: string;
}

/** Строка перечня моделей (кадр f06): без колонок, они нужны только на экране модели */
export interface StatModelListItem {
  id: string;
  title: string;
  description: string | null;
  ownerId: string;
  columnCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StatModelListPage {
  items: StatModelListItem[];
  total: number;
}

/**
 * Ячейка отчёта. Подавленная приходит как {suppressed: true} — не ноль и не
 * пропуск: ноль читался бы как «никого нет», пропуск — как ошибка экрана,
 * а правда в том, что люди есть, но их слишком мало, чтобы назвать число.
 *
 * Доля считается от показанного основания — числа респондентов колонки —
 * и подавляется вместе с числом: доля рядом со знаменателем восстанавливает
 * скрытое умножением.
 */
export type StatCell =
  | { suppressed: false; count: number; percent: number }
  | { suppressed: true };

export interface StatRunBand {
  scaleId: string;
  scaleCode: string;
  scaleTitle: string;
  bandId: string;
  label: string;
  severity: Severity;
  highRisk: boolean;
  cell: StatCell;
}

export interface StatRunScale {
  scaleId: string;
  scaleCode: string;
  scaleTitle: string;
  bands: StatRunBand[];
  /**
   * Все, кто не попал ни в одну из показанных полос: другие полосы и те,
   * у кого результат не нормирован. Показывается, чтобы полосы и остаток
   * складывались в основание и остаток был честной ячейкой, а не тем, что
   * читатель вычислит сам вычитанием — тогда порог его не защитил бы.
   *
   * Подавляется наравне с полосами: что из группы можно напечатать, решает
   * проверка восстановимости по всему ответу, а не правило про группу.
   */
  rest: StatCell;
}

export interface StatRunOption {
  optionId: string;
  text: string;
  highRisk: boolean;
  cell: StatCell;
}

export interface StatRunQuestion {
  questionId: string;
  title: string;
  type: QuestionType;
  options: StatRunOption[];
  /**
   * Все, кто не выбрал ни одного из показанных вариантов, включая не
   * ответивших. У вопроса с несколькими вариантами это дополнение
   * объединения, и вместе с самими вариантами оно задаёт области диаграммы
   * Венна: именно в них живут горстки, которые ищет проверка.
   */
  rest: StatCell;
}

/**
 * Почему колонка закрыта целиком. «small» — респондентов меньше порога;
 * «recoverable» — проверка восстановимости не нашла безопасного набора
 * чисел: что бы колонка ни напечатала, вместе с числами соседок это
 * называет горстку людей поимённо. Экран в обоих случаях рисует строки с
 * подписью «менше 5»: причина нужна не подписи, а разбору — по ней видно,
 * почему колонка над порогом всё-таки закрыта.
 */
export type StatSuppressReason = "small" | "recoverable";

/** Одна колонка отчёта — «Group 1: Males, age 25-30, 30 users» с кадра f26 */
export interface StatRunColumn {
  title: string | null;
  presetId: string | null;
  presetTitle: string | null;
  filters: SampleFilters;
  surveyId: string;
  surveyTitle: string;
  versionId: string;
  versionNumber: number;
  /**
   * Основание: респонденты выборки, по последнему сданному прохождению
   * каждого. Колонка меньше порога подавляется целиком — и основание, и
   * все ячейки под ним; то же с колонкой, которую закрыла проверка
   * восстановимости.
   */
  respondents: StatCell;
  /** Причина закрытия всей колонки; null — колонка открыта */
  suppressedReason: StatSuppressReason | null;
  /**
   * Готовая фраза о том, чего в колонке нет и почему: колонка закрыта
   * целиком или из неё убраны отдельные показатели, потому что вместе с
   * остальными числами отчёта они восстанавливают конкретных людей.
   * null — показано всё, что колонка умеет показать.
   *
   * Фраза, а не код: сервер и так переводит отказы (errorStrings.ts), и
   * второй словарь на клиенте ради одной строки — лишний договор между
   * двумя приложениями. Экран обязан её показать: молча нарисованные
   * прочерки читаются как «данных нет», а данные есть.
   */
  note: string | null;
  /** Сколько показателей колонки скрыто; 0 — показаны все */
  hiddenFigures: number;
  scales: StatRunScale[];
  questions: StatRunQuestion[];
  /**
   * Респонденты хотя бы с одним попаданием в показатель «ВШР»; null — в
   * колонке ничего не помечено. Своих правил у него нет: это такое же
   * число системы, как ячейки, и прячется оно тогда, когда вместе с
   * остальными числами ответа называет людей. Так, «ВШР: 13» поверх
   * показанных «Високий: 6» и «Шум: 8» из двадцати называет того
   * единственного, кто попал в оба показателя.
   */
  highRisk: StatCell | null;
}

export interface StatRunResult {
  /** null — превью без сохранения */
  modelId: string | null;
  title: string;
  ranAt: string;
  smallCellFloor: number;
  columns: StatRunColumn[];
}

/* ── Поликлиника: расписание и приёмы ── */

export type SlotKind = "primary" | "repeat" | "any";
export type AppointmentKind = "primary" | "repeat";
export type AppointmentMode = "onsite" | "remote";
export type AppointmentStatus =
  | "booked"
  | "confirmed"
  | "arrived"
  | "in_progress"
  | "done"
  | "no_show"
  | "cancelled";

/** Свободное время у специалиста — то, что видит записывающийся */
export interface FreeSlot {
  id: string;
  specialistId: string;
  specialistName: string;
  /** Кабинет: человеку надо знать, куда идти, ещё до приёма */
  room: string | null;
  startsAt: string;
  endsAt: string;
}

/** Приём в списке — и у пациента, и в «Сегодня» у специалиста */
export interface AppointmentView {
  id: string;
  slotId: string;
  startsAt: string;
  endsAt: string;
  kind: AppointmentKind;
  mode: AppointmentMode;
  meetingUrl: string | null;
  status: AppointmentStatus;
  specialistId: string;
  specialistName: string;
  room: string | null;
  patientId: string;
  /** Имя или код: анонимный аккаунт виден специалисту как «Респондент А-4821» */
  patientName: string;
  /** Причина обращения словами пациента; null — не указал, и это его право */
  reason: string | null;
  bookedAt: string;
  confirmedAt: string | null;
  /** Слот выпал из расписания после правки шаблона — приём цел, но требует решения */
  offSchedule: boolean;
  /**
   * Сколько назначенного человек не сдал к этому приёму.
   *
   * Предупреждаются оба: пациенту — напоминание, специалисту — пометка.
   * Без неё специалист узнаёт о несданной методике в момент, когда собирался
   * её обсуждать, — то есть когда время приёма уже идёт.
   */
  pendingAssignments: number;
  /**
   * Скрининг при записи: сдан или нет; null — отделение его не даёт.
   *
   * Ради этого первичный приём и перестаёт наполовину уходить на заполнение
   * бланков. Специалисту важно знать до приёма, начинать ли с разговора или
   * с анкеты.
   */
  screeningDone: boolean | null;
  /**
   * Кто ведёт этого человека; null — никто.
   *
   * Нужен в списке дня: записаться можно к любому свободному специалисту, и
   * плата за эту доступность — размывание преемственности. Гасит её не
   * запрет, а пометка: незакреплённых видно, а не приходится искать.
   */
  leadSpecialistId: string | null;
}

/** Обычная неделя специалиста */
export interface ScheduleTemplateView {
  id: string;
  weekday: number;
  startsAt: string;
  endsAt: string;
  slotMinutes: number;
}

/** Исключение из обычной недели */
export interface ScheduleExceptionView {
  id: string;
  date: string;
  kind: "off" | "extra";
  startsAt: string | null;
  endsAt: string | null;
  slotMinutes: number | null;
  note: string | null;
}

/* ══════════════════════════════════════════════════════════════════════════
 * События реального времени
 *
 * Договор живёт здесь, а не по копии на каждой стороне.
 *
 * Копий было две, и они уже разошлись: сервер завёл вид «action» и слал его
 * на КАЖДОЕ журналируемое изменение, а клиент о нём не знал — и показывал
 * человеку голое слово «action» в центре событий. Собственный докблок
 * сервера объяснял, зачем этот вид заведён; на клиент объяснение не доехало,
 * потому что доезжать было нечему.
 * ══════════════════════════════════════════════════════════════════════ */

export type AppEventKind =
  | "alert.created"
  | "case.changed"
  | "response.submitted"
  | "schedule.run"
  | "presence.changed"
  /**
   * Любое изменяющее действие, попавшее в журнал.
   *
   * Заводится не вместо перечисленных выше, а под ними: те несут смысл
   * («пришла тревога», «сдано прохождение») и подписчик знает, что с ними
   * делать. Это — общий поток, чтобы не заводить kind под каждое новое
   * действие и не обнаруживать через полгода, что половина системы событий
   * не выпускает вовсе.
   */
  | "action";

export interface AppEvent {
  kind: AppEventKind;
  /**
   * Методики, к которым относится событие: событие видит тот, кому доступна
   * хотя бы одна из них. Список, а не одна методика, потому что события
   * киоска относятся к батарее целиком. `null` — системное событие,
   * видимое всем сотрудникам.
   */
  surveyIds: string[] | null;
  /** Кого касается; null у анонимных прохождений */
  userId: string | null;
  at: string;
  severity?: "moderate" | "severe";
  /** Сеанс киоска — чтобы открытый экран сеанса обновлял только себя */
  sessionId?: string;
  /** Экран, на котором находится сотрудник: `patient:<id>` и подобные */
  resource?: string;

  /* ── поля общего потока «action» ── */

  /** Действие журнала: `clinic.cancel`, `episode.open` и так далее */
  action?: string;
  resourceType?: string | null;
  resourceId?: string | null;
  /** Кто сделал; null у фоновых проходов */
  actorId?: string | null;
}
