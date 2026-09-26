import { describe, expect, test } from "bun:test";
import { createMobileTelemetry, mobileErrorInput, type ErrorUtilsLike, type GlobalHandler } from "../src/telemetry";

/**
 * Ошибки мобильного приложения (src/telemetry.ts): перехват поверх
 * штатного обработчика React Native, склейка, пачки — и ничего о человеке.
 */

function fakeErrorUtils() {
  const seen: { error: unknown; fatal?: boolean }[] = [];
  let handler: GlobalHandler = (error, fatal) => seen.push({ error, fatal });
  const utils: ErrorUtilsLike = {
    getGlobalHandler: () => handler,
    setGlobalHandler: (h) => {
      handler = h;
    },
  };
  return { utils, seen, fire: (e: unknown, fatal?: boolean) => handler(e, fatal) };
}

function setup(token: string | null = "tok") {
  const sent: { url: string; body: { items: Record<string, unknown>[] }; auth?: string }[] = [];
  const t = createMobileTelemetry({
    apiUrl: "http://api.test",
    release: "1.0.0",
    os: "Android",
    getToken: async () => token,
    currentRoute: () => "/survey/7c9e6679-7425-40de-944b-e07fc1f90ae7",
    fetch: async (url, init) => {
      sent.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: (init.headers as Record<string, string>).Authorization,
      });
      return new Response(null, { status: 202 });
    },
  });
  return { t, sent };
}

describe("ошибки мобилки", () => {
  test("штатный обработчик зовётся всегда; падение насмерть уходит сразу", async () => {
    const { t, sent } = setup();
    const eu = fakeErrorUtils();
    const uninstall = t.install(eu.utils);
    eu.fire(new Error("render failed for olena@example.com"), true);
    // штатное поведение при падении — как было
    expect(eu.seen).toHaveLength(1);
    expect(eu.seen[0]!.fatal).toBe(true);
    await Bun.sleep(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("http://api.test/api/ops/client-errors");
    expect(sent[0]!.auth).toBe("Bearer tok");
    const item = sent[0]!.body.items[0]!;
    expect(item).toMatchObject({ platform: "mobile", kind: "error", route: "/survey/:id", release: "1.0.0", os: "Android" });
    expect(item.message).toBe("render failed for [email]");
    expect(JSON.stringify(sent)).not.toContain("7c9e6679");
    uninstall();
    eu.fire(new Error("after"), false);
    expect(t.pending).toBe(0);
  });

  test("повторы склеиваются счётчиком; без входа — не больше пяти в пачке", async () => {
    const { t, sent } = setup(null);
    for (let i = 0; i < 4; i++) t.report(new Error("same"), false);
    for (let i = 0; i < 6; i++) t.report(new Error(`other ${i}`), false);
    expect(t.pending).toBe(7);
    await t.flush();
    expect(sent[0]!.auth).toBeUndefined();
    expect(sent[0]!.body.items).toHaveLength(5);
    expect(sent[0]!.body.items[0]!.count).toBe(4);
    expect(t.pending).toBe(2);
  });

  test("отказ API — не поломка приложения", () => {
    const apiError = Object.assign(new Error("Нет связи"), { status: 0 });
    expect(mobileErrorInput(apiError, { route: "/" })).toBeNull();
    expect(mobileErrorInput("boom", { route: "/(app)/surveys", release: "bad release!" })).toEqual({
      platform: "mobile",
      kind: "error",
      name: "Error",
      message: "boom",
      route: "/(app)/surveys",
    });
  });
});
