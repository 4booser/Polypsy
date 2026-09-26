import { describe, expect, test } from "bun:test";
import {
  OPS_RULE_LIMITS,
  TelemetryBuffer,
  VITAL_BOUNDS,
  VITAL_METRICS,
  VITAL_THRESHOLDS,
  cleanFrames,
  clientErrorKey,
  coarseBrowser,
  coarseOs,
  histQuantile,
  isIdSegment,
  isRouteTemplate,
  maskText,
  routeTemplate,
  vitalBucket,
  vitalRating,
  type ClientErrorInput,
} from "../src";

/**
 * Телеметрия интерфейса: общие правила консоли, мобилки и сервера
 * (src/telemetry.ts). Главное здесь — что адрес с идентификатором и текст
 * человека не уходят и не принимаются, и что p75 из корзин считается так
 * же, как его считают сервер и тесты техпанели.
 */

describe("адрес шаблоном", () => {
  test("идентификаторы, почта, набранный текст — в «:id»; запрос и хост — прочь", () => {
    const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    expect(routeTemplate(`/patients/${id}/case?tab=scales#top`)).toBe("/patients/:id/case");
    expect(routeTemplate("/responses/12345")).toBe("/responses/:id");
    expect(routeTemplate("/join/Ab3dEf9hJk2mNp")).toBe("/join/:id");
    expect(routeTemplate("/search/%D0%86%D0%B2%D0%B0%D0%BD")).toBe("/search/:id");
    expect(routeTemplate("/search/Іваненко")).toBe("/search/:id");
    expect(routeTemplate("https://console.example/ops/vitals?route=x")).toBe("/ops/vitals");
    // слова маршрута остаются словами
    expect(routeTemplate("/ops/client-errors")).toBe("/ops/client-errors");
    expect(routeTemplate("/patients/:id/case")).toBe("/patients/:id/case");
    expect(routeTemplate("")).toBe("/");
  });

  test("сервер отвергает всё, что не шаблон", () => {
    expect(isRouteTemplate("/patients/:id/case")).toBe(true);
    expect(isRouteTemplate("/")).toBe(true);
    for (const bad of [
      "/patients/7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "/responses/42",
      "/today?date=2026-09-26",
      "/users/ivan@example.com",
      "/search/%D0%86",
      "patients",
      "/a b",
      `/${"x".repeat(200)}`,
    ]) {
      expect(isRouteTemplate(bad), bad).toBe(false);
    }
    expect(isIdSegment("vitals")).toBe(false);
    expect(isIdSegment("index-DkJ3f8a2")).toBe(true);
  });
});

describe("текст без данных", () => {
  test("почта, телефон, UUID — масками; адрес — без хоста и запроса, строка:колонка на месте", () => {
    expect(maskText("no user ivan.franko@example.com, +380501234567, 7c9e6679-7425-40de-944b-e07fc1f90ae7")).toBe(
      "no user [email], [phone], :id",
    );
    expect(maskText("Failed to fetch https://console.example/api/patients/42?q=Іван")).toBe("Failed to fetch api/patients/:id");
    expect(maskText("x".repeat(20), 10)).toBe(`${"x".repeat(10)}…`);
  });

  test("кадры стека: только кадры, имя сборки сохранено, запрос отрезан", () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'scales')",
      "    at Card (https://console.example/assets/index-DkJ3f8a2.js:12:345)",
      "f@https://console.example/assets/vendor.js?v=3:1:99",
      "not a frame",
    ].join("\n");
    expect(cleanFrames(stack)).toEqual(["at Card (assets/index-DkJ3f8a2.js:12:345)", "f@assets/vendor.js:1:99"]);
    expect(cleanFrames(undefined)).toEqual([]);
  });

  test("браузер и ОС — семейство и старшая версия", () => {
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.84 Safari/537.36";
    expect(coarseBrowser(chrome)).toBe("Chrome 128");
    expect(coarseOs(chrome)).toBe("Windows");
    const edge = `${chrome} Edg/128.0.2739.42`;
    expect(coarseBrowser(edge)).toBe("Edge 128");
    const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    expect(coarseBrowser(safari)).toBe("Safari 18");
    expect(coarseOs(safari)).toBe("iOS");
    expect(coarseBrowser("curl/8")).toBeUndefined();
  });
});

describe("накопитель пачек", () => {
  const err = (message: string): ClientErrorInput => ({ platform: "web", kind: "error", name: "Error", message, route: "/x" });

  test("повторы склеиваются счётчиком, пачка не больше maxBatch, потолок сессии держится", () => {
    const b = new TelemetryBuffer<ClientErrorInput>({
      maxBatch: 2,
      maxBuffered: 3,
      sessionCap: 4,
      keyOf: clientErrorKey,
      merge: (a, n) => ({ ...a, count: (a.count ?? 1) + (n.count ?? 1) }),
    });
    for (let i = 0; i < 5; i++) b.add(err("same"));
    expect(b.size).toBe(1);
    b.add(err("a"));
    b.add(err("b"));
    expect(b.add(err("c"))).toBe(false); // ожидание переполнено
    expect(b.dropped).toBe(1);

    const first = b.take();
    expect(first).toHaveLength(2);
    expect(first[0]!.count).toBe(5);
    // склейка продолжает работать с оставшимися после выемки
    b.add(err("b"));
    expect(b.size).toBe(1);
    expect(b.take(1)).toEqual([{ ...err("b"), count: 2 }]);
    // потолок сессии: взято 3, ещё одна — и дальше тишина
    expect(b.add(err("d"))).toBe(true);
    expect(b.add(err("e"))).toBe(false);
  });
});

describe("скорость экранов: корзины и оценка", () => {
  test("пороги оценки — среди границ корзин: оценка p75 не зависит от интерполяции", () => {
    for (const m of VITAL_METRICS) {
      expect(VITAL_BOUNDS[m], m).toContain(VITAL_THRESHOLDS[m].good);
      expect(VITAL_BOUNDS[m], m).toContain(VITAL_THRESHOLDS[m].poor);
      // границы строго растут
      expect(VITAL_BOUNDS[m].every((b, i, a) => i === 0 || b > a[i - 1]!), m).toBe(true);
    }
  });

  test("оценка по порогам Web Vitals: граница «добре» — ещё «добре»", () => {
    expect(vitalRating("LCP", 2500)).toBe("good");
    expect(vitalRating("LCP", 2501)).toBe("needs");
    expect(vitalRating("LCP", 4001)).toBe("poor");
    expect(vitalRating("CLS", 0.1)).toBe("good");
    expect(vitalRating("INP", 500)).toBe("needs");
  });

  test("корзина и p75: интерполяция внутри, выше последней границы — сама граница, пусто — null", () => {
    expect(vitalBucket("LCP", 1000)).toBe(3);
    expect(vitalBucket("LCP", 1001)).toBe(4);
    expect(vitalBucket("LCP", 99_999)).toBe(VITAL_BOUNDS.LCP.length);
    const hist = new Array(VITAL_BOUNDS.LCP.length + 1).fill(0);
    hist[3] = 3; // три по секунде
    hist[7] = 1; // одна на три
    expect(histQuantile(hist, 0.75, VITAL_BOUNDS.LCP)).toBe(1000);
    expect(histQuantile(hist, 1, VITAL_BOUNDS.LCP)).toBe(3000);
    const over = new Array(VITAL_BOUNDS.LCP.length + 1).fill(0);
    over[VITAL_BOUNDS.LCP.length] = 5;
    expect(histQuantile(over, 0.75, VITAL_BOUNDS.LCP)).toBe(20_000);
    expect(histQuantile(new Array(14).fill(0), 0.75, VITAL_BOUNDS.LCP)).toBeNull();
  });
});

describe("пределы правил оповещений", () => {
  test("у правил без окна окна нет, у проверки журнала нет и порога", () => {
    expect(OPS_RULE_LIMITS.diskFree.window).toBeNull();
    expect(OPS_RULE_LIMITS.auditChain).toEqual({ threshold: null, window: null });
    expect(OPS_RULE_LIMITS.errors5xx.threshold![1]).toBe(100);
  });
});
