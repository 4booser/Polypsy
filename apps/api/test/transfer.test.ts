import { describe, expect, test } from "bun:test";
import { adminA, api, db, makeUser, root } from "./fixtures";
import { scaleNorms, scales, surveys } from "../src/db/schema";
import { eq } from "drizzle-orm";

/**
 * Перенос выверенной методики между экземплярами.
 *
 * Учреждение, которое сверило ключи подсчёта с пособием, не должно делать эту
 * работу заново в соседнем экземпляре. Но переносится не всё: часть сведений
 * принадлежит месту, и молча уехав, они начинают врать.
 */

/** Опубликованная методика из фикстур, выгруженная файлом */
async function exportOf(surveyId: string) {
  const res = await api(`/api/surveys/${surveyId}/export`, root.token);
  expect(res.status).toBe(200);
  return res.body;
}

describe("что уезжает", () => {
  test("методика возвращается с теми же ключами подсчёта", async () => {
    /*
     * Главное, ради чего перенос и нужен: ключи. «Импортировалось, но
     * считает иначе» — худший исход, потому что заметить его можно только
     * пересчитав вручную то, что и хотели не считать вручную.
     */
    const { sr45 } = await import("../src/instruments/sr45");
    const created = await api("/api/surveys", root.token, {
      method: "POST",
      body: JSON.stringify(sr45),
    });
    expect(created.status).toBe(201);

    const file = await exportOf(created.body.id);
    const imported = await api("/api/surveys/import", root.token, {
      method: "POST",
      body: JSON.stringify(file),
    });
    expect(imported.status).toBe(201);

    const again = await exportOf(imported.body.id);

    /*
     * Сверяем ключи, а не файл целиком: заголовки и идентификаторы законно
     * различаются, а вот раскладка пунктов по шкалам и их веса — нет.
     */
    const keysOf = (f: { scales: { code: string; key: { item: number; weight: number }[] }[] }) =>
      Object.fromEntries(
        f.scales.map((s) => [s.code, s.key.map((k) => `${k.item}:${k.weight}`).join(",")]),
      );
    expect(keysOf(again)).toEqual(keysOf(file));
  });

  test("полосы интерпретации и их пороги едут целиком", async () => {
    const { sadPersons } = await import("../src/instruments/sadPersons");
    const created = await api("/api/surveys", root.token, {
      method: "POST",
      body: JSON.stringify(sadPersons),
    });
    const file = await exportOf(created.body.id);
    const imported = await api("/api/surveys/import", root.token, {
      method: "POST",
      body: JSON.stringify(file),
    });
    const again = await exportOf(imported.body.id);

    const bandsOf = (f: { scales: { bands: { minScore: number; maxScore: number; severity: string }[] }[] }) =>
      f.scales.flatMap((s) => s.bands.map((b) => `${b.minScore}-${b.maxScore}:${b.severity}`));
    expect(bandsOf(again)).toEqual(bandsOf(file));
  });
});

describe("что не уезжает", () => {
  test("нормы местной выборки в файл не попадают", async () => {
    /*
     * T-балл значит разное относительно мирной популяции и относительно
     * своего госпиталя. Норма, посчитанная по выборке одного учреждения и
     * молча уехавшая в другое, означает, что второе считает своих людей по
     * чужой популяции и об этом не знает.
     */
    const { sr45 } = await import("../src/instruments/sr45");
    const created = await api("/api/surveys", root.token, {
      method: "POST",
      body: JSON.stringify(sr45),
    });

    const [scale] = await db.select().from(scales).where(eq(scales.surveyId, created.body.id));
    expect(scale).toBeDefined();
    await db.insert(scaleNorms).values([
      {
        id: crypto.randomUUID(),
        scaleId: scale!.id,
        sex: null,
        ageMin: null,
        ageMax: null,
        mean: 10,
        sd: 3,
        source: "посібник НПС, 2016",
      },
      {
        id: crypto.randomUUID(),
        scaleId: scale!.id,
        sex: "male",
        ageMin: null,
        ageMax: null,
        mean: 12,
        sd: 4,
        source: "локальная выборка, N=213, 2026-08",
      },
    ]);

    const file = await exportOf(created.body.id);
    const sources = file.scales.flatMap((s: { norms: { source: string | null }[] }) =>
      s.norms.map((n) => n.source ?? ""),
    );
    expect(sources.some((x: string) => x.includes("посібник"))).toBe(true);
    expect(sources.some((x: string) => x.includes("локальная выборка"))).toBe(false);
  });

  test("ссылка на батарею не уезжает в чужой экземпляр", async () => {
    /*
     * Идентификатор батареи принадлежит своему экземпляру; в чужом он либо не
     * найдётся, либо — что хуже — найдётся и укажет на другую батарею.
     */
    const { sr45 } = await import("../src/instruments/sr45");
    const created = await api("/api/surveys", root.token, {
      method: "POST",
      body: JSON.stringify(sr45),
    });
    const file = await exportOf(created.body.id);
    const links = file.scales.flatMap((s: { bands: { cascadeBatteryId: string | null }[] }) =>
      s.bands.map((b) => b.cascadeBatteryId),
    );
    expect(links.every((x: string | null) => x === null)).toBe(true);
  });

  test("отметка о сверке ключей не переносится", async () => {
    /*
     * Сверка — утверждение учреждения о том, что ключи сверены с пособием
     * именно здесь. Перенести её значило бы дать одному учреждению ручаться
     * за другое.
     */
    const { sr45 } = await import("../src/instruments/sr45");
    const created = await api("/api/surveys", root.token, {
      method: "POST",
      body: JSON.stringify(sr45),
    });
    await db
      .update(surveys)
      .set({ keysVerifiedAt: new Date().toISOString() })
      .where(eq(surveys.id, created.body.id));

    const file = await exportOf(created.body.id);
    expect(file.keysVerifiedAt).toBeUndefined();

    const imported = await api("/api/surveys/import", root.token, {
      method: "POST",
      body: JSON.stringify(file),
    });
    const [row] = await db.select().from(surveys).where(eq(surveys.id, imported.body.id));
    expect(row!.keysVerifiedAt).toBeNull();
  });

  test("импортированное приходит черновиком", async () => {
    // публикация — осознанное действие после сверки, а не следствие импорта
    const { sadPersons } = await import("../src/instruments/sadPersons");
    const created = await api("/api/surveys", root.token, {
      method: "POST",
      body: JSON.stringify(sadPersons),
    });
    const file = await exportOf(created.body.id);
    const imported = await api("/api/surveys/import", root.token, {
      method: "POST",
      body: JSON.stringify(file),
    });
    const [row] = await db.select().from(surveys).where(eq(surveys.id, imported.body.id));
    expect(row!.status).toBe("draft");
  });
});
