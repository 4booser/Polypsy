import { describe, expect, test } from "bun:test";
import type { SurveyListItem } from "@quizzy/shared";
import {
  attentionOf,
  dayDiff,
  dueIn,
  grantCounts,
  grantState,
  nextExpiring,
  pluralForm,
  shortDate,
  splitCode,
  tShift,
} from "../src/pages/methods/model";

/*
 * Чистая часть раздела «Методики» (pages/methods/model.ts): код методики из
 * названия, форма слова при числе, короткие даты, состояние назначения,
 * что в каталоге требует внимания, зсув T. Названия — настоящие, из
 * каталога учреждения (apps/api/src/instruments).
 */

describe("код методики из названия", () => {
  test.each([
    ["Депресія (PHQ-9)", "PHQ-9", "Депресія"],
    ["Тривога (GAD-7)", "GAD-7", "Тривога"],
    ["Вживання алкоголю, короткий скринінг (AUDIT-C)", "AUDIT-C", "Вживання алкоголю, короткий скринінг"],
    ["Ознаки СДУГ у дорослих (ASRS-v1.1, 6 запитань)", "ASRS-v1.1", "Ознаки СДУГ у дорослих (6 запитань)"],
    ["Вигорання (Копенгагенський опитувальник, CBI)", "CBI", "Вигорання (Копенгагенський опитувальник)"],
    ["Поширені психічні розлади (SRQ-20, ВООЗ)", "SRQ-20", "Поширені психічні розлади (ВООЗ)"],
    ["Шкала оцінки ризику суїциду (SAD PERSONS)", "SAD PERSONS", "Шкала оцінки ризику суїциду"],
    ["Способи подолання стресу (Brief COPE)", "Brief COPE", "Способи подолання стресу"],
    ["СР-45. Схильність до суїцидальних реакцій", "СР-45", "Схильність до суїцидальних реакцій"],
  ])("«%s» → %s", (title, code, name) => {
    expect(splitCode(title)).toEqual({ code, name });
  });

  test.each([
    "Якість сну (демо)",
    "Самооцінка (шкала Розенберга)",
    "БОО «Адаптивність-200»",
    "Опитувальник Міні-мульт",
    "Відчуття самотності (UCLA, 3 пункти) у підлітків",
  ])("«%s» — без коду, название целиком", (title) => {
    expect(splitCode(title)).toEqual({ code: null, name: title });
  });
});

describe("форма слова при числе", () => {
  test("украинский и русский: один, несколько, много", () => {
    expect([1, 2, 4, 5, 11, 21, 22, 25].map((n) => pluralForm("uk", n))).toEqual([
      "one",
      "few",
      "few",
      "many",
      "many",
      "one",
      "few",
      "many",
    ]);
    expect(pluralForm("ru", 3)).toBe("few");
  });

  test("английский: one и many", () => {
    expect(pluralForm("en", 1)).toBe("one");
    expect(pluralForm("en", 3)).toBe("many");
  });
});

describe("короткие даты", () => {
  const now = new Date(2026, 9, 8, 17, 0);
  test("год — только не текущий", () => {
    expect(shortDate("2026-09-12", now)).toBe("12.09");
    expect(shortDate("2025-02-03", now)).toBe("03.02.2025");
  });
  test("дни считаются по календарю, а не сутками", () => {
    expect(dayDiff(now, new Date(2026, 9, 9, 8, 0))).toBe(1);
    expect(dayDiff(now, new Date(2026, 9, 8, 23, 59))).toBe(0);
    expect(dueIn(7, now)).toBe("2026-10-15");
  });
});

describe("состояние назначения", () => {
  const now = new Date(2026, 9, 8, 17, 0);
  const g = (completed: boolean, expiresAt: string | null) => ({ completed, expiresAt });

  test("пройдено, просрочено, спливає, чекаємо", () => {
    expect(grantState(g(true, "2026-10-01T20:59:59Z"), now)).toBe("done");
    expect(grantState(g(false, new Date(2026, 9, 6, 23, 59).toISOString()), now)).toBe("late");
    expect(grantState(g(false, new Date(2026, 9, 9, 23, 59).toISOString()), now)).toBe("soon");
    expect(grantState(g(false, new Date(2026, 9, 18, 23, 59).toISOString()), now)).toBe("open");
    expect(grantState(g(false, null), now)).toBe("open");
  });

  test("счёт для «Призначення зараз»", () => {
    const list = [
      g(true, null),
      g(false, new Date(2026, 9, 6, 23, 59).toISOString()),
      g(false, new Date(2026, 9, 9, 23, 59).toISOString()),
      g(false, new Date(2026, 9, 14, 23, 59).toISOString()),
      g(false, new Date(2026, 9, 30, 23, 59).toISOString()),
      g(false, null),
    ];
    expect(grantCounts(list, now)).toEqual({ all: 6, open: 5, late: 1, done: 1, expiring: 2, forever: 2 });
    expect(nextExpiring(list, now)).toBe(list[2]!);
  });
});

describe("что требует внимания в каталоге", () => {
  const item = (over: Partial<SurveyListItem>): SurveyListItem =>
    ({
      id: crypto.randomUUID(),
      title: "M",
      status: "published",
      scoringEnabled: true,
      keysVerifiedAt: "2026-09-12T10:00:00Z",
      rightsStatus: "licensed",
      archivedAt: null,
      updatedAt: "2026-10-01T10:00:00Z",
      ...over,
    }) as SurveyListItem;

  test("ключи, права и черновики — только у методик в работе", () => {
    const keys = item({ keysVerifiedAt: null });
    const noScore = item({ keysVerifiedAt: null, scoringEnabled: false });
    const rights = item({ rightsStatus: "unclear" });
    const noRecord = item({ rightsStatus: undefined });
    const retired = item({ keysVerifiedAt: null, rightsStatus: "unclear", archivedAt: "2026-10-02T10:00:00Z" });
    const oldDraft = item({ status: "draft", updatedAt: "2026-09-01T10:00:00Z" });
    const newDraft = item({ status: "draft", updatedAt: "2026-10-07T10:00:00Z" });
    const a = attentionOf([keys, noScore, rights, noRecord, retired, oldDraft, newDraft]);
    expect(a.keys).toEqual([keys]);
    expect(a.rights).toEqual([rights, noRecord]);
    expect(a.drafts).toEqual([newDraft, oldDraft]);
  });
});

describe("зсув середнього T", () => {
  test("как в листе норм: 10·(Mв − Mн)/SDн, одна десятая", () => {
    expect(tShift({ mean: 5.3, sd: 2.4 }, { mean: 7.0 })).toBe(7.1);
    expect(tShift({ mean: 4.4, sd: 2.2 }, { mean: 4.0 })).toBe(-1.8);
  });
  test("без нормы или с нулевым SD — не определён", () => {
    expect(tShift(undefined, { mean: 1 })).toBeNull();
    expect(tShift({ mean: 1, sd: 0 }, { mean: 2 })).toBeNull();
  });
});
