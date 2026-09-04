import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Скриншотные эталоны витрины.
 *
 * Витрина показывает каждый компонент во всех состояниях — это единственное
 * место, где согласованность видна целиком. Первая же спешная правка кнопки
 * иначе расходится с остальными, и заметят это через месяц на демонстрации.
 *
 * Снимается в обеих темах: тёмная и светлая — это два разных набора токенов,
 * и правка одной регулярно ломает другую.
 *
 * Порог подобран так, чтобы тест что-то значил. Первая попытка стояла на двух
 * процентах различающихся пикселей — и смена акцентного цвета через неё
 * прошла: акцент занимает меньше процента площади. Порог, который пропускает
 * перекраску половины интерфейса, хуже отсутствующего теста, потому что
 * создаёт уверенность.
 *
 * Поэтому: почти нулевая доля пикселей и низкий порог различия по цвету.
 * Сглаживание шрифтов отличается между машинами, но Playwright и так держит
 * отдельный эталон на каждую платформу (суффикс в имени файла), так что
 * сравниваются всегда снимки с одной и той же ОС.
 */
const TOLERANCE = {
  maxDiffPixelRatio: 0.001,
  threshold: 0.1,
  animations: "disabled" as const,
};

/*
 * Токены проверяются отдельно от снимков, и это не дублирование.
 *
 * Снимок ловит вёрстку, но плохо ловит цвет: акцент занимает меньше промилле
 * площади витрины, и его перекраска проходит через любой разумный порог по
 * доле различающихся пикселей. Проверка вычисленных значений отвечает на
 * вопрос «изменился ли токен» прямо, а не через площадь.
 */
const TOKENS = [
  "--bg",
  "--surface",
  "--surface-2",
  "--border",
  "--text",
  "--muted",
  "--accent",
  "--primary",
  "--sev-none",
  "--sev-mild",
  "--sev-moderate",
  "--sev-severe",
  "--focus",
];

for (const theme of ["dark", "light"] as const) {
  test(`витрина не разъехалась: тема ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => {
      localStorage.setItem("quizzy.theme", value);
    }, theme);

    await login(page, "psy");
    await page.goto("/ui");
    await page.waitForSelector("h1");

    /*
     * Ждём шрифты: без этого снимок ловит запасную гарнитуру, метрики
     * расходятся, и различие в два процента срабатывает на пустом месте.
     */
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator("main.main")).toHaveScreenshot(`uikit-${theme}.png`, TOLERANCE);
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`токены темы не менялись незаметно: ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => {
      localStorage.setItem("quizzy.theme", value);
    }, theme);

    await login(page, "psy");
    await page.goto("/ui");
    await page.waitForSelector("h1");

    const values = await page.evaluate((names) => {
      const style = getComputedStyle(document.documentElement);
      return names.map((n) => `${n}: ${style.getPropertyValue(n).trim()}`).join("\n");
    }, TOKENS);

    expect(values).toMatchSnapshot(`tokens-${theme}.txt`);
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`печать читается на бумаге: тема ${theme}`, async ({ page }) => {
    /*
     * Браузер не печатает фон. Если в печатном режиме остаётся тёмная тема,
     * почти белый текст ложится на белую бумагу — и отчёт выходит пустым
     * листом. Так и было: `:root[data-theme="dark"]` перебивал печатный блок
     * по специфичности, а тема тёмная по умолчанию.
     *
     * Проверяется не картинка, а сами токены: пустой лист на снимке от
     * правильно белого листа не отличить.
     */
    await page.addInitScript((value) => {
      localStorage.setItem("quizzy.theme", value);
    }, theme);

    await login(page, "psy");
    await page.emulateMedia({ media: "print" });

    const ink = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const parse = (name: string) => {
        const value = style.getPropertyValue(name).trim();
        const hex = value.length === 4
          ? value.replace(/#(.)(.)(.)/, "#$1$1$2$2$3$3")
          : value;
        return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
      };
      const luminance = (rgb: number[]) =>
        (0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!) / 255;
      return { text: luminance(parse("--text")), bg: luminance(parse("--bg")) };
    });

    // текст тёмный, бумага светлая — иначе печатать нечего
    expect(ink.text).toBeLessThan(0.3);
    expect(ink.bg).toBeGreaterThan(0.9);
  });
}

test("подсказка закрывается один раз и не возвращается", async ({ page }) => {
  /*
   * Хранится список ЗАКРЫТЫХ подсказок, а не показанных: подсказка по
   * умолчанию видна, и потерянная запись о показе не должна навсегда прятать
   * объяснение. Проверяется обе стороны — что закрылась и что после
   * перезагрузки не вернулась.
   */
  await login(page, "psy");
  await page.goto("/patients");
  await page.waitForSelector("table tbody tr");
  const href = await page.locator("table tbody tr td a").first().getAttribute("href");
  await page.goto(href!);

  const hint = page.locator(".hint-box").first();
  await expect(hint).toBeVisible();

  await hint.getByRole("button", { name: "Понятно" }).click();
  await expect(page.locator(".hint-box")).toHaveCount(0);

  await page.reload();
  await page.waitForSelector("h1");
  await expect(page.locator(".hint-box")).toHaveCount(0);
});

/**
 * Скриншотные эталоны рабочих экранов.
 *
 * Витрина выше показывает компоненты поодиночке; здесь — то, что из них
 * собрано. Разница существенная: кнопка и таблица могут быть в порядке
 * каждая, а экран приёма при этом разъезжается на три панели неравной
 * высоты. Жалоба «неудобно и криво» приходит именно про собранный экран.
 *
 * Снимается только тёмная тема, и это выбор, а не экономия. Цвета обеих тем
 * уже держит проверка токенов, а компоновку вторая тема повторяет один в
 * один: те же элементы, те же размеры. Второй набор эталонов удваивал бы
 * стоимость любой правки вёрстки, ничего нового не проверяя.
 */

/**
 * Данные экрана берутся из записанных ответов, а не из базы стенда.
 *
 * Первая версия снимала живой экран — и покраснела в первом же полном
 * прогоне, хотя вёрстку никто не трогал: сценарии приёма, идущие раньше,
 * успевали назначить методику и отметить неявку, и на экране дня появлялась
 * лишняя пометка. Снимок вёрстки, зависящий от того, кто до него нажал
 * «Пришёл», ломается от чужих правок и потому будет отключён при первой же
 * спешке.
 *
 * Поэтому ответы API записываются один раз вместе с эталоном и дальше
 * воспроизводятся. Экран становится функцией от данных, а данные — частью
 * эталона; проверяется ровно то, ради чего тест написан, — как консоль
 * раскладывает известные ей данные.
 *
 * Записываются только чтения. Записи (POST, PUT, DELETE) при открытии
 * экрана не случаются, а если случатся — пусть идут в стенд и падают там
 * заметно, а не подменяются тишиной.
 */
const API_DIR = "e2e/visual.e2e.ts-snapshots/api";

/**
 * Ключ записанного ответа: путь и параметры, но без дат и меток времени.
 *
 * Они попадают в АДРЕС запроса: отчёт отделения спрашивает период «с начала
 * месяца по сегодня», очередь событий — «что было после такого-то момента».
 * Назавтра адрес другой, записанного ответа под ним нет, экран получает
 * выдуманный 404 и не отрисовывается.
 *
 * То есть ровно та беда, от которой уходили: изменчивость просто переехала
 * из ответа в запрос. Даты и метки времени заменяются заглушкой — сам ответ
 * всё равно заморожен, и различать запросы по дате здесь незачем.
 */
function keyOf(url: string): string {
  const parsed = new URL(url);
  return (parsed.pathname + parsed.search)
    // метка времени часто приходит кодированной: «T10%3A56%3A52.935Z»,
    // и класс из цифр с двоеточиями её не ловит — в %3A есть буква
    .replace(/\d{4}-\d{2}-\d{2}T[^&#]*?Z/g, "<time>")
    .replace(/\d{4}-\d{2}-\d{2}/g, "<date>");
}

async function withRecordedApi(
  page: import("@playwright/test").Page,
  screen: string,
  recording: boolean,
) {
  const file = `${API_DIR}/${screen}.json`;
  const saved: Record<string, { status: number; body: string }> = recording
    ? {}
    : JSON.parse(await readFile(file, "utf8"));

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    const key = keyOf(request.url());

    if (!recording) {
      const hit = saved[key];
      /*
       * Незаписанный запрос — это не повод молча сходить в базу: значит
       * экран стал спрашивать что-то новое, и эталон устарел. Пустой ответ
       * покажет это на снимке, а не спрячет.
       */
      if (!hit) return route.fulfill({ status: 404, body: "{}" });
      return route.fulfill({
        status: hit.status,
        contentType: "application/json",
        body: hit.body,
      });
    }

    /*
     * Консоль опрашивает очередь работы в фоне и после снимка. Такой запрос
     * застаёт закрывающийся контекст, и обработчик падает уже за пределами
     * проверяемого — гасим, чтобы падение было только по существу.
     */
    try {
      const response = await route.fetch();
      // тело читается до fulfill: тот освобождает ответ, и чтение после него падает
      const body = await response.text();
      saved[key] = { status: response.status(), body };
      await route.fulfill({ status: response.status(), contentType: "application/json", body });
    } catch {
      await route.abort().catch(() => {});
    }
  });

  return async () => {
    if (!recording) return;
    await mkdir(API_DIR, { recursive: true });
    // ключи сортируются: иначе порядок запросов гуляет и файл шумит в истории
    const ordered = Object.fromEntries(Object.entries(saved).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(file, `${JSON.stringify(ordered, null, 2)}\n`);
  };
}

const SCREENS: Array<{ name: string; open: (page: import("@playwright/test").Page) => Promise<void> }> = [
  {
    name: "today",
    open: async (page) => {
      await page.goto("/today");
      await page.getByRole("heading", { name: "Сегодня" }).waitFor();
    },
  },
  {
    name: "schedule",
    open: async (page) => {
      await page.goto("/my-schedule");
      await page.locator("h1").waitFor();
    },
  },
  {
    name: "visit",
    open: async (page) => {
      await page.goto("/today");
      await page.locator('a[href^="/visit/"]').first().click();
      await page.waitForURL(/\/visit\//);
      /*
       * Ждём заголовок ИМЕННО приёма, а не любой h1.
       *
       * Экран дня к этому моменту ещё в разметке, и `h1` совпадал с ним:
       * ожидание заканчивалось до того, как приезжали данные приёма, и в
       * записанные ответы они не попадали. Тест при записи проходил —
       * снимок успевал дорисоваться, — а при воспроизведении экран получал
       * на свой запрос выдуманный 404.
       */
      await page.getByRole("heading", { name: "Приём", exact: true }).waitFor();
    },
  },
  {
    name: "department-report",
    open: async (page) => {
      await page.goto("/department-report");
      await page.locator("h1").waitFor();
    },
  },
  {
    name: "messages",
    open: async (page) => {
      await page.goto("/messages");
      await page.locator("h1").waitFor();
    },
  },
  {
    name: "worklist",
    open: async (page) => {
      await page.goto("/worklist");
      await page.locator("h1").waitFor();
    },
  },
  {
    name: "patient",
    open: async (page) => {
      await page.goto("/patients");
      await page.locator("table tbody tr").first().waitFor();
      await page.locator("table tbody tr td a").first().click();
      await page.waitForURL(/\/patients\//);
      /*
       * Ждём вкладки карты, а не просто заголовок: заголовок «Пациенты»
       * есть и на списке, с которого мы уходим, — ожидание проходило
       * мгновенно, и снимок ловил карту в состоянии загрузки.
       */
      await page.getByRole("link", { name: "Хронология" }).waitFor();
      // карта дозагружает динамику и эпизоды отдельными запросами
      await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    },
  },
];

for (const screen of SCREENS) {
  test(`экран не разъехался: ${screen.name}`, async ({ page }, testInfo) => {
    /*
     * Ответы записываются, только если их ещё нет. `--update-snapshots`
     * обновляет картинки, но НЕ данные.
     *
     * Данные — это вход, картинка — результат. Пока обновление картинок
     * заодно перезаписывало и данные, два набора эталонов (macOS у
     * разработчика, Linux в CI) затирали данные друг у друга: снятые на
     * одной системе картинки переставали сходиться, потому что под ними
     * менялись идентификаторы и даты. Каждая система по очереди «чинила»
     * себя и ломала соседа.
     *
     * Обновить данные теперь — отдельное осознанное действие: удалить
     * файл в `visual.e2e.ts-snapshots/api/` и снять эталоны заново на
     * обеих системах.
     */
    const recording = !existsSync(`${API_DIR}/${screen.name}.json`);
    void testInfo;
    await page.addInitScript(() => {
      localStorage.setItem("quizzy.theme", "dark");
    });

    // вход идёт в настоящий стенд: перехват ставится после него
    await login(page, "psy");
    const save = await withRecordedApi(page, screen.name, recording);
    await screen.open(page);
    await page.evaluate(() => document.fonts.ready);
    /*
     * Снимок раньше сохранения набора ответов.
     *
     * Было наоборот — и панели, догружающиеся отдельными запросами, успевали
     * попасть в картинку, но не в набор: при записи они рисовались живыми
     * данными, при воспроизведении их запрос не находился и панель исчезала
     * совсем. Эталон и набор расходились в одном и том же прогоне.
     *
     * В этом порядке всё, что видно на снимке, заведомо уже записано.
     */
    /*
     * Поля даты закрываются маской.
     *
     * Часть из них подставляет СЕГОДНЯ — отчёт отделения открывается с «по»
     * = текущий день, — и эталон, снятый вчера, краснеет сегодня. Ответы API
     * тут не спасают: значение считает клиент, в перехваченный набор оно не
     * попадает вовсе. Маска по границам поля оставляет вёрстку под
     * наблюдением: съехавшее поле сдвинет соседей, и это будет видно.
     */
    await expect(page.locator("main.main")).toHaveScreenshot(`screen-${screen.name}.png`, {
      ...TOLERANCE,
      mask: [page.locator('input[type="date"]')],
    });

    await save();

    /*
     * Перехват снимается после снимка, а не до. До — значит отдать фоновому
     * опросу право подставить живые данные ровно в момент съёмки, и вся
     * затея с записанными ответами теряет смысл.
     */
    await page.unroute("**/api/**");
  });
}
