import { describe, expect, test } from "bun:test";
import { createSurveySchema, validateSurvey, type Issue } from "@quizzy/shared";
import { minimult } from "../minimult";
import { mlo } from "../mlo";
import { sadPersons } from "../sadPersons";
import { sr45 } from "../sr45";

/**
 * Целостность встроенных методик.
 *
 * Проверяется не подсчёт (для него есть золотые протоколы), а структура:
 * ключ не ссылается на несуществующий пункт, полосы интерпретации не рвутся
 * и не накладываются, поправки указывают на существующие шкалы, у каждого
 * пункта есть варианты ответа. Такие поломки не роняют приложение — они
 * молча дают неверный балл, и заметить их можно только проверкой.
 *
 * Прогон идёт без базы: методики описаны файлами, и им незачем ждать
 * поднятого Postgres, чтобы быть проверенными.
 */

const INSTRUMENTS = [
  ["СР-45", sr45],
  ["SAD PERSONS", sadPersons],
  ["Мини-мульт", minimult],
  ["МЛО «Адаптивность»", mlo],
] as const;

function describeIssues(issues: Issue[]): string {
  return issues.map((i) => `${i.level} ${i.where}: ${i.message}`).join("\n");
}

describe("встроенные методики", () => {
  for (const [name, draft] of INSTRUMENTS) {
    test(`${name}: описание принимается схемой`, () => {
      const parsed = createSurveySchema.safeParse(draft);
      if (!parsed.success) {
        throw new Error(
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"),
        );
      }
      expect(parsed.success).toBe(true);
    });

    test(`${name}: структура без ошибок`, () => {
      const issues = validateSurvey(createSurveySchema.parse(draft));
      const errors = issues.filter((i) => i.level === "error");
      if (errors.length) throw new Error(describeIssues(errors));
      expect(errors).toEqual([]);
    });

    test(`${name}: каждый пункт спрашиваемого типа имеет варианты`, () => {
      const parsed = createSurveySchema.parse(draft);
      const naked = parsed.questions.filter(
        (q) => q.type !== "info" && !["text", "longtext", "number", "date"].includes(q.type) && !q.options?.length,
      );
      expect(naked.map((q) => q.title)).toEqual([]);
    });

    test(`${name}: каждая шкала вычислима`, () => {
      /*
       * Балл берётся либо из собственных пунктов (ключ), либо из других шкал
       * (поправки, как у композита ЛАП = ПР + КП + МН). Шкала без того и
       * другого всегда даёт ноль и молча портит профиль.
       */
      const parsed = createSurveySchema.parse(draft);
      const uncomputable = (parsed.scales ?? []).filter(
        (s) => !s.key?.length && !s.corrections?.length,
      );
      expect(uncomputable.map((s) => s.code)).toEqual([]);
    });

    test(`${name}: шкала без полос объясняет, почему их нет`, () => {
      /*
       * Балл без полосы интерпретации — просто число, специалист по нему
       * ничего не скажет. Но есть два законных случая: шкала достоверности
       * работает порогом, а не полосами; и шкала, для которой в пособии нет
       * норм (Ma в Мини-мульте) — её нельзя интерпретировать честно, и это
       * записано в описании прямым текстом.
       *
       * Молчаливое отсутствие полос — единственное, что здесь запрещено:
       * оно неотличимо от забытой таблицы.
       */
      const parsed = createSurveySchema.parse(draft);
      const unexplained = (parsed.scales ?? []).filter(
        (s) =>
          !s.bands?.length &&
          s.validityThreshold === undefined &&
          !s.description,
      );
      expect(unexplained.map((s) => s.code)).toEqual([]);
    });
  }

  test("предупреждения перечислены явно, а не спрятаны", () => {
    /*
     * Предупреждения — это не ошибки, но и не шум: у МЛО часть украинских
     * формулировок ещё не выверена. Тест не запрещает их, а фиксирует
     * текущее число: выросло — кто-то добавил непроверенный контент и должен
     * это заметить.
     */
    const counts = INSTRUMENTS.map(([name, draft]) => {
      const issues = validateSurvey(createSurveySchema.parse(draft));
      return [name, issues.filter((i) => i.level === "warning").length] as const;
    });
    for (const [, count] of counts) expect(count).toBeLessThanOrEqual(WARNING_BUDGET);
  });
});

/** Потолок предупреждений на методику. Снижать можно, повышать — только осознанно. */
const WARNING_BUDGET = 20;
