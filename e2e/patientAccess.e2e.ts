import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { goMenu, login, menuButton, moreMenu, openMenu, topNav } from "./helpers";

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
    await page.getByRole("link", { name: "Тесты" }).waitFor();
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
  await page
    .locator('a[href^="/me/tests/"]')
    .filter({ hasNotText: "Адаптивность" })
    .filter({ hasNotText: "Мини-мульт" })
    .first()
    .click();
  await page.getByRole("heading", { level: 1 }).waitFor();

  /* мишени прохождения меряются там же, где и всё остальное */
  expect(await tooSmall(page), "мишень меньше пальца в прохождении").toEqual([]);
  expect(await axeDigest(page), "автопроверка доступности в прохождении").toEqual([]);

  /*
   * Полоса прогресса названа и имеет значение.
   *
   * Зрячему числа по-прежнему не показываем — оно живёт только в
   * aria-valuetext, то есть слышно диктору и невидимо на экране.
   */
  const bar = page.getByRole("progressbar");
  await expect(bar).toHaveAttribute("aria-valuenow", "1");
  await expect(bar).toHaveAttribute("aria-valuetext", /1 из \d+|Информация/);
  /*
   * Число есть в разметке и его нет на экране: «вопрос 7 из 45» впереди
   * пугает, и решение не показывать его остаётся в силе. Меряем именно
   * ширину — текст в разметке присутствует, но занимает пиксель.
   */
  const counter = page.locator("h1 span").first();
  await expect(counter).toHaveText(/1 из \d+/);
  expect(
    await counter.evaluate((el) => el.getBoundingClientRect().width),
    "счётчик пунктов виден зрячему — он должен быть слышен только диктору",
  ).toBeLessThanOrEqual(1);

  const first = (await page.getByRole("heading", { level: 1 }).textContent())?.trim();

  // отвечаем и идём дальше КЛАВИАТУРОЙ: мышью потеря фокуса не видна
  await page.locator("button[aria-pressed]").first().click();
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
   * Ниже 1100 px шесть пунктов полосы спрятаны, а список бургера, пока он
   * закрыт, не отрисован вовсе. Проверка всё равно нажимает Tab, а не
   * смотрит на класс: рельса, которую полоса сменила, была задвинута
   * трансформацией — выглядела скрытой и при этом принимала фокус из-за
   * края, — и спрятать пункты так же снова можно одной строкой стилей.
   * Автопроверка доступности об этом молчит по построению.
   */
  test("спрятанные пункты меню не забирают первые нажатия Tab", async ({ page }) => {
    await login(page, "psy");
    await page.goto("/today");
    await page.getByRole("link", { name: "Сегодня" }).waitFor();

    // предпосылка: на этой ширине пункты действительно спрятаны — иначе проверять нечего
    await expect(topNav(page), "на телефоне полоса разделов должна быть спрятана").toBeHidden();

    const visited: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      visited.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return "нет";
          /*
           * Спрятанное — это пункты полосы и список бургера (диалог, которого
           * при закрытом меню быть не должно). Сама шапка — знак, язык, кнопка
           * бургера — видна и в порядке табуляции стоит по праву.
           */
          const hidden =
            !!document.querySelector("header nav")?.contains(el) || !!el.closest('[role="dialog"]');
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
    await page.getByRole("link", { name: "Сегодня" }).waitFor();

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
    await page.getByRole("link", { name: "Сегодня" }).waitFor();

    await goMenu(page, "Пациенты");

    await expect(page).toHaveURL(/\/patients/);
    await expect(moreMenu(page), "новый экран читают сквозь меню").toBeHidden();
  });
});
