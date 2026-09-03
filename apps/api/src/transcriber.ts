/**
 * Рабочий процесс расшифровки записей приёма.
 *
 *   bun apps/api/src/transcriber.ts
 *
 * Отдельным процессом, а не тиком планировщика внутри API, по двум причинам.
 *
 * Первая — нагрузка. Расшифровка часового приёма на процессоре занимает
 * минуты, иногда десятки минут. Рядом в том же процессе обслуживаются
 * запросы специалистов, и «консоль подтормаживает после обеда» — это
 * ровно то, как выглядит очередь расшифровок изнутри кабинета.
 *
 * Вторая — пропускная способность. В планировщике расшифровка шла раз в
 * час по одной записи: восемь приёмов за день разгребались бы восемь часов,
 * то есть стенограмма первого утреннего приёма приезжала бы к вечеру, а
 * последнего — назавтра. Здесь очередь берётся подряд, пока в ней что-то
 * есть.
 *
 * Ограничение остаётся прежним: по одной записи за раз. Взять пачку значило
 * бы занять все ядра и вернуть первую проблему с другой стороны.
 */
import { env } from "./env";
import { baseDb, client } from "./db";
import { systemContext } from "./db/context";
import { log } from "./lib/log";
import { transcribeNext, transcriptionAvailable } from "./lib/recordings";

/** Пауза, когда очередь пуста. Записи появляются по концу приёма — спешить некуда. */
const IDLE_MS = 30_000;
/** Пауза после отказа: не долбить в сломанное с той же частотой */
const ERROR_MS = 120_000;

if (!transcriptionAvailable()) {
  /*
   * Отказ, а не тихий простой. Молча работающий вхолостую воркер выглядит
   * как «расшифровка включена», очередь при этом растёт, и обнаруживается
   * это через неделю по жалобе «где стенограммы».
   */
  console.error(
    [
      "",
      "Расшифровка не настроена: WHISPER_BIN и WHISPER_MODEL не заданы.",
      "",
      `  WHISPER_BIN   — путь к исполняемому файлу whisper.cpp (сейчас: ${env.whisperBin ?? "—"})`,
      `  WHISPER_MODEL — путь к файлу модели .bin (сейчас: ${env.whisperModel ?? "—"})`,
      "",
      "Записи приёмов при этом продолжают сохраняться зашифрованными:",
      "очередь дождётся расшифровки, ничего не теряется.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

log.info("transcriber started", { model: env.whisperModel?.split("/").pop() ?? "?" });

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info("transcriber shutdown", { signal });
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

while (!stopping) {
  let did = false;
  try {
    did = await systemContext(baseDb, () => transcribeNext());
  } catch (error) {
    log.warn("transcribe failed", { error: String(error) });
    await sleep(ERROR_MS);
    continue;
  }
  // сделали дело — сразу за следующим; пусто — подождём
  if (!did) await sleep(IDLE_MS);
}

await client.end({ timeout: 5 }).catch(() => {});
process.exit(0);
