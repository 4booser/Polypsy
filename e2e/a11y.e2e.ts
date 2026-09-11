import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, login } from "./helpers";

/**
 * Доступность проверяется автоматически там, где это возможно: контраст,
 * подписи полей, роли, порядок заголовков. Автопроверка ловит примерно
 * половину реальных проблем — остальное только руками, но эта половина
 * возвращается при каждой правке вёрстки, и ловить её должен CI.
 */

/*
 * Два прогона, а не один, — потому что иначе часть правил не выполняется.
 *
 * Стоял один фильтр по меткам: wcag2a, wcag2aa, wcag21a, wcag21aa. Выглядит
 * исчерпывающе, а на деле выключает целый класс проверок, который axe умеет:
 *
 *   heading-order        — метки cat.semantics, best-practice
 *   page-has-heading-one — метки cat.semantics, best-practice
 *   target-size          — метки wcag22aa, wcag258
 *
 * То есть «порядок заголовков» и «размер целей нажатия» не выполнялись ВОВСЕ.
 * Заголовки — то, чем незрячий человек ориентируется на странице: диктор
 * читает их список вместо того, чтобы обводить экран глазами, и пропущенный
 * уровень означает «раздел, которого нет». Размер цели — то, обо что
 * спотыкается человек с тремором, а в психологическом отделении таких
 * непропорционально много.
 *
 * Метку best-practice целиком сюда брать нельзя: вместе с двумя нужными она
 * включает три десятка правил о разметке страницы (region, landmark-*,
 * scope-attr-valid…), и проверка превратилась бы в список замечаний о
 * вёрстке вместо разговора о доступности. Поэтому две названы поимённо, а
 * runOnly в axe принимает либо метки, либо правила — отсюда два прогона и
 * склейка нарушений.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const BY_NAME = ["heading-order", "page-has-heading-one"];

async function scan(page: Page) {
  const byTag = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const byName = await new AxeBuilder({ page }).withRules(BY_NAME).analyze();
  return [...byTag.violations, ...byName.violations];
}

/** Нарушения в читаемом виде: id правила и селекторы, а не «ожидалось []» */
function digest(violations: Awaited<ReturnType<typeof scan>>) {
  return violations.flatMap((v) => v.nodes.map((n) => `${v.id} → ${n.target.join(" ")}`));
}

/*
 * Долг: нарушения, которые вскрылись вместе с вернувшимися правилами.
 *
 * Ключ — «правило @ экран», значение — что сломано и кто чинит. Список заведён
 * не чтобы закрыть глаза: без него проверка падала бы на старом экране, и
 * вернувшиеся правила выключили бы обратно в тот же день — а вместе с ними
 * прошло бы и новое нарушение. С ним старое названо поимённо и видно в
 * исходнике, а любое НОВОЕ падает.
 *
 * Чинить их здесь нельзя: экраны правят параллельно, и правка вёрстки из
 * смоука приехала бы конфликтом. Строка убирается вместе с починкой экрана.
 */
const KNOWN = new Map<string, string>([
  [
    "page-has-heading-one @ /permissions",
    "на экране прав нет ни одного заголовка: ни h1, ни разделов. Диктор открывает страницу и не может сказать, куда попал, а перейти к содержимому нечем — списка заголовков нет. Чинит владелец экрана прав: h1 с названием экрана (ключ perm.title в словаре уже есть) и h2 на «Роли» / «Личные исключения»",
  ],
]);

/**
 * Нарушения экрана за вычетом известного долга.
 *
 * Экран называется явной строкой, а не берётся из page.url(): у части экранов
 * в адресе идентификатор, и ключ долга скакал бы от прогона к прогону.
 */
async function violationsOf(page: Page, screen: string) {
  return digest(await scan(page))
    .filter((item) => !KNOWN.has(`${item.split(" → ")[0]!} @ ${screen}`))
    .map((item) => `${screen}: ${item}`);
}

/*
 * ─────────── данные, без которых проверять нечего ───────────
 *
 * Проверка доступности смотрит на НАРИСОВАННОЕ и молчит о том, чего на экране
 * нет. Полоса открытых случаев на сводке рисуется только при openCases > 0 —
 * и на стенде без случаев двадцать два прогона подряд объявляли доступным
 * экран, половины которого они не видели. Ровно так и был пропущен провал по
 * контрасту на этой полосе: его нашли глазами, а не проверкой.
 *
 * Отсюда правило для всего файла: где показанное зависит от данных, данные
 * заводятся явно, а перед сканированием проверяется, что нужное на экране
 * действительно есть. Посев — не гарантия: он меняется вместе с продуктом, и
 * «у нас же есть демо-случаи» — это надежда, а не утверждение.
 */

/*
 * Токены переиспользуются между тестами файла.
 *
 * Пароли хешируются argon2 — это сотни миллисекунд на вход по замыслу, и
 * лишний вход на каждую проверку складывался в заметное время на прогоне из
 * тридцати двух. Смоук идёт в один поток, так что кэш на модуль безопасен.
 */
const tokens = new Map<string, string>();

async function apiToken(page: Page, who: keyof typeof ACCOUNTS): Promise<string> {
  const cached = tokens.get(who);
  if (cached) return cached;
  const res = await page.request.post("/api/auth/login", { data: ACCOUNTS[who] });
  expect(res.ok(), `не удалось войти по API как ${who}`).toBe(true);
  const token = (await res.json()).token as string;
  tokens.set(who, token);
  return token;
}

/**
 * На стенде есть хотя бы один открытый случай риска.
 *
 * Если нет — заводится тем же путём, каким он появляется в бою: пациент сдаёт
 * методику, отметив критический вариант ответа. Вставлять строку в таблицу
 * напрямую было бы проще и неправильно: случай открывает код разбора, и
 * запись мимо него проверяла бы вёрстку экрана, которого в реальности не
 * бывает.
 */
type Option = { id: string; riskFlag?: boolean };
type Question = { id: string; type: string; required: boolean; options?: Option[] };

/**
 * Человек, заведённый ради посева случая.
 *
 * Свой на каждый прогон: общий посевной пациент участвует в чужих проверках,
 * и любая запись за него сдвигает их. Заводится настоящей регистрацией, а не
 * записью в базу: случай открывает код разбора, и обойти его значило бы
 * проверять экран, которого в жизни не бывает.
 */
let seededPatient: string | null = null;

async function seedPatientToken(page: Page): Promise<string> {
  if (seededPatient) return seededPatient;
  const email = `a11y-seed-${Date.now()}@test.local`;
  const res = await page.request.post("/api/auth/register", {
    data: { email, password: "a11y-seed-12345", firstName: "Посев", lastName: "Доступности" },
  });
  if (!res.ok()) throw new Error(`посев: не удалось завести пациента — ${res.status()} ${await res.text()}`);
  seededPatient = (await res.json()).token as string;
  return seededPatient;
}

async function ensureOpenCase(page: Page): Promise<void> {
  const staff = { Authorization: `Bearer ${await apiToken(page, "superadmin")}` };
  const countOpen = async () => {
    const r = await (await page.request.get("/api/alert-cases?status=open", { headers: staff })).json();
    return Number(r.total ?? r.items?.length ?? 0);
  };
  if ((await countOpen()) > 0) return;

  const surveys = await (await page.request.get("/api/surveys", { headers: staff })).json();
  const refusals: string[] = [];
  for (const s of surveys.items as { id: string; status: string; title: string }[]) {
    if (s.status !== "published") continue;
    const full = await (await page.request.get(`/api/surveys/${s.id}`, { headers: staff })).json();
    const questions: Question[] = full.questions ?? [];

    /*
     * Методика должна быть такой, которую пациент сдаёт целиком сам.
     *
     * Первая редакция посева отправляла ОДИН ответ — тот, что открывает
     * случай, — и сервер отвечал «Не дано відповідь на обов’язкове питання»,
     * а на шкале SAD PERSONS ещё и «методику заповнює фахівець». Посев молча
     * не срабатывал, и проверка шла дальше по пустому экрану — то есть
     * ровно то, ради чего он и заводился.
     */
    if (full.administration !== "self") continue;
    const risky = questions.find((q) => q.options?.some((o) => o.riskFlag));
    if (!risky) continue;
    if (questions.some((q) => q.required && !q.options?.length)) continue;

    const answers = questions
      .filter((q) => q.options?.length)
      .map((q) => {
        const pick = q === risky ? q.options!.find((o) => o.riskFlag)! : q.options![0]!;
        return { questionId: q.id, optionIds: [pick.id] };
      });

    /*
     * Сдаёт ОТДЕЛЬНЫЙ человек, заведённый для посева, а не общий посевной
     * пациент.
     *
     * Первая редакция сдавала за patient1 — и тот всплывал наверх во всех
     * списках, упорядоченных по свежести замера. Дальше по прогону это
     * ломало проверки, которые берут «первого в списке»: в двух прогонах
     * подряд падали разные тесты, оба проходили в одиночку, и выглядело это
     * регрессией, которой не было.
     *
     * Проверка доступности не имеет права менять то, что видят остальные.
     */
    const patient = { Authorization: `Bearer ${await seedPatientToken(page)}` };
    const res = await page.request.post(`/api/surveys/${s.id}/responses`, {
      headers: patient,
      data: {
        answers,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        status: "completed",
        events: [],
      },
    });
    if (res.ok()) {
      // случай открывает код разбора, а не этот запрос: убеждаемся, что открылся
      expect(await countOpen(), `«${s.title}» сдана, но случай не открылся`).toBeGreaterThan(0);
      return;
    }
    refusals.push(`«${s.title}» → ${res.status()} ${(await res.text()).slice(0, 120)}`);
  }
  throw new Error(
    `на стенде нет открытых случаев и не удалось завести ни одного: ${refusals.join("; ") || "нет подходящей методики с критическим пунктом"}`,
  );
}

test("экран входа доступен", async ({ page }) => {
  await page.goto("/");
  expect(await violationsOf(page, "/login")).toEqual([]);
});

// обе темы: тёмная по умолчанию, светлая — та, в которой работают при дневном
// свете, и контраст в ней проваливается независимо
for (const theme of ["dark", "light"] as const) {
  for (const [name, path] of [
    ["пациенты", "/patients"],
    // витрина: все компоненты во всех состояниях сразу — самая плотная
    // проверка доступности, какая у нас есть
    ["библиотека", "/ui"],
    ["направления", "/referrals"],
    /*
     * Экраны, появившиеся с расписанием и приёмом. Их шесть, и ни один не
     * проверялся: доступность ловится автоматически ровно наполовину, но эта
     * половина возвращается при каждой правке вёрстки — а вёрстки за
     * последние волны написано больше, чем за всё до них.
     */
    ["сегодня", "/today"],
    ["расписание приёма", "/my-schedule"],
    ["переписка", "/messages"],
    ["права", "/permissions"],
  ] as const) {
    test(`экран «${name}» доступен, тема ${theme}`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("quizzy.theme", t), theme);
      await login(page, "psy");
      await page.goto(path);
      await page.locator("h1, .card, [data-panel]").first().waitFor();
      expect(await violationsOf(page, path)).toEqual([]);
    });
  }

  test(`экран «сводка» доступен, тема ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("quizzy.theme", t), theme);
    await login(page, "psy");
    await ensureOpenCase(page);

    await page.goto("/");
    await page.locator("h1").first().waitFor();
    /*
     * Полоса случаев должна быть на экране до сканирования, а не «обычно
     * бывает». Это самый заметный блок сводки и единственный цветной — и
     * именно он не рисуется на пустом стенде.
     */
    await expect(
      page.locator('a[href="/alerts"]').first(),
      "на сводке нет полосы открытых случаев — сканировать нечего",
    ).toBeVisible();
    expect(await violationsOf(page, "/")).toEqual([]);
  });

  test(`экран «случаи риска» доступен, тема ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("quizzy.theme", t), theme);
    await login(page, "psy");
    await ensureOpenCase(page);

    await page.goto("/alerts");
    /*
     * Случай ВЫБИРАЕТСЯ, а не только открывается список.
     *
     * Экран из трёх панелей, и правая — разбор — существует лишь после
     * выбора строки: заголовки методик, баллы, кнопки решения живут там.
     * Сканируя /alerts сразу после загрузки, проверка видела очередь и
     * пустое место справа — то есть примерно половину экрана, и как раз ту,
     * которая меняется чаще.
     */
    await page.locator(".queue-row").first().waitFor();
    await page.locator(".queue-row").first().click();
    await expect(page.locator(".triage-case")).toBeVisible();
    await page.waitForTimeout(400);
    expect(await violationsOf(page, "/alerts")).toEqual([]);
  });
}

/*
 * Кабинет пациента — единственное, чем пользуются с телефона и в тяжёлом
 * состоянии.
 *
 * В списке было девять экранов из сорока четырёх маршрутов и ни одного из
 * кабинета. Между тем консоль открывает специалист на рабочем мониторе, а
 * кабинет — человек, которого сюда привела тревога или бессонница, с
 * телефона, часто ночью и не всегда с первой попытки. Если где-то и нужно
 * ловить мелкую цель нажатия и сбитый порядок заголовков, то здесь.
 */
for (const theme of ["dark", "light"] as const) {
  for (const [name, path] of [
    ["кабинет", "/me"],
    ["профиль", "/me/profile"],
  ] as const) {
    test(`кабинет пациента: «${name}» доступен, тема ${theme}`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("quizzy.theme", t), theme);
      await login(page, "patient");
      await page.goto(path);
      await page.locator("h1").first().waitFor();
      expect(await violationsOf(page, path)).toEqual([]);
    });
  }

  test(`кабинет пациента: «методики» доступны, тема ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("quizzy.theme", t), theme);
    await login(page, "patient");
    await page.goto("/me/tests");
    // список методик — содержимое экрана; пустой экран проверять незачем
    await expect(
      page.locator('a[href^="/me/tests/"]').first(),
      "пациенту не назначено ни одной методики — на экране пусто",
    ).toBeVisible();
    expect(await violationsOf(page, "/me/tests")).toEqual([]);
  });

  test(`кабинет пациента: «запись на приём» доступна, тема ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("quizzy.theme", t), theme);
    await login(page, "patient");
    await page.goto("/me/booking");
    await page.locator("h1").first().waitFor();
    /*
     * Свободное время — данные из расписания специалистов. Без них экран
     * показывает «Вільного часу поки немає», и проверка доступности честно
     * сообщает, что одна строка текста доступна.
     */
    await expect(
      page.getByRole("button").filter({ hasText: /\d{1,2}:\d{2}/ }).first(),
      "в расписании нет свободного времени — выбирать нечего",
    ).toBeVisible();
    expect(await violationsOf(page, "/me/booking")).toEqual([]);
  });

  test(`кабинет пациента: прохождение методики доступно, тема ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("quizzy.theme", t), theme);
    await login(page, "patient");
    await page.goto("/me/tests");
    await page.locator('a[href^="/me/tests/"]').first().click();
    /*
     * Ждём именно вариант ответа, а не заголовок: экран прохождения — это
     * вопрос и кнопки под ним, и сканировать его до того, как приехал
     * первый пункт, значит проверить заставку загрузки.
     */
    await page.locator("button[aria-pressed]").first().waitFor();
    expect(await violationsOf(page, "/me/tests/:id")).toEqual([]);
  });
}

/*
 * Экран приёма — с параметром, поэтому отдельно. Именно на нём больше всего
 * новой вёрстки: три панели, запись приёма, обращения, диспансерный учёт,
 * вставка из библиотеки. Пропустить его значило бы проверить всё, кроме
 * самого плотного места.
 */
for (const theme of ["dark", "light"] as const) {
  test(`экран приёма доступен, тема ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("quizzy.theme", t), theme);
    await login(page, "psy");
    await page.goto("/today");
    await page.locator('a[href^="/visit/"]').first().click();
    await page.getByRole("heading", { name: "Приём", exact: true }).waitFor();
    await page.waitForTimeout(600);
    expect(await violationsOf(page, "/visit/:id")).toEqual([]);
  });
}

test("день отмечается с клавиатуры, без мыши", async ({ page }) => {
  /*
   * Автопроверка ловит подписи и контраст, но не отвечает на вопрос
   * «можно ли этим пользоваться без мыши». А за стойкой мышь — не всегда
   * самое быстрое: явку отмечают между двумя людьми, не глядя на экран.
   *
   * Проверяется путь целиком: дойти до кнопки табуляцией и нажать её
   * пробелом. Клик мышью по той же кнопке этого бы не доказал.
   */
  await login(page, "psy");
  await page.goto("/today");
  /*
   * Заголовком экрана стоит дата, а «Сегодня» — вкладка: сводка и приём
   * слиты в один экран.
   */
  await page.getByRole("link", { name: "Сегодня" }).waitFor();

  const came = page.getByRole("button", { name: "Пришёл" }).first();
  await expect(came).toBeVisible();

  // до кнопки добираемся табуляцией, а не фокусируем её напрямую:
  // focus() доказал бы, что кнопка принимает фокус, но не что до неё дойти
  let reached = false;
  for (let i = 0; i < 60 && !reached; i += 1) {
    await page.keyboard.press("Tab");
    reached = await came.evaluate((el) => el === document.activeElement);
  }
  expect(reached, "до кнопки «Пришёл» нельзя добраться табуляцией").toBe(true);

  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Начать" }).first()).toBeVisible();
});
