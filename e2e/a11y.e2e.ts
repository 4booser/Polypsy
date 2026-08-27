import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

/**
 * Доступность проверяется автоматически там, где это возможно: контраст,
 * подписи полей, роли, порядок заголовков. Автопроверка ловит примерно
 * половину реальных проблем — остальное только руками, но эта половина
 * возвращается при каждой правке вёрстки, и ловить её должен CI.
 */
async function scan(page: Page) {
  return new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
}

/** Нарушения в читаемом виде: id правила и селекторы, а не «ожидалось []» */
function digest(violations: Awaited<ReturnType<typeof scan>>["violations"]) {
  return violations.flatMap((v) => v.nodes.map((n) => `${v.id} → ${n.target.join(" ")}`));
}

test("экран входа доступен", async ({ page }) => {
  await page.goto("/");
  expect(digest((await scan(page)).violations)).toEqual([]);
});

// обе темы: тёмная по умолчанию, светлая — та, в которой работают при дневном
// свете, и контраст в ней проваливается независимо
for (const theme of ["dark", "light"] as const) {
  for (const [name, path] of [
    ["сводка", "/"],
    ["пациенты", "/patients"],
    ["случаи риска", "/alerts"],
    ["направления", "/referrals"],
  ] as const) {
    test(`экран «${name}» доступен, тема ${theme}`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("quizzy.theme", t), theme);
      await login(page, "psy");
      await page.goto(path);
      await page.locator(".page-head, .card").first().waitFor();
      expect(digest((await scan(page)).violations)).toEqual([]);
    });
  }
}
