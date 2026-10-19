import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";

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
    /*
     * Источник словаря для проверок: в сборке его подменяет плагин
     * (dictionaryPlugin.ts) куском языка, и его импорты UI и ERRORS в
     * начальный кусок не попадают.
     */
    if (rel(file) === "dictionary/source.ts") continue;
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
      /*
       * Точка входа набора и части, которые первому экрану не нужны (волна
       * 27): оболочка берёт свои части из их модулей напрямую (ui/toast,
       * ui/states, ui/Drawer, ui/strokeIcons…), иначе `export *` точки
       * входа тянул в начальный кусок таблицу, фильтры и окна. Части
       * кабинета пациента и модель записи — тоже: листу падения нужны
       * только строки-звонки (patient/callRows.tsx), клиенту API — только
       * имя файла записи (components/recorder/audioFile.ts).
       */
      "ui/index.tsx",
      "ui/DataTable.tsx",
      "ui/filters.tsx",
      "ui/records.tsx",
      "patient/parts.tsx",
      "components/recorder/model.ts",
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

  test("из общего пакета — без справочников на трёх языках", () => {
    /*
     * Модуль прав держит справочник прав на трёх языках (названия, что
     * открывает каждое право), а начальному куску из него нужны лишь
     * ступень роли и пункты рельсы, которые нельзя спрятать: они живут в
     * ladder.ts и alwaysVisible.ts (волна 27). Словарь интерфейса консоль
     * берёт у себя (src/dictionary), и из uiStrings.ts в начальном куске —
     * только выбор языка браузера.
     */
    const modules = new Map([...graph.sharedNames].map((n) => [n, sharedModuleOf(n)] as const));
    const fromPermissions = [...modules].filter(([, m]) => m?.endsWith("/permissions.ts")).map(([n]) => n);
    expect(fromPermissions).toEqual([]);
    const fromDictionary = [...modules].filter(([, m]) => m?.endsWith("/uiStrings.ts")).map(([n]) => n);
    expect(fromDictionary.filter((n) => n !== "detectLang")).toEqual([]);
  });

  test("проверка видит то, что проверяет: вход и оболочка в графе есть", () => {
    // без этого пустой граф (сломанный разбор импортов) проходил бы все проверки выше
    const mods = [...graph.modules].map(rel);
    expect(mods).toContain("App.tsx");
    expect(mods).toContain("pages/Login.tsx");
    expect(mods).toContain("shell/AppBar.tsx");
    expect(mods).toContain("shell/Rail.tsx");
    expect(graph.packages.has("react-router-dom")).toBe(true);
    expect(graph.sharedNames.size).toBeGreaterThan(10);
  });

  test("начальный кусок делится: React — своим файлом, словарь — куском на язык", () => {
    const config = readFileSync(resolve(import.meta.dir, "../vite.config.ts"), "utf8");
    expect(config).toContain("manualChunks");
    expect(config).toMatch(/return "react"/);
    // словарь — плагином: ядро куском на язык, строки экранов — с экранами (dictionaryPlugin.ts)
    expect(config).toContain("dictionaryByLanguage()");
    expect(config).toContain("languageChunk(id)");
  });

  test("словарь консоль берёт у себя, а не трёхъязычным целым из общего пакета", () => {
    /*
     * makeUiT, uiText и renderError из "@quizzy/shared" вернули бы в сборку
     * весь словарь на трёх языках — 1,4 МБ, ради которых его и разбили по
     * языку и по экрану (волна 27). У консоли свои с теми же подписями —
     * src/dictionary. Значениями UI и ERRORS берёт лишь источник для
     * проверок (src/dictionary/source.ts), и в сборке его подменяет плагин.
     */
    const FULL = new Set(["UI", "ERRORS", "PUSH", "makeUiT", "uiText", "renderError", "untranslatedEn", "EMPTY_BY_DESIGN_EN"]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && rel(full) !== "dictionary/source.ts") {
          for (const { spec, names } of staticImports(readFileSync(full, "utf8"))) {
            if (spec !== "@quizzy/shared") continue;
            for (const n of names) if (FULL.has(n)) offenders.push(`${rel(full)}: ${n}`);
          }
        }
      }
    };
    walk(SRC);
    expect(offenders, "переводчик консоли — из src/dictionary, а не из общего пакета").toEqual([]);
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

/*
 * Бюджет начальной загрузки — по настоящей сборке (волна 27, perf-bundle).
 *
 * Сторож выше идёт по графу импортов и ловит «тяжёлый модуль попал в
 * начальный кусок». Чего граф не видит — веса: модуль, оставшийся на месте,
 * может вырасти вдвое. Поэтому здесь консоль собирается целиком (Vite в
 * отдельном процессе, во временный каталог) и меряется то, что браузер
 * качает до первого экрана: вход (index), куски из modulepreload (react),
 * стили и кусок словаря выбранного языка (strings-uk; ru и en не больше).
 *
 * Волна 27 сняла начальную загрузку с 2250 КБ (626 КБ gzip) до 759 КБ
 * (212 КБ gzip): словарь по языку и по экрану, точка входа набора мимо
 * оболочки, справочник прав и модель записи вне начального куска,
 * наследие стилей без мёртвых правил. Пределы ниже — эти числа с запасом
 * в несколько процентов на обычный рост; превысили — значит, в начальный
 * кусок что-то приехало, и это надо найти (BUILD_SOURCEMAP=1 и карта
 * исходников покажут, что именно), а не поднять предел.
 */
const BUDGET = {
  /** вход, modulepreload, стили и кусок словаря одного языка */
  initialRaw: 800_000,
  initialGzip: 225_000,
  /** сама консоль: оболочка, вход, набор */
  entryRaw: 295_000,
  /** ядро словаря одного языка: строки входа, оболочки и набора */
  stringsRaw: 45_000,
  /** стили целиком: утилиты, токены, наследие, набор */
  cssRaw: 175_000,
};

describe("бюджет начальной загрузки", () => {
  const WEB = resolve(import.meta.dir, "..");
  const out = mkdtempSync(join(tmpdir(), "quizzy-bundle-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  let built: Promise<{ html: string; size: (path: string) => { raw: number; gzip: number }; assets: string[] }> | null = null;
  const build = () =>
    (built ??= (async () => {
      const proc = Bun.spawn(
        [process.execPath, resolve(WEB, "../../node_modules/vite/bin/vite.js"), "build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"],
        /*
         * NODE_ENV — боевой явно: bun test ставит «test», Vite его сохраняет,
         * и в сборку уезжал бы отладочный React — вдвое тяжелее того, что
         * получает браузер.
         */
        { cwd: WEB, stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_ENV: "production" } },
      );
      const code = await proc.exited;
      if (code !== 0) throw new Error(`vite build: ${code}\n${await new Response(proc.stderr).text()}`);
      const html = readFileSync(join(out, "index.html"), "utf8");
      const size = (path: string) => {
        const buf = readFileSync(join(out, path.replace(/^\//, "")));
        return { raw: buf.length, gzip: gzipSync(buf).length };
      };
      return { html, size, assets: readdirSync(join(out, "assets")) };
    })());

  test(
    "в начальной загрузке — вход, React, стили и словарь одного языка; всё в бюджете",
    async () => {
      const { html, size, assets } = await build();
      const entry = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]!);
      const preload = [...html.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
      const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
      const strings = assets.filter((a) => /^strings-(uk|ru|en)-.*\.js$/.test(a));

      expect(entry).toHaveLength(1);
      // словарь в предзагрузку ставит скрипт по выбранному языку, а не сборщик — всем трём
      expect(preload.filter((p) => p.includes("strings-"))).toEqual([]);
      expect(strings.map((a) => a.split("-")[1]).sort()).toEqual(["en", "ru", "uk"]);
      expect(html).toContain('k.rel="modulepreload"');

      const parts = [...entry, ...preload, ...css].map(size);
      const largestStrings = Math.max(...strings.map((a) => size(`assets/${a}`).raw));
      const uk = size(`assets/${strings.find((a) => a.startsWith("strings-uk-"))!}`);
      const total = { raw: parts.reduce((n, p) => n + p.raw, 0) + uk.raw, gzip: parts.reduce((n, p) => n + p.gzip, 0) + uk.gzip };
      const report = JSON.stringify({ total, entry: size(entry[0]!), css: css.map(size), largestStrings });

      expect(total.raw, report).toBeLessThanOrEqual(BUDGET.initialRaw);
      expect(total.gzip, report).toBeLessThanOrEqual(BUDGET.initialGzip);
      expect(size(entry[0]!).raw, report).toBeLessThanOrEqual(BUDGET.entryRaw);
      expect(largestStrings, report).toBeLessThanOrEqual(BUDGET.stringsRaw);
      for (const c of css) expect(size(c).raw, report).toBeLessThanOrEqual(BUDGET.cssRaw);
    },
    180_000,
  );
});
