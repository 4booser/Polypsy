import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { SurveyListItem } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { SurveyOptions, TestPicker } from "../src/pages/analytics/Editor";
import { ANY_TEST } from "../src/pages/analytics/model";

/**
 * Селект методики в форме модели не теряет сохранённый тест, которого нет в
 * списке api.surveys(): снятую с использования или чужую методику список не
 * отдаёт, и без своей опции контролируемый <select> рисовался бы пустым, а
 * при сохранении идентификатор уходил бы на сервер молча.
 *
 * Проверяется разметка, а не картинка: глазом пустое поле «тест снят» от
 * пустого поля «тест ещё не выбран» не отличить — оба выглядят как макет.
 */

const listed = [{ id: "sv1", title: "Шкала Бека" }] as unknown as SurveyListItem[];

const render = (node: ReactElement) =>
  renderToStaticMarkup(
    <LangProvider>
      <select>{node}</select>
    </LangProvider>,
  );

const options = (html: string) => [...html.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);

describe("опции селекта методик", () => {
  test("выбранная есть в списке — опции только из списка, без дублей", () => {
    expect(options(render(<SurveyOptions surveys={listed} current="sv1" loaded={{}} />))).toEqual([["sv1", "Шкала Бека"]]);
  });

  test("«не выбрано» и «будь-який тест» сиротой не считаются", () => {
    for (const current of ["", ANY_TEST]) {
      expect(options(render(<SurveyOptions surveys={listed} current={current} loaded={{}} />))).toHaveLength(1);
    }
  });

  test("сохранённый тест вне списка остаётся опцией с тем же идентификатором — впереди списка", () => {
    const html = render(<SurveyOptions surveys={listed} current="sv9" loaded={{}} />);
    expect(options(html).map(([v]) => v)).toEqual(["sv9", "sv1"]);
    /* пока методика грузится, подпись честная: «загрузка», а не пустота и не uuid */
    expect(options(html)[0]![1]).toBe("Завантаження…");
  });

  test("снятая с использования методика подписана названием и пометкой", () => {
    const loaded = { sv9: { title: "Шкала Гамільтона", archivedAt: "2024-01-01T00:00:00Z", scales: [] } };
    const html = render(<SurveyOptions surveys={listed} current="sv9" loaded={loaded} />);
    expect(options(html)[0]).toEqual(["sv9", "Шкала Гамільтона (знято з використання)"]);
  });

  test("методика, которую сервер не отдал, названа недоступной, а не пропала", () => {
    const html = render(<SurveyOptions surveys={listed} current="sv9" loaded={{ sv9: null }} />);
    expect(options(html)[0]![0]).toBe("sv9");
    expect(options(html)[0]![1]).toContain("Недоступний тест");
  });
});

/**
 * Список выбора теста — собственный (кадр f25), и обещания доступности у
 * него тоже собственные: штатный <select> давал их сам, здесь их даёт
 * разметка. Проверяется закрытое состояние — то, в котором поле живёт почти
 * всё время: роль, свёрнутость, имя и подпись внутри поля.
 */
describe("поле выбора теста", () => {
  const pick = (value: string) =>
    renderToStaticMarkup(
      <LangProvider>
        <TestPicker value={value} surveys={listed} loaded={{}} onChange={() => {}} />
      </LangProvider>,
    );

  test("закрытое поле: role=combobox, aria-expanded=false и ни списка, ни ссылки на него", () => {
    const html = pick("");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain("aria-controls");
  });

  test("пустое поле подписано изнутри, выбранное показывает название теста", () => {
    expect(pick("")).toContain("Назва тесту");
    expect(pick("sv1")).toContain("Шкала Бека");
  });

  test("«будь-який тест» остаётся видимым значением, хотя в списке его нет", () => {
    expect(pick(ANY_TEST)).toContain("Будь-який тест");
  });
});
