import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "../src/lang";
import { Field, Input, Textarea, TOUCH_MIN_PX, TouchArea } from "../src/ui/primitives";

/**
 * Кабинет пациента: правила, которые не должны держаться на памяти.
 *
 * Это единственный экран продукта, который открывает не сотрудник, а человек
 * в тяжёлом состоянии, с телефона и иногда с диктором. Всё, что здесь
 * проверяется, однажды уже было забыто: высота мишени стояла руками и
 * разошлась между экранами, поле причины обращения осталось без подписи,
 * заголовка не было ни на одном из четырёх экранов.
 *
 * Поэтому проверяется не «правильно ли сейчас» — это меряет смоук на живой
 * странице, — а то, что забыть НЕЛЬЗЯ: зона объявлена, сырых полей нет,
 * безымянное поле падает при разработке.
 */

const WEB = resolve(import.meta.dir, "..");
const PATIENT = join(WEB, "src/patient");

const draw = (node: React.ReactNode) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);

describe("безымянное поле в кабинете не доезжает до человека", () => {
  /*
   * Подпись через обёртку Field или ссылку на видимый заголовок — два
   * законных способа назвать поле. Третьего нет: placeholder исчезает при
   * наборе, а <h2> рядом с полем ничем с ним не связан — именно так и
   * выглядело нарушение 4.1.2 на записи к специалисту.
   */
  test("поле без подписи падает и называет виновника", () => {
    expect(() => draw(
      <TouchArea>
        <Input placeholder="с чем обращаетесь" />
      </TouchArea>,
    )).toThrow(/<input> в кабинете пациента без подписи/);
  });

  test("подпись обёрткой Field принимается", () => {
    expect(() => draw(
      <TouchArea>
        <Field label="С чем обращаетесь">
          <Textarea rows={3} />
        </Field>
      </TouchArea>,
    )).not.toThrow();
  });

  test("ссылка на видимый заголовок принимается", () => {
    // так названы поля в прохождении методики: подпись там — сам вопрос
    expect(() => draw(
      <TouchArea>
        <h1 id="q">Как часто за последние две недели…</h1>
        <Input aria-labelledby="q" />
      </TouchArea>,
    )).not.toThrow();
  });

  test("в консоли специалиста проверка молчит", () => {
    /*
     * Нарочно: в консоли шесть десятков полей чужих экранов, и падение на
     * них означало бы, что защиту снимут в тот же день. Строгость включает
     * место, а не тип элемента.
     */
    expect(() => draw(<Input placeholder="поиск" />)).not.toThrow();
  });
});

/** Разметка без пояснений: в комментариях сюда попадает и то, что они запрещают */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("территория пальца объявлена, а не проставлена руками", () => {
  /* какие экраны кабинета живут вне оболочки и потому объявляют зону сами */
  const APP = code(readFileSync(join(WEB, "src/App.tsx"), "utf8"));

  /** `const X = lazy(() => import("./patient/Y"))` → X: файл */
  function lazyFiles(): Map<string, string> {
    const map = new Map<string, string>();
    for (const m of APP.matchAll(/const (\w+) = lazy\(\(\) => import\("\.\/(patient\/\w+)"\)\)/g)) {
      map.set(m[1]!, join(WEB, "src", `${m[2]}.tsx`));
    }
    return map;
  }

  /** Экраны, подключённые к адресам /me не через оболочку кабинета */
  function screensOutsideShell(): string[] {
    const start = APP.indexOf('<Route path="/me" element={<PatientApp />}>');
    const end = APP.indexOf("</Routes>", start);
    expect(start, "маршруты кабинета переписаны — проверка смотрит не туда").toBeGreaterThan(0);
    const block = APP.slice(APP.indexOf("</Route>", start), end);
    return [...block.matchAll(/<Route path="\/me[^"]*" element=\{<(\w+)/g)].map((m) => m[1]!);
  }

  test("пол мишени в зоне — то самое число, которое объявлено константой", () => {
    /*
     * Класс Tailwind обязан быть литералом, поэтому 44 написано в нём
     * цифрами. Проверка связывает цифру с константой: иначе однажды
     * поправят одно и не заметят, что второе осталось прежним, — и
     * пояснение начнёт описывать не то, что происходит.
     */
    const html = renderToStaticMarkup(<TouchArea>мишени</TouchArea>);
    expect(html).toContain(`min-h-[${TOUCH_MIN_PX}px]`);
    expect(html).toContain(`min-w-[${TOUCH_MIN_PX}px]`);
  });

  test("оболочка кабинета объявляет зону пальца", () => {
    const shell = code(readFileSync(join(PATIENT, "PatientApp.tsx"), "utf8"));
    /* булевым, а не toContain: иначе сообщение об ошибке — весь файл целиком */
    expect(shell.includes("<TouchArea"), "без TouchArea высота мишеней снова станет делом памяти").toBe(true);
  });

  test("экран кабинета вне оболочки объявляет зону сам", () => {
    const files = lazyFiles();
    const outside = screensOutsideShell();
    // прохождение методики — как раз такой экран: свой маршрут, без вкладок
    expect(outside.length, "проверка не нашла ни одного такого экрана").toBeGreaterThan(0);
    for (const name of outside) {
      const file = files.get(name);
      if (!file) continue;
      expect(
        code(readFileSync(file, "utf8")).includes("<TouchArea"),
        `${name}: экран /me вне оболочки без зоны пальца`,
      ).toBe(true);
    }
  });

  test("в кабинете нет полей мимо примитивов", () => {
    /*
     * Сырой <input> обходит проверку имени: она живёт в примитиве, а не в
     * браузере. Запрет сырых полей и делает её неизбежной — иначе защита
     * снимается одной буквой в нижнем регистре.
     */
    const bad: string[] = [];
    for (const name of readdirSync(PATIENT)) {
      if (!name.endsWith(".tsx")) continue;
      const src = code(readFileSync(join(PATIENT, name), "utf8"));
      for (const m of src.matchAll(/<(input|textarea|select)[\s/>]/g)) {
        bad.push(`${name}: <${m[1]}>`);
      }
    }
    expect(bad, "используйте Input/Textarea/Select из ui/primitives").toEqual([]);
  });
});
