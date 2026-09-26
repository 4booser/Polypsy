import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ladderReadable, withLadder } from "../src/pages/people/data";
import type { StaffRow } from "../src/pages/people/model";

/**
 * Справочник сотрудников не зовёт маршрут, который заведомо откажет (волна
 * 12, разбор кода: «регулярно обращался к запрещённому маршруту, засоряя
 * аудит штатными отказами»).
 *
 * Главный путь — какой справочник читать, реестр или «кого я вправе
 * назначать», — решается по праву ещё с 88d6f7e и проверяется в
 * people.test.ts. Здесь — то, что оставалось: карточки прав суперадминов в
 * реестре администраторов и разделы карточки, которые открывает только
 * право patients.read.
 */

const row = (id: string, role: "superadmin" | "admin"): StaffRow =>
  ({ id, role, fullName: id, firstName: id, lastName: id, email: `${id}@x.y` }) as unknown as StaffRow;

describe("ступени лестницы в реестре администраторов", () => {
  const rows = [row("super-a", "superadmin"), row("head-1", "admin"), row("me", "admin"), row("super-b", "superadmin")];

  const spy = () => {
    const asked: string[] = [];
    const card = async (id: string) => {
      asked.push(id);
      return { roles: [{ code: id === "head-1" ? "head_of_department" : "specialist" }] };
    };
    return { asked, card };
  };

  test("не суперадмин не спрашивает карточку прав суперадмина — отказ известен заранее", async () => {
    const { asked, card } = spy();
    const out = await withLadder(rows, { id: "me", isSuper: false }, card);
    expect(asked.sort()).toEqual(["head-1", "me"]);
    // суперадмин остаётся в списке — просто без ступеней: в реестр его ставит класс, а не лестница
    expect(out.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(out.find((r) => r.id === "super-a")?.ladder).toBeUndefined();
    expect(out.find((r) => r.id === "head-1")?.ladder).toEqual(["head_of_department"]);
  });

  test("суперадмин спрашивает всех: ему сервер не отказывает", async () => {
    const { asked, card } = spy();
    await withLadder(rows, { id: "super-a", isSuper: true }, card);
    expect(asked.sort()).toEqual(["head-1", "me", "super-a", "super-b"]);
  });

  test("свою карточку прав открывает кто угодно — даже суперадмин из чужого кеша", () => {
    expect(ladderReadable({ id: "super-a", isSuper: false }, row("super-a", "superadmin"))).toBe(true);
    expect(ladderReadable({ id: "x", isSuper: false }, row("super-a", "superadmin"))).toBe(false);
    expect(ladderReadable({ id: "x", isSuper: false }, row("head-1", "admin"))).toBe(true);
  });

  test("отказ по одному человеку не роняет список", async () => {
    const card = async (id: string) => {
      if (id === "head-1") throw new Error("err.roleAboveYours");
      return { roles: [] };
    };
    const out = await withLadder(rows, { id: "me", isSuper: false }, card);
    expect(out).toHaveLength(4);
    expect(out.find((r) => r.id === "head-1")?.ladder).toBeUndefined();
  });
});

describe("разделы карточки под правом patients.read", () => {
  /*
   * Проверка по тексту экрана: запрос за пациентами и группами обязан стоять
   * за проверкой права. Без браузера иначе не проверить, а поломка здесь
   * тихая — отказ уходит в журнал доступа красной строкой, экран же просто
   * показывает «ничего нет».
   */
  const card = readFileSync(resolve(import.meta.dir, "../src/pages/people/StaffCard.tsx"), "utf8");

  test("группы пациентов спрашиваются только с правом", () => {
    expect(card).toMatch(/useResource\(\(\) => api\.patientGroups\(\), \[\], \{ enabled: canPatients \}\)/);
    expect(card).toMatch(/const canPatients = can\("patients\.read"\)/);
  });

  test("список пациентов монтируется только с правом", () => {
    expect(card).toMatch(/if \(can\("patients\.read"\)\) return <OwnPatientsList/);
    // запрос живёт только в OwnPatientsList: вызова вне него нет
    const calls = [...card.matchAll(/api\.respondents\(/g)].length;
    const list = card.slice(card.indexOf("function OwnPatientsList"));
    expect(calls).toBe(1);
    expect(list).toContain("api.respondents(");
  });
});
