import { expect, test } from "@playwright/test";
import { goCaseCard, login, openSeededPatient, SEED_SURVEY } from "./helpers";

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

/**
 * Экраны без параметров — открываются как есть.
 *
 * Только то, что в приложении есть. Здесь висели «/schedules», «/compare»,
 * «/surveillance» и «/unit-report» — пути от удалённых экранов; ни один Route
 * их не обслуживает, и маршрутизатор отправляет неизвестный путь на сводку.
 * Проверки на них были вечно зелёными и проверяли сводку по четвёртому разу,
 * а в отчёте выглядели как покрытие четырёх экранов.
 */
const STATIC: Screen[] = [
  { name: "сводка", path: "/" },
  { name: "очередь работы", path: "/worklist" },
  { name: "методики", path: "/surveys" },
  { name: "конструктор", path: "/constructor" },
  { name: "батареи", path: "/batteries" },
  { name: "приглашения", path: "/invites" },
  { name: "группы методик", path: "/groups" },
  { name: "группы пациентов", path: "/patient-groups" },
  { name: "пациенты", path: "/patients" },
  { name: "случаи риска", path: "/alerts" },
  { name: "направления", path: "/referrals" },
  { name: "когорты", path: "/cohorts" },
  { name: "библиотека", path: "/ui" },
];

/** Только суперадмину */
const SUPER: Screen[] = [
  /*
   * Перечень и форма аналитических моделей читают /api/decisions/rules,
   * закрытый правом alerts.review; у суперадмина оно есть по построению, а
   * есть ли у «psy» из посева — от посева и зависит. Смоук не должен падать
   * от состава прав тестовой учётки.
   */
  { name: "перечень аналитики", path: "/analytics" },
  { name: "новая аналитическая модель", path: "/analytics/new" },
  /* учётки и журнал — вкладки техпанели с волны 10; /users и /audit только перенаправляют сюда */
  { name: "учётные записи", path: "/ops/users" },
  { name: "сессии", path: "/ops/sessions" },
  { name: "журнал доступа", path: "/ops/audit" },
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
  await page.locator("h1, .card, [data-panel], .empty").first().waitFor({ timeout: 10_000 });
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
    /*
     * Методика названа поимённо, а не «первая строка каталога».
     *
     * Каталог упорядочен по времени создания, и первой встаёт методика,
     * которую только что завёл сценарий конструктора: у неё нет ни
     * прохождений, ни норм, ни ключей — то есть половина проверяемых экранов
     * показала бы пустое состояние, ничего не проверив.
     */
    const row = page.locator("table tbody tr td a").filter({ hasText: SEED_SURVEY }).first();
    await row.waitFor();
    const href = await row.getAttribute("href");
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
    const first = await openSeededPatient(page);
    const id = (await first.getAttribute("href"))!.split("/").pop()!;

    /*
     * Два разных экрана, а не один с вкладками: «/patients/:id» с волны 6 —
     * карточка по кадру f19, а сводка консилиума с динамикой переехала в
     * клиническую карту «/patients/:id/case». Прежний адрес «/summary»
     * оставлен в проверке намеренно: он теперь перенаправление (App.tsx), и
     * ссылки на него ходят по переписке и в чужих закладках.
     */
    await open(page, { name: "карточка пациента", path: `/patients/${id}` });
    await open(page, { name: "клиническая карта", path: `/patients/${id}/case` });
    await open(page, { name: "сводка", path: `/patients/${id}/summary` });
  });

  test("хронология пациента открывается и упорядочена", async ({ page }) => {
    await login(page, "psy");
    await (await openSeededPatient(page)).click();
    // хронология осталась в клинической карте, за шестерёнкой — см. goCaseCard
    await goCaseCard(page);
    /*
     * Дожидаемся карты, ПОТОМ читаем имя. Без ожидания заголовок читается
     * ещё со списка — «Пациенты», — и проверка сравнивает вкладку со
     * списком, а не с картой.
     */
    const tab = page.getByRole("link", { name: "Хронология" });
    await tab.waitFor();
    const name = (await page.locator("h1").textContent())!.trim();
    await tab.click();
    await expect(page.locator("h1")).toHaveText(name);
    await expect(page.locator(".tl-event").first()).toBeVisible();

    // дни идут от свежего к старому: историю читают с конца
    const days = await page.locator(".tl-date").allTextContents();
    expect([...days].sort().reverse()).toEqual(days);
    await expect(page.locator(".error")).toHaveCount(0);
  });
});
