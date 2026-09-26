/**
 * Хранилище записей приёма — глазами техпанели: сколько, сколько места,
 * что с очередью расшифровки, что упало.
 *
 * Самые чувствительные данные системы (routes/recordings.ts: «разговор
 * человека о себе целиком»), и техпанель смотрит на них только числами.
 * Ни имени, ни приёма, ни пути к файлу: идентификатор строки записи (он же
 * — задание расшифровки), возраст и текст ошибки, из которого вычищены пути
 * и данные. Разработчик с ops.read прав на пациентов не имеет, и экран
 * устроен так, чтобы их и не понадобилось.
 *
 * Что сервер знает о расшифровке. Очередь — это строки visit_recordings в
 * статусе uploaded (ждут) и transcribing (взяты воркером). Сам воркер —
 * отдельный процесс (transcriber.ts), и API не видит, жив ли он: если
 * очередь растёт, а «розшифровується» не меняется, воркер стоит. Строка,
 * которая расшифровывается дольше шести часов, скорее всего осиротела:
 * воркер упал посреди записи (начало расшифровки в базе не хранится —
 * возраст считается от конца приёма, и это сказано на экране).
 */
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { OpsRecordings, RecordingStatus } from "@quizzy/shared";
import { db } from "../db";
import { visitRecordings } from "../db/schema";
import { env } from "../env";
import { diskUsage } from "./opsAlerts";
import { normalizeMessage } from "./opsBuffer";
import { transcriptionAvailable } from "./recordings";

/*
 * «Застрявшая» расшифровка — дольше шести часов от конца приёма (см. выше);
 * порог стоит прямо в запросе литералом interval '6 hours'.
 */
/** Сколько файлов пересчитывается за один запрос: дальше — нижняя граница с пометкой */
const DIR_SCAN_CAP = 20_000;

/**
 * Текст отказа расшифровки для экрана: пути к файлам и временным файлам
 * заменены (в них идентификатор записи и каталог тома), дальше — тот же
 * фильтр, что у ошибок техпанели.
 */
export function cleanFailure(text: string | null): string | null {
  if (!text) return null;
  const noPaths = text.replace(/(?:[A-Za-z]:)?(?:\/|\\)[^\s'"():,]+/g, "[path]");
  return normalizeMessage(noPaths).slice(0, 300);
}

async function scanDir(dir: string): Promise<OpsRecordings["disk"]> {
  const root = resolve(dir);
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    /* каталога нет — записей ещё не было; это ноль, а не «не прочитался» */
    if ((error as { code?: string }).code === "ENOENT") names = [];
    else return null;
  }
  const files = names.filter((n) => n.endsWith(".enc"));
  const truncated = files.length > DIR_SCAN_CAP;
  let bytes = 0;
  for (const name of files.slice(0, DIR_SCAN_CAP)) {
    try {
      bytes += (await stat(join(root, name))).size;
    } catch {
      /* файл стёрли между readdir и stat — удаление записи, обычное дело */
    }
  }
  const disk = await diskUsage(root);
  return {
    files: Math.min(files.length, DIR_SCAN_CAP),
    bytes,
    truncated,
    totalBytes: disk?.totalBytes ?? null,
    freeBytes: disk?.freeBytes ?? null,
  };
}

/** Сводка хранилища. Зовётся системным контекстом: политики строк пускают к записи только двоих */
export async function recordingsReport(): Promise<OpsRecordings> {
  const byStatus = await db
    .select({
      status: visitRecordings.status,
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${visitRecordings.audioBytes}), 0)::bigint`,
    })
    .from(visitRecordings)
    .groupBy(visitRecordings.status);

  const [stored] = await db
    .select({ count: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${visitRecordings.audioBytes}), 0)::bigint` })
    .from(visitRecordings)
    .where(isNotNull(visitRecordings.audioPath));

  const [queue] = await db
    .select({
      waiting: sql<number>`count(*) filter (where ${visitRecordings.status} = 'uploaded')::int`,
      transcribing: sql<number>`count(*) filter (where ${visitRecordings.status} = 'transcribing')::int`,
      oldest: sql<number | null>`extract(epoch from now() - min(coalesce(${visitRecordings.endedAt}, ${visitRecordings.createdAt})) filter (where ${visitRecordings.status} = 'uploaded'))::float8`,
      stuck: sql<number>`count(*) filter (where ${visitRecordings.status} = 'transcribing' and coalesce(${visitRecordings.endedAt}, ${visitRecordings.createdAt}) < now() - interval '6 hours')::int`,
    })
    .from(visitRecordings);

  const failed = await db
    .select({
      id: visitRecordings.id,
      age: sql<number | null>`extract(epoch from now() - coalesce(${visitRecordings.endedAt}, ${visitRecordings.createdAt}))::float8`,
      failure: visitRecordings.failure,
      hasFile: sql<boolean>`${visitRecordings.audioPath} is not null`,
    })
    .from(visitRecordings)
    .where(eq(visitRecordings.status, "failed"))
    .orderBy(sql`coalesce(${visitRecordings.endedAt}, ${visitRecordings.createdAt}) desc`)
    .limit(50);

  return {
    byStatus: byStatus
      .map((r) => ({ status: r.status as RecordingStatus, count: Number(r.count), bytes: Number(r.bytes) }))
      .sort((a, b) => b.count - a.count),
    stored: { count: Number(stored?.count ?? 0), bytes: Number(stored?.bytes ?? 0) },
    disk: await scanDir(env.recordingsDir),
    queue: {
      waiting: Number(queue?.waiting ?? 0),
      transcribing: Number(queue?.transcribing ?? 0),
      oldestWaitingSec: queue?.oldest === null || queue?.oldest === undefined ? null : Math.round(Number(queue.oldest)),
      stuck: Number(queue?.stuck ?? 0),
    },
    failed: failed.map((f) => ({
      id: f.id,
      ageSec: f.age === null ? null : Math.round(Number(f.age)),
      error: cleanFailure(f.failure),
      retryable: Boolean(f.hasFile),
    })),
    transcriberHere: transcriptionAvailable(),
  };
}

/**
 * Повторить упавшую расшифровку: вернуть запись в очередь.
 *
 * Только из «не получилось» и только если файл на месте: запись, которую
 * человек попросил удалить, стёрта вместе с файлом и в очередь не
 * возвращается ни при каком раскладе — условие стоит в самом UPDATE, а не в
 * проверке перед ним (та же гонка, что разобрана в routes/recordings.ts).
 */
export async function retryRecording(id: string): Promise<"ok" | "notFound" | "notRetryable"> {
  const done = await db
    .update(visitRecordings)
    .set({ status: "uploaded", failure: null })
    .where(and(eq(visitRecordings.id, id), eq(visitRecordings.status, "failed"), isNotNull(visitRecordings.audioPath)))
    .returning({ id: visitRecordings.id });
  if (done.length) return "ok";
  const [row] = await db.select({ id: visitRecordings.id }).from(visitRecordings).where(eq(visitRecordings.id, id));
  return row ? "notRetryable" : "notFound";
}
