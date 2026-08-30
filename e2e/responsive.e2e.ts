import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Консоль на планшете и телефоне.
 *
 * Проверяется одно, но главное: страница никогда не едет вбок. Горизонтальная
 * прокрутка всего документа — это не «немного тесно», это сломанный экран:
 * половина содержимого оказывается за краем, и человек об этом не знает.
 *
 * Широкие таблицы листать вбок можно и нужно — но внутри своего контейнера.
 */
const SIZES = [
  { name: "планшет", width: 1024, height: 768 },
  { name: "телефон", width: 390, height: 844 },
] as const;

const SCREENS = [
  ["сводка", "/"],
  ["случаи риска", "/alerts"],
  ["пациенты", "/patients"],
  ["направления", "/referrals"],
] as const;

for (const size of SIZES) {
  test.describe(`${size.name} ${size.width}×${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    for (const [name, path] of SCREENS) {
      test(`«${name}» не едет вбок`, async ({ page }) => {
        await login(page, "psy");
        await page.goto(path);
        await page.locator("h1, .card, [data-panel]").first().waitFor();

        const overflow = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        // допуск в 1 px: округление при масштабировании — не поломка
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
      });
    }

    test("навигация доступна и ведёт куда надо", async ({ page }) => {
      await login(page, "psy");
      /*
       * На узком экране рельса не сжимает содержимое, а выезжает поверх:
       * деление на две колонки на 390 px не оставляет места ни одной таблице.
       * Поэтому сначала её открывают кнопкой, и это часть проверки.
       */
      const toggle = page.getByRole("button", { name: /меню|меню/i }).first();
      if (await toggle.isVisible()) await toggle.click();
      const link = page.locator(`.sidebar a[href="/patients"]`);
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(/\/patients/);
    });
  });
}
