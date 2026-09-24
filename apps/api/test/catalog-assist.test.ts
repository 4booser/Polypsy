import { describe, expect, test } from "bun:test";
import { computeProfile, isQuestionVisible, type Answer, type SurveyFull } from "@quizzy/shared";
import { db, eq } from "./fixtures";
import { surveys } from "../src/db/schema";
import { installCatalog } from "../src/lib/catalogInstall";
import { validateAnswers } from "../src/lib/submission";
import { getSurvey } from "../src/lib/surveys";

/**
 * ASSIST на настоящей базе: маршрут вопросов переживает установку.
 *
 * ASSIST — первая методика каталога с условиями показа, и все её переходы
 * держатся на сравнении числа: «Q1 ≥ 1», «Q2 > 0». Движок сравнивает, только
 * если значение условия — число (`typeof value === "number"`). Условие лежит в
 * jsonb; вернись оно из базы строкой, каждое условие молча стало бы ложным, и в
 * живом экземпляре ASSIST показывал бы только Q1 и Q8 — а баллы всех веществ
 * были бы нулём у любого человека. Золотой протокол этого не увидит: он строит
 * методику из описания, минуя базу. Здесь — через установщик и тот же загрузчик,
 * которым методику открывает форма.
 */

describe("ASSIST после установки каталога", () => {
  async function load(): Promise<SurveyFull> {
    await installCatalog();
    const [row] = await db.select().from(surveys).where(eq(surveys.catalogKey, "assist"));
    expect(row, "ASSIST не установлен").toBeTruthy();
    expect(row!.administration, "ASSIST заполняет специалист").toBe("clinician");
    const survey = await getSurvey(row!.id, null, "uk");
    expect(survey).not.toBeNull();
    return survey!;
  }

  /** Пункт по номеру с единицы — в порядке показа */
  const at = (survey: SurveyFull, n: number) =>
    [...survey.questions].sort((a, b) => a.position - b.position)[n - 1]!;
  const pick = (survey: SurveyFull, n: number, option: number): Answer => {
    const q = at(survey, n);
    return { questionId: q.id, optionIds: [q.options.filter((o) => o.kind === "option")[option]!.id] };
  };

  test("условия показа возвращаются числами", async () => {
    const survey = await load();
    const values = survey.questions.flatMap((q) => q.logic.map((r) => r.value));
    expect(values.length).toBeGreaterThan(0);
    expect(values.filter((v) => typeof v !== "number")).toEqual([]);
  });

  test("алкоголь: «да» открывает вопросы о веществе, «нет» — закрывает; балл считается", async () => {
    /*
     * Раскладка бланка: Q1b — 2, Q2b — 13, Q3b — 23, Q4b — 33, Q5b — 42, Q6b — 52,
     * Q7b — 62, Q8 — 71 (см. golden-behaviour.test.ts). Ответы — алкогольная
     * часть примера ВОЗ «Chloe»: 6 + 0 + 5 + 0 + 3 + 0 = 14.
     */
    const survey = await load();
    const answers: Answer[] = [
      ...Array.from({ length: 10 }, (_, i) => pick(survey, i + 1, i === 1 ? 1 : 0)),
      pick(survey, 13, 4), // Q2b щодня
      pick(survey, 23, 0), // Q3b ніколи
      pick(survey, 33, 2), // Q4b щомісяця
      pick(survey, 42, 0), // Q5b ніколи
      pick(survey, 52, 2), // Q6b так, але не за 3 місяці
      pick(survey, 62, 0), // Q7b ні
      pick(survey, 71, 0), // Q8 ні
    ];
    const map = new Map(answers.map((a) => [a.questionId, a]));
    const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, map));
    expect(visible.length, "показано не то, что спрошено").toBe(answers.length);

    // сервер принимает: скрытые обязательные пункты не требуются
    const input = { answers, startedAt: new Date().toISOString(), durationMs: 1, status: "completed", events: [] };
    expect(() => validateAnswers(survey, input as never)).not.toThrow();

    const alcohol = computeProfile(survey, answers).scores.find((s) => s.scaleCode === "ALC")!;
    expect(alcohol.rawScore).toBe(14);
    expect(alcohol.band?.grade).toBe(2);

    // «нет» в Q1b закрывает всё про алкоголь, включая Q3–Q5 при старом ответе Q2b
    const closed = new Map(map);
    closed.set(at(survey, 2).id, pick(survey, 2, 0));
    for (const n of [13, 23, 33, 42, 52, 62]) {
      expect(isQuestionVisible(at(survey, n), survey.questions, closed), `пункт ${n}`).toBe(false);
    }
  });
});
