import { expect, test } from "@playwright/test";
import { fieldByLabel, goTop, login, setEditLang } from "./helpers";

/**
 * Раскрыть меню шестерёнки конструктора.
 *
 * Имя меню несёт строку об автосохранении, когда черновик тронут
 * («Инструменты конструктора — черновик сохраняется сам»), поэтому имя
 * ищется по началу, а не целиком.
 */
async function openTools(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: /^Инструменты конструктора/ }).click();
}

const ITEMS = [
  "1. Я легко засыпаю после дежурства.",
  "2. Резкие звуки заставляют меня вздрагивать.",
  "3. Я могу спокойно говорить о том, что было.",
].join("\n");

test("методика создаётся из вставленного текста и публикуется", async ({ page }) => {
  await login(page, "psy");
  /*
   * В полосе методики подписаны «Тесты» (ключ top.tests): так их называет
   * заказчик на макете, и так их ищет человек. Пункт «Методики» в бургере
   * ведёт туда же, но сценарий идёт полосой — той дверью, которой ходят
   * каждый день, — и заодно проверяет, что подпись на месте.
   */
  await goTop(page, "Тесты");

  /*
   * Ссылки «Создать методику» в каталоге больше нет. По кадру f11 над списком
   * стоит один глиф «+» (имя по ключу cat.add), и он раскрывает меню «Новый
   * тест / Новая папка / Импорт из файла». Сценарий идёт этим путём, а не
   * прямым переходом на /constructor: прямой переход был бы зелёным и при
   * пропавшем меню, а человек в каталоге видит только «+».
   */
  await page.getByRole("button", { name: "Добавить", exact: true }).click();
  await page.getByRole("menu", { name: "Добавить" }).getByRole("menuitem", { name: "Новый тест" }).click();
  /*
   * Заголовка «Новый тест» на экране больше нет: по кадру f24_1 над вкладками
   * пусто, и заголовок оставлен только диктору (titleHidden). Поэтому
   * toBeAttached, а не toBeVisible: экран узнаётся по заголовку в дереве
   * доступности и по вкладкам ниже.
   */
  await expect(page.getByRole("heading", { level: 1, name: "Новый тест" })).toBeAttached();

  // вид теста по умолчанию — «Конкретный»: общий набор ответов и шкалы с ключом (кадр f24)
  await expect(page.getByRole("tab", { name: "Конкретный тест" })).toHaveAttribute("aria-selected", "true");

  /*
   * Название — на обоих языках, хотя поле одно: язык правки переключается
   * селектом на весь экран, а хранится текст по-прежнему парой {uk, ru}.
   * Проверяется именно пара: после переключения поле пустое (русский текст
   * не утёк в украинский), после возврата — прежнее значение на месте.
   * Сервер при создании одноязычное название пропустит (localizedSchema
   * принимает {uk?, ru?}, normalizeLocalized лишь выбрасывает пустые языки),
   * так что двуязычность здесь держит сценарий, а не сервер: методика для
   * украинского госпиталя без украинского названия — брак, который иначе
   * обнаружился бы на украинской консоли пациента.
   */
  const title = `Смоук ${Date.now()}`;
  const titleField = () => fieldByLabel(page, "Название теста");
  await titleField().fill(title);
  await setEditLang(page, "uk");
  await expect(titleField()).toHaveValue("");
  await titleField().fill(title);
  await setEditLang(page, "ru");
  await expect(titleField()).toHaveValue(title);

  /*
   * Главный сценарий переноса методики из пособия — вставка пунктов текстом.
   * Строка «Вставить пункты из текста» стоит под списком вопросов (ключ
   * co.bulkPaste) и открывает панель с полем; панель ищется по своему
   * заголовку, а поле в ней — единственное текстовое (два селекта рядом —
   * не textbox). Пункты в тесте по-русски, а панель по умолчанию кладёт текст
   * в украинский — язык выставляется явно, иначе пункты легли бы не в тот
   * ключ и в аккордеоне (он показывает язык правки) стояли бы без текста.
   */
  await page.getByRole("button", { name: "Вставить пункты из текста" }).click();
  const paste = page
    .locator("[data-panel]")
    .filter({ has: page.getByRole("heading", { name: "Вставка пунктов из текста" }) });
  await paste.getByRole("textbox").fill(ITEMS);
  await fieldByLabel(page, "Язык вставляемого текста").selectOption("ru");
  await paste.getByRole("button", { name: "Добавить 3 пунктов" }).click();

  /*
   * Вопросы — аккордеон (кадр f12): строка на пункт, свёрнутая, с именем
   * «N. текст … Развернуть вопрос». Счёт строк и текст первой — то же, что
   * прежде говорила вкладка «Вопросы 3», только теперь по самим пунктам.
   */
  const rows = page.getByRole("button", { name: /Развернуть вопрос$/ });
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("Я легко засыпаю после дежурства.");

  /*
   * Проверка структуры — пункт меню шестерёнки: на кадрах конструктора её нет
   * ни в полосе инструментов, ни рядом с «Створити», и она убрана с глаз
   * вместе с отменой, возвратом и предпросмотром. Отчёт по-прежнему выводится
   * над формой.
   * Важен не факт отчёта, а что ошибок в нём нет: сервер отказывает в
   * публикации при структурных ошибках (err.surveyPublishErrors), и без
   * этой проверки следующий шаг падал бы с невнятным «не удалось сохранить».
   */
  await openTools(page);
  await page.getByRole("menuitem", { name: "Проверить структуру" }).click();
  await expect(
    page.getByRole("heading", { name: /^(Структурных замечаний нет|Замечаний: 0 ошибок)/ }),
  ).toBeVisible();

  /*
   * «Опубликовать» в шапке (ключ cn.publish) заводит методику и публикует её
   * одним нажатием; «Создать» внизу (cn.create) оставила бы черновик, и в
   * каталоге на вкладке опубликованных его бы не было.
   */
  await page.getByRole("button", { name: "Опубликовать", exact: true }).click();

  // публикация уводит на аналитику новой методики: версия 1, прохождений нет
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByText(/^Версия 1 ·/)).toBeVisible();

  // каталог открывается на опубликованных, свежая методика — первой строкой
  await goTop(page, "Тесты");
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

  /*
   * Предпросмотр больше не стоит панелью справа: на всех кадрах конструктора
   * справа пусто, и он открывается пунктом меню шестерёнки — блоком под
   * формой.
   */
  await openTools(page);
  await page.getByRole("menuitem", { name: "Предпросмотр" }).click();

  const phone = page.locator(".preview-phone");
  await expect(phone).toBeVisible();

  const firstShown = await page.locator(".preview-question").textContent();

  /*
   * Вопросы — аккордеон, и свёрнутый пункт курсора не принимает: раньше
   * сценарий ставил курсор в поле второго пункта, теперь второй пункт
   * раскрывается строкой — конструктор сообщает предпросмотру номер при
   * раскрытии, а не только по фокусу в поле, и предпросмотр обязан перейти.
   */
  await page.getByRole("button", { name: /Развернуть вопрос$/ }).nth(1).click();
  await expect(page.locator(".preview-nav span")).toHaveText(/^2 \/ /);
  await expect(page.locator(".preview-question")).not.toHaveText(firstShown ?? "");

  // ключи и баллы в предпросмотр не попадают: человек их не видит
  await expect(phone).not.toContainText("Код ключа");
});
