import { expect, type Locator, type Page } from "@playwright/test";

/** Учётки посева — те же, что печатает `db:seed` */
export const ACCOUNTS = {
  superadmin: { email: "root@quizzy.dev", password: "root12345" },
  psy: { email: "psy@quizzy.dev", password: "psy12345" },
  psy2: { email: "psy2@quizzy.dev", password: "psy212345" },
  /* пациент: у него своя оболочка, и шапки специалиста с бургером он не видит вовсе */
  patient: { email: "patient1@quizzy.dev", password: "patient12345" },
};

/*
 * Оболочка сотрудника: полоса с шестью пунктами сверху и бургер справа, в
 * котором лежит всё остальное (см. apps/web/src/shell/Topbar.tsx).
 *
 * Локаторы к ней собраны здесь, по одному на элемент, а не рассыпаны по
 * сценариям. Два локатора на один бургер разошлись бы в тот день, когда ему
 * сменят подпись: половина сценариев продолжала бы его находить, половина —
 * нет, и падение выглядело бы как поломка меню, а не как устаревший тест.
 * Все локаторы ролевые: сценарий ищет то же, что диктор, — имя кнопки, имя
 * диалога, имя навигации, — а не класс, которого у полосы больше нет.
 */

/**
 * Кнопка бургера.
 *
 * Имя у неё меняется вместе с состоянием («Развернуть меню» → «Свернуть
 * меню») и с языком, поэтому локатор перечисляет все четыре подписи. Одна и
 * та же кнопка нужна и чтобы открыть меню, и чтобы после Esc проверить, что
 * фокус вернулся именно на неё, — а к тому моменту подпись уже другая.
 *
 * Она же — признак оболочки сотрудника на любой ширине: полоса с шестью
 * пунктами ниже 1100 px спрятана, а бургер стоит всегда.
 */
export function menuButton(page: Page): Locator {
  return page.getByRole("button", { name: /^(Развернуть|Свернуть|Розгорнути|Згорнути) меню$/ });
}

/** Выпадающий список бургера — диалог, названный по ключу top.more */
export function moreMenu(page: Page): Locator {
  return page.getByRole("dialog", { name: /^(Другие разделы|Ще розділи)$/ });
}

/**
 * Открыть бургер и вернуть его список.
 *
 * Единственный способ открыть бургер в сценариях: второй завёлся бы своим
 * локатором и своим ожиданием, и однажды они разошлись бы. Уже открытый не
 * трогается — кнопка переключает, и повторное нажатие закрыло бы меню:
 * сценарий, который открыл его ради одной проверки, а потом позвал goMenu,
 * остался бы перед закрытым списком.
 */
export async function openMenu(page: Page): Promise<Locator> {
  const button = menuButton(page);
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  const menu = moreMenu(page);
  await menu.waitFor();
  return menu;
}

/**
 * Перейти по пункту бургера.
 *
 * `.first()` — не от лени. Ниже 1100 px шесть верхних пунктов повторяются в
 * начале списка (полоса их там не показывает), и «Пациенты» встречаются в
 * бургере дважды. Ведут оба туда же; строгий режим падал бы на «двух
 * совпадениях», не называя причины. Переход закрывает меню сам — за этим
 * следит оболочка, и сценарии на это опираются.
 */
export async function goMenu(page: Page, link: RegExp | string): Promise<void> {
  const menu = await openMenu(page);
  await menu.getByRole("link", { name: link }).first().click();
}

/**
 * Ширина, начиная с которой шесть пунктов стоят в полосе; ниже они уходят в
 * бургер. Число — то же, что в Topbar.tsx (max-[1100px]), и названо здесь
 * затем, чтобы сценарий на планшете знал, какую дверь ждать, а не искал
 * любую.
 */
export const TOP_NAV_MIN_WIDTH = 1100;

/** Шесть пунктов полосы — навигация, названная по ключу shell.sections */
export function topNav(page: Page): Locator {
  return page.getByRole("navigation", { name: /^(Разделы консоли|Розділи консолі)$/ });
}

/**
 * Перейти по пункту полосы — так, как ходят каждый день.
 *
 * Те же разделы есть и в бургере, но сценарий идёт той дверью, которой идёт
 * человек: у полосы своя подпись («Тесты», а не «Методики»), и проверить её
 * можно, только пройдя через неё. Ниже 1100 px полосы нет — там сценарию
 * нужен goMenu, и это его решение, а не помощника: молчаливый запасной ход
 * через бургер скрыл бы пропавший пункт полосы.
 */
export async function goTop(page: Page, link: RegExp | string): Promise<void> {
  await topNav(page).getByRole("link", { name: link }).click();
}

/**
 * Переключатель языка в шапке.
 *
 * Ищется внутри шапки (banner) поимённо: на «Учётной записи» стоит второй
 * переключатель, и общий поиск по странице находил бы оба. Имя — «Мова /
 * Язык», одно на оба языка: подпись называет сам язык и потому не
 * переводится. Видимое слово — не имя, а состояние: оно называет ТЕКУЩИЙ
 * язык («Рус»/«Укр») и раскрывает меню языков.
 */
/**
 * Ссылки на людей в списке пациентов.
 *
 * Список больше не таблица: по макету (кадр f05) это сетка карточек в три
 * колонки, и «table tbody tr td a» на нём ничего не находит. Признак
 * `data-patients` стоит на самой сетке (pages/patientGroups/PersonGrid.tsx)
 * ровно ради этой проверки: классы там менять можно, признак — нет.
 */
export function patientLinks(page: Page): Locator {
  return page.locator("[data-patients] a");
}

/** Поле поиска над списком пациентов: на макете без подписи внутри, имя даёт aria-label */
export function patientSearch(page: Page): Locator {
  return page.getByRole("textbox", { name: /^(Поиск|Пошук)$/ });
}

/*
 * Ищется по хвосту имени, а не по имени целиком: имя кнопки языка
 * начинается с видимого слова («Укр — Мова / Язык»), чтобы управляющий
 * голосом попадал по тому, что читает глазами (WCAG 2.5.3). Точное
 * совпадение перестало бы находить кнопку, а искать по «Укр» нельзя — оно
 * меняется вместе с языком, ради которого сценарий и написан. Кнопка
 * раскрывает меню языков (см. setLang ниже).
 */
export function langToggle(page: Page): Locator {
  return page.getByRole("banner").getByRole("button", { name: /Мова \/ Язык/ });
}

/**
 * Полные имена языков в меню языка — каждое на своём языке (LANG_NAMES.full
 * в packages/shared/src/types.ts). Набраны здесь, а не импортом: сценарий
 * ищет то, что видит человек, и расхождение с общей записью должно падать
 * здесь, а не молча переезжать в ожидание.
 */
export const LANG_FULL = { uk: "Українська", ru: "Русский" } as const;

/**
 * Поставить язык оболочки — выбрать из меню.
 *
 * С 2026-09-26 слово в шапке не переключает язык «на второй», а раскрывает
 * меню из всех языков (shell/LangMenu.tsx): языков стало больше двух. Пункт
 * ищется ролью menuitemradio по полному имени. Уже стоящий язык не
 * выбирается повторно — меню при этом и не открывается. Ожидание по lang
 * документа — признак, что выбор доехал: словарь меняется раньше, чем
 * страница, а lang оболочка ставит и при старте, и при каждой смене, и от
 * него зависят диктор и переносы.
 */
export async function setLang(page: Page, lang: "uk" | "ru"): Promise<void> {
  if ((await page.locator("html").getAttribute("lang")) !== lang) {
    await langToggle(page).click();
    await page.getByRole("menuitemradio", { name: LANG_FULL[lang] }).click();
  }
  await expect(page.locator("html")).toHaveAttribute("lang", lang);
}

/*
 * Форма входа живёт на «/login»: корень для гостя — лендинг «Про кампанію»
 * (кадр f00), и с него до формы ещё одно нажатие. Поле почты подписано
 * «Логін», как на кадре f01, — на обоих языках, потому что язык стенда
 * заранее не известен.
 */
export async function login(page: Page, who: keyof typeof ACCOUNTS) {
  const acc = ACCOUNTS[who];
  await page.goto("/login");
  await page.getByLabel(/^(Логин|Логін)$/).fill(acc.email);
  await page.getByLabel("Пароль").fill(acc.password);
  await page.getByRole("button", { name: /^(Войти|Увійти)$/ }).click();
  /*
   * Сначала уход с «/login», и только потом оболочка.
   *
   * Ждать одну лишь «навигацию» с волны 6 нельзя: у публичного листа в
   * подвале своя навигация («Разделы сайта», PublicFrame.tsx), и локатор
   * совпадал с ней ещё до того, как запрос входа успевал вернуться.
   * Помощник отпускал сценарий, стоя на форме входа, тот шёл `goto` по
   * адресу, который гостю не отдают, — и падал на пустом экране входа,
   * рассказывая про пропавшие строки кабинета. Хуже того, проверки, которым
   * хватало любого `h1`, зеленели на форме входа, ничего не проверив.
   *
   * Адрес — признак надёжный: пока токена нет, App держит гостевые
   * маршруты, и «/login» остаётся; после входа сотрудник уезжает на «/», а
   * пациент — на «/me».
   */
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  /*
   * Признак входа — оболочка, а не конкретный раздел. У сотрудника это
   * бургер: полоса с шестью пунктами на телефоне спрятана, и ждать её значило
   * бы виснуть на 390 px. У пациента бургера нет — у него своя оболочка с
   * нижней полосой вкладок, и ждём её как навигацию.
   */
  await menuButton(page).or(page.getByRole("navigation")).first().waitFor();
}

/**
 * Открыть клиническую карту пациента — сводку, динамику и хронологию.
 *
 * С волны 6 «/patients/:id» занят карточкой по кадру f13 (личные данные,
 * «Тесты», «Группы», «Заключения»), а прежняя карта со сводкой, планом
 * безопасности, записями приёма и направлениями переехала на
 * «/patients/:id/case» (pages/CaseCard.tsx).
 *
 * Дверь туда одна, и со сверки разделов «Пациенты» и «Группы» она в
 * БУРГЕРЕ верхней полосы, разделом «Клиническая карта»: на кадре f13 в
 * строке заголовка карточки стоит одна кнопка «Відписатись», и шестерёнке
 * там места нет. Раздел появляется, пока открыт человек (Topbar.tsx,
 * clinicalLinks).
 *
 * Сценарии ходят этой дверью, а не прямым goto по адресу: адрес открылся бы
 * и после того, как раздел случайно убрали бы из бургера, — и пропажу
 * единственного входа не заметил бы никто. Ожидание по адресу, а не по
 * заголовку: у карточки и у карты заголовки разные, но оба появляются не
 * сразу, а «/case» в адресе стоит ровно тогда, когда переход состоялся.
 */
export async function goCaseCard(page: Page, entry: RegExp | string = /^(Обзор|Огляд)$/): Promise<void> {
  await goMenu(page, entry);
  await page.waitForURL(/\/patients\/[^/]+\/case/);
}

/**
 * Выйти из консоли.
 *
 * Кнопка выхода живёт в подвале бургера, и кроме как через openMenu до неё
 * не добраться: она не отрисована, пока меню закрыто.
 */
export async function logout(page: Page) {
  const menu = await openMenu(page);
  await menu.getByRole("button", { name: /^(Выйти|Вийти)$/ }).click();
}

/**
 * Поле конструктора по подписи.
 *
 * Обычный getByLabel не годится. Подписи над полем по макету нет нигде:
 * она печатается визуально скрытым span внутри <label>, а глазу показана
 * плейсхолдером с тем же текстом, который Field ставит на само поле (см.
 * primitives.tsx). Имя у поля одно, а найти его по тексту можно двумя
 * путями — и они разойдутся в тот день, когда плейсхолдер решат укоротить.
 * Поэтому поле ищется по строению Field: `[data-field]` — точка опоры,
 * которую примитив обещает смоуку явно, — и подпись первым span внутри
 * label. `:text-is`, а не `:has-text`: подпись сравнивается целиком, иначе
 * короткая подпись находила бы и всякую длинную, в которую она входит.
 *
 * Поле у двуязычного текста теперь одно, а не два рядом (украинское и
 * русское): язык правки выбирается один раз на весь экран, см. setEditLang.
 * Внутри — что положили: ввод, многострочное поле или селект.
 */
export function fieldByLabel(page: Page, label: string): Locator {
  return page
    .locator(`[data-field]:has(> label > span:text-is("${label}"))`)
    .first()
    .locator("input, textarea, select");
}

/**
 * Поставить язык, на котором правится текст теста.
 *
 * Это не язык консоли (см. setLang): специалист с русской консолью вписывает
 * украинский текст методики. Хранение осталось двуязычным ({uk, ru}), и
 * переключатель решает лишь, какой из двух ключей показывает каждое поле.
 *
 * С правки по кадрам f23_1/f24_1 это не селект в рамке, а меню: кнопка без
 * рамки с короткой надписью «Укр»/«Рус» (имя для диктора — «Язык текста
 * теста», ключ cn.editLang), а в раскрытом списке языки названы полностью.
 * Поэтому здесь два шага вместо selectOption. Ожидание по надписи кнопки —
 * признак, что выбор дошёл до формы, а не только до пункта меню: следующий
 * fill обязан попасть в поле нового языка.
 */
const EDIT_LANG_FULL = { uk: "Українська", ru: "Русский" } as const;
const EDIT_LANG_SHORT = { uk: "Укр", ru: "Рус" } as const;

export async function setEditLang(page: Page, lang: "uk" | "ru"): Promise<void> {
  const trigger = page.getByRole("button", { name: "Язык текста теста" });
  await trigger.click();
  await page.getByRole("menuitem", { name: EDIT_LANG_FULL[lang], exact: true }).click();
  await expect(trigger).toHaveText(EDIT_LANG_SHORT[lang]);
}

/**
 * Строки списка пациентов текстом. Список с волны 4 — сетка карточек
 * (<ul data-patients>, кадр f05), а не таблица: читаются её пункты, по тому
 * же признаку, что и patientLinks. Через expect.poll, а не waitFor: после
 * смены пользователя старый список какое-то время ещё в DOM, и одиночное
 * ожидание успевает совпасть с ним, а читается уже пустой экран загрузки.
 */
export async function rowTexts(page: Page): Promise<string[]> {
  const rows = page.locator("[data-patients] > li");
  /*
   * Возвращается ровно тот список, который удовлетворил проверке, а не
   * прочитанный заново.
   *
   * Между «строки появились» и «прочитать строки» список успевает
   * перерисоваться — и вторым чтением приходил пустой массив. Тест падал не
   * на утверждении о правах, а на пустом списке, то есть выглядел как
   * нарушение разграничения там, где просто не повезло со временем. Дырку в
   * правах такой тест, наоборот, пропустил бы: пустой список сравнивать не с
   * чем.
   */
  let texts: string[] = [];
  await expect
    .poll(async () => {
      texts = await rows.allTextContents();
      return texts.length;
    })
    .toBeGreaterThan(0);
  return texts;
}

/*
 * ─────────────── свои данные вместо чужих ───────────────
 *
 * Сценарии смоука идут по одному стенду и одной базе, а порядок файлов задаёт
 * не автор, а сортировка имён в Playwright. Пока проверка берёт «первую
 * строку списка» или «единственный приём, который ждёт явки», она проверяет
 * не экран, а то, что сосед до неё туда не дотянулся: у себя зелено, в CI
 * красно, и падает не тот тест, который сломан.
 *
 * Поэтому здесь помощники, которыми сценарий заводит себе собственные данные
 * — своего пациента, свой случай, свой приём — и дальше проверяет ИХ. Тот же
 * приём уже принят в юнит-тестах (см. «свой случай, а не одолженный у
 * соседей» в apps/api/test/content.test.ts).
 *
 * Заведение идёт через API, а не через интерфейс: регистрация, сдача методики
 * и запись на приём — по три-четыре экрана каждая, и проходить их ради
 * предпосылки значило бы удлинить прогон вчетверо, а заодно уронить проверку
 * там, где сломан чужой экран.
 */

/**
 * Токен API учётки посева — свежий на каждый вызов, и это не расточительство.
 *
 * Кэш на модуль напрашивается: argon2 считает пароль сотни миллисекунд по
 * замыслу. Но «Выйти» сдвигает границу действительности всех выданных
 * access-токенов учётки (см. revokeByToken в apps/api/src/lib/refresh.ts), а
 * из консоли выходят сразу два сценария — разграничение доступа в
 * clinic.e2e.ts и права в auth.e2e.ts. Сохранённый токен психолога умирал в
 * тот момент, когда любой из них доходил до выхода, и следующий файл получал
 * 401 на ровном месте — то есть ровно ту зависимость от порядка, ради
 * которой всё это писалось. Вход стоит сотню миллисекунд, а такое падение —
 * полчаса чтения журнала.
 */
export async function apiToken(page: Page, who: keyof typeof ACCOUNTS): Promise<string> {
  const res = await page.request.post("/api/auth/login", { data: ACCOUNTS[who] });
  expect(res.ok(), `не удалось войти по API как ${who}`).toBe(true);
  return (await res.json()).token as string;
}

/** Заголовок с токеном — чтобы не переписывать его в каждом запросе */
export function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Методика, которой заводится случай риска и которой человек попадает в зону
 * психолога Ивановой.
 *
 * Названа поимённо, а не «первая опубликованная»: у первой в каталоге
 * порядок задан временем создания, и туда встаёт методика, которую только
 * что завёл соседний сценарий конструктора. СР-45 лежит в группе «Приёмное
 * отделение» (её ведёт psy), общедоступна, заполняется самим человеком и
 * несёт критические пункты — то есть годится и на предпосылку случая, и на
 * то, чтобы новый человек стал виден психологу.
 */
export const SEED_SURVEY = "СР-45";

/** Пациент из посева, которого никто не заводит и не удаляет по ходу прогона */
export const SEEDED_PATIENT = "Петров";

export interface OwnPatient {
  id: string;
  token: string;
  /** Фамилия — по ней сценарий находит СВОЮ строку в общих списках */
  lastName: string;
}

/** Счётчик на прогон: от него и от часов зависят фамилия, почта и телефон */
let ownPatientSeq = 0;

/**
 * Свой пациент — заведён регистрацией, как приходит настоящий человек.
 *
 * Фамилия уникальна на вызов: списки пациентов и дня общие, и искать в них
 * «Иванова» значило бы снова брать первого попавшегося. Запись прямо в базу
 * была бы короче и неверна — мимо неё остались бы и согласие, и роль, и
 * прикрепления, которые расставляет маршрут регистрации.
 */
export async function createOwnPatient(page: Page, tag: string): Promise<OwnPatient> {
  ownPatientSeq += 1;
  const mark = `${Date.now().toString().slice(-6)}${ownPatientSeq}`;
  const lastName = `Смоуков${mark}`;
  const res = await page.request.post("/api/auth/register", {
    data: {
      email: `${tag}-${mark}@test.local`,
      password: "smoke-own-12345",
      // телефон обязателен и уникален: по нему человека ищут в приёмном покое
      phone: `+380${mark.padStart(9, "0")}`,
      anonymous: false,
      firstName: "Свой",
      lastName,
    },
  });
  if (!res.ok()) {
    throw new Error(`не удалось завести своего пациента (${tag}): ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string; user: { id: string } };
  return { id: body.user.id, token: body.token, lastName };
}

/** Опубликованная методика посева по названию — идентификаторы в базе случайные */
async function seedSurveyId(page: Page, token: string): Promise<string> {
  const list = (await (
    await page.request.get("/api/surveys?status=published", { headers: auth(token) })
  ).json()) as { items: { id: string; title: string }[] };
  const hit = list.items.find((s) => s.title.includes(SEED_SURVEY));
  expect(hit, `на стенде нет методики «${SEED_SURVEY}» — предпосылку заводить нечем`).toBeTruthy();
  return hit!.id;
}

/**
 * Свой пациент сдаёт методику — сам, как в бою.
 *
 * `risky` выбирает критический вариант там, где он есть: случай риска
 * открывает код разбора при сдаче, и вставлять его в таблицу напрямую
 * значило бы проверять экран, которого в жизни не бывает.
 *
 * Сдача нужна и без случая: пока у человека нет ни одного замера по методике
 * группы, психолог не видит его ни в списке пациентов, ни в своей зоне.
 */
export async function submitSeedSurvey(
  page: Page,
  patient: OwnPatient,
  opts: { risky: boolean },
): Promise<void> {
  const headers = auth(patient.token);
  const surveyId = await seedSurveyId(page, patient.token);
  const full = (await (await page.request.get(`/api/surveys/${surveyId}`, { headers })).json()) as {
    questions: { id: string; type: string; options: { id: string; riskFlag?: boolean }[] }[];
  };
  const answers = full.questions
    .filter((q) => q.type !== "info" && q.options.length)
    .map((q) => {
      const risky = opts.risky ? q.options.find((o) => o.riskFlag) : undefined;
      return {
        questionId: q.id,
        optionIds: [(risky ?? q.options[0]!).id],
        durationMs: 2000,
        changeCount: 0,
        visitCount: 1,
      };
    });
  const res = await page.request.post(`/api/surveys/${surveyId}/responses`, {
    headers,
    data: {
      answers,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      status: "completed",
      events: [],
    },
  });
  if (!res.ok()) {
    throw new Error(`свой пациент не смог сдать «${SEED_SURVEY}»: ${res.status()} ${await res.text()}`);
  }
}

/**
 * Свой пациент, уже видимый психологу: заведён и сдал методику его группы.
 *
 * Отдельным помощником, потому что порознь эти два шага бессмысленны:
 * незарегистрированному нечего сдавать, а не сдавший ничего не виден в
 * списке пациентов — он там появляется по замерам (см. /api/dynamics/
 * respondents), а не по факту существования.
 */
export async function createVisiblePatient(
  page: Page,
  tag: string,
  opts: { risky: boolean } = { risky: false },
): Promise<OwnPatient> {
  const patient = await createOwnPatient(page, tag);
  await submitSeedSurvey(page, patient, opts);
  return patient;
}

/** Сегодняшняя дата в часах отделения, а не машины: день приёма строится по ним */
function todayInKyiv(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
}

/** Стенное время в Киеве через N минут, HH:MM */
function kyivClock(plusMinutes: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(Date.now() + plusMinutes * 60_000));
}

/** Счётчик дополнительных окон: каждому вызову своё время, см. ниже */
let extraWindowSeq = 0;

/**
 * Свободное время психолога на СЕГОДНЯ.
 *
 * Занять можно только будущий слот (см. takeSlot в routes/clinic.ts), а день
 * приёма показывает именно сегодняшний день, — поэтому берётся ближайший
 * свободный, а если сетка на сегодня уже разобрана, заводится дополнительное
 * время тем же способом, каким его заводит специалист: исключением
 * расписания. Это существующий путь продукта, а не лазейка мимо него.
 */
async function freeSlotToday(page: Page, staffToken: string, specialistId: string): Promise<string> {
  const headers = auth(staffToken);
  const today = todayInKyiv();
  const dayOf = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(iso));
  const open = async () => {
    const res = await page.request.get(`/api/clinic/slots?specialistId=${specialistId}`, { headers });
    if (!res.ok()) throw new Error(`свободное время не отдано: ${res.status()} ${await res.text()}`);
    const body = (await res.json()) as { items: { id: string; startsAt: string }[] };
    return body.items.filter((s) => dayOf(s.startsAt) === today);
  };

  const first = await open();
  if (first.length) return first[0]!.id;

  /*
   * Окно ровно в один слот, и каждому вызову своё.
   *
   * Слоты уникальны парой «специалист + начало» (см. syncSlots), и два вызова
   * в одну минуту просили бы один и тот же слот: второй получил бы `on
   * conflict do nothing`, то есть уже занятое время, — и проверка падала бы
   * на «свободного слота не появилось». Поэтому окна расходятся по пять
   * минут вперёд, а не берутся «через минуту от сейчас».
   */
  extraWindowSeq += 1;
  const start = 4 + (extraWindowSeq - 1) * 5;
  const from = kyivClock(start);
  const to = kyivClock(start + 5);
  if (to <= from) {
    throw new Error("до конца суток в Киеве не осталось места под своё время приёма");
  }
  const created = await page.request.post("/api/clinic/schedule/exceptions", {
    headers,
    data: { date: today, kind: "extra", startsAt: from, endsAt: to, slotMinutes: 5, note: "Смоук" },
  });
  if (!created.ok()) {
    throw new Error(`не удалось добавить время приёма: ${created.status()} ${await created.text()}`);
  }
  const again = await open();
  expect(again.length, "дополнительное время заведено, а свободного слота не появилось").toBeGreaterThan(0);
  return again[0]!.id;
}

export interface OwnAppointment {
  id: string;
  patient: OwnPatient;
}

/**
 * Свой приём на сегодня — со своим пациентом и на своём слоте.
 *
 * Посев кладёт на день четыре приёма в четырёх состояниях, и это ровно
 * столько, сколько нужно, чтобы посмотреть на экран, — но не столько, чтобы
 * пять сценариев по очереди отметили явку. Первый же «Пришёл» забирает
 * состояние у следующего, и кто из них упадёт, решает порядок файлов.
 *
 * `status` двигает приём туда, где он нужен проверке: «не подтвердил» — это
 * booked, «не пришёл» — no_show. Обратных переходов нет (см. NEXT в
 * routes/clinic.ts), поэтому состояние задаётся сразу, а не откатывается.
 */
export async function createOwnAppointment(
  page: Page,
  tag: string,
  status: "booked" | "no_show" = "booked",
): Promise<OwnAppointment> {
  const staffToken = await apiToken(page, "psy");
  const headers = auth(staffToken);
  const me = (await (await page.request.get("/api/auth/me", { headers })).json()) as { id: string };

  const patient = await createVisiblePatient(page, tag);
  const slotId = await freeSlotToday(page, staffToken, me.id);

  const booked = await page.request.post("/api/clinic/appointments", {
    headers,
    data: { slotId, patientId: patient.id },
  });
  if (!booked.ok()) {
    throw new Error(`не удалось записать своего пациента: ${booked.status()} ${await booked.text()}`);
  }
  const id = ((await booked.json()) as { id: string }).id;

  if (status !== "booked") {
    const moved = await page.request.post(`/api/clinic/appointments/${id}/status`, {
      headers,
      data: { status },
    });
    if (!moved.ok()) {
      throw new Error(`не удалось поставить приёму «${status}»: ${moved.status()} ${await moved.text()}`);
    }
  }
  return { id, patient };
}

/**
 * Своя строка на экране дня.
 *
 * По идентификатору приёма, а не по имени: тёзки в списке пациентов —
 * обычное дело, и строка «первая с такой фамилией» вернула бы ту же лотерею,
 * от которой уходим. Признак `data-appointment` стоит на строке дня
 * (pages/Today.tsx) ровно ради этой проверки.
 */
export function dayRow(page: Page, appointmentId: string): Locator {
  return page.locator(`[data-appointment="${appointmentId}"]`);
}

/**
 * Открыть в списке пациента ИЗ ПОСЕВА, а не первого попавшегося.
 *
 * Список упорядочен по свежести последнего замера (см. /api/dynamics/
 * respondents), и наверх поднимается тот, кого только что завёл соседний
 * сценарий: человек без единого события в хронологии и без карты, доступной
 * этому специалисту. Проверка карты превращалась в лотерею — в одиночку
 * зелёная, в общем прогоне красная через раз, и падала не там, где сломано.
 *
 * Петров из посева существует всегда, у него серия из пяти повторных
 * замеров, и завести или удалить его по ходу дела некому.
 */
export async function openSeededPatient(page: Page): Promise<Locator> {
  await page.goto("/patients");
  await patientSearch(page).fill(SEEDED_PATIENT);
  const row = patientLinks(page).first();
  await expect(row).toContainText(SEEDED_PATIENT);
  return row;
}
