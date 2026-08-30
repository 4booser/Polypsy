import { expect, test } from "@playwright/test";
import { fieldByLabel, login } from "./helpers";

const ITEMS = [
  "1. Я легко засыпаю после дежурства.",
  "2. Резкие звуки заставляют меня вздрагивать.",
  "3. Я могу спокойно говорить о том, что было.",
].join("\n");

test("методика создаётся из вставленного текста и публикуется", async ({ page }) => {
  await login(page, "psy");
  await page.getByRole("link", { name: "Методики" }).click();
  await page.getByRole("link", { name: "Создать методику" }).click();
  await expect(page.getByRole("heading", { name: "Новая методика" })).toBeVisible();

  const title = `Смоук ${Date.now()}`;
  await fieldByLabel(page, "Название", "ru").fill(title);
  await fieldByLabel(page, "Название", "uk").fill(title);

  // главный сценарий переноса методики из пособия — вставка пунктов текстом
  await page.getByRole("button", { name: /^Вопросы/ }).click();
  await page.getByRole("button", { name: "Вставить пункты из текста" }).click();
  await page.getByRole("textbox").filter({ hasText: "" }).last().fill(ITEMS);
  await page.getByRole("button", { name: /Добавить 3 пункт/ }).click();

  await expect(page.getByRole("button", { name: "Вопросы 3" })).toBeVisible();

  await page.getByRole("button", { name: "Проверить структуру" }).click();
  await page.getByRole("button", { name: "Сохранить и опубликовать" }).click();

  // публикация уводит на аналитику новой методики: версия 1, прохождений нет
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("версия 1")).toBeVisible();

  await page.getByRole("link", { name: "Методики" }).click();
  await expect(page.getByRole("link", { name: title })).toBeVisible();
});

test("предпросмотр показывает пункт, который правят", async ({ page }) => {
  /*
   * Раньше вид пункта был виден только после публикации и прохождения:
   * длинная формулировка, не влезающая в экран телефона, обнаруживалась
   * на пациенте.
   */
  await login(page, "psy");
  const token = await page.evaluate(() => localStorage.getItem("quizzy.web.token"));
  const surveys = await (
    await page.request.get("/api/surveys", { headers: { Authorization: `Bearer ${token}` } })
  ).json();

  // нужна методика с пунктами: у пустого черновика предпросмотру нечего показывать
  let withQuestions: string | null = null;
  for (const s of surveys.items as { id: string; status: string }[]) {
    if (s.status !== "published") continue;
    const detail = await (
      await page.request.get(`/api/surveys/${s.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    if ((detail.questions ?? []).length >= 2) {
      withQuestions = s.id;
      break;
    }
  }
  expect(withQuestions).not.toBeNull();

  await page.goto(`/constructor/${withQuestions}`);
  await page.getByRole("button", { name: /^Вопросы/ }).click();

  const phone = page.locator(".preview-phone");
  await expect(phone).toBeVisible();

  const firstShown = await page.locator(".preview-question").textContent();

  // ставим курсор во второй пункт — предпросмотр обязан перейти к нему
  await page.locator(".constructor-main [data-panel], .constructor-main .card").nth(2).locator("textarea").first().focus();
  await expect(page.locator(".preview-nav span")).not.toHaveText("1 / 1");
  await expect(page.locator(".preview-question")).not.toHaveText(firstShown ?? "");

  // ключи и баллы в предпросмотр не попадают: человек их не видит
  await expect(phone).not.toContainText("Код ключа");
});
