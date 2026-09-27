import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api, tokenStore } from "../src/api";
import {
  CLEAR_NARROWING,
  emptyQueueKey,
  hasNarrowing,
  queueQuery,
  readFilters,
  statusPatch,
  withOwnGroup,
  type QueueFilters,
} from "../src/pages/alerts/model";
import { listBody } from "../src/ui/paging";
import { patchParams } from "../src/ui/viewParams";

/**
 * Очередь случаев: фильтры и адрес — поведение, а не отрисовка (волна 13).
 *
 * alertsQueue.test.tsx уже закрепляет незнакомые значения и перевёрнутый
 * период. Здесь — остальное, что делает человек с отбором: «хто розбирає»,
 * период, пациент, подразделение и группа из чужой ссылки, смена статуса,
 * «скинути фільтри», и что стоит в колонке очереди при отказе и обрыве.
 * Каждая проверка идёт от адреса: адрес экрана правят руками и присылают
 * ссылкой, и именно он — вход в эти решения.
 */

const G1 = "0b8f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const G2 = "1c9f7b4f-2d3e-4f60-9bac-1d2e3f4a5b6c";
const P1 = "2da08c50-3e4f-4071-8cbd-2e3f4a5b6c7d";

/** Отбор из адреса — так, как его читает экран (Alerts.tsx: useUrlState → readFilters) */
const fromUrl = (search: string): QueueFilters => {
  const p = new URLSearchParams(search);
  return readFilters((name) => p.get(name) ?? "");
};

describe("«хто розбирає»", () => {
  test("мої, нічиї, чужі — уходят на сервер как есть; «будь-хто» — не уходит вовсе", () => {
    for (const who of ["me", "none", "others"] as const) {
      const f = fromUrl(`assigned=${who}`);
      expect(f.assigned).toBe(who);
      expect(queueQuery(f, 30).assigned).toBe(who);
      expect(hasNarrowing(f)).toBe(true);
    }
    const any = fromUrl("");
    expect(queueQuery(any, 30).assigned).toBeUndefined();
    expect(hasNarrowing(any)).toBe(false);
  });

  test("конкретный сотрудник по идентификатору — не вариант поля, и из адреса не применяется", () => {
    // сервер такое принимает, но поле фильтра показать его не может: применённый отбор, которого не видно, — хуже никакого
    expect(fromUrl(`assigned=${P1}`).assigned).toBe("");
  });
});

describe("период", () => {
  test("обе границы — в запросе, включительно; одна граница — только она", () => {
    expect(queueQuery(fromUrl("from=2026-09-01&to=2026-09-10"), 30)).toMatchObject({ from: "2026-09-01", to: "2026-09-10" });
    const onlyTo = queueQuery(fromUrl("to=2026-09-10"), 30);
    expect(onlyTo.from).toBeUndefined();
    expect(onlyTo.to).toBe("2026-09-10");
  });

  test("один и тот же день с обеих сторон — это сутки, а не перевёрнутый период", () => {
    expect(queueQuery(fromUrl("from=2026-09-10&to=2026-09-10"), 30)).toMatchObject({ from: "2026-09-10", to: "2026-09-10" });
  });

  test("не дата, несуществующий день, время вместо даты — не уходят на сервер (он ответил бы 400)", () => {
    for (const bad of ["вчора", "2026-13-01", "2026-09-31", "2026-09-10T00:00", "10.09.2026"]) {
      const q = queueQuery(fromUrl(`from=${encodeURIComponent(bad)}&to=${encodeURIComponent(bad)}`), 30);
      expect(q.from, bad).toBeUndefined();
      expect(q.to, bad).toBeUndefined();
    }
  });
});

describe("пациент", () => {
  test("отбор по человеку — его случаи по одному, а не строка человека", () => {
    const q = queueQuery(fromUrl(`patient=${P1}`), 30);
    expect(q.patient).toBe(P1);
    expect(q.group).toBe("case");
  });

  test("снятие пациента возвращает очередь людей, остальной отбор остаётся", () => {
    const next = patchParams(`patient=${P1}&severity=severe`, { patient: "" });
    expect(next.has("patient")).toBe(false);
    const f = fromUrl(next.toString());
    expect(queueQuery(f, 30).group).toBeUndefined();
    expect(f.severity).toBe("severe");
  });
});

describe("подразделение и поиск из адреса", () => {
  test("подразделение — как есть, без пробелов по краям", () => {
    expect(queueQuery(fromUrl("unit=%20Рота%203%20"), 30).unit).toBe("Рота 3");
  });

  test("подразделение длиннее предела сервера не уходит на сервер (он ответил бы 400 на всю очередь)", () => {
    /*
     * Сервер (caseListQuery: unit ≤ 120) отвергает запрос целиком, и отказ
     * вставал на месте очереди с «повторити», повторявшим тот же отказ.
     * Обрезать нельзя: обрезок — другое подразделение, которого нет.
     */
    const f = fromUrl(`unit=${"Р".repeat(121)}`);
    expect(f.unit).toBe("");
    expect(queueQuery(f, 30).unit).toBeUndefined();
    expect(fromUrl(`unit=${"Р".repeat(120)}`).unit.length).toBe(120);
  });

  test("поиск длиннее предела обрезается и не кончается пробелом", () => {
    const f = fromUrl(`q=${encodeURIComponent(`${"К".repeat(119)} ${"о".repeat(20)}`)}`);
    expect(f.q).toBe("К".repeat(119));
    expect(queueQuery(f, 30).search).toBe("К".repeat(119));
  });
});

describe("группа пациентов из чужой ссылки", () => {
  test("своя группа применяется; чужая, когда свои известны, — нет, и поле показывает «усі групи»", () => {
    /*
     * Общий вид коллеги, сохранённый с его группой: у получателя её нет, и
     * сервер отвечал 404 на всю очередь. Теперь чужая группа не уходит, а
     * остальной отбор вида остаётся в силе.
     */
    const f = fromUrl(`patientGroup=${G2}&severity=severe`);
    expect(queueQuery(withOwnGroup(f, [G1, G2]), 30).patientGroup).toBe(G2);
    const foreign = withOwnGroup(f, [G1]);
    expect(foreign.patientGroup).toBe("");
    expect(queueQuery(foreign, 30).patientGroup).toBeUndefined();
    expect(foreign.severity).toBe("severe");
  });

  test("пока свои группы не известны (в пути или не пришли) — группа применяется как есть", () => {
    const f = fromUrl(`patientGroup=${G2}`);
    expect(withOwnGroup(f, null).patientGroup).toBe(G2);
  });

  test("без группы в адресе отбор не меняется вовсе — тот же объект", () => {
    const f = fromUrl("severity=severe");
    expect(withOwnGroup(f, [G1])).toBe(f);
  });

  test("экран проводит отбор через withOwnGroup, а свои группы при отказе — null, а не пустой список", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Alerts.tsx"), "utf8");
    expect(src).toMatch(/withOwnGroup\(\s*readFilters\(/);
    expect(src).toContain("api.patientGroups().catch(() => null)");
  });
});

describe("статус и сброс", () => {
  test("«Відкриті» — умолчание: статус снимается из адреса вместе с прежним all=1", () => {
    const next = patchParams("all=1&severity=severe", statusPatch("open"));
    expect(next.toString()).toBe("severity=severe");
    expect(fromUrl(next.toString()).status).toBe("open");
  });

  test("«Розібрані» и «Усі» — в адресе; старый all=1 не остаётся рядом", () => {
    expect(patchParams("all=1", statusPatch("resolved")).toString()).toBe("status=resolved");
    const all = patchParams("", statusPatch("all"));
    expect(all.toString()).toBe("status=all");
    expect(queueQuery(fromUrl(all.toString()), 30).status).toBe("all");
  });

  test("«Скинути фільтри» снимает весь отбор, но не статус и не чужие параметры адреса", () => {
    const start = `status=resolved&severity=severe&assigned=me&unit=Рота&patientGroup=${G1}&patient=${P1}&from=2026-09-01&to=2026-09-10&q=Коваль&keep=1`;
    const next = patchParams(start, CLEAR_NARROWING);
    expect(next.toString()).toBe("status=resolved&keep=1");
    expect(hasNarrowing(fromUrl(next.toString()))).toBe(false);
  });

  test("кнопка сброса снимает ровно то, что считается сужением", () => {
    /*
     * hasNarrowing решает, видна ли кнопка, CLEAR_NARROWING — что она снимет.
     * Разойдутся — и кнопка будет видна, а нажатие оставит отбор на месте
     * (или наоборот — отбор есть, а кнопки нет).
     */
    const everything = fromUrl(
      `severity=severe&assigned=me&unit=Рота&patientGroup=${G1}&patient=${P1}&from=2026-09-01&to=2026-09-10&q=Коваль`,
    );
    const narrowingKeys: string[] = (Object.keys(everything) as (keyof QueueFilters)[]).filter(
      (k) => k !== "status" && hasNarrowing({ ...fromUrl(""), [k]: everything[k] }),
    );
    expect(narrowingKeys.sort()).toEqual(Object.keys(CLEAR_NARROWING).sort());
  });
});

describe("что в колонке очереди", () => {
  test("пусто по отбору и «открытых нет» — разные слова", () => {
    expect(emptyQueueKey(fromUrl("severity=severe"))).toBe("cases.emptyFiltered");
    expect(emptyQueueKey(fromUrl(""))).toBe("cases.emptyOpen");
    expect(emptyQueueKey(fromUrl("status=all"))).toBe("cases.emptyAll");
    // статус — не сужение: разобранных нет — это не «ничего по фильтру»
    expect(emptyQueueKey(fromUrl("status=resolved"))).toBe("cases.emptyAll");
  });

  test("до первого ответа: скелет; отказ — на месте строк; обрыв связи — скелет, а не «порожньо»", () => {
    expect(listBody(null, null)).toEqual({ body: "loading", stale: null });
    expect(listBody(null, "Помилка сервера")).toEqual({ body: "failed", stale: null });
  });

  test("отказ перечитывания поверх строк — строкой над ними, строки остаются", () => {
    /*
     * Перечитывание после «взяти на себе» или по событию новой тревоги
     * отказало: раньше колонка молча показывала прежнюю очередь.
     */
    expect(listBody([{ id: "c1" }], "Помилка сервера")).toEqual({ body: "rows", stale: "Помилка сервера" });
    expect(listBody([], "Помилка сервера")).toEqual({ body: "empty", stale: "Помилка сервера" });
    expect(listBody([{ id: "c1" }], null)).toEqual({ body: "rows", stale: null });
  });

  test("колонка очереди показывает отказ поверх строк с «повторити»", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/pages/Alerts.tsx"), "utf8");
    expect(src).toContain("listBody(page.items ? rows : null, page.error)");
    expect(src).toMatch(/queue\.stale \? \(/);
  });
});

describe("адрес → запрос: до сервера", () => {
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
      return new Response(JSON.stringify({ items: [], nextCursor: null, grouping: "person" }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = saved.fetch;
    (globalThis as { localStorage?: Storage }).localStorage = saved.localStorage;
  });

  test("кривой адрес уходит на сервер только тем, что сервер примет", async () => {
    const f = withOwnGroup(
      fromUrl(
        `severity=critical&assigned=others&unit=${"Р".repeat(200)}&patientGroup=${G2}&from=2026-09-10&to=2026-09-01&q=%20Коваль%20&status=bogus`,
      ),
      [G1],
    );
    await api.alertCases(queueQuery(f, 30));
    const sent = new URL(seen[0]!, "http://x");
    expect(sent.pathname).toBe("/api/alert-cases");
    expect(Object.fromEntries(sent.searchParams)).toEqual({
      status: "open",
      assigned: "others",
      from: "2026-09-10",
      search: "Коваль",
      limit: "30",
    });
  });
});
