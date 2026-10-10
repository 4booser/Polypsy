import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { answerScore, computeScores, isAnswered, type Answer, type Option, type Question } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { TouchArea } from "../src/ui/primitives";
import {
  DateInput,
  MatrixInput,
  pickDate,
  pickMatrix,
  RankingInput,
  toggleRank,
  type RunnerAnswer,
} from "../src/patient/answerInputs";
import { makeScale, makeSurvey, yesNoQuestion } from "../../../packages/shared/test/fixtures";

/**
 * Матрица, ранжирование и дата в веб-кабинете (#168).
 *
 * Веб-кабинет — единственный канал пациента без телефона. Runner рисовал
 * матрицу строкой кнопок без строк и клал ответ в optionIds; общий
 * isAnswered ждёт answer.matrix — и «Далі» на обязательной матрице
 * демо-методики не включалось никогда. Ранжирование и дата тоже не
 * считались отвеченными, а необязательная матрица теряла балл.
 *
 * Здесь проверяется форма ответа — та же, что у мобилки и сервера, — и то,
 * что общий движок считает по ней тот же балл.
 */

function opt(qid: string, id: string, kind: "row" | "option", text: string, score: number, position: number): Option {
  return { id: `${qid}-${id}`, questionId: qid, text, keyCode: null, score, kind, position, riskFlag: false, riskLabel: null, riskSeverity: null };
}

/** Матрица как в «Скрининге эмоционального состояния»: четыре строки, частота 0–3 */
function matrixQuestion(): Question {
  const base = yesNoQuestion(0);
  const q = base.id;
  return {
    ...base,
    type: "matrix",
    title: "Как часто за последние две недели вас беспокоило:",
    options: [
      opt(q, "c0", "option", "Ни разу", 0, 0),
      opt(q, "c1", "option", "Несколько дней", 1, 1),
      opt(q, "c2", "option", "Более половины дней", 2, 2),
      opt(q, "c3", "option", "Почти каждый день", 3, 3),
      opt(q, "r1", "row", "Нервозность", 0, 4),
      opt(q, "r2", "row", "Беспокойство", 0, 5),
      opt(q, "r3", "row", "Трудно расслабиться", 0, 6),
      opt(q, "r4", "row", "Раздражительность", 0, 7),
    ],
  };
}

function rankingQuestion(): Question {
  const base = yesNoQuestion(1);
  const q = base.id;
  return {
    ...base,
    type: "ranking",
    options: [opt(q, "a", "option", "Сон", 0, 0), opt(q, "b", "option", "Робота", 0, 1), opt(q, "c", "option", "Сім'я", 0, 2)],
  };
}

const rows = (q: Question) => q.options.filter((o) => o.kind === "row");
const columns = (q: Question) => q.options.filter((o) => o.kind === "option");

/** Как Runner копит ответ пункта: { ...прежний, ...новый } (Runner.tsx, set) */
const merge = (prev: RunnerAnswer | undefined, next: RunnerAnswer): RunnerAnswer => ({ ...prev, ...next });

/** То, что собирает мобилка на тех же нажатиях (apps/mobile/src/components/QuestionInput.tsx, case "matrix") */
function mobileMatrix(q: Question, picks: number[]): Answer {
  let picked: Record<string, string> = {};
  rows(q).forEach((row, i) => {
    picked = { ...picked, [row.id]: columns(q)[picks[i]!]!.id };
  });
  return { questionId: q.id, matrix: picked };
}

describe("матрица", () => {
  test("ответ — answer.matrix по строкам; все строки — отвечено, не все — «Далі» закрыто", () => {
    const q = matrixQuestion();
    let a: RunnerAnswer | undefined;
    const [r1, r2, r3, r4] = rows(q);
    const c = columns(q);
    a = merge(a, pickMatrix(a, r1!.id, c[0]!.id));
    a = merge(a, pickMatrix(a, r2!.id, c[1]!.id));
    a = merge(a, pickMatrix(a, r3!.id, c[3]!.id));
    expect(isAnswered(q, { questionId: q.id, ...a }), "три строки из четырёх — уже отвечено").toBe(false);
    a = merge(a, pickMatrix(a, r4!.id, c[2]!.id));
    // передумал в первой строке — значение заменяется, а не добавляется
    a = merge(a, pickMatrix(a, r1!.id, c[1]!.id));

    expect(a.matrix).toEqual({ [r1!.id]: c[1]!.id, [r2!.id]: c[1]!.id, [r3!.id]: c[3]!.id, [r4!.id]: c[2]!.id });
    expect(a.optionIds, "матрица снова легла в optionIds").toBeUndefined();
    expect(isAnswered(q, { questionId: q.id, ...a })).toBe(true);
  });

  test("балл — как у мобилки на тех же нажатиях: и за пункт, и по шкале", () => {
    const q = matrixQuestion();
    const picks = [1, 1, 3, 2];
    let a: RunnerAnswer | undefined;
    rows(q).forEach((row, i) => {
      a = merge(a, pickMatrix(a, row.id, columns(q)[picks[i]!]!.id));
    });
    const web: Answer = { questionId: q.id, ...a };
    const mobile = mobileMatrix(q, picks);
    expect(web.matrix).toEqual(mobile.matrix!);
    expect(answerScore(q, web)).toBe(7);
    expect(answerScore(q, web)).toBe(answerScore(q, mobile));

    const scale = makeScale({ code: "ANX", items: [{ questionId: q.id, matchKey: null, weight: 1 }] });
    const survey = makeSurvey([q], [scale]);
    const webScores = computeScores(survey, [web]);
    expect(webScores.map((s) => s.rawScore)).toEqual([7]);
    expect(webScores).toEqual(computeScores(survey, [mobile]));
  });

  test("разметка: строка — подпись группы, столбцы — кнопки с состоянием", () => {
    const q = matrixQuestion();
    const answer = pickMatrix(undefined, rows(q)[0]!.id, columns(q)[2]!.id);
    const html = renderToStaticMarkup(
      <LangProvider>
        <TouchArea>
          <MatrixInput question={q} answer={answer} onChange={() => {}} />
        </TouchArea>
      </LangProvider>,
    );
    for (const row of rows(q)) expect(html).toContain(row.text);
    expect(html.match(/role="group"/g)?.length).toBe(4);
    expect(html.match(/aria-pressed="(true|false)"/g)?.length).toBe(16);
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
  });
});

describe("ранжирование", () => {
  test("нажатия по порядку дают answer.ranking; все расставлены — отвечено; повторное нажатие снимает", () => {
    const q = rankingQuestion();
    const [a1, b1, c1] = columns(q);
    let a: RunnerAnswer | undefined;
    a = merge(a, toggleRank(a, b1!.id));
    a = merge(a, toggleRank(a, a1!.id));
    expect(isAnswered(q, { questionId: q.id, ...a })).toBe(false);
    a = merge(a, toggleRank(a, c1!.id));
    expect(a.ranking).toEqual([b1!.id, a1!.id, c1!.id]);
    expect(isAnswered(q, { questionId: q.id, ...a })).toBe(true);

    a = merge(a, toggleRank(a, a1!.id));
    expect(a.ranking).toEqual([b1!.id, c1!.id]);
    expect(isAnswered(q, { questionId: q.id, ...a })).toBe(false);
  });

  test("разметка: подсказка, расставленные с местом, остальные — с местом, куда встанут", () => {
    const q = rankingQuestion();
    const html = renderToStaticMarkup(
      <LangProvider>
        <RankingInput question={q} answer={toggleRank(undefined, columns(q)[1]!.id)} onChange={() => {}} />
      </LangProvider>,
    );
    expect(html).toContain("<ol");
    expect(html).toContain("1: Робота");
    expect(html).toContain("Сон. ");
    expect(html.match(/<button/g)?.length).toBe(3);
  });
});

describe("дата", () => {
  test("значение поля даты — answer.date; пустое поле — не отвечено", () => {
    const q: Question = { ...yesNoQuestion(2), type: "date", options: [] };
    const a = pickDate("2026-10-11");
    expect(a).toEqual({ date: "2026-10-11" });
    expect(isAnswered(q, { questionId: q.id, ...a })).toBe(true);
    expect(isAnswered(q, { questionId: q.id, ...merge(a, pickDate("")) })).toBe(false);
  });

  test("поле даты названо вопросом — сторож кабинета его пропускает", () => {
    const html = renderToStaticMarkup(
      <LangProvider>
        <TouchArea>
          <DateInput answer={{ date: "2026-10-11" }} onChange={() => {}} labelledBy="q-title" />
        </TouchArea>
      </LangProvider>,
    );
    expect(html).toContain('type="date"');
    expect(html).toContain('aria-labelledby="q-title"');
    expect(html).toContain('value="2026-10-11"');
  });
});

test("Runner ведёт матрицу, ранжирование и дату в свои поля, а не в кнопки вариантов", () => {
  const runner = readFileSync(resolve(import.meta.dir, "../src/patient/Runner.tsx"), "utf8");
  const branch = (type: string) => runner.indexOf(`current.type === "${type}"`);
  const generic = runner.indexOf("choices.length ? (");
  for (const type of ["matrix", "ranking", "date"]) {
    expect(branch(type), `у ${type} нет своей ветки`).toBeGreaterThan(0);
    expect(branch(type), `${type} проверяется после общей кнопочной ветки`).toBeLessThan(generic);
  }
});
