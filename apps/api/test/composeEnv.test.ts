import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Каждая настройка, которую читает сервер, доезжает до его контейнера (#158).
 *
 * .env.docker кормит подстановку в docker-compose.yml, а не окружение
 * контейнера: переменная, вписанная туда и не объявленная в `environment`
 * службы, до процесса не доходит. Так молча не действовали SITE_ALIASES,
 * OPEN_REGISTRATION (#155), а до #158 — INSTITUTION_TZ, SENTRY_DSN,
 * METRICS_TOKEN и LOG_LEVEL: пояс всегда Киев, сбор ошибок и метрики
 * выключены при внешне верной настройке.
 *
 * Сторож — сверка по тексту: что читает код (схема env.ts и прямые
 * process.env.* в apps/api/src) против environment служб compose. Новая
 * переменная без проброса валит этот тест, пока её не объявят в compose или
 * не впишут ниже с причиной, почему серверу она не нужна.
 */

const ROOT = resolve(import.meta.dir, "../../..");
const SRC = resolve(ROOT, "apps/api/src");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

type Service = { environment?: Record<string, unknown> };
const compose = Bun.YAML.parse(read("docker-compose.yml")) as { services: Record<string, Service> };
const envOf = (service: string) => new Set(Object.keys(compose.services[service]?.environment ?? {}));

/** Ключи схемы env.ts — всё, что сервер разбирает на старте */
function schemaKeys(): string[] {
  const source = read("apps/api/src/env.ts");
  const block = source.slice(source.indexOf("const schema = z.object({"), source.indexOf("\n});", source.indexOf("const schema = z.object({")));
  return [...block.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!);
}

/** Прямые чтения окружения мимо env.ts: process.env.X и process.env["X"] */
function directReads(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of new Bun.Glob("**/*.ts").scanSync(SRC)) {
    if (file.endsWith(".test.ts")) continue;
    const text = readFileSync(join(SRC, file), "utf8");
    for (const m of text.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])/g)) {
      const name = (m[1] ?? m[2])!;
      out.set(name, [...(out.get(name) ?? []), file]);
    }
  }
  return out;
}

/**
 * Не настройка сервера api — и почему. Каждая строка здесь — решение, а не
 * способ заглушить тест: где переменная должна быть, там она проверяется.
 */
const NOT_API: Record<string, { why: string; services?: string[] }> = {
  APP_DB_PASSWORD: { why: "пароль роли приложения заводит подготовка (provision.ts); api входит уже этой ролью", services: ["provision"] },
  ADMIN_EMAIL: { why: "разовый ввод установщика: docker compose run -e ADMIN_EMAIL=… provision bun apps/api/src/install.ts" },
  SCHEDULER_ENABLED: {
    why: "у api планировщик включён всегда (одна реплика); выключен он явно у transcriber — два тика выдали бы задания дважды",
    services: ["transcriber"],
  },
};

describe("compose передаёт серверу всё, что тот читает", () => {
  const names = [...new Set([...schemaKeys(), ...directReads().keys()])].sort();

  test("сверка видит и схему env.ts, и прямые чтения", () => {
    // контроль: пустой список сделал бы сверку ниже зелёной ни о чём
    expect(names).toContain("JWT_SECRET");
    expect(names).toContain("INSTITUTION_TZ");
    expect(names).toContain("SENTRY_DSN");
    expect(names).toContain("METRICS_TOKEN");
    expect(names).toContain("LOG_LEVEL");
    expect(names.length).toBeGreaterThan(30);
  });

  test("каждая переменная объявлена у api или названа выше с причиной", () => {
    const api = envOf("api");
    const missing = names.filter((name) => !api.has(name) && !NOT_API[name]);
    expect(missing, `не объявлены у api в docker-compose.yml: ${missing.join(", ")}`).toEqual([]);
    for (const [name, rule] of Object.entries(NOT_API)) {
      for (const service of rule.services ?? []) {
        expect(envOf(service).has(name), `${name} должна быть объявлена у ${service}`).toBe(true);
      }
    }
  });

  test("настройки из .env.docker берутся подстановкой, пояс и уровень журнала — с умолчанием", () => {
    const text = read("docker-compose.yml");
    for (const name of ["INSTITUTION_TZ", "LOG_LEVEL", "SENTRY_DSN", "METRICS_TOKEN"]) {
      expect(text, name).toContain(`      ${name}: \${${name}:-`);
    }
    // пустая строка — не умолчание zod, а неверный пояс: compose подставляет Киев сам
    expect(text).toContain("INSTITUTION_TZ: ${INSTITUTION_TZ:-Europe/Kyiv}");
  });

  test("расшифровщик получает пояс и уровень журнала, api — пути распознавания", () => {
    const worker = envOf("transcriber");
    for (const name of ["INSTITUTION_TZ", "LOG_LEVEL", "WHISPER_BIN", "WHISPER_MODEL", "FFMPEG_BIN"]) {
      expect(worker.has(name), `${name} у transcriber`).toBe(true);
    }
    // экран приёма спрашивает api, настроено ли распознавание
    const api = envOf("api");
    for (const name of ["WHISPER_BIN", "WHISPER_MODEL"]) expect(api.has(name), `${name} у api`).toBe(true);
  });

  test("ключи environment не повторяются ни в одной службе", () => {
    // повтор ключа compose не принимает вовсе — так встала выкатка v1.11.1
    const lines = read("docker-compose.yml").split("\n");
    let service = "";
    let inEnv = false;
    const seen = new Map<string, Set<string>>();
    const twice: string[] = [];
    for (const line of lines) {
      const svc = /^ {2}([a-z][\w-]*):\s*$/.exec(line);
      if (svc) {
        service = svc[1]!;
        inEnv = false;
        continue;
      }
      if (/^ {4}environment:\s*$/.test(line)) {
        inEnv = true;
        continue;
      }
      if (/^ {4}\S/.test(line)) inEnv = false;
      const key = inEnv ? /^ {6}([A-Z][A-Z0-9_]*):/.exec(line) : null;
      if (!key) continue;
      const set = seen.get(service) ?? new Set<string>();
      if (set.has(key[1]!)) twice.push(`${service}.${key[1]}`);
      set.add(key[1]!);
      seen.set(service, set);
    }
    expect(seen.get("api")?.size ?? 0).toBeGreaterThan(30);
    expect(twice).toEqual([]);
  });
});

describe("INSTITUTION_TZ на старте", () => {
  async function tz(value: string | undefined): Promise<{ ok: boolean; out: string }> {
    const environment: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    if (value !== undefined) environment.INSTITUTION_TZ = value;
    const code = `const { env } = await import(${JSON.stringify(`${SRC}/env.ts`)}); console.log("TZ=" + env.institutionTz)`;
    const proc = Bun.spawn(["bun", "-e", code], { cwd: SRC, env: environment, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { ok: (await proc.exited) === 0, out: `${out}${err}` };
  }

  test("пусто и не задано — Киев, верный пояс — как есть", async () => {
    for (const value of [undefined, "", "  "]) expect((await tz(value)).out, JSON.stringify(value)).toContain("TZ=Europe/Kyiv");
    expect((await tz("Europe/Warsaw")).out).toContain("TZ=Europe/Warsaw");
  }, 30_000);

  test("незнакомый пояс — отказ запуска с названием переменной", async () => {
    const res = await tz("Europe/Kyyiv");
    expect(res.ok).toBe(false);
    expect(res.out).toContain("INSTITUTION_TZ");
    expect(res.out).not.toContain("TZ=");
  }, 30_000);
});

describe("предел ядер расшифровщика не больше ядер хоста", () => {
  async function clamp(content: string | null, hostCpus: number): Promise<{ ok: boolean; file: string; out: string }> {
    const dir = mkdtempSync(join(tmpdir(), "cpus-"));
    try {
      const file = join(dir, ".env.docker");
      writeFileSync(file, content ?? "");
      const proc = Bun.spawn(["bash", resolve(ROOT, "scripts/transcriber-cpus.sh"), file], {
        env: { PATH: process.env.PATH ?? "", HOST_CPUS: String(hostCpus) },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { ok: (await proc.exited) === 0, file: readFileSync(file, "utf8"), out: `${out}${err}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("одноядерный хост: 2 из примера окружения становится 1, остальное не тронуто", async () => {
    const res = await clamp("JWT_SECRET=a=b\nTRANSCRIBER_CPUS=2\nWHISPER_MODEL_NAME=small\n", 1);
    expect(res.ok, res.out).toBe(true);
    expect(res.file).toBe("JWT_SECRET=a=b\nTRANSCRIBER_CPUS=1\nWHISPER_MODEL_NAME=small\n");
  });

  test("переменной нет — умолчание compose (2) тоже приводится", async () => {
    const res = await clamp("POSTGRES_PASSWORD=x\n", 1);
    expect(res.ok, res.out).toBe(true);
    expect(res.file).toBe("POSTGRES_PASSWORD=x\nTRANSCRIBER_CPUS=1\n");
  });

  test("допустимое значение не трогается", async () => {
    // контроль: без него «всегда пишет число ядер» выглядело бы как исправная проверка
    for (const [content, cpus] of [
      ["TRANSCRIBER_CPUS=2\n", 4],
      ["TRANSCRIBER_CPUS=1.5\n", 2],
      ["TRANSCRIBER_CPUS=2\n", 2],
      ["X=1\n", 8],
    ] as const) {
      const res = await clamp(content, cpus);
      expect(res.ok, res.out).toBe(true);
      expect(res.file, `${content} при ${cpus} ядрах`).toBe(content);
    }
  });

  test("не число — отказ, файл не тронут", async () => {
    const res = await clamp("TRANSCRIBER_CPUS=два\n", 1);
    expect(res.ok).toBe(false);
    expect(res.file).toBe("TRANSCRIBER_CPUS=два\n");
  });

  test("установщик и выкатка зовут сверку до подъёма", () => {
    const setup = read("scripts/vps-setup.sh");
    expect(setup.indexOf("scripts/transcriber-cpus.sh")).toBeGreaterThan(0);
    expect(setup.indexOf("scripts/transcriber-cpus.sh")).toBeLessThan(setup.indexOf("up -d --build"));
    const deploy = read(".github/workflows/deploy.yml");
    expect(deploy).toMatch(/scp [^\n]*scripts\/transcriber-cpus\.sh/);
    const call = deploy.indexOf("bash scripts/transcriber-cpus.sh .env.docker");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(deploy.indexOf("docker compose --env-file .env.docker up -d"));
  });
});
