import { expect, test } from "@playwright/test";
import { fieldByLabel, goRail, login, setEditLang } from "./helpers";

const ITEMS = [
  "1. Я легко засыпаю после дежурства.",
  "2. Резкие звуки заставляют меня вздрагивать.",
  "3. Я могу спокойно говорить о том, что было.",
].join("\n");

test("методика создаётся из вставленного текста и публикуется", async ({ page }) => {
  await login(page, "psy");
  /*
   * Каталог — раздел «Методики» рельсы: сценарий идёт той дверью, которой
   * ходят каждый день, — и заодно проверяет, что она на месте.
   */
  await goRail(page, "Методики");

  /*
   * «Нова методика» — основная кнопка в шапке каталога (UI 3, волна 25;
   * клавиша N). Сценарий идёт этой дверью, а не прямым переходом на
   * /constructor: прямой переход был бы зелёным и при пропавшей кнопке.
   */
  await page.getByRole("link", { name: "Новая методика", exact: true }).click();
  /*
   * Старт новой методики (макет methods-new): способы начать — карточки-
   * радио. Главный путь переноса методики из пособия — вставка пунктов
   * текстом: выбор карточки сам открывает ящик вставки.
   */
  await expect(page.getByRole("heading", { level: 1, name: "Новая методика" })).toBeVisible();
  await page.getByRole("radio", { name: /Вставить пункты из текста/ }).check();
  const paste = page.getByRole("dialog", { name: "Вставка пунктов из текста" });
  await paste.getByRole("textbox").fill(ITEMS);
  /*
   * Пункты в тесте по-русски: язык текста ставится явно, иначе пункты легли
   * бы не в тот ключ и в списке (он показывает язык правки) стояли бы без
   * текста.
   */
  await paste.getByRole("group", { name: "Язык вставляемого текста" }).getByRole("button", { name: "русский" }).click();
  await paste.getByRole("button", { name: "Создать черновик" }).click();

  /*
   * Правка новой, ещё не сохранённой методики: /constructor/new, раздел
   * «Основное». Название — на обоих языках, хотя поле одно: язык правки
   * переключается на весь экран, а хранится текст парой {uk, ru}.
   * Проверяется именно пара: после переключения поле пустое (русский текст
   * не утёк в украинский), после возврата — прежнее значение на месте.
   */
  await expect(page).toHaveURL(/\/constructor\/new$/);
  const title = `Смоук ${Date.now()}`;
  const titleField = () => fieldByLabel(page, "Название методики");
  await titleField().fill(title);
  await setEditLang(page, "uk");
  await expect(titleField()).toHaveValue("");
  await titleField().fill(title);
  await setEditLang(page, "ru");
  await expect(titleField()).toHaveValue(title);

  /*
   * Пункты — раздел «Вопросы» колонки структуры: свёрнутая строка на пункт с
   * именем «N текст … Развернуть вопрос». Счёт строк и текст первой — то,
   * что вставили.
   */
  await page.getByRole("navigation", { name: "Разделы методики" }).getByRole("button", { name: /^Вопросы/ }).click();
  const rows = page.getByRole("button", { name: /Развернуть вопрос$/ });
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("Я легко засыпаю после дежурства.");

  /*
   * Проверка структуры — кнопка в шапке, отчёт — в ящике. Важен не факт
   * отчёта, а что ошибок в нём нет: сервер отказывает в публикации при
   * структурных ошибках (err.surveyPublishErrors), и без этой проверки
   * следующий шаг падал бы с невнятным «не удалось сохранить».
   */
  await page.getByRole("button", { name: /^Проверить структуру/ }).click();
  const check = page.getByRole("dialog", { name: "Проверить структуру" });
  await expect(
    check.getByRole("heading", { name: /^(Структурных замечаний нет|Замечаний: 0 ошибок)/ }),
  ).toBeVisible();

  /*
   * «Опубликовать» в ящике проверки (ключ cn.publish) заводит методику и
   * публикует её одним нажатием; «Создать» в шапке (cn.create) оставила бы
   * черновик, и в каталоге на вкладке опубликованных его бы не было.
   */
  await check.getByRole("button", { name: "Опубликовать", exact: true }).click();

  /*
   * Публикация уводит на обзор новой методики (/surveys/:id, волна 25 —
   * рамка методики «Виразної»): имя заголовком, в паспорте — «Опубликовано,
   * версия 1». Полная аналитика со срезами — по-прежнему во вкладке «Тести»
   * раздела «Аналітика», туда ведут вкладки рамки.
   */
  await expect(page).toHaveURL(/\/surveys\/[0-9a-f-]{8,}$/);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByText("Опубликовано, версия 1")).toBeVisible();

  // каталог открывается на опубликованных, свежая методика — первой строкой
  await goRail(page, "Методики");
  await expect(page.getByRole("link", { name: title })).toBeVisible();
});

test("перегляд показывает пункт, который правят", async ({ page }) => {
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

  // нужна методика с пунктами: у пустого черновика перегляду нечего показывать
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
   * Перегляд — правая колонка конструктора (макет methods-constructor),
   * панель с заголовком «Предпросмотр». Номер пункта стоит в его верхней
   * строке: «1 из N».
   */
  const preview = page.getByRole("region", { name: "Предпросмотр" });
  await expect(preview.locator("[data-preview-at]")).toHaveText(/^1 из /);
  const firstShown = await preview.locator("[data-preview-question]").textContent();

  /*
   * Пункты свёрнуты, и свёрнутый пункт курсора не принимает: раскрытие само
   * сообщает перегляду номер, и перегляд обязан перейти.
   */
  await page.getByRole("button", { name: /Развернуть вопрос$/ }).nth(1).click();
  await expect(preview.locator("[data-preview-at]")).toHaveText(/^2 из /);
  await expect(preview.locator("[data-preview-question]")).not.toHaveText(firstShown ?? "");

  // ключи и баллы в перегляд не попадают: человек их не видит
  await expect(preview).not.toContainText("Код ключа");
});
