import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { goCaseCard, login, patientLinks } from "./helpers";

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
      localStorage.setItem("quizzy.theme.v2", value);
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
      localStorage.setItem("quizzy.theme.v2", value);
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
      localStorage.setItem("quizzy.theme.v2", value);
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
  await patientLinks(page).first().waitFor();
  const href = await patientLinks(page).first().getAttribute("href");
  await page.goto(href!);
  /*
   * Подсказка про RCI живёт на сводке клинической карты (pages/CaseSummary),
   * а «/patients/:id» с волны 6 — карточка по кадру f19, где подсказок нет
   * вовсе. Идём туда шестерёнкой, как человек.
   */
  await goCaseCard(page);

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

/**
 * Опубликованные методики стенда — через API, но ИЗ СТРАНИЦЫ, короткие
 * первыми.
 *
 * Соседние экраны берут идентификатор со ссылки в ЗАПИСАННОМ списке: приём
 * — из «Сегодня», карта — из «Пациентов». При воспроизведении id тогда
 * приходит из того же набора, что и всё остальное, и экран находит свои
 * ответы. Здесь список спрашивается fetch-ом из страницы, а не через
 * page.request: запрос из страницы проходит тот же перехват, записывается
 * вместе с ответами экрана и при воспроизведении отдаёт тот же id.
 *
 * Через page.request было бы короче и неверно. Идентификаторы посева —
 * случайные UUID, и каждый прогон пересоздаёт базу: живой запрос вернул бы
 * свежий id, под которым записанного ответа нет, и экран получил бы
 * выдуманный 404 на собственные данные.
 *
 * Короткие первыми — потому что свиток снимается целиком (см. fit). Первой
 * в каталоге стоит МЛО на двести пунктов: её прохождение — тридцать экранов
 * высоты, а записанный набор ответов — полмегабайта на каждый экран. Вёрстку
 * пункта пять пунктов сторожат не хуже двухсот.
 */
async function recordedSurveys(
  page: import("@playwright/test").Page,
): Promise<Array<{ id: string; questionCount: number; responseCount: number }>> {
  return page.evaluate(async () => {
    const headers = { Authorization: `Bearer ${localStorage.getItem("quizzy.web.token")}` };
    const list = (await (await fetch("/api/surveys?status=published", { headers })).json()) as {
      items: Array<{ id: string; questionCount: number; responseCount: number }>;
    };
    return list.items
      .map(({ id, questionCount, responseCount }) => ({ id, questionCount, responseCount }))
      .sort((a, b) => a.questionCount - b.questionCount);
  });
}

/**
 * Сданное прохождение с баллами — из самой короткой методики, где оно есть.
 *
 * Именно сданное и с баллами: у брошенного лестница результатов пуста, и
 * снимок сторожил бы половину экрана. Список методик несёт число сданных
 * прохождений, так что за списком прохождений запрос идёт только к тем, у
 * кого они есть, — и в записи не оседает по запросу на каждую методику.
 */
async function recordedScoredResponse(
  page: import("@playwright/test").Page,
): Promise<{ surveyId: string; responseId: string }> {
  const candidates = (await recordedSurveys(page)).filter((s) => s.responseCount > 0).map((s) => s.id);
  const found = await page.evaluate(async (ids) => {
    const headers = { Authorization: `Bearer ${localStorage.getItem("quizzy.web.token")}` };
    for (const id of ids) {
      const list = (await (await fetch(`/api/surveys/${id}/responses?limit=5`, { headers })).json()) as {
        rows: Array<{ id: string; status: string; scores: unknown[] }>;
      };
      const hit = list.rows.find((r) => r.status === "completed" && r.scores.length > 0);
      if (hit) return { surveyId: id, responseId: hit.id };
    }
    return null;
  }, candidates);
  expect(found, "на стенде нет ни одного сданного прохождения с баллами — экран показать не на чем").not.toBeNull();
  return found!;
}

/**
 * Первый лікар реестра — из ЗАПИСАННОГО GET /api/users, тем же fetch-ом из
 * страницы, что и recordedSurveys: id посева случайные, и живой page.request
 * дал бы чужой. Порядок — как в реестре (sortByName в pages/people/model.ts):
 * карточка снимается с той же строки, что стоит первой на экране списка.
 *
 * Реестр закрыт правом users.manage, поэтому экраны людей снимаются от
 * root, а не от psy: psy без ступени лестницы не видит ни /staff, ни /admins
 * (isSuper || canAssign в App.tsx), а по /api/permissions/staff получил бы
 * усечённый справочник без пола и года рождения — не тот экран, что на
 * кадре f43.
 */
async function recordedDoctor(page: import("@playwright/test").Page): Promise<{ id: string; fullName: string }> {
  const doctor = await page.evaluate(async () => {
    const headers = { Authorization: `Bearer ${localStorage.getItem("quizzy.web.token")}` };
    const list = (await (await fetch("/api/users", { headers })).json()) as {
      items: Array<{ id: string; role: string; fullName: string }>;
    };
    return list.items
      .filter((u) => u.role === "admin")
      .map(({ id, fullName }) => ({ id, fullName }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, "uk"))[0] ?? null;
  });
  expect(doctor, "на стенде нет ни одного лікаря — карточку показать не на ком").not.toBeNull();
  return doctor!;
}

/**
 * Первый в ЗАПИСАННОМ списке пациент — тем же fetch-ом из страницы, что и
 * recordedSurveys: id посева случайные, живой page.request дал бы чужой.
 *
 * Список зоны видимости спрашивается без параметров: ровно такой запрос
 * лежит в наборе и у карты, и у карточки, и при воспроизведении оба экрана
 * получают одного и того же человека.
 */
async function recordedPatientId(page: import("@playwright/test").Page): Promise<string> {
  const first = await page.evaluate(async () => {
    const headers = { Authorization: `Bearer ${localStorage.getItem("quizzy.web.token")}` };
    const list = (await (await fetch("/api/dynamics/respondents", { headers })).json()) as {
      items: Array<{ userId: string }>;
    };
    return list.items[0]?.userId ?? null;
  });
  expect(first, "на стенде нет ни одного пациента — карту показать не на ком").not.toBeNull();
  return first!;
}

/**
 * Отправленная рассылка с ответами — из ЗАПИСАННОГО перечня, тем же путём.
 *
 * Именно отправленная и именно с ответами: карточка черновика — это форма
 * (кадр f16), а кадр f22 рисует показ с вариантами, и счётчики по вариантам
 * сервер отдаёт только у отправленной. Посев такую заводит (apps/api/src/
 * seed/mailings.ts: «Повторний замір настрою» с тремя вариантами), но брать
 * её id оттуда нельзя — он случайный и пересоздаётся с базой.
 *
 * Перечень спрашивается с запасом (limit 20): черновик и уведомление без
 * вариантов стоят в том же списке, и страница по умолчанию могла бы
 * кончиться раньше нужной строки.
 */
async function recordedSentMailing(page: import("@playwright/test").Page): Promise<string> {
  const id = await page.evaluate(async () => {
    const headers = { Authorization: `Bearer ${localStorage.getItem("quizzy.web.token")}` };
    const list = (await (await fetch("/api/mailings?limit=20&offset=0", { headers })).json()) as {
      items: Array<{ id: string; status: string; answeredCount: number }>;
    };
    const sent = list.items.filter((m) => m.status === "sent");
    return (sent.find((m) => m.answeredCount > 0) ?? sent[0])?.id ?? null;
  });
  expect(id, "на стенде нет ни одной отправленной рассылки — карточку показать не на чем").not.toBeNull();
  return id!;
}

/**
 * Вытянуть окно по высоте содержимого — см. поле fit у экрана.
 *
 * Меряется именно прокручиваемая область (overflow-y: auto), а не любой
 * элемент подряд: у подписей для диктора (sr-only) scrollHeight тоже больше
 * clientHeight, и наибольшая разница по всем элементам ловила бы их. Ширина
 * не меняется, значит, высоты строк после растяжения те же, и одного замера
 * хватает; проверка после — что прокручивать больше нечего.
 */
async function fitToContent(page: import("@playwright/test").Page) {
  const hidden = () =>
    page.evaluate(() => {
      let most = 0;
      for (const el of document.querySelectorAll<HTMLElement>("main.main *")) {
        const { overflowY } = getComputedStyle(el);
        if (overflowY !== "auto" && overflowY !== "scroll") continue;
        most = Math.max(most, el.scrollHeight - el.clientHeight);
      }
      return most;
    });
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: size.height + (await hidden()) });
  await expect.poll(hidden).toBe(0);
}

type Account = Parameters<typeof login>[1];

const SCREENS: Array<{
  name: string;
  open: (page: import("@playwright/test").Page) => Promise<void>;
  /**
   * От кого снимается. По умолчанию psy — рядовой специалист, чей экран и
   * есть основной; реестры людей открыты только суперадмину и заведующему
   * (isSuper || canAssign), и их снимает root.
   */
  as?: Account;
  /**
   * Снимается гостем — без входа вовсе.
   *
   * Лендинг и форма входа существуют только для того, кто не вошёл: войдя,
   * по «/» получаешь сводку, по «/login» — её же. Учётки у такого экрана
   * поэтому нет, а перехват ответов ставится сразу, а не после входа.
   */
  guest?: true;
  /**
   * Что попадает в кадр. По умолчанию рабочая область консоли (main.main).
   *
   * У публичных страниц её нет: лист рисует PublicFrame, и кадры f00/f01 —
   * это лист целиком, от «Укр» в шапке до подвала с контактами. Снимать у
   * них один <main> значило бы выбросить из эталона половину того, что
   * заказчик нарисовал.
   */
  root?: string;
  /** Заголовок экрана — сегодняшняя дата, и в снимке его надо закрыть */
  maskTitle?: true;
  /**
   * Снимается весь свиток, а не одна верхняя треть.
   *
   * Содержимое экрана прокручивается внутри своей области, а не вместе со
   * страницей, и full-page снимок Playwright её не разворачивает: в кадр
   * попадало бы то, что влезло в 720 px, — заголовок и два первых пункта, —
   * а лестница результатов и редактор заключения, ради которых экран
   * нарисован, оставались за краем. Окно вытягивается по высоте содержимого
   * ровно, без запаса: область растёт вместе с окном (flex-1), и лишняя
   * высота стала бы пустой полосой внизу снимка.
   */
  fit?: true;
}> = [
  {
    name: "today",
    open: async (page) => {
      await page.goto("/today");
      await page.getByRole("link", { name: "Сегодня" }).waitFor();
    },
    /*
     * Заголовком этого экрана стоит сегодняшняя дата — и это сознательно:
     * название экрана ничего не сообщает тому, кто уже здесь, а дата
     * отвечает на вопрос, который тут задают. Расплата — снимок, который
     * менялся бы каждое утро; закрываем заголовок маской по тем же
     * основаниям, что и поля даты.
     */
    maskTitle: true,
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
      /*
       * Карта открывается по адресу, а не щелчком по первой строке списка.
       * Эталон снят с карты, а список пациентов с волны 4 — другой экран
       * (сетка f05 с вкладками групп): он спрашивает /api/patient-groups и
       * листает /api/dynamics/respondents с параметрами, которых в записанном
       * наборе нет, и под воспроизведением не отрисовывается вовсе. Тянуть
       * его в набор значило бы переснимать эталон карты, которая не менялась.
       * Первый из /api/dynamics/respondents — тот же человек, что и в наборе:
       * запрос без параметров в нём есть, и при воспроизведении он отвечает
       * из записи.
       */
      const first = await recordedPatientId(page);
      /*
       * Адрес с волны 6 — «/case»: сам «/patients/:id» занят карточкой по
       * кадру f19 (см. экран patient-card ниже), а эта карта переехала
       * (pages/CaseCard.tsx). Экран тот же самый и эталон тот же: переезд
       * сменил только маршрут и адреса вкладок, ни одного пикселя.
       */
      await page.goto(`/patients/${first}/case`);
      /*
       * Ждём вкладки карты, а не просто заголовок: заголовок «Пациенты»
       * есть и на списке, — ожидание проходило мгновенно, и снимок ловил
       * карту в состоянии загрузки.
       */
      await page.getByRole("link", { name: "Хронология" }).waitFor();
      // карта дозагружает динамику и эпизоды отдельными запросами
      await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    },
  },
  /*
   * Экраны раздела «Тести» волны 3 — каталог, конструктор в двух состояниях,
   * просмотр прохождения и заключение. Это первые экраны, переделанные по
   * макету один в один, и расхождение с макетом на них видно только глазом:
   * колонка 700, шаг строки 51, «від — до — текст» — ничего из этого не
   * ловит ни смоук экранов, ни проверка доступности.
   */
  {
    name: "catalogue",
    open: async (page) => {
      await page.goto("/surveys");
      /*
       * Заголовок каталога печатается скрыто (titleHidden): строка над
       * списком отдана вкладкам, и ждать видимого h1 здесь нечего. Признак
       * готовности — строка списка: она рисуется последней, после папок и
       * постраничности, которым нужны свои ответы.
       */
      await page.locator("table tbody tr").first().waitFor();
      await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    },
    // страница каталога конечна (десять строк) — в кадре она вся, с последней строкой
    fit: true,
  },
  {
    name: "constructor-new",
    open: async (page) => {
      await page.goto("/constructor");
      /*
       * Заголовка «Новый тест» на экране нет: по кадру f24_1 над вкладками
       * пусто, и заголовок оставлен скрытым для диктора. Признак готовности —
       * сами вкладки; снимается вид по умолчанию — «Конкретный».
       */
      await expect(page.getByRole("tab", { name: "Конкретный тест" })).toHaveAttribute("aria-selected", "true");
    },
    // до «Ответов», шкал и кнопки «Создать» внизу — они и есть форма
    fit: true,
  },
  {
    name: "constructor-edit",
    open: async (page) => {
      /*
       * Самая короткая из опубликованных методик с пунктами — из записанного
       * списка, а не прямым goto с живым id: см. recordedSurveys о случайных
       * id посева. Без пунктов нельзя: ждать нечего, и аккордеон пуст.
       */
      const survey = (await recordedSurveys(page)).find((s) => s.questionCount > 0);
      expect(survey, "на стенде нет опубликованной методики с пунктами").toBeDefined();
      await page.goto(`/constructor/${survey!.id}`);
      /*
       * Ждём строку аккордеона, а не заголовок: заголовком стоит название
       * методики, и оно есть в разметке ещё до того, как приехали пункты.
       */
      await page.getByRole("button", { name: /Развернуть вопрос$/ }).first().waitFor();
    },
    fit: true,
  },
  {
    name: "response",
    open: async (page) => {
      const { surveyId, responseId } = await recordedScoredResponse(page);
      await page.goto(`/surveys/${surveyId}/responses/${responseId}`);
      // «Результаты» и кнопка стоят в самом низу свитка — если они есть, есть и всё выше
      await page.getByRole("heading", { name: "Результаты" }).waitFor();
      await page.getByRole("link", { name: "Создать заключение" }).waitFor();
    },
    // ради лестницы результатов и кнопки внизу экран и нарисован
    fit: true,
  },
  {
    name: "conclusion",
    open: async (page) => {
      const { responseId } = await recordedScoredResponse(page);
      await page.goto(`/responses/${responseId}/conclusion`);
      await page.getByRole("heading", { name: "Выводы заключения" }).waitFor();
      /*
       * Модели и само заключение приезжают своими запросами и до того
       * стоят строкой «Загрузка…». Ждём, пока её не останется: снимок с ней
       * — снимок ожидания, а не экрана.
       */
      await expect(page.locator("main.main").getByText("Загрузка…")).toHaveCount(0);
      await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    },
    // редактор с полосой инструментов стоит последним в свитке
    fit: true,
  },
  /*
   * Экраны волны 4 — люди: сетка пациентов с вкладками групп (f05), реестры
   * лікарів и администраторов (f43, f50), карточка сотрудника (f33) и
   * конструктор аналитической модели (f27).
   *
   * Списка групп, карточки группы, перечня аналитики и правки модели здесь
   * нет: посев (apps/api/src/seed.ts) не заводит ни одной группы пациентов и
   * ни одного правила, а эталон пустого экрана сторожит пустоту, не вёрстку.
   * Появятся в посеве — добавить по этому же образцу: id из записанных
   * GET /api/patient-groups и GET /api/decisions/rules.
   */
  {
    name: "patients",
    open: async (page) => {
      await page.goto("/patients");
      /*
       * Сетка карточек рисуется после списка людей и вкладок групп, которым
       * нужны свои ответы; data-patients — опора сквозных проверок
       * (PersonGrid), а не класс, который сменят на первой же правке.
       */
      await patientLinks(page).first().waitFor();
      await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    },
    // сетка 3×N со строкой над списком и панелью контекста — снимается вся
    fit: true,
  },
  {
    name: "staff",
    as: "superadmin",
    open: async (page) => {
      await page.goto("/staff");
      // строка реестра — ссылка на карточку; появилась — справочник приехал
      await page.locator('a[href^="/staff/"]').first().waitFor();
      await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    },
  },
  {
    name: "staff-card",
    as: "superadmin",
    open: async (page) => {
      const doctor = await recordedDoctor(page);
      await page.goto(`/staff/${doctor.id}`);
      /*
       * Ждём заголовок с именем, а не любой h1: у карточки «не найдено» и у
       * состояния загрузки заголовок тоже есть, и ожидание проходило бы до
       * того, как приехал справочник.
       */
      await page.getByRole("heading", { level: 1, name: doctor.fullName }).waitFor();
      // права сотрудника и его пациенты догружаются отдельными запросами
      await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    },
    // профиль с полями, сменой пароля и разделами ниже — свиток
    fit: true,
  },
  {
    name: "admins",
    as: "superadmin",
    open: async (page) => {
      await page.goto("/admins");
      await page.locator('a[href^="/staff/"]').first().waitFor();
      // ступени лестницы догружаются поштучно (withLadder) — без них строки неполные
      await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    },
  },
  {
    name: "analytics-new",
    open: async (page) => {
      await page.goto("/analytics/new");
      /*
       * Форма рисуется, когда приехал список методик (селект параметра);
       * до того экран — «Загрузка». Кнопка сохранения стоит последней в
       * форме: есть она — есть и всё выше.
       */
      await page.getByText("Название аналитической модели").waitFor();
      await page.getByRole("button", { name: "Сохранить" }).waitFor();
      await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    },
    // название, примечание, структура и действия — до кнопки внизу
    fit: true,
  },
  /*
   * Экраны волны 6 — публичная часть, карточка пациента и рассылки.
   *
   * Лендинг и вход снимаются целиком листом (root: "body"): у них нет
   * main.main консоли, а кадры f00 и f01 — это весь лист, вместе с подвалом.
   * Снимаются гостем: войдя, ни того ни другого уже не увидеть.
   */
  {
    name: "landing",
    guest: true,
    root: "body",
    open: async (page) => {
      await page.goto("/");
      await page.getByRole("heading", { level: 1, name: /^(О кампании|Про кампанію)$/ }).waitFor();
      /*
       * Ждём кнопку входа, а не один заголовок: она стоит последней в
       * содержимом листа, и пока её нет, снимок поймал бы лист без неё.
       * Фоновая картинка — отдельная забота: её ждём загрузкой, иначе в
       * кадр попадает сиреневая заливка без волн и силуэта.
       */
      await page.getByRole("link", { name: /^(Войти|Увійти)$/ }).waitFor();
      await page.evaluate(
        () =>
          new Promise<void>((done) => {
            const img = new Image();
            img.onload = () => done();
            img.onerror = () => done();
            img.src = "/landing.webp";
          }),
      );
    },
  },
  {
    name: "login",
    guest: true,
    root: "body",
    open: async (page) => {
      await page.goto("/login");
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.getByRole("button", { name: /^(Войти|Увійти)$/ }).waitFor();
      await page.evaluate(
        () =>
          new Promise<void>((done) => {
            const img = new Image();
            img.onload = () => done();
            img.onerror = () => done();
            img.src = "/landing.webp";
          }),
      );
    },
  },
  {
    name: "patient-card",
    open: async (page) => {
      const first = await recordedPatientId(page);
      await page.goto(`/patients/${first}`);
      /*
       * Ждём заголовок раздела «Тесты» — второй уровень, а не первый:
       * первым стоит слово «Пациент», и оно есть в разметке ещё до того,
       * как приехала карточка. Разделы рисуются по одному ответу
       * (/api/patients/:id/card), так что появился первый — есть и все.
       */
      await page.getByRole("heading", { level: 2, name: /^(Тесты|Тести)$/ }).waitFor();
      await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    },
    // личные данные, «Тесты», «Группы» и «Заключения» — кадры f19_1 и f19_2 подряд
    fit: true,
  },
  {
    name: "mailings",
    open: async (page) => {
      await page.goto("/mailings");
      /*
       * Строка перечня, а не заголовок: заголовок «Сообщения» и поле поиска
       * стоят и над пустым списком, и над списком в загрузке.
       */
      await page.locator('main.main a[href^="/mailings/"]').first().waitFor();
      await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    },
    // страница перечня конечна (десять строк) — в кадре она вся
    fit: true,
  },
  {
    name: "mailing-new",
    open: async (page) => {
      await page.goto("/mailings/new");
      /*
       * Кнопка «Создать» стоит последней в форме (кадр f16): есть она —
       * есть и название, и текст, и рамка «Ответ» с вариантами. Селект
       * адресатов ждёт свой список групп, поэтому ещё и скелеты.
       */
      await page.getByRole("button", { name: /^(Создать|Створити)$/ }).waitFor();
      await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    },
    fit: true,
  },
  {
    name: "mailing-card",
    open: async (page) => {
      const id = await recordedSentMailing(page);
      await page.goto(`/mailings/${id}`);
      /*
       * Ждём рамку «Ответ» с вариантами — то, чем отправленная рассылка
       * отличается от формы: пока карточка едет, на экране строка загрузки,
       * и заголовка у экрана нет вовсе (titleHidden).
       */
      await page.getByRole("group", { name: /^(Ответ|Відповідь)$/ }).waitFor();
      await expect.poll(async () => page.locator(".skeleton").count(), { timeout: 10_000 }).toBe(0);
    },
    fit: true,
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
    /*
     * Эталоны снимаются в СВЕТЛОЙ теме — той, в которой нарисован макет
     * заказчика и в которой консоль теперь открывается по умолчанию.
     * Снимать в тёмной значило бы сторожить не то, что обещано: переделка
     * идёт один в один по макету, и расхождение с ним видно только на
     * светлом. Тёмную тему держат эталоны витрины и дампы токенов.
     */
    await page.addInitScript(() => {
      localStorage.setItem("quizzy.theme.v2", "light");
    });

    // вход идёт в настоящий стенд: перехват ставится после него
    if (!screen.guest) await login(page, screen.as ?? "psy");
    const save = await withRecordedApi(page, screen.name, recording);
    await screen.open(page);
    await page.evaluate(() => document.fonts.ready);
    // после ожиданий экрана, а не до: пока данные не приехали, мерить нечего
    if (screen.fit) await fitToContent(page);
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
    await expect(page.locator(screen.root ?? "main.main")).toHaveScreenshot(`screen-${screen.name}.png`, {
      ...TOLERANCE,
      mask: [
        page.locator('input[type="date"]'),
        ...(screen.maskTitle ? [page.locator("main.main h1")] : []),
      ],
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
