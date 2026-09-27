import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSurveySchema, type CreateSurveyDraft, type CreateSurveyInput, type SurveyFull } from "@quizzy/shared";
import { db } from "../db";
import { surveys } from "../db/schema";
import { surveyFields } from "../lib/catalogInstall";
import { createVersion, getSurvey } from "../lib/surveys";
import { CATALOG } from "../instruments/catalog";
import { minimult } from "../instruments/minimult";
import { mlo } from "../instruments/mlo";
import { sadPersons } from "../instruments/sadPersons";
import { sr45 } from "../instruments/sr45";
import { buildExamples } from "./examples";
import { checkInstrument } from "./checks";
import { SHEET_LANGS } from "./format";
import { NOTES } from "./notes";
import { renderReadme, renderRules } from "./readme";
import { REVIEW_BEGIN, REVIEW_END, renderSheet } from "./render";

/**
 * Листы сверки методик для клинического психолога (волна 14).
 *
 * Методики никто клинически не подтверждал, и психолог заказчика должен
 * проверить каждую, не читая код. Лист методики (docs/instruments/<язык>/
 * <код>.md) описывает ровно то, что считает система: он собран не из
 * исходника методики, а из того, что получилось после установки — черновик
 * проходит ту же схему (createSurveySchema), ту же запись версии в базу
 * (createVersion) и то же чтение версии, что при прохождении (getSurvey).
 * Ключ, который createVersion молча отбросил (номер пункта за пределами
 * бланка, повтор), в лист не попадёт — как не попадёт он и в подсчёт.
 *
 * Примеры «ответы → результат» считает живой движок (examples.ts), а тест
 * apps/api/test/instrumentSheets.test.ts пересобирает листы и падает, если
 * лист в репозитории разошёлся с тем, что считает система: лист не устаревает
 * молча. Перегенерация — `bun run --cwd apps/api docs:instruments` (нужна
 * база, как любому тесту с базой: генератор ставит методики по-настоящему).
 *
 * Отвергнуто: собирать лист из черновика методики напрямую, без базы, — тогда
 * он описывал бы то, что написано в файле, а не то, что стоит в системе, и
 * расхождение между ними (ровно то, что ищет сверка) было бы невидимо.
 */

export const SHEETS_DIR = "docs/instruments";

/** Методика, для которой строится лист */
export interface SheetEntry {
  /** Устойчивое имя: ключ каталога или имя встроенной методики — оно же имя файла листа */
  key: string;
  /** Файл определения в apps/api/src/instruments */
  module: string;
  draft: CreateSurveyDraft;
  /** Ставится установщиком каталога (иначе — только демонстрационным посевом) */
  catalog: boolean;
  /** Источник, как его записывает журнал установки; у встроенных его в системе нет */
  source: string | null;
  notScored: { items: number[]; reason: string } | null;
}

/**
 * Файл определения по ключу каталога. Явным списком: имя файла и ключ
 * расходятся (audit → audit10.ts, big-five → bigFive.ts), а угадывать путь,
 * который печатается в лист как «где смотреть», нельзя.
 */
const MODULE_OF: Record<string, string> = {
  who5: "who5.ts",
  gad7: "gad7.ts",
  phq9: "phq9.ts",
  pss10: "pss10.ts",
  pcl5: "pcl5.ts",
  audit: "audit10.ts",
  pq16: "pq16.ts",
  "big-five": "bigFive.ts",
  phq4: "phq4.ts",
  phq8: "phq8.ts",
  cesdr: "cesdr.ts",
  srq20: "srq20.ts",
  gds15: "gds15.ts",
  dass42: "dass42.ts",
  pcptsd5: "pcptsd5.ts",
  ces: "ces.ts",
  sbqr: "sbqr.ts",
  mspss: "mspss.ts",
  osss3: "osss3.ts",
  rses: "rses.ts",
  ucla3: "ucla3.ts",
  brief_cope: "briefCope.ts",
  cage: "cage.ts",
  auditc: "auditc.ts",
  assist: "assist.ts",
  asrs6: "asrs6.ts",
  cbi: "cbi.ts",
};

/**
 * Все методики: четыре встроенные (их ставит только демонстрационный посев
 * seed.ts) и весь каталог. Методика каталога без строки в MODULE_OF роняет
 * сборку — новая методика не должна остаться без листа молча.
 */
export function sheetEntries(): SheetEntry[] {
  const builtin: SheetEntry[] = [
    { key: "sr45", module: "sr45.ts", draft: sr45, catalog: false, source: null, notScored: null },
    { key: "sad-persons", module: "sadPersons.ts", draft: sadPersons, catalog: false, source: null, notScored: null },
    { key: "minimult", module: "minimult.ts", draft: minimult, catalog: false, source: null, notScored: null },
    { key: "mlo", module: "mlo.ts", draft: mlo, catalog: false, source: null, notScored: null },
  ];
  const catalog = CATALOG.map((e): SheetEntry => {
    const module = MODULE_OF[e.key];
    if (!module) throw new Error(`instrumentSheets: для методики каталога «${e.key}» не указан файл определения (MODULE_OF)`);
    if (!NOTES[e.key]) throw new Error(`instrumentSheets: для методики каталога «${e.key}» нет записи в notes.ts`);
    return { key: e.key, module, draft: e.draft, catalog: true, source: e.source, notScored: e.notScored ?? null };
  });
  return [...builtin, ...catalog];
}

export interface InstalledInstrument {
  entry: SheetEntry;
  input: CreateSurveyInput;
  uk: SurveyFull;
  ru: SurveyFull;
}

/**
 * Поставить методики так, как их ставит система, и прочитать обратно.
 *
 * Строка методики — теми же полями, что пишет установщик каталога
 * (surveyFields); название подменено меткой, чтобы копии для листов не
 * путались с настоящими методиками в той же базе (лист берёт название из
 * определения). Статус — черновик: копии не видны ни пациенту, ни каталогу.
 */
export async function installForSheets(createdBy: string, groupId: string): Promise<InstalledInstrument[]> {
  const tag = crypto.randomUUID().slice(0, 8);
  const out: InstalledInstrument[] = [];
  for (const entry of sheetEntries()) {
    const input = createSurveySchema.parse(entry.draft);
    const id = crypto.randomUUID();
    await db.insert(surveys).values({
      id,
      groupId,
      ...surveyFields(input),
      title: { uk: `Лист звірки ${entry.key} ${tag}` },
      status: "draft",
      createdBy,
    } as never);
    await createVersion(id, input, createdBy, "лист звірки");
    const [uk, ru] = await Promise.all([getSurvey(id, null, "uk"), getSurvey(id, null, "ru")]);
    out.push({ entry, input, uk: uk!, ru: ru! });
  }
  return out;
}

/* ─────────────────────────── что генератор читает с диска ─────────────────────────── */

export interface DossierCard {
  key: string;
  file: string;
  citation?: string;
  verdict?: string;
  bands?: unknown;
  bands_source?: string;
  bands_note?: string;
  reverse?: unknown;
  risk_items?: unknown;
  items?: unknown;
  license?: { verdict?: string; conditions?: string | null };
}

export interface SheetContext {
  /** Уже лежащие листы: из них переносится блок «Перевірка психологом» */
  existing: Map<string, string>;
  /** Эталонные тесты: файл → «золотые протоколы», названные в нём */
  golden: Map<string, string[]>;
  dossiers: Map<string, DossierCard>;
}

/** Прочитать всё, что нужно генератору, из корня репозитория */
export function readSheetContext(root: string): SheetContext {
  const existing = new Map<string, string>();
  for (const lang of SHEET_LANGS) {
    const dir = join(root, SHEETS_DIR, lang);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".md")) existing.set(`${SHEETS_DIR}/${lang}/${name}`, readFileSync(join(dir, name), "utf8"));
    }
  }
  for (const name of ["README.md", "README.ru.md"]) {
    const path = join(root, SHEETS_DIR, name);
    if (existsSync(path)) existing.set(`${SHEETS_DIR}/${name}`, readFileSync(path, "utf8"));
  }

  const golden = new Map<string, string[]>();
  const testsDir = join(root, "apps/api/src/instruments/__tests__");
  for (const name of readdirSync(testsDir).sort()) {
    if (!/^golden.*\.test\.ts$/.test(name)) continue;
    const text = readFileSync(join(testsDir, name), "utf8");
    const names = [...text.matchAll(/describe\("золотой протокол: ([^"]+)"/g)].map((m) => m[1]!);
    golden.set(name, names);
  }

  const dossiers = new Map<string, DossierCard>();
  const dossierDir = join(root, SHEETS_DIR, "dossiers");
  for (const name of readdirSync(dossierDir).sort()) {
    if (!name.endsWith(".json")) continue;
    const cards = JSON.parse(readFileSync(join(dossierDir, name), "utf8")) as DossierCard[];
    for (const card of cards) dossiers.set(card.key, { ...card, file: `${SHEETS_DIR}/dossiers/${name}` });
  }
  return { existing, golden, dossiers };
}

/** Блок «Перевірка психологом» из уже лежащего листа — генератор его не перезаписывает */
export function reviewBlockOf(text: string | undefined): string | null {
  if (!text) return null;
  const start = text.indexOf(REVIEW_BEGIN);
  const end = text.indexOf(REVIEW_END);
  if (start < 0 || end < start) return null;
  return text.slice(start, end + REVIEW_END.length);
}

/** Где эталонный тест методики: файл и имя «золотого протокола» */
export function goldenOf(key: string, ctx: SheetContext): { file: string; name: string } | null {
  const name = NOTES[key]?.golden;
  if (!name) return null;
  for (const [file, names] of ctx.golden) if (names.includes(name)) return { file, name };
  return null;
}

/**
 * Все файлы пакета сверки: путь от корня репозитория → содержимое.
 *
 * Чистая функция от установленных методик и прочитанного с диска: её зовёт и
 * запись (docs:instruments), и тест расхождения — одно и то же, иначе тест
 * проверял бы не то, что пишется.
 */
export function buildSheetFiles(installed: InstalledInstrument[], ctx: SheetContext): Map<string, string> {
  const files = new Map<string, string>();
  const built = installed.map((inst) => {
    const notes = NOTES[inst.entry.key] ?? { differences: [], verify: [], remarks: [] };
    const examples = buildExamples({ uk: inst.uk, ru: inst.ru }, notes.dossier ?? []);
    const dossier = ctx.dossiers.get(inst.entry.key) ?? null;
    const findings = checkInstrument(inst, examples, dossier, notes);
    return { inst, notes, examples, dossier, findings };
  });

  for (const b of built) {
    for (const lang of SHEET_LANGS) {
      const path = `${SHEETS_DIR}/${lang}/${b.inst.entry.key}.md`;
      files.set(
        path,
        renderSheet(lang, {
          ...b,
          golden: goldenOf(b.inst.entry.key, ctx),
          review: reviewBlockOf(ctx.existing.get(path)),
        }),
      );
    }
  }
  for (const lang of SHEET_LANGS) {
    files.set(`${SHEETS_DIR}/${lang}/scoring-rules.md`, renderRules(lang));
  }
  const reviews = new Map(
    built.map((b) => [b.inst.entry.key, reviewBlockOf(files.get(`${SHEETS_DIR}/uk/${b.inst.entry.key}.md`))]),
  );
  files.set(`${SHEETS_DIR}/README.md`, renderReadme("uk", built, ctx, reviews));
  files.set(`${SHEETS_DIR}/README.ru.md`, renderReadme("ru", built, ctx, reviews));
  return files;
}

export type BuiltInstrument = {
  inst: InstalledInstrument;
  notes: (typeof NOTES)[string];
  examples: ReturnType<typeof buildExamples>;
  dossier: DossierCard | null;
  findings: ReturnType<typeof checkInstrument>;
};
