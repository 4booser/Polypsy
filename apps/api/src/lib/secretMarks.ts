import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { OpsSecretName, OpsSecretStatus } from "@quizzy/shared";
import { db } from "../db";
import { securitySecretMarks } from "../db/schema";
import { env } from "../env";
import { auditSystem } from "./audit";
import { activeKey } from "./crypto";
import { log } from "./log";

/**
 * Состояние секретов для техпанели: задан ли, и когда его меняли.
 *
 * Ни одного значения наружу: экран получает имя, «задан / не задан /
 * стоит значение для разработки» и даты. Даже отпечаток, по которому
 * замечается смена, остаётся в базе (почему его хранение не утечка — в
 * миграции 0092).
 */

export const SECRET_NAMES: readonly OpsSecretName[] = [
  "ENCRYPTION_KEY",
  "JWT_SECRET",
  "PHONE_INDEX_SECRET",
  "EXPORT_SECRET",
  "METRICS_TOKEN",
];

/*
 * Значения по умолчанию из env.ts. В production процесс с ними не
 * поднимается, а вне его они законны — но экран обязан назвать их прямо:
 * «задан» про dev-секрет было бы неправдой, которая доживает до стенда.
 */
const DEV_DEFAULTS: Partial<Record<OpsSecretName, string>> = {
  JWT_SECRET: "dev-secret-change-me",
  PHONE_INDEX_SECRET: "dev-phone-index-secret-change-me",
  EXPORT_SECRET: "dev-export-secret-change-me",
};

function currentValue(name: OpsSecretName): string | null {
  switch (name) {
    case "ENCRYPTION_KEY": {
      const key = activeKey();
      return key ? `${key.id}:${key.key.toString("base64")}` : null;
    }
    case "JWT_SECRET":
      return env.jwtSecret || null;
    case "PHONE_INDEX_SECRET":
      return env.phoneIndexSecret || null;
    case "EXPORT_SECRET":
      return env.exportSecret || null;
    case "METRICS_TOKEN":
      // читается там же, где и в routes/metrics.ts: из окружения на лету
      return process.env.METRICS_TOKEN || null;
  }
}

/**
 * Отпечаток значения: 32 бита HMAC с самим значением в роли ключа.
 *
 * Для ключа шифрования в отпечаток входит и его идентификатор — открытым
 * текстом, он не секрет, — чтобы смена основного ключа читалась в журнале
 * как смена, даже если кто-то вернул прежний ключ под новым именем.
 */
function fingerprint(name: OpsSecretName): string | null {
  const value = currentValue(name);
  if (value === null) return null;
  const mark = createHmac("sha256", value).update("quizzy:secret-mark").digest("hex").slice(0, 8);
  return name === "ENCRYPTION_KEY" ? `${activeKey()!.id}:${mark}` : mark;
}

/**
 * Сверить текущие значения с запомненными и отметить смену.
 *
 * Зовётся планировщиком каждый тик (раз в час и сразу при старте) и
 * экраном раздела — то есть смена замечается при первом запуске с новым
 * значением, а не когда кто-то откроет панель. Смена — строка журнала от
 * системы: «когда поменяли секрет» — вопрос, который задают после
 * инцидента, и ответ должен лежать там же, где остальные ответы.
 *
 * Две реплики, стартовавшие разом, не задвоят запись: вставка — «если
 * нет», правка — «если отличается», и журнал пишет только тот, чья правка
 * прошла.
 */
export async function observeSecrets(now = new Date()): Promise<void> {
  const at = now.toISOString();
  for (const name of SECRET_NAMES) {
    const fp = fingerprint(name);
    const inserted = await db
      .insert(securitySecretMarks)
      .values({ name, fingerprint: fp, seenSince: at, trackedSince: at, checkedAt: at })
      .onConflictDoNothing()
      .returning({ name: securitySecretMarks.name });
    if (inserted.length) continue;

    const changed = await db
      .update(securitySecretMarks)
      .set({ fingerprint: fp, seenSince: at, checkedAt: at })
      .where(
        and(
          eq(securitySecretMarks.name, name),
          sql`${securitySecretMarks.fingerprint} is distinct from ${fp}`,
        ),
      )
      .returning({ name: securitySecretMarks.name });
    if (!changed.length) continue;

    log.warn("sec.secret_changed", { name, set: fp !== null });
    await auditSystem({
      action: "sec.secret_changed",
      resourceType: "secret",
      resourceId: name,
      details: { name, set: fp !== null },
    });
  }
}

/** Состояние секретов для экрана: без значений и без отпечатков */
export async function secretStatuses(): Promise<OpsSecretStatus[]> {
  const marks = new Map((await db.select().from(securitySecretMarks)).map((m) => [m.name, m]));
  return SECRET_NAMES.map((name) => {
    const value = currentValue(name);
    const mark = marks.get(name);
    return {
      name,
      state: value === null ? "unset" : DEV_DEFAULTS[name] === value ? "default" : "set",
      seenSince: mark?.seenSince ?? null,
      trackedSince: mark?.trackedSince ?? null,
    };
  });
}
