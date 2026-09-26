import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Сторож начального куска консоли (волна 12, разбор кода: «весь бандл
 * консоли загружался одним файлом, а рабочий код содержал console.log»).
 *
 * До правки начальный кусок весил 1,28 МБ: вместе со входом ехали сводка с
 * графиками, очередь случаев, список пациентов, палитра команд с cmdk,
 * виртуализация таблиц и весь zod — хотя консоль им ничего не разбирает.
 * Теперь всё это — по требованию (App.tsx, ui/virtualRows.tsx,
 * shared/wireSchemas.ts), а начальный кусок поделён на три (vite.config.ts).
 *
 * Проверка идёт по статическому графу импортов от main.tsx, а не сборкой:
 * сборка — секунды и запись на диск на каждом прогоне, а граф — ровно то, по
 * чему сборщик решает, что попадёт в начальный кусок. Динамический
 * `import()` граф рвёт — туда и уходят экраны.
 */

const SRC = resolve(import.meta.dir, "../src");
const SHARED = resolve(import.meta.dir, "../../../packages/shared/src");
const rel = (p: string) => relative(SRC, p);

/** Статические импорты значений: `import type` и `import()` в граф начального куска не входят */
function staticImports(text: string): { spec: string; names: string[] }[] {
  const out: { spec: string; names: string[] }[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^"';]*?)\s*from\s*["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) {
    if (m[5]) {
      out.push({ spec: m[5], names: [] });
      continue;
    }
    if (m[2]) continue;
    const clause = m[3] ?? "";
    const names = [...clause.matchAll(/\{([^}]*)\}/g)]
      .flatMap((b) => b[1]!.split(","))
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith("type "))
      .map((n) => n.split(/\s+as\s+/)[0]!.trim());
    // `export * from` и `import X from` — модуль нужен целиком
    out.push({ spec: m[4]!, names: clause.includes("{") ? names : ["*"] });
  }
  return out;
}

function resolveLocal(from: string, spec: string): string | null {
  const base = spec === "@quizzy/shared" ? join(SHARED, "index") : resolve(dirname(from), spec);
  for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/** Модули консоли и пакеты, достижимые от main.tsx статическими импортами, и имена, взятые из общего пакета */
function initialGraph() {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const sharedNames = new Set<string>();
  const queue = [join(SRC, "main.tsx")];
  while (queue.length) {
    const file = queue.pop()!;
    if (modules.has(file)) continue;
    modules.add(file);
    // общий пакет берётся по именам (см. ниже), а не по export * — иначе в граф попал бы весь пакет
    if (file.startsWith(SHARED)) continue;
    for (const { spec, names } of staticImports(readFileSync(file, "utf8"))) {
      if (spec.endsWith(".css")) continue;
      if (spec === "@quizzy/shared") {
        for (const n of names) sharedNames.add(n);
        continue;
      }
      if (spec.startsWith(".")) {
        const next = resolveLocal(file, spec);
        if (next) queue.push(next);
        continue;
      }
      packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
    }
  }
  return { modules, packages, sharedNames };
}

/** В каком модуле общего пакета объявлено имя */
function sharedModuleOf(name: string): string | null {
  const decl = new RegExp(`export\\s+(?:const|function|class|let|enum)\\s+${name}\\b`);
  for (const f of readdirSync(SHARED)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    if (decl.test(readFileSync(join(SHARED, f), "utf8"))) return join(SHARED, f);
  }
  return null;
}

describe("начальный кусок консоли", () => {
  const graph = initialGraph();

  test("тяжёлые экраны в нём не лежат — они по требованию", () => {
    const heavy = [
      "pages/Dashboard.tsx",
      "pages/Alerts.tsx",
      "pages/Patients.tsx",
      "charts/clinical.tsx",
      "charts/index.tsx",
      "shell/CommandPalette.tsx",
      "ui/virtualRows.tsx",
      "pages/constructor/index.tsx",
    ];
    const inside = [...graph.modules].map(rel).filter((m) => heavy.includes(m));
    expect(inside).toEqual([]);
  });

  test("тяжёлые библиотеки в него не попадают", () => {
    const libs = ["cmdk", "@tanstack/react-virtual", "d3-array", "d3-scale", "d3-shape", "qrcode-generator", "zod"];
    expect([...graph.packages].filter((p) => libs.includes(p))).toEqual([]);
  });

  test("из общего пакета — только модули без zod", () => {
    /*
     * Модуль общего пакета, из которого консоль берёт хоть одно значение,
     * попадает в начальный кусок целиком — со схемами zod на верхнем уровне,
     * если они там есть (сборщик обязан считать их вызов побочным эффектом).
     * Поэтому схемы живут отдельно (schemas.ts, wireSchemas.ts), и сюда их
     * модули приходить не должны.
     */
    const withZod = [...graph.sharedNames]
      .map((n) => [n, sharedModuleOf(n)] as const)
      .filter(([, m]) => m && /from\s+["']zod["']/.test(readFileSync(m, "utf8")))
      .map(([n, m]) => `${n} ← ${relative(SHARED, m!)}`);
    expect(withZod).toEqual([]);
  });

  test("проверка видит то, что проверяет: вход и оболочка в графе есть", () => {
    // без этого пустой граф (сломанный разбор импортов) проходил бы все проверки выше
    const mods = [...graph.modules].map(rel);
    expect(mods).toContain("App.tsx");
    expect(mods).toContain("pages/Login.tsx");
    expect(mods).toContain("shell/Topbar.tsx");
    expect(graph.packages.has("react-router-dom")).toBe(true);
    expect(graph.sharedNames.size).toBeGreaterThan(10);
  });

  test("начальный кусок делится: React и словарь — своими файлами", () => {
    const config = readFileSync(resolve(import.meta.dir, "../vite.config.ts"), "utf8");
    expect(config).toContain("manualChunks");
    expect(config).toMatch(/return "react"/);
    expect(config).toMatch(/uiStrings\.ts"\)\) return "strings"/);
  });
});

describe("отладочный вывод", () => {
  test("console.log и console.debug в коде консоли нет", () => {
    /*
     * Второй сторож — правило noConsole в biome.json для apps/web/src (в CI
     * идёт `biome lint`). Этот — на случай запуска одних тестов: вывод в
     * консоль браузера у рабочей консоли читает любой, кто открыл
     * инструменты разработчика, а в нём бывают ответы сервера с ФИО.
     * console.error и console.warn разрешены — это сообщения об отказе, а не
     * отладка.
     */
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|jsx?)$/.test(name)) {
          const lines = readFileSync(full, "utf8").split("\n");
          lines.forEach((line, i) => {
            const code = line.replace(/\/\/.*$/, "");
            if (/\bconsole\s*\.\s*(log|debug|trace|dir|table)\s*\(/.test(code)) found.push(`${rel(full)}:${i + 1}`);
          });
        }
      }
    };
    walk(SRC);
    expect(found).toEqual([]);
  });
});
