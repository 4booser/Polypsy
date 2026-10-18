import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { apiToken, auth, emailField, eventsBell, passwordField } from "./helpers";

/**
 * Вход и его ворота глазами человека (Polypsy 2.0, участок «доступ»):
 * блокировка после перебора, временный пароль, второй фактор кодом из
 * приложения и кодом восстановления, приглашение пациента.
 *
 * Правила за этими экранами проверены тестами API (loginGuard, secondFactor,
 * tempPassword, invites); здесь — что экран их показывает и проводит по ним
 * человека, а не стоит перед ним немым отказом.
 *
 * Каждый сценарий заводит свою учётку: перебор пароля запирает почту на 15
 * минут, а второй фактор и смена пароля меняют вход — делать это с учётками
 * посева значило бы ломать соседние файлы.
 */

const SUBMIT = /^(Увійти|Войти)$/;
const unique = (what: string) => `access-${what}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;

/** Сотрудник с паролем, заведённый суперадмином; `temporary` — с обязательной сменой пароля */
async function staffAccount(page: Page, what: string, temporary = false) {
  const root = await apiToken(page, "superadmin");
  const email = unique(what);
  const password = "access-e2e-12345";
  const made = await page.request.post("/api/users", {
    headers: auth(root),
    data: { email, password, firstName: "Доступ", lastName: "Смоук", role: "admin", mustChangePassword: temporary },
  });
  expect(made.ok(), await made.text()).toBe(true);
  return { email, password };
}

/* ─────────── TOTP (RFC 6238) — тот же расчёт, что у приложения-аутентификатора ─────────── */

function base32(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of text.replace(/[\s=]/g, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret: string, atMs: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / 30)));
  const mac = createHmac("sha1", base32(secret)).update(counter).digest();
  const at = mac[mac.length - 1]! & 0x0f;
  const n = (mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, "0");
}

/** Учётка со вторым фактором: настроен и подтверждён по API, как это сделал бы человек в «Обліковому записі» */
async function factorAccount(page: Page, what: string) {
  const acc = await staffAccount(page, what);
  const login = await page.request.post("/api/auth/login", { data: acc });
  expect(login.ok(), await login.text()).toBe(true);
  const token = (await login.json()).token as string;
  const setup = await page.request.post("/api/auth/mfa/setup", { headers: auth(token) });
  expect(setup.ok(), await setup.text()).toBe(true);
  const { secret } = (await setup.json()) as { secret: string };
  const confirm = await page.request.post("/api/auth/mfa/confirm", {
    headers: auth(token),
    data: { code: totp(secret, Date.now()) },
  });
  expect(confirm.ok(), await confirm.text()).toBe(true);
  const { recoveryCodes } = (await confirm.json()) as { recoveryCodes: string[] };
  return { ...acc, secret, recoveryCodes };
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await emailField(page).fill(email);
  await passwordField(page).fill(password);
  await page.getByRole("button", { name: SUBMIT }).click();
}

test.describe("вход", () => {
  test("забагато спроб: вход для почты остановлен, кнопка говорит, до какого времени", async ({ page }) => {
    /*
     * Пять неудач — по API (так быстрее и так же считается сервером: счётчик
     * по почте), шестая — с экрана. Почта выдуманная: перебор считается и
     * для неизвестного адреса, чтобы по ответу нельзя было узнать, есть ли он.
     */
    const email = unique("lock");
    for (let i = 0; i < 5; i++) {
      const res = await page.request.post("/api/auth/login", { data: { email, password: "не-той-пароль" } });
      expect(res.status()).toBe(401);
    }
    await signIn(page, email, "не-той-пароль");

    await expect(page.getByRole("alert")).toContainText(/Забагато спроб|Слишком много попыток/);
    const locked = page.getByRole("button", { name: /^(Увійти можна о|Войти можно в) \d{1,2}:\d{2}$/ });
    await expect(locked).toBeDisabled();
    // подсказка, кто сбрасывает пароль, открыта сама: человеку сейчас нужна именно она
    await expect(page.getByText(/Не пам’ятаєте пароль\?|Не помните пароль\?/)).toBeVisible();

    // другая почта — другая блокировка: кнопка снова «Увійти»
    await emailField(page).fill(unique("other"));
    await expect(page.getByRole("button", { name: SUBMIT })).toBeEnabled();
  });

  test("временный пароль: сначала свой, потом работа", async ({ page }) => {
    const acc = await staffAccount(page, "temp", true);
    await signIn(page, acc.email, acc.password);

    await expect(page.getByRole("heading", { level: 1, name: /^(Змініть пароль|Смените пароль)$/ })).toBeVisible();
    // до смены консоли нет — ни рельсы, ни колокольчика
    await expect(eventsBell(page)).toHaveCount(0);

    const fresh = "свій-пароль-access-2026";
    await page.getByLabel(/^(Тимчасовий пароль|Временный пароль)$/).fill(acc.password);
    await page.getByLabel(/^(Новий пароль|Новый пароль)$/).fill(fresh);
    await page.getByLabel(/^(Новий пароль ще раз|Новый пароль ещё раз)$/).fill(fresh);
    await page.getByRole("button", { name: /^(Змінити пароль|Сменить пароль)$/ }).click();

    // смена гасит сессию, экран входит заново новым паролем сам — человек попадает в консоль
    await expect(eventsBell(page)).toBeVisible();
  });
});

test.describe("второй фактор", () => {
  test("после пароля — код из приложения, и человек внутри", async ({ page }) => {
    const acc = await factorAccount(page, "otp");
    await signIn(page, acc.email, acc.password);

    await expect(page.getByRole("heading", { level: 1, name: /^(Код із застосунку|Код из приложения)$/ })).toBeVisible();
    const submit = page.getByRole("button", { name: SUBMIT });
    await expect(submit).toBeDisabled();

    /*
     * Код следующего шага (30 с вперёд): код текущего уже потрачен на
     * подтверждение, и сервер не примет его второй раз (защита от повтора),
     * а соседний шаг он принимает — так терпит расхождение часов телефона.
     * Код вставляется целиком в первую клетку и раскладывается по шести сам.
     */
    const digits = page.getByRole("group", { name: /Шість цифр коду|Шесть цифр кода/ }).getByRole("textbox");
    await digits.first().fill(totp(acc.secret, Date.now() + 30_000));
    await expect(digits.nth(5)).not.toHaveValue("");
    await submit.click();

    await expect(eventsBell(page)).toBeVisible();
  });

  test("нет телефона — код восстановления, и человек внутри", async ({ page }) => {
    const acc = await factorAccount(page, "recovery");
    await signIn(page, acc.email, acc.password);

    await page.getByRole("button", { name: /^(Ввести код відновлення|Ввести код восстановления)$/ }).click();
    await page.getByLabel(/^(Код відновлення|Код восстановления)$/).fill(acc.recoveryCodes[0]!);
    await page.getByRole("button", { name: SUBMIT }).click();

    await expect(eventsBell(page)).toBeVisible();
  });

  test("«Інший обліковий запис» возвращает к паролю", async ({ page }) => {
    const acc = await factorAccount(page, "back");
    await signIn(page, acc.email, acc.password);
    await page.getByRole("button", { name: /^(Інший обліковий запис|Другая учётная запись)$/ }).click();
    await expect(emailField(page)).toBeVisible();
    await expect(passwordField(page)).toBeVisible();
  });
});

test.describe("приглашение пациента", () => {
  test("недействительное — сказано, что запрошення не діє и почему", async ({ page }) => {
    await page.goto(`/join/no-such-invite-${Date.now()}`);
    await expect(page.getByRole("heading", { level: 1, name: /^(Запрошення не діє|Приглашение не действует)$/ })).toBeVisible();
    // «ваш випадок» отмечен в списке причин
    await expect(page.getByText(/^(ваш випадок|ваш случай)$/)).toBeVisible();
  });

  test("по ссылке специалиста человек регистрируется и узнаёт, где входить", async ({ page }) => {
    const psy = await apiToken(page, "psy");
    const made = await page.request.post("/api/invites", { headers: auth(psy), data: { maxUses: 1 } });
    expect(made.ok(), await made.text()).toBe(true);
    const { token } = (await made.json()) as { token: string };

    await page.goto(`/join/${token}`);
    await expect(page.getByRole("heading", { level: 1, name: /^(Вас запросили пройти обстеження|Вас пригласили пройти обследование)$/ })).toBeVisible();

    const submit = page.getByRole("button", { name: /^(Зареєструватися|Зарегистрироваться)$/ });
    await expect(submit).toBeDisabled();

    await page.getByLabel(/^Телефон \*$/).fill(`+38050${Math.floor(1000000 + Math.random() * 8999999)}`);
    await page.getByLabel(/^(Електронна пошта|Электронная почта) \*$/).fill(unique("join"));
    await page.getByLabel(/^Пароль \*$/).fill("join-e2e-12345");
    await page.getByLabel(/^(Прізвище|Фамилия) \*$/).fill("Запрошений");
    await page.getByLabel(/^(Ім’я|Имя) \*$/).fill("Смоук");
    await submit.click();

    await expect(page.getByRole("heading", { level: 1, name: /^(Обліковий запис створено|Учётная запись создана)$/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /^(Увійти|Войти)$/ }).last()).toBeVisible();
  });

  test("«Допомога» открывает, кому звонить", async ({ page }) => {
    await page.goto(`/join/no-such-invite-${Date.now()}`);
    await page.getByRole("button", { name: /^(Допомога|Помощь)$/ }).click();
    // в ящике — звонок одним нажатием: ссылки tel:, 103 среди них
    const help = page.getByRole("dialog");
    await expect(help.getByRole("link", { name: /103/ })).toHaveAttribute("href", "tel:103");
  });
});
