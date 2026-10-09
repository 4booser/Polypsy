import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI, type AppointmentStatus, type AppointmentView, type UiKey } from "@quizzy/shared";
import { api } from "../src/api";
import { LangProvider } from "../src/lang";
import { AppointmentRow, moveOf, rowActions } from "../src/pages/Today";

/**
 * Столбец действий на экране дня стоит на месте.
 *
 * Кнопки в строке прижимались к правому краю, и положение каждой зависело от
 * того, сколько их в этой строке: у записанного «Не пришёл» стоял на кнопку
 * левее края, у неявки такая же по смыслу кнопка — у самого края. Столбец
 * переставал читаться сверху вниз, и одно и то же действие приходилось
 * каждый раз искать глазами заново.
 *
 * Глазами это и ловилось — на снимке экрана, через раз. Поэтому проверяются
 * два правила, которые нельзя выполнить наполовину: мест в строке всегда
 * одинаково, и одна и та же надпись всегда в одном и том же месте.
 */

/*
 * Список статусов собирается из Record, а не пишется массивом.
 *
 * Массив молча устареет: новый статус приёма появится в модели, строка с ним
 * поедет по своим правилам, а проверка останется зелёной, потому что про
 * него не знает. Record заставляет компилятор потребовать новую строку здесь
 * же — забыть нельзя, можно только решить, что с ним делать.
 */
const ALL: Record<AppointmentStatus, true> = {
  booked: true,
  confirmed: true,
  arrived: true,
  in_progress: true,
  done: true,
  no_show: true,
  cancelled: true,
};
const STATUSES = Object.keys(ALL) as AppointmentStatus[];

const appointment = (status: AppointmentStatus): AppointmentView => ({
  id: `a-${status}`,
  slotId: "s-1",
  startsAt: "2026-09-10T09:00:00.000Z",
  endsAt: "2026-09-10T09:30:00.000Z",
  kind: "primary",
  mode: "onsite",
  meetingUrl: null,
  status,
  specialistId: "sp-1",
  specialistName: "Іваненко І. І.",
  room: "214",
  patientId: "p-1",
  patientName: "Савченко Оксана Миколаївна",
  reason: null,
  bookedAt: "2026-09-01T09:00:00.000Z",
  confirmedAt: null,
  offSchedule: false,
  pendingAssignments: 0,
  screeningDone: null,
  /*
   * Ведущий назначен нарочно: иначе в строке появляется «Закрепить за
   * собой», и счёт кнопок перестал бы говорить о столбце действий — а
   * именно его здесь и проверяют.
   */
  leadSpecialistId: "sp-1",
});

interface Cell {
  slot: string;
  cls: string;
  label: string | null;
}

/** Места и их содержимое так, как они доехали до разметки */
function cells(status: AppointmentStatus): Cell[] {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>
        <AppointmentRow a={appointment(status)} busy={false} onStatus={() => {}} onLead={() => {}} />
      </LangProvider>
    </MemoryRouter>,
  );
  const out = [...html.matchAll(/data-slot="([^"]+)" class="([^"]*)">(.*?)<\/div>/g)].map((m) => ({
    slot: m[1]!,
    cls: m[2]!,
    label: (m[3]!.match(/<button[^>]*>(.*?)<\/button>/)?.[1] ?? null)?.replace(/<[^>]*>/g, "") ?? null,
  }));
  /*
   * Кнопки вне мест считаются здесь же, а не отдельной проверкой: столбец из
   * закреплённых мест плюс одна кнопка «как раньше» — это ровно та поломка,
   * от которой заведена проверка, и по числу мест её не видно.
   */
  const loose = (html.match(/<button/g)?.length ?? 0) - out.filter((c) => c.label !== null).length;
  expect(loose, `статус ${status}: ${loose} кнопок строки стоят вне закреплённых мест`).toBe(0);
  return out;
}

describe("места в столбце действий", () => {
  test("мест в строке всегда одинаково, какой бы ни был статус", () => {
    const shape = STATUSES.map((s) => [s, cells(s).map((c) => c.slot).join(" | ")] as const);
    const first = shape[0]!;
    expect(first[1], `у статуса ${first[0]} в столбце нет мест вовсе`).not.toBe("");
    for (const [status, slots] of shape) {
      expect(slots, `статус ${status}: места не те же, что у ${first[0]}`).toBe(first[1]);
    }
  });

  test("ширина места не зависит от того, что в нём стоит", () => {
    /*
     * Ширину задаёт место, а не надпись. Иначе «Завершить» и «Пришёл» дают
     * разные столбцы в соседних строках — при том, что мест поровну.
     */
    const widths = new Map<string, string[]>();
    for (const status of STATUSES) {
      for (const c of cells(status)) {
        widths.set(c.cls, [...(widths.get(c.cls) ?? []), `${status}/${c.slot}`]);
      }
    }
    const kinds = [...widths].map(([cls, where]) => `${cls} → ${where.join(", ")}`);
    expect(kinds.length, `места оформлены по-разному: ${kinds.join(" ; ")}`).toBe(1);
  });

  test("одна и та же кнопка всегда в одном и том же месте", () => {
    const seen = new Map<string, Set<string>>();
    for (const status of STATUSES) {
      for (const c of cells(status)) {
        if (c.label === null) continue;
        seen.set(c.label, (seen.get(c.label) ?? new Set()).add(c.slot));
      }
    }
    const wandering = [...seen].filter(([, slots]) => slots.size > 1);
    expect(
      wandering.map(([label, slots]) => `«${label}» стоит то в ${[...slots].join(", то в ")}`),
    ).toEqual([]);
  });

  test("в строке принятого приёма не нажимают ничего, но место остаётся", () => {
    /*
     * Пустая строка — не частный случай, а условие всего остального: убери
     * место у приёмов без действий, и столбец снова поедет.
     */
    const acts = rowActions("done");
    expect(Object.values(acts).every((a) => a === null), "у принятого приёма появилось действие").toBe(true);
    expect(cells("done").length).toBe(cells("booked").length);
  });
});

/**
 * Шаг назад: снять ошибочное «пришёл» или «начали» (#38, w19:ui).
 *
 * Сервер принимает in_progress → arrived и arrived → booked с волны 18, а
 * кнопки не было — ошибку нажатия «исправляли» переносом. Проверяется: шаг
 * назад есть ровно у двух состояний и ведёт ровно на одну ступень, стоит в
 * левом месте, спрашивает перед запросом, и отказ в вопросе запроса не
 * шлёт.
 */
describe("шаг назад на экране дня", () => {
  /** Текст ключа на любом из языков — проверка не зависит от языка окружения */
  const anyLang = (key: UiKey) => {
    const e = UI[key] as { uk: string; ru: string; en?: string };
    return [e.uk, e.ru, e.en].filter((x): x is string => !!x);
  };

  test("«начали» возвращается в «пришёл», «пришёл» — в «записан»; другим состояниям шага назад нет", () => {
    expect(rowActions("in_progress").offPath).toMatchObject({ to: "arrived", key: "day.undo" });
    expect(rowActions("arrived").offPath).toMatchObject({ to: "booked", key: "day.undo" });
    // вперёд по-прежнему ведёт правое место
    expect(rowActions("in_progress").step?.to).toBe("done");
    expect(rowActions("arrived").step?.to).toBe("in_progress");
    for (const status of STATUSES.filter((s) => s !== "arrived" && s !== "in_progress")) {
      expect(rowActions(status).offPath?.key, `статус ${status}`).not.toBe("day.undo");
    }
  });

  test("кнопка видна в строке «пришёл» и «на приёме» — в левом месте", () => {
    const labels = anyLang("day.undo");
    for (const status of ["arrived", "in_progress"] as const) {
      const left = cells(status).find((c) => c.slot === "offPath");
      expect(labels, `статус ${status}: слева «${left?.label}»`).toContain(left?.label ?? "");
    }
    for (const status of ["booked", "confirmed", "done", "no_show", "cancelled"] as const) {
      const shown = cells(status).map((c) => c.label);
      expect(shown.some((l) => l !== null && labels.includes(l)), `статус ${status}`).toBe(false);
    }
  });

  test("перед шагом назад — вопрос; «нет» — запроса нет", () => {
    const asked: UiKey[] = [];
    const no = (q: UiKey) => {
      asked.push(q);
      return false;
    };
    expect(moveOf(rowActions("arrived").offPath!, no)).toBeNull();
    expect(moveOf(rowActions("in_progress").offPath!, no)).toBeNull();
    expect(asked).toEqual(["day.undoArrived", "day.undoStarted"]);
    // вопрос называет снимаемую отметку и то, куда вернётся приём
    expect(UI["day.undoArrived"].uk).toContain("прийшов");
    expect(UI["day.undoStarted"].uk).toContain("на прийомі");
  });

  test("«да» — уходит шаг назад; ход вперёд вопросов не задаёт", () => {
    const yes = () => true;
    expect(moveOf(rowActions("arrived").offPath!, yes)).toBe("booked");
    expect(moveOf(rowActions("in_progress").offPath!, yes)).toBe("arrived");
    const never = () => {
      throw new Error("ход вперёд спросил подтверждение");
    };
    expect(moveOf(rowActions("booked").step!, never)).toBe("arrived");
    expect(moveOf(rowActions("arrived").step!, never)).toBe("in_progress");
    expect(moveOf(rowActions("booked").offPath!, never)).toBe("no_show");
  });

  describe("запрос", () => {
    /* клиент читает токен из localStorage, которого в bun нет: хранилище в памяти на время проверки */
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
    beforeEach(() => {
      g.localStorage = memory();
      g.sessionStorage = memory();
    });
    afterEach(() => {
      globalThis.fetch = saved.fetch;
      g.localStorage = saved.localStorage;
      g.sessionStorage = saved.sessionStorage;
    });

    test("шаг назад — тот же POST …/status, что и ход вперёд, с прежним состоянием в теле", async () => {
      const calls: { url: string; method: string; body: string }[] = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;
      await api.appointmentStatus("a-1", moveOf(rowActions("arrived").offPath!, () => true)!);
      await api.appointmentStatus("a-2", moveOf(rowActions("in_progress").offPath!, () => true)!);
      expect(calls.map((c) => [c.url, c.method, JSON.parse(c.body)])).toEqual([
        ["/api/clinic/appointments/a-1/status", "POST", { status: "booked" }],
        ["/api/clinic/appointments/a-2/status", "POST", { status: "arrived" }],
      ]);
    });
  });
});
