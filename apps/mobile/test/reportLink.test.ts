import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as ts from "typescript";
import { REPORT_LINK_PREFIX, reportLinkPath, reportLinkUrl } from "../src/report/model";
import { sourceFiles } from "../../web/test/rawStrings";

/**
 * Печатный лист прохождения в мобилке (волна 14, участок mobreport).
 *
 * Было: «Відкрити висновок» отдавал браузеру телефона голый адрес листа
 * (api.reportUrl → Linking.openURL): без токена лист не открывался (401),
 * без языка приложения был бы на языке браузера. Стало: приложение
 * запросом с токеном и языком получает одноразовую ссылку (сервер:
 * apps/api/test/reportLinks.test.ts), браузер получает только её.
 */

const API = "https://polypsy.example";
/* 256 бит в base64url — как выдаёт сервер (lib/reportLinks.ts) */
const TICKET = "Q2hlY2tlZC1vbmUtdGltZS1saW5rLXRva2VuLTAxMjM0";

describe("адрес, который уйдёт браузеру", () => {
  test("одноразовая ссылка приклеивается к адресу нашего сервера", () => {
    expect(reportLinkUrl(API, `${REPORT_LINK_PREFIX}${TICKET}`)).toBe(`${API}/api/report-links/${TICKET}`);
    // хвостовой слэш в настройке не даёт двойного
    expect(reportLinkUrl(`${API}/`, `${REPORT_LINK_PREFIX}${TICKET}`)).toBe(`${API}/api/report-links/${TICKET}`);
  });

  test("не наша ссылка браузеру не отдаётся", () => {
    const refused: unknown[] = [
      undefined,
      null,
      42,
      "",
      // прежний голый адрес листа — именно его браузер открывал без токена
      "/api/reports/responses/5c1d",
      // чужой хост в ответе: хост всегда наш, путь — только наш префикс
      `https://evil.example${REPORT_LINK_PREFIX}${TICKET}`,
      `//evil.example${REPORT_LINK_PREFIX}${TICKET}`,
      // лишнее в адресе: запрос, фрагмент, выход из префикса
      `${REPORT_LINK_PREFIX}${TICKET}?token=abc`,
      `${REPORT_LINK_PREFIX}${TICKET}#x`,
      `${REPORT_LINK_PREFIX}../reports/responses/5c1d`,
      `${REPORT_LINK_PREFIX}${TICKET}/extra`,
      // слишком короткое — не 256 бит
      `${REPORT_LINK_PREFIX}abc`,
    ];
    for (const path of refused) expect(reportLinkUrl(API, path), String(path)).toBeNull();
  });

  test("токен входа в адрес не пролезает, даже если сервер его пришлёт", () => {
    // JWT: три части через точку — в одноразовой ссылке точек не бывает
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwYXRpZW50In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
    expect(reportLinkUrl(API, `${REPORT_LINK_PREFIX}${jwt}`)).toBeNull();
  });

  test("ссылку просят по прохождению; идентификатор не ломает путь", () => {
    expect(reportLinkPath("5c1d-7a")).toBe("/api/reports/responses/5c1d-7a/link");
    expect(reportLinkPath("a/b?c")).toBe("/api/reports/responses/a%2Fb%3Fc/link");
  });
});

/* ─────────── сторож: адрес API браузеру не отдаётся ─────────── */

const MOBILE = resolve(import.meta.dir, "..");
const files = [...sourceFiles(join(MOBILE, "app")), ...sourceFiles(join(MOBILE, "src"))];
const rel = (file: string) => file.slice(MOBILE.length + 1);

function walk(file: string, visit: (node: ts.Node, source: ts.SourceFile) => void): void {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const go = (node: ts.Node) => {
    visit(node, source);
    ts.forEachChild(node, go);
  };
  go(source);
}

const where = (node: ts.Node, source: ts.SourceFile, file: string) =>
  `${rel(file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

/** Первый аргумент вызова fetch(…) — единственное место, где адрес API уходит с заголовками */
function isFetchUrl(node: ts.Node): boolean {
  const call = node.parent;
  return (
    !!call &&
    ts.isCallExpression(call) &&
    call.arguments[0] === node &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === "fetch"
  );
}

/** `${API_URL}…` или API_URL + … — выражение, собирающее адрес API */
function buildsApiAddress(node: ts.Node): boolean {
  if (ts.isTemplateExpression(node)) {
    const first = node.templateSpans[0];
    return node.head.text === "" && !!first && ts.isIdentifier(first.expression) && first.expression.text === "API_URL";
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return ts.isIdentifier(node.left) && node.left.text === "API_URL";
  }
  return false;
}

describe("сторож: адрес API не уходит браузеру", () => {
  test("файлы найдены — иначе сторож ничего не проверял бы", () => {
    expect(files.some((f) => f.endsWith(join("src", "api", "client.ts")))).toBe(true);
    expect(files.some((f) => f.endsWith(join("app", "survey", "[id].tsx")))).toBe(true);
  });

  test("адрес API собирается только для fetch — с заголовками, а не для браузера", () => {
    /*
     * Так и жил дефект: api.reportUrl собирал `${API_URL}/api/reports/…`,
     * экран отдавал его Linking.openURL. Рядом лежал такой же exportUrl —
     * мёртвый, но готовый повторить то же самое при первом вызове.
     */
    const found: string[] = [];
    for (const file of files) {
      walk(file, (node, source) => {
        if (buildsApiAddress(node) && !isFetchUrl(node)) found.push(`${where(node, source, file)} ${node.getText(source)}`);
      });
    }
    expect(found).toEqual([]);
  });

  test("браузеру отдаётся только телефон горячей линии и одноразовая ссылка на лист", () => {
    const found: string[] = [];
    for (const file of files) {
      walk(file, (node, source) => {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
        if (node.expression.name.text !== "openURL") return;
        const arg = node.arguments[0];
        const text = arg?.getText(source) ?? "";
        // звонок: tel:… — не адрес, токена в нём нет
        if (text.startsWith("`tel:")) return;
        // единственное открытие листа — ссылкой, выданной сервером по запросу с токеном
        if (rel(file) === join("src", "report", "useOpenReport.ts") && text === "await api.reportLink(responseId)") return;
        found.push(`${where(node, source, file)} ${node.getText(source)}`);
      });
    }
    expect(found).toEqual([]);
  });
});
