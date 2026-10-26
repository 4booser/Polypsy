import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { Patient } from "../src/api";
import { PatientPickerView, searchPatients } from "../src/components/PatientPicker";
import { LangProvider } from "../src/lang";
import { loadAdminister } from "../src/pages/administerModel";
import { assignChoices } from "../src/pages/batteries/model";

/**
 * Выбор пациента за пределами первой сотни (#174).
 *
 * GET /api/access/patients отдаёт не больше ста человек и ищет сам
 * (routes/access.ts, PATIENT_LIMIT): ФИО зашифровано, листать его в SQL
 * нечем. «Доступ до методики», «Набори» и «Провести методику» брали первую
 * сотню без поиска и искали в ней у себя — сто пятого человека нельзя было
 * ни найти, ни назначить, а «нікого не залишилось» выглядело как «его нет в
 * зоне». Здесь — тот же сервер в миниатюре: поиск по ФИО и почте, потолок
 * сто, признак усечения.
 */

const LIMIT = 100;
const pad = (n: number) => String(n).padStart(3, "0");
const zone: Patient[] = Array.from({ length: 105 }, (_, i) => ({
  id: `p${pad(i + 1)}`,
  fullName: `Пацієнт ${pad(i + 1)}`,
  email: `p${pad(i + 1)}@clinic.ua`,
  unit: null,
}));
const last = zone[104]!;

const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
const saved = { fetch: globalThis.fetch, localStorage: g.localStorage, sessionStorage: g.sessionStorage };
let paths: string[] = [];

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

beforeEach(() => {
  paths = [];
  g.localStorage = memoryStorage();
  g.sessionStorage = memoryStorage();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.startsWith("/api/access/patients")) {
      const search = (new URL(path, "http://x").searchParams.get("search") ?? "").trim().toLowerCase();
      const all = zone.filter((p) => `${p.fullName} ${p.email}`.toLowerCase().includes(search));
      return reply({ items: all.slice(0, LIMIT), total: all.length, truncated: all.length > LIMIT });
    }
    if (path.startsWith("/api/surveys/s1")) return reply({ id: "s1", versionId: "v1", questions: [] });
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = saved.fetch;
  g.localStorage = saved.localStorage;
  g.sessionStorage = saved.sessionStorage;
});

describe("поиск — на сервере", () => {
  test("положительный контроль: без поиска — сотня и признак усечения, сто пятого в ней нет", async () => {
    const found = await searchPatients("");
    expect(found.items).toHaveLength(100);
    expect(found.truncated).toBe(true);
    expect(found.items.some((p) => p.id === last.id)).toBe(false);
  });

  test("набранное уходит серверу — и сто пятый находится", async () => {
    const found = await searchPatients("  Пацієнт 105 ");
    expect(paths.at(-1)).toContain("search=");
    expect(found.items.map((p) => p.id)).toEqual([last.id]);
    expect(found.truncated).toBe(false);
  });

  test("«Набори»: сто пятый — в предложениях «+ ПІБ», если набор ему не назначен", async () => {
    const found = await searchPatients("105");
    expect(assignChoices(found, [], "105").list.map((p) => p.id)).toEqual([last.id]);
    const busy = [{ userId: last.id, cancelledAt: null, completedAt: null, overdue: false }];
    expect(assignChoices(found, busy, "105").list).toEqual([]);
  });

  test("«Набори»: усечение видно — и серверное, и строки предложений", async () => {
    const wide = await searchPatients("пацієнт");
    expect(assignChoices(wide, [], "пацієнт").cut).toBe(true);
    const narrow = await searchPatients("пацієнт 10");
    // 100–105 — шестеро: в строку влезают все
    expect(assignChoices(narrow, [], "пацієнт 10")).toEqual({ list: narrow.items, cut: false });
    const nine = await searchPatients("пацієнт 0");
    expect(nine.truncated).toBe(false);
    expect(assignChoices(nine, [], "пацієнт 0").cut).toBe(true);
  });

  test("«Провести методику» не грузит первую сотню вместе с методикой", async () => {
    await loadAdminister("s1", undefined);
    expect(paths.some((p) => p.startsWith("/api/access/patients"))).toBe(false);
  });
});

/*
 * Выбор — одно поле-комбобокс: набрал, стрелками по найденным, Enter. Прежде
 * человека искали в одном поле и выбирали в родном списке рядом.
 */
describe("выбор: что на экране", () => {
  const view = (over: Partial<Parameters<typeof PatientPickerView>[0]> = {}) =>
    renderToStaticMarkup(
      <LangProvider>
        <PatientPickerView
          label="Кого обстежуємо"
          query="пацієнт"
          onQuery={() => {}}
          found={{ data: { items: zone.slice(0, 3), truncated: false }, error: null }}
          chosen={null}
          onPick={() => {}}
          onChange={() => {}}
          open
          onOpen={() => {}}
          active={1}
          onActive={() => {}}
          {...over}
        />
      </LangProvider>,
    );

  test("одно поле-комбобокс и список найденных под ним; подсвеченный пункт назван полю", () => {
    const html = view();
    expect(html.match(/role="combobox"/g)).toHaveLength(1);
    expect(html).not.toContain("<select");
    expect(html.match(/role="option"/g)).toHaveLength(3);
    const active = /aria-activedescendant="([^"]+)"/.exec(html)?.[1];
    expect(active, "подсвеченный пункт не назван полю").toBeDefined();
    expect(new RegExp(`id="${active}"[^>]*aria-selected="true"`).test(html)).toBe(true);
    // вторая строка пункта — подразделение, а без него почта
    expect(html).toContain("p002@clinic.ua");
  });

  test("закрытое поле списка не рисует и о нём не объявляет", () => {
    const html = view({ open: false });
    expect(html).not.toContain('role="listbox"');
    expect(html).toContain('aria-expanded="false"');
  });

  test("усечённая выдача говорит о себе — «звузьте пошук»", () => {
    expect(view({ found: { data: { items: zone.slice(0, 100), truncated: true }, error: null } })).toContain(
      "Показано не всіх — звузьте пошук",
    );
    // положительный контроль: полная выдача — без пометки
    expect(view()).not.toContain("звузьте пошук");
  });

  test("отказ сервера печатается, а не превращается в пустой список", () => {
    const html = view({ found: { data: null, error: "Недостатньо прав" } });
    expect(html).toContain("Недостатньо прав");
    expect(html).not.toContain("Нікого не знайдено");
    // а пустая выдача — словом
    expect(view({ found: { data: { items: [], truncated: false }, error: null } })).toContain("Нікого не знайдено");
  });

  test("выбранный — плашкой с «Змінити», поля поиска рядом нет", () => {
    const html = view({ chosen: last });
    expect(html).toContain(last.fullName);
    expect(html).toContain(">Змінити<");
    expect(html).toContain('aria-label="Змінити пацієнта"');
    expect(html).not.toContain('role="combobox"');
  });
});

describe("экраны ищут на сервере", () => {
  const src = (f: string) => readFileSync(resolve(import.meta.dir, "../src/pages", f), "utf8");

  test("ни один из трёх не берёт первую сотню без поиска", () => {
    for (const f of ["Access.tsx", "Batteries.tsx", "../components/AssignDrawer.tsx", "Administer.tsx", "administerModel.ts"]) {
      expect(/api\.patients\(\s*\)/.test(src(f)), `${f}: api.patients() без поиска`).toBe(false);
    }
  });

  /*
   * С волны 25 «Доступ до методики» и «Набори» назначают в общем ящике
   * (components/AssignDrawer.tsx, с волны 27 — общий и для групп): поиск там — по набранному, на сервере.
   * Сторож идёт за ящиком и следит, что оба экрана назначают через него.
   */
  test("«Доступ до методики» и «Набори» — ящик с поиском по набранному, «Провести методику» — поле с поиском", () => {
    expect(src("../components/AssignDrawer.tsx")).toContain("usePatientSearch(query, { onlyTyped: true })");
    expect(src("methods/MethodPage.tsx")).toContain("<AssignDrawer");
    expect(src("Access.tsx")).toContain("<MethodPage");
    expect(src("Batteries.tsx")).toContain("<AssignDrawer");
    expect(src("Administer.tsx")).toContain("<PatientPicker");
  });
});
