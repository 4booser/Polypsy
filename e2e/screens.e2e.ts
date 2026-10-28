import { expect, test } from "@playwright/test";
import { goPatientTab, login, openDrawer, openSeededPatient, patientTabs, SEED_SURVEY } from "./helpers";

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
     * Каталог упорядочен по названию, и первой может встать методика,
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

  test("рабочее место пациента: вкладки и прежние адреса", async ({ page }) => {
    await login(page, "psy");
    const first = await openSeededPatient(page);
    const id = (await first.getAttribute("href"))!.split("/").pop()!;

    /*
     * Одна страница с вкладками: карточка пациента и клиническая карта
     * слились в рабочее место «/patients/:id». Каждая вкладка открывается
     * своим адресом — ими ходят ссылки очереди работы, поиска и переписки.
     */
    for (const tab of ["", "dynamics", "measures", "records", "referrals", "messages", "timeline"]) {
      await open(page, { name: tab || "обзор", path: `/patients/${id}${tab ? `?tab=${tab}` : ""}` });
    }

    /*
     * Прежние адреса клинической карты и сводки консилиума — теперь
     * перенаправления (App.tsx, RedirectToPatient): они живут в переписке и
     * в чужих закладках. Каждый ведёт туда, где его сведения сейчас, —
     * проверяется и адрес, и выбранная вкладка.
     */
    const legacy: [string, string, RegExp][] = [
      ["case", "", /^(Обзор|Огляд)/],
      ["case/dynamics", "?tab=dynamics", /^(Динамика|Динаміка)/],
      ["case/timeline", "?tab=timeline", /^(Хронология|Хронологія)/],
      ["summary", "", /^(Обзор|Огляд)/],
      ["dynamics", "?tab=dynamics", /^(Динамика|Динаміка)/],
      ["timeline", "?tab=timeline", /^(Хронология|Хронологія)/],
    ];
    for (const [from, to, tab] of legacy) {
      await open(page, { name: from, path: `/patients/${id}/${from}` });
      await expect(page).toHaveURL(new RegExp(`/patients/${id}${to.replace("?", "\\?")}$`));
      await expect(patientTabs(page).getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    }

    /* прежние вкладки карточки: «Заключення» и «Нотатки» — виды «Записів», «Прийоми» — вид хронологии */
    await open(page, { name: "?tab=notes", path: `/patients/${id}?tab=notes` });
    await expect(page).toHaveURL(/[?&]tab=records/);
    await expect(page).toHaveURL(/[?&]kind=notes/);
  });

  test("запись приёма в ящике на 1280: все четыре вида записи видны целиком", async ({ page }) => {
    /*
     * Ящик — 440 px, а ряд «Первинний / Прийом / Спостереження /
     * Консультація» требует около 390: в узкой колонке прежней карты
     * «Консультація» уходила за край и обрезалась. Проверка — что все четыре
     * вида встают в ящик целиком.
     */
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, "psy");
    await (await openSeededPatient(page)).click();
    await page
      .getByRole("main")
      .getByRole("group", { name: /^(Действия с пациентом|Дії з пацієнтом)$/ })
      .getByRole("button", { name: /^(Запись приёма|Запис прийому)/ })
      .click();
    const kinds = openDrawer(page).getByRole("group", { name: /^(Вид записи|Вид запису)$/ });
    await kinds.waitFor();
    const fit = await kinds.evaluate((g) => {
      // мерка — сам ящик, а не группа: ряд, шире ящика, вылезал бы за него целиком вместе с группой
      const box = g.closest("[data-drawer]")!.getBoundingClientRect();
      return [...g.querySelectorAll("button")].map((b) => {
        const r = b.getBoundingClientRect();
        return { text: b.textContent, inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5, whole: b.scrollWidth <= b.clientWidth + 1 };
      });
    });
    expect(fit).toHaveLength(4);
    expect(fit.filter((b) => !b.inside || !b.whole)).toEqual([]);
  });

  test("хронология пациента открывается и упорядочена", async ({ page }) => {
    await login(page, "psy");
    await (await openSeededPatient(page)).click();
    /*
     * Дожидаемся рабочего места, ПОТОМ читаем имя. Без ожидания заголовок
     * читается ещё со списка — «Пациенты», — и проверка сравнивает вкладку
     * со списком, а не с пациентом.
     */
    const tab = patientTabs(page).getByRole("tab", { name: /^Хронология/ });
    await tab.waitFor();
    /*
     * И дожидаемся ИМЕНИ: пока данные карты в пути, заголовок — заглушка
     * «Пациент». Экраны с волны 12 грузятся отдельными кусками, и вкладка
     * успевала появиться раньше имени — тогда сравнивалась заглушка.
     */
    await expect(page.locator("h1")).not.toHaveText(/^(Пациент|Пацієнт|Patient)$/);
    const name = (await page.locator("h1").textContent())!.trim();
    await goPatientTab(page, "Хронология");
    await expect(page.locator("h1")).toHaveText(name);
    // строка события ленты (patientCard/Timeline.tsx, data-evt) — не класс, который сменят на первой правке
    await expect(page.locator("[data-evt]").first()).toBeVisible();

    // дни идут от свежего к старому: историю читают с конца (ключ дня — в data-day)
    const days = await page.locator("[data-day]").evaluateAll((els) => els.map((e) => e.getAttribute("data-day") ?? ""));
    expect(days.length).toBeGreaterThan(0);
    expect([...days].sort().reverse()).toEqual(days);
    await expect(page.locator(".error")).toHaveCount(0);
  });
});
