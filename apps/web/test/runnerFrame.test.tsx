import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UI, type Question } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { TouchArea } from "../src/ui/primitives";
import { SCALE_BUTTONS_MAX, ScaleInput, scaleEndLabel, scalePoints } from "../src/patient/answerInputs";
import { RunnerIntro, canGoBack, hasIntro } from "../src/patient/Runner";
import { yesNoQuestion } from "../../../packages/shared/test/fixtures";

/**
 * Рамка методики в веб-кабинете (#170): инструкция, диапазон и подписи
 * шкалы, запрет возврата.
 *
 * Кабинет проводил методику без инструкции — а рамка PHQ-9 «за останні 2
 * тижні» есть только в ней; шкалу сна с обратным ключом 0–10 «Очень
 * плохо…Отлично» рисовал пустым числовым полем — ответ в обратную сторону
 * инвертировал балл; кнопку «Назад» показывал и там, где автор методики
 * возврат запретил. Мобилка всё это делала.
 */

const draw = (node: ReactNode) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);

/** Текст ключа на любом из языков — проверка не зависит от языка окружения */
const has = (html: string, key: keyof typeof UI) => {
  const e = UI[key] as { uk: string; ru: string; en?: string };
  return [e.uk, e.ru, e.en].some((t) => !!t && html.includes(t));
};

const RUNNER = readFileSync(resolve(import.meta.dir, "../src/patient/Runner.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** Шкала сна из демо-методики: ползунок 0–10, обратный ключ */
const sleep = (over: Partial<Question> = {}): Question => ({
  ...yesNoQuestion(0),
  type: "slider",
  title: "Оцените качество сна",
  minValue: 0,
  maxValue: 10,
  step: 1,
  minLabel: "Очень плохо",
  maxLabel: "Отлично",
  reverseScored: true,
  options: [],
  ...over,
});

const scale = (q: Question, number?: number) =>
  draw(
    <TouchArea>
      <h1 id="q">{q.title}</h1>
      <ScaleInput question={q} answer={number === undefined ? undefined : { number }} onChange={() => {}} labelledBy="q" />
    </TouchArea>,
  );

describe("инструкция — до первого пункта", () => {
  test("есть текст инструкции — есть экран инструкции; пустой — нет", () => {
    expect(hasIntro({ instructions: "Як часто за останні 2 тижні вас турбувало…" })).toBe(true);
    expect(hasIntro({ instructions: null })).toBe(false);
    expect(hasIntro({ instructions: "  \n " })).toBe(false);
  });

  test("экран: название, инструкция, сколько пунктов и «Почати»", () => {
    const html = draw(
      <RunnerIntro
        survey={{ title: "PHQ-9", instructions: "Як часто за останні 2 тижні вас турбувало…" }}
        count={9}
        onStart={() => {}}
        onLeave={() => {}}
      />,
    );
    expect(html).toContain("PHQ-9");
    expect(html).toContain("Як часто за останні 2 тижні вас турбувало…");
    expect(has(html, "ms.start")).toBe(true);
    expect(has(html, "ms.questions")).toBe(true);
    // сколько пунктов — числом рядом с подписью: «Питань: 9»
    const q = UI["ms.questions"] as { uk: string; ru: string; en?: string };
    expect([q.uk, q.ru, q.en].some((t) => !!t && html.includes(`${t}: 9`))).toBe(true);
    // уйти с инструкции можно «Пізніше»; «Вийти з методики» — на полосе прохождения над любым экраном
    expect(has(html, "ptw.later")).toBe(true);
    expect(RUNNER).toContain("<RunnerBar");
    // начатое на устройстве — «Продовжити» и «Почати заново»
    const resumed = draw(
      <RunnerIntro
        survey={{ title: "PHQ-9", instructions: "т" }}
        count={9}
        onStart={() => {}}
        onLeave={() => {}}
        resume={{ answered: 3, savedAt: null }}
        onRestart={() => {}}
      />,
    );
    expect(has(resumed, "ptw.restart")).toBe(true);
    expect(has(resumed, "ptw.continue")).toBe(true);
  });

  test("Runner показывает инструкцию раньше первого пункта", () => {
    const intro = RUNNER.indexOf("<RunnerIntro");
    expect(intro, "Runner не рисует экран инструкции").toBeGreaterThan(0);
    expect(RUNNER).toContain("!started && hasIntro(survey)");
    expect(intro, "инструкция рисуется после пункта").toBeLessThan(RUNNER.indexOf("id={titleId}"));
  });
});

describe("шкала и ползунок: диапазон и подписи концов", () => {
  test("деления — от min до max с шагом, умолчания как у мобилки", () => {
    expect(scalePoints(sleep())).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(scalePoints(sleep({ minValue: 1, maxValue: 7 }))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // шаг в плавающей точке не теряет последнее деление
    expect(scalePoints(sleep({ minValue: 0, maxValue: 0.5, step: 0.1 }))).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(scalePoints(sleep({ minValue: null, maxValue: null, step: null }))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // нулевой шаг не уводит в бесконечный цикл
    expect(scalePoints(sleep({ step: 0 }))).toHaveLength(11);
  });

  test("подпись конца — с числом; без слова — без подписи", () => {
    expect(scaleEndLabel(0, "Очень плохо")).toBe("0 — Очень плохо");
    expect(scaleEndLabel(10, null)).toBeNull();
    expect(scaleEndLabel(10, "  ")).toBeNull();
  });

  test("шкала сна: одиннадцать делений кнопками и подписи обоих концов", () => {
    const html = scale(sleep(), 7);
    expect(html).toContain("0 — Очень плохо");
    expect(html).toContain("10 — Отлично");
    expect(html.match(/<button/g)?.length).toBe(11);
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>7</);
    // диктор слышит у края слово, а не голое число
    expect(html).toContain('aria-label="0 — Очень плохо"');
    // группа делений названа вопросом
    expect(html).toContain('role="group" aria-labelledby="q"');
    // голого поля без границ больше нет
    expect(html).not.toContain('type="number"');
  });

  test("шкала без подписей — деления всё равно видны", () => {
    const html = scale(sleep({ minLabel: null, maxLabel: null, minValue: 1, maxValue: 5 }));
    expect(html.match(/<button/g)?.length).toBe(5);
    expect(html).toMatch(/>1<\/button>/);
    expect(html).toMatch(/>5<\/button>/);
  });

  test("делений больше, чем помещается кнопками, — поле с границами и видимым диапазоном", () => {
    const q = sleep({ type: "scale", minValue: 0, maxValue: 100, minLabel: "Немає болю", maxLabel: "Нестерпний біль" });
    expect(scalePoints(q).length).toBeGreaterThan(SCALE_BUTTONS_MAX);
    const html = scale(q, 40);
    expect(html).toContain('type="number"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="100"');
    expect(html).toContain('value="40"');
    const hint = UI["qi.rangeHint"];
    expect([hint.uk, hint.ru, hint.en].some((t) => html.includes(t.replace("{min}", "0").replace("{max}", "100")))).toBe(true);
    expect(html).toContain("0 — Немає болю");
    expect(html).toContain("100 — Нестерпний біль");
  });

  test("Runner ведёт шкалу и ползунок в ScaleInput, а не в числовое поле", () => {
    expect(RUNNER).toContain('current.type === "scale" || current.type === "slider" ? (');
    expect(RUNNER).toContain("<ScaleInput");
    expect(RUNNER).not.toContain('["scale", "slider", "number"].includes(current.type)');
  });
});

describe("allowBack", () => {
  test("возврат запрещён — «Назад» нет ни на одном пункте", () => {
    for (const step of [0, 1, 5]) expect(canGoBack({ allowBack: false }, step)).toBe(false);
  });

  test("возврат разрешён — «Назад» со второго пункта", () => {
    expect(canGoBack({ allowBack: true }, 0)).toBe(false);
    expect(canGoBack({ allowBack: true }, 1)).toBe(true);
  });

  test("кнопку «Назад» Runner рисует по allowBack и включает по canGoBack", () => {
    // запрещён возврат — кнопки нет вовсе; на первом пункте — есть, но выключена
    expect(RUNNER).toContain("survey.allowBack !== false ? (");
    expect(RUNNER).toContain("disabled={!canGoBack(survey, step)}");
    expect(RUNNER).not.toContain("{step > 0 ? (");
  });
});
