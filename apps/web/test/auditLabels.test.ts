import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { UI, uiText } from "@quizzy/shared";
import { AUDIT_ACTION_KEY, JOB_KEY, actionLabel } from "../src/pages/ops/model";

/**
 * Каждое действие журнала названо словами.
 *
 * Журнал техпанели показывает действие подписью из AUDIT_ACTION_KEY, а
 * незнакомое — кодом. Карту пополняли руками, и она отстала от перечня
 * сервера на полторы сотни действий: всё, что добавили поликлиника, записи
 * приёма, статистика, рассылки и сама техпанель, читалось в журнале как
 * «clinic.phone_view» и «stat_model.run».
 *
 * Перечень берётся из самого сервера — из типа AuditAction в
 * apps/api/src/lib/audit.ts, — а не переписывается сюда: список, набранный
 * второй раз, отстал бы точно так же. Новое действие без подписи роняет
 * проверку с его именем.
 */

const ROOT = resolve(import.meta.dir, "../../..");

/** Коды действий из `export type AuditAction = | "…" | "…";` — без комментариев, где тоже бывают кавычки */
function serverActions(): string[] {
  const src = readFileSync(join(ROOT, "apps/api/src/lib/audit.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const start = src.indexOf("export type AuditAction =");
  const end = src.indexOf(";", start);
  expect(start, "тип AuditAction не найден — проверка смотрит не туда").toBeGreaterThan(0);
  return [...src.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("подписи действий журнала", () => {
  const actions = serverActions();

  test("перечень сервера прочитан целиком", () => {
    // около двух сотен действий; заметно меньше — значит, разбор споткнулся о новую запись
    expect(actions.length).toBeGreaterThan(200);
    expect(actions).toContain("auth.login");
    expect(actions).toContain("access.denied");
  });

  test("у каждого действия сервера есть подпись", () => {
    const missing = actions.filter((a) => !AUDIT_ACTION_KEY[a]);
    expect(missing, "журнал покажет эти действия кодом").toEqual([]);
  });

  test("подпись есть в словаре на трёх языках и не повторяет код", () => {
    const bad: string[] = [];
    for (const action of actions) {
      const key = AUDIT_ACTION_KEY[action];
      if (!key || !UI[key]) {
        bad.push(`${action}: нет ключа ${key}`);
        continue;
      }
      for (const lang of ["uk", "ru", "en"] as const) {
        const text = uiText(key, lang);
        if (!text.trim() || text === key || text === action) bad.push(`${action} ${lang}: «${text}»`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("журнал показывает слова, а не код", () => {
    const ut = (key: Parameters<typeof uiText>[0]) => uiText(key, "uk");
    expect(actionLabel("clinic.phone_view", ut)).toBe("Перегляд телефону");
    expect(actionLabel("consent.decline", ut)).toBe("Відмова від згоди");
    // незнакомое — по-прежнему кодом: лучше код, чем пустая ячейка
    expect(actionLabel("future.action", ut)).toBe("future.action");
  });
});

test("фонова задача продления сетки названа словами", () => {
  const key = JOB_KEY["slots.horizon"];
  expect(key).toBeDefined();
  for (const lang of ["uk", "ru", "en"] as const) expect(uiText(key!, lang)).not.toBe(key);
});
