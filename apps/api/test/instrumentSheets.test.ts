import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { db, root } from "./fixtures";
import { surveyGroups } from "../src/db/schema";
import { CATALOG } from "../src/instruments/catalog";
import {
  SHEETS_DIR,
  buildSheetFiles,
  installForSheets,
  readSheetContext,
  reviewBlockOf,
  sheetEntries,
  type InstalledInstrument,
  type SheetContext,
} from "../src/instrumentSheets";
import { REVIEW_BEGIN } from "../src/instrumentSheets/render";
import { reviewStatus } from "../src/instrumentSheets/readme";

/**
 * Листы сверки методик не расходятся с тем, что считает система (волна 14).
 *
 * Пакет docs/instruments/ — то, по чему психолог заказчика проверяет каждую
 * методику, не читая код. Лист, описывающий прошлую редакцию методики, хуже
 * отсутствующего: психолог подпишет «сверено» под тем, чего в системе уже
 * нет. Поэтому тест ставит все методики настоящим путём (как установщик),
 * пересобирает пакет живым движком и сравнивает с репозиторием побайтно —
 * блок «Перевірка психологом» переносится из лежащего листа, так что его
 * заполнение тест не ломает.
 *
 * Перегенерация: `bun run --cwd apps/api docs:instruments` (SHEETS_WRITE=1
 * этого же файла) — пишет пакет вместо сравнения и убирает листы методик,
 * которых больше нет.
 */

const ROOT = resolve(import.meta.dir, "../../..");
const WRITE = process.env.SHEETS_WRITE === "1";

let installed: InstalledInstrument[] = [];
let ctx: SheetContext;
let files: Map<string, string>;

/*
 * Пакет собирается один раз на файл: перебор достижимых сумм у 31 методики
 * (у БОО — двести пунктов, у Мини-мульта — две нормы) занимает секунды, а
 * под нагрузкой параллельных прогонов — десятки секунд.
 */
beforeAll(async () => {
  const group = crypto.randomUUID();
  await db.insert(surveyGroups).values({ id: group, title: `Листи звірки ${group.slice(0, 8)}`, createdBy: root.id });
  installed = await installForSheets(root.id, group);
  ctx = readSheetContext(ROOT);
  files = buildSheetFiles(installed, ctx);
}, 600_000);

/** Первая отличающаяся строка — чтобы отказ показывал, что именно устарело */
function firstDiff(want: string, have: string): string {
  const a = want.split("\n");
  const b = have.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `строка ${i + 1}:\n  система: ${a[i] ?? "(конец)"}\n  в файле:  ${b[i] ?? "(конец)"}`;
  }
  return "";
}

describe("пакет сверки методик", () => {
  test("лист есть у каждой методики: встроенные и весь каталог", () => {
    const keys = sheetEntries().map((e) => e.key);
    expect(keys).toEqual(expect.arrayContaining(["sr45", "sad-persons", "minimult", "mlo", ...CATALOG.map((e) => e.key)]));
    expect(new Set(keys).size).toBe(keys.length);
    expect(installed.length).toBe(keys.length);
  });

  test("листы в репозитории совпадают с тем, что считает движок", () => {
    if (WRITE) {
      // листы методик, которых больше нет, убираются — иначе они описывали бы несуществующее
      for (const lang of ["uk", "ru"]) {
        const dir = join(ROOT, SHEETS_DIR, lang);
        mkdirSync(dir, { recursive: true });
        for (const name of readdirSync(dir)) {
          if (!files.has(`${SHEETS_DIR}/${lang}/${name}`)) rmSync(join(dir, name));
        }
      }
      for (const [path, text] of files) {
        mkdirSync(dirname(join(ROOT, path)), { recursive: true });
        writeFileSync(join(ROOT, path), text);
      }
      console.log(`  пакет сверки записан: ${files.size} файлов в ${SHEETS_DIR}/`);
      return;
    }

    const stale: string[] = [];
    for (const [path, text] of files) {
      const have = ctx.existing.get(path);
      if (have === undefined) stale.push(`${path}: листа нет в репозитории`);
      else if (have !== text) stale.push(`${path}: ${firstDiff(text, have)}`);
    }
    for (const path of ctx.existing.keys()) {
      if (!files.has(path)) stale.push(`${path}: лист методики, которой в системе нет`);
    }
    expect(
      stale,
      "листы сверки разошлись с тем, что считает система — перегенерируй: bun run --cwd apps/api docs:instruments",
    ).toEqual([]);
  });

  test("у каждого листа есть блок сверки, и его отметка читается сводкой", () => {
    for (const [path, text] of files) {
      if (!/\/(uk|ru)\/(?!scoring-rules)[^/]+\.md$/.test(path)) continue;
      expect(reviewBlockOf(text), `${path}: нет блока «Перевірка психологом»`).not.toBeNull();
    }
    // заполненная строка таблицы — это «сверено», пустая — нет
    const blank = reviewBlockOf(files.get(`${SHEETS_DIR}/uk/phq9.md`))!;
    expect(reviewStatus(blank)).toBeNull();
    const filled = blank.replace("|   |   |   |   |", "| Іваненко І. І., психолог | 2026-10-01 | звірено | — |");
    expect(filled.startsWith(REVIEW_BEGIN)).toBe(true);
    expect(reviewStatus(filled)).toEqual({ who: "Іваненко І. І., психолог", date: "2026-10-01", verdict: "звірено" });
  });

  test("проверочные примеры досье совпадают с досье, а расхождение не прячется", () => {
    const sheets = [...files].filter(([path]) => /\/uk\/(?!scoring-rules)[^/]+\.md$/.test(path));
    const checked = sheets.filter(([, text]) => text.includes("Очікується за досьє"));
    // у каждой методики с досье есть проверочный пример — иначе сверка с первоисточником молчит
    const withDossier = installed.filter((i) => ctx.dossiers.has(i.entry.key)).map((i) => `${SHEETS_DIR}/uk/${i.entry.key}.md`);
    expect(checked.map(([path]) => path).sort()).toEqual(withDossier.sort());
    // ✗ в примере обязан стоять и в замечаниях листа: расхождение с досье — находка, а не шум
    for (const [path, text] of sheets) {
      if (!text.includes(" ✗")) continue;
      const remarks = text.slice(text.indexOf("## 9."));
      expect(remarks, `${path}: ✗ в примере без замечания`).toContain("Приклад досьє");
    }
  });
});
