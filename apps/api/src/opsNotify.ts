/**
 * Оповещение с хоста в каналы техпанели (#159).
 *
 *   bun apps/api/src/opsNotify.ts "<тема>" ["<текст>"]
 *
 * Зовёт его scripts/ops-alert.sh — через `docker compose exec -T api`, — когда
 * отказывает то, чего приложение само не видит: ночная копия базы, проверка
 * её восстановимости, внешняя копия. Каналы те же, что у правил техпанели
 * (Telegram и почта, lib/opsAlerts.ts, deliver), и настраиваются там же —
 * в .env.docker; второй список адресатов на хосте разошёлся бы с первым.
 *
 * Текст приходит готовым от скрипта; тема получает имя экземпляра, как у
 * остальных оповещений. В выводе — только итог по каналам, без адресов.
 *
 * Код выхода: 0 — хотя бы один канал принял; 1 — ни один (не настроены или
 * отказали): тогда скрипт пробует Telegram с хоста; 2 — нечего слать.
 */
import { client } from "./db";
import { deliver, instanceLabel } from "./lib/opsAlerts";

const [subject = "", text = ""] = process.argv.slice(2);
if (!subject.trim()) {
  console.error("usage: bun apps/api/src/opsNotify.ts <subject> [text]");
  process.exit(2);
}

const deliveries = await deliver(["telegram", "email"], `[${instanceLabel()}] ${subject.trim()}`, text.trim());
for (const d of deliveries) console.log(`${d.channel}: ${d.outcome}${d.error ? ` (${d.error})` : ""}`);
await client.end();
process.exit(deliveries.some((d) => d.outcome === "sent") ? 0 : 1);
