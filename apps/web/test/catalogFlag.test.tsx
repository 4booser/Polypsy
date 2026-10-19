import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { LangProvider } from "../src/lang";
import { Flag } from "../src/pages/constructor/SurveyList";

/**
 * Признак строки каталога («критичний пункт», «лише за призначенням»,
 * «права не з’ясовано») — значок, который берёт фокус. Имя ему дано, но у
 * безролевого span диктор вправе его не прочесть: без роли критический
 * пункт методики для него не существовал. Мутация: убрать role — проверка
 * роли падает.
 */
describe("признак строки каталога", () => {
  test("значок с именем — изображение, его видно с клавиатуры", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LangProvider>
          <Flag label="Є критичний пункт">
            <svg aria-hidden />
          </Flag>
        </LangProvider>
      </MemoryRouter>,
    );
    const span = /<span[^>]*aria-label="Є критичний пункт"[^>]*>/.exec(html)?.[0] ?? "";
    expect(span, "значка с именем нет").not.toBe("");
    expect(span).toContain('role="img"');
    expect(span).toContain('tabindex="0"');
  });
});
