/**
 * Вымышленные люди для наполнения экземпляра.
 *
 * Нужны, чтобы система не выглядела пустой: аналитика без прохождений — это
 * сетка без точек, очередь разбора без случаев — пустой экран, а динамика по
 * одному замеру не рисуется вовсе. Показать всё это можно только на данных.
 *
 * Два правила, без которых затея вредна.
 *
 * **Вымышленный человек обязан быть отличим от настоящего.** Все заводятся с
 * почтой на домене `demo.local` — такого домена не существует и завести его
 * нельзя, — и убираются одной командой. Смешать демонстрацию с живой
 * картотекой в психиатрическом учреждении означало бы, что кто-то однажды
 * позвонит по несуществующему случаю или, наоборот, примет настоящую тревогу
 * за посев.
 *
 * **Картотека — это отделение, а не выборка.** Прежняя редакция раздавала
 * имена из пятнадцати пар случайно (три «Мельник Марія Степанівна» на сто
 * двадцать человек), подразделения — из списка отделений госпиталя
 * («Лабораторія», «Адміністрація»), а состояние — случайным блужданием
 * баллов. Врач, открывший такую карточку, видел не человека, а шум. Теперь
 * у каждого — неповторимое имя, воинская часть без настоящих номеров
 * (механизированный батальон, артиллерийский дивизион, ветеран), звание и
 * должность по возрасту и клиническая история одного из портретов отделения
 * (lib/demoStories.ts): с какой бедой пришёл, чем меряли, как шло лечение.
 */

/** Портрет клинической истории — см. lib/demoStories.ts */
export type ArchetypeKey =
  | "ptsd"
  | "ptsdSlow"
  | "depression"
  | "adjustment"
  | "alcohol"
  | "insomnia"
  | "moralInjury"
  | "grief"
  | "burnout"
  | "crisis"
  | "stable"
  | "screening"
  | "psychosis"
  | "anxiety";

/**
 * Сколько людей каждого портрета на сто двадцать — столько, сколько их
 * бывает в психологическом отделении военного госпиталя.
 *
 * Больше всего посттравматических, депрессивных, адаптационных и только что
 * направленных; кризисов и психотических — единицы. Доли зафиксированы, а не
 * разыгрываются: таблица портретов идёт в описание выкатки, и «примерно
 * шестнадцать» там не годится. Сто двадцать — число, которое запускают на
 * проде; на большем числе список повторяется по кругу (см. archetypeAt).
 */
export const ARCHETYPE_COUNTS: Record<ArchetypeKey, number> = {
  ptsd: 16,
  ptsdSlow: 5,
  depression: 12,
  adjustment: 14,
  alcohol: 8,
  insomnia: 9,
  moralInjury: 4,
  grief: 4,
  burnout: 6,
  crisis: 4,
  stable: 14,
  screening: 16,
  psychosis: 2,
  anxiety: 6,
};

const ROUND = Object.values(ARCHETYPE_COUNTS).reduce((s, n) => s + n, 0);

export interface Person {
  /** Номер с единицы: по нему всё остальное и выводится */
  ordinal: number;
  slug: string;
  lastName: string;
  firstName: string;
  middleName: string;
  sex: "male" | "female";
  /** YYYY-MM-DD */
  birthDate: string;
  unit: string;
  rank: string | null;
  position: string | null;
  specialty: string | null;
  archetype: ArchetypeKey;
  /** Который по счёту человек своего портрета, с нуля — по нему выбирается вариант истории */
  variant: number;
}

/**
 * Детерминированный источник случайности.
 *
 * Посев с настоящим Math.random даёт разную картотеку на каждом прогоне, и
 * повторный запуск на том же экземпляре завёл бы вторых Шевчуків с другими
 * ответами. От номера человека — значит один и тот же человек всегда один и
 * тот же.
 */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Элемент списка по случайности: одинаковые зёрна — одинаковый выбор */
export function pick<T>(r: () => number, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)]!;
}

/** Целое из [from, to] включительно */
export function between(r: () => number, from: number, to: number): number {
  return from + Math.floor(r() * (to - from + 1));
}

/** Перемешивание Фишера — Йетса с заданным зерном; исходный список не трогается */
function shuffled<T>(list: readonly T[], seed: number): T[] {
  const out = [...list];
  const r = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/* ═════════════ имена ═════════════ */

/*
 * Фамилии — без тех, что уже есть у людей посева и у демонстрационного
 * персонала (Гончаренко, Савченко, Ковальчук, Мельник, Бондаренко,
 * Шевченко, Гриценко, Ткаченко, Лисенко, Романюк, Демченко): однофамилец
 * врача среди пациентов — первое, что путает на экране дня.
 */
const SURNAMES = [
  "Кравчук", "Олійник", "Шевчук", "Поліщук", "Бойко", "Ткачук", "Марченко", "Руденко", "Мороз", "Савчук",
  "Пономаренко", "Клименко", "Кравець", "Литвиненко", "Павленко", "Кузьменко", "Левченко", "Карпенко",
  "Сидоренко", "Гуменюк", "Лук'яненко", "Нестеренко", "Мазур", "Петрук", "Тимошенко", "Приходько",
  "Остапчук", "Дмитренко", "Харченко", "Яковенко", "Захарченко", "Вдовиченко", "Стасюк", "Гнатюк",
  "Онищенко", "Іщенко", "Головко", "Мартинюк", "Демчук", "Костенко", "Тарасенко", "Бабенко", "Науменко",
  "Юрченко", "Кириленко", "Гордієнко", "Мирошниченко", "Фесенко", "Кучер", "Семенюк", "Зінченко", "Бондар",
  "Коваль", "Гуцуляк", "Федорчук", "Антонюк", "Білик", "Гаврилюк", "Дячук", "Жук", "Зайченко", "Ігнатенко",
  "Колесник", "Кушнір", "Мацюк", "Михайленко", "Носенко", "Остапенко", "Панченко", "Прокопенко", "Рибак",
  "Свириденко", "Сорока", "Тищенко", "Устименко", "Фединяк", "Хоменко", "Цимбалюк", "Чорновол", "Шаповал",
  "Щербак", "Ярошенко", "Андрієнко", "Байда", "Василенко", "Гайдай", "Довгань", "Єременко", "Зубко",
  "Іваненко", "Кармелюк", "Ляшенко", "Мельничук", "Нагорняк", "Олексієнко", "Пилипенко", "Рудик",
  "Трохименко", "Фоменко", "Химич", "Цибуля", "Чабан", "Шульга", "Яремчук", "Бабич", "Вакуленко",
  "Гребенюк", "Дорошенко", "Єфименко", "Заїка", "Ільченко", "Кобзар", "Лемешко", "Максименко", "Овчаренко",
  "Панасюк", "Семко", "Тесленко", "Федоренко", "Харитонюк", "Чубенко", "Шостак", "Юрчишин", "Яценко",
  "Вовк", "Гнатенко", "Дідух", "Єрмоленко", "Корнієнко", "Лагода", "Мисник", "Нечипоренко", "Пастух",
  "Романенко", "Самійленко", "Тимчук", "Усенко", "Філоненко", "Хмара", "Чумак", "Шинкаренко", "Юхименко",
  "Якименко", "Бурлака", "Дубина", "Ємець", "Журба", "Ісаєнко", "Калина", "Лобода", "Мовчан", "Нікітюк",
  "Петренко", "Решетняк", "Сірко", "Терещенко", "Гуменний", "Дяченко", "Кравченко", "Литвин", "Марчук",
  "Осадчук", "Пилипчук", "Ничипорук", "Сенченко", "Тарасюк", "Ковтун", "Луценко", "Мартиненко", "Назаренко",
  "Опанасенко", "Палій", "Рябошапка", "Саєнко", "Тимощук", "Ходаківський", "Цимбал", "Шевченюк", "Яковчук",
  "Бондарчук", "Власенко", "Гаркуша", "Дацюк", "Жураковський", "Зозуля", "Кіт", "Ліщук", "Мельниченко",
  "Нестерук", "Олешко", "Паламарчук", "Ружин", "Скиба", "Тітаренко", "Федюк", "Чепурко", "Шкурко",
] as const;

/** Прилагательные фамилии меняются по роду; остальные у женщин те же */
const ADJECTIVAL: Record<string, string> = {
  Лозинський: "Лозинська",
  Вербицький: "Вербицька",
  Зелінський: "Зелінська",
  Яворський: "Яворська",
  Вишневський: "Вишневська",
  Савицький: "Савицька",
  Білецький: "Білецька",
  Гладкий: "Гладка",
  Заболотний: "Заболотна",
  Бережний: "Бережна",
  Наконечний: "Наконечна",
  Осадчий: "Осадча",
  Ковальський: "Ковальська",
  Ружицький: "Ружицька",
  Островський: "Островська",
  Терлецький: "Терлецька",
  Чорний: "Чорна",
  Ходаківський: "Ходаківська",
  Жураковський: "Жураковська",
};

const ALL_SURNAMES = [...SURNAMES, ...Object.keys(ADJECTIVAL).filter((s) => !(SURNAMES as readonly string[]).includes(s))];

const MALE_NAMES = [
  "Олександр", "Андрій", "Сергій", "Дмитро", "Віталій", "Максим", "Олег", "Іван", "Володимир", "Микола",
  "Юрій", "Богдан", "Тарас", "Роман", "Віктор", "Василь", "Ігор", "Артем", "Денис", "Євген", "Ярослав",
  "Назар", "Павло", "Михайло", "Олексій", "Костянтин", "Владислав", "Руслан", "Станіслав", "Вадим", "Антон",
  "Петро", "Степан", "Анатолій", "Валерій", "Ростислав", "Святослав", "Остап", "Данило", "Кирило",
  "Едуард", "Валентин", "Арсен", "Григорій", "Леонід",
] as const;

const FEMALE_NAMES = [
  "Олена", "Наталія", "Ірина", "Тетяна", "Оксана", "Юлія", "Світлана", "Катерина", "Анна", "Марія",
  "Людмила", "Вікторія", "Ольга", "Галина", "Христина", "Анастасія", "Діана", "Ганна", "Лілія", "Валентина",
  "Надія", "Софія", "Дарина", "Яна", "Інна", "Лариса", "Марина", "Віра", "Леся", "Зоряна", "Мирослава",
  "Уляна", "Олеся", "Аліна", "Євгенія", "Роксолана",
] as const;

/** Имя отца → отчество сына и дочери */
const PATRONYMICS: [string, string][] = [
  ["Олександрович", "Олександрівна"],
  ["Андрійович", "Андріївна"],
  ["Сергійович", "Сергіївна"],
  ["Дмитрович", "Дмитрівна"],
  ["Віталійович", "Віталіївна"],
  ["Олегович", "Олегівна"],
  ["Іванович", "Іванівна"],
  ["Володимирович", "Володимирівна"],
  ["Миколайович", "Миколаївна"],
  ["Юрійович", "Юріївна"],
  ["Богданович", "Богданівна"],
  ["Романович", "Романівна"],
  ["Вікторович", "Вікторівна"],
  ["Васильович", "Василівна"],
  ["Ігорович", "Ігорівна"],
  ["Петрович", "Петрівна"],
  ["Степанович", "Степанівна"],
  ["Анатолійович", "Анатоліївна"],
  ["Валерійович", "Валеріївна"],
  ["Леонідович", "Леонідівна"],
  ["Григорович", "Григорівна"],
  ["Михайлович", "Михайлівна"],
  ["Павлович", "Павлівна"],
  ["Ярославович", "Ярославівна"],
  ["Тарасович", "Тарасівна"],
  ["Олексійович", "Олексіївна"],
  ["Євгенович", "Євгенівна"],
  ["Костянтинович", "Костянтинівна"],
  ["Станіславович", "Станіславівна"],
  ["Федорович", "Федорівна"],
  ["Борисович", "Борисівна"],
];

/* ═════════════ служба ═════════════ */

/** Должность: звание по ступени, специальность — род войск */
interface Post {
  title: string;
  step: "soldier" | "nco" | "officer";
  /** Может ли быть женщиной — в штатах отделения так и распределено */
  women?: boolean;
  /**
   * Офицерская должность: возрастной коридор и звания по возрасту. Майор на
   * взводе и лейтенант на службе бригады бросаются в глаза так же, как
   * лейтенант в пятьдесят.
   */
  officer?: { ages: [number, number]; ranks: [number, string][] };
}

/* звания офицеров по возрасту: [с какого возраста, звание] по возрастанию */
const PLATOON: Post["officer"] = { ages: [22, 33], ranks: [[0, "Лейтенант"], [25, "Старший лейтенант"], [30, "Капітан"]] };
const STAFF_OFFICER: Post["officer"] = { ages: [26, 45], ranks: [[0, "Старший лейтенант"], [30, "Капітан"], [38, "Майор"]] };
const CHIEF_OFFICER: Post["officer"] = { ages: [30, 50], ranks: [[0, "Капітан"], [36, "Майор"], [44, "Підполковник"]] };
const DOCTOR: Post["officer"] = { ages: [25, 45], ranks: [[0, "Лейтенант"], [28, "Старший лейтенант"], [32, "Капітан"], [40, "Майор"]] };

interface Unit {
  title: string;
  /** Вес в картотеке: механизированных больше всего */
  weight: number;
  specialty: string;
  posts: Post[];
  /** Доля женщин в подразделении: медрота и связь — больше, штурм — почти никого */
  women: number;
}

/*
 * Подразделения — без номеров частей: номер настоящей бригады на витрине
 * означал бы, что вымышленный пациент «служит» в существующей части, и
 * снимок экрана с ним уже нельзя показать никому.
 */
const UNITS: Unit[] = [
  {
    title: "Механізований батальйон",
    weight: 22,
    specialty: "Піхота",
    women: 0.05,
    posts: [
      { title: "Стрілець", step: "soldier", women: true },
      { title: "Старший стрілець", step: "soldier" },
      { title: "Кулеметник", step: "soldier" },
      { title: "Гранатометник", step: "soldier" },
      { title: "Механік-водій БМП", step: "soldier" },
      { title: "Навідник-оператор", step: "soldier" },
      { title: "Командир відділення", step: "nco" },
      { title: "Командир взводу", step: "officer", officer: PLATOON },
    ],
  },
  {
    title: "Штурмовий батальйон",
    weight: 10,
    specialty: "Піхота",
    women: 0.02,
    posts: [
      { title: "Стрілець", step: "soldier" },
      { title: "Кулеметник", step: "soldier" },
      { title: "Снайпер", step: "soldier" },
      { title: "Командир відділення", step: "nco" },
      { title: "Командир штурмового взводу", step: "officer", officer: PLATOON },
    ],
  },
  {
    title: "Танковий батальйон",
    weight: 5,
    specialty: "Бронетехніка",
    women: 0,
    posts: [
      { title: "Механік-водій танка", step: "soldier" },
      { title: "Навідник танка", step: "soldier" },
      { title: "Командир танка", step: "nco" },
    ],
  },
  {
    title: "Артилерійський дивізіон",
    weight: 10,
    specialty: "Артилерія",
    women: 0.04,
    posts: [
      { title: "Номер обслуги", step: "soldier" },
      { title: "Навідник гармати", step: "soldier" },
      { title: "Водій тягача", step: "soldier" },
      { title: "Командир гармати", step: "nco" },
      { title: "Старший офіцер батареї", step: "officer", officer: PLATOON },
    ],
  },
  {
    title: "Розвідувальна рота",
    weight: 5,
    specialty: "Розвідка",
    women: 0.03,
    posts: [
      { title: "Розвідник", step: "soldier" },
      { title: "Розвідник-снайпер", step: "soldier" },
      { title: "Командир розвідувального відділення", step: "nco" },
    ],
  },
  {
    title: "Рота ударних БпЛА",
    weight: 7,
    specialty: "Безпілотні системи",
    women: 0.12,
    posts: [
      { title: "Оператор ударних БпЛА", step: "soldier", women: true },
      { title: "Технік БпЛА", step: "soldier", women: true },
      { title: "Командир екіпажу БпЛА", step: "nco" },
    ],
  },
  {
    title: "Інженерно-саперна рота",
    weight: 5,
    specialty: "Інженерні війська",
    women: 0.02,
    posts: [
      { title: "Сапер", step: "soldier" },
      { title: "Водій інженерної машини", step: "soldier" },
      { title: "Командир саперного відділення", step: "nco" },
    ],
  },
  {
    title: "Медична рота",
    weight: 6,
    specialty: "Медична служба",
    women: 0.45,
    posts: [
      { title: "Бойовий медик", step: "soldier", women: true },
      { title: "Санітарний інструктор", step: "nco", women: true },
      { title: "Водій-санітар", step: "soldier" },
      { title: "Фельдшер", step: "nco", women: true },
      { title: "Лікар медичної роти", step: "officer", women: true, officer: DOCTOR },
    ],
  },
  {
    title: "Вузол зв'язку",
    weight: 5,
    specialty: "Зв'язок",
    women: 0.35,
    posts: [
      { title: "Радіотелефоніст", step: "soldier", women: true },
      { title: "Оператор зв'язку", step: "soldier", women: true },
      { title: "Начальник радіостанції", step: "nco", women: true },
    ],
  },
  {
    title: "Підрозділ забезпечення",
    weight: 8,
    specialty: "Логістика",
    women: 0.2,
    posts: [
      { title: "Водій", step: "soldier" },
      { title: "Кухар", step: "soldier", women: true },
      { title: "Комірник", step: "soldier", women: true },
      { title: "Ремонтник", step: "soldier" },
      { title: "Командир відділення забезпечення", step: "nco" },
    ],
  },
  {
    title: "Зенітний ракетний дивізіон",
    weight: 4,
    specialty: "Протиповітряна оборона",
    women: 0.06,
    posts: [
      { title: "Оператор ЗРК", step: "soldier", women: true },
      { title: "Номер розрахунку ПЗРК", step: "soldier" },
      { title: "Командир розрахунку", step: "nco" },
    ],
  },
  {
    title: "Комендантська рота",
    weight: 3,
    specialty: "Охорона",
    women: 0.08,
    posts: [
      { title: "Стрілець-вартовий", step: "soldier" },
      { title: "Командир відділення охорони", step: "nco" },
    ],
  },
  {
    title: "Штаб бригади",
    weight: 4,
    specialty: "Штабна служба",
    women: 0.35,
    posts: [
      { title: "Оператор штабу", step: "soldier", women: true },
      { title: "Діловод", step: "soldier", women: true },
      { title: "Офіцер оперативного відділення", step: "officer", women: true, officer: STAFF_OFFICER },
      { title: "Начальник служби", step: "officer", officer: CHIEF_OFFICER },
    ],
  },
  {
    title: "Батальйон територіальної оборони",
    weight: 6,
    specialty: "Піхота",
    women: 0.06,
    posts: [
      { title: "Стрілець", step: "soldier" },
      { title: "Кулеметник", step: "soldier" },
      { title: "Командир відділення", step: "nco" },
    ],
  },
];

/** Подразделение ветеранов — не часть, а статус: так его и пишет регистратура */
export const VETERAN_UNIT = "Ветеран";
/** Сотрудники госпиталя, направленные из-за выгорания */
export const STAFF_UNIT = "Персонал госпіталю";

const STAFF_POSTS: { title: string; specialty: string; women: number; officer?: boolean }[] = [
  { title: "Медична сестра хірургічного відділення", specialty: "Медсестринство", women: 0.95 },
  { title: "Операційна медична сестра", specialty: "Медсестринство", women: 0.95 },
  { title: "Медична сестра відділення реанімації", specialty: "Медсестринство", women: 0.9 },
  { title: "Лікар-анестезіолог", specialty: "Анестезіологія", women: 0.4, officer: true },
  { title: "Лікар-хірург", specialty: "Хірургія", women: 0.2, officer: true },
  { title: "Фельдшер приймального відділення", specialty: "Невідкладна допомога", women: 0.5 },
];

const RANKS = {
  soldier: ["Солдат", "Солдат", "Старший солдат", "Старший солдат", "Старший солдат", "Молодший сержант"],
  nco: ["Молодший сержант", "Сержант", "Сержант", "Старший сержант", "Старший сержант", "Головний сержант"],
} as const;

/** Офицерское звание по возрасту: лейтенант в 45 и майор в 24 бросаются в глаза */
function officerRank(age: number): string {
  if (age < 25) return "Лейтенант";
  if (age < 30) return "Старший лейтенант";
  if (age < 38) return "Капітан";
  if (age < 46) return "Майор";
  return "Підполковник";
}

/** Ступень → возрастной коридор */
const AGES = { soldier: [20, 52], nco: [24, 50], officer: [23, 48] } as const;

/* ═════════════ портреты по порядку ═════════════ */

/**
 * Портрет человека по номеру — один и тот же при любом числе людей.
 *
 * Сто двадцать мест портретов перемешаны раз и навсегда; номер 121 и дальше
 * идут по тому же списку, перемешанному заново. Так первые сто двадцать
 * всегда одни и те же — «demo-fill 60», а потом «demo-fill 120» дают ровно
 * ту же картотеку, что «demo-fill 120» сразу, — а доли портретов держатся на
 * любом числе.
 */
function archetypeOrder(round: number): ArchetypeKey[] {
  const slots = (Object.entries(ARCHETYPE_COUNTS) as [ArchetypeKey, number][]).flatMap(([key, n]) =>
    Array.from({ length: n }, () => key),
  );
  return shuffled(slots, 20_261_028 + round * 7_919);
}

/** Портрет и номер внутри портрета для человека с порядковым индексом i (с нуля) */
export function archetypeAt(i: number): { archetype: ArchetypeKey; variant: number } {
  const round = Math.floor(i / ROUND);
  const order = archetypeOrder(round);
  const archetype = order[i % ROUND]!;
  const before = order.slice(0, i % ROUND).filter((a) => a === archetype).length;
  return { archetype, variant: round * ARCHETYPE_COUNTS[archetype] + before };
}

/** Кто этот человек по службе: часть, звание, должность — по портрету */
function service(
  archetype: ArchetypeKey,
  variant: number,
  r: () => number,
): { unit: string; post: string | null; specialty: string | null; step: Post["step"] | "veteran" | "staff"; women: number; officer?: boolean } {
  if (archetype === "burnout") {
    const post = STAFF_POSTS[variant % STAFF_POSTS.length]!;
    return { unit: STAFF_UNIT, post: post.title, specialty: post.specialty, step: "staff", women: post.women, officer: post.officer };
  }
  /*
   * Ветераны — те, кого ведут после службы: стабильные после лечения чаще
   * всего, часть горюющих и с моральной травмой. Доля подобрана так, чтобы
   * в списке их было видно, но картотека оставалась госпитальной.
   */
  const veteranShare: Partial<Record<ArchetypeKey, number>> = {
    stable: 0.5,
    grief: 0.5,
    moralInjury: 0.5,
    ptsdSlow: 0.4,
    alcohol: 0.25,
    insomnia: 0.2,
    ptsd: 0.15,
    depression: 0.2,
    anxiety: 0.2,
  };
  if (r() < (veteranShare[archetype] ?? 0)) {
    const former = weightedUnit(r);
    return { unit: VETERAN_UNIT, post: null, specialty: former.specialty, step: "veteran", women: former.women + 0.05 };
  }
  const unit = weightedUnit(r);
  return { unit: unit.title, post: null, specialty: unit.specialty, step: "soldier", women: unit.women };
}

const UNIT_WEIGHT = UNITS.reduce((s, u) => s + u.weight, 0);

function weightedUnit(r: () => number): Unit {
  let left = r() * UNIT_WEIGHT;
  for (const u of UNITS) {
    left -= u.weight;
    if (left <= 0) return u;
  }
  return UNITS[0]!;
}

/** День рождения: год от возраста, день и месяц — настоящие (без 30 февраля) */
function birthDate(r: () => number, age: number, today: Date): string {
  const year = today.getUTCFullYear() - age - (r() < 0.5 ? 1 : 0);
  const month = between(r, 1, 12);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = between(r, 1, days);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Картотека из n человек — одна и та же при одном и том же n, и первые k
 * людей одинаковы при любом n ≥ k.
 *
 * Имя неповторимо по построению: фамилии раздаются перестановкой списка, так
 * что первые двести с лишним людей — ещё и без однофамильцев, а полное имя
 * сверяется со всеми уже выданными. Возраст отсчитывается от года, а не от
 * сегодняшнего дня, чтобы «тот же человек» не старел между прогонами в
 * пределах года.
 */
export function makePeople(n: number, today: Date = new Date()): Person[] {
  const year = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const surnames = shuffled(ALL_SURNAMES, 31_337);
  const used = new Set<string>();
  const people: Person[] = [];

  for (let i = 0; i < n; i++) {
    const r = rng(1000 + i * 7919);
    const { archetype, variant } = archetypeAt(i);
    const job = service(archetype, variant, r);

    /* пол — по подразделению: в штурмовом женщин почти нет, в медроте — почти половина */
    let female = r() < job.women;
    let unit = job.unit;
    let post: string | null = job.post;
    let rank: string | null = null;
    let age: number;

    if (job.step === "staff") {
      age = between(r, 26, 55);
      // врачи госпиталя — офицеры, медсёстры и фельдшеры — по большей части вольнонаёмные
      rank = job.officer ? officerRank(age) : null;
    } else if (job.step === "veteran") {
      age = between(r, 27, 61);
      const former = r() < 0.75 ? pick(r, RANKS.soldier) : pick(r, RANKS.nco);
      rank = `${former} запасу`;
    } else {
      const u = UNITS.find((x) => x.title === unit)!;
      const posts = female ? u.posts.filter((p) => p.women) : u.posts;
      /* в подразделении без «женских» должностей — мужчина: штат так и устроен */
      const chosen = posts.length ? pick(r, posts) : pick(r, u.posts);
      if (!posts.length) female = false;
      post = chosen.title;
      const [lo, hi] = chosen.officer?.ages ?? AGES[chosen.step];
      age = between(r, lo, hi);
      rank = chosen.officer
        ? chosen.officer.ranks.filter(([from]) => age >= from).at(-1)![1]
        : chosen.step === "officer"
          ? officerRank(age)
          : pick(r, RANKS[chosen.step]);
    }

    /* горе вдовы и мать-одиночка в истории (см. demoStories, grief) — женщина-ветеран */
    if (archetype === "grief" && variant % ARCHETYPE_COUNTS.grief === 1) {
      female = true;
      unit = VETERAN_UNIT;
      post = null;
      rank = `${pick(r, RANKS.soldier)} запасу`;
    }

    const base = surnames[i % surnames.length]!;
    const lastName = female ? (ADJECTIVAL[base] ?? base) : base;
    const names = female ? FEMALE_NAMES : MALE_NAMES;
    let firstName: string = pick(r, names);
    let middle = pick(r, PATRONYMICS);
    /* «Ярослав Ярославович» бывает, но в картотеке из ста двадцати бросается в глаза — отчество другое */
    const sameAsFather = () => middle[0].startsWith(firstName.slice(0, -1)) || middle[0].startsWith(firstName);
    while (sameAsFather()) middle = PATRONYMICS[(PATRONYMICS.indexOf(middle) + 1) % PATRONYMICS.length]!;
    // полное имя — неповторимо: при совпадении перебираются имя, затем отчество
    for (let k = 0; used.has(`${lastName} ${firstName} ${middle[female ? 1 : 0]}`) && k < 400; k++) {
      firstName = names[(names.indexOf(firstName as never) + 1) % names.length]!;
      if (k % names.length === names.length - 1) middle = PATRONYMICS[(PATRONYMICS.indexOf(middle) + 1) % PATRONYMICS.length]!;
      while (sameAsFather()) middle = PATRONYMICS[(PATRONYMICS.indexOf(middle) + 1) % PATRONYMICS.length]!;
    }
    const middleName = middle[female ? 1 : 0];
    used.add(`${lastName} ${firstName} ${middleName}`);

    people.push({
      ordinal: i + 1,
      slug: `demo-${String(i + 1).padStart(3, "0")}`,
      lastName,
      firstName,
      middleName,
      sex: female ? "female" : "male",
      birthDate: birthDate(r, age, year),
      unit,
      rank,
      position: post,
      specialty: job.specialty,
      archetype,
      variant,
    });
  }
  return people;
}
