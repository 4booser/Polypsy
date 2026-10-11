import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { databaseUrlProblem, maskDatabaseUrl, passwordBreaksUrl, URL_SAFE_PASSWORD_RECIPE } from "../src/lib/dbUrl";

/**
 * Пароль роли приложения в адресе подключения (#163).
 *
 * Рецепт в подсказках (.env.docker.example, provision.ts, docs/DEPLOY.md)
 * давал обычный base64, примерно в 40% случаев с «/». docker-compose
 * подставляет пароль в DATABASE_URL как есть: api падал с «Invalid URL», и
 * драйвер печатал адрес целиком — с паролем — в журнал контейнера.
 */

const API = resolve(import.meta.dir, "..");
const ROOT = resolve(API, "../..");

/** Пароль, который выдал бы прежний рецепт: base64 с «/» и «+» */
const OLD_RECIPE_PASSWORD = "q8/Zk+3vT0pW9x/YbR2mLs7N";

function sh(script: string): string {
  const out = Bun.spawnSync(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" });
  return out.stdout.toString().trim();
}

describe("адрес базы с паролем (#163)", () => {
  test("маскировка прячет пароль — и в адресе, который URL не разбирает", () => {
    const ok = "postgres://quizzy_app:s3cr3t-Pass_word@postgres:5432/quizzy";
    expect(maskDatabaseUrl(ok)).toBe("postgres://quizzy_app:***@postgres:5432/quizzy");

    const broken = `postgres://quizzy_app:${OLD_RECIPE_PASSWORD}@postgres:5432/quizzy`;
    const masked = maskDatabaseUrl(broken);
    expect(masked).toBe("postgres://quizzy_app:***@postgres:5432/quizzy");
    expect(masked).not.toContain("q8");

    // без пароля — как есть
    expect(maskDatabaseUrl("postgres://abooser@localhost:5432/quizzy")).toBe("postgres://abooser@localhost:5432/quizzy");
  });

  test("проверка адреса называет причину и не печатает пароль", () => {
    for (const pw of [OLD_RECIPE_PASSWORD, "abc/12", "x#y", "a?b", "p%zz", "two words"]) {
      const url = `postgres://quizzy_app:${pw}@postgres:5432/quizzy`;
      const problem = databaseUrlProblem(url);
      expect(problem, pw).not.toBeNull();
      expect(problem!, pw).not.toContain(pw);
      expect(problem!, pw).toContain("***");
    }
    // закодированный пароль и пароль base64url — годятся
    expect(databaseUrlProblem(`postgres://quizzy_app:${encodeURIComponent(OLD_RECIPE_PASSWORD)}@postgres:5432/quizzy`)).toBeNull();
    expect(databaseUrlProblem("postgres://quizzy_app:q8_Zk-3vT0pW9x_YbR2mLs7N@postgres:5432/quizzy")).toBeNull();
    expect(databaseUrlProblem("postgres://abooser@localhost:5432/quizzy_test")).toBeNull();
  });

  test(
    "процесс с неразборчивым DATABASE_URL падает на проверке конфигурации, и пароля в выводе нет",
    async () => {
      const url = `postgres://quizzy_app:${OLD_RECIPE_PASSWORD}@127.0.0.1:5432/quizzy`;
      // тот же вход, что у api и provision: модуль базы читает конфигурацию и создаёт пул
      const proc = Bun.spawn(["bun", "-e", `await import(${JSON.stringify(`${API}/src/db/index.ts`)})`], {
        cwd: API,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          DATABASE_URL: url,
          JWT_SECRET: process.env.JWT_SECRET ?? "",
          ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "",
          SCHEDULER_ENABLED: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      const output = `${out}${err}`;
      expect(code, "процесс с неразборчивым адресом не упал").not.toBe(0);
      expect(output.includes(OLD_RECIPE_PASSWORD), "пароль из DATABASE_URL попал в вывод упавшего процесса").toBe(false);
      expect(output).toContain("DATABASE_URL");
      expect(output).toContain("postgres://quizzy_app:***@127.0.0.1:5432/quizzy");
    },
    20_000,
  );

  test("рецепт пароля в подсказках — base64url: в адресе ничего не ломается", () => {
    // рецепт, который печатает provision.ts, — на деле, а не по тексту
    for (let i = 0; i < 200; i++) {
      const pw = sh(URL_SAFE_PASSWORD_RECIPE);
      expect(pw.length).toBeGreaterThanOrEqual(30);
      expect(passwordBreaksUrl(pw), pw).toBe(false);
      expect(databaseUrlProblem(`postgres://quizzy_app:${pw}@postgres:5432/quizzy`), pw).toBeNull();
    }
    // контроль: прежний рецепт пароль ломает
    expect(passwordBreaksUrl(OLD_RECIPE_PASSWORD)).toBe(true);
    expect(passwordBreaksUrl("p%41ss")).toBe(true);

    const example = readFileSync(resolve(ROOT, ".env.docker.example"), "utf8");
    const deploy = readFileSync(resolve(ROOT, "docs/DEPLOY.md"), "utf8");
    const provision = readFileSync(resolve(API, "src/provision.ts"), "utf8");
    for (const [name, text] of [
      [".env.docker.example", example],
      ["docs/DEPLOY.md", deploy],
    ] as const) {
      const lines = text.split("\n").filter((l) => /APP_DB_PASSWORD|POSTGRES_PASSWORD/.test(l) && l.includes("urandom"));
      for (const line of lines) expect(line, `${name}: рецепт пароля базы без base64url`).toContain("tr '+/' '-_'");
    }
    expect(example).toContain("tr '+/' '-_'");
    expect(provision, "provision.ts подсказывает прежний рецепт").not.toContain("head -c 24 /dev/urandom | base64\"");
  });
});
