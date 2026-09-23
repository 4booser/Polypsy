import { expect, test } from "@playwright/test";
import { login, topNav } from "./helpers";

/**
 * Разовая диагностика: что видит браузер на раннере GitHub.
 *
 * Локально и в докер-стенде тот же набор зелёный, в CI — семьдесят одно
 * падение одинаковым составом дважды. Логи раннера показывают только
 * «элемент не найден», а нужно знать, ЧТО на странице вместо него: консоль,
 * адрес, наличие токена и начало разметки. Файл живёт до объяснения причины
 * и удаляется вместе с ней.
 *
 * Запускается только в диагностическом прогоне (E2E_DIAG), чтобы не удлинять
 * обычный смоук.
 */
test.skip(!process.env.E2E_DIAG, "только для диагностики");

test("рассказ о странице после входа и перезагрузки", async ({ page }) => {
  const console_: string[] = [];
  page.on("console", (m) => console_.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
  page.on("pageerror", (e) => console_.push(`pageerror: ${String(e).slice(0, 300)}`));
  const failed: string[] = [];
  page.on("requestfailed", (r) => failed.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));

  await login(page, "psy");
  const before = {
    url: page.url(),
    width: await page.evaluate(() => window.innerWidth),
    token: await page.evaluate(() => Object.keys(localStorage).join(",")),
    nav: await topNav(page).count(),
  };
  await page.reload();
  await page.waitForTimeout(3000);
  const after = {
    url: page.url(),
    width: await page.evaluate(() => window.innerWidth),
    token: await page.evaluate(() => Object.keys(localStorage).join(",")),
    nav: await topNav(page).count(),
    burger: await page.getByRole("button", { name: /Меню|Розділи|Разделы/ }).count(),
    body: (await page.evaluate(() => document.body.innerText)).slice(0, 400).replace(/\n+/g, " | "),
    html: (await page.evaluate(() => document.body.innerHTML)).slice(0, 600),
  };
  console.log("ДО:", JSON.stringify(before));
  console.log("ПОСЛЕ:", JSON.stringify(after));
  console.log("КОНСОЛЬ:", JSON.stringify(console_.slice(0, 25)));
  console.log("НЕ УДАЛИСЬ ЗАПРОСЫ:", JSON.stringify(failed.slice(0, 10)));
  expect(after.nav + after.burger, "после перезагрузки нет ни полосы разделов, ни бургера").toBeGreaterThan(0);
});
