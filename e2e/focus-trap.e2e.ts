import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Фокус внутри модальных слоёв.
 *
 * Диалог, из которого Tab выводит наружу, — не диалог, а картинка поверх
 * работающей страницы: человек с клавиатурой продолжает «нажимать кнопки
 * окна», а нажимает разделы рельсы под ним и не видит, где он. Так и было:
 * два Tab из окна витрины уводили на рельсу, один Tab из палитры — в тело
 * страницы, а после Esc фокус оставался там, куда его занесло.
 *
 * Проверяется поведение, а не наличие кода: обход клавишами настоящий, и
 * нажатий делается заведомо больше, чем в слое фокусируемых элементов, —
 * ловушка, которая держит один круг и отпускает на втором, тоже должна
 * попасться.
 */

/** Чем сейчас владеет фокус — человеческим именем, а не «element» */
async function focusName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "ничего";
    const text = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
    return text ? `${el.tagName}«${text}»` : el.tagName;
  });
}

/** Внутри ли слоя фокус прямо сейчас */
async function focusInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(
    (sel) => !!(document.activeElement as HTMLElement | null)?.closest(sel),
    selector,
  );
}

/** Сколько в слое элементов, достижимых клавишей Tab */
async function focusableCount(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const box = document.querySelector(sel);
    if (!box) return 0;
    return box.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex^="-"])',
    ).length;
  }, selector);
}

/**
 * Обойти слой клавишами и вернуть список побегов.
 *
 * Возвращается именно список — с номером шага и именем элемента, на котором
 * фокус оказался снаружи. Голое «ожидалось true» заставило бы разбираться
 * заново; здесь падение сразу называет виновника: тот самый пункт рельсы за
 * пределами окна.
 */
async function walk(page: Page, selector: string, steps: number, back = false): Promise<string[]> {
  const escapes: string[] = [];
  for (let i = 1; i <= steps; i += 1) {
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    if (!(await focusInside(page, selector))) {
      escapes.push(`${back ? "Shift+Tab" : "Tab"} №${i} → ${await focusName(page)}`);
    }
  }
  return escapes;
}

/**
 * Общая проверка для любого слоя: фокус не выходит, Esc возвращает открывшему.
 *
 * Одна на оба диалога намеренно — ловушка у них тоже одна, и разойтись
 * проверки не должны.
 */
async function expectTrapped(page: Page, opener: Locator, selector: string, name: string) {
  await opener.click();
  const layer = page.locator(selector);
  await layer.waitFor();

  // диктор должен узнать о границе — иначе за окном для него вся страница
  await expect(layer, `у слоя «${name}» нет aria-modal — для диктора границы нет`)
    .toHaveAttribute("aria-modal", "true");
  await expect(layer, `слой «${name}» не объявлен диалогом`).toHaveAttribute("role", "dialog");

  // нажатий строго больше, чем элементов: круг обязан замкнуться и повториться
  const steps = (await focusableCount(page, selector)) + 3;
  expect(steps, `в слое «${name}» не нашлось ни одного элемента для обхода`).toBeGreaterThan(3);

  expect(
    await walk(page, selector, steps),
    `фокус вышел за пределы слоя «${name}» по Tab`,
  ).toEqual([]);
  expect(
    await walk(page, selector, steps, true),
    `фокус вышел за пределы слоя «${name}» по Shift+Tab`,
  ).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(layer).toBeHidden();
  /*
   * Возврат — не украшение: без него человек после Esc продолжает работу с
   * того места, куда его случайно занесло обходом, а не оттуда, откуда он
   * открывал слой.
   */
  await expect(opener, `после Esc фокус не вернулся на кнопку, открывшую «${name}»`).toBeFocused();
}

test("диалог держит фокус внутри и возвращает его по Esc", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/ui");
  await expectTrapped(page, page.getByRole("button", { name: "Диалог", exact: true }), ".modal", "Диалог");
});

test("палитра команд держит фокус внутри и возвращает его по Esc", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/ui");
  await expectTrapped(
    page,
    page.getByRole("button", { name: /Поиск и команды/ }),
    ".palette",
    "Палитра команд",
  );
});

/**
 * Ловушка не отнимает фокус у того, кто занял его сам.
 *
 * Палитра ставит курсор в поиск при открытии, и весь смысл ⌘K в том, что
 * фамилию набирают сразу, не глядя на экран. Ловушка, которая тянет фокус на
 * контейнер слоя «чтобы диктор объявил диалог», вынимает курсор из поля:
 * человек видит палитру с пустым поиском, в который он якобы печатает.
 */
test("палитра открывается с курсором в поиске", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/ui");
  await page.getByRole("button", { name: /Поиск и команды/ }).click();
  await page.locator(".palette").waitFor();

  await expect(
    page.locator(".palette input"),
    "палитра открылась с курсором не в поиске",
  ).toBeFocused();

  await page.keyboard.type("свод");
  await expect(
    page.locator(".palette input"),
    "набранное после открытия не дошло до поиска палитры",
  ).toHaveValue("свод");
});

/**
 * Ловушка не заменяет объявление границы.
 *
 * Диктор ходит по странице своим курсором, фокус DOM при этом не двигается —
 * то есть на перехват Tab ему опереться нечем. Границу слоя ему называет
 * aria-modal вместе с именем диалога, и проверять это надо отдельно: слой,
 * запертый для клавиатуры, но не объявленный, для незрячего остаётся куском
 * страницы, под которым лежит ещё одна, якобы рабочая.
 */
for (const [name, open] of [
  ["Диалог", async (page: Page) => page.getByRole("button", { name: "Диалог", exact: true }).click()],
  ["Палитра команд", async (page: Page) => page.getByRole("button", { name: /Поиск и команды/ }).click()],
] as const) {
  test(`слой «${name}» объявлен диктору как диалог`, async ({ page }) => {
    await login(page, "psy");
    await page.goto("/ui");
    await open(page);
    const layer = page.getByRole("dialog");
    await expect(layer).toBeVisible();
    // имя обязательно: «диалог» без имени не говорит, куда человек попал
    await expect(layer).toHaveAccessibleName(/.+/);

    /*
     * Ждём конца появления слоя.
     *
     * Оба слоя выезжают и проявляются; пока идёт анимация, они полупрозрачны,
     * и проверка контраста меряет цвет, которого через долю секунды не будет.
     * Один прогон на этом и споткнулся: отказ был настоящим по числам и
     * ложным по сути.
     */
    await layer.evaluate(async (el) => {
      await Promise.allSettled(el.getAnimations({ subtree: true }).map((a) => a.finished));
    });

    const scan = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      scan.violations.flatMap((v) => v.nodes.map((n) => `${v.id} → ${n.target.join(" ")}`)),
    ).toEqual([]);
  });
}

/**
 * Слой поверх слоя: фокус держит верхний, и только он.
 *
 * ⌘K работает с любого экрана, в том числе поверх открытого окна, — и тогда
 * ловушек в странице две. Проверяется не только то, где фокус оказался: две
 * ловушки, хватающие один Tab, приводят фокус в верхний слой обеими руками —
 * сперва нижняя тянет его к себе, потом верхняя забирает обратно. Глазами
 * это незаметно, но окно под палитрой успевает получить фокус и разослать
 * события своим полям: у поля с проверкой при потере фокуса это настоящее
 * срабатывание, которого человек не просил.
 */
test("палитра поверх диалога забирает фокус себе, а не делит его с окном", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/ui");
  await page.getByRole("button", { name: "Диалог", exact: true }).click();
  await page.locator(".modal").waitFor();

  await page.keyboard.press("Control+k");
  await page.locator(".palette").waitFor();

  // считаем, сколько раз фокус заглянул в окно под палитрой
  await page.evaluate(() => {
    const counter = window as unknown as { __under: number };
    counter.__under = 0;
    document
      .querySelector(".modal")
      ?.addEventListener("focusin", () => {
        counter.__under += 1;
      });
  });

  expect(
    await walk(page, ".palette", 4),
    "фокус ушёл из палитры, открытой поверх окна",
  ).toEqual([]);

  expect(
    await page.evaluate(() => (window as unknown as { __under: number }).__under),
    "окно под палитрой перехватывает фокус, пока человек работает в палитре",
  ).toBe(0);
});

/**
 * Esc гасит один слой — верхний.
 *
 * Обработчики слоёв висят на разных целях: у диалога на документе, у палитры
 * на окне, — и документ срабатывает раньше. Пока каждый слой закрывался по
 * Esc безусловно, одно нажатие гасило оба сразу: человек терял и то, что
 * открыл только что, и то, из чего он это открыл. Останавливать событие
 * бесполезно — нижний слой уже успел его увидеть; решает правило «Esc
 * принадлежит верхнему», то же, по которому распределяется Tab.
 */
test("Esc закрывает палитру поверх диалога, а диалог оставляет", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/ui");
  await page.getByRole("button", { name: "Диалог", exact: true }).click();
  await page.locator(".modal").waitFor();

  await page.keyboard.press("Control+k");
  await page.locator(".palette").waitFor();

  await page.keyboard.press("Escape");

  await expect(page.locator(".palette"), "палитра должна была закрыться").toHaveCount(0);
  await expect(
    page.locator(".modal"),
    "диалог под палитрой закрылся тем же нажатием",
  ).toHaveCount(1);

  // и второй Esc закрывает уже сам диалог — иначе из него не выйти
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
});

/**
 * Пустой слой не запирает.
 *
 * Ловушка, которая держит человека в диалоге без единой достижимой кнопки, —
 * тупик без выхода: нажимать нечего, уйти нельзя. Такой слой — поломка, и
 * платить за неё застреванием человек не должен. Проверяется на палитре: её
 * содержимое вычищается прямо в разметке, и остаётся пустая коробка.
 */
test("из слоя без единого элемента фокус выпускается", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/ui");
  await page.getByRole("button", { name: /Поиск и команды/ }).click();
  await page.locator(".palette").waitFor();

  await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>(".palette");
    if (!box) throw new Error("палитра не открылась");
    box.replaceChildren();
    box.focus();
  });

  await page.keyboard.press("Tab");
  expect(
    await focusInside(page, ".palette"),
    "фокус заперт в слое, в котором не на чем стоять",
  ).toBe(false);
});
