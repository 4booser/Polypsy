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
 * **Ответы согласованы между методиками.** У человека есть скрытое
 * состояние — уровень тревоги, подавленности, посттравматических реакций, —
 * и ответы во всех восьми опросниках выводятся из него. Случайные ответы
 * дали бы нулевые корреляции, шкалы без связи между собой и графики без
 * формы: на таких данных нельзя ни проверить аналитику, ни показать её.
 */

export type Trend = "improving" | "stable" | "worsening";

/** Скрытое состояние: от него выводятся ответы во всех методиках */
export interface Latent {
  /** 0 — нет признака, 1 — предельная выраженность */
  anxiety: number;
  depression: number;
  ptsd: number;
  stress: number;
  alcohol: number;
  /** Необычные переживания: у большинства около нуля */
  unusual: number;
  /** Благополучие считается обратным к остальному, но со своим шумом */
  wellbeing: number;
  /** Черты личности: E, A, C, N, O в долях от 0 до 1 */
  traits: [number, number, number, number, number];
}

export interface Person {
  slug: string;
  lastName: string;
  firstName: string;
  middleName: string;
  sex: "male" | "female";
  birthYear: number;
  unit: string;
  reason: string;
  latent: Latent;
  trend: Trend;
  /** Сколько раз обследовался за полгода */
  visits: number;
}

const UNITS = [
  "Терапевтичне відділення",
  "Хірургічне відділення",
  "Приймальне відділення",
  "Адміністрація",
  "Лабораторія",
  "Швидка допомога",
];

const REASONS = [
  "Не сплю третій тиждень, важко зібратися",
  "Після відрядження важко повернутися у звичний ритм",
  "Скерував керівник після розбору",
  "Постійна тривога без причини",
  "Втратив інтерес до всього, що раніше подобалося",
  "Після події на роботі повертаються спогади",
  "Дратуюся на близьких, зриваюся",
  "Хочу пройти обстеження перед призначенням",
  "Часто болить голова, лікар не знаходить причини",
  "Не можу зосередитися на роботі",
];

/* Имена подобраны распространённые: вымышленный человек не должен выглядеть
   пародией — на него будут смотреть те же люди, что и на настоящих. */
const MALE = [
  ["Шевченко", "Тарас", "Григорович"],
  ["Коваленко", "Андрій", "Петрович"],
  ["Бондаренко", "Сергій", "Іванович"],
  ["Ткаченко", "Олександр", "Миколайович"],
  ["Кравченко", "Дмитро", "Васильович"],
  ["Мельник", "Ігор", "Степанович"],
  ["Поліщук", "Роман", "Юрійович"],
  ["Мороз", "Віктор", "Анатолійович"],
  ["Лисенко", "Богдан", "Олегович"],
  ["Гончаренко", "Максим", "Сергійович"],
  ["Савченко", "Владислав", "Ігорович"],
  ["Марченко", "Артем", "Дмитрович"],
  ["Пономаренко", "Євген", "Валерійович"],
  ["Руденко", "Назар", "Романович"],
  ["Захарченко", "Юрій", "Павлович"],
];

const FEMALE = [
  ["Шевченко", "Оксана", "Григорівна"],
  ["Коваленко", "Наталія", "Петрівна"],
  ["Бондаренко", "Ірина", "Іванівна"],
  ["Ткаченко", "Тетяна", "Миколаївна"],
  ["Кравченко", "Олена", "Василівна"],
  ["Мельник", "Марія", "Степанівна"],
  ["Поліщук", "Юлія", "Юріївна"],
  ["Мороз", "Світлана", "Анатоліївна"],
  ["Лисенко", "Ганна", "Олегівна"],
  ["Гончаренко", "Вікторія", "Сергіївна"],
  ["Савченко", "Катерина", "Ігорівна"],
  ["Марченко", "Дарина", "Дмитрівна"],
  ["Пономаренко", "Людмила", "Валеріївна"],
  ["Руденко", "Софія", "Романівна"],
  ["Захарченко", "Аліна", "Павлівна"],
];

/**
 * Детерминированный источник случайности.
 *
 * Посев с настоящим Math.random даёт разную картотеку на каждом прогоне, и
 * повторный запуск на том же экземпляре завёл бы вторых Шевченків с другими
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

/** Нормальный шум: сумма трёх равномерных ближе к колоколу, чем одна */
function noise(r: () => number, spread: number): number {
  return ((r() + r() + r()) / 3 - 0.5) * 2 * spread;
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Портреты, из которых складывается картотека.
 *
 * Доли подобраны так, чтобы экраны показывали не только тяжёлое: очередь
 * разбора из ста человек не бывает, а система, где у всех всё плохо, ничего
 * не проверяет — в ней нельзя отличить работающий порог от сломанного.
 */
const PROFILES: { weight: number; make: (r: () => number) => Latent }[] = [
  {
    // здоровые: большинство любой картотеки
    weight: 40,
    make: (r) => ({
      anxiety: clamp(0.1 + noise(r, 0.12)),
      depression: clamp(0.08 + noise(r, 0.1)),
      ptsd: clamp(0.05 + noise(r, 0.08)),
      stress: clamp(0.25 + noise(r, 0.15)),
      alcohol: clamp(0.12 + noise(r, 0.12)),
      unusual: clamp(0.05 + noise(r, 0.06)),
      wellbeing: clamp(0.75 + noise(r, 0.15)),
      traits: [r(), r(), r(), clamp(0.3 + noise(r, 0.2)), r()],
    }),
  },
  {
    // тревожно-депрессивные: самая частая пара в поликлинике
    weight: 22,
    make: (r) => {
      const core = clamp(0.55 + noise(r, 0.2));
      return {
        anxiety: clamp(core + noise(r, 0.12)),
        depression: clamp(core - 0.05 + noise(r, 0.15)),
        ptsd: clamp(0.2 + noise(r, 0.15)),
        stress: clamp(core + 0.1 + noise(r, 0.12)),
        alcohol: clamp(0.2 + noise(r, 0.15)),
        unusual: clamp(0.1 + noise(r, 0.08)),
        wellbeing: clamp(0.35 - core * 0.2 + noise(r, 0.12)),
        traits: [clamp(0.35 + noise(r, 0.2)), r(), r(), clamp(0.7 + noise(r, 0.15)), r()],
      };
    },
  },
  {
    // выраженный стресс без клиники: перегрузка, а не расстройство
    weight: 16,
    make: (r) => ({
      anxiety: clamp(0.35 + noise(r, 0.15)),
      depression: clamp(0.22 + noise(r, 0.12)),
      ptsd: clamp(0.1 + noise(r, 0.1)),
      stress: clamp(0.75 + noise(r, 0.12)),
      alcohol: clamp(0.25 + noise(r, 0.15)),
      unusual: clamp(0.05 + noise(r, 0.06)),
      wellbeing: clamp(0.4 + noise(r, 0.15)),
      traits: [r(), r(), clamp(0.65 + noise(r, 0.2)), clamp(0.55 + noise(r, 0.2)), r()],
    }),
  },
  {
    // посттравматические реакции
    weight: 12,
    make: (r) => {
      const p = clamp(0.6 + noise(r, 0.2));
      return {
        anxiety: clamp(p - 0.1 + noise(r, 0.15)),
        depression: clamp(p - 0.15 + noise(r, 0.15)),
        ptsd: p,
        stress: clamp(p + noise(r, 0.12)),
        alcohol: clamp(0.35 + noise(r, 0.2)),
        unusual: clamp(0.15 + noise(r, 0.1)),
        wellbeing: clamp(0.3 + noise(r, 0.12)),
        traits: [clamp(0.3 + noise(r, 0.2)), r(), r(), clamp(0.75 + noise(r, 0.15)), r()],
      };
    },
  },
  {
    // проблемное употребление алкоголя
    weight: 6,
    make: (r) => ({
      anxiety: clamp(0.4 + noise(r, 0.2)),
      depression: clamp(0.45 + noise(r, 0.2)),
      ptsd: clamp(0.25 + noise(r, 0.15)),
      stress: clamp(0.5 + noise(r, 0.15)),
      alcohol: clamp(0.75 + noise(r, 0.15)),
      unusual: clamp(0.1 + noise(r, 0.08)),
      wellbeing: clamp(0.3 + noise(r, 0.15)),
      traits: [clamp(0.6 + noise(r, 0.2)), r(), clamp(0.3 + noise(r, 0.2)), clamp(0.6 + noise(r, 0.2)), r()],
    }),
  },
  {
    /*
     * Необычные переживания выше порога PQ-16. Доля намеренно мала: столько
     * их и бывает, а картотека, где каждый десятый за порогом, приучила бы
     * не смотреть на этот сигнал.
     */
    weight: 4,
    make: (r) => ({
      anxiety: clamp(0.5 + noise(r, 0.2)),
      depression: clamp(0.4 + noise(r, 0.2)),
      ptsd: clamp(0.2 + noise(r, 0.15)),
      stress: clamp(0.5 + noise(r, 0.15)),
      alcohol: clamp(0.2 + noise(r, 0.15)),
      unusual: clamp(0.65 + noise(r, 0.15)),
      wellbeing: clamp(0.3 + noise(r, 0.15)),
      traits: [clamp(0.25 + noise(r, 0.15)), r(), r(), clamp(0.65 + noise(r, 0.2)), clamp(0.7 + noise(r, 0.2))],
    }),
  },
];

const TOTAL_WEIGHT = PROFILES.reduce((s, p) => s + p.weight, 0);

/** Картотека из n человек — одна и та же при одном и том же n */
export function makePeople(n: number): Person[] {
  const people: Person[] = [];
  for (let i = 0; i < n; i++) {
    const r = rng(1000 + i * 7919);
    const male = r() < 0.45;
    const names = male ? MALE : FEMALE;
    const name = names[Math.floor(r() * names.length)]!;

    let pick = r() * TOTAL_WEIGHT;
    let profile = PROFILES[0]!;
    for (const p of PROFILES) {
      pick -= p.weight;
      if (pick <= 0) {
        profile = p;
        break;
      }
    }

    const trend: Trend = r() < 0.4 ? "improving" : r() < 0.75 ? "stable" : "worsening";
    people.push({
      slug: `demo-${String(i + 1).padStart(3, "0")}`,
      lastName: name[0]!,
      firstName: name[1]!,
      middleName: name[2]!,
      sex: male ? "male" : "female",
      birthYear: 1968 + Math.floor(r() * 38),
      unit: UNITS[Math.floor(r() * UNITS.length)]!,
      reason: REASONS[Math.floor(r() * REASONS.length)]!,
      latent: profile.make(r),
      trend,
      visits: 2 + Math.floor(r() * 4),
    });
  }
  return people;
}

/**
 * Состояние человека на конкретном замере.
 *
 * `step` — номер замера от нуля. Улучшение и ухудшение идут постепенно: скачок
 * от «тяжело» к «хорошо» за один замер выглядит как ошибка ввода, а не как
 * лечение, и на графике читается именно так.
 */
export function latentAt(person: Person, step: number, steps: number): Latent {
  const progress = steps <= 1 ? 0 : step / (steps - 1);
  const shift =
    person.trend === "improving" ? -0.35 * progress : person.trend === "worsening" ? 0.3 * progress : 0;
  const r = rng(7000 + step * 131 + person.slug.length * 17);
  const move = (v: number) => clamp(v + shift + noise(r, 0.07));

  const l = person.latent;
  return {
    anxiety: move(l.anxiety),
    depression: move(l.depression),
    ptsd: move(l.ptsd),
    stress: move(l.stress),
    alcohol: clamp(l.alcohol + shift * 0.4 + noise(r, 0.05)),
    unusual: clamp(l.unusual + shift * 0.3 + noise(r, 0.05)),
    // благополучие движется в обратную сторону: улучшение состояния его растит
    wellbeing: clamp(l.wellbeing - shift + noise(r, 0.07)),
    traits: l.traits,
  };
}
