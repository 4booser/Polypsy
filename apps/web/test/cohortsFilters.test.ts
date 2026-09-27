import { describe, expect, test } from "bun:test";
import { isDateInput } from "@quizzy/shared";
import {
  activeFilters,
  paramsFromSpec,
  resultView,
  specErrors,
  specFromParams,
  withSpec,
} from "../src/pages/cohorts/model";

/**
 * «Добір людей»: поведение отбора в адресе и того, что стоит на месте
 * результата (w13:uitests).
 *
 * Соседний cohorts.test.ts закрепляет поездку правила через адрес и метки
 * условий. Здесь — то, что ломалось на живых ссылках: даты, похожие на
 * даты, значения длиннее пределов сервера, правка условий поверх открытой
 * сохранённой вибірки и результат, который «грузится» и не загрузится.
 */

const url = (s: string) => new URLSearchParams(s);
const SURVEY = "0b8f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

describe("кривое значение в адресе", () => {
  test("несуществующий день — не условие: сервер (calendarDay) его не примет", () => {
    /*
     * До правки проверкой была регулярка ГГГГ-ММ-ДД, и «2026-02-31» уходило
     * на сервер — предпросмотр открывался отказом «Невірний запит».
     */
    for (const bad of ["2026-02-31", "2026-13-01", "0000-01-01", "2026-9-1", "вчора", "2026-09-10T10:00"]) {
      const spec = specFromParams(url(`from=${bad}&to=${bad}`));
      expect(spec.from, bad).toBeUndefined();
      expect(spec.to, bad).toBeUndefined();
    }
    const ok = specFromParams(url("from=2024-02-29&to=2026-09-30"));
    expect([ok.from, ok.to]).toEqual(["2024-02-29", "2026-09-30"]);
    expect(isDateInput(ok.from, { dayOnly: true })).toBe(true);
  });

  test("значения длиннее пределов сервера не применяются, сверх числа условий — не читаются", () => {
    const long = "р".repeat(121);
    const spec = specFromParams(
      url(
        [
          `unit=${long}`,
          "unit=Рота 1",
          `place=${"м".repeat(161)}`,
          "place=Київ",
          `survey=${SURVEY}`,
          `scale=${"k".repeat(41)}~>=~5`,
          ...Array.from({ length: 12 }, (_, i) => `scale=S${i}~<~${i}`),
        ].join("&"),
      ),
    );
    expect(spec.units).toEqual(["Рота 1"]);
    expect(spec.localities).toEqual(["Київ"]);
    expect(spec.scales?.length).toBe(10);
    expect(spec.scales?.[0]?.code).toBe("S0");

    const many = specFromParams(url(Array.from({ length: 60 }, (_, i) => `unit=Рота ${i}`).join("&")));
    expect(many.units?.length).toBe(50);
  });

  test("возраст вне 0…120 и не целый — не условие", () => {
    expect(specFromParams(url("age_from=-1&age_to=121"))).toEqual({});
    expect(specFromParams(url("age_from=25.5&age_to=abc"))).toEqual({});
  });

  test("условие по шкале без методики не применяется: код шкалы — имя внутри методики", () => {
    expect(specFromParams(url("scale=L~<=~50")).scales).toBeUndefined();
  });
});

describe("правка условий в адресе", () => {
  test("правка идёт от актуального адреса: второе быстрое нажатие не теряет первое", () => {
    const first = withSpec(url("sex=male"), { ageMin: 25 });
    const second = withSpec(first, { minSeverity: "moderate" });
    expect(specFromParams(second)).toEqual({ sex: "male", ageMin: 25, minSeverity: "moderate" });
  });

  test("смена методики снимает условия по шкалам прежней", () => {
    const now = url(`survey=${SURVEY}&scale=L~<=~50&scale=F~>~70`);
    const next = withSpec(now, { surveyId: "another", scales: [] });
    expect(specFromParams(next)).toEqual({ surveyId: "another" });
  });

  test("открытая сохранённая остаётся открытой: правка делает её «зміненою», а не закрытой", () => {
    const next = withSpec(url("saved=abc&sex=female"), { sex: null });
    expect(next.get("saved")).toBe("abc");
    expect(next.has("sex")).toBe(false);
  });

  test("«скинути» снимает все условия, но не открытую сохранённую", () => {
    const next = paramsFromSpec({}, url(`saved=abc&sex=male&unit=Рота 1&survey=${SURVEY}&risk=1`));
    expect(next.toString()).toBe("saved=abc");
  });

  test("снятие метки условия убирает ровно его", () => {
    const spec = specFromParams(url("unit=Рота 1&unit=Рота 2&risk=1"));
    const rota1 = activeFilters(spec, (k) => k).find((f) => f.id === "unit:Рота 1")!;
    expect(rota1.without(spec)).toEqual({ units: ["Рота 2"], riskOnly: true });
  });
});

describe("что стоит на месте результата", () => {
  test("перевёрнутый диапазон из ссылки без прежнего числа — «виправте умови», а не вечный скелет", () => {
    /* до правки здесь был скелет «загружается»: запрос выключен и не придёт никогда */
    const spec = specFromParams(url("age_from=45&age_to=25"));
    const invalid = !!specErrors(spec).age;
    expect(invalid).toBe(true);
    expect(resultView({ invalid, hasPreview: false, error: null })).toBe("invalid");
  });

  test("ошибка набора при прежнем числе — прежнее число, приглушённое", () => {
    expect(resultView({ invalid: true, hasPreview: true, error: null })).toBe("result");
  });

  test("отказ сервера — ошибка с «повторити», даже если прежнее число было", () => {
    expect(resultView({ invalid: false, hasPreview: true, error: "Методика недоступна" })).toBe("error");
    expect(resultView({ invalid: false, hasPreview: false, error: "Методика недоступна" })).toBe("error");
  });

  test("идёт первый счёт или нет связи до первого ответа — скелет; число есть — число", () => {
    /* обрыв связи — не ошибка: о нём говорит строка оболочки, запрос ждёт связи */
    expect(resultView({ invalid: false, hasPreview: false, error: null })).toBe("loading");
    expect(resultView({ invalid: false, hasPreview: true, error: null })).toBe("result");
  });
});
