import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { goMenu, login, menuButton, moreMenu, openMenu, railNav } from "./helpers";

/**
 * Кабинет пациента с телефона: мишени, заголовки, подписи, фокус.
 *
 * Всё это меряется на живой странице, а не читается в исходниках, потому что
 * ровно так оно и ломалось: разметка выглядела правильной, а рулетка поверх
 * снимка показывала 34 px. Числа здесь настоящие — getBoundingClientRect на
 * 390×844, размере самого распространённого телефона.
 */
test.use({ viewport: { width: 390, height: 844 } });

const SCREENS = [
  ["главная", "/me"],
  ["тесты", "/me/tests"],
  ["запись", "/me/booking"],
  ["профиль", "/me/profile"],
] as const;

/** Наименьшая мишень для пальца; то же число, что в TouchArea */
const TOUCH_MIN = 44;

/**
 * Мишени меньше пальца — с размером и надписью каждой.
 *
 * Сообщение важнее самой проверки: «ожидалось []» через год не скажет,
 * какую кнопку чинить, а «Сохранить 358×36» скажет сразу.
 */
async function tooSmall(page: Page): Promise<string[]> {
  return page.evaluate((min) => {
    const sel = 'a[href], button, input, select, textarea, summary, [role="button"]';
    const bad: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      /* невидимое мишенью не является: его не нажимают */
      if (r.width === 0 || r.height === 0) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      if (r.width >= min && r.height >= min) continue;
      const name = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24);
      bad.push(`${el.tagName.toLowerCase()} «${name}» ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return bad;
  }, TOUCH_MIN);
}

async function headings(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("h1, h2, h3")].map(
      (h) => `${h.tagName}:${(h.textContent ?? "").trim().slice(0, 30)}`,
    ),
  );
}

async function axeDigest(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return violations.flatMap((v) => v.nodes.map((n) => `${v.id} → ${n.target.join(" ")}`));
}

for (const [name, path] of SCREENS) {
  test(`кабинет «${name}»: мишени под палец, заголовок, подписи`, async ({ page }) => {
    await login(page, "patient");
    await page.goto(path);
    /* ждём не заголовок, а нижние вкладки: иначе проверка про заголовок
       вырождается в таймаут ожидания, который ничего не объясняет */
    /* вкладка — в навигации кабинета: на главной есть и «Все тесты» в панели «Что пройти» */
    await page.getByRole("navigation", { name: /^(Кабінет|Кабинет|Portal)$/ }).getByRole("link", { name: "Тесты" }).waitFor();
    await page.waitForLoadState("networkidle");

    /*
     * Один заголовок первого уровня, и он называет экран.
     *
     * Было так: на главной два h2 и ни одного h1, на «Тестах» — ни одного
     * заголовка вовсе, весь экран из одного списка ссылок. Человек с
     * диктором не мог ответить на вопрос «где я».
     */
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(
      h1,
      `заголовков первого уровня не один; что есть на экране: ${(await headings(page)).join(" | ")}`,
    ).toHaveCount(1);
    expect((await h1.textContent())?.trim()).toBeTruthy();

    expect(await tooSmall(page), "мишень меньше пальца").toEqual([]);
    expect(await axeDigest(page), "автопроверка доступности").toEqual([]);
  });
}

test("прохождение методики: фокус едет за вопросом, а не падает в никуда", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, "patient");
  await page.goto("/me/tests");
  /*
   * Длина методики здесь не важна — проверяется один переход. Методики
   * учреждения с 2026-10 выдаются только по назначению, и у пациента посева
   * назначена БОО «Адаптивність-200» (seed.ts): прежний отсев БОО оставлял
   * список пустым.
   */
  await page.locator('a[href^="/me/tests/"]').filter({ hasNotText: "Мини-мульт" }).first().click();
  await page.getByRole("heading", { level: 1 }).waitFor();
  /*
   * У методики с инструкцией перед первым пунктом — её экран и «Почати»
   * (#170), как и в a11y.e2e.ts. Без этого шага проверка зеленела, только
   * если инструкцию этой методики уже открывал другой сценарий раньше.
   */
  const start = page.getByRole("button", { name: /^(Почати|Начать|Start)$/ });
  /* один ответ — радио (плитки «Виразної»), несколько и шкала — переключатели */
  const firstOption = page.getByRole("radio").or(page.locator("button[aria-pressed]")).first();
  await Promise.race([start.waitFor(), firstOption.waitFor()]);
  if (await start.isVisible()) await start.click();
  await firstOption.waitFor();

  /* мишени прохождения меряются там же, где и всё остальное */
  expect(await tooSmall(page), "мишень меньше пальца в прохождении").toEqual([]);
  expect(await axeDigest(page), "автопроверка доступности в прохождении").toEqual([]);

  /*
   * Полоса прогресса названа и имеет значение.
   *
   * «Питання 3 з 7» с сегментами — язык телефона «Виразної»: зрячий видит
   * число на полосе прохождения (диктору оно там не читается, aria-hidden),
   * диктор слышит его в aria-valuetext и в начале заголовка вопроса.
   */
  const bar = page.getByRole("progressbar");
  await expect(bar).toHaveAttribute("aria-valuenow", "1");
  await expect(bar).toHaveAttribute("aria-valuetext", /1 из \d+|Информация/);
  /*
   * В заголовке вопроса номер — только для диктора: зрячий уже видит его на
   * полосе, и второй раз крупным шрифтом над вопросом он был бы лишним.
   * Меряем именно ширину — текст в разметке есть, но занимает пиксель.
   */
  const counter = page.locator("h1 span").first();
  await expect(counter).toHaveText(/1 из \d+/);
  expect(
    await counter.evaluate((el) => el.getBoundingClientRect().width),
    "номер в заголовке виден зрячему — он должен быть слышен только диктору",
  ).toBeLessThanOrEqual(1);

  const first = (await page.getByRole("heading", { level: 1 }).textContent())?.trim();

  // отвечаем и идём дальше КЛАВИАТУРОЙ: мышью потеря фокуса не видна
  await firstOption.click();
  const next = page.getByRole("button", { name: "Дальше" });
  await next.focus();
  await page.keyboard.press("Enter");

  const where = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return `${el?.tagName ?? "нет"} «${(el?.textContent ?? "").trim().slice(0, 40)}»`;
  });
  const heading = page.getByRole("heading", { level: 1 });
  const second = (await heading.textContent())?.trim();
  expect(second, "вопрос не сменился — проверка ничего не доказывает").not.toBe(first);
  /*
   * Фокус обязан стоять на заголовке НОВОГО вопроса. Раньше он падал в
   * body: нажатая кнопка на мгновение пропадает из разметки, и табуляция
   * начиналась с начала документа — на каждом из сорока пяти пунктов.
   */
  expect(
    await heading.evaluate((el) => el === document.activeElement),
    `после «Дальше» фокус оказался здесь: ${where}`,
  ).toBe(true);
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
});

test.describe("меню консоли на телефоне", () => {
  /*
   * Ниже 1100 px рельса и колонка подразделов спрятаны, а меню «Ще
   * розділи», пока оно закрыто, не отрисовано вовсе. Проверка всё равно
   * нажимает Tab, а не смотрит на класс: прежняя рельса была задвинута
   * трансформацией — выглядела скрытой и при этом принимала фокус из-за
   * края, — и спрятать пункты так же снова можно одной строкой стилей.
   * Автопроверка доступности об этом молчит по построению.
   */
  test("спрятанные пункты меню не забирают первые нажатия Tab", async ({ page }) => {
    await login(page, "psy");
    await page.goto("/today");
    await page.getByRole("main").getByRole("link", { name: /^Приём/ }).waitFor();

    // предпосылка: на этой ширине пункты действительно спрятаны — иначе проверять нечего
    await expect(railNav(page), "на телефоне рельса разделов должна быть спрятана").toBeHidden();

    const visited: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      visited.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return "нет";
          /*
           * Спрятанное — это рельса, колонка подразделов и меню «Ще розділи»
           * (диалог, которого при закрытом меню быть не должно). Сама полоса
           * приложения — знак, поиск, язык, кнопка меню — видна и в порядке
           * табуляции стоит по праву.
           */
          const hidden =
            [...document.querySelectorAll("nav")].some((n) => n.contains(el) && !n.closest("main")) ||
            !!el.closest('[role="dialog"]');
          return `${hidden ? "СПРЯТАНО" : "экран"}:${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 20)}`;
        }),
      );
    }
    expect(
      visited.filter((v) => v.startsWith("СПРЯТАНО")),
      `порядок табуляции: ${visited.join(" → ")}`,
    ).toEqual([]);
  });

  test("открытый бургер держит фокус, закрывается Esc и возвращает фокус кнопке", async ({ page }) => {
    await login(page, "psy");
    await page.goto("/today");
    await page.getByRole("main").getByRole("link", { name: /^Приём/ }).waitFor();

    const menu = await openMenu(page);
    /* фокус переехал внутрь: иначе Tab продолжает под слоем, где ничего не видно */
    expect(await menu.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    /*
     * И остаётся внутри: нажатий больше, чем пунктов, — круг обязан
     * замкнуться. На телефоне список выше экрана и прокручивается, и пункт за
     * нижним краем — как раз тот случай, когда уход фокуса глазами незаметен.
     * Полный обход ловушки живёт в focus-trap.e2e.ts; здесь проверяется, что
     * на этой ширине она вообще стоит.
     */
    const steps = (await menu.locator("a[href], button:not([disabled])").count()) + 2;
    for (let i = 1; i <= steps; i += 1) {
      await page.keyboard.press("Tab");
      expect(
        await menu.evaluate((el) => el.contains(document.activeElement)),
        `Tab №${i} вывел фокус из меню`,
      ).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(
      menuButton(page),
      "после закрытия фокус обязан вернуться на кнопку, а не в начало документа",
    ).toBeFocused();
  });

  test("переход по разделу закрывает бургер, а не оставляет его поверх", async ({ page }) => {
    await login(page, "psy");
    await page.goto("/today");
    await page.getByRole("main").getByRole("link", { name: /^Приём/ }).waitFor();

    await goMenu(page, "Пациенты");

    await expect(page).toHaveURL(/\/patients/);
    await expect(moreMenu(page), "новый экран читают сквозь меню").toBeHidden();
  });
});
