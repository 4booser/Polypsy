import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { SurveyListItem } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import {
  PARAM_PICKS,
  SurveyOptions,
  TestPicker,
  paramKindOver,
  paramPick,
} from "../src/pages/analytics/Editor";
import { ANY_TEST, newParam } from "../src/pages/analytics/model";
import { Select } from "../src/ui/primitives";

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

/**
 * Вид уже заведённого параметра меняется, а не задаётся один раз при
 * добавлении.
 *
 * Первая редакция убрала поле «Вид параметра» с формы (кадр f19 его не
 * рисует) и оставила выбор вида только в окне «Додати Параметр». Цена: чтобы
 * превратить условие по шкале во флаг риска — или вернуть «будь-який тест»,
 * который из списка методик не выбирается вовсе, — строку надо было удалить и
 * завести заново, потеряв вместе с ней шкалу, условие и порог. Здесь
 * проверяется обратное: любой вид достижим из любого, а то, что смены вида не
 * касается, переживает её.
 */
describe("смена вида параметра", () => {
  const base = newParam({ scaleCode: "ANX", op: "<=", value: "12", metric: "normed", surveyId: "sv1" });

  test("любой вид достижим из любого", () => {
    for (const from of PARAM_PICKS) {
      let p = { ...base, ...paramKindOver(base, from) };
      expect(paramPick(p)).toBe(from);
      for (const to of PARAM_PICKS) {
        p = { ...p, ...paramKindOver(p, to) };
        expect(paramPick(p), `${from} → ${to} не сработал`).toBe(to);
      }
    }
  });

  test("«будь-який тест» — не дорога в один конец", () => {
    const any = { ...base, ...paramKindOver(base, "any") };
    expect(any.surveyId).toBe(ANY_TEST);
    const back = { ...any, ...paramKindOver(any, "scale") };
    expect(paramPick(back)).toBe("scale");
    expect(back.surveyId).toBe("");
  });

  test("прогулка через флаг риска и обратно возвращает условие целым", () => {
    const risk = { ...base, ...paramKindOver(base, "risk") };
    const back = { ...risk, ...paramKindOver(risk, "scale") };
    expect(back).toEqual(base);
  });

  test("свой же вид ничего не трогает", () => {
    for (const k of PARAM_PICKS) {
      const p = { ...base, ...paramKindOver(base, k) };
      expect(paramKindOver(p, k)).toEqual({});
    }
  });
});

/** Исходник без комментариев: иначе сторож читает объяснение вместо кода */
const bare = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const EDITOR = bare("../src/pages/analytics/Editor.tsx");
const LIST = bare("../src/pages/analytics/List.tsx");

/**
 * Отметка условия и действия — флажок набора с именем.
 *
 * Прежняя форма рисовала свой квадратик 20×20 со своей областью нажатия, и
 * её приходилось сторожить замерами. Теперь отметка — Checkbox набора в
 * шапке блока условия и в строке действия, рядом с корзиной; сторожится
 * то, без чего «Прибрати позначені» не работает для диктора: у каждого
 * флажка есть имя, и корзина — кнопка с именем, а не голый значок.
 */
describe("отметка и удаление строк формы", () => {
  test("флажки условия и действия — флажки набора с именем", () => {
    expect(EDITOR).toContain('<Checkbox checked={p.picked} aria-label={ut("am.pickParam")}');
    expect(EDITOR).toContain('<Checkbox checked={a.picked} aria-label={ut("am.pickAction")}');
  });

  test("корзина условия и действия — кнопка с именем", () => {
    expect(EDITOR).toContain('aria-label={ut("am.removeCond")}');
    expect(EDITOR).toContain('aria-label={ut("am.removeAct")}');
  });

  test("у каждого поля с отказом есть id, к которому ведёт ссылка сводки", () => {
    for (const field of ["test", "scale", "threshold", "count", "advise", "suggest", "pathway"]) {
      expect(EDITOR, `нет id у поля «${field}»`).toContain(`-${field}` + "`");
    }
  });
});

/**
 * Состояние перечня — в адресе, правкой replace: ссылку на «вимкнені з
 * PHQ-9, сторінка 2» пересылают коллеге, а каждая буква поиска шагом в
 * истории браузера не становится.
 */
describe("перечень моделей: состояние в адресе", () => {
  test("поиск, страница, размер, вид, фильтры и порядок читаются из адреса", () => {
    for (const key of ["q", "page", "per", "view", "sort", "test", "act"]) {
      expect(LIST, `«${key}» не читается из адреса`).toContain(`params.get("${key}")`);
    }
  });

  test("правка адреса — replace, а не новый шаг истории", () => {
    expect(LIST).toContain("{ replace: true }");
  });

  test("страница за концом списка возвращается на ближайшую", () => {
    expect(LIST).toContain("page > pages");
  });
});

/**
 * Выпадающий список остаётся отличимым от поля ввода.
 *
 * Сторож стоит здесь, а не рядом с primitives: сюда его привела правка этого
 * раздела. Конструктору модели завели свойство `Select plain` — рамка
 * #666666 и снятая каретка, — и надели его на «Вид дії», «Рівень ризику»,
 * «Який тест запропонувати» и «Кількість проходжень», то есть на строки,
 * которых кадр f19 не рисует вовсе. На экране получилось поле, по которому
 * не видно, что в нём есть что выбрать; кадром это не подпёрто ничем —
 * единственное поле выбора, нарисованное обычным полем (выбор теста, f25),
 * списком ОС не является и Select не трогает.
 *
 * Проверяется картинка, а не имя свойства: каретка обязана быть нарисована в
 * стиле элемента. Свойства с любым другим именем, снимающего её, так не
 * завести незаметно.
 */
describe("каретка выпадающего списка", () => {
  const html = renderToStaticMarkup(
    <Select aria-label="Вид">
      <option value="a">а</option>
    </Select>,
  );

  test("каретка нарисована", () => {
    expect(html).toContain("linear-gradient");
  });

  /* шеврон набора — приглушённым тоном (.inp > значок: --muted), токеном, а не своим числом */
  test("нарисована токеном темы, а не своим числом", () => {
    expect(html).toContain("var(--muted)");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  test("место под каретку в поле отведено", () => {
    expect(html).toContain("pr-9");
  });
});
