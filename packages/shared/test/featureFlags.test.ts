import { describe, expect, test } from "bun:test";
import {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  audienceIsEmpty,
  emptyAudience,
  featureFlagAudienceSchema,
  flagEnabledFor,
  isFeatureFlagKey,
  isTransientStatus,
  serviceStatusInputSchema,
  type FlagSubject,
} from "../src";

/**
 * Флаги функций и состояние системы — правила, которые делят сервер, веб и
 * мобилка. Здесь проверяется, что правило одно и что оно не включает
 * ничего по умолчанию.
 */

const doctor: FlagSubject = {
  id: "u-doctor",
  role: "admin",
  staffRoles: ["psychologist"],
  surveyGroups: ["g-mlo"],
  departments: ["d-1"],
};
const person: FlagSubject = { id: "u-patient", role: "user", staffRoles: [], surveyGroups: [], departments: [] };

describe("реестр флагов", () => {
  test("каждый ключ с названием и описанием на трёх языках", () => {
    expect(FEATURE_FLAG_KEYS.length).toBeGreaterThan(0);
    for (const key of FEATURE_FLAG_KEYS) {
      const entry = FEATURE_FLAGS[key];
      for (const lang of ["uk", "ru", "en"] as const) {
        expect(entry.title[lang].trim().length, `${key}.title.${lang}`).toBeGreaterThan(0);
        expect(entry.description[lang].trim().length, `${key}.description.${lang}`).toBeGreaterThan(0);
      }
    }
  });

  test("ключ узнаётся только свой, а не унаследованный", () => {
    expect(isFeatureFlagKey(FEATURE_FLAG_KEYS[0]!)).toBe(true);
    expect(isFeatureFlagKey("toString")).toBe(false);
    expect(isFeatureFlagKey("no.such.flag")).toBe(false);
  });
});

describe("кому включён", () => {
  const on = (audience: Partial<ReturnType<typeof emptyAudience>>) => ({
    enabled: true,
    audience: featureFlagAudienceSchema.parse(audience),
  });

  test("нет строки — никому", () => {
    expect(flagEnabledFor(null, doctor)).toBe(false);
    expect(flagEnabledFor(undefined, person)).toBe(false);
  });

  test("главный выключатель сильнее аудитории", () => {
    expect(flagEnabledFor({ enabled: false, audience: featureFlagAudienceSchema.parse({ all: true }) }, doctor)).toBe(false);
  });

  test("каждый разрез включает своих и только своих", () => {
    expect(flagEnabledFor(on({ all: true }), person)).toBe(true);
    expect(flagEnabledFor(on({ roles: ["user"] }), person)).toBe(true);
    expect(flagEnabledFor(on({ roles: ["user"] }), doctor)).toBe(false);
    expect(flagEnabledFor(on({ users: ["u-doctor"] }), doctor)).toBe(true);
    expect(flagEnabledFor(on({ users: ["u-doctor"] }), person)).toBe(false);
    expect(flagEnabledFor(on({ staffRoles: ["psychologist"] }), doctor)).toBe(true);
    expect(flagEnabledFor(on({ surveyGroups: ["g-mlo"] }), doctor)).toBe(true);
    expect(flagEnabledFor(on({ surveyGroups: ["g-other"] }), doctor)).toBe(false);
    expect(flagEnabledFor(on({ departments: ["d-1"] }), doctor)).toBe(true);
  });

  test("пустая аудитория — никому, и это видно", () => {
    const empty = on({});
    expect(audienceIsEmpty(empty.audience)).toBe(true);
    expect(flagEnabledFor(empty, doctor)).toBe(false);
    expect(audienceIsEmpty(on({ roles: ["admin"] }).audience)).toBe(false);
  });

  test("старая строка без нового разреза читается как пустой список, а не падает", () => {
    const parsed = featureFlagAudienceSchema.parse({ users: ["u-doctor"] });
    expect(parsed.departments).toEqual([]);
    expect(featureFlagAudienceSchema.safeParse({ roles: ["root"] }).success).toBe(false);
  });
});

describe("состояние системы", () => {
  test("временные отказы — сеть и 502/503/504; ошибка кода — нет", () => {
    expect([0, 502, 503, 504].every(isTransientStatus)).toBe(true);
    expect([400, 401, 403, 409, 500].some(isTransientStatus)).toBe(false);
  });

  test("время конца — момент с поясом, а не «через час»", () => {
    expect(serviceStatusInputSchema.safeParse({ status: "maintenance", expectedEnd: "2026-09-26T21:30:00+03:00" }).success).toBe(true);
    expect(serviceStatusInputSchema.safeParse({ status: "maintenance", expectedEnd: "через годину" }).success).toBe(false);
    expect(serviceStatusInputSchema.safeParse({ status: "down" }).success).toBe(false);
  });
});
