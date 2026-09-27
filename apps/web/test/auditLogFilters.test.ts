import { describe, expect, test } from "bun:test";
import { auditQuery } from "@quizzy/shared";
import { auditPeriodError, auditQueryOf } from "../src/pages/ops/auditModel";
import { auditFiltersFrom } from "../src/pages/ops/model";

/**
 * Техпанель → «Аудит»: что из адреса уходит в запрос журнала.
 *
 * Отбор журнала приходит ссылками — из «Користувачів» (?actor=, ?subject=),
 * из «Підозрілої активності» (период днями), из закладок. Сервер отбор
 * проверяет строго (auditQuery), и до правки кривое значение из адреса
 * уходило к нему как есть: вместо журнала экран показывал «Невірний запит»,
 * а «повторити» повторяло тот же отказ. Каждый случай ниже прогоняется через
 * саму схему сервера.
 */

const from = (s: string) => auditQueryOf(auditFiltersFrom(new URLSearchParams(s)));
const passes = (q: Record<string, string>) => auditQuery.safeParse(q);

describe("отбор журнала → запрос", () => {
  test("заданное уходит как есть, пустое не уходит", () => {
    const q = from("actor=root@test&subject=&action=user.disable&outcome=denied&from=2026-09-01&to=2026-09-26&q=%20");
    expect(q).toEqual({ actor: "root@test", action: "user.disable", outcome: "denied", from: "2026-09-01", to: "2026-09-26" });
    expect(passes(q).success).toBe(true);
  });

  test("кривое значение в адресе — условия нет, а не отказ сервера на весь журнал", () => {
    const garbage = [
      "from=вчора",
      "from=2026-02-31",
      "to=2026-13-01",
      "from=0000-01-01",
      "outcome=failed",
      `q=${"я".repeat(500)}`,
      `actor=${"a".repeat(300)}`,
      `action=${"x".repeat(80)}`,
      `resourceType=${"t".repeat(80)}`,
    ];
    for (const raw of garbage) {
      const q = from(raw);
      const verdict = passes(q);
      expect(verdict.success, `${raw}: ${verdict.error?.issues.map((i) => i.message).join("; ")}`).toBe(true);
    }
    expect(from("from=вчора&outcome=failed")).toEqual({});
  });

  test("длинный текст обрезается, а длинный код действия снимается — обрезанный код не нашёл бы ничего", () => {
    expect(from(`q=${"я".repeat(500)}`).q?.length).toBe(200);
    expect(from(`action=${"x".repeat(80)}`).action).toBeUndefined();
  });

  test("перевёрнутый период: конец не применяется, и это сказано словами", () => {
    const f = auditFiltersFrom(new URLSearchParams("from=2026-09-10&to=2026-09-01"));
    expect(auditPeriodError(f)).toBe("coh.errPeriod");
    expect(auditQueryOf(f)).toEqual({ from: "2026-09-10" });
    // один день — не перевёрнутый период
    expect(auditPeriodError(auditFiltersFrom(new URLSearchParams("from=2026-09-10&to=2026-09-10")))).toBeNull();
  });

  test("момент и день одного числа — не перевёрнутый период: конец дня включительно", () => {
    const f = auditFiltersFrom(new URLSearchParams("from=2026-09-10T12:00:00Z&to=2026-09-10"));
    expect(auditPeriodError(f)).toBeNull();
    expect(auditQueryOf(f).to).toBe("2026-09-10");
  });

  test("кривая дата не делает период «перевёрнутым»", () => {
    expect(auditPeriodError(auditFiltersFrom(new URLSearchParams("from=2026-09-31&to=2026-09-01")))).toBeNull();
  });

  test("параметры не отбора (страница, открытая строка) в запрос не попадают", () => {
    expect(from("page=3&open=abc&cursor=zzz")).toEqual({});
  });
});
