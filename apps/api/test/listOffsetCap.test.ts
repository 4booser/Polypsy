import { describe, expect, test } from "bun:test";
import { LIST_OFFSET_MAX } from "@quizzy/shared";
import { adminA, appApi, patient } from "./fixtures";

/**
 * Смещение у списков со страницами по смещению — не дальше 5 000 (#205).
 *
 * Пациенты, рассылки и входящие рассылки, каталог методик, статистические
 * модели принимали смещение до миллиона, как когда-то журнал (#202):
 * глубокая страница — перебор и сортировка (в базе) или расшифровка (в
 * приложении) всего отбора ради хвоста. Теперь предел — LIST_OFFSET_MAX,
 * глубже — поиск. Консоль за предел не просит (apps/web/test/listOffset.test.ts).
 * Запросы — ролью приложения: сотрудник и пациент.
 */

const LISTS = [
  { name: "пациенты", path: "/api/patients?limit=50", who: () => adminA.token },
  { name: "рассылки", path: "/api/mailings?limit=10", who: () => adminA.token },
  { name: "входящие рассылки", path: "/api/mailings/inbox?limit=50", who: () => patient.token },
  { name: "каталог методик", path: "/api/surveys?limit=10", who: () => adminA.token },
  { name: "статистические модели", path: "/api/stat-models?limit=10", who: () => adminA.token },
] as const;

describe("предел смещения списков (#205)", () => {
  test("предел — 5 000, как у журнала", () => {
    expect(LIST_OFFSET_MAX).toBe(5_000);
  });

  for (const list of LISTS) {
    test(`${list.name}: смещение за пределом — отказ`, async () => {
      for (const offset of [LIST_OFFSET_MAX + 1, 900_000]) {
        const res = await appApi(`${list.path}&offset=${offset}`, list.who());
        expect(res.status, `offset=${offset}: ${JSON.stringify(res.body)}`).toBe(400);
      }
    }, 30_000);

    test(`${list.name}: положительный контроль — смещение на пределе и первая страница`, async () => {
      for (const offset of [0, LIST_OFFSET_MAX]) {
        const res = await appApi(`${list.path}&offset=${offset}`, list.who());
        expect(res.status, `offset=${offset}: ${JSON.stringify(res.body)}`).toBe(200);
      }
    }, 30_000);
  }
});
