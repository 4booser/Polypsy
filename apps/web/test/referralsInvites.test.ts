import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { UI, type Referral, type UiKey } from "@quizzy/shared";
import { api, tokenStore } from "../src/api";
import { inviteState } from "../src/pages/invites/model";
import { DESTINATION_KEY, closedParam, referralSorts, showClosed } from "../src/pages/referrals/model";
import { sortRows, type Column } from "../src/ui";
import { listBody } from "../src/ui/paging";
import { patchParams } from "../src/ui/viewParams";

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

describe("направления: «показати закриті»", () => {
  test("из адреса: закрытые — только при all=1; опечатка не расширяет реестр", () => {
    expect(showClosed("1")).toBe(true);
    for (const raw of ["", "0", "true", "yes", "1 ", "2"]) expect(showClosed(raw), raw).toBe(false);
  });

  test("переключатель туда и обратно: открытые — умолчание, в адресе их нет", () => {
    const on = patchParams("referrals.sort=urgency", { all: closedParam(true) });
    expect(on.get("all")).toBe("1");
    const off = patchParams(on, { all: closedParam(false) });
    expect(off.has("all")).toBe(false);
    // сортировка таблицы переключателем не трогается
    expect(off.get("referrals.sort")).toBe("urgency");
  });

  test("в запрос уходит all=1 только для закрытых; курсор — продолжение той же выборки", async () => {
    await api.referrals(showClosed(""));
    await api.referrals(showClosed("1"), "CUR");
    expect(sent(0).pathname).toBe("/api/referrals");
    expect(sent(0).search).toBe("");
    expect(Object.fromEntries(sent(1).searchParams)).toEqual({ all: "1", cursor: "CUR" });
  });

  test("экран читает и пишет отбор через модель", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Referrals.tsx"), "utf8");
    expect(src).toContain("showClosed(allParam)");
    expect(src).toContain("setAllParam(closedParam(v))");
    // смена отбора — новая выборка: `all` в зависимостях загрузки
    expect(src).toMatch(/usePagedResource<Referral>\(\(cursor\) => api\.referrals\(all, cursor\), \[all\]\)/);
  });
});

describe("направления: порядок колонок", () => {
  /*
   * Колонки «Куди», «Терміновість», «Статус» показывают перевод, а
   * сортировались по коду: «Терміновість» по алфавиту кодов шла
   * immediate → routine → urgent, то есть «негайно, планово, терміново» —
   * ни по срочности, ни по алфавиту; «Куди» по кодам давала «командиру,
   * стаціонар, інше, амбулаторно, психіатр». Порядок на экране выглядел
   * несортированным, и человек, нажавший заголовок, решал, что сортировка
   * сломана, — или не замечал и читал список как упорядоченный.
   */
  const ut = (k: UiKey) => UI[k].uk;
  const sorts = referralSorts(ut);
  const columns: Column<Referral>[] = (["destination", "urgency", "status"] as const).map((key) => ({
    key,
    header: key,
    sort: sorts[key],
    render: () => null,
  }));
  let n = 0;
  const ref = (destination: Referral["destination"], urgency: Referral["urgency"], status: Referral["status"]): Referral =>
    ({ id: `r${++n}`, destination, urgency, status }) as Referral;
  const rows = [
    ref("commander", "urgent", "declined"),
    ref("inpatient", "immediate", "created"),
    ref("other", "routine", "completed"),
    ref("outpatient", "urgent", "accepted"),
    ref("psychiatrist", "routine", "created"),
  ];
  const order = (key: string, desc = false) => sortRows(rows, columns, { key, desc });

  test("терміновість — по степени срочности: планово → терміново → негайно, и обратно", () => {
    expect(order("urgency").map((r) => r.urgency)).toEqual(["routine", "routine", "urgent", "urgent", "immediate"]);
    expect(order("urgency", true).map((r) => r.urgency)).toEqual(["immediate", "urgent", "urgent", "routine", "routine"]);
  });

  test("статус — по ходу направления: виписано → прийнято → завершено → відхилено", () => {
    expect(order("status").map((r) => r.status)).toEqual(["created", "created", "accepted", "completed", "declined"]);
  });

  test("«Куди» — по алфавиту того, что написано в колонке", () => {
    expect(order("destination").map((r) => ut(DESTINATION_KEY[r.destination]))).toEqual([
      "амбулаторно",
      "інше",
      "командиру",
      "психіатр",
      "стаціонар",
    ]);
  });

  test("равные по срочности остаются в порядке сервера (свіжі згори) при любом направлении", () => {
    const routine = (desc: boolean) => order("urgency", desc).filter((r) => r.urgency === "routine").map((r) => r.id);
    expect(routine(false)).toEqual(routine(true));
  });

  test("выгрузка пишет словами то, что видно, а не номер ступени", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Referrals.tsx"), "utf8");
    for (const key of ["destination", "urgency", "status"]) expect(src).toContain(`sort: sorts.${key},`);
    expect(src).toContain("csv: (r: Referral) => ut(URGENCY_KEY[r.urgency])");
    expect(src).toContain("csv: (r: Referral) => ut(STATUS_KEY[r.status])");
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
