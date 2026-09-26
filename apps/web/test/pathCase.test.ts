import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Сторож регистра путей (волна 12, разбор кода: «Pager.tsx и pager.tsx
 * конфликтовали на macOS»).
 *
 * На macOS и Windows файловая система по умолчанию к регистру безразлична:
 * два пути, различающиеся одной заглавной, там один файл, а в git и на
 * Linux — два. Так и было с ui/Pager.tsx и ui/pager.tsx (исправлено в
 * 31bc4b4): у кого-то после pull один из них молча затирал другой, а
 * сборка на Linux видела оба. Вторая половина той же беды — импорт
 * "../ui/Pager" при файле pager.tsx: на Mac он находится, в CI и в образе —
 * нет, и ломается выкатка, а не разработка.
 */

const ROOT = resolve(import.meta.dir, "../../..");
const WEB_SRC = resolve(import.meta.dir, "../src");

/** Пути репозитория: из git, а без него (архив, образ) — обходом каталогов */
function trackedPaths(): string[] {
  const git = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (git.exitCode === 0) return git.stdout.toString().split("\0").filter(Boolean);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git" || name === "dist" || name === ".expo") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(ROOT, full));
    }
  };
  walk(ROOT);
  return out;
}

describe("регистр путей", () => {
  test("в репозитории нет путей, различающихся только регистром", () => {
    /*
     * Сравниваются и файлы, и каталоги на всех уровнях: «Ui/menu.tsx» рядом с
     * «ui/pager.tsx» — та же поломка, только на уровень выше.
     */
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const path of trackedPaths()) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join("/");
        const folded = prefix.toLowerCase();
        const first = seen.get(folded);
        if (first === undefined) seen.set(folded, prefix);
        else if (first !== prefix) clashes.push(`${first} ↔ ${prefix}`);
      }
    }
    expect([...new Set(clashes)]).toEqual([]);
  });

  test("относительные импорты консоли пишут имя файла в его настоящем регистре", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|css)$/.test(name)) files.push(full);
      }
    };
    walk(WEB_SRC);

    /* существует ли путь ровно в таком регистре — сверка по списку каталога, а не по stat */
    const exact = (path: string): boolean => {
      const rel = relative(ROOT, path).split("/");
      let dir = ROOT;
      for (const part of rel) {
        if (!readdirSync(dir).includes(part)) return false;
        dir = join(dir, part);
      }
      return true;
    };
    const candidates = (base: string) =>
      ["", ".ts", ".tsx", ".css", "/index.ts", "/index.tsx"].map((ext) => base + ext);

    const wrong: string[] = [];
    const spec = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(spec)) {
        const target = resolve(dirname(file), m[1]!);
        const found = candidates(target).filter((p) => existsSync(p) && statSync(p).isFile());
        if (found.length && !found.some(exact)) wrong.push(`${relative(WEB_SRC, file)}: ${m[1]}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
