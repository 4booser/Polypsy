import { describe, expect, test } from "bun:test";
import { clipAtWord, instrumentCode, instrumentMeasure } from "./format";

/**
 * Короткое имя методики — над графиком «Динаміки», в строке «Клінічної
 * картини», в реестре и в ящике заключения. Примеры — названия каталога
 * после вычитки «Назва (КОД)» и методики учреждения, у которых кода в
 * скобках нет; плюс прежние ошибки: «Ознаки СДУГ у дорослих (ASRS-v1» и
 * название целиком у CIWA-Ar, Brief COPE, RSES и Flourishing.
 */
describe("instrumentCode", () => {
  test("код — последняя скобка, регистр и длина не важны", () => {
    expect(instrumentCode("Депресія (PHQ-9)")).toBe("PHQ-9");
    expect(instrumentCode("Ознаки СДУГ у дорослих (ASRS-6)")).toBe("ASRS-6");
    expect(instrumentCode("Ознаки СДУГ у дорослих (ASRS-v1.1)")).toBe("ASRS-v1.1");
    expect(instrumentCode("Синдром відміни алкоголю (CIWA-Ar)")).toBe("CIWA-Ar");
    expect(instrumentCode("Способи подолання стресу (Brief COPE)")).toBe("Brief COPE");
    expect(instrumentCode("Психологічне процвітання (Flourishing Scale)")).toBe("Flourishing Scale");
    expect(instrumentCode("Професійна якість життя (ProQOL 5)")).toBe("ProQOL 5");
    expect(instrumentCode("Шкала депресії Гамільтона (HAM-D-17)")).toBe("HAM-D-17");
    expect(instrumentCode("Шкала оцінки ризику суїциду (SAD PERSONS)")).toBe("SAD PERSONS");
    // кириллицей — тоже код
    expect(instrumentCode("Опитувальник (СР-45)")).toBe("СР-45");
    // имя в скобках — с заглавной
    expect(instrumentCode("Самооцінка (шкала Розенберга)")).toBe("Шкала Розенберга");
    // из перечня в скобках — первая часть, без источника
    expect(instrumentCode("Поширені психічні розлади (SRQ-20, ВООЗ)")).toBe("SRQ-20");
    expect(instrumentCode("Відчуття самотності (UCLA, 3 пункти)")).toBe("UCLA");
  });

  test("пометка в скобках — не код: тогда название, длинное — по границе слова", () => {
    expect(instrumentCode("Якість сну (демо)")).toBe("Якість сну (демо)");
    expect(instrumentCode("Контрольний замір стану (демо)")).toBe("Контрольний замір стану…");
  });

  test("код в начале названия и сокращение перед названием в кавычках", () => {
    expect(instrumentCode("СР-45. Схильність до суїцидальних реакцій")).toBe("СР-45");
    expect(instrumentCode("БОО «Адаптивність-200»")).toBe("БОО");
    expect(instrumentCode("МЛО «Адаптивность-200»")).toBe("МЛО");
  });

  test("методики учреждения — по ключу каталога и языку", () => {
    expect(instrumentCode("Опитувальник Міні-мульт", { catalogKey: "minimult", lang: "uk" })).toBe("Міні-мульт");
    expect(instrumentCode("Опросник Мини-мульт", { catalogKey: "minimult", lang: "ru" })).toBe("Мини-мульт");
    expect(instrumentCode("БОО «Адаптивність-200»", { catalogKey: "mlo", lang: "uk" })).toBe("БОО");
    expect(instrumentCode("МЛО «Адаптивность-200»", { catalogKey: "mlo", lang: "ru" })).toBe("МЛО");
    // ключ без строки в таблице — разбор названия; чужое имя свойства — не ключ
    expect(instrumentCode("Депресія (PHQ-9)", { catalogKey: "phq9", lang: "uk" })).toBe("PHQ-9");
    expect(instrumentCode("Опитувальник (СР-45)", { catalogKey: "constructor" })).toBe("СР-45");
    // без ключа — название целиком: оно короче предела и середину слова не режет
    expect(instrumentCode("Опитувальник Міні-мульт")).toBe("Опитувальник Міні-мульт");
  });
});

describe("clipAtWord", () => {
  test("режет по границе слова, а не посреди", () => {
    expect(clipAtWord("Шкала Розенберга", 20)).toBe("Шкала Розенберга");
    expect(clipAtWord("Шкала Розенберга", 14)).toBe("Шкала…");
    expect(clipAtWord("Делірій і когнітивне порушення: швидка оцінка", 24)).toBe("Делірій і когнітивне…");
    // одно длинное слово — целым и без многоточия: ничего не отброшено
    expect(clipAtWord("Самоспівчуттєвість", 10)).toBe("Самоспівчуттєвість");
    expect(clipAtWord("Самоспівчуттєвість і усвідомленість", 10)).toBe("Самоспівчуттєвість…");
  });
});

describe("instrumentMeasure", () => {
  test("название без кода — что меряли; пометка в скобках остаётся", () => {
    expect(instrumentMeasure("Депресія (PHQ-9)")).toBe("Депресія");
    expect(instrumentMeasure("Синдром відміни алкоголю (CIWA-Ar)")).toBe("Синдром відміни алкоголю");
    expect(instrumentMeasure("Поширені психічні розлади (SRQ-20, ВООЗ)")).toBe("Поширені психічні розлади");
    expect(instrumentMeasure("СР-45. Схильність до суїцидальних реакцій")).toBe("Схильність до суїцидальних реакцій");
    expect(instrumentMeasure("БОО «Адаптивність-200»")).toBe("Адаптивність-200");
    expect(instrumentMeasure("Опитувальник Міні-мульт")).toBe("Опитувальник Міні-мульт");
    expect(instrumentMeasure("Якість сну (демо)")).toBe("Якість сну (демо)");
  });
});
