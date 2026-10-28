import type { SafetyPlanContent } from "@quizzy/shared";
import type { AnswerPlan } from "./demoAnswers";
import { ARCHETYPE_COUNTS, between, pick, rng, type ArchetypeKey, type Person } from "./demoPeople";

/**
 * Клинические истории вымышленных людей: с чем пришёл, чем и когда меряли,
 * как шло лечение, что записал специалист.
 *
 * Картотека прежней редакции была набором замеров без людей: PHQ-9 и GAD-7
 * случайным блужданием, обращения без повода, ни одной записи приёма, ни
 * одного заключения. Специалист, открывший такую карточку, не мог понять
 * про человека ничего — а заказчик судит о продукте именно по ним. Здесь у
 * каждого портрета отделения (lib/demoPeople.ts, ARCHETYPE_COUNTS) своя
 * история с началом и ходом:
 *
 *   · методики — те, которыми такой случай и ведут: бойовий ПТСР — PCL-5,
 *     PHQ-9, SCI, один раз LEC-5 и CES; горе — TGI-SR+; выгорание персонала —
 *     BAT-12, ProQOL, PSS-10; кризис — C-SSRS, SIDAS, SBQ-R;
 *   · баллы — траектория курса (быстрый ответ в начале, пологий конец), с
 *     разбросом замера, а не случайное блуждание; повторный замер — раз в
 *     2–4 недели, как его назначают; методику с окном «за два тижні» не
 *     повторяют на следующий день;
 *   · риск — у немногих и по делу: открытые случаи только у тех, у кого
 *     острое состояние сейчас (около шести процентов), остальные сигналы
 *     разобраны лечащим специалистом с исходом и заметкой;
 *   · записи приёма — коротким клиническим текстом по-украински: жалобы,
 *     психический статус, вмешательство, план; сеансы идут по протоколу
 *     метода (CPT, PE, EMDR, поведенческая активация, КПТ-І), а не одной
 *     фразой по кругу, и с настоящими баллами замера.
 *
 * Модуль только описывает историю — днями от сегодняшнего и словами. Писать
 * её в базу (приёмы в слоты, прохождения через persistSubmission, даты
 * сигналов, подписи) — дело lib/demoFill.ts.
 */

/* ═════════════ описание истории ═════════════ */

/** Замер одной методикой: цель по шкалам и заданные ответы — см. lib/demoAnswers.ts */
export interface Measure extends Omit<AnswerPlan, "seed"> {
  key: string;
  /** Заполняет специалист на приёме (интервью C-SSRS, шкала CIWA-Ar) */
  clinician?: boolean;
}

/** Что известно на момент записи приёма: баллы этого и прошлых замеров */
export interface NoteContext {
  person: Person;
  /** Значение шкалы в замере этого приёма; без шкалы — первая шкала методики */
  score(key: string, scale?: string): number | null;
  /** Подпись полосы, в которую лёг балл этого замера */
  band(key: string, scale?: string): string | null;
  /** Первый замер методики у человека */
  first(key: string, scale?: string): number | null;
  /** Последний замер методики на этот момент — этого приёма или раньше (домашний скрининг) */
  last(key: string, scale?: string): number | null;
  /** Номер состоявшегося приёма у человека, с единицы: первичный — первый */
  visitNo: number;
  /** ФИО лечащего специалиста */
  clinician: string;
  /** Дата дня истории — ДД.ММ.ГГГГ */
  date(day: number): string;
}

export type NoteFn = (c: NoteContext) => string;

export interface Visit {
  /** День относительно сегодняшнего по Киеву: −3 — три дня назад */
  day: number;
  kind: "primary" | "repeat";
  /** Чем закончился приём, если к моменту наполнения он прошёл */
  outcome: "done" | "no_show" | "cancelled";
  measures: Measure[];
  note?: NoteFn;
  noteKind?: "intake" | "session" | "observation" | "consult";
  /** Запись приёма не подписана — черновик */
  draft?: boolean;
  /** Повод со слов пациента — у первичного приёма */
  reason?: string;
  /** Срочный приём — в ближайшее свободное время, а не в привычное */
  urgent?: boolean;
}

/** Замер вне приёма — дома, по назначению */
export interface HomeSession {
  day: number;
  /** Минута суток по Киеву */
  minute: number;
  /**
   * Сдано только что — за час-три до наполнения, а не в заданную минуту:
   * случай по такому замеру в очереди свежий, а не висит с позавчера.
   */
  recent?: boolean;
  measures: Measure[];
}

export interface CaseDecision {
  outcome: "confirmed" | "not_confirmed" | "needs_followup";
  note: string;
}

/** Что сработало в замере, по которому открылся случай */
export interface CaseContext {
  day: number;
  /** Подписи сигналов случая */
  labels: string[];
  /** Был ли сигнал по критическому пункту (а не только по полосе шкалы) */
  critical: boolean;
  /** Первый случай у человека */
  first: boolean;
}

export interface Story {
  episode: {
    openDay: number;
    reason: string;
    closeDay?: number;
    outcome?: "improved" | "stable" | "worse" | "referred" | "dropped" | "transferred";
    outcomeText?: NoteFn;
  } | null;
  visits: Visit[];
  home: HomeSession[];
  /** С какого дня случаи риска остаются неразобранными — у тех, кто в остром состоянии сейчас */
  openFrom?: number;
  /** Решение лечащего специалиста по случаю */
  decide: (c: CaseContext) => CaseDecision;
  /** Заключение по замеру приёма: номер приёма в visits и методика, к прохождению которой оно пишется */
  conclusion?: { visit: number; key: string; text: NoteFn };
  safetyPlans: { day: number; content: (clinician: string) => SafetyPlanContent }[];
  referrals: {
    day: number;
    destination: "psychiatrist" | "inpatient" | "outpatient" | "commander" | "other";
    urgency: "routine" | "urgent" | "immediate";
    status: "created" | "accepted" | "completed" | "declined";
    reason: string;
    outcomeNote?: string;
    updatedDay?: number;
  }[];
  dispensary?: { groupLabel: string; intervalMonths: number; lastSeenDay: number; nextDueDay: number; note?: string };
  thread?: { day: number; minute: number; fromPatient: boolean; text: string; read: boolean }[];
  /** Назначенный следующий замер: методика, когда выдан и к какому дню */
  pending: { key: string; grantedDay: number; dueDay: number }[];
  /** Набор «Первинний скринінг»: когда назначен и к какому дню */
  battery?: { assignedDay: number; dueDay: number };
}

/* ═════════════ слова ═════════════ */

const g = (p: Person, male: string, female: string) => (p.sex === "female" ? female : male);
const fmt = (v: number | null, digits = 0) =>
  v === null ? "—" : digits ? v.toFixed(digits).replace(".", ",") : String(Math.round(v));

/** Форма слова при числе: 1 тиждень, 2 тижні, 5 тижнів */
function pl(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.round(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/** Подпись полосы внутри фразы — со строчной, если это не аббревиатура */
const lc = (s: string) => (s.length > 1 && s[1] === s[1]!.toLowerCase() ? s[0]!.toLowerCase() + s.slice(1) : s);

/** «53, поріг ймовірного ПТСР досягнуто» — балл и полоса без скобок в скобках */
const banded = (v: number | null, band: string | null, digits = 0) => (band ? `${fmt(v, digits)}, ${lc(band)}` : fmt(v, digits));

/** Как методику называют в записи приёма */
const TITLE: Record<string, string> = { pcl5: "PCL-5", phq9: "PHQ-9", who5: "WHO-5", k10: "K10", sci: "SCI" };

/** Динамика словами, без статистического жаргона */
function change(now: number | null, then: number | null, meaningful: number, lowerIsBetter = true): string {
  if (now === null || then === null) return "";
  const d = lowerIsBetter ? then - now : now - then;
  if (Math.abs(d) < meaningful) return "у межах похибки вимірювання";
  return d > 0 ? "зміна значуща, на краще" : "зміна значуща, на гірше";
}

const STATUS_CALM = (p: Person) =>
  `Свідомість ясна, ${g(p, "орієнтований", "орієнтована")} у повному обсязі; контакт продуктивний; мислення послідовне.`;

/** «з дружиною» / «з чоловіком» */
const spouse = (p: Person) => g(p, "дружиною", "чоловіком");

/**
 * Сеанс по протоколу: n-й состоявшийся приём берёт n-ю ступень метода.
 * Сверх протокола (продлённый курс) ступени идут по кругу с отметкой
 * «продовження» — одна и та же фраза два приёма подряд выглядела бы
 * копированием, а не записью.
 */
function step(list: string[], visitNo: number): string {
  const i = Math.max(0, visitNo - 2);
  if (i < list.length) return list[i]!;
  return `Продовження: ${lc(list[Math.max(0, list.length - 3) + ((i - list.length) % Math.min(3, list.length))]!)}`;
}

/* ═════════════ траектории ═════════════ */

/** Значение на доле курса t ∈ [0; 1]: быстрый ответ в начале, пологий конец — как идёт ответ на терапию */
function curve(from: number, to: number, t: number, speed = 2.2): number {
  const k = (1 - Math.exp(-speed * Math.max(0, Math.min(1, t)))) / (1 - Math.exp(-speed));
  return from + (to - from) * k;
}

/** Балл с разбросом замера, в пределах шкалы */
function noisy(r: () => number, v: number, spread: number, lo: number, hi: number, digits = 0): number {
  const raw = v + (r() + r() - 1) * spread;
  const m = 10 ** digits;
  return Math.max(lo, Math.min(hi, Math.round(raw * m) / m));
}

/** Дни курса: первый приём, затем с шагом, с отклонением в день-два, строго по возрастанию */
function courseDays(r: () => number, start: number, every: number, count: number, wobble = 1): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    let d = start + i * every + (i ? between(r, -wobble, wobble) : 0);
    if (out.length && d <= out[out.length - 1]!) d = out[out.length - 1]! + 1;
    out.push(d);
  }
  return out;
}

/**
 * Будущее курса обрезается: в журнале записи стоят один-два следующих
 * приёма, а не все двенадцать до весны.
 */
function trimFuture(days: number[], keep = 2): number[] {
  const past = days.filter((d) => d <= 0);
  const future = days.filter((d) => d > 0 && d <= 20).slice(0, keep);
  return [...past, ...future];
}

/* ═════════════ методики ═════════════ */

const M = {
  pcl5: (total: number): Measure => ({ key: "pcl5", targets: { PCL: total } }),
  phq9: (total: number, item9 = 0): Measure => ({ key: "phq9", targets: { PHQ: total }, fixed: { 9: item9 } }),
  gad7: (total: number): Measure => ({ key: "gad7", targets: { GAD: total } }),
  who5: (raw: number): Measure => ({ key: "who5", targets: { WHO5: raw } }),
  sci: (total: number): Measure => ({ key: "sci", targets: { SCI: total } }),
  sci02: (total: number): Measure => ({ key: "sci02", targets: { SCI02: total } }),
  ris: (total: number): Measure => ({ key: "ris", targets: { RIS: total } }),
  fas: (total: number): Measure => ({ key: "fas", targets: { FAS: total } }),
  k10: (total: number): Measure => ({ key: "k10", targets: { K10: total } }),
  pss10: (total: number): Measure => ({ key: "pss10", targets: { PSS: total } }),
  phq4: (anx: number, dep: number): Measure => ({ key: "phq4", targets: { ANX: anx, DEP: dep } }),
  audit: (total: number): Measure => ({ key: "audit", targets: { AUDIT: total } }),
  auditc: (total: number): Measure => ({ key: "auditc", targets: { AUDITC: total } }),
  ciwa: (total: number): Measure => ({ key: "ciwaar", targets: { CIWA: total }, clinician: true }),
  bat12: (avg: number): Measure => ({ key: "bat12", targets: { BAT12: avg } }),
  proqol: (cs: number, bo: number, sts: number): Measure => ({ key: "proqol5", targets: { CS: cs, BO: bo, STS: sts } }),
  ces: (total: number): Measure => ({ key: "ces", targets: { CES: total } }),
  /* ворота «чи була подія» — так: у військових вона була майже завжди, PC-PTSD-5 рахує, що з неї лишилося */
  pcptsd5: (n: number): Measure => ({ key: "pcptsd5", targets: { PCPTSD5: n }, fixed: { 1: 1 } }),
  pq16: (total: number): Measure => ({ key: "pq16", targets: { PQ: total } }),
  /** MIOS: ворота «есть ли такой опыт» — да; тип опыта — номера вариантов с нуля */
  mios: (shame: number, trust: number, kinds: number[]): Measure => ({
    key: "mios",
    targets: { SR: shame, TVR: trust },
    fixed: { 1: 1, 2: kinds },
  }),
  /** TGI-SR+: п. 17 («бажання померти, щоб бути з покійним») — по сюжету, 1 — «ніколи» */
  tgi: (total: number, item17 = 1): Measure => ({ key: "tgi_sr_plus", targets: { TGI: total }, fixed: { 17: item17 } }),
  /**
   * C-SSRS (скринер): ответы интервью по пунктам, 1 — «так». Пункты 3–5
   * задаются только при «так» на второй, седьмой — при «так» на шестой.
   */
  cssrs: (a: { wish: boolean; thoughts: boolean; method?: boolean; intent?: boolean; plan?: boolean; behavior?: boolean; recent?: boolean }): Measure => {
    const yes = (v: boolean | undefined) => (v ? 1 : 0);
    const fixed: Record<number, number> = { 1: yes(a.wish), 2: yes(a.thoughts), 6: yes(a.behavior) };
    if (a.thoughts) Object.assign(fixed, { 3: yes(a.method), 4: yes(a.intent), 5: yes(a.plan) });
    if (a.behavior) fixed[7] = yes(a.recent);
    return { key: "cssrs", targets: {}, clinician: true, allowRisk: true, fixed };
  },
  /** SBQ-R: баллы вариантов по пунктам бланка */
  sbqr: (i1: number, i2: number, i3: number, i4: number): Measure => ({
    key: "sbqr",
    targets: {},
    allowRisk: true,
    fixed: { 1: i1, 2: i2, 3: i3, 4: i4 },
  }),
  /** SIDAS: частота думок (п. 1) — ворота остальных пунктов */
  sidas: (total: number): Measure =>
    total > 0
      ? { key: "sidas", targets: { SIDAS: total }, fixed: { 1: Math.max(1, Math.round(total / 5)) }, allowRisk: true }
      : { key: "sidas", targets: {}, fixed: { 1: 0 } },
  /** LEC-5: на каждую подію — номера вариантов с нуля; не названа — «не стосується мене» */
  lec5: (events: Record<number, number[]>): Measure => ({
    key: "lec5",
    targets: {},
    fixed: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [i + 1, events[i + 1] ?? [5]])),
  }),
};

/* ═════════════ общие решения по случаям ═════════════ */

/** Решение по случаю, когда сработали только полосы шкал: на старте — подтверждено, дальше — наблюдение */
function bandDecision(start: string, follow = "Пацієнт на курсі, динаміка за планом; контрольний замір у визначений строк."): (c: CaseContext) => CaseDecision {
  return (c) => (c.first ? { outcome: "confirmed", note: start } : { outcome: "needs_followup", note: follow });
}

/** Девятый пункт PHQ-9 без активных намерений: интервью проведено, острого риска нет */
const PASSIVE_IDEATION: CaseDecision = {
  outcome: "not_confirmed",
  note: "C-SSRS проведено: пасивні думки про смерть без наміру й плану; гострого ризику немає. Обговорено план безпеки, домовлено про контакт.",
};

/* ═════════════ план безопасности ═════════════ */

function safetyPlan(
  r: () => number,
  opts: { signs: string[]; reasons: string[]; weapon: boolean; people: [string, string][] },
): (clinician: string) => SafetyPlanContent {
  const coping = pickSome(r, [
    "Вийти на прогулянку на 20–30 хвилин",
    "Дихання 4–6: вдих на 4, видих на 6, п’ять хвилин",
    "Холодна вода на обличчя й руки",
    "Записати думки в нотатки телефону, не залишатися з ними в голові",
    "Фізичне навантаження: віджимання, присідання, турнік",
    "Увімкнути аудіокнигу або подкаст",
  ], 3);
  const distractions = pickSome(r, [
    "Вийти до спільної кімнати відділення, де є люди",
    "Спортзал госпіталю",
    "Подзвонити побратимові без розмови про погане",
    "Прибрати в кімнаті, розібрати речі",
    "Футбол по телевізору з сусідами по палаті",
  ], 2);
  return (clinician) => ({
    warningSigns: opts.signs,
    copingStrategies: coping,
    distractions,
    people: opts.people.map(([name, contact]) => ({ name, contact })),
    professionals: [
      { name: `${clinician}, психолог відділення`, contact: "кабінет у відділенні, пн–пт 9:00–17:00" },
      { name: "Черговий лікар госпіталю", contact: "через пост медичної сестри, цілодобово" },
      { name: "Лінія психологічної підтримки ветеранів", contact: "7333" },
    ],
    meansRestriction: opts.weapon
      ? "Зброю здано на зберігання черговому підрозділу до рішення лікаря-психіатра. Ліки видає медична сестра відділення, вдома запасу немає."
      : "Ліки видає медична сестра відділення, запасу при собі немає. Алкоголь — ні.",
    reasonsToLive: opts.reasons,
  });
}

function pickSome<T>(r: () => number, list: readonly T[], n: number): T[] {
  const pool = [...list];
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]!);
  return out;
}

/** Телефон близкого — вымышленный, того же вида, что у вымышленных людей */
function contactPhone(r: () => number): string {
  const s = String(500_000_000 + Math.floor(r() * 90_000_000));
  return `+380 ${s.slice(0, 2)} ${s.slice(2, 5)} ${s.slice(5, 7)} ${s.slice(7, 9)}`;
}

/* ═════════════ общие кирпичи ═════════════ */

type Builder = (p: Person, r: () => number, v: number) => Story;

const NONE: Pick<Story, "home" | "safetyPlans" | "referrals" | "pending"> = { home: [], safetyPlans: [], referrals: [], pending: [] };

/**
 * Пункт приёма в курсе: прошедшее — по сюжету, будущее — запись.
 * Неявка выпадает из курса без замера и записи — как и в жизни.
 */
function visit(day: number, kind: Visit["kind"], measures: Measure[], note: NoteFn | undefined, extra: Partial<Visit> = {}): Visit {
  return { day, kind, outcome: "done", measures, note, noteKind: kind === "primary" ? "intake" : "session", ...extra };
}

/** День последнего состоявшегося замера методикой — от него считается назначенный повтор */
function lastDayWith(visits: Visit[], key: string): number | null {
  const days = visits.filter((x) => x.day <= 0 && x.outcome === "done" && x.measures.some((m) => m.key === key)).map((x) => x.day);
  return days.length ? Math.max(...days) : null;
}

/** День последнего состоявшегося приёма */
const lastPastOf = (visits: Visit[], fallback: number) => visits.filter((x) => x.day <= 0 && x.outcome === "done").at(-1)?.day ?? fallback;

/* ═════════════ портреты ═════════════ */

/* ─── бойовий ПТСР, покращення на терапії ─── */

const PTSD_EVENTS = [
  "мінометний обстріл позицій, під час якого загинув побратим",
  "підрив на міні під час евакуації пораненого",
  "штурм опорного пункту й тривалий бій у посадці",
  "обстріл колони, осколкове поранення",
  "атака FPV-дронів на бліндаж, двоє загиблих поруч",
  "кількаденне утримання позиції в оточенні",
];
const MEDIC_EVENT = "евакуація поранених під обстрілом, загибель пораненого під час евакуації";

const METHODS = [
  { name: "CPT (когнітивна терапія переробки)", short: "CPT", sessions: 12 },
  { name: "пролонгована експозиція (PE)", short: "PE", sessions: 10 },
  { name: "EMDR", short: "EMDR", sessions: 9 },
];

/** Сеанси CPT за протоколом — з другого (перший — первинний прийом) */
const CPT_STEPS = (p: Person, event: string) => [
  `Прочитано заяву про вплив події; визначено застряглі точки: «Я ${g(p, "мав", "мала")} це передбачити», «Нікому не можна довіряти». Пояснено аркуші ABC.`,
  "Аркуші ABC заповнено 5 днів із 7: відокремлює подію, думку й почуття; провідна емоція — провина. Домашнє завдання — письмовий опис події.",
  `Прочитано опис події (${event}); виражені сум і злість, уперше без уникання деталей. Домашнє завдання — перечитувати щодня.`,
  `Сократівський діалог щодо провини: розмежування наміру, передбачуваності й відповідальності. Частково приймає, що не ${g(p, "міг", "могла")} знати, куди прилетить.`,
  "Аркуші оскарження думок; патерни мислення — «все або нічого», перебільшення небезпеки.",
  `Тема безпеки: рідше перевіряє замки й вікна вночі; ${g(p, "сходив", "сходила")} у супермаркет у годину пік.`,
  "Тема довіри — до командування, до рідних і до себе; обговорено, кому й що можна розповісти.",
  "Тема влади й контролю: спалахи гніву вдома рідші, користується паузою «зупинитися — вдих — вийти з кімнати».",
  `Тема самоповаги: «Я не ${g(p, "слабкий", "слабка")}, бо ${g(p, "вижив", "вижила")}»; приймає подяку побратимів без знецінення.`,
  `Тема близькості: ${g(p, "повернувся", "повернулася")} до спілкування з побратимами, уперше за пів року ${g(p, "пішов", "пішла")} на зустріч підрозділу.`,
  "Нова заява про вплив події: провину змінили сум і вдячність загиблому. Профілактика рецидиву, план на випадок загострення.",
];

const PE_STEPS = (p: Person, event: string) => [
  "Психоосвіта про уникання; складено ієрархію: натовп, громадський транспорт, звук мотоцикла, новини з фронту. Перше завдання in vivo — супермаркет удень.",
  `Перша експозиція в уяві: розповідь про подію (${event}) 40 хв, дистрес з 85 до 60 зі 100. Запис сесії — слухати щодня.`,
  "Експозиція в уяві: дистрес на піку 75, наприкінці 45. In vivo — поїздка маршруткою без виходу посеред дороги.",
  "Гарячі точки спогаду: момент вибуху й тиша після нього. Дистрес на піку 65.",
  `Гаряча точка «не ${g(p, "встиг", "встигла")} допомогти»; сльози, після — полегшення. In vivo — торговий центр у вихідний.`,
  "Дистрес на піку 45, наприкінці 20. Слухає запис щодня без уникання, новини дивиться без панічних реакцій.",
  "Гарячі точки опрацьовано, розповідь цілісна, дистрес 30. In vivo — концерт у місті, до кінця.",
  "Підсумкова експозиція: дистрес 20 зі 100; ієрархію пройдено.",
  "Завершення курсу: план самостійних вправ, профілактика рецидиву. Уникання суттєво менше.",
];

const EMDR_STEPS = (p: Person, event: string) => [
  "Підготовка: ресурс «безпечне місце», техніка «контейнер», навички заземлення. Обрано мішені: подія, нічні звуки, запах гару.",
  `Оцінка першої мішені (${event}): переконання «Я ${g(p, "безпорадний", "безпорадна")}», дистрес 9 з 10, віра в позитивне переконання 2 з 7. Перша десенсибілізація — дистрес 6.`,
  `Десенсибілізація першої мішені: дистрес з 6 до 2; нове переконання «${g(p, "Я зробив усе, що міг", "Я зробила все, що могла")}» — 5 з 7.`,
  "Друга мішень — нічні звуки: дистрес з 7 до 3. Удень на гучні звуки реагує слабше.",
  "Третя мішень — запах гару: дистрес з 6 до 1. Сканування тіла: напруга в плечах минає.",
  "Перевірка опрацьованих мішеней: дистрес 0–1, позитивне переконання 6 з 7. Майбутній шаблон — повернення до підрозділу.",
  "Майбутній шаблон: перший день у підрозділі, звук артилерії — дистрес 2 з 10.",
  "Завершення курсу: усі мішені опрацьовано, план підтримки, контрольний огляд через 6 тижнів.",
];

/** Кошмары и сон по ходу курса — строкой состояния в записи */
function nightsLine(t: number, from = 5, to = 0.5): string {
  const n = Math.round(curve(from, to, t));
  const sleep = Math.round(curve(4, 7, t));
  return n > 0 ? `Кошмари ${n} ${pl(n, "раз", "рази", "разів")} на тиждень, сон ${sleep} год.` : `Кошмарів за тиждень не було, сон ${sleep} год.`;
}

const ptsd: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.ptsd;
  const method = METHODS[v % METHODS.length]!;
  const medic = p.specialty === "Медична служба";
  const event = medic ? MEDIC_EVENT : pick(r, PTSD_EVENTS);
  const steps = method.short === "CPT" ? CPT_STEPS(p, event) : method.short === "PE" ? PE_STEPS(p, event) : EMDR_STEPS(p, event);
  const start = -between(r, 45, 150);
  const all = courseDays(r, start, 7, method.sessions);
  /* один из шестнадцати перестал приходить посреди курса: последний приём — неявка, повтор не сдан */
  const dropout = k === 9 && start < -60;
  const days = dropout ? all.filter((d) => d <= -6) : trimFuture(all);
  const end = all[all.length - 1]!;
  const finished = end < -10 && !dropout;

  const pclFrom = between(r, 46, 62);
  const pclTo = between(r, 18, 30);
  const phqFrom = between(r, 11, 17);
  const phqTo = between(r, 4, 8);
  const sciFrom = between(r, 6, 13);
  const sciTo = between(r, 17, 23);
  const at = (d: number) => (d - start) / Math.max(1, end - start);
  const pcl = (d: number) => noisy(r, curve(pclFrom, pclTo, at(d)), 3, 0, 80);
  const phq = (d: number) => noisy(r, curve(phqFrom, phqTo, at(d)), 1.5, 0, 27);
  const sci = (d: number) => noisy(r, curve(sciFrom, sciTo, at(d)), 2, 0, 32);
  // у одного из шестнадцати на старте — девятый пункт PHQ-9 «кілька днів»
  const item9 = k === 4 ? 1 : 0;
  const missed = r() < 0.3 ? between(r, 2, Math.max(2, days.length - 2)) : -1;

  const visits: Visit[] = days.map((d, i) => {
    if (i === 0) {
      return visit(
        d,
        "primary",
        [
          M.pcl5(pclFrom),
          M.phq9(phqFrom, item9),
          M.sci(sciFrom),
          // перелік подій — після симптомів: щойно згадані епізоди не мають забарвлювати відповіді про теперішній стан
          M.lec5(medic ? { 10: [0, 3], 12: [1], 13: [1, 3], 14: [1, 3], 2: [0] } : { 10: [0], 2: [0], 7: [0], 13: [1], 14: [1], 16: r() < 0.4 ? [0] : [5] }),
          M.ces(between(r, 22, 36)),
          ...(item9 ? [M.cssrs({ wish: true, thoughts: false })] : []),
        ],
        (c) =>
          [
            "Первинний прийом.",
            `Скарги: нав’язливі спогади, нічні кошмари ${between(r, 3, 5)} рази на тиждень, сон ${between(r, 3, 5)} год, дратівливість, уникання розмов про службу.`,
            `Анамнез: на передовій ${between(r, 5, 22)} міс.; подія — ${event}. Раніше за психологічною допомогою не ${g(p, "звертався", "зверталася")}.`,
            `Психічний стан: ${STATUS_CALM(p)} Настрій знижений, тривожний; афект звужений. ${item9 ? "Пасивне бажання смерті без думок про самогубство (C-SSRS)." : "Суїцидальні думки заперечує."}`,
            `Обстеження: PCL-5 — ${banded(c.score("pcl5"), c.band("pcl5"))}; PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))}; SCI — ${fmt(c.score("sci"))}; бойова експозиція (CES) — ${fmt(c.score("ces"))}.`,
            "Оцінка: виражені посттравматичні симптоми з депресивними проявами та безсонням; діагноз — за лікарем-психіатром.",
            `План: психоосвіта; ${method.name}, ${method.sessions} сесій щотижня; контрольний PCL-5 через 3–4 тижні.`,
          ].join("\n"),
        { reason: pick(r, ["Не можу спати, щоночі сниться той обстріл", "Зриваюся на рідних, не впізнаю себе", "Постійно напоготові, не можу розслабитися навіть удома"]) },
      );
    }
    if (i === missed || (dropout && i === days.length - 1)) return visit(d, "repeat", [], undefined, { outcome: "no_show" });
    const measuring = i % 4 === 0 || (i === days.length - 1 && finished && d === end);
    const measures = measuring ? [M.pcl5(pcl(d)), M.phq9(phq(d)), ...(i % 8 === 0 || d === end ? [M.sci(sci(d))] : [])] : [];
    return visit(d, "repeat", measures, (c) => {
      const base = `Сесія ${c.visitNo} (${method.short}). ${step(steps, c.visitNo)}`;
      if (!measuring) return c.visitNo % 2 ? `${base} ${nightsLine(at(d))}` : base;
      const now = c.score("pcl5");
      return `${base}\nКонтрольний замір: PCL-5 — ${fmt(now)} (на початку — ${fmt(c.first("pcl5"))}), ${change(now, c.first("pcl5"), 10)}; PHQ-9 — ${fmt(c.score("phq9"))}.`;
    });
  });

  // через полтора месяца после курса — контрольный приём: прошедший или записанный
  const control = finished ? end + between(r, 38, 50) : null;
  if (control !== null && control <= 0) {
    visits.push(
      visit(control, "repeat", [M.pcl5(noisy(r, pclTo, 3, 0, 80)), M.phq9(noisy(r, phqTo, 1.5, 0, 27))], (c) =>
        `Контрольний огляд через півтора місяця після курсу. Стан стабільний: кошмари поодинокі, сон 6–7 год, ${g(p, "повернувся", "повернулася")} до звичного навантаження.\nPCL-5 — ${fmt(c.score("pcl5"))}, PHQ-9 — ${fmt(c.score("phq9"))}. Наступний огляд — через 3 місяці.`,
        { noteKind: "observation" },
      ),
    );
  } else if (control !== null && control <= 20) {
    visits.push(visit(control, "repeat", [], undefined));
  }

  const closeDay = finished ? end + between(r, 1, 3) : undefined;
  const lastPast = lastPastOf(visits, start);
  const nextMeasure = finished ? null : (days.find((d, i) => d > 0 && i % 4 === 0) ?? days.find((d) => d > 0) ?? null);
  // ВЛК после курса: ответ комиссии приходит через две-три недели
  const commission = finished && k === 7 ? end + 2 : null;

  return {
    ...NONE,
    episode: {
      openDay: start - between(r, 0, 3),
      reason: medic
        ? `${g(p, "Бойовий медик", "Бойова медикиня")}: після евакуації поранених під обстрілом — нав’язливі образи, безсоння, уникання.`
        : pick(r, [
            `${g(p, "Скерований", "Скерована")} командиром після виходу з позицій: нічні кошмари, спалахи гніву, сон 3–4 години.`,
            "Після мінометного обстрілу, у якому загинув побратим: нав’язливі спогади, уникання, безсоння.",
            `${g(p, "Переведений", "Переведена")} з хірургічного відділення після осколкового поранення: флешбеки, постійна настороженість.`,
            `${g(p, "Звернувся", "Звернулася")} сам${g(p, "", "а")} після ротації: кошмари, різка реакція на гучні звуки, ${g(p, "віддалився", "віддалилася")} від родини.`,
            "Скерування лікаря-психіатра на травмофокусовану психотерапію.",
          ]),
      ...(closeDay
        ? {
            closeDay,
            outcome: "improved" as const,
            outcomeText: (c: NoteContext) =>
              `Курс ${method.short} завершено: PCL-5 з ${fmt(c.first("pcl5"))} до ${fmt(c.score("pcl5"))}, нижче порогу ймовірного ПТСР. Рекомендовано контрольний огляд через 3 місяці.`,
          }
        : {}),
    },
    visits,
    decide: (c) =>
      c.critical
        ? PASSIVE_IDEATION
        : bandDecision(
            "Підтверджено на первинному прийомі: виражені симптоми ПТСР і депресії, гострого ризику немає. Взято на курс психотерапії.",
            "Пацієнт на курсі психотерапії, динаміка позитивна; контрольний замір за планом.",
          )(c),
    ...(v % 2 === 0
      ? {
          conclusion: {
            visit: 0,
            key: "pcl5",
            text: (c: NoteContext) =>
              [
                `Психодіагностичне обстеження ${c.date(days[0]!)}.`,
                "Методики: PCL-5, PHQ-9, SCI, LEC-5, CES.",
                `Результати: PCL-5 — ${banded(c.score("pcl5"), c.band("pcl5"))} (з 80); PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))} (з 27); SCI — ${banded(c.score("sci"), c.band("sci"))} (з 32); бойова експозиція за CES — ${banded(c.score("ces"), c.band("ces"))} (з 41). LEC-5: ${medic ? "бойові дії, тяжкі людські страждання й раптова насильницька смерть — як свідок і на службі" : "бойові дії, вибух, напад зі зброєю — особисто; раптова насильницька смерть — як свідок"}.`,
                "Висновок: виражені посттравматичні симптоми (повторне переживання, уникання, надмірна пильність) з депресивними проявами та порушенням сну. Результати узгоджуються з клінічною картиною ПТСР; діагноз встановлює лікар-психіатр.",
                `Рекомендовано: ${method.name}, ${method.sessions} сесій; консультація лікаря-психіатра; повторне обстеження через 4 тижні.`,
              ].join("\n"),
          },
        }
      : {}),
    referrals: [
      ...(k === 1
        ? [
            {
              day: start + 3,
              destination: "psychiatrist" as const,
              urgency: "routine" as const,
              status: "completed" as const,
              reason: "Консультація психіатра: верифікація діагнозу ПТСР, питання фармакотерапії безсоння.",
              outcomeNote: "Діагноз ПТСР підтверджено. Призначено сертралін 50 мг вранці; контроль через 4 тижні.",
              updatedDay: start + 6,
            },
          ]
        : []),
      ...(commission !== null
        ? [
            {
              day: commission,
              destination: "other" as const,
              urgency: "routine" as const,
              status: commission < -21 ? ("completed" as const) : ("accepted" as const),
              reason: "Військово-лікарська комісія: визначення придатності до служби після завершення курсу лікування.",
              ...(commission < -21 ? { outcomeNote: "Висновок комісії отримано; рекомендації враховано в плані спостереження.", updatedDay: commission + 18 } : {}),
            },
          ]
        : []),
    ],
    ...(finished && v % 3 === 0
      ? { dispensary: { groupLabel: "Динамічне спостереження після лікування ПТСР", intervalMonths: 3, lastSeenDay: lastPast, nextDueDay: lastPast + 91 } }
      : {}),
    ...(k === 2 && lastPast < -3
      ? {
          thread: [
            { day: lastPast + 2, minute: 19 * 60 + 40, fromPatient: true, text: "Добрий вечір. Цього тижня кошмарів не було жодного разу. Дякую.", read: true },
            { day: lastPast + 3, minute: 9 * 60 + 15, fromPatient: false, text: "Добрий день! Це важливий крок. Продовжуємо за планом, до зустрічі на наступному прийомі.", read: true },
          ],
        }
      : {}),
    /*
     * Следующий замер назначен на прошлом приёме; у выбывшего он просрочен —
     * повтор так и не сдан, и это видно в очереди работы.
     */
    pending: dropout
      ? [{ key: "pcl5", grantedDay: lastDayWith(visits, "pcl5") ?? lastPast, dueDay: Math.min(-1, (lastDayWith(visits, "pcl5") ?? lastPast) + 21) }]
      : nextMeasure !== null
        ? [
            { key: "pcl5", grantedDay: lastPast, dueDay: nextMeasure },
            { key: "phq9", grantedDay: lastPast, dueDay: nextMeasure },
          ]
        : control !== null && control > 0 && control <= 20
          ? [{ key: "pcl5", grantedDay: lastPast, dueDay: control }]
          : [],
  };
};

/* ─── ПТСР з повільною відповіддю ─── */

const SLOW_STEPS = (p: Person, alcohol: boolean) => [
  `Домашнє завдання не ${g(p, "виконав", "виконала")}: «не було сил». Уникає розмови про подію; обговорено мотивацію й темп роботи.`,
  "Біль у нозі після поранення посилює безсоння; узгоджено консультацію лікаря-реабілітолога.",
  alcohol
    ? "Алкоголь «щоб відключитися» 3–4 вечори на тиждень; пояснено зв’язок між випивкою й кошмарами, ціль — лише вихідні."
    : "Денна втома, дратівливість на службі; планування дня з паузами.",
  "Навички заземлення й стабілізації; експозицію відкладено до зниження уникання.",
  "Уперше говорить про загиблих побратимів без перерви; сльози, після — втома й полегшення.",
  "Узгоджено з психіатром корекцію терапії; обговорено очікування від лікування.",
  `Конфлікти в родині через спалахи гніву; план «тайм-ауту», розмова з ${spouse(p)} на наступному прийомі.`,
  "Повторне пояснення моделі ПТСР; спільно переглянуто цілі на наступний місяць.",
];

const ptsdSlow: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.ptsdSlow;
  const start = -between(r, 100, 170);
  const all = courseDays(r, start, 14, 14, 2);
  const dropout = k === 1;
  const crisisDay = k === 0 ? -2 : null;
  let days = trimFuture(all, dropout ? 0 : 2);
  if (dropout) days = days.filter((d) => d <= -2);
  /* загострення позавчора — позаплановий приём у той день; планові поруч з ним зсуваються */
  if (crisisDay !== null) days = [...days.filter((d) => d < crisisDay - 3 || d > 0), crisisDay].sort((a, b) => a - b);
  const pclFrom = between(r, 55, 66);
  const pclTo = pclFrom - between(r, 4, 9);
  const phqFrom = between(r, 13, 18);
  const at = (d: number) => (d - start) / Math.max(1, -start);
  const alcohol = k % 2 === 0;
  const steps = SLOW_STEPS(p, alcohol);

  const visits: Visit[] = days.map((d, i) => {
    if (i === 0) {
      return visit(
        d,
        "primary",
        [M.pcl5(pclFrom), M.phq9(phqFrom), ...(alcohol ? [M.auditc(between(r, 6, 9))] : []), M.lec5({ 10: [0], 2: [0], 7: [0], 13: [1], 14: [1], 15: [1] })],
        (c) =>
          [
            "Первинний прийом.",
            `Скарги: щоденні кошмари, відчуженість, спалахи гніву, сон 3–4 год${alcohol ? ", вживає алкоголь, «щоб заснути»" : ""}. Симптоми понад рік.`,
            `Психічний стан: ${STATUS_CALM(p)} Настрій знижений, дратівливий; афект напружений. Суїцидальні думки заперечує.`,
            `Обстеження: PCL-5 — ${banded(c.score("pcl5"), c.band("pcl5"))}; PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))}${alcohol ? `; AUDIT-C — ${fmt(c.score("auditc"))}` : ""}.`,
            "План: травмофокусована терапія раз на 2 тижні, консультація психіатра щодо фармакотерапії, контроль PCL-5 кожні 6 тижнів.",
          ].join("\n"),
        { reason: "Знову погано сплю, щоночі ті самі сни" },
      );
    }
    // у выбывающего — две неявки в конце, без записи на будущее
    if (dropout && i >= days.length - 2) return visit(d, "repeat", [], undefined, { outcome: "no_show" });
    const crisis = crisisDay !== null && d === crisisDay;
    const measuring = crisis || i % 3 === 0;
    const pclNow = crisis ? pclFrom + 1 : noisy(r, curve(pclFrom, pclTo, at(d)), 3, 0, 80);
    const phqNow = crisis ? 17 : noisy(r, curve(phqFrom, phqFrom - 3, at(d)), 1.5, 0, 27);
    const measures = measuring
      ? [M.pcl5(pclNow), M.phq9(phqNow, crisis ? 1 : 0), ...(alcohol && i % 6 === 0 ? [M.auditc(between(r, 4, 8))] : []), ...(crisis ? [M.cssrs({ wish: true, thoughts: false })] : [])]
      : [];
    return visit(
      d,
      "repeat",
      measures,
      (c) => {
        if (crisis) {
          return [
            "Позаплановий прийом. Після звістки про загибель побратима — погіршення: не спить третю ніч, думки «краще б мене не було».",
            `PHQ-9 — ${fmt(c.score("phq9"))}, п. 9 — «протягом декількох днів»; PCL-5 — ${fmt(c.score("pcl5"))}. C-SSRS: бажання смерті — так, думки про самогубство — ні.`,
            "Складено план безпеки, домовлено про щоденний контакт; скеровано до психіатра терміново.",
          ].join("\n");
        }
        const line = `Сесія ${c.visitNo}. ${step(steps, c.visitNo)} ${nightsLine(at(d) * 0.4, 6, 3)}`;
        return measuring
          ? `${line}\nКонтрольний замір: PCL-5 — ${fmt(c.score("pcl5"))} (на початку — ${fmt(c.first("pcl5"))}), ${change(c.score("pcl5"), c.first("pcl5"), 10)}; PHQ-9 — ${fmt(c.score("phq9"))}.`
          : line;
      },
      crisis ? { urgent: true } : {},
    );
  });

  const lastPast = lastPastOf(visits, start);
  return {
    ...NONE,
    episode: {
      openDay: start - 2,
      reason: pick(r, [
        "Повторне звернення: після першого курсу симптоми повернулися, вживає алкоголь, щоб заснути.",
        "Після року на передовій і загибелі кількох побратимів — щоденні кошмари, відчуженість, спалахи гніву.",
        `${g(p, "Переведений", "Переведена")} з іншого госпіталю для продовження лікування: ПТСР, хронічний біль після поранення.`,
      ]),
    },
    visits,
    ...(crisisDay !== null ? { openFrom: crisisDay } : {}),
    decide: (c) =>
      c.critical
        ? { outcome: "confirmed", note: "Підтверджено: загострення після втрати побратима, пасивні суїцидальні думки. План безпеки, щоденний контакт, психіатр — терміново." }
        : bandDecision(
            "Підтверджено: хронічні виражені симптоми ПТСР; гострого ризику немає. Продовжено терапію, скеровано до психіатра.",
            "Хронічний перебіг, відповідь на терапію повільна; гострого ризику немає. Узгоджено з психіатром.",
          )(c),
    ...(k === 3
      ? {
          conclusion: {
            visit: 0,
            key: "pcl5",
            text: (c: NoteContext) =>
              `Психодіагностичне обстеження ${c.date(days[0]!)}.\nМетодики: PCL-5, PHQ-9, LEC-5${alcohol ? ", AUDIT-C" : ""}.\nРезультати: PCL-5 — ${banded(c.score("pcl5"), c.band("pcl5"))} (з 80); PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))} (з 27).\nВисновок: хронічні посттравматичні симптоми високої вираженості з депресивними проявами; потребує поєднання психотерапії та фармакотерапії.\nРекомендовано: консультація психіатра, травмофокусована терапія, повторне обстеження через 6 тижнів.`,
          },
        }
      : {}),
    safetyPlans:
      crisisDay !== null
        ? [
            {
              day: crisisDay,
              content: safetyPlan(r, {
                signs: ["Третя ніч без сну", "Думки «краще б мене не було»", "Бажання випити, щоб «відключитися»", "Не відповідаю на дзвінки"],
                reasons: ["Син", "Обіцянка побратимам жити далі", "Батьки"],
                weapon: p.unit !== "Ветеран",
                people: [[g(p, "Дружина", "Чоловік"), contactPhone(r)], ["Побратим Олексій", contactPhone(r)]],
              }),
            },
          ]
        : [],
    referrals: [
      ...(crisisDay !== null
        ? [{ day: crisisDay, destination: "psychiatrist" as const, urgency: "urgent" as const, status: "accepted" as const, reason: "Погіршення після втрати побратима, пасивні суїцидальні думки: огляд психіатра, корекція терапії." }]
        : []),
      ...(k === 2
        ? [{
            day: start + 20,
            destination: "psychiatrist" as const,
            urgency: "routine" as const,
            status: "completed" as const,
            reason: "Хронічний ПТСР, недостатня відповідь на психотерапію: питання фармакотерапії.",
            outcomeNote: "Сертралін збільшено до 100 мг, додано празозин на ніч від кошмарів.",
            updatedDay: start + 27,
          }]
        : []),
    ],
    ...(k === 4 && lastPast < -3
      ? { thread: [{ day: -2, minute: 21 * 60 + 5, fromPatient: true, text: "Знову погано сплю, кошмари щоночі. Можна раніше на прийом?", read: false }] }
      : {}),
    /* у выбывшего повтор так и остался несданным — просрочка видна в очереди работы */
    pending: dropout
      ? [{ key: "pcl5", grantedDay: lastDayWith(visits, "pcl5") ?? lastPast, dueDay: Math.min(-1, (lastDayWith(visits, "pcl5") ?? lastPast) + 28) }]
      : [{ key: "pcl5", grantedDay: lastPast, dueDay: lastPast + 42 }],
  };
};

/* ─── депресивний епізод, часткова відповідь ─── */

const DEPR_STEPS = (p: Person) => [
  "Поведінкова активація: щоденник активностей, план — 3 приємні й 2 обов’язкові справи на тиждень.",
  "Виконано 3 з 5 запланованих справ; настрій «трохи кращий вранці». Розібрано, що заважало.",
  "Когнітивна реструктуризація думки «Я тягар для родини»; альтернативи формулює з підтримкою.",
  `Приймає сертралін третій тиждень, переносить добре; сон до 6 год, ${g(p, "почав", "почала")} виходити на прогулянки.`,
  "Робота з руминаціями: «час для роздумів» 15 хв, переключення на дію.",
  "Розширення активностей: зустріч із другом, спортзал двічі на тиждень.",
  "Ангедонія зберігається вечорами; додано заплановані приємні справи після служби.",
  "Робота із самокритикою: лист собі від імені друга.",
  "Профілактика рецидиву: ранні ознаки погіршення, план дій, контакти.",
  "Підтримувальна сесія: настрій нестабільний, але без глибоких спадів; план продовжено.",
];

const depression: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.depression;
  const start = -between(r, 40, 160);
  /* курс завершили двоє; решта лікуються досі — раз на два тижні аж до сьогодні */
  const closing = k === 7 || k === 8;
  const all = courseDays(r, start, 14, closing ? 10 : Math.ceil((20 - start) / 14) + 1, 2);
  const days = trimFuture(all);
  const end = all[all.length - 1]!;
  const finished = closing && end < -14;
  const phqFrom = between(r, 16, 21);
  const phqTo = between(r, 9, 13);
  const whoFrom = between(r, 4, 8);
  const whoTo = between(r, 10, 14);
  const gadFrom = between(r, 10, 14);
  const at = (d: number) => (d - start) / Math.max(1, Math.min(end, 0) - start || 1);
  /* у одного — погіршення позавчора: позачерговий прийом, випадок ще на розгляді */
  const worse = k === 0 ? -2 : null;
  const passive = k === 5;
  const usedDays = finished
    ? days.filter((d) => d <= end)
    : worse !== null
      ? [...days.filter((d) => d < worse - 4 || d > 1), worse].sort((a, b) => a - b)
      : days;
  const steps = DEPR_STEPS(p);

  const visits: Visit[] = usedDays.map((d, i) => {
    if (i === 0) {
      return visit(
        d,
        "primary",
        [M.phq9(phqFrom, passive ? 1 : 0), M.gad7(gadFrom), M.who5(whoFrom), ...(passive ? [M.cssrs({ wish: true, thoughts: false })] : [])],
        (c) =>
          [
            "Первинний прийом.",
            `Скарги: пригнічений настрій більшу частину дня, втрата інтересу, раннє пробудження о 4–5 год, зниження апетиту, втома. Триває ${between(r, 6, 14)} тижнів.`,
            `Психічний стан: ${STATUS_CALM(p)} Настрій знижений, мовлення тихе, уповільнене. ${passive ? "Пасивні думки «краще б не прокидатися» без наміру (C-SSRS)." : "Суїцидальні думки заперечує."}`,
            `Обстеження: PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))}; GAD-7 — ${banded(c.score("gad7"), c.band("gad7"))}; WHO-5 — ${fmt(c.score("who5"))} з 25.`,
            "План: поведінкова активація й когнітивна терапія раз на 2 тижні; консультація психіатра щодо антидепресанту; контроль PHQ-9 і WHO-5 щомісяця.",
          ].join("\n"),
        { reason: pick(r, ["Нічого не хочеться, прокидаюся о четвертій і лежу", "Все байдуже, навіть діти не радують", "Немає сил ні на що"]) },
      );
    }
    const measuring = d === worse || i % 2 === 0;
    const phqNow = d === worse ? 16 : noisy(r, curve(phqFrom, phqTo, at(d), 1.6), 1.5, 0, 27);
    const whoNow = d === worse ? 6 : noisy(r, curve(whoFrom, whoTo, at(d), 1.6), 1.5, 0, 25);
    const measures = measuring ? [M.phq9(phqNow), M.who5(whoNow), ...(i === 4 ? [M.gad7(noisy(r, gadFrom - 4, 1.5, 0, 21))] : [])] : [];
    return visit(d, "repeat", measures, (c) => {
      if (d === worse) {
        return `Позачерговий прийом. Погіршення після конфлікту в родині: PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))}, WHO-5 — ${fmt(c.score("who5"))} з 25. П. 9 — 0, суїцидальні думки заперечує. Наступний прийом — за 2 дні, психіатра поінформовано.`;
      }
      const line = `Сесія ${c.visitNo}. ${step(steps, c.visitNo)}`;
      return measuring
        ? `${line}\nКонтрольний замір: PHQ-9 — ${fmt(c.score("phq9"))} (на початку — ${fmt(c.first("phq9"))}), ${change(c.score("phq9"), c.first("phq9"), 6)}; WHO-5 — ${fmt(c.score("who5"))} з 25.`
        : line;
    });
  });

  const lastPast = lastPastOf(visits, start);
  const next = usedDays.find((d) => d > 0);
  return {
    ...NONE,
    episode: {
      openDay: start - between(r, 1, 4),
      reason: pick(r, [
        "Пригнічений настрій, втрата інтересу, раннє пробудження після повернення з ротації.",
        "Скерування терапевта: апатія, втома, думки про власну непотрібність.",
        "Після розлучення під час служби — пригніченість понад два місяці, втрата ваги на 6 кг.",
        `${g(p, "Звернувся", "Звернулася")} сам${g(p, "", "а")}: плаксивість, не може зосередитися на службі, «все байдуже».`,
      ]),
      ...(finished
        ? {
            closeDay: end + 3,
            outcome: k === 7 ? ("referred" as const) : ("improved" as const),
            outcomeText: (c: NoteContext) =>
              k === 7
                ? `Передано під спостереження психіатра поліклініки за місцем служби: PHQ-9 з ${fmt(c.first("phq9"))} до ${fmt(c.score("phq9"))}, підтримувальна терапія триває.`
                : `Стан покращився: PHQ-9 з ${fmt(c.first("phq9"))} до ${fmt(c.score("phq9"))}, WHO-5 — ${fmt(c.score("who5"))} з 25. Курс завершено.`,
          }
        : {}),
    },
    visits,
    ...(worse !== null ? { openFrom: worse } : {}),
    decide: (c) =>
      c.critical
        ? PASSIVE_IDEATION
        : bandDecision(
            "Підтверджено на прийомі: депресивна симптоматика, гострого ризику немає. Психотерапія, консультація психіатра.",
            "Відповідь на лікування часткова, гострого ризику немає; обговорено з психіатром корекцію терапії.",
          )(c),
    ...(k % 3 === 1
      ? {
          conclusion: {
            visit: 0,
            key: "phq9",
            text: (c: NoteContext) =>
              [
                `Психодіагностичне обстеження ${c.date(days[0]!)}.`,
                "Методики: PHQ-9, GAD-7, WHO-5.",
                `Результати: PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))} (з 27); GAD-7 — ${banded(c.score("gad7"), c.band("gad7"))} (з 21); WHO-5 — ${banded(c.score("who5"), c.band("who5"))} (з 25).`,
                "Висновок: виражена депресивна симптоматика (знижений настрій, ангедонія, порушення сну й апетиту) з тривожним компонентом; суттєво знижене благополуччя.",
                "Рекомендовано: психотерапія (поведінкова активація, КПТ), консультація психіатра щодо антидепресанту, контроль через 4 тижні.",
              ].join("\n"),
          },
        }
      : {}),
    safetyPlans: passive
      ? [{
          day: usedDays[0]!,
          content: safetyPlan(r, {
            signs: ["Думки «краще б не прокидатися»", "Перестаю відповідати на повідомлення", "Лежу весь день, не виходжу з кімнати"],
            reasons: ["Донька", "Мама", "Пес Бакс, якого нема на кого лишити"],
            weapon: false,
            people: [["Сестра", contactPhone(r)], [g(p, "Друг Олег", "Подруга Оксана"), contactPhone(r)]],
          }),
        }]
      : [],
    referrals: [
      ...(k % 3 === 0 && k !== 9
        ? [{
            day: start + 10,
            destination: "psychiatrist" as const,
            urgency: "routine" as const,
            status: "completed" as const,
            reason: "Депресивний епізод, недостатня відповідь на психотерапію: питання антидепресанту.",
            outcomeNote: "Депресивний епізод помірного ступеня. Сертралін 50 мг, контроль через 4 тижні.",
            updatedDay: start + 16,
          }]
        : []),
      // відповідь ще не надійшла — свіже направлення, а не забуте
      ...(k === 9 ? [{ day: Math.max(start + 10, -6), destination: "psychiatrist" as const, urgency: "routine" as const, status: "accepted" as const, reason: "Часткова відповідь на терапію: питання корекції антидепресанту." }] : []),
    ],
    ...(k === 2 && lastPast < -6
      ? {
          thread: [
            { day: lastPast + 3, minute: 8 * 60 + 20, fromPatient: true, text: "Від нових ліків трохи нудить зранку. Це мине?", read: true },
            { day: lastPast + 3, minute: 11 * 60 + 5, fromPatient: false, text: "Так, у перші 1–2 тижні це буває часто. Приймайте після сніданку; обговоримо на прийомі.", read: true },
          ],
        }
      : {}),
    pending: finished || next === undefined ? [] : [{ key: "phq9", grantedDay: lastPast, dueDay: next }, { key: "who5", grantedDay: lastPast, dueDay: next }],
  };
};

/* ─── розлад адаптації, що минає ─── */

const ADJ_STEPS = (p: Person) => [
  "Навички саморегуляції: дихання 4–6, прогресивна м’язова релаксація. Сон покращився до 6–7 год.",
  "Розв’язання проблем: розмова з командиром про графік, план зв’язку з родиною. Напруження менше.",
  `Підтримка, нормалізація реакцій на зміни; ${g(p, "знайшов", "знайшла")} спільну мову з новим підрозділом.`,
  "Закріплення навичок, план на випадок нових стресових подій.",
];

const adjustment: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.adjustment;
  const start = -between(r, 10, 120);
  const count = between(r, 3, 5);
  const all = courseDays(r, start, 7, count, 1);
  const days = trimFuture(all);
  const end = all[all.length - 1]!;
  const finished = end < -5;
  const k10From = between(r, 22, 29);
  const k10To = between(r, 13, 18);
  const pssFrom = between(r, 20, 27);
  const pssTo = between(r, 10, 16);
  const t = (d: number) => (d - start) / Math.max(1, end - start);
  const trigger = pick(r, [
    { reason: "Після мобілізації важко адаптуватися: тривога, порушення сну, конфлікти в підрозділі.", what: "мобілізації" },
    { reason: "Після поранення й тривалого лікування — страх повернення до служби, напруження.", what: "поранення й лікування" },
    { reason: "Переведення до іншого підрозділу, розлука з родиною: напруження, плаксивість.", what: "переведення до іншого підрозділу" },
    { reason: "Після розформування підрозділу й загибелі командира — розгубленість, безсоння.", what: "розформування підрозділу" },
    { reason: `${g(p, "Дружина подала", "Чоловік подав")} на розлучення під час служби: дратівливість, не може зосередитися.`, what: "розриву в родині" },
  ]);
  const rescheduled = k === 3 ? 1 : -1;
  const steps = ADJ_STEPS(p);

  const visits: Visit[] = [];
  days.forEach((d, i) => {
    if (i === rescheduled && d < -3) {
      visits.push(visit(d, "repeat", [], undefined, { outcome: "cancelled" }));
      d += 2;
    }
    const last = finished && d === end;
    if (i === 0) {
      visits.push(
        visit(
          d,
          "primary",
          [M.k10(k10From), M.pss10(pssFrom)],
          (c) =>
            [
              "Первинна консультація.",
              `Скарги: напруження, тривога за родину, сон 5 год, дратівливість упродовж ${between(r, 2, 6)} тижнів після ${trigger.what}.`,
              `Психічний стан: ${STATUS_CALM(p)} Емоційно ${g(p, "лабільний", "лабільна")}, критичність збережена. Суїцидальні думки заперечує.`,
              `Обстеження: K10 — ${banded(c.score("k10"), c.band("k10"))}; PSS-10 — ${fmt(c.score("pss10"))} з 40.`,
              "Оцінка: реакція на стрес, порушення адаптації. План: 3–4 консультації — саморегуляція, розв’язання проблем, підтримка.",
            ].join("\n"),
          { reason: pick(r, [`Не можу звикнути, весь час ${g(p, "напружений", "напружена")}`, "Погано сплю, думаю про родину", "Зриваюся на всіх"]), noteKind: "intake" },
        ),
      );
      return;
    }
    const measures = last || i === 2 ? [M.k10(noisy(r, curve(k10From, k10To, t(d)), 1.5, 10, 50)), M.pss10(noisy(r, curve(pssFrom, pssTo, t(d)), 2, 0, 40))] : [];
    visits.push(
      visit(
        d,
        "repeat",
        measures,
        (c) =>
          last
            ? `Завершальна консультація. K10 — ${banded(c.score("k10"), c.band("k10"))} (на початку — ${fmt(c.first("k10"))}); PSS-10 — ${fmt(c.score("pss10"))}. Стан стабілізувався, ${g(p, "повернувся", "повернулася")} до звичного ритму служби. Рекомендовано звертатися за потреби.`
            : `Консультація ${c.visitNo}. ${step(steps, c.visitNo)}${measures.length ? `\nK10 — ${fmt(c.score("k10"))} (на початку — ${fmt(c.first("k10"))}).` : ""}`,
        { noteKind: "consult" },
      ),
    );
  });

  const lastPast = lastPastOf(visits, start);
  return {
    ...NONE,
    episode: {
      openDay: start - between(r, 0, 2),
      reason: trigger.reason,
      ...(finished
        ? {
            closeDay: end + 1,
            outcome: "improved" as const,
            outcomeText: (c: NoteContext) => `Стан стабілізувався: K10 з ${fmt(c.first("k10"))} до ${fmt(c.score("k10"))}. Консультації завершено.`,
          }
        : {}),
    },
    visits,
    decide: bandDecision("Підтверджено: виражений дистрес на тлі стресової події, гострого ризику немає. Консультації за планом."),
    ...(k % 4 === 0
      ? {
          conclusion: {
            visit: 0,
            key: "k10",
            text: (c: NoteContext) =>
              `Психологічне обстеження ${c.date(days[0]!)}.\nМетодики: K10, PSS-10.\nРезультати: K10 — ${banded(c.score("k10"), c.band("k10"))} (з 50); PSS-10 — ${fmt(c.score("pss10"))} з 40.\nВисновок: реакція на стрес у зв’язку зі зміною обставин служби; ознак психотичних і тяжких афективних розладів немає.\nРекомендовано: 3–4 консультації психолога, контроль K10 після курсу.`,
          },
        }
      : {}),
    referrals:
      k === 10
        ? [{
            day: start + 2,
            destination: "commander",
            urgency: "routine",
            status: "completed",
            reason: "Рекомендації командиру: адаптаційний період, без нарядів з озброєнням 2 тижні.",
            outcomeNote: "Командира поінформовано, рекомендації враховано.",
            updatedDay: start + 4,
          }]
        : [],
    ...(k === 6 && !finished && lastPast < -3
      ? {
          thread: [
            { day: lastPast + 1, minute: 18 * 60 + 30, fromPatient: true, text: "Чи можна перенести прийом? Ставлять у наряд саме того дня.", read: true },
            { day: lastPast + 2, minute: 9 * 60 + 10, fromPatient: false, text: "Так, перенесено на наступний тиждень, той самий час. Якщо не вийде — напишіть.", read: true },
          ],
        }
      : {}),
  };
};

/* ─── шкідливе вживання алкоголю ─── */

const ALC_STEPS = (p: Person) => [
  "Мотиваційне інтерв’ю: «за» і «проти» змін, ціль — тверезість на 3 місяці.",
  "Тригери вживання: безсоння, самотність увечері, зустрічі з товаришами по службі; план альтернатив.",
  "Навички відмови в компанії; рольова гра.",
  "Сон без алкоголю 5–6 год; рекомендації з гігієни сну.",
  "Відвідує групу підтримки; потяг увечері слабший.",
  `Розмова з ${spouse(p)} про план тверезості відбулася; домовилися про спільні вечори без алкоголю.`,
  "Профілактика зриву: ранні ознаки, кому дзвонити.",
  "Підтримувальна сесія; план на найближчі свята.",
];

/** «Без алкоголю 5 тижнів» — тиждень, тижні, тижнів */
const soberLine = (weeks: number) => `Без алкоголю ${weeks} ${pl(weeks, "тиждень", "тижні", "тижнів")}.`;

const alcohol: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.alcohol;
  const reasons = [
    `${g(p, "Скерований", "Скерована")} командиром після дисциплінарного порушення у стані сп’яніння.`,
    `Після повернення з передової щодня вживає алкоголь, «щоб заснути»; ${g(p, "дружина наполягла", "чоловік наполіг")} на зверненні.`,
    "Конфлікти в підрозділі через вживання; попередження від командира.",
  ];
  if (k === 0 || k === 1) {
    // відміна в стаціонарі: зараз (0) і два місяці тому (1)
    const day0 = k === 0 ? -2 : -between(r, 55, 70);
    const ciwa = k === 0 ? [14, 11] : [13, 7, 3];
    const visits: Visit[] = ciwa.map((score, i) =>
      visit(
        day0 + (i === 2 ? 3 : i),
        i === 0 ? "primary" : "repeat",
        [M.ciwa(score), ...(i === 1 ? [M.audit(between(r, 21, 26)), M.phq9(between(r, 9, 12))] : [])],
        (c) =>
          i === 0
            ? [
                `${g(p, "Госпіталізований", "Госпіталізована")} з ознаками синдрому відміни алкоголю. Вживання щоденне ${between(r, 4, 10)} міс., остання доза — напередодні.`,
                `Тремор, пітливість, тривожність, порушення сну. CIWA-Ar — ${banded(c.score("ciwaar"), c.band("ciwaar"))}.`,
                "Узгоджено з черговим лікарем: спостереження кожні 4 години, медикаментозна підтримка.",
              ].join("\n")
            : i === 1
              ? `CIWA-Ar — ${fmt(c.score("ciwaar"))}: ознаки відміни зменшуються. AUDIT — ${banded(c.score("audit"), c.band("audit"))}; PHQ-9 — ${fmt(c.score("phq9"))}. Мотиваційне інтерв’ю: визнає проблему, ${g(p, "згоден", "згодна")} на лікування.`
              : `CIWA-Ar — ${fmt(c.score("ciwaar"))}: синдром відміни минув. Обговорено план тверезості, тригери (безсоння, самотність увечері), група підтримки.`,
        i === 0 ? { reason: "Трусить, не сплю, хочу кинути пити", urgent: true } : {},
      ),
    );
    if (k === 1) {
      const auditc = [between(r, 5, 7), between(r, 3, 5), between(r, 2, 3)];
      courseDays(r, day0 + 14, 14, 4, 2).forEach((d, i) => {
        if (d > 0) return;
        visits.push(
          visit(d, "repeat", i % 2 === 0 ? [M.auditc(auditc[Math.min(2, i / 2)]!)] : [], (c) =>
            `Сесія ${c.visitNo}. ${soberLine(Math.round((d - day0) / 7))} ${step(ALC_STEPS(p), c.visitNo - 2)}${c.score("auditc") !== null ? `\nAUDIT-C — ${fmt(c.score("auditc"))} (на старті AUDIT — ${fmt(c.first("audit"))}).` : ""}`,
          ),
        );
      });
    }
    const lastPast = lastPastOf(visits, day0);
    return {
      ...NONE,
      episode: { openDay: day0, reason: `${g(p, "Госпіталізований", "Госпіталізована")} з ознаками синдрому відміни алкоголю.` },
      visits: [...visits, visit(k === 0 ? 1 : between(r, 3, 12), "repeat", [], undefined)],
      ...(k === 0 ? { openFrom: day0 } : {}),
      decide: (c) =>
        c.first
          ? { outcome: "confirmed", note: "Підтверджено: синдром відміни алкоголю. Спостереження чергового лікаря, медикаментозна підтримка." }
          : { outcome: "needs_followup", note: "Синдром відміни зменшується; спостереження продовжено." },
      ...(k === 1
        ? {
            conclusion: {
              visit: 1,
              key: "audit",
              text: (c: NoteContext) =>
                `Психологічне обстеження ${c.date(day0 + 1)}.\nМетодики: AUDIT, PHQ-9, CIWA-Ar (у динаміці).\nРезультати: AUDIT — ${banded(c.score("audit"), c.band("audit"))} (з 40); PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))}.\nВисновок: ознаки залежності від алкоголю із синдромом відміни; депресивна симптоматика.\nРекомендовано: лікування в лікаря-психіатра (нарколога), мотиваційне консультування, група підтримки, AUDIT-C щомісяця.`,
            },
          }
        : {}),
      referrals: [{
        day: day0 + 1,
        destination: "psychiatrist",
        urgency: "routine",
        status: k === 0 ? "accepted" : "completed",
        reason: "Консультація лікаря-психіатра (нарколога): ймовірна залежність від алкоголю, синдром відміни.",
        ...(k === 0 ? {} : { outcomeNote: "Підтверджено залежність від алкоголю. Призначено налтрексон, спостереження нарколога.", updatedDay: day0 + 4 }),
      }],
      pending: k === 1 ? [{ key: "auditc", grantedDay: lastPast, dueDay: lastPast + 28 }] : [],
    };
  }

  const start = -between(r, 45, 140);
  const dropout = k === 2;
  const all = courseDays(r, start, 10, dropout ? 4 : 9, 2);
  const days = trimFuture(all);
  const end = all[all.length - 1]!;
  const finished = !dropout && end < -5;
  const auditFrom = between(r, 16, 22);
  const cFrom = between(r, 8, 10);
  const cTo = between(r, 2, 4);
  const relapse = k === 4 ? 4 : -1;
  const steps = ALC_STEPS(p);
  const visits: Visit[] = days.map((d, i) => {
    if (i === 0) {
      return visit(
        d,
        "primary",
        [M.audit(auditFrom), M.phq9(between(r, 6, 11))],
        (c) =>
          [
            "Первинний прийом.",
            `Вживає алкоголь ${pick(r, ["щодня", "4–5 вечорів на тиждень"])} ${between(r, 3, 12)} міс., до 6–8 стандартних порцій, «щоб заснути й не думати». Епізоди провалів у пам’яті.`,
            `Психічний стан: ${STATUS_CALM(p)} Критичність до вживання часткова. Суїцидальні думки заперечує.`,
            `Обстеження: AUDIT — ${banded(c.score("audit"), c.band("audit"))}; PHQ-9 — ${fmt(c.score("phq9"))}.`,
            "План: мотиваційне інтерв’ю, консультація психіатра-нарколога, AUDIT-C щомісяця.",
          ].join("\n"),
        { reason: "Командир сказав прийти, але й сам розумію, що забагато п’ю" },
      );
    }
    if (dropout && i >= 2) return visit(d, "repeat", [], undefined, { outcome: "no_show" });
    const measuring = i % 3 === 0 || (finished && d === end);
    const now = i === relapse ? cFrom - 1 : noisy(r, curve(cFrom, cTo, i / Math.max(1, all.length - 1)), 1, 0, 12);
    const weeks = Math.round((d - start) / 7);
    return visit(d, "repeat", measuring || i === relapse ? [M.auditc(now)] : [], (c) => {
      if (i === relapse) return `Сесія ${c.visitNo}. Зрив на вихідних після конфлікту в родині. Розбір ситуації без осуду, план на наступний раз. AUDIT-C — ${fmt(c.score("auditc"))}.`;
      const line = `Сесія ${c.visitNo}. ${i > relapse && relapse > 0 ? "Після зриву — знову без алкоголю." : soberLine(weeks)} ${step(steps, c.visitNo)}`;
      return measuring ? `${line}\nAUDIT-C — ${fmt(c.score("auditc"))} (на старті AUDIT — ${fmt(c.first("audit"))}).` : line;
    });
  });
  const lastPast = lastPastOf(visits, start);
  const next = days.find((d) => d > 0);
  const dropDay = (all[3] ?? start + 30) + 10;
  return {
    ...NONE,
    episode: {
      openDay: start - 1,
      reason: pick(r, reasons),
      ...(dropout && dropDay < 0
        ? {
            closeDay: dropDay,
            outcome: "dropped" as const,
            outcomeText: () => `${g(p, "Перестав", "Перестала")} відвідувати після двох зустрічей, на дзвінки не відповідає. Командира поінформовано про рекомендації.`,
          }
        : finished
          ? {
              closeDay: end + 2,
              outcome: "improved" as const,
              outcomeText: (c: NoteContext) => `Курс завершено: AUDIT-C — ${fmt(c.score("auditc"))} (на старті AUDIT — ${fmt(c.first("audit"))}), тверезість утримує. Підтримувальні зустрічі за потреби.`,
            }
          : {}),
    },
    visits,
    decide: bandDecision("Підтверджено: шкідливе вживання алкоголю, гострого ризику немає. Мотиваційне консультування, консультація нарколога."),
    ...(k === 4
      ? {
          conclusion: {
            visit: 0,
            key: "audit",
            text: (c: NoteContext) =>
              `Психологічне обстеження ${c.date(days[0]!)}.\nМетодики: AUDIT, PHQ-9.\nРезультати: AUDIT — ${banded(c.score("audit"), c.band("audit"))} (з 40); PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))} (з 27).\nВисновок: шкідливе вживання алкоголю як спосіб упоратися з безсонням і напруженням; мотивація до змін — помірна.\nРекомендовано: мотиваційне консультування, консультація лікаря-психіатра (нарколога), контроль AUDIT-C щомісяця.`,
          },
        }
      : {}),
    referrals: dropout
      ? [{ day: start + 25, destination: "commander", urgency: "routine", status: "completed", reason: "Поінформувати командира: пропускає консультації, рекомендовано контроль і повторне скерування.", outcomeNote: "Командира поінформовано.", updatedDay: start + 27 }]
      : k === 3
        ? [{ day: start + 4, destination: "psychiatrist", urgency: "routine", status: "completed", reason: "Консультація лікаря-психіатра (нарколога): шкідливе вживання алкоголю.", outcomeNote: "Шкідливе вживання без ознак залежності. Рекомендовано психотерапію, медикаментозного лікування не потребує.", updatedDay: start + 9 }]
        : [],
    ...(k === 5 && !finished && lastPast < -2
      ? { thread: [{ day: -1, minute: 20 * 60 + 45, fromPatient: true, text: `Тримаюся вже п’ятий тиждень. На вихідних було важко, але не ${g(p, "зірвався", "зірвалася")}.`, read: false }] }
      : {}),
    pending: dropout || finished || next === undefined ? [] : [{ key: "auditc", grantedDay: lastPast, dueDay: next }],
  };
};

/* ─── порушення сну ─── */

const insomnia: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.insomnia;
  const start = -between(r, 20, 120);
  const all = courseDays(r, start, 7, 5, 1);
  const days = trimFuture(all);
  const end = all[all.length - 1]!;
  const finished = end < -5;
  const sciFrom = between(r, 6, 12);
  const sciTo = between(r, 18, 25);
  const fasFrom = between(r, 28, 38);
  const tbi = k === 2;
  const t = (d: number) => (d - start) / Math.max(1, end - start);
  const visits: Visit[] = days.map((d, i) => {
    const efficiency = Math.round(curve(64, 88, t(d)));
    if (i === 0) {
      return visit(
        d,
        "primary",
        [M.sci(sciFrom), M.ris(between(r, 17, 25)), M.fas(fasFrom)],
        (c) =>
          [
            "Первинний прийом.",
            `Скарги: засинання 60–90 хв, ${between(r, 2, 4)} нічні пробудження, раннє пробудження, денна втома${tbi ? ", головний біль після контузії" : ""}. Кава 5–6 чашок на день, телефон у ліжку.`,
            `Психічний стан: ${STATUS_CALM(p)} ${g(p, "Втомлений", "Втомлена")}, фон настрою рівний. Суїцидальні думки заперечує.`,
            `Обстеження: SCI — ${banded(c.score("sci"), c.band("sci"))}; RIS — ${fmt(c.score("ris"))}; FAS — ${banded(c.score("fas"), c.band("fas"))}.`,
            "План: КПТ-І, 5 сесій — щоденник сну, обмеження часу в ліжку, контроль стимулів, гігієна сну.",
          ].join("\n"),
        { reason: pick(r, ["Не можу заснути годинами", "Прокидаюся о третій і більше не сплю", "Збився сон після нічних чергувань"]) },
      );
    }
    const last = finished && d === end;
    const measures = i === 2 ? [M.sci(noisy(r, curve(sciFrom, sciTo, t(d)), 2, 0, 32))] : last ? [M.sci(sciTo), M.ris(between(r, 7, 12)), M.fas(between(r, 18, 25))] : [];
    return visit(d, "repeat", measures, (c) => {
      if (last) {
        return `Завершення КПТ-І. SCI — ${banded(c.score("sci"), c.band("sci"))} (на початку — ${fmt(c.first("sci"))}); FAS — ${fmt(c.score("fas"))}. Ефективність сну ${efficiency} %. Рекомендації щодо підтримання режиму.`;
      }
      const body = [
        `щоденник сну — ефективність ${efficiency} %. Вікно сну 00:30–06:30; контроль стимулів: у ліжку лише сон.`,
        `ефективність сну ${efficiency} %, засинання 30–40 хв; вікно сну розширено на 15 хв, кава — до 14:00.`,
        `робота з думками про сон («якщо не посплю — завалю службу»); ефективність сну ${efficiency} %.`,
        `ефективність сну ${efficiency} %, засинання 15–20 хв; вікно сну 23:45–06:30.`,
      ][Math.min(3, c.visitNo - 2)]!;
      return `КПТ-І, сесія ${c.visitNo}: ${body}${measures.length ? ` SCI — ${fmt(c.score("sci"))}.` : ""}`;
    });
  });
  const lastPast = lastPastOf(visits, start);
  return {
    ...NONE,
    episode: {
      openDay: start - between(r, 0, 2),
      reason: tbi
        ? "Після контузії — порушення сну й головний біль, денна втома."
        : pick(r, [
            "Безсоння понад 3 місяці: засинає за 1,5–2 години, прокидається 3–4 рази за ніч.",
            "Після нічних чергувань збитий режим сну, денна втома, помилки на службі.",
            "Прокидається о 3-й і більше не засинає; вдень сонливість.",
          ]),
      ...(finished
        ? { closeDay: end + 2, outcome: "improved" as const, outcomeText: (c: NoteContext) => `КПТ-І завершено: SCI з ${fmt(c.first("sci"))} до ${fmt(c.score("sci"))}, поріг безсоння не досягнуто.` }
        : {}),
    },
    visits,
    decide: bandDecision("Підтверджено: виснаження на тлі хронічного безсоння, гострого ризику немає. КПТ-І за планом."),
    ...(k % 3 === 0
      ? {
          conclusion: {
            visit: 0,
            key: "sci",
            text: (c: NoteContext) =>
              `Психологічне обстеження ${c.date(days[0]!)}.\nМетодики: SCI, RIS, FAS.\nРезультати: SCI — ${banded(c.score("sci"), c.band("sci"))} (з 32); RIS — ${banded(c.score("ris"), c.band("ris"))} (з 40); FAS — ${banded(c.score("fas"), c.band("fas"))} (з 50).\nВисновок: хронічне безсоння з вираженою денною втомою; ознаки психофізіологічної інсомнії.\nРекомендовано: когнітивно-поведінкова терапія безсоння (5 сесій), гігієна сну, контроль SCI після курсу.`,
          },
        }
      : {}),
    referrals: tbi
      ? [{ day: start + 2, destination: "other", urgency: "routine", status: "completed", reason: "Консультація невролога: головний біль і порушення сну після контузії.", outcomeNote: "Органічної патології не виявлено, МРТ без особливостей. Рекомендовано продовжити КПТ-І.", updatedDay: start + 9 }]
      : [],
    ...(k === 4 && !finished
      ? { thread: [{ day: -1, minute: 7 * 60 + 50, fromPatient: true, text: "Надсилаю щоденник сну за тиждень: засинаю швидше, але о п’ятій прокидаюся.", read: false }] }
      : {}),
    pending: finished ? [] : [{ key: "sci", grantedDay: lastPast, dueDay: days.find((d) => d > 0) ?? lastPast + 7 }],
  };
};

/* ─── моральна травма ─── */

const MORAL_STEPS = (p: Person) => [
  "Психоосвіта: моральна травма — не слабкість, а реакція на порушення власних цінностей.",
  `Розмежування відповідальності й провини, «тест справедливого суду». Уперше ${g(p, "розповів", "розповіла")} про подію повністю.`,
  "Тема сорому й страху осуду з боку родини; план розмови з близькими.",
  "Лист до загиблого побратима, прочитано на сесії; після — полегшення.",
  "Цінності, які не зруйновано: турбота про своїх, чесність; як вони проявляються зараз.",
  "Гнів на командування; розмежування гніву й зневіри, що з цим робити.",
  `Розмова з ${spouse(p)} про подію відбулася; реакція підтримувальна.`,
  "Зустріч із капеланом госпіталю за власним бажанням; тема прощення себе.",
  "Відновлювальні дії: допомога родині загиблого, волонтерство.",
  "Уявна розмова з побратимом, якому довіряє, — «моральним свідком».",
  "Підсумки: провину змінила відповідальність за те, як жити далі; план підтримки.",
];

const moralInjury: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.moralInjury;
  const start = -between(r, 50, 140);
  const all = courseDays(r, start, 7, 12, 1);
  const days = trimFuture(all);
  const end = all[all.length - 1]!;
  /* тип досвіду MIOS (п. 2): 0 — власні дії чи бездіяльність, 1 — дії інших, 2 — зрада */
  const story = [
    { reason: `Після бою, у якому за ${g(p, "його", "її")} наказом загинули двоє підлеглих, — провина, сором, відчуженість.`, event: "загибель підлеглих після наказу", kinds: [0] },
    { reason: `${g(p, "Не зміг", "Не змогла")} евакуювати пораненого побратима: самозвинувачення, безсоння, уникає родини загиблого.`, event: "смерть пораненого побратима, якого не вдалося евакуювати", kinds: [0] },
    { reason: `Під час обстрілу загинули цивільні, яких не встигли вивести: «я ${g(p, "мав", "мала")} зробити більше».`, event: "загибель цивільних під час виходу", kinds: [0, 1] },
    { reason: "Командування кинуло підрозділ без підтримки: гнів, зневіра, «нікому не можна довіряти».", event: "залишення підрозділу без підтримки", kinds: [2] },
  ][k]!;
  const t = (d: number) => (d - start) / Math.max(1, end - start);
  const srFrom = between(r, 17, 23);
  const tvrFrom = between(r, 16, 22);
  const pclFrom = between(r, 34, 44);
  const phqFrom = between(r, 11, 15);
  const steps = MORAL_STEPS(p);
  const visits: Visit[] = days.map((d, i) => {
    const measuring = i === 0 || i === 6 || i === 11;
    const measures = measuring
      ? [
          M.mios(i ? noisy(r, curve(srFrom, between(r, 10, 14), t(d), 1.4), 2, 0, 28) : srFrom, i ? noisy(r, curve(tvrFrom, between(r, 12, 16), t(d), 1.4), 2, 0, 28) : tvrFrom, story.kinds),
          M.pcl5(i ? noisy(r, curve(pclFrom, between(r, 22, 29), t(d)), 3, 0, 80) : pclFrom),
          M.phq9(i ? noisy(r, curve(phqFrom, between(r, 5, 8), t(d)), 1.5, 0, 27) : phqFrom),
        ]
      : [];
    if (i === 0) {
      return visit(
        d,
        "primary",
        measures,
        (c) =>
          [
            "Первинний прийом.",
            `Скарги: постійні думки про подію (${story.event}), провина, сором, відчуття, що «не заслуговує на добре життя»; ${g(p, "віддалився", "віддалилася")} від родини.`,
            `Психічний стан: ${STATUS_CALM(p)} Настрій знижений, ${g(p, "стриманий", "стримана")}, під час розповіді дивиться вниз. Суїцидальні думки заперечує.`,
            `Обстеження: MIOS — ${fmt(c.score("mios", "MIOS"))} з 56 (сором — ${fmt(c.score("mios", "SR"))}, підірвана довіра — ${fmt(c.score("mios", "TVR"))}); PCL-5 — ${banded(c.score("pcl5"), c.band("pcl5"))}; PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))}.`,
            "Оцінка: ознаки моральної травми з посттравматичною симптоматикою. План: робота з провиною й соромом, адаптивне розкриття; за згодою — зустріч із капеланом.",
          ].join("\n"),
        { reason: "Не можу пробачити собі той день" },
      );
    }
    return visit(d, "repeat", measures, (c) => {
      const line = `Сесія ${c.visitNo}. ${step(steps, c.visitNo)}`;
      return measuring
        ? `${line}\nКонтрольний замір: MIOS — ${fmt(c.score("mios", "MIOS"))} (на початку — ${fmt(c.first("mios", "MIOS"))}), PCL-5 — ${fmt(c.score("pcl5"))}, PHQ-9 — ${fmt(c.score("phq9"))}.`
        : line;
    });
  });
  const lastPast = lastPastOf(visits, start);
  const finished = end < -5;
  return {
    ...NONE,
    episode: {
      openDay: start - 2,
      reason: story.reason,
      ...(finished
        ? { closeDay: end + 2, outcome: "improved" as const, outcomeText: (c: NoteContext) => `Курс завершено: MIOS з ${fmt(c.first("mios", "MIOS"))} до ${fmt(c.score("mios", "MIOS"))}, PCL-5 — ${fmt(c.score("pcl5"))}. Підтримувальні зустрічі за потреби.` }
        : {}),
    },
    visits,
    decide: bandDecision("Підтверджено: посттравматична й депресивна симптоматика на тлі моральної травми, гострого ризику немає. Взято на курс."),
    ...(k % 2 === 0
      ? {
          conclusion: {
            visit: 0,
            key: "mios",
            text: (c: NoteContext) =>
              `Психодіагностичне обстеження ${c.date(days[0]!)}.\nМетодики: MIOS, PCL-5, PHQ-9.\nРезультати: MIOS — ${fmt(c.score("mios", "MIOS"))} з 56 (наслідки, пов’язані із соромом, — ${fmt(c.score("mios", "SR"))}; з підірваною довірою — ${fmt(c.score("mios", "TVR"))}); PCL-5 — ${banded(c.score("pcl5"), c.band("pcl5"))} (з 80); PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))} (з 27).\nВисновок: виражені наслідки моральної травми (провина, сором, зневіра) з посттравматичними та депресивними проявами.\nРекомендовано: психотерапія, спрямована на моральну травму (12 сесій), за згодою — участь капелана, контроль через 6 тижнів.`,
          },
        }
      : {}),
    pending: finished ? [] : [{ key: "mios", grantedDay: lastPast, dueDay: all.find((d, i) => d > 0 && (i === 6 || i === 11)) ?? lastPast + 21 }],
  };
};

/* ─── пролонгована реакція горя ─── */

const GRIEF_STEPS = (p: Person, whom: string) => [
  `Розповідь про смерть ${whom}, робота з униканням. Уперше ${g(p, "переглянув", "переглянула")} фотографії.`,
  "Щоденник туги: найважче — вечори й вихідні; план підтримки на ці години.",
  "Робота з провиною того, хто вижив: «що сказав би загиблий».",
  "Відвідування могили — уперше після похорону. Туга не зникла, але «стало можна дихати».",
  "Уявна розмова із загиблим; прощання, якого не було.",
  `Повернення до того, чого ${g(p, "уникав", "уникала")}: місця, де бували разом, спільна музика.`,
  "Відновлення сенсу: волонтерство у фонді підтримки родин загиблих.",
  "Нові ролі й плани на рік; підтримка родини.",
  "Підсумки курсу: пам’ять без болю, що паралізує; план на роковини.",
];

const grief: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.grief;
  const start = -between(r, 60, 150);
  const all = courseDays(r, start, 9, 10, 2);
  const days = trimFuture(all);
  const end = all[all.length - 1]!;
  const loss = [
    { who: "брат", whom: "брата", reason: "Загибель брата на фронті 9 місяців тому: щоденна туга, не може прийняти втрату." },
    { who: "чоловік", whom: "чоловіка", reason: "Загинув чоловік під час бойового завдання: не виходить з дому, тримається лише заради дитини." },
    { who: "командир і двоє побратимів", whom: "командира й побратимів", reason: "Загибель командира й двох побратимів: провина того, хто вижив, уникає місць, де служили разом." },
    { who: "найкращий друг", whom: "друга", reason: "Загинув найкращий друг з першого дня служби: «частина мене померла разом із ним»." },
  ][k]!;
  const tgiFrom = between(r, 78, 92);
  const tgiTo = between(r, 58, 69);
  const t = (d: number) => (d - start) / Math.max(1, end - start);
  const wish = k === 0;
  const steps = GRIEF_STEPS(p, loss.whom);
  const visits: Visit[] = days.map((d, i) => {
    const measuring = i === 0 || i % 3 === 0;
    const measures = measuring
      ? [M.tgi(i ? noisy(r, curve(tgiFrom, tgiTo, t(d)), 3, 22, 110) : tgiFrom, i === 0 && wish ? 3 : 1), ...(i === 0 ? [M.phq9(between(r, 11, 16)), ...(wish ? [M.cssrs({ wish: true, thoughts: false })] : [])] : [])]
      : [];
    if (i === 0) {
      return visit(
        d,
        "primary",
        measures,
        (c) =>
          [
            "Первинний прийом.",
            `Втрата: ${loss.who}, ${between(r, 7, 14)} міс. тому. Скарги: щоденна туга, нав’язливі думки про загиблого, уникання нагадувань, відчуття порожнечі й безглуздості.`,
            `Психічний стан: ${STATUS_CALM(p)} Настрій знижений, плаче під час розповіді. ${wish ? "Бажання «піти слідом» протягом місяця; C-SSRS — без думок про самогубство й наміру." : "Суїцидальні думки заперечує."}`,
            `Обстеження: TGI-SR+ — ${banded(c.score("tgi_sr_plus"), c.band("tgi_sr_plus"))}; PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))}.`,
            "План: терапія пролонгованого горя, 10 сесій.",
          ].join("\n"),
        { reason: `Не можу жити далі без ${loss.whom}` },
      );
    }
    return visit(d, "repeat", measures, (c) => {
      const line = `Сесія ${c.visitNo}. ${step(steps, c.visitNo)}`;
      return measuring ? `${line}\nTGI-SR+ — ${fmt(c.score("tgi_sr_plus"))} (на початку — ${fmt(c.first("tgi_sr_plus"))}).` : line;
    });
  });
  const lastPast = lastPastOf(visits, start);
  const finished = end < -5;
  return {
    ...NONE,
    episode: {
      openDay: start - 3,
      reason: loss.reason,
      ...(finished ? { closeDay: end + 2, outcome: "improved" as const, outcomeText: (c: NoteContext) => `Курс завершено: TGI-SR+ з ${fmt(c.first("tgi_sr_plus"))} до ${fmt(c.score("tgi_sr_plus"))}, нижче порогу пролонгованого горя.` } : {}),
    },
    visits,
    decide: (c) =>
      c.critical
        ? { outcome: "not_confirmed", note: "C-SSRS проведено: бажання «бути поруч із загиблим» без думок про самогубство й наміру; гострого ризику немає. Обговорено план безпеки." }
        : bandDecision("Підтверджено: пролонгована реакція горя, гострого ризику немає. Терапія горя за планом.")(c),
    ...(k % 2 === 0
      ? {
          conclusion: {
            visit: 0,
            key: "tgi_sr_plus",
            text: (c: NoteContext) =>
              `Психодіагностичне обстеження ${c.date(days[0]!)}.\nМетодики: TGI-SR+, PHQ-9.\nРезультати: TGI-SR+ — ${banded(c.score("tgi_sr_plus"), c.band("tgi_sr_plus"))} (з 110); PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))} (з 27).\nВисновок: ознаки пролонгованого розладу горя з депресивними проявами.\nРекомендовано: терапія пролонгованого горя (10 сесій), контроль TGI-SR+ щомісяця.`,
          },
        }
      : {}),
    pending: finished ? [] : [{ key: "tgi_sr_plus", grantedDay: lastPast, dueDay: days.find((d) => d > 0) ?? lastPast + 14 }],
  };
};

/* ─── вигорання персоналу госпіталю ─── */

const BURN_STEPS = (p: Person) => [
  "Межі між роботою й відпочинком, ритуал завершення зміни. З керівником відділення узгоджено два вихідні поспіль раз на тиждень.",
  `Група підтримки персоналу — ${g(p, "відвідав", "відвідала")} дві зустрічі. Сон 6–7 год.`,
  "Вторинна травматизація: техніки «переходу» після важких пацієнтів, розмова з колегою після зміни.",
  "Цінності в роботі: що дає сили, що забирає; повернення до хобі.",
  "Профілактика повторного вигорання: ранні ознаки, домовленості з керівником.",
];

const burnout: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.burnout;
  const start = -between(r, 20, 110);
  const all = courseDays(r, start, 14, 6, 2);
  const days = trimFuture(all);
  const end = all[all.length - 1]!;
  const finished = end < -5;
  const batFrom = between(r, 300, 345) / 100;
  const batTo = between(r, 230, 270) / 100;
  const pssFrom = between(r, 22, 28);
  const t = (d: number) => (d - start) / Math.max(1, end - start);
  const steps = BURN_STEPS(p);
  const visits: Visit[] = days.map((d, i) => {
    const last = finished && d === end;
    const measuring = i === 0 || i === 2 || last;
    const measures = measuring
      ? [
          M.bat12(i ? noisy(r, curve(batFrom, batTo, t(d)), 0.12, 1, 5, 2) : batFrom),
          M.pss10(i ? noisy(r, curve(pssFrom, between(r, 14, 18), t(d)), 2, 0, 40) : pssFrom),
          ...(i === 0 || last ? [M.proqol(i ? between(r, 32, 38) : between(r, 24, 30), i ? between(r, 24, 28) : between(r, 30, 36), i ? between(r, 20, 25) : between(r, 27, 34))] : []),
        ]
      : [];
    if (i === 0) {
      return visit(
        d,
        "primary",
        measures,
        (c) =>
          [
            "Первинна консультація.",
            `Скарги: виснаження, відчуття «на автопілоті», дратівливість, сон 5 год, думки про роботу вдома. Графік — ${pick(r, ["добові чергування через дві доби", "денні зміни по 12 годин без вихідних", "чергування після масового надходження поранених"])}.`,
            `Психічний стан: ${STATUS_CALM(p)} ${g(p, "Втомлений", "Втомлена")}, емоційно ${g(p, "виснажений", "виснажена")}. Суїцидальні думки заперечує.`,
            `Обстеження: BAT-12 — ${banded(c.score("bat12"), c.band("bat12"), 2)}; PSS-10 — ${fmt(c.score("pss10"))} з 40; ProQOL: вигорання — ${fmt(c.score("proqol5", "BO"))}, вторинний травматичний стрес — ${fmt(c.score("proqol5", "STS"))}, задоволення від співчуття — ${fmt(c.score("proqol5", "CS"))}.`,
            "План: консультації раз на 2 тижні; узгодження навантаження з керівником відділення; група підтримки персоналу.",
          ].join("\n"),
        { reason: "Сил немає, на роботі як робот", noteKind: "intake" },
      );
    }
    return visit(
      d,
      "repeat",
      measures,
      (c) =>
        last
          ? `Завершальна консультація. BAT-12 — ${fmt(c.score("bat12"), 2)} (на початку — ${fmt(c.first("bat12"), 2)}), PSS-10 — ${fmt(c.score("pss10"))}. Сон 7 год, на роботі «знову бачу людей, а не задачі».`
          : `Консультація ${c.visitNo}. ${step(steps, c.visitNo)}${measuring ? `\nКонтрольний замір: BAT-12 — ${fmt(c.score("bat12"), 2)} (на початку — ${fmt(c.first("bat12"), 2)}), PSS-10 — ${fmt(c.score("pss10"))}.` : ""}`,
      { noteKind: "consult" },
    );
  });
  const lastPast = lastPastOf(visits, start);
  return {
    ...NONE,
    episode: {
      openDay: start - 2,
      reason: pick(r, [
        `${p.position ?? "Працівник госпіталю"}: виснаження, байдужість до пацієнтів, безсоння після чергувань.`,
        `${g(p, "Звернувся", "Звернулася")} за рекомендацією завідувача відділення через емоційне виснаження.`,
        "Після масового надходження поранених — не може «вимкнутися» вдома, сни про роботу.",
      ]),
      ...(finished
        ? { closeDay: end + 1, outcome: "improved" as const, outcomeText: (c: NoteContext) => `Консультації завершено: BAT-12 з ${fmt(c.first("bat12"), 2)} до ${fmt(c.score("bat12"), 2)}, навантаження узгоджено з керівником.` }
        : {}),
    },
    visits,
    decide: bandDecision("Підтверджено: виражене вигорання, гострого ризику немає. Консультації за планом, узгодження навантаження."),
    ...(k === 1 || k === 4
      ? {
          conclusion: {
            visit: 0,
            key: "bat12",
            text: (c: NoteContext) =>
              `Психологічне обстеження ${c.date(days[0]!)}.\nМетодики: BAT-12, ProQOL 5, PSS-10.\nРезультати: BAT-12 — ${banded(c.score("bat12"), c.band("bat12"), 2)}; ProQOL: задоволення від співчуття — ${banded(c.score("proqol5", "CS"), c.band("proqol5", "CS"))}, вигорання — ${fmt(c.score("proqol5", "BO"))}, вторинний травматичний стрес — ${fmt(c.score("proqol5", "STS"))}; PSS-10 — ${fmt(c.score("pss10"))} з 40.\nВисновок: виражене професійне вигорання з високим рівнем сприйнятого стресу.\nРекомендовано: консультації психолога раз на 2 тижні, корекція графіка роботи, група підтримки персоналу, контроль BAT-12 через місяць.`,
          },
        }
      : {}),
    ...(k === 3 && !finished
      ? { thread: [{ day: -1, minute: 22 * 60 + 10, fromPatient: true, text: "Після зміни графіка чергувань стало легше. Чи потрібно ще раз проходити опитувальник?", read: false }] }
      : {}),
    pending: finished ? [] : [{ key: "bat12", grantedDay: lastPast, dueDay: days.find((d) => d > 0) ?? lastPast + 14 }],
  };
};

/* ─── гостра суїцидальна криза, план безпеки ─── */

const crisis: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.crisis;
  const day0 = [-2, -4, -40, -95][k]!;
  const heavy = k === 1;
  const plan = safetyPlan(r, {
    signs: pick(r, [
      ["Безсоння понад дві ночі поспіль", "Думки «я тягар для всіх»", "Хочеться побути на самоті, вимкнути телефон", "Алкоголь увечері"],
      ["Перестаю їсти й виходити з кімнати", "Перечитую старі повідомлення загиблого друга", "Думки, що «все марно»"],
    ]),
    reasons: pick(r, [["Донька Софійка", "Мама", "Обіцянка побратимам повернутися"], ["Син", "Батько, якому потрібна допомога", "Плани на дім, який будуємо"]]),
    weapon: p.unit !== "Ветеран",
    people: [[pick(r, ["Мама", "Брат Сергій", g(p, "Дружина", "Чоловік")]), contactPhone(r)], [pick(r, ["Побратим Андрій", "Друг Василь", "Сестра Ірина"]), contactPhone(r)]],
  });
  const crisisMeasures = [
    M.phq9(heavy ? 22 : between(r, 18, 21), heavy ? 3 : 2),
    M.sidas(heavy ? 33 : between(r, 22, 28)),
    M.sbqr(heavy ? 4 : 3, 3, heavy ? 3 : 2, heavy ? 4 : 3),
    M.cssrs({ wish: true, thoughts: true, method: true, intent: heavy, plan: false, behavior: k === 3 || heavy, recent: false }),
  ];
  const what = [
    "Після звістки про загибель друга — думки про самогубство; має доступ до зброї.",
    `${g(p, "Доставлений", "Доставлена")} черговим лікарем: ${g(p, "висловлював", "висловлювала")} намір накласти на себе руки після сварки з ${spouse(p)}.`,
    "Після звістки про загибель брата — думки про самогубство, не спить, відмовляється від їжі.",
    "Повторні суїцидальні думки після звільнення зі служби; спроба (передозування ліків) два роки тому.",
  ][k]!;
  /*
   * Наступні контакти: у перші дні — розмова без опитувальників (SIDAS питає
   * про місяць, PHQ-9 — про два тижні, наступного дня їх не повторюють);
   * далі SIDAS раз на тиждень, PHQ-9 — не частіше ніж раз на два тижні. Після
   * психіатричного відділення — повторна оцінка C-SSRS і SIDAS.
   */
  const plans: { day: number; sidas: number | null; phq: number | null; reassess?: boolean }[] =
    k === 0
      ? [{ day: -1, sidas: null, phq: null }]
      : k === 1
        ? [{ day: -1, sidas: 12, phq: null, reassess: true }]
        : k === 2
          ? [
              { day: -39, sidas: null, phq: null },
              { day: -37, sidas: null, phq: null },
              { day: -33, sidas: 9, phq: null },
              { day: -26, sidas: 5, phq: 13 },
              { day: -19, sidas: 2, phq: null },
              { day: -12, sidas: 0, phq: 9 },
            ]
          : [
              { day: -93, sidas: null, phq: null },
              { day: -88, sidas: 10, phq: null },
              { day: -81, sidas: 6, phq: 14 },
              { day: -74, sidas: 3, phq: null },
              { day: -60, sidas: 0, phq: 10 },
              { day: -45, sidas: 0, phq: null },
              { day: -20, sidas: 0, phq: 7 },
            ];
  const visits: Visit[] = [
    visit(
      day0,
      "primary",
      crisisMeasures,
      (c) =>
        [
          "Позачерговий прийом.",
          what,
          `C-SSRS: бажання смерті — так, думки про самогубство — так, думки про спосіб — так, намір — ${heavy ? "так" : "ні"}, план — ні; суїцидальна поведінка в анамнезі — ${k === 3 || heavy ? "так" : "ні"}.`,
          `SIDAS — ${banded(c.score("sidas"), c.band("sidas"))}; SBQ-R — ${fmt(c.score("sbqr"))}; PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))}.`,
          `Захисні чинники: ${pick(r, ["донька, мати", "син, побратими", "брат, віра"])}; критичність до стану збережена.`,
          `Дії: складено план безпеки; ${p.unit !== "Ветеран" ? "зброю здано на зберігання черговому підрозділу; " : ""}огляд психіатра сьогодні${heavy ? " — переведено до психіатричного відділення на спостереження" : ""}; щоденний контакт.`,
        ].join("\n"),
      { urgent: true, reason: `Привели, бо ${g(p, "сказав", "сказала")}, що не хочу жити` },
    ),
    ...plans.map((f) =>
      visit(
        f.day,
        "repeat",
        [
          ...(f.sidas !== null ? [M.sidas(f.sidas)] : []),
          // п. 9 PHQ-9 узгоджений із SIDAS: поки думки є, «не турбували взагалі» не відповідають
          ...(f.phq !== null ? [M.phq9(f.phq, f.sidas ? 1 : 0)] : []),
          ...(f.reassess ? [M.cssrs({ wish: true, thoughts: true, method: false })] : []),
        ],
        (c) => {
          const days = f.day - day0;
          const head = f.reassess
            ? `Повторна оцінка після повернення з психіатричного відділення. Думки про смерть зберігаються, способу й наміру немає; приймає призначене. План безпеки переглянуто.`
            : f.sidas === null
              ? `Контакт ${days}-ї доби. ${g(p, "Спав", "Спала")} ${pick(r, ["4", "5", "5–6"])} год; думки про самогубство «приходять, але слабші», наміру немає. План безпеки при собі, телефон чергового збережено.`
              : f.sidas > 0
                ? `Огляд через ${days} ${pl(days, "день", "дні", "днів")} після кризи. Суїцидальні думки рідше, без наміру; план безпеки діє.`
                : `Огляд. Суїцидальних думок понад 2 тижні немає; план безпеки переглянуто, оновлено контакти. ${g(p, "Повернувся", "Повернулася")} до звичного розпорядку.`;
          const scores = [
            c.score("sidas") !== null ? `SIDAS — ${fmt(c.score("sidas"))} (на початку — ${fmt(c.first("sidas"))})` : null,
            c.score("phq9") !== null ? `PHQ-9 — ${fmt(c.score("phq9"))}` : null,
          ].filter(Boolean);
          return scores.length ? `${head}\n${scores.join(", ")}.` : head;
        },
        { noteKind: "observation" },
      ),
    ),
    visit(k < 2 ? (k === 0 ? 1 : 2) : between(r, 3, 9), "repeat", [], undefined),
  ];
  const resolved = k >= 2;
  const lastPast = plans[plans.length - 1]!.day;
  return {
    episode: {
      openDay: day0,
      reason: what,
      ...(k === 3 ? { closeDay: -45, outcome: "improved" as const, outcomeText: () => "Криза минула: суїцидальних думок понад місяць немає, план безпеки переглянуто. Під динамічним спостереженням." } : {}),
    },
    visits,
    home: [],
    openFrom: resolved ? undefined : k === 0 ? day0 : -1,
    decide: (c) =>
      c.first
        ? { outcome: "confirmed", note: "Підтверджено: суїцидальні думки зі способом. План безпеки, огляд психіатра в день звернення, щоденний контакт." }
        : c.critical
          ? { outcome: "needs_followup", note: "Думки рідшають, без наміру; план безпеки діє, контакт за графіком." }
          : { outcome: "needs_followup", note: "Депресивна симптоматика зменшується; спостереження за планом." },
    conclusion: {
      visit: 0,
      key: "sidas",
      text: (c) =>
        `Оцінка суїцидального ризику ${c.date(day0)}.\nМетодики: C-SSRS (скринер), SIDAS, SBQ-R, PHQ-9.\nРезультати: SIDAS — ${banded(c.score("sidas"), c.band("sidas"))} (з 50); SBQ-R — ${banded(c.score("sbqr"), c.band("sbqr"))}; PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))} (з 27).\nВисновок: ${heavy ? "високий" : "підвищений"} суїцидальний ризик: думки про самогубство зі способом${heavy ? " і наміром" : " без наміру"}. Рішення про безпеку ухвалено спільно з лікарем-психіатром.\nРекомендовано: план безпеки, обмеження доступу до засобів, щоденний контакт до стабілізації, повторна оцінка через 7 днів.`,
    },
    safetyPlans: [
      { day: day0, content: plan },
      ...(resolved ? [{ day: k === 2 ? -19 : -60, content: plan }] : []),
      ...(k === 3 ? [{ day: -20, content: plan }] : []),
    ],
    referrals: [
      {
        day: day0,
        destination: heavy ? "inpatient" : "psychiatrist",
        urgency: heavy ? "immediate" : "urgent",
        status: "completed",
        reason: heavy ? "Високий суїцидальний ризик з наміром: огляд психіатра й госпіталізація." : "Суїцидальні думки зі способом: невідкладний огляд психіатра.",
        outcomeNote: heavy
          ? `Переведено до психіатричного відділення на 3 доби; ${g(p, "повернувся", "повернулася")} під спостереження відділення.`
          : "Огляд психіатра: госпіталізація не потрібна; призначено міртазапін 15 мг на ніч, повторний огляд через 3 дні.",
        updatedDay: day0,
      },
      ...(p.unit !== "Ветеран"
        ? [{
            day: day0,
            destination: "commander" as const,
            urgency: "urgent" as const,
            status: resolved ? ("completed" as const) : ("accepted" as const),
            reason: "Тимчасово обмежити доступ до зброї та нарядів з озброєнням до рішення лікаря-психіатра.",
            ...(resolved ? { outcomeNote: "Обмеження знято за рішенням психіатра.", updatedDay: day0 + 21 } : {}),
          }]
        : []),
    ],
    ...(k === 3 ? { dispensary: { groupLabel: "Динамічне спостереження після суїцидальної кризи", intervalMonths: 1, lastSeenDay: -20, nextDueDay: 10 } } : {}),
    ...(k === 0 ? { thread: [{ day: -1, minute: 21 * 60 + 30, fromPatient: true, text: `Дякую, що вислухали. План ношу з собою, вчора вперше нормально ${g(p, "поспав", "поспала")}.`, read: false }] } : {}),
    pending: [{ key: "sidas", grantedDay: lastPast, dueDay: k < 2 ? 2 : lastPast + 14 }],
  };
};

/* ─── стабільний стан після лікування ─── */

const STABLE_STEPS = (p: Person) => [
  "Навички саморегуляції закріплено, домашні завдання виконує регулярно.",
  `Сон покращився, ${g(p, "повернувся", "повернулася")} інтерес до звичних справ.`,
  "Профілактика рецидиву: ранні ознаки, план дій, кому дзвонити.",
];

const stable: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.stable;
  /*
   * Четверо з чотирнадцяти пропустили контрольний огляд: останній прийом —
   * завершення курсу більше трьох місяців тому. Така прострочка обліку і є
   * те, заради чого розділ заведено; групи обліку в них різні.
   */
  const overdue = [1, 6, 11, 12].includes(k);
  const start = overdue ? -between(r, 176, 185) : -between(r, 150, 185);
  const closed = start + between(r, 60, 80);
  const conditions = [
    { label: "Динамічне спостереження після лікування ПТСР", what: "ПТСР", reason: "Після бойових дій — кошмари, настороженість, безсоння.", keys: ["pcl5", "phq9"], on: [between(r, 44, 55), between(r, 10, 14)], off: [between(r, 16, 26), between(r, 3, 6)] },
    { label: "Динамічне спостереження після депресивного епізоду", what: "депресивного епізоду", reason: "Пригніченість, втрата інтересу після повернення з ротації.", keys: ["phq9", "who5"], on: [between(r, 15, 19), between(r, 4, 8)], off: [between(r, 3, 6), between(r, 15, 19)] },
    { label: "Динамічне спостереження після розладу адаптації", what: "розладу адаптації", reason: "Важка адаптація після поранення й лікування.", keys: ["k10"], on: [between(r, 25, 29)], off: [between(r, 12, 16)] },
    { label: "Динамічне спостереження після лікування безсоння", what: "безсоння", reason: "Хронічне безсоння, денна втома.", keys: ["sci"], on: [between(r, 6, 11)], off: [between(r, 19, 25)] },
  ];
  const condition = conditions[k % 4]!;
  const measure = (key: string, value: number): Measure =>
    key === "pcl5" ? M.pcl5(value) : key === "phq9" ? M.phq9(value) : key === "who5" ? M.who5(value) : key === "k10" ? M.k10(value) : M.sci(value);
  const before = condition.keys.map((key, i) => measure(key, condition.on[i]!));
  const after = condition.keys.map((key, i) => measure(key, condition.off[i]!));
  const list = (c: NoteContext, withStart: boolean) =>
    condition.keys.map((key) => `${TITLE[key]} — ${fmt(c.score(key))}${withStart ? ` (на початку — ${fmt(c.first(key))})` : ""}`).join(", ");
  const steps = STABLE_STEPS(p);

  // контрольні прийоми раз на 6–9 тижнів після закриття курсу
  const checks: number[] = [];
  if (!overdue) for (let d = closed + between(r, 35, 50); d < -2; d += between(r, 42, 63)) checks.push(d);
  const visits: Visit[] = [
    visit(
      start,
      "primary",
      before,
      (c) => `Первинний прийом з приводу ${condition.what}. ${condition.reason}\nПсихічний стан: ${STATUS_CALM(p)} Суїцидальні думки заперечує.\nОбстеження: ${list(c, false)}.\nПлан: курс психотерапії, 6 сесій.`,
      { reason: "Хочу повернутися до нормального життя" },
    ),
    ...courseDays(r, start + 14, 14, 3, 2).map((d) => visit(d, "repeat", [], (c) => `Сесія ${c.visitNo}. ${step(steps, c.visitNo)}`)),
    visit(closed, "repeat", after, (c) => `Завершення курсу. ${list(c, true)}. Стан стабільний; динамічне спостереження раз на 3 місяці.`),
    ...checks.map((d) =>
      visit(
        d,
        "repeat",
        [M.who5(between(r, 15, 21)), M.phq4(between(r, 0, 2), between(r, 0, 1))],
        (c) =>
          `Контрольний огляд. Стан стабільний: сон 7 год, настрій рівний, ${p.unit === "Ветеран" ? pick(r, ["працює водієм у комунальному підприємстві", "займається у ветеранському спортклубі", "навчається за програмою перекваліфікації"]) : g(p, "повернувся до служби", "повернулася до служби")}.\nWHO-5 — ${fmt(c.score("who5"))} з 25, PHQ-4 — ${fmt(c.score("phq4", "PHQ4"))}. Наступний огляд через 3 місяці.`,
        { noteKind: "observation" },
      ),
    ),
  ];
  const lastSeen = checks.length ? checks[checks.length - 1]! : closed;
  const nextDue = lastSeen + 91;
  if (!overdue && nextDue <= 20) visits.push(visit(Math.max(1, nextDue), "repeat", [], undefined));
  return {
    ...NONE,
    episode: {
      openDay: start - 2,
      reason: condition.reason,
      closeDay: closed + 1,
      outcome: "improved",
      outcomeText: (c) => `Курс завершено: ${list(c, true)}. Стан стабільний, динамічне спостереження раз на 3 місяці.`,
    },
    visits,
    decide: bandDecision(`Підтверджено на первинному прийомі, гострого ризику немає. Курс психотерапії з приводу ${condition.what}.`),
    ...(k === 0 || k === 5 || k === 10
      ? {
          conclusion: {
            visit: 4,
            key: condition.keys[0]!,
            text: (c: NoteContext) =>
              `Заключення за підсумками курсу ${c.date(closed)}.\nРезультати: ${condition.keys.map((key) => `${TITLE[key]} — ${banded(c.score(key), c.band(key))} (на початку курсу — ${fmt(c.first(key))})`).join("; ")}.\nВисновок: стан стабілізувався, симптоми нижче клінічних порогів.\nРекомендовано: динамічне спостереження раз на 3 місяці (WHO-5, PHQ-4), звертатися раніше за потреби.`,
          },
        }
      : {}),
    dispensary: { groupLabel: condition.label, intervalMonths: 3, lastSeenDay: lastSeen, nextDueDay: nextDue },
    referrals:
      k === 3
        ? [{ day: closed + 2, destination: "outpatient", urgency: "routine", status: "completed", reason: "Подальше спостереження в психолога за місцем проживання.", outcomeNote: "Прийнято під спостереження ветеранського простору громади.", updatedDay: closed + 9 }]
        : [],
    ...(k === 7 && lastSeen + 21 < 0
      ? {
          thread: [
            { day: lastSeen + 20, minute: 12 * 60 + 40, fromPatient: true, text: "Добрий день. Усе гаразд, працюю. На контроль прийду, як домовлялися.", read: true },
            { day: lastSeen + 21, minute: 9 * 60 + 30, fromPatient: false, text: "Дякуємо, що написали. Чекаємо на контрольний огляд.", read: true },
          ],
        }
      : {}),
    pending: overdue ? [] : [{ key: "who5", grantedDay: lastSeen, dueDay: nextDue }],
  };
};

/* ─── нове скерування: лише первинний скринінг ─── */

/** Профили скрининга: PHQ-9, GAD-7, PC-PTSD-5, AUDIT-C, SCI-02, WHO-5 */
const SCREENS: { phq: number; item9?: number; gad: number; pc: number; auditc: number; sci02: number; who: number; label: string }[] = [
  { phq: 3, gad: 2, pc: 1, auditc: 2, sci02: 6, who: 18, label: "скринінг негативний" },
  { phq: 6, gad: 5, pc: 4, auditc: 3, sci02: 3, who: 14, label: "позитивний скринінг ПТСР" },
  { phq: 12, gad: 8, pc: 2, auditc: 2, sci02: 2, who: 10, label: "ознаки депресії, безсоння" },
  { phq: 5, gad: 4, pc: 1, auditc: 7, sci02: 4, who: 15, label: "позитивний скринінг вживання алкоголю" },
  { phq: 8, gad: 11, pc: 3, auditc: 3, sci02: 2, who: 12, label: "виражена тривога, безсоння" },
  { phq: 4, gad: 3, pc: 0, auditc: 1, sci02: 2, who: 16, label: "ознаки безсоння" },
];

const screening: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.screening;
  const reasons = [
    `Скерування командира: плановий огляд після ${between(r, 5, 9)} місяців на передовій.`,
    `${g(p, "Звернувся", "Звернулася")} сам${g(p, "", "а")} через порушення сну.`,
    `${g(p, "Направлений", "Направлена")} з терапевтичного відділення: тривога, серцебиття без органічної причини.`,
    "Після контузії — скарги на пам’ять і сон.",
    "Скерування медичної роти після повернення з позицій.",
  ];
  const reason = pick(r, reasons);
  // 0 и 1 — сдали только что и вчера, сигнал ещё на разборе; 2–10 — сдали, 11–12 — ждут сдачи, 13–15 — просрочили
  const referral = k <= 1 ? -between(r, 2, 3) : k <= 7 ? -between(r, 6, 13) : k <= 10 ? -between(r, 3, 5) : k <= 12 ? -between(r, 1, 3) : -between(r, 8, 12);
  const done = k <= 10;
  const screenDay = k <= 1 ? -1 : referral + between(r, 0, 2);
  const s =
    k === 0
      ? { phq: 13, item9: 1, gad: 11, pc: 3, auditc: 2, sci02: 2, who: 7, label: "ознаки депресії, думки про смерть" }
      : k === 1
        ? { phq: 14, gad: 9, pc: 5, auditc: 5, sci02: 1, who: 9, label: "позитивний скринінг ПТСР, ознаки депресії" }
        : SCREENS[(k + p.ordinal) % SCREENS.length]!;
  const measures: Measure[] = [M.phq9(s.phq, s.item9 ?? 0), M.gad7(s.gad), M.pcptsd5(s.pc), M.auditc(s.auditc), M.sci02(s.sci02), M.who5(s.who)];
  const firstVisit =
    k <= 1 ? (k === 0 ? 1 : 0) : k <= 7 ? screenDay + between(r, 1, 4) : k <= 10 ? between(r, 0, 6) : k <= 12 ? between(r, 3, 8) : k === 13 ? -3 : between(r, 2, 6);
  const deep = s.pc >= 4 ? "pcl5" : s.phq >= 10 ? "phq9" : s.auditc >= 4 ? "audit" : s.sci02 <= 2 ? "sci" : null;
  const visits: Visit[] = [
    visit(
      firstVisit,
      "primary",
      [],
      (c) =>
        [
          "Первинний прийом за результатами скринінгу.",
          `Скринінг ${c.date(screenDay)}: ${s.label}. PHQ-9 — ${fmt(c.last("phq9"))}, GAD-7 — ${fmt(c.last("gad7"))}, PC-PTSD-5 — ${fmt(c.last("pcptsd5"))} з 5, AUDIT-C — ${fmt(c.last("auditc"))}, SCI-02 — ${fmt(c.last("sci02"))}, WHO-5 — ${fmt(c.last("who5"))} з 25.`,
          `Психічний стан: ${STATUS_CALM(p)} Суїцидальні думки заперечує.`,
          deep === "pcl5"
            ? "План: поглиблене обстеження (PCL-5, LEC-5), психотерапія за результатами."
            : deep === "phq9"
              ? "План: повторний PHQ-9 через 2 тижні, консультації психолога."
              : deep === "audit"
                ? "План: AUDIT, мотиваційне консультування."
                : deep === "sci"
                  ? "План: SCI, рекомендації з гігієни сну, за потреби — КПТ-І."
                  : "План: клінічно значущих порушень не виявлено; рекомендації, звертатися за потреби.",
        ].join("\n"),
      { reason: pick(r, ["Командир сказав пройти огляд", "Погано сплю останній місяць", "Важко зосередитися, все дратує"]), outcome: k === 13 ? "no_show" : "done" },
    ),
  ];
  if (k >= 2 && k <= 7 && firstVisit < 0) {
    visits.push(
      visit(firstVisit + between(r, 5, 10), "repeat", [], () =>
        `Повторна консультація. Обговорено результати скринінгу, психоосвіта щодо стресових реакцій; ${deep ? "поглиблене обстеження призначено" : "рекомендації з режиму сну й навантаження"}.`,
      ),
    );
  }
  return {
    ...NONE,
    episode: { openDay: referral, reason },
    visits,
    home: done
      ? [
          k === 0
            ? { day: -1, minute: 0, recent: true, measures }
            : { day: screenDay, minute: k === 1 ? 9 * 60 + 30 : between(r, 18 * 60, 21 * 60 + 30), measures },
        ]
      : [],
    ...(k <= 1 ? { openFrom: -1 } : {}),
    decide: (c) =>
      c.critical
        ? { outcome: "not_confirmed", note: "Розмова по телефону: думки про смерть пасивні, без наміру й плану. Первинний прийом — завтра, план безпеки обговорено." }
        : { outcome: "needs_followup", note: "Скринінг переглянуто: гострого ризику немає. Первинний прийом призначено, поглиблене обстеження — за результатами прийому." },
    ...(k === 3 && firstVisit < 0
      ? {
          conclusion: {
            visit: 0,
            key: "phq9",
            text: (c: NoteContext) =>
              `Первинне психологічне обстеження ${c.date(screenDay)} (набір «Первинний скринінг»).\nРезультати: PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))} (з 27); GAD-7 — ${banded(c.score("gad7"), c.band("gad7"))}; PC-PTSD-5 — ${banded(c.score("pcptsd5"), c.band("pcptsd5"))} (з 5); AUDIT-C — ${fmt(c.score("auditc"))}; SCI-02 — ${banded(c.score("sci02"), c.band("sci02"))}; WHO-5 — ${fmt(c.score("who5"))} з 25.\nВисновок: ${s.label}. Позитивний скринінг — привід для поглибленої оцінки, а не діагноз.\nРекомендовано: ${deep === "pcl5" ? "PCL-5 і LEC-5" : deep === "phq9" ? "повторний PHQ-9 через 2 тижні" : deep === "audit" ? "AUDIT" : deep === "sci" ? "SCI" : "спостереження за потреби"}; консультації психолога.`,
          },
        }
      : {}),
    battery: { assignedDay: referral, dueDay: k >= 13 ? referral + between(r, 5, 7) : referral + 7 },
    referrals: k === 4 && reason.startsWith("Після контузії") && firstVisit < 0
      ? [{ day: firstVisit, destination: "other", urgency: "routine", status: "created", reason: "Консультація невролога: скарги на пам’ять і сон після контузії." }]
      : [],
    pending: deep && done && firstVisit < 0 ? [{ key: deep, grantedDay: firstVisit, dueDay: firstVisit + 14 }] : [],
  };
};

/* ─── психотична симптоматика → переведення ─── */

const psychosis: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.psychosis;
  const day0 = k === 0 ? -between(r, 25, 40) : -between(r, 70, 90);
  const visits: Visit[] = [
    visit(
      day0,
      "primary",
      [M.pq16(between(r, 10, 13)), M.phq9(between(r, 10, 13))],
      (c) =>
        [
          "Первинний прийом.",
          "Скарги на «голоси», що коментують дії, підозріливість до побратимів, недосипання понад 2 тижні на позиціях.",
          `Психічний стан: ${g(p, "напружений", "напружена")}, ${g(p, "насторожений", "насторожена")}, на запитання відповідає з паузами, критичність знижена. Суїцидальні думки заперечує.`,
          `PQ-16 — ${banded(c.score("pq16"), c.band("pq16"))} (з 16); PHQ-9 — ${fmt(c.score("phq9"))}.`,
          "Оцінка: психотична симптоматика, потрібен невідкладний огляд психіатра. Скеровано, супроводжено черговим.",
        ].join("\n"),
      { urgent: true, reason: "Скерували з медроти" },
    ),
    ...(k === 1
      ? [
          visit(
            day0 + 35,
            "repeat",
            [M.phq9(between(r, 4, 7))],
            (c) => `${g(p, "Повернувся", "Повернулася")} після лікування в психіатричному відділенні. Стан стабільний, «голосів» немає, приймає призначене. PHQ-9 — ${fmt(c.score("phq9"))}. Подальше спостереження — у психіатра.`,
            { noteKind: "observation" },
          ),
        ]
      : []),
  ];
  return {
    ...NONE,
    episode: {
      openDay: day0,
      reason: "Підозріливість, чує «голоси» після тривалого недосипання на позиціях; скерування медичної роти.",
      closeDay: day0 + (k === 1 ? 36 : 1),
      outcome: "transferred",
      outcomeText: () => "Переведено до психіатричного відділення для обстеження й лікування.",
    },
    visits,
    decide: () => ({ outcome: "confirmed", note: "Підтверджено: психотична симптоматика. Невідкладний огляд психіатра, переведено до психіатричного відділення." }),
    ...(k === 0
      ? {
          conclusion: {
            visit: 0,
            key: "pq16",
            text: (c: NoteContext) =>
              `Психологічне обстеження ${c.date(day0)}.\nМетодики: PQ-16, PHQ-9.\nРезультати: PQ-16 — ${banded(c.score("pq16"), c.band("pq16"))} (з 16); PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))} (з 27).\nВисновок: виражені незвичні переживання (слухові обмани, ідеї стосунку) на тлі тривалого недосипання; потребує невідкладного огляду психіатра.\nРекомендовано: переведення до психіатричного відділення.`,
          },
        }
      : {}),
    referrals: [{
      day: day0,
      destination: "inpatient",
      urgency: "immediate",
      status: "completed",
      reason: "Психотична симптоматика: невідкладний огляд психіатра, госпіталізація до психіатричного відділення.",
      outcomeNote: "Госпіталізовано до психіатричного відділення.",
      updatedDay: day0,
    }],
  };
};

/* ─── тривожний розлад ─── */

const GAD_STEPS = [
  "Психоосвіта про тривогу; щоденник тривожних думок.",
  "«Час для тривоги» 20 хв увечері; відкладання хвилювань.",
  "Реструктуризація катастрофізації щодо родини: імовірність і наслідки.",
  "Прогресивна м’язова релаксація; дзвінки рідним за графіком замість постійного моніторингу новин.",
  "Толерантність до невизначеності: поведінкові експерименти.",
  "Проблемно-орієнтовані навички: що можна зробити для родини, а що ні.",
  "Профілактика рецидиву, план самостійних вправ.",
];
const PANIC_STEPS = (p: Person) => [
  "Психоосвіта: панічний напад — хибна тривога тіла; щоденник нападів.",
  "Інтероцептивна експозиція: біг на місці, дихання через трубочку; страх з 70 до 30.",
  "Ієрархія ситуацій, яких уникає; перше завдання — супермаркет удень.",
  `${g(p, "Проїхав", "Проїхала")} маршруткою дві зупинки без нападу; у щоденнику — 1 напад за тиждень.`,
  "Відмова від захисної поведінки: носити воду, сідати біля дверей.",
  "Метро в годину пік — тривога 40, без нападу.",
  "Підсумки курсу, план на випадок повернення симптомів.",
];

const anxiety: Builder = (p, r, v) => {
  const k = v % ARCHETYPE_COUNTS.anxiety;
  const panic = k === 4;
  const start = -between(r, 30, 130);
  const all = courseDays(r, start, 7, 8, 1);
  const days = trimFuture(all);
  const end = all[all.length - 1]!;
  const finished = end < -5;
  const gadFrom = between(r, 13, 17);
  const whoFrom = between(r, 7, 11);
  const t = (d: number) => (d - start) / Math.max(1, end - start);
  const steps = panic ? PANIC_STEPS(p) : GAD_STEPS;
  const visits: Visit[] = days.map((d, i) => {
    const measuring = i === 0 || i === 4 || (finished && d === end);
    const measures = measuring
      ? [
          M.gad7(i ? noisy(r, curve(gadFrom, between(r, 5, 8), t(d)), 1.5, 0, 21) : gadFrom),
          M.who5(i ? noisy(r, curve(whoFrom, between(r, 14, 18), t(d)), 1.5, 0, 25) : whoFrom),
          ...(i === 0 || d === end ? [M.phq9(i ? between(r, 3, 6) : between(r, 7, 11))] : []),
        ]
      : [];
    if (i === 0) {
      return visit(
        d,
        "primary",
        measures,
        (c) =>
          [
            "Первинний прийом.",
            panic
              ? "Скарги: напади паніки (серцебиття, нестача повітря, страх смерті) 2–3 рази на тиждень після обстрілу в тилу; уникає людних місць і транспорту."
              : "Скарги: постійна тривога за родину в прифронтовому місті, напруження, серцебиття, не може розслабитися навіть удома.",
            `Психічний стан: ${STATUS_CALM(p)} ${g(p, "Тривожний", "Тривожна")}, ${g(p, "напружений", "напружена")}. Суїцидальні думки заперечує.`,
            `Обстеження: GAD-7 — ${banded(c.score("gad7"), c.band("gad7"))}; WHO-5 — ${fmt(c.score("who5"))} з 25; PHQ-9 — ${fmt(c.score("phq9"))}.`,
            `План: КПТ ${panic ? "панічного розладу (інтероцептивна експозиція)" : "тривоги («час для тривоги», реструктуризація катастрофізації)"}, 8 сесій щотижня.`,
          ].join("\n"),
        { reason: panic ? "Накриває паніка, думаю, що серце" : "Постійно тривожно, не можу розслабитися" },
      );
    }
    return visit(d, "repeat", measures, (c) => {
      const line = `Сесія ${c.visitNo}. ${step(steps, c.visitNo)}`;
      return measuring ? `${line}\nКонтрольний замір: GAD-7 — ${fmt(c.score("gad7"))} (на початку — ${fmt(c.first("gad7"))}), WHO-5 — ${fmt(c.score("who5"))} з 25.` : line;
    });
  });
  const lastPast = lastPastOf(visits, start);
  return {
    ...NONE,
    episode: {
      openDay: start - 1,
      reason: panic
        ? "Панічні напади після обстрілу в тилу; уникає людних місць і транспорту."
        : pick(r, ["Постійна тривога за родину в прифронтовому місті, напруження, серцебиття.", "Тривога й безсоння після переведення до штабу."]),
      ...(finished ? { closeDay: end + 2, outcome: "improved" as const, outcomeText: (c: NoteContext) => `КПТ завершено: GAD-7 з ${fmt(c.first("gad7"))} до ${fmt(c.score("gad7"))}.` } : {}),
    },
    visits,
    decide: bandDecision("Підтверджено: виражена тривога, гострого ризику немає. КПТ за планом."),
    ...(k === 1
      ? {
          conclusion: {
            visit: 0,
            key: "gad7",
            text: (c: NoteContext) =>
              `Психологічне обстеження ${c.date(days[0]!)}.\nМетодики: GAD-7, WHO-5, PHQ-9.\nРезультати: GAD-7 — ${banded(c.score("gad7"), c.band("gad7"))} (з 21); WHO-5 — ${banded(c.score("who5"), c.band("who5"))} (з 25); PHQ-9 — ${banded(c.score("phq9"), c.band("phq9"))} (з 27).\nВисновок: виражена генералізована тривога зі зниженим благополуччям; депресивні прояви легкі.\nРекомендовано: КПТ тривоги, 8 сесій, контроль GAD-7 через 4 тижні.`,
          },
        }
      : {}),
    pending: finished ? [] : [{ key: "gad7", grantedDay: lastPast, dueDay: days.find((d) => d > 0) ?? lastPast + 14 }],
  };
};

const BUILDERS: Record<ArchetypeKey, Builder> = {
  ptsd,
  ptsdSlow,
  depression,
  adjustment,
  alcohol,
  insomnia,
  moralInjury,
  grief,
  burnout,
  crisis,
  stable,
  screening,
  psychosis,
  anxiety,
};

/**
 * Подписи портретов — для таблицы в описании выкатки и журнала наполнения.
 * Наружу, в интерфейс, не уходят: портрет — конструкция посева, а не
 * клиническая категория.
 */
export const ARCHETYPE_TITLES: Record<ArchetypeKey, string> = {
  ptsd: "бойовий ПТСР, покращення на терапії",
  ptsdSlow: "ПТСР з повільною відповіддю",
  depression: "депресивний епізод, часткова відповідь",
  adjustment: "розлад адаптації, що минає",
  alcohol: "шкідливе вживання алкоголю",
  insomnia: "порушення сну",
  moralInjury: "моральна травма",
  grief: "пролонгована реакція горя",
  burnout: "вигорання персоналу госпіталю",
  crisis: "гостра суїцидальна криза, план безпеки",
  stable: "стабільний стан після лікування",
  screening: "нове скерування, лише первинний скринінг",
  psychosis: "психотична симптоматика, переведення",
  anxiety: "тривожний розлад",
};

/** История человека — одна и та же при каждом прогоне: от номера, а не от часов */
export function storyOf(p: Person): Story {
  const r = rng(424_242 + p.ordinal * 104_729);
  return BUILDERS[p.archetype](p, r, p.variant);
}
