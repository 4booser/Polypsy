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
    await page.waitForSelector(".page-head h1");

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
    await page.waitForSelector(".page-head h1");

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
