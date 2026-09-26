import { isNotNull, sql } from "drizzle-orm";
import type { OpsKeyColumn, OpsKeyVersion, OpsRecordingFiles } from "@quizzy/shared";
import { db } from "../db";
import { visitRecordings } from "../db/schema";
import { activeKey, loadedKeyIds, tryDecryptField } from "./crypto";
import { recordingKeyId } from "./recordings";

/**
 * Опись шифрованных данных по версиям ключа — основа раздела «Ключі й
 * секрети» и перешифровки.
 *
 * Вопрос, на который она отвечает: какими ключами зашифровано то, что сейчас
 * лежит в базе и на диске. Без ответа ротация ключа — это «убрать старый и
 * надеяться»: RUNBOOK говорит «когда enc1:v-старый: в базе не останется», но
 * посмотреть это до сих пор можно было только руками в psql, по одной
 * колонке, зная их список наизусть.
 */

/** Колонка, в которой лежат значения `enc1:<ключ>:…` */
export interface EncryptedColumn {
  table: string;
  column: string;
  /** Одностолбцовый первичный ключ; без него колонку не перешифровать порциями */
  pk: string | null;
}

/*
 * Колонки старых имён — наследие первой половины проекта: их начали
 * шифровать, не переименовывая. Всё, что заведено позже, называется *_enc и
 * находится по имени само.
 *
 * Список ведётся руками, и это его слабое место: новая шифрованная колонка
 * со «старым» именем в опись не попадёт. Поэтому правило имени сторожит
 * тест (opsSec.test.ts): после посева во всей базе не должно найтись
 * значения `enc1:` вне описи.
 */
const LEGACY = [
  "users.first_name",
  "users.last_name",
  "users.middle_name",
  "users.birth_date",
  "answers.text",
  "conclusions.text",
  "patient_notes.text",
  "safety_plans.content",
];

/*
 * Имена таблиц и колонок подставляются в текст запроса, а не параметрами —
 * иначе нельзя. Приходят они из каталога базы, но проверяются всё равно:
 * подстановка без проверки — это та строка, которую через год скопируют
 * туда, где имя придёт снаружи.
 */
const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`недопустимое имя в описи шифрования: ${name}`);
  return `"${name}"`;
}

/** Все шифрованные колонки базы: старые имена поимённо, новые — по *_enc */
export async function encryptedColumns(): Promise<EncryptedColumn[]> {
  const rows = await db.execute<{ table: string; column: string; pk: string | null }>(sql`
    select c.relname::text as table,
           a.attname::text as column,
           (select pa.attname::text
              from pg_index i
              join pg_attribute pa on pa.attrelid = i.indrelid and pa.attnum = i.indkey[0]
             where i.indrelid = c.oid and i.indisprimary and i.indnatts = 1) as pk
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid
     where c.relnamespace = 'public'::regnamespace
       and c.relkind = 'r'
       and a.attnum > 0 and not a.attisdropped
       and a.atttypid in ('text'::regtype, 'varchar'::regtype)
       and (a.attname like '%\_enc' or (c.relname::text || '.' || a.attname::text) in ${LEGACY})
     order by 1, 2
  `);
  return [...rows].map((r) => ({ table: String(r.table), column: String(r.column), pk: r.pk ? String(r.pk) : null }));
}

interface Tally {
  table: string;
  column: string;
  byKey: Map<string, number>;
  plain: number;
  /** По одному значению на ключ — для пробного расшифрования, наружу не уходит */
  samples: Map<string, string>;
}

/**
 * Подсчёт по версиям ключа: один проход по каждой таблице, а не по каждой
 * колонке. У users шифрованных колонок пять, и пять проходов по самой
 * «широкой» таблице ради одного экрана — лишнее.
 *
 * Версия берётся из заголовка значения (`enc1:<ключ>:`), а не пробой
 * расшифровать: сосчитать надо в том числе то, что расшифровать уже нечем.
 * Образец на версию — min(v): он достаётся тем же проходом и нужен, чтобы
 * проверить, открывает ли загруженный ключ свои значения.
 */
async function tallyColumns(columns: EncryptedColumn[]): Promise<Tally[]> {
  const byTable = new Map<string, EncryptedColumn[]>();
  for (const c of columns) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c]);

  const out: Tally[] = [];
  for (const [table, cols] of byTable) {
    const values = cols.map((c) => `('${c.column}', t.${ident(c.column)})`).join(", ");
    const rows = await db.execute<{ col: string; k: string; n: number; sample: string | null }>(
      sql.raw(`
        select x.col,
               case when x.v like 'enc1:%' then split_part(x.v, ':', 2) else '' end as k,
               count(*)::int as n,
               min(x.v) filter (where x.v like 'enc1:%') as sample
          from ${ident(table)} t
          cross join lateral (values ${values}) as x(col, v)
         where x.v is not null and x.v <> ''
         group by 1, 2
      `),
    );
    for (const c of cols) {
      const tally: Tally = { table, column: c.column, byKey: new Map(), plain: 0, samples: new Map() };
      for (const r of rows) {
        if (r.col !== c.column) continue;
        if (r.k === "") tally.plain += Number(r.n);
        else {
          tally.byKey.set(r.k, Number(r.n));
          if (r.sample) tally.samples.set(r.k, r.sample);
        }
      }
      out.push(tally);
    }
  }
  return out;
}

/**
 * Файлы записей приёма по ключам: читается только заголовок файла.
 *
 * Файлы — отдельная статья, потому что их не видно в базе: строка
 * visit_recordings хранит путь, а ключ записан в самом файле. Ротация,
 * посчитавшая только колонки, объявила бы «на старом ключе ноль» и
 * оставила записи приёмов без ключа.
 */
export async function recordingFiles(): Promise<OpsRecordingFiles & { paths: string[] }> {
  const rows = await db
    .select({ path: visitRecordings.audioPath })
    .from(visitRecordings)
    .where(isNotNull(visitRecordings.audioPath));

  const byKey: Record<string, number> = {};
  let legacy = 0;
  let missing = 0;
  const paths: string[] = [];
  for (const { path } of rows) {
    if (!path) continue;
    let head: Buffer;
    try {
      const file = Bun.file(path);
      head = Buffer.from(await file.slice(0, 80).arrayBuffer());
      if (!head.length && !(await file.exists())) throw new Error("нет файла");
    } catch {
      missing++;
      continue;
    }
    paths.push(path);
    const { keyId } = recordingKeyId(head);
    if (keyId === null) legacy++;
    else byKey[keyId] = (byKey[keyId] ?? 0) + 1;
  }
  return { byKey, legacy, missing, paths };
}

export interface KeyInventory {
  encryption: boolean;
  activeKey: string | null;
  loadedKeys: string[];
  keys: OpsKeyVersion[];
  columns: OpsKeyColumn[];
  files: OpsRecordingFiles;
  plainTotal: number;
  lostTotal: number;
  staleTotal: number;
}

/**
 * Опись целиком: колонки, файлы, версии ключа и их состояние.
 *
 * Идёт системным контекстом (вызывающий оборачивает в asSystem): запись
 * приёма видна по политике только двоим участникам, и суперадмин её строк
 * не видит — опись, посчитанная от его имени, недосчитала бы именно самое
 * чувствительное.
 */
export async function keyInventory(): Promise<KeyInventory> {
  const active = activeKey()?.id ?? null;
  const loaded = loadedKeyIds();
  const columns = await encryptedColumns();
  const tallies = await tallyColumns(columns);
  const files = await recordingFiles();

  const seen = new Set<string>(loaded);
  for (const t of tallies) for (const k of t.byKey.keys()) seen.add(k);
  for (const k of Object.keys(files.byKey)) seen.add(k);

  const keys: OpsKeyVersion[] = [...seen].map((id) => {
    const values = tallies.reduce((s, t) => s + (t.byKey.get(id) ?? 0), 0);
    /*
     * «Открывает ли ключ свои значения» — по одному образцу на колонку.
     * Ловит самую тихую поломку: ключ с тем же именем, но другим
     * содержимым (переписали v1 при переносе окружения). Счётчики при этом
     * выглядят безупречно, а прочитать нельзя ничего.
     */
    let opens: boolean | null = null;
    if (loaded.includes(id)) {
      for (const t of tallies) {
        const sample = t.samples.get(id);
        if (!sample) continue;
        const ok = tryDecryptField(sample).ok;
        opens = (opens ?? true) && ok;
      }
    }
    return {
      id,
      active: id === active,
      loaded: loaded.includes(id),
      values,
      files: files.byKey[id] ?? 0,
      opens,
    };
  });
  // порядок: как в окружении (основной первым), затем версии, которых там нет
  keys.sort((a, b) => {
    const ia = loaded.indexOf(a.id);
    const ib = loaded.indexOf(b.id);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.id.localeCompare(b.id);
  });

  const plainTotal = tallies.reduce((s, t) => s + t.plain, 0);
  const lostTotal = keys.filter((k) => !k.loaded).reduce((s, k) => s + k.values + k.files, 0);
  const staleTotal =
    keys.filter((k) => k.loaded && !k.active).reduce((s, k) => s + k.values + k.files, 0) +
    (active ? plainTotal + files.legacy : 0);

  return {
    encryption: active !== null,
    activeKey: active,
    loadedKeys: loaded,
    keys,
    columns: tallies.map((t) => ({
      table: t.table,
      column: t.column,
      byKey: Object.fromEntries(t.byKey),
      plain: t.plain,
      rewrappable: columns.find((c) => c.table === t.table && c.column === t.column)?.pk != null,
    })),
    files: { byKey: files.byKey, legacy: files.legacy, missing: files.missing },
    plainTotal,
    lostTotal,
    staleTotal,
  };
}
