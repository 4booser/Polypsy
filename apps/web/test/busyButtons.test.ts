import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { sourceFiles } from "./rawStrings";

/**
 * Кнопка, запускающая действие, гаснет, пока оно идёт (w14:webtails).
 *
 * Проверки поведения волны 13 гасили кнопку отправки у форм, которые можно
 * нарисовать без сети (окно заведения учётки, согласие, запись к врачу), —
 * а у экранов, которые сами грузят свои данные, это состояние без браузера
 * не нарисовать: экран до него не доходит. Здесь — сторож на разборе
 * исходника компилятором, по всем экранам разом.
 *
 * Правило. Действие экрана идёт через useAction (ui/index.tsx): его run
 * не начнёт второе, пока идёт первое, но кнопка при этом выглядела живой —
 * человек жал «зберегти» ещё раз, ничего не происходило, и он не знал,
 * ушло ли. Поэтому кнопка, чей onClick запускает run (прямо или через
 * функцию экрана), и кнопка отправки формы, чей onSubmit его запускает,
 * держат `disabled`, в котором есть занятость этого useAction (`busy` или
 * как её назвал экран).
 *
 * Исключения — только с причиной, и каждое обязано срабатывать: мёртвое
 * исключение прячет будущую кнопку с тем же текстом.
 */

const WEB = resolve(import.meta.dir, "..");
const rel = (f: string) => relative(WEB, f);

interface Exception {
  file: string;
  /** начало текста onClick (без пробелов по краям), по которому узнаётся кнопка */
  click: string;
  why: string;
}

const EXCEPTIONS: Exception[] = [
  {
    file: "src/pages/Account.tsx",
    click: "() => applyPref(",
    why: "тема, плотность и движение: вид меняется сразу, на этом же нажатии, а сервер лишь запоминает выбор — гасить переключатель на время записи значило бы мигать им на каждом нажатии",
  },
  {
    file: "src/pages/Invites.tsx",
    click: "() => run(async () => navigator.clipboard.writeText(",
    why: "копирование ссылки и кода приглашения в буфер: без сервера и мгновенно, и второе нажатие копирует то же самое — гасить нечего",
  },
  {
    file: "src/pages/UiKit.tsx",
    click: "() => void run(async () => { throw",
    why: "витрина компонентов для разработки: кнопка показывает всплывающий отказ, действия нет",
  },
];

/** Кнопка, нарушающая правило */
interface Offender {
  file: string;
  line: number;
  click: string;
}

/** Кнопки файла, живые во время своего действия; `src` — исходник (для проверки самого сторожа — выдуманный) */
function scan(file: string, src: string = readFileSync(file, "utf8")): Offender[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const runners = new Set<string>();
  const busies = new Set<string>();

  // имена из `const { run, busy } = useAction()` и из свойств компонента `{ busy, run }`
  const bind = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isCallExpression(init) && init.expression.getText(sf) === "useAction") {
        for (const el of node.name.elements) {
          const key = (el.propertyName ?? el.name).getText(sf);
          if (key === "run") runners.add(el.name.getText(sf));
          if (key === "busy") busies.add(el.name.getText(sf));
        }
      }
    }
    if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
      const keys = node.name.elements.map((el) => (el.propertyName ?? el.name).getText(sf));
      if (keys.includes("run")) runners.add("run");
      if (keys.includes("busy")) busies.add("busy");
    }
    ts.forEachChild(node, bind);
  };
  bind(sf);
  if (!runners.size) return [];

  const callsRunner = (node: ts.Node, names: Set<string>): boolean => {
    let found = false;
    const walk = (n: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.has(n.expression.text)) found = true;
      else if (ts.isIdentifier(n) && wrappers.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) found = true;
      else ts.forEachChild(n, walk);
    };
    walk(node);
    return found;
  };

  // функции экрана, запускающие run: `const save = () => run(…)`, `function assign() { … run(…) }`
  const wrappers = new Set<string>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      const fn = ts.isCallExpression(init) && init.expression.getText(sf) === "useCallback" ? init.arguments[0] : init;
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && callsRunner(fn.body, runners)) wrappers.add(node.name.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body && !/^[A-Z]/.test(node.name.text) && callsRunner(node.body, runners)) {
      wrappers.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  // обёртка может звать обёртку: два прохода хватает с запасом
  collect(sf);
  collect(sf);

  const starts = (expr: ts.Expression | undefined) => !!expr && callsRunner(expr, runners);
  const attr = (el: ts.JsxOpeningLikeElement, name: string) =>
    el.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === name);
  const value = (a: ts.JsxAttribute | undefined) =>
    a?.initializer && ts.isJsxExpression(a.initializer) ? a.initializer.expression : undefined;
  const mentionsBusy = (expr: ts.Expression | undefined) => {
    let found = false;
    const walk = (n: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(n) && busies.has(n.text)) found = true;
      else ts.forEachChild(n, walk);
    };
    if (expr) walk(expr);
    return found;
  };

  const out: Offender[] = [];
  const visit = (node: ts.Node, runForm: boolean) => {
    let inForm = runForm;
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === "form") {
      inForm = starts(value(attr(node.openingElement, "onSubmit")));
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (tag === "Button" || tag === "button") {
        const click = value(attr(node, "onClick"));
        const submit = attr(node, "type")?.initializer?.getText(sf) === '"submit"';
        if ((starts(click) || (inForm && submit)) && !mentionsBusy(value(attr(node, "disabled")))) {
          out.push({
            file: rel(file),
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            click: (click?.getText(sf) ?? "<submit>").replace(/\s+/g, " ").trim(),
          });
        }
      }
    }
    ts.forEachChild(node, (c) => visit(c, inForm));
  };
  visit(sf, false);
  return out;
}

const files = sourceFiles(join(WEB, "src")).filter((f) => f.endsWith(".tsx"));
const all = files.flatMap((f) => scan(f));
const excused = (o: Offender) => EXCEPTIONS.some((e) => e.file === o.file && o.click.startsWith(e.click));

describe("кнопка действия гаснет, пока оно идёт", () => {
  test("сторож видит экраны: кнопки с run находятся, и их много", () => {
    // пустой сторож зелен всегда: проверяем, что он вообще что-то разбирает
    expect(files.length).toBeGreaterThan(100);
    const src = readFileSync(join(WEB, "src/pages/ops/Sessions.tsx"), "utf8");
    expect(src).toContain("disabled={busy}");
  });

  test("каждая кнопка, запускающая действие, держит занятость в disabled", () => {
    const bad = all.filter((o) => !excused(o)).map((o) => `${o.file}:${o.line}  onClick=${o.click.slice(0, 80)}`);
    expect(bad, `кнопки живы, пока идёт их действие:\n${bad.join("\n")}`).toEqual([]);
  });

  test("исключения живые: каждое узнаёт хотя бы одну кнопку", () => {
    const dead = EXCEPTIONS.filter((e) => !all.some((o) => e.file === o.file && o.click.startsWith(e.click)));
    expect(dead.map((e) => `${e.file}: ${e.click}`)).toEqual([]);
    for (const e of EXCEPTIONS) expect(e.why.length, e.file).toBeGreaterThan(20);
  });

  test("сторож ловит то, ради чего написан", () => {
    /*
     * Проверка на выдуманном экране: без этого поломка разбора (сменилось
     * имя хука, JSX стал разбираться иначе) сделала бы сторож вечно зелёным.
     */
    const probe = (code: string) => scan(join(WEB, "src/__probe__.tsx"), code);
    const live = `function A() { const { run } = useAction(); return <Button onClick={() => run(() => api.x())}>x</Button>; }`;
    const guarded = `function A() { const { run, busy } = useAction(); return <Button disabled={busy} onClick={() => run(() => api.x())}>x</Button>; }`;
    const renamed = `function A() { const { run: act, busy: sending } = useAction(); return <Button disabled={!ok || sending} onClick={() => act(() => api.x())}>x</Button>; }`;
    const wrapper = `function A() { const { run } = useAction(); const save = () => run(() => api.x()); return <Button onClick={save}>x</Button>; }`;
    const form = `function A() { const { run } = useAction(); return <form onSubmit={() => void run(() => api.x())}><Button type="submit">x</Button></form>; }`;
    const prop = `function B({ busy, run }: P) { return <Button onClick={() => run(() => api.x())}>x</Button>; }`;
    expect(probe(live)).toHaveLength(1);
    expect(probe(guarded)).toHaveLength(0);
    expect(probe(renamed)).toHaveLength(0);
    expect(probe(wrapper)).toHaveLength(1);
    expect(probe(form)).toHaveLength(1);
    expect(probe(prop)).toHaveLength(1);
  });
});
