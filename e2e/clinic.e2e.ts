import { expect, test } from "@playwright/test";
import { login, rowTexts } from "./helpers";

/**
 * Сквозной клинический сценарий: тревога → пациент → сводка → направление →
 * реестр → закрытие. Это единственный тест, который проверяет контур целиком
 * так, как его проходит специалист, а не по кускам через API.
 */
test("от тревоги до закрытого направления", async ({ page }) => {
  await login(page, "psy");

  await page.getByRole("link", { name: /^Случаи риска/ }).click();
  // экран разбора: единица работы — человек, а не сработавший пункт
  await expect(page.getByRole("heading", { name: "Разбор случаев" })).toBeVisible();

  // из тревоги — к пациенту
  await page.getByRole("link", { name: "Пациенты" }).click();
  const firstPatient = page.locator("table tbody tr td a").first();
  await firstPatient.click();

  // сначала дожидаемся, что страница пациента отрисовалась: заголовок читается
  // сразу после клика и успевает вернуть ещё «Пациенты»
  const summaryLink = page.getByRole("link", { name: "Сводка для консилиума" });
  await summaryLink.waitFor();

  // имя берём с самой страницы: в ссылке рядом с ним стоят инициалы-аватарка,
  // и textContent вернул бы «ПДПетров Дмитрий»
  const patientName = (await page.locator(".page-head h1").textContent())!.trim();
  expect(patientName.length).toBeGreaterThan(0);

  await summaryLink.click();
  await expect(page.locator(".page-head h1")).toHaveText(patientName);
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
  await page.getByRole("link", { name: "Направления" }).click();
  await expect(page.getByText(reason)).toHaveCount(0);
  await page.getByRole("button", { name: "Показать завершённые" }).click();
  await expect(page.getByText(reason)).toBeVisible();
});

test("групповой админ не видит чужих пациентов", async ({ page }) => {
  await login(page, "psy");
  await page.getByRole("link", { name: "Пациенты" }).click();
  const mine = await rowTexts(page);

  await page.getByRole("button", { name: /Выйти/i }).click();
  await login(page, "psy2");
  await page.getByRole("link", { name: "Пациенты" }).click();
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
  await page.getByRole("link", { name: "Сводка для консилиума" }).click();

  const notes = page.locator(".card").filter({ hasText: "Записи приёма" }).first();
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
  await page.getByRole("link", { name: "Сводка для консилиума" }).click();

  const card = page.locator(".card").filter({ hasText: "План безопасности" }).first();
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

test("цель лечения ставится измеримо и показывает прогресс", async ({ page }) => {
  /*
   * «Стало полегче» нельзя ни проверить, ни передать коллеге. Цель привязана
   * к шкале и значению — и тогда прогресс считается из тех же замеров, что и
   * вся аналитика.
   */
  await login(page, "psy");
  await page.goto("/patients");
  await page.locator("table tbody tr td a").first().click();
  await page.getByRole("link", { name: "Сводка для консилиума" }).click();

  const card = page.locator(".card").filter({ hasText: "Цели лечения" }).first();
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "Поставить цель" }).click();
  await card.locator("#goal-survey").selectOption({ index: 1 });
  await card.locator("#goal-scale").selectOption({ index: 1 });
  await card.locator("#goal-target").fill("0.1");
  await card.getByRole("button", { name: "Поставить", exact: true }).click();

  const goal = card.locator(".goal").first();
  await expect(goal).toBeVisible();
  // видно точку отсчёта, цель и текущее значение — всё из замеров
  await expect(goal).toContainText("от");
  await expect(goal).toContainText("сейчас");

  await goal.getByRole("button", { name: "Достигнута", exact: true }).click();
  await expect(card.locator(".goal.closed").first()).toBeVisible();
});

test("консилиум собирает мнения и фиксирует решение", async ({ page }) => {
  /*
   * Особое мнение показывается отдельно и заметно: протокол не должен
   * выглядеть единогласным, каким он не был.
   */
  await login(page, "psy");
  await page.goto("/patients");
  await page.locator("table tbody tr td a").first().click();
  await page.getByRole("link", { name: "Сводка для консилиума" }).click();

  const card = page.locator(".card").filter({ hasText: "Консилиум" }).first();
  await expect(card).toBeVisible();

  const reason = `Повод ${Date.now()}`;
  await card.getByPlaceholder("Повод: что обсуждаем").fill(reason);
  await card.getByRole("button", { name: "Вынести на консилиум" }).click();

  const conference = card.locator(".conference").filter({ hasText: reason }).first();
  await expect(conference).toBeVisible();

  // решение без единого мнения недоступно
  await expect(conference.getByRole("button", { name: "Зафиксировать решение" })).toBeDisabled();

  await conference.getByPlaceholder("Ваше мнение по случаю").fill("Оставить под наблюдением");
  await conference.getByRole("button", { name: "Особое мнение" }).click();
  await expect(conference.locator(".opinion.dissent")).toBeVisible();

  await conference.getByPlaceholder("Решение консилиума").fill("Повторный замер через две недели");
  await conference.getByRole("button", { name: "Зафиксировать решение" }).click();
  await expect(conference).toContainText("решение принято");
});
