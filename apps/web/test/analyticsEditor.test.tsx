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
 * Область нажатия квадратика отметки не залезает на соседей.
 *
 * Квадратик 20×20 стоит в 10 от правого края поля (замер f19: поле кончается
 * на 1109, квадратик 1120…1139), а строки карточки идут шагом 51 при высоте
 * 36, то есть между ними 15. Дорисованная до 44×44 накладка вылезала бы на 12
 * в каждую сторону и забирала бы последние 2px поля — промах по краю поля
 * (или по кнопке выбора теста внутри него) ставил бы отметку вместо того,
 * чтобы открыть список.
 *
 * Проверяется не «какой класс написан», а само условие: вынос накладки за
 * видимый квадрат обязан быть МЕНЬШЕ зазора до соседа с той же стороны — и
 * при этом накладка обязана остаться не меньше порога 2.5.8 (24px).
 */
describe("область нажатия квадратика отметки", () => {
  const GAP_X = 10; /* зазор до поля слева и до рамки карточки справа — замер f19 */
  const GAP_Y = 15; /* зазор между строками карточки */
  const BOX = 20; /* сам квадратик */
  const ROW = 36; /* высота строки, в которой квадратик стоит по центру */

  const pick = (() => {
    const at = EDITOR.indexOf("function Pick(");
    expect(at, "в Editor.tsx больше нет Pick — проверять нечего").toBeGreaterThan(0);
    return EDITOR.slice(at, EDITOR.indexOf("\n}", at));
  })();

  const size = (axis: "w" | "h"): number => {
    const m = pick.match(new RegExp(`after:${axis}-\\[(\\d+)px\\]`));
    expect(m, `у накладки нет явного after:${axis}-[…px]`).not.toBeNull();
    return Number(m![1]);
  };

  test("квадратной накладки нет: сторона, годная по вертикали, по горизонтали накрывает поле", () => {
    expect(
      /after:size-\[\d+px\]/.test(pick),
      "накладка снова задана одной стороной — по горизонтали зазор вдвое меньше вертикального",
    ).toBe(false);
  });

  test("по горизонтали накладка не доходит до чужого края", () => {
    expect((size("w") - BOX) / 2).toBeLessThan(GAP_X);
  });

  test("по вертикали накладка не доходит до соседней строки", () => {
    expect((size("h") - ROW) / 2).toBeLessThan(GAP_Y / 2);
  });

  test("накладка всё ещё крупнее порога размера цели", () => {
    for (const axis of ["w", "h"] as const) expect(size(axis)).toBeGreaterThanOrEqual(24);
  });

  test("зазор строки, из которого всё это считано, на месте", () => {
    expect(EDITOR).toContain(`gap-[${GAP_X}px]`);
  });
});

/**
 * Блок перечня шириной 1230 доходит до экрана.
 *
 * Колонка содержимого — 1200 (max-w-[1248px] px-6), а блок списка на 30
 * шире: колонка 600, зазор 30, вторая колонка 600 (замеры f10 — подложка
 * наведения 200…799, имя второй колонки с 831). `max-w-full` на этом блоке
 * равен max-width:100% от тех же 1200 и молча резал его до 1200: колонки
 * становились по 585 с шагом 615, то есть намерение оставалось в
 * комментарии, а на экране его не было. Ошибка тихая — разметка та же,
 * список тот же, сдвиг 15px виден только замером.
 */
describe("перечень аналитики: ширина блока списка", () => {
  const ul = (() => {
    const at = LIST.indexOf("columns-2");
    expect(at, "список перечня больше не в две колонки — проверять нечего").toBeGreaterThan(0);
    return LIST.slice(LIST.lastIndexOf("<ul", at), LIST.indexOf(">", at));
  })();

  test("объявленная ширина — 1230", () => {
    expect(ul).toContain("w-[1230px]");
  });

  test("ничто не режет её до колонки содержимого", () => {
    expect(/(^|[\s"'`])max-w-full(?![-:\w])/.test(ul), "max-w-full снова отменяет 1230").toBe(false);
  });

  test("узкое окно уходит в одну колонку раньше, чем 1230 перестают помещаться", () => {
    /*
     * 1230 помещаются, пока (w−1248)/2 + 24 + 1230 ≤ w, то есть при w ≥ 1260.
     * Порог одной колонки обязан стоять не ниже: иначе между ним и 1260
     * появляется полоса ширин с горизонтальной прокруткой на пустом месте.
     */
    const m = ul.match(/max-\[(\d+)px\]:columns-1/);
    expect(m, "порога одной колонки нет вовсе").not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1259);
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

  test("нарисована тоном рамки поля, а не своим числом", () => {
    expect(html).toContain("--field-border");
  });

  test("место под каретку в поле отведено", () => {
    expect(html).toContain("pr-[26px]");
  });
});
