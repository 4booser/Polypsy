import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { UI, type UiKey } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { GatePanel } from "../src/pages/ops/people2/MfaPolicy";

/**
 * «Другий фактор» техпанели: показ экрана-барьера рядом с политикой.
 *
 * Политику включают, глядя на то, во что упрётся человек без фактора, —
 * значит, показ обязан совпадать с настоящим экраном. Настоящий экран
 * (SecondFactor.tsx, MfaSetupGate) в Polypsy 2.0 стал тремя шагами — QR-код
 * или ключ, проверка, коды восстановления, — а показ остался прежней
 * карточкой с одной кнопкой «Увімкнути», которой на барьере нет.
 */

const html = renderToStaticMarkup(
  <LangProvider>
    <GatePanel />
  </LangProvider>,
);
const uk = (key: UiKey) => (UI[key] as { uk: string }).uk;
const GATE = readFileSync(resolve(import.meta.dir, "../src/pages/ops/people2/SecondFactor.tsx"), "utf8");
const gate = GATE.slice(GATE.indexOf("export function MfaSetupGate"));

describe("показ экрана-барьера второго фактора", () => {
  test("три шага настоящего экрана — по порядку и теми же словами", () => {
    const steps: UiKey[] = ["ax.mg.s1", "ax.mg.s2", "acct.mfa.codesTitle"];
    const at = steps.map((k) => html.indexOf(uk(k)));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // и у настоящего экрана они те же: поменялся барьер — пора менять показ
    for (const k of steps) expect(gate).toContain(`ut("${k}")`);
  });

  test("кнопка — та, что на барьере («Показати QR-код»), а не «Увімкнути» из настройки в учётной записи", () => {
    expect(html).toContain(uk("ax.mg.start"));
    expect(gate).toContain('ut("ax.mg.start")');
    expect(html).not.toContain(`>${uk("acct.mfa.enable")}<`);
  });

  test("заголовок, пометка «обов’язковий крок» и пояснение — как на барьере; выход на месте", () => {
    for (const k of ["mfa.gate.title", "ax.mg.required", "ax.mg.policy", "mfa.gate.sub", "nav.logout"] as UiKey[]) {
      expect(html).toContain(uk(k));
      expect(gate).toContain(`ut("${k}")`);
    }
  });

  test("показ не нажимается и не читается диктором как живой экран", () => {
    expect(html).toMatch(/<div inert="" aria-hidden="true"/);
    expect(html).not.toContain("<button");
  });
});
