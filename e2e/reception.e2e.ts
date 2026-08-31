import { expect, test } from "@playwright/test";
import { login } from "./helpers";

/**
 * Приём: экран дня и обычная неделя.
 *
 * Отдельным файлом от clinic.e2e.ts: там сквозной клинический контур —
 * тревога, карта, заключение, направление, — а здесь организация приёма.
 * Смешать их значило бы получить файл, который падает целиком, когда сломано
 * что-то одно.
 */
test("день виден целиком и явка отмечается одним нажатием", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/today");

  await expect(page.getByRole("heading", { name: "Сегодня" })).toBeVisible();

  /*
   * В посеве четыре приёма в разных состояниях — именно поэтому экран и
   * показывает картину дня, а не очередь: принятые остаются на месте.
   */
  const rows = page.locator('a[href^="/patients/"]');
  await expect(rows.first()).toBeVisible();

  // ждущий приём предлагает ровно одно следующее действие
  const came = page.getByRole("button", { name: "Пришёл" }).first();
  await expect(came).toBeVisible();
  await came.click();

  // после отметки следующая кнопка — «Начать», а не снова «Пришёл»
  await expect(page.getByRole("button", { name: "Начать" }).first()).toBeVisible();
});

test("неподтверждённый приём помечен, а закреплённого не предлагают закреплять", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/today");

  await expect(page.getByText("не подтвердил").first()).toBeVisible();

  /*
   * Один человек в посеве уже закреплён за специалистом. Кнопок «Закрепить
   * за собой» должно быть меньше, чем строк: иначе пометка «без ведущего»
   * ничего не различает.
   */
  const rowCount = await page.locator('a[href^="/patients/"]').count();
  const takeCount = await page.getByRole("button", { name: "Закрепить за собой" }).count();
  expect(takeCount).toBeLessThan(rowCount);
});

test("неявку, поставленную фоном, можно исправить с экрана", async ({ page }) => {
  /*
   * Неявку ставит и человек, и фоновый проход. Ошибается он там, где кнопку
   * забыли нажать, — и если исправить это негде, напоминание уйдёт тому, кто
   * пришёл.
   */
  await login(page, "psy");
  await page.goto("/today");

  const missed = page.locator('div:has-text("не пришёл")').last();
  await expect(missed).toBeVisible();
  await expect(page.getByRole("button", { name: "Пришёл" }).first()).toBeVisible();
});

test("сохранение недели отвечает числами, а не словом «сохранено»", async ({ page }) => {
  await login(page, "psy");
  await page.goto("/my-schedule");

  await expect(page.getByRole("heading", { name: "Расписание приёма" })).toBeVisible();
  // предупреждение о занятом времени стоит до кнопки, а не в справке
  await expect(page.getByText("Занятое время вне расписания не исчезает")).toBeVisible();

  await page.getByRole("button", { name: "Сохранить неделю" }).click();
  await expect(page.getByText(/Добавлено \d+, снято \d+/)).toBeVisible();
});

test("экран приёма собирается одним запросом и держит набранный текст", async ({ page }) => {
  /*
   * Три панели без переходов между вкладками. Специалист открывает экран,
   * когда человек уже сидит перед ним, и любой уход отсюда стоит либо
   * набранного протокола, либо внимания пациента.
   */
  await login(page, "psy");
  await page.goto("/today");

  // с «Сегодня» — прямо на приём
  await page.locator('a[href^="/visit/"]').first().click();
  await expect(page.getByRole("heading", { name: "Приём", exact: true })).toBeVisible();

  // все три панели на месте сразу, а не по очереди
  await expect(page.getByText("Что было")).toBeVisible();
  await expect(page.getByText("Протокол приёма")).toBeVisible();
  await expect(page.getByText("Действия")).toBeVisible();

  // шаблон подставляется по нажатию, а не сам
  const area = page.locator("textarea").first();
  await expect(area).toHaveValue("");
  await page.getByRole("button", { name: "Подставить шаблон" }).click();
  await expect(area).not.toHaveValue("");

  // и сохраняется, не уводя с экрана
  await area.fill("Состояние ровное, договорились о повторе через неделю.");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByRole("heading", { name: "Приём", exact: true })).toBeVisible();
  await expect(area).toHaveValue(/договорились/);
});

test("на первом приёме видно, что человек здесь впервые", async ({ page }) => {
  /*
   * Записаться можно к любому свободному специалисту, и человек легко
   * попадает к третьему подряд. Принимающий сегодня должен видеть, что он не
   * первый, до того как начнёт задавать вопросы, которые уже задавали.
   */
  await login(page, "psy");
  await page.goto("/today");
  await page.locator('a[href^="/visit/"]').first().click();

  const marker = page.getByText(/Был у|Первый приём здесь/).first();
  await expect(marker).toBeVisible();
});
