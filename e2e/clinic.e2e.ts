import { expect, test } from "@playwright/test";
import { goCaseCard, goMenu, goTop, login, logout, rowTexts, patientLinks } from "./helpers";

/**
 * Сквозной клинический сценарий: тревога → пациент → сводка → направление →
 * реестр → закрытие. Это единственный тест, который проверяет контур целиком
 * так, как его проходит специалист, а не по кускам через API.
 */
test("от тревоги до закрытого направления", async ({ page }) => {
  await login(page, "psy");

  // «Случаи риска» в шесть пунктов полосы не вошли: они в бургере, в «Обзоре»
  await goMenu(page, /^Случаи риска/);
  // экран разбора: единица работы — человек, а не сработавший пункт
  await expect(page.getByRole("heading", { name: "Разбор случаев" })).toBeVisible();

  // из тревоги — к пациенту: полосой, как ходят каждый день
  await goTop(page, "Пациенты");
  const firstPatient = patientLinks(page).first();
  await firstPatient.click();

  /*
   * По щелчку открывается карточка пациента (кадр f19), а направления живут
   * в клинической карте за шестерёнкой — см. goCaseCard. Дожидаемся, что
   * вкладки карты отрисовались: это и есть признак, что карта на месте.
   */
  await goCaseCard(page);
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
  await goMenu(page, "Направления");
  await expect(page.getByText(reason)).toHaveCount(0);
  await page.getByRole("button", { name: "Показать завершённые" }).click();
  await expect(page.getByText(reason)).toBeVisible();
});

test("групповой админ не видит чужих пациентов", async ({ page }) => {
  await login(page, "psy");
  await goTop(page, "Пациенты");
  const mine = await rowTexts(page);

  await logout(page);
  await login(page, "psy2");
  await goTop(page, "Пациенты");
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
  await patientLinks(page).first().click();
  // записи приёма остались в клинической карте, а не на карточке f19
  await goCaseCard(page);

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
  await patientLinks(page).first().click();
  // план безопасности остался в клинической карте, а не на карточке f19
  await goCaseCard(page);

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
