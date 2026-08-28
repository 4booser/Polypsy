import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Каждый экран консоли открывается и не падает.
 *
 * Смоук намеренно неглубокий: он не проверяет, что на экране правильные
 * числа — для этого есть тесты API. Он проверяет то, чего они увидеть не
 * могут: что страница отрисовалась, не бросила исключение в консоль браузера
 * и не показала вместо себя сообщение об ошибке.
 *
 * Ради этого он и нужен. Правка общего компонента ломает восемь экранов
 * молча, и до сих пор поймать это было нечем: из тридцати страниц смоуком
 * покрывались шесть.
 */

interface Screen {
  name: string;
  path: string;
  /** Что должно появиться, чтобы считать экран отрисованным */
  marker?: string;
}

/** Экраны без параметров — открываются как есть */
const STATIC: Screen[] = [
  { name: "сводка", path: "/" },
  { name: "очередь работы", path: "/worklist" },
  { name: "методики", path: "/surveys" },
  { name: "конструктор", path: "/constructor" },
  { name: "батареи", path: "/batteries" },
  { name: "расписание", path: "/schedules" },
  { name: "приглашения", path: "/invites" },
  { name: "сеансы киоска", path: "/kiosk-sessions" },
  { name: "группы", path: "/groups" },
  { name: "пациенты", path: "/patients" },
  { name: "сравнение", path: "/compare" },
  { name: "надзор", path: "/surveillance" },
  { name: "случаи риска", path: "/alerts" },
  { name: "направления", path: "/referrals" },
  { name: "состояние подразделения", path: "/unit-report" },
  { name: "библиотека", path: "/ui" },
];

/** Только суперадмину */
const SUPER: Screen[] = [
  { name: "учётные записи", path: "/users" },
  { name: "журнал доступа", path: "/audit" },
  { name: "описание API", path: "/api-docs" },
];

/**
 * Ошибки в консоли браузера — тоже отказ.
 *
 * Экран, который отрисовался, но бросил исключение, работает наполовину:
 * данные не приехали, обработчик не навесился. Молчаливо считать такое
 * успехом значит иметь смоук, который ничего не ловит.
 */
function watchConsole(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    // отказ сети на фоновом опросе — не поломка экрана
    if (text.includes("Failed to load resource")) return;
    errors.push(text);
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

async function open(page: import("@playwright/test").Page, s: Screen) {
  const errors = watchConsole(page);
  await page.goto(s.path);
  // ждём хоть что-то содержательное: заголовок, карточку или пустое состояние
  await page.locator(".page-head, .card, .empty, h1").first().waitFor({ timeout: 10_000 });
  await expect(page.locator(".error")).toHaveCount(0);
  expect(errors, `ошибки в консоли на ${s.path}`).toEqual([]);
}

test.describe("экраны специалиста", () => {
  for (const s of STATIC) {
    test(`«${s.name}» открывается`, async ({ page }) => {
      await login(page, "psy");
      await open(page, s);
    });
  }
});

test.describe("экраны суперадмина", () => {
  for (const s of SUPER) {
    test(`«${s.name}» открывается`, async ({ page }) => {
      await login(page, "superadmin");
      await open(page, s);
    });
  }
});

test.describe("экраны с параметром", () => {
  test("аналитика методики, ключи, бланк, нормы, доступ, заполнение", async ({ page }) => {
    await login(page, "psy");
    await page.goto("/surveys");
    const first = page.locator("table tbody tr td a").first();
    await first.waitFor();
    const href = await first.getAttribute("href");
    const id = href!.split("/").pop()!;

    for (const path of [
      `/surveys/${id}`,
      `/surveys/${id}/access`,
      `/surveys/${id}/norms`,
      `/surveys/${id}/administer`,
      `/constructor/${id}`,
    ]) {
      await open(page, { name: path, path });
    }
  });

  test("карта пациента и сводка консилиума", async ({ page }) => {
    await login(page, "psy");
    await page.goto("/patients");
    const first = page.locator("table tbody tr td a").first();
    await first.waitFor();
    const id = (await first.getAttribute("href"))!.split("/").pop()!;

    await open(page, { name: "динамика", path: `/patients/${id}` });
    await open(page, { name: "сводка", path: `/patients/${id}/summary` });
  });

  test("хронология пациента открывается и упорядочена", async ({ page }) => {
    await login(page, "psy");
    await page.goto("/patients");
    await page.locator("table tbody tr td a").first().click();
    // ссылка на хронологию живёт на сводке: туда приходят разбираться
    await page.getByRole("link", { name: "Сводка для консилиума" }).click();
    await page.getByRole("link", { name: "Хронология" }).click();
    await expect(page.locator(".page-head h1")).toHaveText("Хронология");
    await expect(page.locator(".tl-event").first()).toBeVisible();

    // дни идут от свежего к старому: историю читают с конца
    const days = await page.locator(".tl-date").allTextContents();
    expect([...days].sort().reverse()).toEqual(days);
    await expect(page.locator(".error")).toHaveCount(0);
  });
});
