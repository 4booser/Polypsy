import { expect, test } from "@playwright/test";
import { apiToken, auth, menuButton } from "./helpers";

/**
 * Выключенная учётка на экране входа (техпанель, волна 10).
 *
 * Обещание проверяется там, где его видит человек: сервер отказывает
 * выключенной учётке своим текстом («обліковий запис вимкнено»), и экран
 * входа обязан показать именно его — а не «неверный пароль», после которого
 * человек пробует ещё пять раз и упирается в блокировку. Сами правила
 * (обмен токена, живой токен, журнал) проверены тестом API
 * (apps/api/test/opsAccounts.test.ts); здесь — что текст доехал до глаз.
 *
 * Учётка заводится своя на каждый прогон: выключать учётки посева значило бы
 * ломать соседние сценарии.
 */
test("выключенная учётка не входит и видит, почему", async ({ page }) => {
  const root = await apiToken(page, "superadmin");
  const email = `ops-off-${Date.now()}@test.local`;
  const password = "ops-e2e-12345";

  const made = await page.request.post("/api/users", {
    headers: auth(root),
    data: { email, password, firstName: "Вимкнений", lastName: "Смоук", role: "admin" },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const { id } = (await made.json()) as { id: string };

  const off = await page.request.post(`/api/ops/users/${id}/disable`, {
    headers: auth(root),
    data: { reason: "Сквозной сценарий выключения" },
  });
  expect(off.ok(), await off.text()).toBe(true);

  await page.goto("/login");
  await page.getByLabel(/^(Логин|Логін)$/).fill(email);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: /^(Войти|Увійти)$/ }).click();

  // отказ объявлен диктору и назван словами сервера — на любом из двух языков
  await expect(page.getByRole("alert")).toContainText(/вимкнено|отключена/i);
  await expect(menuButton(page)).toHaveCount(0);
});
