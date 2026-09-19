import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { login, menuButton, openMenu } from "./helpers";

/**
 * Фокус внутри модальных слоёв.
 *
 * Диалог, из которого Tab выводит наружу, — не диалог, а картинка поверх
 * работающей страницы: человек с клавиатурой продолжает «нажимать кнопки
 * окна», а нажимает шапку и экран под ним и не видит, где он. Так и было:
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
 * Открыть палитру так, как это делает человек без ⌘K: бургер → «Поиск и
 * команды». Возвращает кнопку бургера — ей и должен достаться фокус после
 * Esc (см. expectTrapped).
 *
 * Бургер при этом закрывается сам, ДО открытия палитры: кнопка поиска в нём
 * зовёт onClose(), потом onSearch() (Topbar.tsx, MoreMenu). Так и должно
 * быть — меню было дорогой к палитре, а не окном, поверх которого работают;
 * оставшись открытым, оно легло бы под палитру, и после её закрытия человек
 * читал бы экран сквозь список. Значит палитра, открытая отсюда, стоит на
 * странице одна: слоёв не два, и правило «Esc гасит верхний» к ней не
 * относится — гасить, кроме неё, нечего. Два слоя с бургером возможны
 * только через ⌘K, и это проверяется отдельно ниже.
 *
 * Закрытие бургера проверяется явно, а не подразумевается: перестань он
 * закрываться — getByRole("dialog") в проверках ниже нашёл бы два диалога,
 * и падение называло бы строгий режим, а не причину.
 */
async function openPalette(page: Page): Promise<Locator> {
  const menu = await openMenu(page);
  await menu.getByRole("button", { name: /Поиск и команды/ }).click();
  await expect(menu, "бургер остался открытым под палитрой").toBeHidden();
  await page.locator(".palette").waitFor();
  return menuButton(page);
}

/**
 * Общая проверка для любого слоя: фокус не выходит, Esc возвращает открывшему.
 *
 * Одна на все слои намеренно — ловушка у них тоже одна, и разойтись
 * проверки не должны.
 *
 * `open` открывает слой и возвращает того, кому фокус обязан достаться после
 * Esc. Раньше это был тот же элемент, по которому нажали; у палитры теперь
 * не так: кнопка «Поиск и команды» лежит в бургере и исчезает вместе с ним
 * в момент открытия палитры. Возвращать фокус тогда некуда, кроме кнопки
 * бургера, — это последнее, на чём стояли руки человека, и она на месте.
 * Ослаблять здесь нечего: человек, нажавший Esc, должен оказаться там,
 * откуда пришёл, а не в начале документа, — ровно та поломка, ради которой
 * проверка и написана. Ловушка (useFocusTrap) запоминает «открывшего» по
 * document.activeElement на первом рендере слоя, то есть для палитры из
 * бургера — исчезающую кнопку поиска; вернуть фокус на бургер обязана
 * оболочка, и проверка требует этого от неё.
 */
async function expectTrapped(page: Page, open: () => Promise<Locator>, selector: string, name: string) {
  const returnTo = await open();
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
  await expect(returnTo, `после Esc фокус не вернулся тому, кто открыл «${name}»`).toBeFocused();
}

/** Открыть слой кнопкой витрины: ей же фокус и возвращается */
function byButton(button: Locator): () => Promise<Locator> {
  return async () => {
    await button.click();
    return button;
  };
}

test("диалог держит фокус внутри и возвращает его по Esc", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/ui");
  await expectTrapped(page, byButton(page.getByRole("button", { name: "Диалог", exact: true })), ".modal", "Диалог");
});

test("палитра команд держит фокус внутри и возвращает его по Esc", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/ui");
  await expectTrapped(page, () => openPalette(page), ".palette", "Палитра команд");
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
  /*
   * Через бургер, как человек: меню при этом закрывается, и его ловушка
   * снимается в тот же кадр, в который палитра ставит курсор в поиск. Этот
   * стык и проверяется: отпускающая ловушка меню не должна утащить фокус
   * обратно на кнопку бургера.
   */
  await openPalette(page);

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
  [
    "Палитра команд",
    async (page: Page) => {
      await openPalette(page);
    },
  ],
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
 * Бургер — тоже слой с ловушкой, и палитра может лечь поверх него.
 *
 * Из самого меню так не выйдет — его кнопка поиска сперва закрывает меню
 * (см. openPalette), — но ⌘K работает с любого экрана, в том числе при
 * открытом меню, и тогда слоёв два. Правило «Esc принадлежит верхнему»
 * касается бургера напрямую: его обработчик висит на документе и
 * срабатывает раньше оконного обработчика палитры (App.tsx), и закрывайся
 * он безусловно, одно нажатие гасило бы оба слоя. Topbar проверяет
 * isTopLayer — здесь это проверяется поведением, как и для окна витрины
 * выше, и заодно то, что бургер под палитрой не перехватывает фокус.
 */
test("⌘K поверх бургера: Esc гасит палитру, а бургер оставляет и потом возвращает фокус", async ({ page }) => {
  await login(page, "psy");
  const menu = await openMenu(page);

  await page.keyboard.press("Control+k");
  await page.locator(".palette").waitFor();

  // считаем, сколько раз фокус заглянул в меню под палитрой
  await menu.evaluate((el) => {
    const counter = window as unknown as { __under: number };
    counter.__under = 0;
    el.addEventListener("focusin", () => {
      counter.__under += 1;
    });
  });
  expect(await walk(page, ".palette", 4), "фокус ушёл из палитры, открытой поверх бургера").toEqual([]);
  expect(
    await page.evaluate(() => (window as unknown as { __under: number }).__under),
    "бургер под палитрой перехватывает фокус, пока человек работает в палитре",
  ).toBe(0);

  await page.keyboard.press("Escape");
  await expect(page.locator(".palette"), "палитра должна была закрыться").toHaveCount(0);
  await expect(menu, "бургер под палитрой закрылся тем же нажатием").toBeVisible();

  // второй Esc гасит уже сам бургер и возвращает фокус кнопке, которая его открыла
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(menuButton(page), "после Esc фокус не вернулся на кнопку бургера").toBeFocused();
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
  await openPalette(page);

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
