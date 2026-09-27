import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Сторож слоя загрузки (волна 13).
 *
 * Решение заказчика 2026-09-27: все загрузки данных идут одним путём —
 * useResource / usePagedResource / useResourceMap поверх TanStack Query.
 * Внешний разбор насчитал сорок одно место, где экран грузил данные голым
 * эффектом: `useEffect(() => { api.x().then(setX) })`. У каждого — те же
 * болезни: устаревший ответ ложится поверх свежего, отказ висит после
 * удачного повтора, вернувшаяся связь никого не будит. Переписаны все; этот
 * тест не даёт им вернуться.
 *
 * Проверка — по исходникам: тело каждого useEffect/useLayoutEffect в
 * apps/web/src, где есть прямой вызов `api.*(…)` или голый `fetch(…)`.
 * Исключения — явным списком и с причиной: это действия, а не загрузки
 * (одноразовый обмен кода, пульс присутствия, пометка «прочитано»), и один
 * живой хвост, который в «бесконечный запрос» не ложится. Новое исключение
 * пишется сюда же — с причиной, которую прочтёт следующий.
 */

const SRC = resolve(import.meta.dir, "../src");

const ALLOWED: { file: string; calls: string[]; why: string }[] = [
  {
    file: "pages/GoogleReturn.tsx",
    calls: ["googleExchange", "me"],
    why: "одноразовое действие: обмен кода Google на пару токенов — код одноразовый, его нельзя ни повторить, ни отменить",
  },
  {
    file: "pages/Messages.tsx",
    calls: ["markRead"],
    why: "действие при показе: пометка писем прочитанными — изменение, а не загрузка; список после него перечитывается через reload()",
  },
  {
    file: "events.ts",
    calls: ["presenceHere"],
    why: "пульс присутствия «я здесь» — действие без ответа; список «кто здесь» грузится через useResource",
  },
  {
    file: "pages/ops/Logs.tsx",
    calls: ["opsLogs"],
    why: "живой хвост журнала: курсор вперёд, дочитка назад и склейка с потолком не ложатся в бесконечный запрос; защищён поколением фильтров, отменяется сигналом, без связи ждёт",
  },
];

function codeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) codeFiles(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Тела эффектов: от `useEffect(` до парной скобки, мимо строк и комментариев */
export function effectBodies(src: string): { line: number; body: string }[] {
  const out: { line: number; body: string }[] = [];
  for (const m of src.matchAll(/\buse(?:Layout)?Effect\s*\(/g)) {
    let i = m.index! + m[0].length;
    let depth = 1;
    let quote: string | null = null;
    while (i < src.length && depth > 0) {
      const c = src[i]!;
      if (quote) {
        if (c === "\\") i += 1;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "/" && src[i + 1] === "/") {
        const end = src.indexOf("\n", i);
        i = end < 0 ? src.length : end;
        continue;
      } else if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        i = end < 0 ? src.length : end + 2;
        continue;
      } else if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      i += 1;
    }
    out.push({ line: src.slice(0, m.index).split("\n").length, body: src.slice(m.index, i) });
  }
  return out;
}

/** Прямые загрузки в теле эффекта: методы api.* и голый fetch; комментарии не в счёт */
export function directCalls(body: string): string[] {
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const calls = [...code.matchAll(/\bapi\s*\.\s*(\w+)\s*\(/g)].map((m) => m[1]!);
  if (/(^|[^\w.])fetch\s*\(/.test(code)) calls.push("fetch");
  return [...new Set(calls)];
}

describe("загрузки — одним путём", () => {
  const found = codeFiles(SRC).flatMap((file) =>
    effectBodies(readFileSync(file, "utf8")).flatMap(({ line, body }) =>
      directCalls(body).map((call) => ({ file: relative(SRC, file), line, call })),
    ),
  );

  test("в эффектах apps/web/src нет прямых запросов, кроме оправданных", () => {
    const offenders = found
      .filter((f) => !ALLOWED.some((a) => a.file === f.file && a.calls.includes(f.call)))
      .map((f) => `${f.file}:${f.line} ${f.call}`);
    expect(offenders).toEqual([]);
  });

  test("белый список не устаревает: каждое исключение ещё на месте", () => {
    // исключение, которого больше нет в коде, — дверь, через которую пройдёт следующее
    const stale = ALLOWED.flatMap((a) =>
      a.calls.filter((c) => !found.some((f) => f.file === a.file && f.call === c)).map((c) => `${a.file} ${c}`),
    );
    expect(stale).toEqual([]);
  });

  test("проверка видит то, что проверяет", () => {
    // без этого сломанный разбор (пустой список тел) проходил бы все проверки выше
    const sample = [
      "useEffect(() => {",
      "  // api.fake() в комментарии не в счёт",
      '  const url = "https://x/y"; // и строка с адресом тоже',
      "  api",
      "    .patients({ q: `(${a})` })",
      "    .then(setRows);",
      "  fetch(`/api/invites/preview/${token}`).then((r) => r.json());",
      "}, [a]);",
      "useLayoutEffect(() => void refetch(), []);",
    ].join("\n");
    const bodies = effectBodies(sample);
    expect(bodies.length).toBe(2);
    expect(directCalls(bodies[0]!.body).sort()).toEqual(["fetch", "patients"]);
    expect(directCalls(bodies[1]!.body)).toEqual([]);
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("слой загрузки устроен как обещано", () => {
  const read = (p: string) => readFileSync(join(SRC, p), "utf8");

  test("хуки — поверх TanStack Query, без своего счётчика запусков", () => {
    const hook = read("useResource.ts");
    expect(hook).toMatch(/\buseQuery\(/);
    expect(hook).toMatch(/\buseInfiniteQuery\(/);
    expect(hook).not.toMatch(/runId/);
  });

  test("клиент — в корне: и консоль, и кабинет пациента под одним провайдером", () => {
    const main = read("main.tsx");
    expect(main).toMatch(/<QueryClientProvider client=\{queryClient\}>/);
    expect(main).toMatch(/wireConnection\(\)/);
    // кабинет пациента — ветка App, а не свой корень
    expect(read("App.tsx")).toMatch(/<Route path="\/me" element=\{<PatientApp \/>\}>/);
  });

  test("строка связи стоит в консоли и в кабинете", () => {
    expect(read("App.tsx")).toMatch(/<ConnectionLine place="console" \/>/);
    expect(read("patient/PatientApp.tsx")).toMatch(/<ConnectionLine place="patient" \/>/);
  });
});
