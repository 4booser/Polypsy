/**
 * Наполнение стенда правдоподобными прохождениями. ТОЛЬКО для разработки.
 *
 * Прохождения сдаются через настоящий HTTP-обработчик, а не вставкой в
 * таблицы: иначе мимо пройдут подсчёт баллов, поднятие тревог, снимки пола и
 * возрастной группы, каскадные назначения и флаги качества — то есть ровно
 * то, что и нужно проверять на наполненном стенде.
 *
 * Ответы не случайны. У каждого человека есть скрытая выраженность состояния,
 * и вероятность «тяжёлого» варианта растёт вместе с ней. Равномерный шум дал
 * бы колокол вокруг середины по каждой шкале, нулевые корреляции и пустые
 * экраны надзора — стенд выглядел бы наполненным, а проверить на нём было бы
 * нечего.
 *
 *   bun run db:simulate            — 300 человек
 *   bun run db:simulate 1000       — столько, сколько попросили
 *   bun run db:simulate 1000 77    — то же с другим зерном случайности
 */
import { env } from "./env";

if (env.isProduction) {
  console.error("db:simulate запрещён в production");
  process.exit(1);
}

import { eq } from "drizzle-orm";
import { t, type Question, type SurveyFull } from "@quizzy/shared";
import { app } from "./app";
import { client, db } from "./db";
import { responses, surveys, users } from "./db/schema";
import { issueToken } from "./lib/auth";
import { encryptPersonFields } from "./lib/crypto";

const TOTAL = Math.max(1, Math.min(Number(process.argv[2] ?? 300), 5000));
/*
 * Метка прогона в адресе почты. Учётки симуляции удалить нельзя — у них есть
 * записи в журнале, а он неизменяем; значит, второй прогон обязан не
 * натыкаться на почту первого.
 */
const RUN = Date.now().toString(36);
/** Одновременных сдач: больше не ускоряет — упирается в один процесс сервера */
const CONCURRENCY = 8;

/* ─────────── случайность с зерном ─────────── */

/**
 * Свой генератор, а не Math.random: прогон должен воспроизводиться. Иначе
 * «на моей базе тревога есть, а у тебя нет» невозможно разобрать.
 */
let seed = Number(process.argv[3] ?? 20260827);
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));

/** Нормальное распределение через Бокса—Мюллера: возраст и выраженность не равномерны */
function gauss(mean: number, sd: number): number {
  const u = Math.max(rnd(), 1e-9);
  const v = Math.max(rnd(), 1e-9);
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ─────────── люди ─────────── */

const UNITS = [
  "1-й батальон",
  "2-й батальон",
  "3-й батальон",
  "Медицинская рота",
  "Рота связи",
  "Артиллерийский дивизион",
  "Разведрота",
];
const RANKS = ["Солдат", "Старший солдат", "Сержант", "Старший сержант", "Прапорщик", "Лейтенант"];
const POSITIONS = ["Стрелок", "Гранатометчик", "Санитарный инструктор", "Связист", "Водитель", "Наводчик"];

const MALE_FIRST = ["Тарас", "Богдан", "Андрій", "Олег", "Сергій", "Ігор", "Микола", "Василь", "Петро", "Юрій"];
const FEMALE_FIRST = ["Оксана", "Наталія", "Ірина", "Марія", "Олена", "Тетяна", "Софія", "Юлія"];
const LAST = [
  "Коваленко", "Шевченко", "Бондаренко", "Ткаченко", "Кравченко", "Мельник", "Поліщук",
  "Савченко", "Гриценко", "Марченко", "Лисенко", "Руденко", "Захарчук", "Литвин", "Дяченко",
];

interface Person {
  id: string;
  token: string;
  sex: "male" | "female";
  /** Скрытая выраженность состояния: −2 спокоен … +2 тяжело */
  trait: number;
  /** Отвечает небрежно: слишком быстро либо одним столбцом */
  careless: "fast" | "straight" | null;
}

async function makePerson(i: number): Promise<Person> {
  // 82 / 18 — правдоподобно для боевого подразделения, а не поровну
  const sex = rnd() < 0.82 ? "male" : "female";
  const first = sex === "male" ? pick(MALE_FIRST) : pick(FEMALE_FIRST);
  const last = pick(LAST) + (sex === "female" ? "" : "");
  const age = Math.round(Math.min(58, Math.max(18, gauss(31, 8))));
  const year = new Date().getFullYear() - age;

  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email: `sim-${RUN}-${i}@sim.local`,
    ...encryptPersonFields({
      firstName: first,
      lastName: last,
      middleName: null,
      birthDate: `${year}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`,
    }),
    sex,
    unit: pick(UNITS),
    rank: pick(RANKS),
    position: pick(POSITIONS),
    // войти под этими учётками нельзя: пароль — случайный мусор
    passwordHash: `sim:${crypto.randomUUID()}`,
    role: "user",
  });

  return {
    id,
    token: await issueToken({ id, role: "user" } as never),
    sex,
    /*
     * Хвост тяжёлых случаев толще нормального: в госпитале обследуют не
     * случайную улицу. Без этого шкалы риска почти не срабатывали бы, и
     * проверить разбор тревог было бы не на чем.
     */
    trait: rnd() < 0.14 ? gauss(1.5, 0.6) : gauss(-0.35, 0.85),
    careless: rnd() < 0.06 ? (rnd() < 0.5 ? "fast" : "straight") : null,
  };
}

/* ─────────── ответы ─────────── */

/**
 * Пункты, по которым намеренно заложено различие между мужчинами и женщинами.
 *
 * Это синтетика для проверки экрана DIF, а не находка: реальный анализ на
 * этих данных ничего не значит. Индексы фиксированы, чтобы эффект был
 * воспроизводим и его можно было узнать глазами.
 */
const DIF_ITEMS = new Set([7, 23]);

/**
 * Насколько трудно «согласиться» с пунктом.
 *
 * Без этого слагаемого все пункты равновероятны, и утвердительно ответить на
 * «жизнь иногда хуже смерти» оказывалось так же легко, как на «я плохо сплю».
 * В первом прогоне это дало 18 тяжёлых тревог на 24 прохождения — экран
 * тревог превращался в шум, на котором ничего не проверишь.
 *
 * Вариант, поднимающий тревогу, отодвинут далеко: согласие с ним требует
 * действительно высокой выраженности. Остальные пункты чуть различаются
 * между собой — детерминированно от номера, чтобы прогон воспроизводился.
 */
function difficultyOf(option: { riskFlag: boolean }, index: number): number {
  const critical = option.riskFlag ? 3.2 : 0;
  return critical + ((index * 37) % 11) / 11 - 0.5;
}

/**
 * Выбор варианта: чем выше выраженность, тем вероятнее «тяжёлый» ответ.
 *
 * Формально это softmax по баллам варианта за вычетом трудности пункта. Так
 * распределения по шкалам получаются скошенными, как в жизни, а не
 * биномиальными вокруг середины — и корреляции между шкалами появляются
 * сами, потому что у них общая причина.
 */
function chooseOption(q: Question, person: Person, index: number): string[] {
  const options = q.options.filter((o) => o.kind !== "row");
  if (!options.length) return [];

  if (person.careless === "straight") return [options[0]!.id];

  const scores = options.map((o) => o.score);
  const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
  const spread = Math.max(...scores) - Math.min(...scores) || 1;

  let trait = person.trait;
  if (DIF_ITEMS.has(index)) trait += person.sex === "female" ? 0.9 : -0.9;

  const weights = options.map((o) =>
    Math.exp((1.4 * trait * (o.score - mean)) / spread - difficultyOf(o, index) * ((o.score - mean) / spread + 0.5)),
  );
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rnd() * total;
  for (let i = 0; i < options.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return [options[i]!.id];
  }
  return [options[options.length - 1]!.id];
}

function answerFor(q: Question, person: Person, index: number) {
  const base = {
    questionId: q.id,
    // небрежные проскакивают вопрос за доли секунды — это и ловит флаг «слишком быстро»
    durationMs: person.careless === "fast" ? int(200, 700) : int(1800, 9000),
    changeCount: rnd() < 0.12 ? 1 : 0,
    visitCount: 1,
  };

  switch (q.type) {
    case "single":
    case "yesno":
    case "multiple":
      return { ...base, optionIds: chooseOption(q, person, index) };
    case "matrix": {
      const rows = q.options.filter((o) => o.kind === "row");
      const matrix: Record<string, string> = {};
      for (const row of rows) matrix[row.id] = chooseOption(q, person, index)[0]!;
      return { ...base, matrix };
    }
    case "scale":
    case "slider":
    case "number": {
      const min = q.minValue ?? 0;
      const max = q.maxValue ?? 10;
      const mid = (min + max) / 2;
      const value = Math.round(Math.min(max, Math.max(min, mid + person.trait * (max - min) * 0.22)));
      return { ...base, number: value };
    }
    case "text":
    case "longtext":
      return { ...base, text: "" };
    case "date":
      return { ...base, date: new Date().toISOString().slice(0, 10) };
    default:
      return { ...base, skipped: true };
  }
}

/* ─────────── сдача ─────────── */

async function apiCall(path: string, token: string, init: RequestInit = {}) {
  const res = await app.request(path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const contentCache = new Map<string, SurveyFull>();

async function submit(person: Person, surveyId: string, daysAgo: number, drift: number) {
  let survey = contentCache.get(surveyId);
  if (!survey) {
    const res = await apiCall(`/api/surveys/${surveyId}`, person.token);
    if (res.status !== 200) return false;
    survey = res.body as SurveyFull;
    contentCache.set(surveyId, survey);
  }

  const shifted: Person = { ...person, trait: person.trait + drift };
  const asked = survey.questions.filter((q) => q.type !== "info");
  const answers = asked.map((q, i) => answerFor(q, shifted, i));
  const durationMs = answers.reduce((s, a) => s + (a.durationMs ?? 0), 0);
  const startedAt = new Date(Date.now() - daysAgo * 86_400_000 - durationMs).toISOString();

  const res = await apiCall(`/api/surveys/${surveyId}/responses`, person.token, {
    method: "POST",
    body: JSON.stringify({ answers, startedAt, durationMs, status: "completed" }),
  });
  if (res.status !== 201) return false;

  /*
   * Дату сдачи двигаем в прошлое уже после вставки.
   *
   * Сервер ставит submitted_at сам и правильно делает: доверять клиентской
   * дате нельзя, иначе прохождение можно задним числом «перенести» в другой
   * период отчётности. Но тогда весь набор ложится одним днём, и динамика,
   * дрейф выборки и контрольные карты становятся бессмысленными — на графике
   * ровная нулевая линия и один шип сегодня.
   *
   * Поэтому дата правится напрямую в базе: это допустимо ровно потому, что
   * скрипт для разработки и в production не запускается.
   */
  const id = (res.body as { id?: string } | null)?.id;
  if (id) {
    await db
      .update(responses)
      .set({ submittedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString() })
      .where(eq(responses.id, id));
  }
  return true;
}

/* ─────────── прогон ─────────── */

const rows = await db.select().from(surveys).where(eq(surveys.administration, "self"));
const pool = rows.filter((r) => r.status === "published").map((r) => ({ id: r.id, title: t(r.title as never) }));
if (!pool.length) {
  console.error("Нет опубликованных методик самозаполнения — сначала bun run db:seed");
  process.exit(1);
}

console.log(`Методик в обороте: ${pool.length}`);
console.log(`Людей: ${TOTAL}\n`);

let done = 0;
let submitted = 0;
let repeats = 0;

async function worker(from: number, step: number) {
  for (let i = from; i < TOTAL; i += step) {
    const person = await makePerson(i);

    // сколько методик прошёл: большинство одну-две, кто-то весь набор
    const count = rnd() < 0.55 ? 1 : rnd() < 0.85 ? 2 : Math.min(pool.length, 4);
    const chosen = [...pool].sort(() => rnd() - 0.5).slice(0, count);

    for (const s of chosen) {
      const daysAgo = int(0, 180);
      if (await submit(person, s.id, daysAgo, 0)) submitted++;

      /*
       * Часть людей приходит повторно, и состояние между визитами меняется.
       * Без этого не на чем смотреть динамику и достоверность сдвига (RCI):
       * один замер на человека — это точка, а не линия.
       */
      if (rnd() < 0.3 && daysAgo > 40) {
        const drift = person.trait > 0.5 ? -gauss(0.7, 0.4) : gauss(0, 0.5);
        if (await submit(person, s.id, Math.max(0, daysAgo - int(30, 90)), drift)) {
          submitted++;
          repeats++;
        }
      }
    }

    done++;
    if (done % 50 === 0) process.stdout.write(`  ${done} / ${TOTAL} человек, прохождений ${submitted}\n`);
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, (_, k) => worker(k, CONCURRENCY)));

console.log(`\nГотово за ${((Date.now() - started) / 1000).toFixed(1)} с`);
console.log(`  людей:        ${done}`);
console.log(`  прохождений:  ${submitted}`);
console.log(`  из них повторных: ${repeats}`);
console.log(`\nВ пунктах ${[...DIF_ITEMS].join(" и ")} намеренно заложено различие по полу —`);
console.log("это синтетика для проверки экрана DIF, а не находка.");

await client.end();
