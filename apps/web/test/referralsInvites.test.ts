import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { UI, type UiKey } from "@quizzy/shared";
import { api, tokenStore } from "../src/api";
import { inviteState } from "../src/pages/invites/model";
import {
  DESTINATION_KEY,
  closedWithin,
  inView,
  matchesReferral,
  sortReferrals,
  spanText,
  viewCount,
  viewFrom,
  waitOf,
} from "../src/pages/referrals/model";
import { listBody } from "../src/ui/paging";

/**
 * Направления и приглашения: отбор, запрос, состояние строки и что стоит на
 * месте списка (волна 13, проверки поведения интерфейса).
 *
 * У реестра направлений один фильтр — «показати закриті» (?all=1), у
 * приглашений фильтров нет вовсе; зато у обоих список приезжает курсором, и
 * у обоих отказ поверх уже показанных строк должен быть виден.
 */

const saved = { fetch: globalThis.fetch, localStorage: (globalThis as { localStorage?: Storage }).localStorage };
let seen: string[] = [];

beforeEach(() => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
  tokenStore.set("t");
  seen = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = saved.fetch;
  (globalThis as { localStorage?: Storage }).localStorage = saved.localStorage;
});

const sent = (i: number) => new URL(seen[i]!, "http://x");

describe("направления: вид реестра в адресе", () => {
  /*
   * Прежде реестр открывался на незакрытых, а закрытые добавлял `?all=1`.
   * Теперь виды — пилюлями («Відкриті», «Виписані»… «Усі», ?v=), и защищать
   * надо то же: опечатка в адресе не расширяет реестр, умолчание в адрес не
   * пишется.
   */
  test("из адреса: незнакомое значение — «Відкриті», а не «Усі»", () => {
    for (const raw of ["", "0", "1", "true", "yes", "open "]) expect(viewFrom(raw), raw).toBe("open");
    expect(viewFrom("all")).toBe("all");
  });

  test("в запрос уходит all=1 только по просьбе; курсор — продолжение той же выборки", async () => {
    await api.referrals(false);
    await api.referrals(true, "CUR");
    expect(sent(0).pathname).toBe("/api/referrals");
    expect(sent(0).search).toBe("");
    expect(Object.fromEntries(sent(1).searchParams)).toEqual({ all: "1", cursor: "CUR" });
  });

  test("экран читает вид через модель и грузит весь реестр: «закриті за 30 днів» стоят под открытыми", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Referrals.tsx"), "utf8");
    expect(src).toContain("const view = viewFrom(viewRaw);");
    expect(src).toContain('setViewRaw(k === "open" ? "" : k)');
    expect(src).toMatch(/usePagedResource<Referral, ReferralPage>\(\(cursor\) => api\.referrals\(true, cursor\), \[\]\)/);
  });
});

describe("направления: выгрузка", () => {
  test("выгрузка пишет словами то, что видно, а не код или номер ступени", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Referrals.tsx"), "utf8");
    expect(src).toContain("sort: (r) => ut(DESTINATION_KEY[r.destination])");
    expect(src).toContain("sort: (r) => ut(URGENCY_KEY[r.urgency])");
    expect(src).toContain("sort: (r) => ut(STATUS_KEY[r.status])");
  });

  test("подписи «Куди» есть на всех языках", () => {
    for (const k of Object.values(DESTINATION_KEY)) expect(UI[k as UiKey].uk.length).toBeGreaterThan(0);
  });
});

describe("приглашения: выписанные ссылки страницами", () => {
  test("первая страница — без курсора, следующая — с ним", async () => {
    await api.invites();
    await api.invites("a/b+c");
    expect(sent(0).pathname).toBe("/api/invites");
    expect(sent(0).search).toBe("");
    // курсор кодируется: в нём бывают «/» и «+», а сервер читает его как есть
    expect(sent(1).searchParams.get("cursor")).toBe("a/b+c");
  });
});

describe("приглашения: жива ли ссылка", () => {
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  const inv = (over: Partial<Parameters<typeof inviteState>[0]> = {}) => ({
    revokedAt: null,
    usedCount: 0,
    maxUses: 1,
    expiresAt: "2026-10-11T12:00:00.000Z",
    ...over,
  });

  test("живая — пока не отозвана, не израсходована и не истекла", () => {
    expect(inviteState(inv(), now)).toBe("live");
    expect(inviteState(inv({ usedCount: 2, maxUses: 5 }), now)).toBe("live");
  });

  test("отозванная — прежде прочего: отзыв — решение человека, и строка говорит о нём", () => {
    expect(inviteState(inv({ revokedAt: "2026-09-20T00:00:00.000Z", usedCount: 1 }), now)).toBe("revoked");
  });

  test("израсходованная и истёкшая — мертвы сами по себе, отзывать их нечего", () => {
    expect(inviteState(inv({ usedCount: 1, maxUses: 1 }), now)).toBe("used");
    expect(inviteState(inv({ expiresAt: "2026-09-27T11:59:59.000Z" }), now)).toBe("expired");
  });

  test("срок сравнивается моментом, а не строкой: смещение пояса не делает живую ссылку мёртвой", () => {
    // 14:30 по Киеву — это 11:30 по Гринвичу, то есть в прошлом; и наоборот
    expect(inviteState(inv({ expiresAt: "2026-09-27T14:30:00+03:00" }), now)).toBe("expired");
    expect(inviteState(inv({ expiresAt: "2026-09-27T15:30:00+03:00" }), now)).toBe("live");
  });
});

describe("что стоит на месте списка", () => {
  test("до первого ответа — скелет (и при обрыве связи тоже), отказ — на месте строк", () => {
    expect(listBody(null, null).body).toBe("loading");
    expect(listBody(null, "Помилка сервера").body).toBe("failed");
  });

  test("пусто — только по ответу сервера", () => {
    expect(listBody([], null)).toEqual({ body: "empty", stale: null });
  });

  test("отказ перечитывания после «відкликати» или подгрузки «ще» — виден поверх строк", () => {
    /*
     * Раньше у приглашений такой отказ не показывался вовсе: отозванная
     * ссылка оставалась в списке живой, а «ще» молча ничего не делало.
     */
    expect(listBody([{ id: "i1" }], "Помилка сервера")).toEqual({ body: "rows", stale: "Помилка сервера" });
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Invites.tsx"), "utf8");
    expect(src).toContain("listBody(rows, list.error)");
    expect(src).toMatch(/body\.stale \? \(/);
  });

  test("направления показывают такой отказ строкой над таблицей", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Referrals.tsx"), "utf8");
    expect(src).toContain("listBody(rows, page.error)");
    expect(src).toContain("{body.stale ? ");
  });
});

describe("реестр направлений «Виразної»", () => {
  const NOW = Date.parse("2026-10-18T12:00:00.000Z");
  const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
  const ref = (over: Partial<import("@quizzy/shared").Referral>) => ({
    id: "r",
    userId: "u",
    userName: "Мельник Андрій",
    responseId: null,
    alertId: null,
    destination: "psychiatrist" as const,
    urgency: "routine" as const,
    status: "created" as const,
    reason: "Сигнал PHQ-9",
    outcomeNote: null,
    createdByName: "Ірина Савчук",
    createdAt: ago(1),
    updatedAt: null,
    ...over,
  });

  test("вид из адреса: незнакомое — «Відкриті»", () => {
    expect(viewFrom("")).toBe("open");
    expect(viewFrom("declined")).toBe("declined");
    expect(viewFrom("yes")).toBe("open");
  });

  test("«Відкриті» — виписані и прийняті; закрытые туда не попадают", () => {
    expect(inView(ref({ status: "created" }), "open")).toBe(true);
    expect(inView(ref({ status: "accepted" }), "open")).toBe(true);
    expect(inView(ref({ status: "declined" }), "open")).toBe(false);
    expect(inView(ref({ status: "completed" }), "all")).toBe(true);
  });

  test("числа пилюль — из ответа сервера; без них — «неизвестно», а не ноль", () => {
    const counts = { created: 2, accepted: 1, completed: 12, declined: 2 };
    expect(viewCount(counts, "open")).toBe(3);
    expect(viewCount(counts, "all")).toBe(17);
    expect(viewCount(counts, "completed")).toBe(12);
    expect(viewCount(undefined, "open")).toBeNull();
  });

  test("ожидание: больше суток без ответа — «late», принятое — за сколько приняли", () => {
    expect(waitOf(ref({ createdAt: ago(0.5) }), NOW)).toEqual({ kind: "issued", minutes: 30 });
    expect(waitOf(ref({ createdAt: ago(48) }), NOW).kind).toBe("late");
    expect(waitOf(ref({ status: "accepted", createdAt: ago(2), updatedAt: ago(1) }), NOW)).toEqual({ kind: "accepted", minutes: 60 });
    expect(waitOf(ref({ status: "completed" }), NOW).kind).toBe("none");
    const unit = { min: "хв", hour: "год", day: "дн." };
    expect([spanText(40, unit), spanText(180, unit), spanText(3 * 1440, unit)]).toEqual(["40 хв", "3 год", "3 дн."]);
  });

  test("«закриті за 30 днів» — по дню закрытия, открытые туда не входят", () => {
    expect(closedWithin(ref({ status: "completed", createdAt: ago(60 * 24), updatedAt: ago(24) }), NOW)).toBe(true);
    expect(closedWithin(ref({ status: "declined", createdAt: ago(40 * 24), updatedAt: ago(31 * 24) }), NOW)).toBe(false);
    expect(closedWithin(ref({ status: "created" }), NOW)).toBe(false);
  });

  test("«спершу термінові»: открытые выше, внутри — негайно, терміново, планово", () => {
    const rows = [
      ref({ id: "plan", urgency: "routine", createdAt: ago(1) }),
      ref({ id: "closed", status: "completed", urgency: "immediate", updatedAt: ago(1) }),
      ref({ id: "now", urgency: "immediate", createdAt: ago(5) }),
      ref({ id: "soon", urgency: "urgent", createdAt: ago(2) }),
    ];
    expect(sortReferrals(rows, "urgent").map((r) => r.id)).toEqual(["now", "soon", "plan", "closed"]);
    expect(sortReferrals(rows, "oldest").map((r) => r.id)[0]).toBe("now");
  });

  test("отбор: поиск по пациенту и подставе, куди, терміновість, виписав", () => {
    const r = ref({});
    const all = { q: "", dest: "", urg: "", by: "" };
    expect(matchesReferral(r, { ...all, q: "phq" })).toBe(true);
    expect(matchesReferral(r, { ...all, q: "мельник" })).toBe(true);
    expect(matchesReferral(r, { ...all, dest: "inpatient" })).toBe(false);
    expect(matchesReferral(r, { ...all, urg: "routine", by: "Ірина Савчук" })).toBe(true);
  });
});
