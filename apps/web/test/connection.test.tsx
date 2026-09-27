import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UI } from "@quizzy/shared";
import { connection, serverAnswered } from "../src/connection";
import { LangProvider } from "../src/lang";
import { ConnectionLine } from "../src/ui/ConnectionLine";

/**
 * Связь с сервером (волна 13): «понятное восстановление после потери
 * связи» — одно знание на вкладку, проверка сервера с растущей паузой, и
 * строка в оболочке, которая говорит, что происходит.
 */

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("не дождались");
    await tick(2);
  }
}

let offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs) off();
  offs = [];
});
afterAll(() => connection.resetForTest());

describe("состояние связи", () => {
  test("обрыв — проверка сервера с растущей паузой, пока он не ответит", async () => {
    const answers = [false, false, true];
    const asked: number[] = [];
    const start = Date.now();
    connection.resetForTest({
      probe: async () => {
        asked.push(Date.now() - start);
        return answers.shift() ?? true;
      },
      delays: [5, 15, 40],
    });
    const seen: boolean[] = [];
    offs.push(connection.subscribe(() => seen.push(connection.isOnline())));

    connection.lost();
    expect(connection.get()).toMatchObject({ online: false, restoredAt: null });
    expect(connection.get().lostAt).not.toBeNull();

    await until(() => connection.isOnline());
    expect(asked.length).toBe(3);
    // паузы растут: вторая проверка — позже первой больше чем на первую паузу
    expect(asked[1]! - asked[0]!).toBeGreaterThanOrEqual(14);
    expect(connection.get()).toMatchObject({ online: true, lostAt: null });
    expect(connection.get().restoredAt).not.toBeNull();
    expect(seen).toEqual([false, true]);
  });

  test("повторный обрыв, пока связи нет, ничего не сбрасывает", () => {
    connection.resetForTest({ probe: async () => false, delays: [60_000], now: () => 1000 });
    connection.lost();
    const first = connection.get().lostAt;
    connection.lost();
    expect(connection.get().lostAt).toBe(first);
  });

  test("«перевірити зараз» не ждёт паузы, а параллельные нажатия делят одну проверку", async () => {
    let probes = 0;
    connection.resetForTest({
      probe: async () => {
        probes += 1;
        await tick(5);
        return true;
      },
      delays: [60_000],
    });
    connection.lost();
    const [a, b] = await Promise.all([connection.check(), connection.check()]);
    expect([a, b]).toEqual([true, true]);
    expect(probes).toBe(1);
    expect(connection.isOnline()).toBe(true);
  });

  test("ответ сервера — любой, кроме отказа шлюза", () => {
    expect(serverAnswered(200)).toBe(true);
    expect(serverAnswered(401)).toBe(true);
    expect(serverAnswered(500)).toBe(true);
    expect(serverAnswered(503)).toBe(true);
    expect(serverAnswered(502)).toBe(false);
    expect(serverAnswered(504)).toBe(false);
  });
});

describe("строка «немає зв’язку»", () => {
  const draw = () =>
    renderToStaticMarkup(
      <LangProvider>
        <ConnectionLine place="console" />
      </LangProvider>,
    );
  const either = (html: string, key: keyof typeof UI) => {
    const e = UI[key] as { uk: string; ru: string };
    return html.includes(e.uk) || html.includes(e.ru);
  };

  beforeEach(() => connection.resetForTest({ probe: async () => false, delays: [60_000] }));

  test("связь есть — строки нет", () => {
    expect(draw()).toBe("");
  });

  test("связи нет — говорит, с какого времени, что с данными и что будет дальше", () => {
    connection.lost();
    const html = draw();
    expect(html).toContain('data-connection="lost"');
    expect(html).toContain('role="status"');
    expect(either(html, "conn.lost")).toBe(true);
    expect(either(html, "conn.keep")).toBe(true);
    expect(either(html, "conn.checkNow")).toBe(true);
    // время обрыва — цифрами моноширинным, как все числа консоли
    expect(html).toMatch(/font-mono tabular-nums">\d{2}:\d{2}</);
    // янтарь — ровно потому, что это требует внимания
    expect(html).toContain("text-accent");
  });

  test("ни одного хекса и инлайнового стиля в разметке строки", () => {
    connection.lost();
    const html = draw();
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(html).not.toContain("style=");
  });
});
