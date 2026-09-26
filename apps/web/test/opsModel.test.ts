import { describe, expect, test } from "bun:test";
import type { ClinicalTrace, Permission } from "@quizzy/shared";
import { UI } from "@quizzy/shared";
import {
  AUDIT_ACTION_KEY,
  AUDIT_PRESETS,
  PASSWORD_ALPHABET,
  TRACE_ORDER,
  auditFiltersFrom,
  canOpenOps,
  generatePassword,
  holdKey,
  holdsOfRow,
  opsHome,
  opsTabs,
  personHref,
  prettyDetails,
} from "../src/pages/ops/model";

/**
 * Техпанель без браузера: кому какие вкладки, что держит учётку, какой
 * пароль выдаётся.
 *
 * Правило «вкладка по своему праву» проверяется здесь, а не глазами: вкладка,
 * ведущая в отказ сервера, выглядит рабочей до первого нажатия, а пропавшая
 * вкладка — как будто её и не было.
 */

const only =
  (...granted: Permission[]) =>
  (p: Permission) =>
    granted.includes(p);

describe("вкладки техпанели", () => {
  test("у каждой вкладки своё право: наблюдаемость, люди, журнал", () => {
    /*
     * Не точным списком: разделы по ops.read дописывают сразу несколько
     * участков (наблюдаемость, данные, …). Держится суть — наблюдаемость на
     * месте, а разделов о людях и журнала это право не открывает.
     */
    const observe = opsTabs(only("ops.read")).map((t) => t.to);
    expect(observe).toEqual(
      expect.arrayContaining(["/ops", "/ops/requests", "/ops/errors", "/ops/logs", "/ops/db", "/ops/jobs"]),
    );
    for (const people of ["/ops/users", "/ops/sessions", "/ops/audit"]) expect(observe).not.toContain(people);
    // люди и безопасность (people2): временные доступы — к учёткам, подозрительное и отчёт — к журналу
    expect(opsTabs(only("users.manage")).map((t) => t.to)).toEqual(["/ops/users", "/ops/sessions", "/ops/grants"]);
    expect(opsTabs(only("audit.read")).map((t) => t.to)).toEqual(["/ops/audit", "/ops/suspicious", "/ops/who-viewed"]);
    expect(opsTabs(only("ops.manage")).map((t) => t.to)).toEqual(["/ops/mfa"]);
  });

  test("панель открыта при любом из трёх прав и закрыта без них", () => {
    expect(canOpenOps(only())).toBe(false);
    expect(canOpenOps(only("patients.read"))).toBe(false);
    for (const p of ["ops.read", "users.manage", "audit.read"] as Permission[]) expect(canOpenOps(only(p))).toBe(true);
  });

  test("без наблюдаемости /ops ведёт на первую доступную вкладку", () => {
    expect(opsHome(only("ops.read", "audit.read"))).toBe("/ops");
    expect(opsHome(only("users.manage", "audit.read"))).toBe("/ops/users");
    expect(opsHome(only("audit.read"))).toBe("/ops/audit");
    expect(opsHome(only())).toBeNull();
  });

  test("подпись каждой вкладки есть в словаре", () => {
    for (const t of opsTabs(() => true)) expect(UI[t.key], t.key).toBeDefined();
  });
});

describe("что держит учётку", () => {
  const zero: ClinicalTrace = Object.fromEntries(TRACE_ORDER.map((k) => [k, 0])) as unknown as ClinicalTrace;

  test("без следа и журнала — ничего не держит", () => {
    expect(holdsOfRow({ trace: zero, journalEntries: 0 })).toEqual([]);
  });

  test("след — в порядке сервера, журнал — последним", () => {
    const holds = holdsOfRow({ trace: { ...zero, consents: 1, responses: 12, conclusions: 2 }, journalEntries: 5 });
    expect(holds).toEqual([
      { key: "responses", count: 12 },
      { key: "conclusions", count: 2 },
      { key: "consents", count: 1 },
      { key: "journal", count: 5 },
    ]);
  });

  test("у каждого источника есть слово в словаре — его же берёт сервер для текста отказа", () => {
    for (const k of [...TRACE_ORDER, "journal" as const]) expect(UI[holdKey(k)], k).toBeDefined();
  });
});

describe("временный пароль", () => {
  test("четыре группы по четыре знака без путаницы 0/O и 1/l/I", () => {
    for (let i = 0; i < 300; i++) {
      const p = generatePassword();
      expect(p).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
      expect(p).not.toMatch(/[0O1lI]/);
    }
  });

  test("байты за границей равномерности отбрасываются, а не сворачиваются остатком", () => {
    /* 255 и 250 выше границы (224 при 56 знаках): их брать нельзя, иначе первые знаки выпадали бы чаще */
    let calls = 0;
    const p = generatePassword((b) => {
      calls += 1;
      b.fill(calls === 1 ? 255 : 0);
      return b;
    });
    expect(calls).toBe(2);
    expect(p).toBe(`${PASSWORD_ALPHABET[0]!.repeat(4)}-${PASSWORD_ALPHABET[0]!.repeat(4)}-${PASSWORD_ALPHABET[0]!.repeat(4)}-${PASSWORD_ALPHABET[0]!.repeat(4)}`);
  });
});

describe("журнал", () => {
  test("отбор из адреса: пустое не передаётся, чужие параметры не подхватываются", () => {
    const f = auditFiltersFrom(new URLSearchParams("q=%20&actor=root@test&action=user.disable&page=3&to=2026-09-26"));
    expect(f).toEqual({ actor: "root@test", action: "user.disable", to: "2026-09-26" });
  });

  test("у каждого названного действия и быстрого отбора есть слово в словаре", () => {
    for (const [action, key] of Object.entries(AUDIT_ACTION_KEY)) expect(UI[key], action).toBeDefined();
    for (const p of AUDIT_PRESETS) expect(UI[p.key], p.action).toBeDefined();
  });

  test("подробности — как лежат в журнале, ключи по алфавиту", () => {
    expect(prettyDetails(null)).toBe("—");
    expect(prettyDetails({ reason: "x", count: 2 })).toBe('{\n  "count": 2,\n  "reason": "x"\n}');
  });
});

test("имя в строке ведёт в карточку своего класса", () => {
  expect(personHref({ id: "a", role: "user" })).toBe("/patients/a");
  expect(personHref({ id: "b", role: "admin" })).toBe("/staff/b");
  expect(personHref({ id: "c", role: "superadmin" })).toBe("/staff/c");
});
