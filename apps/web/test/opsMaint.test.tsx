import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import {
  UI,
  emptyAudience,
  featureFlagAudienceSchema,
  makeUiT,
  type PublicServiceStatus,
  type ReleaseEntry,
} from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { StatusBody } from "../src/pages/Status";
import { OPS_GROUPS } from "../src/pages/ops/sections";
import {
  audienceParts,
  enabledForNobody,
  localInputToIso,
  rollbackPlan,
  shortSha,
  toggleIn,
  toggleRole,
  uptimeMs,
} from "../src/pages/ops/maint/model";
import { bannerFor, flagsStale, minutesLeft, sameLocalDay, statusPollMs } from "../src/service/model";
import { createOutbox, offlineSafetyPlan, type OutboxStorage } from "../src/patient/outbox";

/**
 * Техпанель, эксплуатация — на клиенте: баннер, страница статуса, флаги,
 * выпуски и отложенные сдачи кабинета пациента.
 *
 * Главное здесь — очередь сдач: в ней лежат клинические ответы, которых
 * больше нигде нет, и ошибка в ней стоит потерянного прохождения. Всё
 * остальное — решения экранов, которые глазами проверяются лишь случайно.
 */

const status = (over: Partial<PublicServiceStatus> = {}): PublicServiceStatus => ({
  status: "ok",
  message: null,
  expectedEnd: null,
  since: null,
  writable: true,
  auto: null,
  checkedAt: "2026-09-26T12:00:00.000Z",
  history: [],
  ...over,
});

describe("баннер", () => {
  test("только при работах и сбоях; «працює» с текстом баннер не держит", () => {
    expect(bannerFor(null)).toBeNull();
    expect(bannerFor(status({ message: "Роботи завершено" }))).toBeNull();
    expect(bannerFor(status({ status: "maintenance", message: "Оновлення" }))?.tone).toBe("maintenance");
    expect(bannerFor(status({ status: "degraded" }))?.tone).toBe("degraded");
  });

  test("отсчёт: округление вверх, прошедший срок — не число", () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    expect(minutesLeft(null, now)).toBeNull();
    expect(minutesLeft("2026-09-26T11:59:00Z", now)).toBeNull();
    expect(minutesLeft("2026-09-26T12:00:20Z", now)).toBe(1);
    expect(minutesLeft("2026-09-26T12:25:00Z", now)).toBe(25);
  });

  test("время конца: сегодня — часы, другой день — с датой", () => {
    const now = new Date(2026, 8, 26, 12, 0).getTime();
    expect(sameLocalDay(new Date(2026, 8, 26, 21, 30).toISOString(), now)).toBe(true);
    expect(sameLocalDay(new Date(2026, 8, 27, 9, 0).toISOString(), now)).toBe(false);
  });

  test("во время работ опрос чаще", () => {
    expect(statusPollMs(status({ status: "maintenance" }))).toBeLessThan(statusPollMs(status()));
  });

  test("флаги перечитываются при смене человека, и только тогда", () => {
    expect(flagsStale(undefined, null)).toBe(true);
    expect(flagsStale("a", "a")).toBe(false);
    expect(flagsStale("a", "b")).toBe(true);
    expect(flagsStale("a", null)).toBe(true);
  });
});

describe("страница статуса", () => {
  const render = (s: PublicServiceStatus | null, unreachable = false) =>
    renderToStaticMarkup(
      <LangProvider>
        <MemoryRouter>
          <StatusBody status={s} unreachable={unreachable} />
        </MemoryRouter>
      </LangProvider>,
    );
  const ut = makeUiT("uk");

  test("состояние названо словом, запись закрыта — сказано прямо", () => {
    const html = render(
      status({
        status: "maintenance",
        writable: false,
        message: "Оновлюємо сервер",
        since: "2026-09-26T11:00:00.000Z",
        history: [{ id: "a", status: "maintenance", message: "Оновлюємо сервер", expectedEnd: null, at: "2026-09-26T11:00:00.000Z" }],
      }),
    );
    expect(html).toContain(ut("svc.status.maintenance"));
    expect(html).toContain(ut("svc.writeClosed"));
    expect(html).toContain("Оновлюємо сервер");
  });

  test("база молчит — сказано, что это увидел сервер", () => {
    const html = render(status({ status: "degraded", auto: "db", writable: false }));
    expect(html).toContain(ut("svc.autoDb"));
  });

  test("сервер не ответил вовсе — честная строка, а не пустота", () => {
    expect(render(null, true)).toContain(ut("svc.unreachable"));
  });
});

describe("раздел «Випуски»", () => {
  const rel = (version: string, migrations: string[] | null, startedAt: string, endedAt: string | null): ReleaseEntry => ({
    id: version,
    version,
    commitSha: "0123456789abcdef",
    commitUrl: null,
    deployedBy: "4booser",
    runUrl: null,
    startedAt,
    endedAt,
    migrations,
    lastMigration: null,
  });

  test("откат — на ближайшую другую версию; остаются миграции всех выпусков новее", () => {
    const items = [
      rel("v1.3.0", ["0090_ops_maint"], "2026-09-26T10:00:00Z", null),
      rel("v1.3.0", [], "2026-09-25T10:00:00Z", "2026-09-26T10:00:00Z"),
      rel("v1.2.0", ["0089_x"], "2026-09-24T10:00:00Z", "2026-09-25T10:00:00Z"),
    ];
    const plan = rollbackPlan(items)!;
    expect(plan.target.version).toBe("v1.2.0");
    expect(plan.left).toEqual(["0090_ops_maint"]);
    expect(plan.unknown).toBe(false);
  });

  test("неизвестные миграции после цели — предупреждение, а не «схема та же»", () => {
    const plan = rollbackPlan([
      rel("v2", null, "2026-09-26T10:00:00Z", null),
      rel("v1", [], "2026-09-25T10:00:00Z", "2026-09-26T10:00:00Z"),
    ])!;
    expect(plan.unknown).toBe(true);
    expect(plan.left).toEqual([]);
  });

  test("откатывать не на что — плана нет", () => {
    expect(rollbackPlan([])).toBeNull();
    expect(rollbackPlan([rel("v1", null, "2026-09-26T10:00:00Z", null)])).toBeNull();
  });

  test("время работы — до следующего выпуска или до сейчас", () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    expect(uptimeMs({ startedAt: "2026-09-26T10:00:00Z", endedAt: null }, now)).toBe(2 * 3600_000);
    expect(uptimeMs({ startedAt: "2026-09-25T10:00:00Z", endedAt: "2026-09-25T11:00:00Z" }, now)).toBe(3600_000);
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });

  test("поле времени без пояса понимается по часам набравшего", () => {
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("вчора")).toBeNull();
    expect(localInputToIso("2026-09-26T21:30")).toBe(new Date(2026, 8, 26, 21, 30).toISOString());
  });
});

describe("раздел «Прапорці»", () => {
  const names = { staffRoles: { head: { uk: "Завідувач" } }, users: { u1: "Олена Іваненко" }, surveyGroups: {}, departments: {} };
  const ut = makeUiT("uk");

  test("кому включён — именами; имени нет — остаётся идентификатор", () => {
    const a = featureFlagAudienceSchema.parse({ roles: ["user"], staffRoles: ["head"], users: ["u1", "gone"] });
    expect(audienceParts(a, names, "uk", ut)).toEqual([ut("fl.role.user"), "Завідувач", "Олена Іваненко", "gone"]);
    expect(audienceParts({ ...a, all: true }, names, "uk", ut)).toEqual([ut("fl.everyone")]);
  });

  test("правка аудитории не трогает соседние списки", () => {
    const a = toggleIn(emptyAudience(), "users", "u1");
    expect(a.users).toEqual(["u1"]);
    expect(toggleIn(a, "users", "u1").users).toEqual([]);
    expect(toggleRole(a, "admin").roles).toEqual(["admin"]);
    expect(toggleRole(a, "admin").users).toEqual(["u1"]);
  });

  test("включён, но никому — предупреждение до сохранения", () => {
    expect(enabledForNobody(true, emptyAudience())).toBe(true);
    expect(enabledForNobody(false, emptyAudience())).toBe(false);
    expect(enabledForNobody(true, toggleRole(emptyAudience(), "user"))).toBe(false);
  });
});

describe("реестр разделов техпанели", () => {
  test("три раздела эксплуатации — в своей группе, по праву ops.read, с подписью из словаря", () => {
    const ops = OPS_GROUPS.find((g) => g.key === "operations")!;
    for (const to of ["/ops/maintenance", "/ops/flags", "/ops/releases"]) {
      const section = ops.sections.find((s) => s.to === to);
      expect(section, to).toBeTruthy();
      expect(section!.perm).toBe("ops.read");
      expect(UI[section!.label]).toBeTruthy();
    }
  });
});

describe("отложенные сдачи кабинета пациента", () => {
  class HttpError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  const memory = (): OutboxStorage & { map: Map<string, string> } => {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
  };

  test("сдача получает clientRequestId, и первый id сохраняется", () => {
    const box = createOutbox(memory());
    const a = box.enqueue("u", "s1", {});
    const b = box.enqueue("u", "s1", { clientRequestId: "first" });
    expect(a.payload.clientRequestId).toBeString();
    expect(b.payload.clientRequestId).toBe("first");
  });

  test("режим обслуживания (503) останавливает проход и ничего не помечает отказом", async () => {
    const box = createOutbox(memory());
    box.enqueue("u", "s1", {});
    box.enqueue("u", "s2", {});
    let calls = 0;
    const res = await box.flush("u", async () => {
      calls++;
      throw new HttpError("Тривають технічні роботи", 503);
    });
    expect(calls).toBe(1);
    expect(res).toEqual({ sent: 0, left: 2, rejected: 0 });
    // работы кончились — уходит само и по порядку
    const order: string[] = [];
    const done = await box.flush("u", async (item) => {
      order.push(item.surveyId);
    });
    expect(done.sent).toBe(2);
    expect(order).toEqual(["s1", "s2"]);
    expect(box.waiting("u")).toHaveLength(0);
  });

  test("отказ по существу помечает запись, не теряет её и не держит остальных", async () => {
    const store = memory();
    const box = createOutbox(store);
    box.enqueue("u", "bad", { answers: [1] });
    box.enqueue("u", "good", {});
    const res = await box.flush("u", async (item) => {
      if (item.surveyId === "bad") throw new HttpError("Методику знято", 409);
    });
    expect(res).toEqual({ sent: 1, left: 0, rejected: 1 });
    const [stuck] = box.rejected("u");
    expect(stuck!.rejectedReason).toBe("Методику знято");
    expect(stuck!.payload.answers).toEqual([1]);
    box.retry("u", stuck!.id);
    expect(box.waiting("u")).toHaveLength(1);
  });

  test("очередь своя у каждого: чужая сдача не уходит под чужим входом", async () => {
    const box = createOutbox(memory());
    box.enqueue("alice", "s1", {});
    const sent: string[] = [];
    await box.flush("bob", async (item) => {
      sent.push(item.id);
    });
    expect(sent).toEqual([]);
    expect(box.waiting("alice")).toHaveLength(1);
  });

  test("всё отправлено — запись из хранилища убирается", async () => {
    const store = memory();
    const box = createOutbox(store);
    box.enqueue("u", "s1", {});
    await box.flush("u", async () => {});
    expect(store.map.size).toBe(0);
  });

  test("памятка безопасности — по тем же критическим вариантам, что на сервере", () => {
    const survey = { safetyPlan: "Зателефонуйте 7333", questions: [{ options: [{ id: "o1", riskFlag: true }, { id: "o2", riskFlag: false }] }] };
    expect(offlineSafetyPlan(survey, [{ optionIds: ["o1"] }])).toBe("Зателефонуйте 7333");
    expect(offlineSafetyPlan(survey, [{ optionIds: ["o2"] }])).toBeNull();
    expect(offlineSafetyPlan({ ...survey, safetyPlan: null }, [{ optionIds: ["o1"] }])).toBeNull();
  });
});
