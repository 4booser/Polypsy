import { expect, test, type Locator, type Page } from "@playwright/test";
import { kyivNow, pickSlotToday, WINDOW_MINUTES } from "./slotWindow";

/** Учётки посева — те же, что печатает `db:seed` */
export const ACCOUNTS = {
  superadmin: { email: "root@quizzy.dev", password: "root12345" },
  psy: { email: "psy@quizzy.dev", password: "psy12345" },
  psy2: { email: "psy2@quizzy.dev", password: "psy212345" },
  /* пациент: у него своя оболочка, и шапки специалиста с бургером он не видит вовсе */
  patient: { email: "patient1@quizzy.dev", password: "patient12345" },
};

/*
 * Оболочка сотрудника Polypsy 2.0: полоса приложения сверху, рельса
 * разделов слева, колонка подразделов раздела рядом с ней; ниже 1100 px
 * рельсы и колонки нет — все разделы в меню «Ще розділи» за кнопкой слева на
 * полосе приложения (apps/web/src/shell/*, состав — shell/nav.ts).
 *
 * Локаторы к ней собраны здесь, по одному на элемент, а не рассыпаны по
 * сценариям. Два локатора на одну кнопку разошлись бы в тот день, когда ей
 * сменят подпись. Все локаторы ролевые: сценарий ищет то же, что диктор, —
 * имя кнопки, имя диалога, имя навигации, — а не класс.
 */

/**
 * Кнопка меню «Ще розділи» — она есть только на узком окне (ниже
 * RAIL_MIN_WIDTH), где нет рельсы.
 *
 * Имя у неё меняется вместе с состоянием («Развернуть меню» → «Свернуть
 * меню») и с языком, поэтому локатор перечисляет все четыре подписи. Одна и
 * та же кнопка нужна и чтобы открыть меню, и чтобы после Esc проверить, что
 * фокус вернулся именно на неё, — а к тому моменту подпись уже другая.
 */
export function menuButton(page: Page): Locator {
  return page.getByRole("button", { name: /^(Развернуть|Свернуть|Розгорнути|Згорнути) меню$/ });
}

/** Меню «Ще розділи» — диалог, названный по ключу top.more */
export function moreMenu(page: Page): Locator {
  return page.getByRole("dialog", { name: /^(Другие разделы|Ще розділи)$/ });
}

/**
 * Открыть меню «Ще розділи» и вернуть его. Только на узком окне: на широком
 * кнопки нет, разделы стоят на рельсе (railNav).
 *
 * Уже открытое не трогается — кнопка переключает, и повторное нажатие
 * закрыло бы меню.
 */
export async function openMenu(page: Page): Promise<Locator> {
  const button = menuButton(page);
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  const menu = moreMenu(page);
  await menu.waitFor();
  return menu;
}

/**
 * Ширина, начиная с которой стоят рельса и колонка подразделов; ниже все
 * разделы уходят в меню «Ще розділи». Число — то же, что в shell/*.tsx
 * (max-[1099px]), и названо здесь затем, чтобы сценарий на планшете знал,
 * какую дверь ждать, а не искал любую.
 */
export const RAIL_MIN_WIDTH = 1100;

/** Рельса разделов — навигация, названная по ключу shell.sections */
export function railNav(page: Page): Locator {
  return page.getByRole("navigation", { name: /^(Разделы консоли|Розділи консолі)$/ }).first();
}

/** Колонка подразделов текущего раздела (пациенты, методики, аналитика, администрирование, техпанель) */
export function subNav(page: Page): Locator {
  return page.locator("nav[data-subnav]");
}

/** Широкое ли окно у страницы: стоит ли рельса */
async function wide(page: Page): Promise<boolean> {
  return (page.viewportSize()?.width ?? 1280) >= RAIL_MIN_WIDTH;
}

/**
 * Перейти в раздел рельсы — так, как ходят каждый день.
 *
 * Имя пункта рельсы — полное («Случаи риска», «Очередь работы»), с числом
 * через запятую, если оно есть: поэтому сравнивается началом. На узком окне
 * рельсы нет — туда ведёт меню «Ще розділи»: это решение помощника, потому
 * что на узком окне другой двери нет вовсе.
 */
export async function goRail(page: Page, name: RegExp | string): Promise<void> {
  if (await wide(page)) {
    await railNav(page).getByRole("link", { name }).first().click();
    return;
  }
  const menu = await openMenu(page);
  await menu.getByRole("link", { name }).first().click();
}

/**
 * Перейти в подраздел: раздел рельсы, затем пункт его колонки. На узком
 * окне — тем же меню «Ще розділи», где подразделы стоят под своим разделом.
 */
export async function goSection(page: Page, rail: RegExp | string, link: RegExp | string): Promise<void> {
  if (await wide(page)) {
    await goRail(page, rail);
    await subNav(page).getByRole("link", { name: link }).first().click();
    return;
  }
  const menu = await openMenu(page);
  await menu.getByRole("link", { name: link }).first().click();
}

/**
 * Перейти по двери оболочки, где бы она ни стояла сейчас: на рельсе или в
 * колонке подразделов открытого раздела (на узком окне — в меню «Ще
 * розділи»). Для дверей открытого человека — «Огляд», «Динаміка» — и
 * разделов рельсы. Подраздел ДРУГОГО раздела так не найти: для него —
 * goSection, и падение здесь называет, где искали.
 *
 * `.first()` — не от лени: на узком окне подраздел текущего раздела стоит в
 * меню дважды (первой группой и под своим разделом), и ведут оба туда же.
 * Переход закрывает меню сам — за этим следит оболочка.
 */
export async function goMenu(page: Page, link: RegExp | string): Promise<void> {
  if (!(await wide(page))) {
    const menu = await openMenu(page);
    await menu.getByRole("link", { name: link }).first().click();
    return;
  }
  const onRail = railNav(page).getByRole("link", { name: link });
  if (await onRail.count()) {
    await onRail.first().click();
    return;
  }
  await subNav(page).getByRole("link", { name: link }).first().click();
}

/**
 * Меню учётной записи за именем справа на полосе приложения (MenuButton
 * набора): имя, должность, почта, затем пункты «Обліковий запис» и «Вийти».
 */
export async function openUserMenu(page: Page): Promise<Locator> {
  const button = page.getByRole("banner").locator("button[data-user-menu]");
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  const menu = page.getByRole("menu", { name: /^(Учётная запись|Обліковий запис)$/ });
  await menu.waitFor();
  return menu;
}

/** Колокольчик центра событий на полосе приложения: стоит всегда, на любой ширине */
export function eventsBell(page: Page): Locator {
  return page.getByRole("banner").getByRole("button", { name: /^(События|Події)/ });
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
 * С 2.0 реестр — снова таблица набора (кадр patients-list). Признак
 * `data-patients` стоит на обёртке таблицы в Patients.tsx ровно ради этой
 * проверки: классы менять можно, признак — нет. Первая ссылка строки — имя
 * человека, она ведёт в карточку.
 */
export function patientLinks(page: Page): Locator {
  return page.locator("[data-patients] tbody tr td a");
}

/**
 * Поле поиска над реестром пациентов: поиск набора (type=search, роль
 * searchbox), имя даёт aria-label. Ищется в main: у полосы приложения свой
 * поиск — палитра.
 */
export function patientSearch(page: Page): Locator {
  return page.getByRole("main").getByRole("searchbox", { name: /^(Поиск|Пошук)$/ });
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
 * Поля формы входа (Polypsy 2.0, «Вхід до Polypsy»): почта подписана
 * «Електронна пошта», пароль — «Пароль». На обоих языках, потому что язык
 * стенда заранее не известен. Пароль — точным именем: рядом кнопка
 * «Показати пароль», и подстрока «пароль» нашла бы её тоже.
 */
export const emailField = (page: Page) => page.getByLabel(/^(Електронна пошта|Электронная почта)$/);
export const passwordField = (page: Page) => page.getByLabel("Пароль", { exact: true });

/*
 * Форма входа живёт на «/login»: корень для гостя — лендинг, и с него до
 * формы ещё одно нажатие.
 */
export async function login(page: Page, who: keyof typeof ACCOUNTS) {
  const acc = ACCOUNTS[who];
  await page.goto("/login");
  await emailField(page).fill(acc.email);
  await passwordField(page).fill(acc.password);
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
  // кабинет пациента с волны 12 начинается с согласия (patient/ConsentGate.tsx)
  if (new URL(page.url()).pathname.startsWith("/me")) await acceptConsentIfAsked(page);
  /*
   * Признак входа — оболочка, а не конкретный раздел. У сотрудника это
   * колокольчик на полосе приложения: он стоит на любой ширине, а рельса на
   * телефоне спрятана, и ждать её значило бы виснуть на 390 px. У пациента
   * своя оболочка с вкладками кабинета, и ждём её как навигацию.
   */
  await eventsBell(page).or(page.getByRole("navigation")).first().waitFor();
}

/**
 * Открыть клиническую карту пациента — сводку, динамику и хронологию.
 *
 * С волны 6 «/patients/:id» занят карточкой, а прежняя карта переехала на
 * «/patients/:id/case» (pages/CaseCard.tsx). В Polypsy 2.0 у карточки своя
 * колонка «Мои пациенты» вместо колонки подразделов, и дверь к карте —
 * ссылка «Клиническая карта» в шапке карточки. Сама карта идёт во всю ширину,
 * без колонки подразделов (shell/nav.ts → sectionOf): её вкладки «Обзор /
 * Динамика / Хронология» — строкой под шапкой пациента (CaseCard, Tabs).
 *
 * Сценарии ходят этими дверями, а не прямым goto по адресу: адрес открылся
 * бы и после того, как дверь случайно убрали бы, — и пропажу единственного
 * входа не заметил бы никто. Ожидание по адресу, а не по заголовку.
 */
export async function goCaseCard(page: Page, entry: RegExp | string = /^(Обзор дела|Огляд справи)$/): Promise<void> {
  if (!/\/patients\/[^/]+\/case(\/|$)/.test(new URL(page.url()).pathname)) {
    await page
      .getByRole("main")
      .getByRole("link", { name: /^(Клиническая карта|Клінічна карта)$/ })
      .first()
      .click();
    await page.waitForURL(/\/patients\/[^/]+\/case/);
  }
  /*
   * Вкладка «Хронология» несёт число событий («Хронология 23»): точное имя
   * без числа её не нашло бы — сравнение по началу имени, как читает человек.
   */
  const name = typeof entry === "string" ? new RegExp(`^${entry}`) : entry;
  await page
    .getByRole("main")
    .getByRole("navigation", { name: /^(Клиническая карта|Клінічна карта)$/ })
    .getByRole("link", { name })
    .first()
    .click();
  await page.waitForURL(/\/patients\/[^/]+\/case/);
}


/**
 * Выйти из консоли.
 *
 * Выход — пункт меню учётной записи за именем на полосе приложения, и
 * кроме как через это меню до него не добраться: он не отрисован, пока
 * меню закрыто.
 */
export async function logout(page: Page) {
  const menu = await openUserMenu(page);
  await menu.getByRole("menuitem", { name: /^(Выйти|Вийти)$/ }).click();
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
 * С макета methods-constructor это сегменты «Украинский | Русский» (группа с
 * именем «Язык текста теста», ключ cn.editLang). Переключателей на экране
 * бывает несколько — в «Основном», в раскрытом пункте, у шкал, — и все они
 * правят одно состояние, поэтому берётся первый. Ожидание aria-pressed —
 * признак, что выбор дошёл до формы: следующий fill обязан попасть в поле
 * нового языка.
 */
const EDIT_LANG_NAME = { uk: "Украинский", ru: "Русский" } as const;

export async function setEditLang(page: Page, lang: "uk" | "ru"): Promise<void> {
  const button = page
    .getByRole("group", { name: "Язык текста теста" })
    .first()
    .getByRole("button", { name: EDIT_LANG_NAME[lang], exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

/**
 * Строки списка пациентов текстом: строки таблицы реестра (2.0) — по тому же
 * признаку, что и patientLinks. Через expect.poll, а не waitFor: после
 * смены пользователя старый список какое-то время ещё в DOM, и одиночное
 * ожидание успевает совпасть с ним, а читается уже пустой экран загрузки.
 */
export async function rowTexts(page: Page): Promise<string[]> {
  const rows = page.locator("[data-patients] tbody tr");
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
  const token = (await res.json()).token as string;
  // сдачи пациента без принятого согласия сервер не примет (волна 12)
  if (who === "patient") await acceptConsentIfAsked(page, token);
  return token;
}

/**
 * Принять согласие вошедшего пациента, если посев завёл текст, а человек
 * его ещё не принимал.
 *
 * С волны 12 без принятой редакции сервер не принимает ответов, а кабинет
 * сначала показывает текст (patient/ConsentGate.tsx). Сценариям, которые
 * проверяют не согласие, а то, что за ним, согласие даётся запросом — тем
 * же, что шлёт кнопка, с редакцией, которую показали. Сам экран согласия
 * проходит кнопкой patient.e2e.
 */
export async function acceptConsentIfAsked(page: Page, token?: string): Promise<void> {
  const bearer = token ?? (await page.evaluate(() => localStorage.getItem("quizzy.web.token")));
  if (!bearer) return;
  const status = (await (await page.request.get("/api/consents/me", { headers: auth(bearer) })).json()) as {
    required?: boolean;
    accepted?: boolean;
    textId?: string | null;
  };
  if (!status?.required || status.accepted) return;
  const res = await page.request.post("/api/consents/me/accept", {
    headers: auth(bearer),
    data: { textId: status.textId },
  });
  expect(res.ok(), `согласие не принято: ${res.status()}`).toBeTruthy();
  if (!token) await page.reload();
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
  // сдачи своего пациента идут запросами — без принятого согласия сервер их не примет
  await acceptConsentIfAsked(page, body.token);
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
  /*
   * Критический вариант — из методики глазами сотрудника: пациенту ключ не
   * отдаётся (#141), у его копии нет riskFlag. Варианты и их id те же.
   */
  const staff = opts.risky ? auth(await apiToken(page, "superadmin")) : headers;
  const full = (await (await page.request.get(`/api/surveys/${surveyId}`, { headers: staff })).json()) as {
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

/**
 * Окна дополнительного времени, уже заведённые этим процессом: второй вызов
 * в ту же минуту не просит занятое время (e2e/slotWindow.ts, windowKey).
 */
const triedWindows = new Set<string>();

/**
 * Свободное время психолога на СЕГОДНЯ.
 *
 * Занять можно только будущий слот (см. takeSlot в routes/clinic.ts), а день
 * приёма показывает именно сегодняшний день, — поэтому берётся ближайший
 * свободный, а если сетка на сегодня уже разобрана, заводится дополнительное
 * время тем же способом, каким его заводит специалист: исключением
 * расписания. Это существующий путь продукта, а не лазейка мимо него.
 *
 * Какое окно заводить и когда сдаться — чистая логика в e2e/slotWindow.ts,
 * проверенная на подменённых часах. Окно поверх занятого слота не
 * раскладывается (с волны 12 открытые слоты одного специалиста не
 * пересекаются, миграция 0105) — тогда берётся следующее, как поступил бы
 * специалист, которому система не дала добавить время поверх приёма.
 *
 * До конца суток в Киеве места нет — сценарий пропускается явно (test.skip
 * с причиной), а не падает: раньше в 23:58 заводилось окно «сегодня
 * 00:02–00:07», уже в прошлом, и сценарии приёма падали на подготовке каждый
 * вечер (внешний разбор, волна 15, п. 15). Сервер часами не подменяется.
 */
async function freeSlotToday(page: Page, staffToken: string, specialistId: string): Promise<string> {
  const headers = auth(staffToken);
  const dayOf = (iso: string) => kyivNow(Date.parse(iso)).date;

  const pick = await pickSlotToday(
    {
      now: () => Date.now(),
      freeToday: async (date) => {
        const res = await page.request.get(`/api/clinic/slots?specialistId=${specialistId}`, { headers });
        if (!res.ok()) throw new Error(`свободное время не отдано: ${res.status()} ${await res.text()}`);
        const body = (await res.json()) as { items: { id: string; startsAt: string }[] };
        return body.items.find((s) => dayOf(s.startsAt) === date)?.id ?? null;
      },
      addWindow: async (window) => {
        const created = await page.request.post("/api/clinic/schedule/exceptions", {
          headers,
          data: { ...window, kind: "extra", slotMinutes: WINDOW_MINUTES, note: "Смоук" },
        });
        if (!created.ok()) {
          throw new Error(`не удалось добавить время приёма: ${created.status()} ${await created.text()}`);
        }
      },
    },
    triedWindows,
  );
  if ("skip" in pick) {
    test.skip(true, pick.skip);
    // test.skip прерывает сценарий сам; строка — для читателя и для типов
    throw new Error(pick.skip);
  }
  return pick.slotId;
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
