import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI, type AppointmentView } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { prepAfterSelect } from "../src/pages/today/model";
import { loadPrep, Prep } from "../src/pages/today/Prep";

/**
 * Подготовка к сессии открывается только явно (решение заказчика после
 * волны 25).
 *
 * Клинический контекст сессии сервер отдаёт маршрутом
 * /api/clinic/appointments/:id/context и пишет при этом в журнал доступа
 * clinic.visit_open. Запись должна значить «человек открыл подготовку», а не
 * «курсор прошёл по строке»: выбор сессии щелчком, J/K или сам собой по
 * ходу дня маршрут не зовёт; зовёт только «Показати підготовку» (P). Смена
 * выбора панель закрывает.
 */

const appt: AppointmentView = {
  id: "a-1",
  slotId: "s-1",
  startsAt: "2026-10-08T14:30:00.000Z",
  endsAt: "2026-10-08T15:20:00.000Z",
  kind: "repeat",
  mode: "onsite",
  meetingUrl: null,
  status: "confirmed",
  specialistId: "sp-1",
  specialistName: "Савчук І.",
  room: "214",
  patientId: "p-1",
  patientName: "Коваленко Оксана Петрівна",
  reason: "тривога перед дзвінками",
  bookedAt: "2026-10-01T09:00:00.000Z",
  confirmedAt: "2026-10-08T08:20:00.000Z",
  offSchedule: false,
  pendingAssignments: 1,
  screeningDone: null,
  leadSpecialistId: "sp-1",
};

const draw = (open: boolean) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>
        <Prep a={appt} state="next" clash={undefined} now={null} open={open} onOpen={() => {}} onNote={() => {}} />
      </LangProvider>
    </MemoryRouter>,
  );

const either = (html: string, key: keyof typeof UI) => {
  const e = UI[key] as { uk: string; ru: string };
  return html.includes(e.uk) || html.includes(e.ru);
};

describe("подготовка: открывается только явно", () => {
  test("выбор другой сессии закрывает открытую; та же сессия остаётся открытой", () => {
    expect(prepAfterSelect("a-1", "a-1")).toBe("a-1");
    expect(prepAfterSelect("a-1", "a-2")).toBeNull();
    expect(prepAfterSelect("a-1", null)).toBeNull();
    // вернувшись к прежней, человек открывает её снова сам
    expect(prepAfterSelect(prepAfterSelect("a-1", "a-2"), "a-1")).toBeNull();
    expect(prepAfterSelect(null, "a-1")).toBeNull();
  });

  test("закрытая панель: расписание и готовность есть, кнопка есть, клинического контекста нет", () => {
    const html = draw(false);
    expect(html).toContain("data-prep-closed");
    expect(html).not.toContain("data-prep-details");
    expect(either(html, "dayA.prepShow")).toBe(true);
    expect(html).toContain('aria-keyshortcuts="P"');
    // то, что уже есть в расписании: кто, когда, кабинет, готовность
    expect(html).toContain(appt.patientName);
    expect(html).toContain("214");
    expect(html).toContain(appt.reason!);
    expect(either(html, "dayA.sinceLast") || either(html, "dayA.firstHere")).toBe(false);
    expect(either(html, "dayA.keyNumbers")).toBe(false);
  });

  test("открытая — блок подготовки вместо кнопки", () => {
    const html = draw(true);
    expect(html).toContain("data-prep-details");
    expect(html).not.toContain("data-prep-closed");
  });

  test("маршрут контекста зовёт только загрузка подготовки, а её — только открытая панель", () => {
    const dir = resolve(import.meta.dir, "../src/pages");
    const sources = [join(dir, "Today.tsx"), ...readdirSync(join(dir, "today")).map((f) => join(dir, "today", f))];
    const calls = sources.flatMap((f) => (readFileSync(f, "utf8").match(/\bvisitContext\(/g) ?? []).map(() => f));
    expect(calls.map((f) => f.split("/").pop())).toEqual(["Prep.tsx"]);
    const prep = readFileSync(join(dir, "today", "Prep.tsx"), "utf8");
    const loader = prep.slice(prep.indexOf("export async function loadPrep"), prep.indexOf("export function Prep("));
    expect(loader).toContain("api.visitContext(a.id)");
    // loadPrep вызывается в одном месте — в PrepDetails, которую рисует только открытая панель
    expect((prep.match(/loadPrep\(a\)/g) ?? []).length).toBe(1);
    const details = prep.slice(prep.indexOf("function PrepDetails"));
    expect(details).toContain("loadPrep(a)");
    expect(prep).toMatch(/\{open \? \(\s*<PrepDetails a=\{a\} \/>/);
  });

  describe("запрос", () => {
    const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
    const saved = { fetch: globalThis.fetch, localStorage: g.localStorage, sessionStorage: g.sessionStorage };
    const memory = (): Storage => {
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
    };
    const calls: string[] = [];
    beforeEach(() => {
      calls.length = 0;
      g.localStorage = memory();
      g.sessionStorage = memory();
      globalThis.fetch = (async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;
    });
    afterEach(() => {
      globalThis.fetch = saved.fetch;
      g.localStorage = saved.localStorage;
      g.sessionStorage = saved.sessionStorage;
    });

    test("рисование закрытой панели не ходит на сервер", () => {
      draw(false);
      expect(calls).toEqual([]);
    });

    test("открытие подготовки зовёт контекст приёма — и только эта загрузка", async () => {
      await loadPrep(appt);
      expect(calls).toContain("/api/clinic/appointments/a-1/context");
      expect(calls.filter((u) => u.includes("/context"))).toHaveLength(1);
    });
  });
});
