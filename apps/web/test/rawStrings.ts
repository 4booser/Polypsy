import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

/**
 * Сырые строки интерфейса: разбор исходника компилятором, а не регуляркой.
 *
 * Прежний сторож (uiStrings.test.ts) искал кавычки регулярными выражениями
 * по тексту файла, из которого перед тем вырезались комментарии. Он ловил
 * почти всё — и промахивался ровно там, где промахнуться хуже всего: на
 * чётности кавычек. В строке
 *
 *     {a.answered ? "" : " · пропуск"}
 *
 * регулярка начинала литерал на второй кавычке пустой строки, захватывала
 * « : » и дальше видела « · пропуск"» уже без открывающей кавычки. Слово
 * жило по-русски в мобильном отчёте о прохождениях на всех трёх языках, а
 * проверка была зелёной. Одиночная буква («А» на кнопке размера шрифта) не
 * проходила порог длины {2,}. Многострочный шаблон не ловился вовсе — это
 * было записано в пояснении как сознательный компромисс.
 *
 * Компилятор этих компромиссов не требует: он знает, где литерал, где
 * комментарий, где текст разметки, а где выражение внутри неё. Поэтому
 * здесь нет ни вырезания комментариев, ни подсчёта скобок, ни порогов
 * длины — только вопрос «видит ли это человек».
 *
 * Модуль общий для двух сторожей: консоли (apps/web/test/noRawStrings.test.ts)
 * и мобилки (apps/mobile/test/noRawStrings.test.ts). Правило одно, а списки
 * исключений у каждого приложения свои — и каждое исключение обязано
 * срабатывать, иначе оно мёртвое (см. deadExceptions).
 */

export interface RawString {
  /** путь от корня репозитория */
  file: string;
  line: number;
  /** текст литерала; подстановки шаблона — «${…}» */
  text: string;
  /**
   * cyrillic — кириллица в любом литерале или тексте разметки;
   * latin — латинское слово там, где текст заведомо доезжает до экрана.
   */
  kind: "cyrillic" | "latin";
  /** для latin: какие слова не нашлись в списке имён */
  words: string[];
}

/** Исключение: файл, начало текста и причина. Причина обязательна. */
export interface Exception {
  file: string;
  text: string;
  why: string;
}

/** Слово-имя, одинаковое на любом языке, — во всём приложении или в одном файле. */
export interface LatinName {
  word: string;
  /** файл, где имя уместно; без файла — везде */
  file?: string;
  why: string;
}

export const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN_WORD = /[A-Za-z]{2,}/g;

/*
 * Подписи, которые видит человек, — свойства разметки.
 *
 * Список шире, чем у стандартного HTML: у компонентов консоли и мобилки
 * свои имена для той же роли (hint у Panel, sub у Page, text у Empty,
 * accessibilityLabel у React Native). Ключ словаря в таком свойстве
 * (`text="hint.rci"`) — не текст, его отсеивает KEY_LIKE ниже.
 */
const VISIBLE_ATTRS = new Set([
  "placeholder",
  "title",
  "alt",
  "label",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "aria-roledescription",
  "aria-placeholder",
  "accessibilityLabel",
  "accessibilityHint",
  "heading",
  "caption",
  "hint",
  "sub",
  "summary",
  "emptyText",
  "text",
  "description",
]);

/*
 * Разметка кода: команда SQL в <Code>, клавиша в <kbd>, кусок конфигурации
 * в <pre>. Это не фраза на языке интерфейса, а то, что человек копирует или
 * нажимает, — переводить её значит сломать. Правило только для латиницы:
 * кириллица внутри <code> была бы странностью, и её сторож покажет.
 */
const CODE_TAGS = new Set(["code", "pre", "kbd", "samp", "Code", "Kbd"]);

/*
 * Ключ, код, путь: «hint.rci», «ops.read», «st.dateFrom». Такой литерал в
 * подписи — это аргумент для словаря или код права, а не текст. Пробела в
 * нём не бывает никогда, а точка — всегда.
 */
const KEY_LIKE = /^[A-Za-z_][\w-]*(?:\.[\w-]+)+$/;

/*
 * Вызовы, аргумент которых человек читает: окна браузера, окно мобилки,
 * тост консоли, поле ошибки экрана. Первый аргумент — текст (у prompt второй
 * — значение по умолчанию, это данные), у Alert.alert — первые два и `text`
 * кнопок.
 */
const DIALOG_CALL = /^(?:window\.)?(?:alert|confirm|prompt)$|^toast$|^set(?:Error|Err|Message|Notice|Info|Hint)$/;

/** Разбор входа: HTML-сущности в тексте разметки — не буквы. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, " ");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Все .ts/.tsx каталога; node_modules пропускается. Нет каталога — пусто. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(path) && !/\.d\.ts$/.test(path)) out.push(path);
  }
  return out;
}

/**
 * Литералы, которые выражение отдаёт на экран как есть.
 *
 * Проходит насквозь то, что текст не меняет: скобки, тернарник (обе ветки,
 * но не условие — в условии сравнение с кодом), склейку `+`, `??`, `||`,
 * правую часть `&&`, подстановки шаблона. Останавливается на вызове
 * (аргумент ut() — ключ, а не текст; результат вызова — не литерал), на
 * обращении к полю и на разметке — её разберёт общий обход.
 */
function reachableLiterals(e: ts.Expression, acc: ts.Node[]): void {
  if (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    reachableLiterals(e.expression, acc);
  } else if (ts.isConditionalExpression(e)) {
    reachableLiterals(e.whenTrue, acc);
    reachableLiterals(e.whenFalse, acc);
  } else if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      reachableLiterals(e.left, acc);
      reachableLiterals(e.right, acc);
    } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      reachableLiterals(e.right, acc);
    }
  } else if (ts.isTemplateExpression(e)) {
    acc.push(e);
    for (const span of e.templateSpans) reachableLiterals(span.expression, acc);
  } else if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    acc.push(e);
  }
}

function literalText(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) {
    return n.head.text + n.templateSpans.map((s) => `\${…}${s.literal.text}`).join("");
  }
  return null;
}

/** Цепочка `a + b + c`, где каждое звено — литерал; иначе null. */
function concatenation(n: ts.Node): ts.Node[] | null {
  if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.PlusToken) return null;
  const parts: ts.Node[] = [];
  const flatten = (e: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(e)) return flatten(e.expression);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return flatten(e.left) && flatten(e.right);
    if (literalText(e) === null) return false;
    parts.push(e);
    return true;
  };
  return flatten(n) ? parts : null;
}

function insideCodeTag(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isJsxElement(p) && CODE_TAGS.has(p.openingElement.tagName.getText())) return true;
  }
  return false;
}

/**
 * Сырые строки одного файла.
 *
 * Кириллица — в любом литерале и любом тексте разметки: пишут интерфейс
 * здесь по-украински и по-русски, и кириллический литерал в исходнике
 * почти всегда и есть забытая подпись. Единственное, что не проверяется, —
 * аргументы console.*: консоль разработчика человек в кабинете не видит.
 *
 * `throw new Error("…")` НЕ освобождён целиком, как было в прежнем стороже.
 * Консоль показывает текст любой брошенной ошибки тостом (useAction в
 * ui/index.tsx), мобилка — строкой ошибки экрана (`e.message`). Сообщение
 * разработчику, брошенное внутри действия, человек прочтёт. Поэтому такие
 * места названы в исключениях поимённо, с причиной, почему до экрана они не
 * доходят; новое — сторож покажет.
 *
 * Латиница — только там, где текст заведомо на экране: текст разметки,
 * подписи-свойства, аргументы окон и тостов, брошенные ошибки. Остальная
 * латиница в исходнике — это код, и разбирать её значило бы получить
 * тысячу ложных тревог.
 */
export function rawStrings(file: string, source: string): RawString[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visible = new Set<ts.Node>();
  const console_ = new Set<ts.Node>();
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  /* проход 1: где литерал на экране, а где он в консоли разработчика */
  const mark = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (/^console\.\w+$/.test(callee)) {
        const all = (x: ts.Node): void => {
          console_.add(x);
          ts.forEachChild(x, all);
        };
        for (const a of n.arguments) all(a);
      } else if (DIALOG_CALL.test(callee) && n.arguments[0]) {
        const acc: ts.Node[] = [];
        reachableLiterals(n.arguments[0], acc);
        for (const x of acc) visible.add(x);
      } else if (callee === "run" && n.arguments[1]) {
        /* run(действие, текстУспеха) из useAction: второй аргумент уходит тостом */
        const acc: ts.Node[] = [];
        reachableLiterals(n.arguments[1], acc);
        for (const x of acc) visible.add(x);
      } else if (callee === "Alert.alert") {
        const acc: ts.Node[] = [];
        for (const a of n.arguments.slice(0, 2)) reachableLiterals(a, acc);
        const buttons = n.arguments[2];
        if (buttons && ts.isArrayLiteralExpression(buttons)) {
          for (const b of buttons.elements) {
            if (!ts.isObjectLiteralExpression(b)) continue;
            for (const p of b.properties) {
              if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "text") reachableLiterals(p.initializer, acc);
            }
          }
        }
        for (const x of acc) visible.add(x);
      }
    } else if (ts.isThrowStatement(n) && ts.isNewExpression(n.expression)) {
      const acc: ts.Node[] = [];
      for (const a of n.expression.arguments ?? []) reachableLiterals(a, acc);
      for (const x of acc) visible.add(x);
    } else if (ts.isJsxAttribute(n) && n.initializer && VISIBLE_ATTRS.has(n.name.getText(sf))) {
      const init = n.initializer;
      const acc: ts.Node[] = [];
      if (ts.isStringLiteral(init)) acc.push(init);
      else if (ts.isJsxExpression(init) && init.expression) reachableLiterals(init.expression, acc);
      for (const x of acc) visible.add(x);
    } else if (ts.isJsxExpression(n) && n.expression && n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      const acc: ts.Node[] = [];
      reachableLiterals(n.expression, acc);
      for (const x of acc) visible.add(x);
    }
    ts.forEachChild(n, mark);
  };
  mark(sf);

  /* проход 2: сами литералы и текст разметки */
  const out: RawString[] = [];
  const report = (n: ts.Node, text: string, isVisible: boolean): void => {
    if (console_.has(n)) return;
    const shown = collapse(text);
    if (!shown) return;
    if (CYRILLIC.test(shown)) {
      out.push({ file, line: lineOf(n), text: shown, kind: "cyrillic", words: [] });
      return;
    }
    if (!isVisible || KEY_LIKE.test(shown)) return;
    const words = decodeEntities(shown).match(LATIN_WORD);
    if (words) out.push({ file, line: lineOf(n), text: shown, kind: "latin", words: [...new Set(words)] });
  };
  const walk = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      report(n, n.text, !insideCodeTag(n));
      return;
    }
    /*
     * Фраза, склеенная из кусков `"…" + "…"`, — одна фраза: так её и
     * показывать в списке нарушений, и называть в исключениях. Иначе длинное
     * сообщение, разбитое на четыре строки исходника, требовало бы четырёх
     * исключений, и три из них выглядели бы как отдельные тексты.
     */
    const parts = concatenation(n);
    if (parts) {
      const text = parts.map((p) => literalText(p) ?? "").join("");
      const shownAtAll = parts.some((p) => visible.has(p)) && !insideCodeTag(n);
      if (!parts.some((p) => console_.has(p))) report(parts[0]!, text, shownAtAll);
      for (const p of parts) if (ts.isTemplateExpression(p)) for (const s of p.templateSpans) walk(s.expression);
      return;
    }
    const text = literalText(n);
    if (text !== null) {
      report(n, text, visible.has(n) && !insideCodeTag(n));
      /* подстановки шаблона — свои выражения, в них бывают свои литералы и разметка */
      if (ts.isTemplateExpression(n)) for (const s of n.templateSpans) walk(s.expression);
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

/** Слова находки, которые не являются именами для этого файла. */
export function unnamedWords(found: RawString, names: readonly LatinName[]): string[] {
  return found.words.filter((w) => !names.some((n) => n.word === w && (!n.file || n.file === found.file)));
}

/**
 * Сверка находок с исключениями.
 *
 * Возвращает и нарушения, и мёртвые исключения — те, что ничего не
 * разрешили. Мёртвое исключение хуже отсутствующего: оно молча разрешит
 * настоящую забытую строку, если та однажды совпадёт с ним началом, а
 * список, в котором половина записей ни к чему не относится, никто не
 * читает — и правило перестаёт работать.
 */
export function judge(
  found: RawString[],
  exceptions: readonly Exception[],
  names: readonly LatinName[],
): { offenders: string[]; deadExceptions: string[]; deadNames: string[] } {
  const usedExceptions = new Set<Exception>();
  const usedNames = new Set<LatinName>();
  const offenders: string[] = [];
  for (const f of found) {
    const ex = exceptions.find((e) => e.file === f.file && f.text.startsWith(e.text));
    if (ex) {
      usedExceptions.add(ex);
      continue;
    }
    if (f.kind === "latin") {
      for (const w of f.words) {
        const n = names.find((x) => x.word === w && (!x.file || x.file === f.file));
        if (n) usedNames.add(n);
      }
      if (unnamedWords(f, names).length === 0) continue;
    }
    offenders.push(`${f.file}:${f.line}: ${f.text.slice(0, 90)}`);
  }
  return {
    offenders,
    deadExceptions: exceptions.filter((e) => !usedExceptions.has(e)).map((e) => `${e.file}: ${e.text}`),
    deadNames: names.filter((n) => !usedNames.has(n)).map((n) => (n.file ? `${n.file}: ${n.word}` : n.word)),
  };
}
