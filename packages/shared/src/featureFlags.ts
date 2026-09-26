import { z } from "zod";

/**
 * Флаги функций: новый экран или новое поведение включается отдельным людям
 * и группам без выкатки.
 *
 * Решение заказчика 2026-09-26 (техпанель, пункт 11): «включать новые
 * экраны для отдельных людей или групп без выкатки».
 *
 * ═══ Почему реестр в коде, а не только таблица ═══
 *
 * Состояние флага (кому включён) живёт в базе — его меняют из техпанели на
 * ходу. А сам перечень ключей живёт здесь, и это главное решение файла. Код
 * спрашивает `useFlag("maint.bannerCountdown")`, и опечатку в ключе ловит
 * компилятор: `FeatureFlagKey` выводится из этого объекта. Строка-ключ,
 * набранная в экране руками, при опечатке молча отвечала бы «выключено» —
 * навсегда и без единого признака, что флага с таким именем нет.
 *
 * Отсюда же и порядок жизни флага: завели ключ здесь → выкатили код,
 * который его спрашивает (по умолчанию выключен для всех) → включили в
 * техпанели нужным людям → включили всем → убрали проверку из кода и ключ
 * отсюда. Строка в таблице, пережившая ключ, в техпанели видна как
 * «застарілий» и никому ничего не включает: сервер отдаёт только ключи
 * реестра.
 *
 * ═══ Флаг — не право ═══
 *
 * Флаг решает, ПОКАЗАТЬ ли человеку новое, а не МОЖНО ли ему это. Закрытое
 * правом остаётся закрытым на сервере, как бы ни стоял флаг. Поэтому флаг
 * не должен открывать ничего, чего нельзя было бы открыть и без него, — и
 * выключение флага обязано оставлять рабочим прежний путь.
 */
export interface FeatureFlagEntry {
  title: { uk: string; ru: string; en: string };
  description: { uk: string; ru: string; en: string };
}

export const FEATURE_FLAGS = {
  /*
   * Настоящий флаг, а не пример в комментарии: без живого ключа механизм
   * оставался бы пустым, и проверить его руками было бы не на чем.
   *
   * Безопасный по построению: выключенный — баннер показывает время
   * окончания работ («до 21:30»), как и без флагов; включённый добавляет к
   * нему отсчёт («≈ 25 хв»). Ничего не открывает и ничего не прячет, а
   * виден каждому, кто видит баннер, — и сотруднику, и пациенту. Удобен
   * ровно для проверки механизма: включили одному человеку — у него отсчёт
   * есть, у соседа нет.
   */
  "maint.bannerCountdown": {
    title: {
      uk: "Відлік у банері обслуговування",
      ru: "Обратный отсчёт в баннере обслуживания",
      en: "Countdown in the maintenance banner",
    },
    description: {
      uk: "Поруч із часом завершення робіт банер показує, скільки ще лишилося: «≈ 25 хв».",
      ru: "Рядом со временем окончания работ баннер показывает, сколько ещё осталось: «≈ 25 мин».",
      en: "Next to the expected end time the banner shows how much is left: “≈ 25 min”.",
    },
  },
} as const satisfies Record<string, FeatureFlagEntry>;

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[];

export function isFeatureFlagKey(key: string): key is FeatureFlagKey {
  // своё свойство, а не `in`: «toString» не флаг, хотя у объекта он есть
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, key);
}

/** Классы учётных записей — те же три, что в users.role */
export const FLAG_BASE_ROLES = ["superadmin", "admin", "user"] as const;

/**
 * Кому включён флаг.
 *
 * Разрезы выбраны по тому, как в системе на самом деле собраны люди, и не
 * все группы годятся.
 *
 * - `roles` — класс учётной записи. `user` — это все пациенты разом: другого
 *   способа адресовать пациентов здесь нет, и это решение, а не пропуск
 *   (см. ниже про группы пациентов).
 * - `staffRoles` — роли лестницы должностей (psychologist, head, chief…),
 *   по коду роли: «новый экран сначала заведующим».
 * - `users` — перечень людей поимённо: «сначала мне и Олене».
 * - `surveyGroups` — группы методик. Это единица разграничения доступа, и
 *   сотрудники в них собраны по работе (group_admins): «всем, кто ведёт
 *   группу МЛО».
 * - `departments` — відділення из профиля приёма (specialist_profiles):
 *   «пилот в одном отделении».
 *
 * Группы ПАЦИЕНТОВ сюда не взяты сознательно. Это личные рабочие списки
 * специалиста (политика строк показывает группу только её владельцу), и
 * названия у них клинические — «ПТСР після поранення». Показать их
 * техпанели значило бы открыть человеку с ops.read то, что закрыто даже от
 * коллег, а сотрудников в них нет вовсе.
 *
 * Флаг включён человеку, если `all` или он попадает хотя бы в один разрез.
 * Пустая аудитория без `all` — никому.
 */
export const featureFlagAudienceSchema = z.object({
  all: z.boolean().default(false),
  roles: z.array(z.enum(FLAG_BASE_ROLES)).max(FLAG_BASE_ROLES.length).default([]),
  staffRoles: z.array(z.string().min(1).max(80)).max(50).default([]),
  users: z.array(z.string().min(1).max(64)).max(200).default([]),
  surveyGroups: z.array(z.string().min(1).max(64)).max(200).default([]),
  departments: z.array(z.string().min(1).max(64)).max(200).default([]),
});

export type FeatureFlagAudience = z.output<typeof featureFlagAudienceSchema>;

/** Правка флага из техпанели: главный выключатель и аудитория целиком */
export const featureFlagUpdateSchema = z.object({
  /*
   * Выключатель отдельно от аудитории. Выключить флаг, не потеряв
   * настроенный перечень людей, — самое частое действие («что-то пошло не
   * так, гасим»), и собирать перечень заново после такого было бы платой за
   * осторожность.
   */
  enabled: z.boolean(),
  audience: featureFlagAudienceSchema,
});

export type FeatureFlagUpdate = z.output<typeof featureFlagUpdateSchema>;

export function emptyAudience(): FeatureFlagAudience {
  return { all: false, roles: [], staffRoles: [], users: [], surveyGroups: [], departments: [] };
}

/** Кто спрашивает — всё, что нужно для решения по флагу */
export interface FlagSubject {
  id: string;
  role: (typeof FLAG_BASE_ROLES)[number];
  staffRoles: readonly string[];
  surveyGroups: readonly string[];
  departments: readonly string[];
}

/**
 * Включён ли флаг этому человеку.
 *
 * Одна функция на сервер и тесты: правило «кому» записано один раз. Нет
 * строки в таблице — выключен: новый ключ, выкаченный кодом, никому ничего
 * не включает, пока его не включат руками.
 */
export function flagEnabledFor(
  state: { enabled: boolean; audience: FeatureFlagAudience } | null | undefined,
  who: FlagSubject,
): boolean {
  if (!state?.enabled) return false;
  const a = state.audience;
  if (a.all) return true;
  const meets = (list: readonly string[], mine: readonly string[]) => mine.some((x) => list.includes(x));
  return (
    a.roles.includes(who.role) ||
    a.users.includes(who.id) ||
    meets(a.staffRoles, who.staffRoles) ||
    meets(a.surveyGroups, who.surveyGroups) ||
    meets(a.departments, who.departments)
  );
}

/** Аудитория, в которой никого нет: такой включённый флаг не включает ничего */
export function audienceIsEmpty(a: FeatureFlagAudience): boolean {
  return (
    !a.all &&
    !a.roles.length &&
    !a.staffRoles.length &&
    !a.users.length &&
    !a.surveyGroups.length &&
    !a.departments.length
  );
}
