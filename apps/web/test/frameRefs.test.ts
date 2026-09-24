import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Номер кадра в докблоке — из своего раздела макета.
 *
 * Долг, ради которого написана проверка: нумерация кадров сменилась, и
 * докблоки сверенных экранов остались со старыми числами. Получилось хуже,
 * чем отсутствие ссылки: PersonGrid.tsx сетки людей ссылался на «f20» —
 * а f20 новой описи это «Створення повідомлення»; карточка пациента — на
 * «f19», то есть на конструктор аналитической модели. Следующая сверка
 * пошла бы по чужим кадрам и «выправила» бы экран по ним.
 *
 * Опись кадров лежит вне репозитория (index.json рядом с самими кадрами), и
 * тянуть её отсюда нельзя: проверка сломалась бы на чужой машине. Поэтому
 * здесь лежит её выжимка — раздел каждого кадра, — а проверка спрашивает
 * одно: упомянут ли кадр ЧУЖОГО раздела. Мелких ошибок внутри раздела (f05
 * вместо f13) она не ловит: их видно вырезкой, а перепутанный раздел —
 * нет.
 */

/** Раздел каждого кадра — выжимка из index.json описи кадров */
const SECTION: Record<string, string> = {
  f00: "public", f01: "login", f02: "people", f03: "other", f04: "people",
  f05: "patients", f06: "groups", f07: "tests", f08: "statistics", f09: "statistics",
  f10: "analytics", f11: "messages", f12: "tests", f13: "patients", f14: "groups",
  f15: "tests", f16: "tests", f17: "statistics", f18: "statistics", f19: "analytics",
  f20: "messages", f21: "tests", f22: "tests", f23: "statistics", f24: "statistics",
  f25: "analytics", f26: "messages", f27: "tests", f28: "tests", f29: "statistics",
  f30: "people", f31: "people", f32: "tests", f33: "tests", f34: "people",
  f35: "people", f36: "patients", f37: "patients", f38: "tests", f39: "other",
  f40: "people", f41: "people", f42: "people", f43: "people", f44: "organisations",
  f45: "organisations", f46: "other", f47: "people", f48: "people", f49: "people",
  f50: "people", f51: "organisations", f52: "organisations",
};

/**
 * Экраны сверки «Пацієнти» и «Групи» и разделы, на которые им можно
 * ссылаться. Общие места (ui/*, shell/*) сюда не входят: примитив живёт
 * сразу во всех разделах, и любой номер для него законен.
 */
const SCREENS: [string, string[]][] = [
  ["src/pages/Patients.tsx", ["patients", "groups"]],
  ["src/pages/patientCard/PatientCard.tsx", ["patients", "groups"]],
  ["src/pages/patientGroups/PatientGroups.tsx", ["patients", "groups", "tests"]],
  ["src/pages/patientGroups/PatientGroupCard.tsx", ["patients", "groups"]],
  ["src/pages/patientGroups/PersonGrid.tsx", ["patients", "groups"]],
  ["src/pages/Conclusion.tsx", ["patients", "groups"]],
  ["src/components/ConclusionEditor.tsx", ["patients", "groups"]],
];

/* «f13», «f13_2», но не «f130» и не хвост слова */
const REF = /\bf(\d\d)(?:_\d)?\b/g;

describe("номера кадров в докблоках", () => {
  for (const [file, allowed] of SCREENS) {
    test(`${file}: только кадры ${allowed.join("/")}`, () => {
      const text = readFileSync(resolve(import.meta.dir, "..", file), "utf8");
      const wrong: string[] = [];
      for (const m of text.matchAll(REF)) {
        const id = `f${m[1]}`;
        const section = SECTION[id];
        if (!section) {
          wrong.push(`${m[0]} — такого кадра в описи нет`);
        } else if (!allowed.includes(section)) {
          wrong.push(`${m[0]} — это раздел «${section}»`);
        }
      }
      expect([...new Set(wrong)], `чужие кадры: ${[...new Set(wrong)].join("; ")}`).toEqual([]);
    });
  }

  test("опись прочитана целиком: 53 кадра", () => {
    /* сторож самого сторожа: обрезанная таблица пропускала бы всё подряд */
    expect(Object.keys(SECTION).length).toBe(53);
  });
});
