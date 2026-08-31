import { env } from "./env";
import { app } from "./app";
import { startScheduler } from "./lib/scheduler";
import { startNotifier } from "./lib/notify";
import { startRetention } from "./lib/retention";
import { client } from "./db";
import { log } from "./lib/log";
import { syncBuiltinRole } from "./lib/permissions";

// расписания меряются днями, поэтому часового тика достаточно; первый проход
// идёт сразу при старте, чтобы простой сервера не сдвигал выдачу заданий.
// Флаг выключает тик на репликах, где он не нужен.
/*
 * Набор прав встроенной роли приводится к справочнику при старте.
 *
 * Миграция заводит саму роль, но не перечисляет её права: список живёт в
 * коде, и дублировать его в SQL значило бы завести второй источник истины,
 * который разъедется незаметно. Отказ здесь не должен ронять запуск — без
 * синхронизации система работает по старым проверкам, а вот не поднявшийся
 * сервер не работает вовсе.
 */
/*
 * Ждём завершения, а не отпускаем в фон.
 *
 * Первая редакция запускала сверку без ожидания — и первые запросы успевали
 * прийти раньше, чем роли розданы. Администратор получал отказ на маршрутах,
 * переведённых на права, экран оставался со скелетами, и выглядело это как
 * «сервер тормозит», а не как «прав ещё нет». Окно маленькое, но приходится
 * ровно на перезапуск, то есть на момент, когда все и заходят.
 *
 * Отказ по-прежнему не роняет запуск: без сверки система работает по старым
 * проверкам, а не поднявшийся сервер не работает вовсе.
 */
await syncBuiltinRole().catch((error) =>
  log.error("builtin role sync failed", { error: String(error) }),
);

const stopScheduler = env.schedulerEnabled ? startScheduler() : null;
// рассыльщик тревог живёт на той же реплике, что и планировщик
const stopNotifier = env.schedulerEnabled ? startNotifier() : null;
const stopRetention = env.schedulerEnabled ? startRetention() : null;

/**
 * Аккуратная остановка: сначала гасим планировщик (чтобы не начать выдачу
 * заданий посреди выключения), затем закрываем пул — Postgres получает
 * нормальное завершение сессий вместо обрыва.
 */
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown", { signal });
  stopScheduler?.();
  stopNotifier?.();
  stopRetention?.();
  await client.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export default {
  port: env.port,
  fetch: app.fetch,
};
