import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  adminA,
  appRequest,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  groupAdmins,
  makeUser,
  sr45,
  surveys,
  type Person,
} from "./fixtures";
import { appointments, departments, episodes, patientNotes, responses, slots } from "../src/db/schema";
import { encryptField } from "../src/lib/crypto";
import { chartHistory } from "../src/lib/chartHistory";
import { ageOnDay, printCalendarDay, printDay, printStamp } from "../src/lib/printDates";
import { env } from "../src/env";

/**
 * Печатная амбулаторная карта (волна 15, внешний разбор, пп. 20–21).
 *
 * п. 20. Было: визиты и прохождения — последние 200, подписанные записи —
 * последние 100; карта об этом молчала и выглядела полной. У ревьюера из 101
 * записи напечатано 100, самой старой нет. Стало: карта полная — история
 * читается порциями (lib/chartHistory.ts), ничего не отрезается.
 *
 * п. 21. Было: даты карты — toLocaleDateString по поясу ПРОЦЕССА. На
 * сервере в UTC обращение, открытое 28.09 в 00:30 по Киеву, печаталось
 * 27.09; дата рождения при поясе западнее Гринвича уезжала на день назад.
 * Стало: моменты — в поясе учреждения (приём — в поясе своего отделения, как
 * справка о посещении), дата рождения — как записана, без перевода поясов.
 * То же в выписке по обращению и в листе прохождения (время сдачи было по
 * Гринвичу, возраст — по часам процесса).
 *
 * Пояс процесса в этом файле — Нью-Йорк: так расхождение видно на любой
 * машине, где бы ни шёл прогон. Запросы — ролью приложения.
 */

const TAG = crypto.randomUUID().slice(0, 8);
const NOTE = (i: number) => `NOTE-${TAG}-${String(i).padStart(3, "0")}`;
const REASON = `TZ-MARKER-${TAG}`;
/** 28.09 00:30 по Киеву, 27.09 17:30 по Нью-Йорку */
const LATE_EVENING_UTC = "2026-09-27T21:30:00.000Z";
/** 28.09 01:00 в Токио, 27.09 19:00 по Киеву */
const TOKYO_MORNING_UTC = "2026-09-27T16:00:00.000Z";
/** 30.04 по Киеву — накануне дня рождения (01.05), в Нью-Йорке тоже 30.04 */
const EVE_OF_BIRTHDAY_UTC = "2026-04-30T12:00:00.000Z";

const VISITS = 205;
/** Подписанные записи: 1…104 — по дню, 105 — поздним вечером, 106…115 — в одну миллисекунду */
const LATE_NOTE = 105;
const NOTES = 115;
/** Завершённые прохождения: 205 по дню, одно поздним вечером, одно накануне дня рождения */
const RESPONSES = 207;

let specialist: Person;
let patient: Person;
let surveyId = "";
let versionId = "";
let kyivDept = "";
let tokyoDept = "";
let episodeId = "";
let lateResponseId = "";
let eveResponseId = "";
let savedTz: string | undefined;

/** День момента в поясе — ожидание теста, посчитанное независимо от кода печати */
const dayIn = (iso: string, tz: string) => new Date(iso).toLocaleDateString("uk-UA", { timeZone: tz });

beforeAll(async () => {
  savedTz = process.env.TZ;
  process.env.TZ = "America/New_York";

  specialist = await makeUser("admin", `chart-spec-${TAG}@test`);
  /*
   * Администратор группы методики: под ролью приложения прохождения чужой
   * группы политика строк ему не покажет, и раздел «Обследования» был бы
   * пуст по зоне, а не по лимиту.
   */
  await db.insert(groupAdmins).values({ groupId: groupA, userId: specialist.id, addedBy: adminA.id });
  patient = await makeUser("user", `chart-p-${TAG}@test`, { birthDate: "1990-05-01" });

  kyivDept = `chart-kyiv-${TAG}`;
  tokyoDept = `chart-tokyo-${TAG}`;
  await db.insert(departments).values([
    { id: kyivDept, title: { uk: "Карта, Київ", ru: "Карта, Киев" }, timezone: "Europe/Kyiv" },
    { id: tokyoDept, title: { uk: "Карта, Токіо", ru: "Карта, Токио" }, timezone: "Asia/Tokyo" },
  ] as never);

  surveyId = crypto.randomUUID();
  await db.insert(surveys).values({
    id: surveyId,
    groupId: groupA,
    title: { uk: `Карта ${TAG}`, ru: `Карта ${TAG}`, en: `Chart ${TAG}` },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    showResultsToPatient: true,
    createdBy: adminA.id,
  } as never);
  versionId = await createVersion(surveyId, createSurveySchema.parse(sr45), adminA.id, "printedChart");

  /* приёмы: по одному в день с 2020 года, давно прошедшие */
  const slotRows = [];
  const visitRows = [];
  for (let i = 0; i < VISITS; i++) {
    const start = new Date(Date.UTC(2020, 0, 1 + i, 8));
    const slotId = `chart-slot-${TAG}-${i}`;
    slotRows.push({
      id: slotId,
      specialistId: specialist.id,
      departmentId: kyivDept,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
      status: "closed",
    });
    visitRows.push({ id: `chart-visit-${TAG}-${i}`, slotId, patientId: patient.id, specialistId: specialist.id, status: "done" });
  }
  /* и два поздним вечером по Гринвичу: в Киеве и в Токио уже завтра */
  for (const [key, dept, at] of [
    ["late-kyiv", kyivDept, LATE_EVENING_UTC],
    ["late-tokyo", tokyoDept, TOKYO_MORNING_UTC],
  ] as const) {
    slotRows.push({
      id: `chart-slot-${TAG}-${key}`,
      specialistId: specialist.id,
      departmentId: dept,
      startsAt: at,
      endsAt: new Date(Date.parse(at) + 1_800_000).toISOString(),
      status: "closed",
    });
    visitRows.push({
      id: `chart-visit-${TAG}-${key}`,
      slotId: `chart-slot-${TAG}-${key}`,
      patientId: patient.id,
      specialistId: specialist.id,
      status: "done",
    });
  }
  await db.insert(slots).values(slotRows as never);
  await db.insert(appointments).values(visitRows as never);

  /*
   * Подписанные записи: NOTE-…-001 — самая старая. Десять последних — в одну
   * миллисекунду (микросекунды разные, у четырёх и они одинаковые): на стыке
   * порций по округлённому до миллисекунды ключу такие терялись бы.
   */
  const createdAt = (i: number) => {
    if (i === LATE_NOTE) return LATE_EVENING_UTC;
    if (i > LATE_NOTE) return `2021-06-01 10:00:00.123${String(i > LATE_NOTE + 6 ? 999 : 100 + i).padStart(3, "0")}+00`;
    return new Date(Date.UTC(2021, 0, i)).toISOString();
  };
  await db.insert(patientNotes).values(
    Array.from({ length: NOTES }, (_, k) => {
      const i = k + 1;
      return {
        id: `chart-note-${TAG}-${String(i).padStart(3, "0")}`,
        userId: patient.id,
        version: i,
        text: encryptField(NOTE(i))!,
        status: "signed",
        createdBy: specialist.id,
        signedBy: specialist.id,
        signedAt: new Date(Date.UTC(2021, 0, i)).toISOString(),
        createdAt: createdAt(i),
      };
    }) as never,
  );

  /* завершённые прохождения своей методики */
  lateResponseId = `chart-resp-${TAG}-late`;
  eveResponseId = `chart-resp-${TAG}-eve`;
  await db.insert(responses).values(
    [
      ...Array.from({ length: RESPONSES - 2 }, (_, i) => ({
        id: `chart-resp-${TAG}-${i}`,
        at: new Date(Date.UTC(2022, 0, 1 + i, 9)).toISOString(),
      })),
      { id: lateResponseId, at: LATE_EVENING_UTC },
      { id: eveResponseId, at: EVE_OF_BIRTHDAY_UTC },
    ].map(({ id, at }) => ({
      id,
      surveyId,
      versionId,
      userId: patient.id,
      status: "completed",
      startedAt: at,
      submittedAt: at,
    })) as never,
  );

  episodeId = `chart-ep-${TAG}`;
  await db.insert(episodes).values({
    id: episodeId,
    patientId: patient.id,
    leadSpecialistId: specialist.id,
    departmentId: kyivDept,
    reasonEnc: encryptField(REASON),
    createdBy: specialist.id,
    openedAt: LATE_EVENING_UTC,
  } as never);
  await db.update(appointments).set({ episodeId }).where(eq(appointments.id, `chart-visit-${TAG}-late-kyiv`));
}, 120_000);

afterAll(async () => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
  /* методика своя — не оставляем её в общих списках соседних файлов */
  await db.update(surveys).set({ status: "closed" }).where(eq(surveys.id, surveyId));
  /* обращение закрываем: «открытое обращение» — живое состояние в общих списках */
  await db.update(episodes).set({ closedAt: new Date().toISOString(), outcomeKind: "stable" }).where(eq(episodes.id, episodeId));
});

async function sheet(path: string, token = specialist.token) {
  const res = await appRequest(path, { headers: { Authorization: `Bearer ${token}`, "Accept-Language": "uk" } });
  return { status: res.status, text: await res.text() };
}

/** Раздел карты от своего заголовка до следующего */
function section(html: string, title: string): string {
  const from = html.indexOf(`<h2>${title}</h2>`);
  if (from < 0) return "";
  const next = html.indexOf("<h2>", from + 4);
  return html.slice(from, next < 0 ? undefined : next);
}

const rowsIn = (part: string) => (part.match(/<tr><td>/g) ?? []).length;

describe("карта полная (п. 20)", () => {
  test("ни приёмы, ни записи, ни обследования не обрезаны", async () => {
    const chart = await sheet(`/api/reports/patients/${patient.id}/chart`);
    expect(chart.status, chart.text.slice(0, 300)).toBe(200);

    const notes = chart.text.match(new RegExp(`NOTE-${TAG}-\\d{3}`, "g")) ?? [];
    expect(notes.length).toBe(NOTES);
    expect(new Set(notes).size).toBe(NOTES);
    expect(chart.text).toContain(NOTE(1));

    expect(rowsIn(section(chart.text, "Прийоми"))).toBe(VISITS + 2);
    expect(rowsIn(section(chart.text, "Обстеження"))).toBe(RESPONSES);
    /* самый старый приём и самое старое обследование — на месте */
    expect(section(chart.text, "Прийоми")).toContain(dayIn("2020-01-01T08:00:00.000Z", "Europe/Kyiv"));
    expect(section(chart.text, "Обстеження")).toContain(dayIn("2022-01-01T09:00:00.000Z", env.institutionTz));
  });

  test("порции любого размера дают ту же историю: без потерь и повторов на стыках", async () => {
    const whole = await chartHistory(patient.id);
    const ids = (h: typeof whole) => ({
      visits: h.visits.map((v) => v.a.id),
      notes: h.notes.map((n) => n.n.id),
      responses: h.responses.map((r) => r.r.id),
    });
    const expected = ids(whole);
    expect(expected.visits.length).toBe(VISITS + 2);
    expect(expected.notes.length).toBe(NOTES);
    expect(expected.responses.length).toBe(RESPONSES);
    /* по одной строке — стык после каждой, в том числе внутри одной миллисекунды */
    for (const size of [1, 3, 7, 100]) {
      expect(ids(await chartHistory(patient.id, size)), `порция ${size}`).toEqual(expected);
    }
  });
});

describe("даты карты — в поясе учреждения, а не процесса (п. 21)", () => {
  test("проверка имеет смысл: день учреждения и день процесса расходятся", () => {
    expect(dayIn(LATE_EVENING_UTC, env.institutionTz)).not.toBe(new Date(LATE_EVENING_UTC).toLocaleDateString("uk-UA"));
  });

  test("обращение, приём, запись, обследование — днём учреждения; рождение — как записано", async () => {
    const chart = await sheet(`/api/reports/patients/${patient.id}/chart`);
    expect(chart.status).toBe(200);
    const kyivDay = dayIn(LATE_EVENING_UTC, env.institutionTz);

    const episodesPart = section(chart.text, "Звернення");
    expect(episodesPart).toContain(`<tr><td>${kyivDay} — триває</td><td>${REASON}</td>`);

    expect(chart.text).toContain("01.05.1990 р. н.");

    /* приём — днём своего отделения: киевский — 28.09, токийский — тоже 28.09, хотя в Киеве ещё 27.09 */
    const visitsPart = section(chart.text, "Прийоми");
    expect(visitsPart).toContain(`<tr><td>${dayIn(LATE_EVENING_UTC, "Europe/Kyiv")}</td>`);
    expect(visitsPart).toContain(`<tr><td>${dayIn(TOKYO_MORNING_UTC, "Asia/Tokyo")}</td>`);

    expect(chart.text).toMatch(
      new RegExp(`${NOTE(LATE_NOTE)}<div class="meta">[^<]*, ${kyivDay.replaceAll(".", "\\.")}</div>`),
    );

    expect(section(chart.text, "Обстеження")).toContain(`<tr><td>${kyivDay}</td>`);
  });

  test("выписка по обращению — тоже днём учреждения", async () => {
    const extract = await sheet(`/api/reports/episodes/${episodeId}`);
    expect(extract.status, extract.text.slice(0, 300)).toBe(200);
    const kyivDay = dayIn(LATE_EVENING_UTC, env.institutionTz);
    expect(extract.text).toContain(`${kyivDay} — триває`);
    expect(section(extract.text, "Прийоми")).toContain(`<tr><td>${kyivDay}</td>`);
  });

  test("лист прохождения — время сдачи по часам учреждения, а не по Гринвичу", async () => {
    /* лист печатает сам обследуемый (методика показывает ему результаты) */
    const report = await sheet(`/api/reports/responses/${lateResponseId}`, patient.token);
    expect(report.status, report.text.slice(0, 300)).toBe(200);
    expect(report.text).toContain(printStamp(LATE_EVENING_UTC, env.institutionTz));
    expect(report.text).not.toContain("2026-09-27 21:30");
  });

  test("лист прохождения — возраст по календарю, а не по часам процесса", async () => {
    /*
     * Накануне дня рождения — ещё 35. Общий ageAt по часам Нью-Йорка
     * превращал «1990-05-01» в 30 апреля и печатал 36.
     */
    const report = await sheet(`/api/reports/responses/${eveResponseId}`, patient.token);
    expect(report.status).toBe(200);
    expect(report.text).toContain("35 років на момент обстеження");
  });
});

describe("даты листа — функциями", () => {
  test("дата рождения не переводится между поясами", () => {
    expect(printCalendarDay("1990-05-01", "uk")).toBe("01.05.1990");
    expect(printCalendarDay("1990-05-01", "en")).toBe("01/05/1990");
    /* не тот вид — как есть, лист не падает */
    expect(printCalendarDay("01.05.1990", "uk")).toBe("01.05.1990");
  });

  test("момент — днём и временем заданного пояса", () => {
    expect(printDay(LATE_EVENING_UTC, "uk", "Europe/Kyiv")).toBe("28.09.2026");
    expect(printDay(LATE_EVENING_UTC, "uk", "UTC")).toBe("27.09.2026");
    expect(printStamp(LATE_EVENING_UTC, "Europe/Kyiv")).toBe("2026-09-28 00:30");
    expect(printStamp("2026-01-15T22:30:00.000Z", "Europe/Kyiv")).toBe("2026-01-16 00:30");
  });

  test("возраст — по календарю дня учреждения", () => {
    expect(ageOnDay("1990-05-01", EVE_OF_BIRTHDAY_UTC, "Europe/Kyiv")).toBe(35);
    expect(ageOnDay("1990-05-01", "2026-04-30T21:30:00.000Z", "Europe/Kyiv")).toBe(36);
    expect(ageOnDay("1990-05-01", "2026-04-30T21:30:00.000Z", "UTC")).toBe(35);
    expect(ageOnDay("1992-02-29", "2026-02-28T12:00:00.000Z", "Europe/Kyiv")).toBe(33);
    expect(ageOnDay("1992-02-29", "2026-03-01T12:00:00.000Z", "Europe/Kyiv")).toBe(34);
    expect(ageOnDay(null, EVE_OF_BIRTHDAY_UTC)).toBeNull();
    expect(ageOnDay("2030-01-01", EVE_OF_BIRTHDAY_UTC)).toBeNull();
  });
});
