import { expect, test } from "@playwright/test";
import { login, rowTexts, goVia } from "./helpers";

/**
 * Сквозной клинический сценарий: тревога → пациент → сводка → направление →
 * реестр → закрытие. Это единственный тест, который проверяет контур целиком
 * так, как его проходит специалист, а не по кускам через API.
 */
test("от тревоги до закрытого направления", async ({ page }) => {
  await login(page, "psy");

  await goVia(page, /Обзор/, /^Случаи риска/);
  // экран разбора: единица работы — человек, а не сработавший пункт
  await expect(page.getByRole("heading", { name: "Разбор случаев" })).toBeVisible();

  // из тревоги — к пациенту
  await goVia(page, /Люди/, "Пациенты");
  const firstPatient = page.locator("table tbody tr td a").first();
  await firstPatient.click();

  /*
   * Отдельного перехода на сводку больше нет: карта открывается сразу на
   * вкладке «Обзор». Дожидаемся, что вкладки отрисовались, — это и есть
   * признак, что карта на месте, а не список.
   */
  await page.getByRole("link", { name: "Хронология" }).waitFor();

  // имя берём с самой страницы: в ссылке рядом с ним стоят инициалы-аватарка,
  // и textContent вернул бы «ПДПетров Дмитрий»
  const patientName = (await page.locator("h1").textContent())!.trim();
  expect(patientName.length).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "Направления" })).toBeVisible();
  await expect(page.getByText("Направлений нет")).toBeVisible();

  await page.getByRole("button", { name: "Выписать направление" }).click();
  const reason = `Смоук ${Date.now()}`;
  await page.getByPlaceholder("что послужило поводом").fill(reason);
  await page.getByRole("button", { name: "Выписать", exact: true }).click();

  const row = page.locator("table tbody tr").filter({ hasText: reason });
  await expect(row).toBeVisible();
  await expect(row).toContainText("выписано");

  // статус движется только вперёд: сначала «принято», и лишь потом «завершено»
  await expect(row.getByRole("button", { name: "Завершено" })).toHaveCount(0);
  await row.getByRole("button", { name: "Принято" }).click();
  await expect(row).toContainText("принято");
  await row.getByRole("button", { name: "Завершено" }).click();
  await expect(row).toContainText("завершено");
  await expect(row.getByRole("button")).toHaveCount(0);

  // завершённого нет в реестре открытых, но оно находится с фильтром
  await goVia(page, /Люди/, "Направления");
  await expect(page.getByText(reason)).toHaveCount(0);
  await page.getByRole("button", { name: "Показать завершённые" }).click();
  await expect(page.getByText(reason)).toBeVisible();
});

test("групповой админ не видит чужих пациентов", async ({ page }) => {
  await login(page, "psy");
  await goVia(page, /Люди/, "Пациенты");
  const mine = await rowTexts(page);

  await page.getByRole("button", { name: /Выйти/i }).click();
  await login(page, "psy2");
  await goVia(page, /Люди/, "Пациенты");
  const theirs = await rowTexts(page);

  expect(mine.length).toBeGreaterThan(0);
  expect(theirs.length).toBeGreaterThan(0);
  // пересечение допустимо (общий пациент), полное совпадение списков — нет
  expect(mine.join("|")).not.toBe(theirs.join("|"));
});

test("запись приёма сохраняется, подписывается и становится неизменной", async ({ page }) => {
  /*
   * Заключение отвечает на вопрос «что показала методика»; приём бывает и без
   * методики. Проверяется тот же контур, что у заключения: черновик правится,
   * подпись фиксирует, правка поверх создаёт новую версию.
   */
  await login(page, "psy");
  await page.goto("/patients");
  await page.locator("table tbody tr td a").first().click();

  const notes = page.locator("[data-panel], .card").filter({ hasText: "Записи приёма" }).first();
  await expect(notes).toBeVisible();

  const text = `Беседа ${Date.now()}`;
  await notes.getByRole("button", { name: "Первичный" }).click();
  await notes.getByPlaceholder(/Жалобы|Новая запись/).fill(text);
  await notes.getByRole("button", { name: "Сохранить черновиком" }).click();

  /*
   * Ждём подтверждения сохранения, а не значения поля: поле держит текст с
   * момента набора, и проверка «в поле мой текст» проходила бы, даже если
   * запрос ещё летит. Именно на этом тест ловил гонку с подписью.
   */
  await expect(page.getByText("Черновик сохранён")).toBeVisible();

  await notes.getByRole("button", { name: "Подписать" }).click();
  // подписанная запись показывается отдельно, а поле освобождается под новую
  await expect(notes).toContainText(text);
  await expect(notes.getByPlaceholder("Новая запись поверх подписанной")).toHaveValue("");
});

test("план безопасности составляется и сохраняется версией", async ({ page }) => {
  /*
   * Не путать с safetyPlan методики: там инструкция инструмента, одинаковая
   * для всех. Здесь план конкретного человека — что делать ему самому, когда
   * рядом никого нет.
   */
  await login(page, "psy");
  await page.goto("/patients");
  await page.locator("table tbody tr td a").first().click();

  const card = page.locator("[data-panel], .card").filter({ hasText: "План безопасности" }).first();
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: /Составить план|Пересмотреть/ }).click();

  // порядок разделов воспроизводит порядок действий в кризисе
  const sign = `Не сплю ${Date.now()}`;
  await card.getByRole("button", { name: "+ Добавить строку" }).first().click();
  await card.getByPlaceholder("Своими словами").first().fill(sign);

  await card.getByRole("button", { name: "Сохранить новой версией" }).click();

  await expect(card.getByText(sign)).toBeVisible();
  await expect(card.getByText(/версия\s+\d+/)).toBeVisible();
});
