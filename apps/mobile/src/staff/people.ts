import type { RespondentDynamics, Sex, Worklist } from "@quizzy/shared";
import { cache } from "../offline/cache";

/**
 * Кто этот человек — до того, как пришла его карта (волна 27).
 *
 * Карта пациента грузит всю динамику, и пока ответ шёл (секунды, на
 * холодной базе — десятки), в шапке не было даже имени: человек нажал на
 * строку «Мельник О. В.» и смотрел на пустую полосу. Имя при этом уже было
 * на устройстве — в строке, на которую нажали, в снимке обхода, в карте у
 * койки. Шапка теперь берёт его оттуда сразу.
 *
 * Здесь же — кто такой человек, за которого заполняют методику
 * (survey/[id].tsx): пол и возраст нужны нормам, а имя — чтобы не
 * перепутать. Экран заполнения брал их, перечитывая всю историю замеров,
 * хотя карта, с которой на него пришли, всё это уже знала.
 *
 * Память — только приложения, не диск, и только своего владельца: на общем
 * планшете следующий специалист шапок предыдущего не получает, а выход и
 * стирание устройства уносят их все (offline/logout.ts, api/client.ts) —
 * как черновики разбора (staff/reviewDrafts.ts). Запоминаются только те,
 * кого открыли, а не весь список.
 *
 * Модуль без react-native — проверяется тестом.
 */

export interface PersonHead {
  name: string;
  sex: Sex | null;
  /**
   * Возраст — только точный, из карты: в строке списка есть лишь год
   * рождения, и возраст по нему ошибается на год до дня рождения — шапка
   * показала бы одно число, а через секунду карта другое.
   */
  age: number | null;
  unit: string | null;
}

/** За кого заполняют: то, что уходит со сдачей для норм, — только из карты */
export interface FillSubject {
  fullName: string;
  sex: Sex | null;
  age: number | null;
}

interface Seen {
  head: PersonHead;
  /** Пришло из карты (имя, пол и возраст точные), а не из строки списка */
  card: boolean;
}

const seen = new Map<string, Seen>();
const keyOf = (owner: string, userId: string) => `${owner}\u0000${userId}`;

export const heads = {
  /**
   * Человек из строки, на которую нажали: имя и то, что строка знает
   * точно. Уже известное из карты строка не затирает.
   */
  noteRow(
    owner: string | null | undefined,
    userId: string,
    row: { name: string; sex?: Sex | null; unit?: string | null },
  ): void {
    if (!owner || !row.name) return;
    const prev = seen.get(keyOf(owner, userId));
    if (prev?.card) {
      if (row.unit && !prev.head.unit) seen.set(keyOf(owner, userId), { ...prev, head: { ...prev.head, unit: row.unit } });
      return;
    }
    seen.set(keyOf(owner, userId), {
      card: false,
      head: { name: row.name, sex: row.sex ?? prev?.head.sex ?? null, age: null, unit: row.unit ?? prev?.head.unit ?? null },
    });
  },
  /** Карта пришла: имя, пол и возраст — точные */
  noteCard(owner: string | null | undefined, userId: string, card: FillSubject & { unit?: string | null }): void {
    if (!owner) return;
    const prev = seen.get(keyOf(owner, userId));
    seen.set(keyOf(owner, userId), {
      card: true,
      head: { name: card.fullName, sex: card.sex, age: card.age, unit: card.unit ?? prev?.head.unit ?? null },
    });
  },
  /** Выход, конец сессии, стирание устройства: шапки уходят все — их открывал тот, кто вышел */
  forgetAll(): void {
    seen.clear();
  },
};

/** Карта у койки на устройстве (offline/cache.ts) — у неё имя, пол и возраст точные */
function savedCard(owner: string, userId: string): RespondentDynamics | null {
  const card = cache.patientCard(owner, userId)?.card as RespondentDynamics | undefined;
  return card?.fullName ? card : null;
}

/**
 * Шапка человека из того, что уже есть на устройстве: память экранов,
 * карта у койки, снимок обхода. Ничего нет — null, и шапка ждёт карту.
 */
export function personHead(owner: string | null | undefined, userId: string | undefined): PersonHead | null {
  if (!owner || !userId) return null;
  const mem = seen.get(keyOf(owner, userId));
  const card = savedCard(owner, userId);
  const row = (cache.rounds(owner)?.rows as Worklist | undefined)?.items?.find((i) => i.userId === userId);
  const exact = mem?.card ? mem.head : card ? { name: card.fullName, sex: card.sex ?? null, age: card.age ?? null } : null;
  const name = exact?.name ?? mem?.head.name ?? row?.userName;
  if (!name) return null;
  return {
    name,
    sex: exact?.sex ?? mem?.head.sex ?? null,
    age: exact?.age ?? null,
    unit: mem?.head.unit ?? row?.unit ?? null,
  };
}

/**
 * За кого заполняют — без запроса, если карта человека уже была: прочитана
 * в этой сессии или лежит на устройстве картой у койки. Строки списка
 * мало: возраста в ней нет, а без него нормы методики посчитаются не те.
 */
export function knownSubject(owner: string | null | undefined, userId: string | undefined): FillSubject | null {
  if (!owner || !userId) return null;
  const mem = seen.get(keyOf(owner, userId));
  if (mem?.card) return { fullName: mem.head.name, sex: mem.head.sex, age: mem.head.age };
  const card = savedCard(owner, userId);
  return card ? { fullName: card.fullName, sex: card.sex ?? null, age: card.age ?? null } : null;
}
