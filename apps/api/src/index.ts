import { env } from "./env";
import { app } from "./app";
import { startScheduler } from "./lib/scheduler";
import { startNotifier } from "./lib/notify";
import { client } from "./db";

// расписания меряются днями, поэтому часового тика достаточно; первый проход
// идёт сразу при старте, чтобы простой сервера не сдвигал выдачу заданий.
// Флаг выключает тик на репликах, где он не нужен.
const stopScheduler = env.schedulerEnabled ? startScheduler() : null;
// рассыльщик тревог живёт на той же реплике, что и планировщик
const stopNotifier = env.schedulerEnabled ? startNotifier() : null;

/**
 * Аккуратная остановка: сначала гасим планировщик (чтобы не начать выдачу
 * заданий посреди выключения), затем закрываем пул — Postgres получает
 * нормальное завершение сессий вместо обрыва.
 */
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Получен ${signal}, останавливаюсь`);
  stopScheduler?.();
  stopNotifier?.();
  await client.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export default {
  port: env.port,
  fetch: app.fetch,
};
