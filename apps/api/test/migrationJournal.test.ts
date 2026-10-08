import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { journalEntries, MIGRATIONS_FOLDER } from "../src/db/migrations";

/**
 * Журнал миграций: порядок, неизменность выпущенного, порядок вливаний.
 *
 * Drizzle применяет только миграции новее последней применённой (по `when`).
 * Миграция, вставшая в журнал ПЕРЕД уже существующими, на базе, которая
 * существующие уже получила, пропускается молча — так 0096 обошла базы,
 * мигрированные между вливаниями 0097/0098 и её самой (внешний разбор,
 * 2026-09-28). Сверка после миграций (src/db/migrations.ts) ловит это на
 * выкатке; здесь — раньше, в CI, до того как база вообще встретит такой
 * журнал.
 *
 * Сверка с main — нужна ли? Решение: сверять не с main, а с тем, на чём
 * реально стоят базы.
 *   - Рабочие базы и копии стоят на выпусках: выкатка идёт только по тегу
 *     (deploy.yml). Поэтому выпущенное неизменно — тег, время и текст каждой
 *     миграции последнего выпуска те же, — а всё новое встаёт после него.
 *   - Базы разработки и стендов стоят на любом состоянии main между
 *     выпусками. Поэтому проверяется каждое состояние первородной линии
 *     (--first-parent) от последнего выпуска до HEAD и рабочей копии: каждое
 *     добавляет миграции только после уже существующих. Именно это и
 *     нарушили 0097/0098 → 0096: каждый журнал по отдельности был в
 *     порядке, ломался переход от одного к другому.
 * Сверка с origin/main этого не даёт: на пуше в main она сравнивает main
 * с самим собой, а на пуше из нескольких вливаний видит только сумму. Нужна
 * история — поэтому CI тянет её целиком (fetch-depth: 0 в ci.yml), и
 * обрезанная история здесь — отказ, а не пропуск.
 */

const ROOT = resolve(import.meta.dir, "../../..");
const JOURNAL = "apps/api/drizzle/meta/_journal.json";

interface Entry {
  idx: number;
  tag: string;
  when: number;
}

const current = journalEntries();

describe("журнал в порядке", () => {
  test("номер, время и порядок записей растут вместе; файлы и записи совпадают", () => {
    const problems: string[] = [];
    current.forEach((e, i) => {
      if (Number(e.tag.slice(0, 4)) !== e.idx) problems.push(`${e.tag}: номер в имени не равен idx ${e.idx}`);
      const prev = current[i - 1];
      if (!prev) return;
      if (e.idx <= prev.idx) problems.push(`${e.tag}: idx ${e.idx} не больше, чем у ${prev.tag}`);
      if (e.when <= prev.when) problems.push(`${e.tag}: when ${e.when} не больше, чем у ${prev.tag} (${prev.when})`);
    });
    const tags = new Set(current.map((e) => e.tag));
    if (tags.size !== current.length) problems.push("теги повторяются");
    const files = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith(".sql"));
    for (const f of files) if (!tags.has(f.replace(/\.sql$/, ""))) problems.push(`${f}: файла нет в журнале`);
    expect(problems).toEqual([]);
  });

  test("0112 повторяет каждый оператор 0096 и отмечает её тем хэшем и временем, что записал бы drizzle", () => {
    const entry = current.find((e) => e.tag === "0096_integrity")!;
    const restore = readFileSync(join(MIGRATIONS_FOLDER, "0112_restore_and_followups.sql"), "utf8");
    // хэш drizzle — sha256 текста файла; здесь — от байтов, как посчитал бы psql или человек
    expect(createHash("sha256").update(readFileSync(join(MIGRATIONS_FOLDER, "0096_integrity.sql"))).digest("hex")).toBe(
      entry.hash,
    );
    expect(restore).toContain(`'${entry.hash}', ${entry.when}`);
    expect(restore).toContain(`hash = '${entry.hash}'`);
    expect(restore).toContain(`created_at = ${entry.when}`);

    const statements = (text: string) =>
      text
        .split("--> statement-breakpoint")
        .map((s) =>
          s
            .split("\n")
            .filter((line) => !line.trim().startsWith("--"))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean);
    const repeated = new Set(statements(restore));
    const original = statements(readFileSync(join(MIGRATIONS_FOLDER, "0096_integrity.sql"), "utf8"));
    expect(original.length).toBe(3);
    expect(original.filter((s) => !repeated.has(s))).toEqual([]);
  });
});

/* ─────────── история: выпуски и вливания ─────────── */

function git(args: string[]): { ok: boolean; out: Buffer; err: string } {
  const run = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { ok: run.exitCode === 0, out: Buffer.from(run.stdout), err: Buffer.from(run.stderr).toString() };
}

const inGit = git(["rev-parse", "--is-inside-work-tree"]).ok;

function journalAt(rev: string): Entry[] {
  const shown = git(["show", `${rev}:${JOURNAL}`]);
  if (!shown.ok) throw new Error(`журнала нет в ${rev}: ${shown.err}`);
  return (JSON.parse(shown.out.toString()) as { entries: Entry[] }).entries;
}

/** Хэш файла миграции в ревизии — как у drizzle: sha256 от текста файла */
function hashAt(rev: string, tag: string): string {
  const shown = git(["show", `${rev}:apps/api/drizzle/${tag}.sql`]);
  if (!shown.ok) throw new Error(`файла ${tag}.sql нет в ${rev}: ${shown.err}`);
  return createHash("sha256").update(shown.out.toString()).digest("hex");
}

/**
 * Вливания не по порядку, которые уже в истории и разобраны.
 *
 * Пусто: последний выпуск (v1.15.1) стоит после всех известных случаев, а
 * проверка идёт от него. Если такое вливание всё же уйдёт в опубликованный
 * main (переписать его нельзя), тег миграции вписывается сюда вместе с
 * причиной и миграцией восстановления — до следующего выпуска, после
 * которого запись больше не нужна.
 */
const KNOWN_OUT_OF_ORDER = new Map<string, string>();

/** Что сломано в переходе журнала prev → next для базы, стоящей на prev */
function transitionProblems(prev: Entry[], next: Entry[], where: string): string[] {
  const problems: string[] = [];
  const before = new Map(prev.map((e) => [e.tag, e]));
  const after = new Map(next.map((e) => [e.tag, e]));
  const maxBefore = Math.max(...prev.map((e) => e.when));
  for (const e of next) {
    const was = before.get(e.tag);
    if (was) {
      if (was.when !== e.when) problems.push(`${where}: у ${e.tag} сменилось when ${was.when} → ${e.when}`);
    } else if (e.when <= maxBefore && !KNOWN_OUT_OF_ORDER.has(e.tag)) {
      problems.push(
        `${where}: ${e.tag} (when ${e.when}) встала перед уже существующими (последняя — ${maxBefore}); ` +
          "база, мигрированная до этого, её пропустит. Вливать миграции по порядку номеров или перенумеровать",
      );
    }
  }
  for (const e of prev) if (!after.has(e.tag)) problems.push(`${where}: ${e.tag} исчезла из журнала`);
  return problems;
}

describe.skipIf(!inGit)("история журнала", () => {
  test("история не обрезана и выпуск найден", () => {
    expect(git(["rev-parse", "--is-shallow-repository"]).out.toString().trim(), "CI: fetch-depth: 0 у actions/checkout").toBe(
      "false",
    );
    expect(git(["describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD"]).ok, "нет тега выпуска в истории HEAD").toBe(
      true,
    );
  });

  const release = () => git(["describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD"]).out.toString().trim();

  test("проверка перехода ловит настоящий случай: 0096 влилась после 0097 и 0098", () => {
    /*
     * Каждый из двух журналов по отдельности в порядке — номера и время
     * растут. Сломан переход: база на слиянии w12:lists уже получила 0098 (и 0097), и
     * 0096 со временем меньше их на ней не применится никогда.
     */
    // коммиты — по теме, а не по хэшу: история переписывалась (трейлеры),
    // и хэши тех слияний сменились
    const bySubject = (subject: string) => {
      const out = git(["log", "--format=%h", `--grep=${subject}`, "HEAD"]).out.toString().trim().split("\n").pop();
      if (!out) throw new Error(`в истории нет коммита «${subject}»`);
      return out;
    };
    const lists = bySubject("Слияние участка w12:lists");
    const integrity = bySubject("Слияние участка w12:integrity");
    expect(transitionProblems(journalAt(lists), journalAt(integrity), "w12").join("\n")).toContain(
      "0096_integrity (when 1788473709043) встала перед уже существующими",
    );
  });

  test("выпущенные миграции неизменны, новые встают после выпущенных", () => {
    const tag = release();
    const released = journalAt(tag);
    const problems = transitionProblems(released, current, `${tag} → рабочая копия`);
    const now = new Map(current.map((e) => [e.tag, e]));
    for (const e of released) {
      const here = now.get(e.tag);
      if (here && here.hash !== hashAt(tag, e.tag)) {
        problems.push(`${e.tag}: текст выпущенной в ${tag} миграции изменён — рабочая база помнит прежний`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("каждое состояние первородной линии после выпуска добавляет миграции только после существующих", () => {
    const tag = release();
    const revs = git(["rev-list", "--first-parent", "--reverse", `${tag}..HEAD`, "--", JOURNAL])
      .out.toString()
      .split("\n")
      .filter(Boolean);
    const problems: string[] = [];
    let prev = journalAt(tag);
    let prevName = tag;
    for (const rev of revs) {
      const next = journalAt(rev);
      problems.push(...transitionProblems(prev, next, `${prevName} → ${rev.slice(0, 8)}`));
      prev = next;
      prevName = rev.slice(0, 8);
    }
    problems.push(...transitionProblems(prev, current, `${prevName} → рабочая копия`));
    expect(problems).toEqual([]);
  });
});

/* ─────────── сторож: одна сверка на все входы ─────────── */

test("мигратор drizzle зовёт только src/db/migrations.ts — остальные входы идут через runMigrations", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name !== "node_modules") walk(path);
      } else if (/\.(ts|tsx|js|mjs)$/.test(d.name) && /drizzle-orm\/[\w-]+\/migrator/.test(readFileSync(path, "utf8"))) {
        offenders.push(relative(ROOT, path));
      }
    }
  };
  for (const dir of ["apps/api/src", "apps/api/test", "scripts"]) walk(join(ROOT, dir));
  expect(offenders).toEqual(["apps/api/src/db/migrations.ts"]);
});
