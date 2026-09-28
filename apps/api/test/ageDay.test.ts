import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import {
  adminA,
  appRequest,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  makeUser,
  root,
  sr45,
  submitSurvey,
  surveys,
  type Person,
} from "./fixtures";
import { responses } from "../src/db/schema";
import { env } from "../src/env";

/**
 * Возраст — днём учреждения, а не часами процесса (волна 15, доработка
 * участка reports).
 *
 * По возрасту при сдаче выбираются нормы (T-балл, полоса) и пишется
 * возрастная полоса прохождения (respondent_age_band), по нему же SPSS
 * выгружает возраст. Общий ageAt брал числа месяца по поясу процесса — и у
 * момента, и у даты рождения, которую читал как полночь по Гринвичу. На
 * сервере в UTC человек, сдавший методику в свой двадцать пятый день
 * рождения в 01:30 по Киеву, получал полосу «до 25»; на сервере в Нью-Йорке
 * накануне дня рождения — уже «25–34».
 *
 * Два случая, оба — с разной стороны:
 *   «наступил»   — по Киеву день рождения уже наступил, по поясу процесса ещё нет;
 *   «не наступил» — по Киеву ещё нет, хотя числа процесса (полночь рождения,
 *                   сдвинутая западнее Гринвича) говорили «уже».
 * Каждый проверяется под поясом процесса UTC и Нью-Йорк: прежний расчёт
 * ошибался в первом под UTC и во втором под Нью-Йорком. Запросы — ролью
 * приложения.
 */

const PROCESS_ZONES = ["UTC", "America/New_York"] as const;
const savedTz = process.env.TZ;
let surveyId = "";

afterEach(() => {
  setSystemTime();
});

afterAll(async () => {
  setSystemTime();
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
  /* методика своя — не оставляем её в общих списках соседних файлов */
  await db.update(surveys).set({ status: "closed" }).where(eq(surveys.id, surveyId));
});

beforeAll(async () => {
  surveyId = crypto.randomUUID();
  await db.insert(surveys).values({
    id: surveyId,
    groupId: groupA,
    title: { uk: "Вік за днем установи", ru: "Возраст по дню учреждения", en: "Age by institution day" },
    administration: "self",
    status: "published",
    publishedAt: "2000-01-01T00:00:00.000Z",
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(surveyId, createSurveySchema.parse(sr45), adminA.id, "ageDay");
}, 30_000);

/** Календарный день момента в поясе — независимо от кода, который проверяем */
const dayIn = (at: Date, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/** Время на часах пояса: «01:30» */
const clockIn = (at: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(at);

/**
 * Последний прошедший момент, когда на часах учреждения было 01:30, — не
 * раньше чем за сутки. Прошлый, а не будущий: строки журнала и прохождения,
 * датированные будущим, путали бы соседние файлы, а вчерашние — нет.
 */
function lastInstitutionHalfPastOne(): Date {
  const at = new Date(Math.floor(Date.now() / 1_800_000) * 1_800_000);
  for (let i = 0; i < 50; i++) {
    if (clockIn(at, env.institutionTz) === "01:30") return at;
    at.setTime(at.getTime() - 1_800_000);
  }
  throw new Error("01:30 по часам учреждения за сутки не нашлось");
}

/** Дата рождения: тот же день и месяц, что `day`, на `years` лет раньше */
function bornYearsBefore(day: string, years: number): string {
  const [y, m, d] = day.split("-");
  return `${Number(y) - years}-${m}-${d}`;
}

describe("сдача: полоса возраста — по дню учреждения", () => {
  for (const zone of PROCESS_ZONES) {
    test(`двадцать пятый день рождения в 01:30 по Киеву, пояс процесса ${zone}`, async () => {
      const moment = lastInstitutionHalfPastOne();
      const kyivDay = dayIn(moment, env.institutionTz);
      /* 29 февраля в невисокосный год рождения не бывает — такой прогон проверять нечем */
      if (kyivDay.endsWith("-02-29")) return;
      expect(dayIn(moment, zone), "пояс процесса обязан быть ещё во вчерашнем дне").not.toBe(kyivDay);

      /*
       * Часы процесса — на тот момент: сдача ставит время по ним
       * (completionTime), и возраст считается на него. Учётная запись и
       * токен — тоже в тот момент; учётки фикстур действуют с 1970 года.
       */
      process.env.TZ = zone;
      setSystemTime(moment);
      const person = await makeUser("user", `age-${zone}-${crypto.randomUUID()}@test`, {
        birthDate: bornYearsBefore(kyivDay, 25),
      });
      const done = await submitSurvey(surveyId, person.token);
      expect(done.status, JSON.stringify(done.body)).toBe(201);
      setSystemTime();

      const [row] = await db
        .select({ band: responses.respondentAgeBand, at: responses.submittedAt })
        .from(responses)
        .where(eq(responses.id, done.body.id));
      expect(row!.at).toBe(moment.toISOString());
      expect(row!.band).toBe("25-34");
    });
  }
});

describe("SPSS: возраст на день сдачи по календарю учреждения", () => {
  /*
   * Сдачи — строками базы с заданным временем: здесь проверяется выгрузка,
   * а не сдача, и момент нужен точный.
   */
  const cases = [
    /* 27.09 22:30 UTC — в Киеве 28.09 01:30: двадцать пять уже есть */
    { key: "reached", born: "2001-09-28", at: "2026-09-27T22:30:00.000Z", age: 25 },
    /* 28.09 12:00 UTC — в Киеве 28.09 15:00: до дня рождения ещё сутки */
    { key: "ahead", born: "2001-09-29", at: "2026-09-28T12:00:00.000Z", age: 24 },
  ] as const;
  const made: Record<string, { person: Person; responseId: string }> = {};

  beforeAll(async () => {
    for (const c of cases) {
      const person = await makeUser("user", `age-spss-${c.key}-${crypto.randomUUID()}@test`, { birthDate: c.born });
      const responseId = crypto.randomUUID();
      await db.insert(responses).values({
        id: responseId,
        surveyId,
        userId: person.id,
        status: "completed",
        startedAt: c.at,
        submittedAt: c.at,
      } as never);
      made[c.key] = { person, responseId };
    }
  });

  for (const zone of PROCESS_ZONES) {
    test(`пояс процесса ${zone}`, async () => {
      process.env.TZ = zone;
      const res = await appRequest(`/api/spss/surveys/${surveyId}/data.csv?profile=full`, {
        headers: { Authorization: `Bearer ${root.token}` },
      });
      const text = (await res.text()).replace(/^﻿/, "");
      expect(res.status, text.slice(0, 200)).toBe(200);
      const [head, ...lines] = text.split(/\r\n/);
      const columns = head!.split(",");
      const caseAt = columns.indexOf("case_id");
      const ageAt = columns.indexOf("age");
      expect(ageAt).toBeGreaterThan(-1);
      for (const c of cases) {
        const line = lines.find((l) => l.split(",")[caseAt] === made[c.key]!.responseId);
        expect(line, `${c.key}: строки нет`).toBeDefined();
        expect(line!.split(",")[ageAt], c.key).toBe(String(c.age));
      }
    });
  }
});
