import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import PatientBooking from "../src/patient/Booking";
import { SLOT_LIMIT, chosenSlot, slotsView } from "../src/patient/slots";

/**
 * Запись на приём в кабинете как состояние формы (w13:uitests).
 *
 * «Свободного времени нет» — ответ, после которого человек перестаёт
 * пытаться записаться. Поэтому он обязан быть правдой: не «ещё грузится»,
 * не «не загрузилось», не «нет связи». А выбранное время, которое заняли,
 * не должно оставаться выбранным: иначе «Записатися» раз за разом упирается
 * в один и тот же отказ.
 */

const slot = (id: string) => ({ id, startsAt: "2026-10-01T09:00:00Z" });

describe("список времени", () => {
  test("пока грузится — не «свободного времени нет»", () => {
    expect(slotsView({ data: null, error: null })).toEqual({ kind: "loading" });
  });

  test("загрузка отказала — ошибка с текстом, а не пустой список", () => {
    expect(slotsView({ data: null, error: "Помилка сервера" })).toEqual({ kind: "failed", error: "Помилка сервера" });
  });

  test("нет связи и списка ещё не было — своё состояние", () => {
    expect(slotsView({ data: null, error: null, offline: true })).toEqual({ kind: "offline" });
  });

  test("пришёл пустой список — вот тогда «свободного времени нет»", () => {
    expect(slotsView({ data: { items: [] }, error: null })).toEqual({ kind: "empty" });
  });

  test("список есть — он и показывается, даже если связь потом пропала", () => {
    const v = slotsView({ data: { items: [slot("a"), slot("b")] }, error: null, offline: true });
    expect(v.kind === "list" && v.times.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("показывается не больше сорока вариантов", () => {
    const many = Array.from({ length: 70 }, (_, i) => slot(`s${i}`));
    const v = slotsView({ data: { items: many }, error: null });
    expect(v.kind === "list" && v.times.length).toBe(SLOT_LIMIT);
  });
});

describe("выбранное время", () => {
  test("время есть в списке — оно выбрано", () => {
    expect(chosenSlot("b", [slot("a"), slot("b")])).toBe("b");
  });

  test("время заняли, список перечитан без него — выбора нет, «Записатися» гаснет", () => {
    expect(chosenSlot("b", [slot("a"), slot("c")])).toBeNull();
  });

  test("время за пределами показанных сорока не считается выбранным", () => {
    const shown = Array.from({ length: SLOT_LIMIT }, (_, i) => slot(`s${i}`));
    expect(chosenSlot("s55", shown)).toBeNull();
    expect(chosenSlot(null, shown)).toBeNull();
  });
});

describe("экран записи в разметке", () => {
  const has = (html: string, key: keyof typeof UI) => {
    const e = UI[key] as { uk: string; ru: string; en?: string };
    return [e.uk, e.ru, e.en].some((t) => !!t && html.includes(t));
  };

  test("первый показ, ответа ещё нет — «завантаження», а не «вільного часу немає»", () => {
    // без сервера загрузка не завершается: экран рисуется ровно в том состоянии, в каком его видят первую секунду
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LangProvider>
          <PatientBooking />
        </LangProvider>
      </MemoryRouter>,
    );
    expect(has(html, "pt.noSlots"), "пока список грузится, экран говорит, что записаться некуда").toBe(false);
    expect(has(html, "common.loading")).toBe(true);
    // и записываться не на что: кнопка выключена, пока время не выбрано
    const e = UI["pt.bookNow"] as { uk: string; ru: string; en?: string };
    const book = [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].find((m) => [e.uk, e.ru, e.en].includes(m[2]!));
    expect(book?.[1]).toMatch(/\sdisabled=""/);
  });
});
