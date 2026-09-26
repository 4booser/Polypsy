import { describe, expect, test } from "bun:test";
import { UI, type OpsKeysReport, type OpsKeyVersion, type OpsReencryptJob, type OpsSqlRefusal } from "@quizzy/shared";
import {
  busyOldKeys,
  envLine,
  fill,
  jobShare,
  looksMultiple,
  nextKeyId,
  pushHistory,
  REFUSAL_TEXT,
  removableKeys,
  rotationSteps,
  secretAge,
  toCsv,
  type HistoryEntry,
} from "../src/pages/ops/sec/model";
import { OPS_GROUPS } from "../src/pages/ops/sections";

/**
 * Логика разделов безопасности техпанели. Главное — мастер ротации: он
 * решает, какой шаг текущий и можно ли убрать старый ключ, и ошибка здесь
 * советует удалить ключ, на котором ещё лежат данные.
 */

const key = (id: string, over: Partial<OpsKeyVersion> = {}): OpsKeyVersion => ({
  id,
  active: false,
  loaded: true,
  values: 0,
  files: 0,
  opens: true,
  ...over,
});

function report(over: Partial<OpsKeysReport> = {}): OpsKeysReport {
  return {
    encryption: true,
    activeKey: "v1",
    loadedKeys: ["v1"],
    keys: [key("v1", { active: true, values: 120 })],
    columns: [],
    files: { byKey: {}, legacy: 0, missing: 0 },
    plainTotal: 0,
    lostTotal: 0,
    staleTotal: 0,
    job: null,
    secrets: [],
    countedAt: "2026-09-26T10:00:00.000Z",
    ...over,
  };
}

const states = (r: OpsKeysReport) => Object.fromEntries(rotationSteps(r).map((s) => [s.key, s.state]));

describe("мастер ротации", () => {
  test("один ключ и всё на нём — ротация не идёт, первый шаг текущий", () => {
    expect(states(report())).toEqual({ add: "current", restart: "todo", reencrypt: "todo", verify: "todo" });
  });

  test("новый ключ основным, старое не перешифровано — текущий шаг «Перешифрувати»", () => {
    const r = report({
      activeKey: "v2",
      loadedKeys: ["v2", "v1"],
      keys: [key("v2", { active: true, values: 3 }), key("v1", { values: 117, files: 2 })],
      staleTotal: 119,
    });
    expect(states(r)).toEqual({ add: "done", restart: "done", reencrypt: "current", verify: "todo" });
    expect(removableKeys(r)).toEqual([]);
    expect(busyOldKeys(r)).toEqual(["v1"]);
  });

  test("всё перешифровано — старый можно убрать, и строка окружения без него", () => {
    const r = report({
      activeKey: "v2",
      loadedKeys: ["v2", "v1"],
      keys: [key("v2", { active: true, values: 120 }), key("v1")],
    });
    expect(states(r)).toEqual({ add: "done", restart: "done", reencrypt: "done", verify: "current" });
    expect(removableKeys(r)).toEqual(["v1"]);
    const keep = r.loadedKeys.filter((id) => !removableKeys(r).includes(id));
    expect(envLine(keep, "key")).toBe('ENCRYPTION_KEY="v2:<key>"');
  });

  test("файл записи на старом ключе держит его, даже если значений ноль", () => {
    const r = report({
      activeKey: "v2",
      loadedKeys: ["v2", "v1"],
      keys: [key("v2", { active: true }), key("v1", { values: 0, files: 1 })],
      staleTotal: 1,
    });
    expect(removableKeys(r)).toEqual([]);
    expect(states(r).verify).toBe("todo");
  });

  test("данные на ключе вне окружения — проверка заблокирована", () => {
    const r = report({
      keys: [key("v1", { active: true, values: 10 }), key("v0", { loaded: false, values: 4 })],
      lostTotal: 4,
    });
    expect(states(r).verify).toBe("blocked");
    // потерянный ключ «убрать» нельзя: его и так нет
    expect(removableKeys(r)).toEqual([]);
  });

  test("открытый текст без ротации — перешифровать всё равно есть что", () => {
    expect(states(report({ plainTotal: 5, staleTotal: 5 })).reencrypt).toBe("current");
  });

  test("шифрование выключено — начинать с ключа", () => {
    const r = report({ encryption: false, activeKey: null, loadedKeys: [], keys: [] });
    expect(states(r).add).toBe("current");
    expect(nextKeyId(r)).toBe("v1");
  });

  test("имя нового ключа — старше всех известных, включая найденные в данных", () => {
    expect(nextKeyId(report())).toBe("v2");
    expect(nextKeyId(report({ keys: [key("v2", { active: true }), key("v7", { loaded: false, values: 1 })] }))).toBe("v8");
  });

  test("строка окружения — с заглушками, без ключей", () => {
    expect(envLine(["v3", "v2"], "ключ")).toBe('ENCRYPTION_KEY="v3:<ключ>,v2:<ключ>"');
  });
});

describe("ход перешифровки", () => {
  const job = (over: Partial<OpsReencryptJob>): OpsReencryptJob => ({
    id: "j",
    status: "running",
    startedAt: "2026-09-26T10:00:00.000Z",
    finishedAt: null,
    startedBy: null,
    targetKey: "v2",
    total: 200,
    processed: 50,
    skipped: 0,
    error: null,
    ...over,
  });
  test("доля пройденного", () => {
    expect(jobShare(job({}))).toBe(0.25);
    expect(jobShare(job({ processed: 300 }))).toBe(1);
    expect(jobShare(job({ total: 0, processed: 0, status: "done" }))).toBe(1);
    expect(jobShare(job({ total: 0, processed: 0 }))).toBe(0);
  });
});

describe("возраст секрета", () => {
  const now = Date.parse("2026-09-26T12:00:00.000Z");
  test("смена при нас — точный возраст", () => {
    expect(
      secretAge(
        { name: "JWT_SECRET", state: "set", seenSince: "2026-09-20T12:00:00.000Z", trackedSince: "2026-09-01T00:00:00.000Z" },
        now,
      ),
    ).toEqual({ kind: "changed", days: 6 });
  });
  test("без смены — «не меньше, чем» с начала слежения", () => {
    const at = "2026-09-16T12:00:00.000Z";
    expect(secretAge({ name: "EXPORT_SECRET", state: "set", seenSince: at, trackedSince: at }, now)).toEqual({
      kind: "tracked",
      days: 10,
    });
  });
  test("отметок нет — неизвестно", () => {
    expect(secretAge({ name: "METRICS_TOKEN", state: "unset", seenSince: null, trackedSince: null }, now)).toEqual({
      kind: "unknown",
    });
  });
});

describe("SQL-консоль на экране", () => {
  test("CSV: точка с запятой, кавычки при нужде, NULL — пустая ячейка", () => {
    expect(toCsv(["a", "b"], [["1", null], ['x;"y"', "line\nbreak"]])).toBe('a;b\r\n1;\r\n"x;""y""";"line\nbreak"');
  });

  test("история: новые сверху, повтор поднимается, а не дублируется", () => {
    const e = (query: string, at: string): HistoryEntry => ({
      query,
      reason: "r",
      at,
      outcome: { kind: "ok", rows: 1, truncated: false },
    });
    let list = pushHistory([], e("select 1", "1"));
    list = pushHistory(list, e("select 2", "2"));
    list = pushHistory(list, e("select 1", "3"));
    expect(list.map((x) => x.at)).toEqual(["3", "2"]);
    expect(pushHistory(list, e("q", "4"), 2)).toHaveLength(2);
  });

  test("подсказка о нескольких операторах не срабатывает на точку с запятой в конце и в строке", () => {
    expect(looksMultiple("select 1;")).toBe(false);
    expect(looksMultiple("select ';' as x")).toBe(false);
    expect(looksMultiple("select 1; delete from users")).toBe(true);
  });

  test("у каждого отказа сервера есть строка словаря на трёх языках", () => {
    const codes: OpsSqlRefusal[] = [
      "empty",
      "too_long",
      "multiple_statements",
      "not_read",
      "write_keyword",
      "row_lock",
      "side_effect",
      "placeholder",
    ];
    for (const code of codes) {
      const entry = UI[REFUSAL_TEXT[code]] as { uk: string; ru: string; en: string };
      expect(entry.uk && entry.ru && entry.en, code).toBeTruthy();
    }
  });

  test("подстановка значений в строку словаря", () => {
    expect(fill("{n} рядків · {ms} мс", { n: 3, ms: 12 })).toBe("3 рядків · 12 мс");
    expect(fill("функція {detail}()", { detail: null })).toBe("функція —()");
    expect(fill("{unknown}", {})).toBe("{unknown}");
  });
});

describe("навигация техпанели", () => {
  test("разделы безопасности открыты ролью суперадмина, а не правом", () => {
    const sections = OPS_GROUPS.flatMap((g) => g.sections);
    for (const to of ["/ops/keys", "/ops/integrity", "/ops/sql"]) {
      const s = sections.find((x) => x.to === to);
      expect(s?.role, to).toBe("superadmin");
      expect(s?.perm, to).toBeUndefined();
    }
  });
});
