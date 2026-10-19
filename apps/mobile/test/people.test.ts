import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resetStore } from "./store.mock";
import { json, loadClient, serve, signIn, useFakeServer } from "./client.harness";
import { cache } from "../src/offline/cache";
import { forgetWipe } from "../src/offline/owner";
import { normOf } from "../src/staff/model";
import { heads, knownSubject, personHead } from "../src/staff/people";

/**
 * Кто этот человек, пока его карта ещё идёт (волна 27, staff/people.ts).
 *
 * Было: карта пациента до ответа динамики показывала пустую полосу без
 * имени, а экран «Заповнити за пацієнта» перечитывал всю историю замеров
 * ради имени, пола и возраста — и до ответа показывал «Заповнюєте за: …» с
 * рабочей кнопкой «Почати».
 */

useFakeServer();

const A = "staff-a";
const B = "staff-b";
const P = "patient-1";
const CARD = { userId: P, fullName: "Мельник Оксана Василівна", email: "p@x", sex: "female", age: 41, surveys: [] };

beforeEach(() => {
  resetStore();
  forgetWipe();
  heads.forgetAll();
});

describe("шапка человека до карты", () => {
  test("строка, на которую нажали: имя, пол, подразделение — без возраста", () => {
    heads.noteRow(A, P, { name: "Мельник О. В.", sex: "female", unit: "2 рота" });
    expect(personHead(A, P)).toEqual({ name: "Мельник О. В.", sex: "female", age: null, unit: "2 рота" });
    // строки мало, чтобы заполнять за человека: возраста нет, нормы посчитались бы не те
    expect(knownSubject(A, P)).toBeNull();
  });

  test("прочитанная карта — точные имя, пол и возраст; строка их потом не затирает", () => {
    heads.noteCard(A, P, { fullName: CARD.fullName, sex: "female", age: 41 });
    heads.noteRow(A, P, { name: "Мельник О. В.", sex: null, unit: "2 рота" });
    expect(personHead(A, P)).toEqual({ name: CARD.fullName, sex: "female", age: 41, unit: "2 рота" });
    expect(knownSubject(A, P)).toEqual({ fullName: CARD.fullName, sex: "female", age: 41 });
  });

  test("карта у койки на устройстве — тоже точный источник; снимок обхода — только имя", () => {
    cache.saveRounds(A, { items: [{ userId: "p2", userName: "Шевчук Т. І.", unit: "Хірургія" }] });
    expect(personHead(A, "p2")).toEqual({ name: "Шевчук Т. І.", sex: null, age: null, unit: "Хірургія" });
    expect(knownSubject(A, "p2")).toBeNull();

    cache.savePatientCard(A, P, CARD);
    expect(knownSubject(A, P)).toEqual({ fullName: CARD.fullName, sex: "female", age: 41 });
    expect(personHead(A, P)?.age).toBe(41);
  });

  test("чужому специалисту и без владельца — ничего", () => {
    heads.noteCard(A, P, { fullName: CARD.fullName, sex: "female", age: 41 });
    cache.savePatientCard(A, P, CARD);
    expect(personHead(B, P)).toBeNull();
    expect(knownSubject(B, P)).toBeNull();
    expect(personHead(null, P)).toBeNull();
    heads.noteRow(null, P, { name: "x" });
    expect(personHead(B, P)).toBeNull();
  });

  test("выход уносит запомненные шапки — следующий на планшете их не получает", async () => {
    const api = await loadClient();
    signIn(A);
    serve(() => json(200, { ok: true }));
    heads.noteCard(A, P, { fullName: CARD.fullName, sex: "female", age: 41 });

    await api.signOut();

    expect(personHead(A, P), "шапка вышедшего пережила выход").toBeNull();
    expect(knownSubject(A, P)).toBeNull();
  });

  test("стирание устройства уносит запомненные шапки", async () => {
    const api = await loadClient();
    signIn(A);
    serve((path) => (path === "/api/devices/checkin" ? json(200, { wipe: true }) : json(200, { ok: true })));
    heads.noteCard(A, P, { fullName: CARD.fullName, sex: "female", age: 41 });

    expect(await api.deviceCheckin(null)).toBe(true);

    expect(personHead(A, P), "шапка пережила стирание").toBeNull();
  });
});

/**
 * Норма разбора — со случаем (волна 27).
 *
 * Было: обход, пацієнти, сигнали и обе карты грузили весь список методик
 * ради одного поля — alertEscalateMinutes; карта — при каждом открытии.
 * Очередь случаев теперь сама отдаёт норму (AlertCase.escalateMinutes).
 */
describe("норма разбора", () => {
  test("берётся у случая; нет поля (сервер старше) — часы без нормы", () => {
    expect(normOf({ escalateMinutes: 240 })).toBe(240);
    expect(normOf({ escalateMinutes: null })).toBeNull();
    expect(normOf({})).toBeNull();
  });

  test("экраны сотрудника не грузят список методик ради нормы", () => {
    const screens = [
      "../app/(app)/patients.tsx",
      "../app/(app)/alerts.tsx",
      "../app/rounds/[userId].tsx",
      "../app/analytics/patients/[userId].tsx",
      "../src/staff/data.ts",
      "../src/staff/ReviewSheet.tsx",
      "../src/staff/ui.tsx",
    ];
    const read = (file: string) => readFileSync(resolve(import.meta.dir, file), "utf8");
    for (const file of screens) {
      const source = read(file);
      expect(source.includes("listSurveys("), `${file}: список методик ради нормы`).toBe(false);
      expect(source.includes("useSurveyIndex"), file).toBe(false);
      expect(source.includes("alertEscalateMinutes"), file).toBe(false);
    }
    /*
     * Обход — первый экран сотрудника — греет каталог на устройство один раз
     * за сессию: «Заповнити» у койки без сети берёт методики из кэша. Это
     * единственный оставшийся запрос списка, и он не ради нормы.
     */
    const rounds = read("../app/(app)/rounds.tsx");
    expect(rounds.match(/listSurveys\(/g)?.length ?? 0).toBe(1);
    expect(rounds.includes("useSurveyIndex")).toBe(false);
  });

  test("заполнение за пациента не перечитывает его историю целиком", () => {
    const screen = readFileSync(resolve(import.meta.dir, "../app/survey/[id].tsx"), "utf8");
    expect(screen.includes("roundsCard("), "карта у койки читается заново ради имени, пола и возраста").toBe(false);
    expect(screen).toContain("useFillSubject(");
    // «Почати» ждёт человека
    expect(screen).toMatch(/disabled=\{!!onBehalfOf && !patient\}/);
  });
});
