import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { UI } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { TouchArea } from "../src/ui/primitives";
import { createOutbox, SERVER_FAILURES_MAX, type OutboxItem, type OutboxStorage } from "../src/patient/outbox";
import { MemoryRouter } from "react-router-dom";
import { OutboxPanel, OutboxStrip, type OutboxView } from "../src/patient/OutboxStrip";

/**
 * Отвергнутая сдача очереди кабинета — не тупик (#172).
 *
 * Разовый 500 или 401 при досылке делали запись отвергнутой навсегда: проход
 * её больше не брал, а повторить или отказаться было нечем — кабинет
 * показывал только счётчик, retry никто не вызывал. Ответы так и лежали в
 * localStorage. Теперь 500 и 401 не окончательны, а отвергнутая по
 * существу запись видна строкой с двумя решениями человека.
 */

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const memory = (): OutboxStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
};

const fail = (status: number, message = `HTTP ${status}`) => async () => {
  throw new HttpError(message, status);
};

describe("500 и 401 не окончательны", () => {
  test("после 500 и здорового прохода запись отправлена", async () => {
    const box = createOutbox(memory(), () => "u");
    box.enqueue("u", "s1", { answers: [1] });

    const broken = await box.flush("u", fail(500, "Внутрішня помилка сервера"));
    expect(broken).toEqual({ sent: 0, left: 1, rejected: 0 });
    expect(box.rejected("u")).toHaveLength(0);

    const sent: OutboxItem[] = [];
    const healthy = await box.flush("u", async (item) => void sent.push(item));
    expect(healthy).toEqual({ sent: 1, left: 0, rejected: 0 });
    expect(sent[0]!.payload.answers).toEqual([1]);
  });

  test("500 останавливает проход, как временный отказ: порядок сдач сохраняется", async () => {
    const box = createOutbox(memory(), () => "u");
    box.enqueue("u", "s1", {});
    box.enqueue("u", "s2", {});
    const tried: string[] = [];
    await box.flush("u", async (item) => {
      tried.push(item.surveyId);
      throw new HttpError("x", 500);
    });
    expect(tried).toEqual(["s1"]);
    const order: string[] = [];
    await box.flush("u", async (item) => void order.push(item.surveyId));
    expect(order).toEqual(["s1", "s2"]);
  });

  test("401 — сессии нет: запись ждёт нового входа и уходит после него", async () => {
    const box = createOutbox(memory(), () => "u");
    box.enqueue("u", "s1", {});
    const res = await box.flush("u", fail(401, "Сесія закінчилась"));
    expect(res).toEqual({ sent: 0, left: 1, rejected: 0 });
    // вошёл снова — проход отправляет
    const again = await box.flush("u", async () => {});
    expect(again.sent).toBe(1);
  });

  test("503 «повторите» — временный, как и раньше: попытка не засчитывается", async () => {
    const box = createOutbox(memory(), () => "u");
    box.enqueue("u", "s1", {});
    for (let i = 0; i < SERVER_FAILURES_MAX + 2; i++) await box.flush("u", fail(503, "Повторіть запит"));
    expect(box.rejected("u")).toHaveLength(0);
    expect(box.waiting("u")[0]!.attempts).toBe(0);
  });

  test("сервер падает на сдаче раз за разом — она становится отвергнутой с причиной и больше не держит очередь", async () => {
    const box = createOutbox(memory(), () => "u");
    box.enqueue("u", "bad", {});
    box.enqueue("u", "good", {});
    const sent: string[] = [];
    const submit = async (item: OutboxItem) => {
      if (item.surveyId === "bad") throw new HttpError("Внутрішня помилка сервера", 500);
      sent.push(item.surveyId);
    };
    for (let i = 1; i < SERVER_FAILURES_MAX; i++) {
      expect((await box.flush("u", submit)).rejected, `проход ${i}`).toBe(0);
    }
    expect(sent).toEqual([]);
    const last = await box.flush("u", submit);
    expect(last).toEqual({ sent: 1, left: 0, rejected: 1 });
    expect(sent).toEqual(["good"]);
    expect(box.rejected("u")[0]!.rejectedReason).toBe("Внутрішня помилка сервера");
  });

  test("отказ по существу (4xx) — по-прежнему отвергнута сразу и не держит остальных", async () => {
    const box = createOutbox(memory(), () => "u");
    box.enqueue("u", "bad", {});
    box.enqueue("u", "good", {});
    const res = await box.flush("u", async (item) => {
      if (item.surveyId === "bad") throw new HttpError("Методику знято", 409);
    });
    expect(res).toEqual({ sent: 1, left: 0, rejected: 1 });
  });
});

describe("решение по отвергнутой — из кабинета", () => {
  test("повторить: запись возвращается в очередь, и проход её отправляет", async () => {
    const box = createOutbox(memory(), () => "u");
    const item = box.enqueue("u", "s1", { answers: [2] }, "PHQ-9");
    await box.flush("u", fail(422, "Відповідь не пройшла перевірку"));
    expect(box.rejected("u").map((i) => i.id)).toEqual([item.id]);

    box.retry("u", item.id);
    const sent: OutboxItem[] = [];
    const res = await box.flush("u", async (i) => void sent.push(i));
    expect(res).toEqual({ sent: 1, left: 0, rejected: 0 });
    expect(sent[0]!.payload).toEqual(item.payload);
  });

  test("отказаться: запись стирается с устройства, остальные целы", async () => {
    const store = memory();
    const box = createOutbox(store, () => "u");
    const bad = box.enqueue("u", "bad", {});
    box.enqueue("u", "good", {});
    // первая отвергнута по существу, вторая ждёт конца работ
    await box.flush("u", async (item) => {
      throw new HttpError(item.surveyId === "bad" ? "Методику знято" : "Тривають технічні роботи", item.surveyId === "bad" ? 409 : 503);
    });
    expect(box.rejected("u").map((i) => i.id)).toEqual([bad.id]);
    box.discard("u", bad.id);
    expect(box.rejected("u")).toHaveLength(0);
    expect(box.waiting("u").map((i) => i.surveyId)).toEqual(["good"]);
    box.discard("u", box.waiting("u")[0]!.id);
    // пустая очередь не оставляет записи в хранилище
    expect(store.map.size).toBe(0);
  });

  test("название методики сохраняется с записью", () => {
    const box = createOutbox(memory(), () => "u");
    expect(box.enqueue("u", "s1", {}, "PHQ-9").title).toBe("PHQ-9");
    expect(box.enqueue("u", "s1", {}).title).toBeUndefined();
  });
});

describe("очередь в кабинете: панель на «Моїх тестах» и строка на остальных экранах", () => {
  const has = (html: string, key: keyof typeof UI) => {
    const e = UI[key] as { uk: string; ru: string; en?: string };
    return [e.uk, e.ru, e.en].some((t) => !!t && html.includes(t));
  };
  const rejected = (over: Partial<OutboxItem> = {}): OutboxItem => ({
    id: "i1",
    ownerId: "u",
    surveyId: "s1",
    title: "PHQ-9",
    payload: { clientRequestId: "r1" },
    queuedAt: "2026-10-11T09:30:00.000Z",
    attempts: 1,
    rejectedReason: "Методику знято з використання",
    ...over,
  });
  const waiting = (id: string): OutboxItem => ({ ...rejected({ id, title: "GAD-7" }), rejectedReason: undefined });
  const box = (over: Partial<OutboxView>): OutboxView => ({
    waiting: [],
    rejected: [],
    busy: false,
    flush: () => {},
    retry: () => {},
    discard: () => {},
    ...over,
  });
  const draw = (node: React.ReactNode) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <LangProvider>
          <TouchArea>{node}</TouchArea>
        </LangProvider>
      </MemoryRouter>,
    );
  const panel = (over: Partial<OutboxView>) => draw(<OutboxPanel outbox={box(over)} />);
  const strip = (over: Partial<OutboxView>) => draw(<OutboxStrip outbox={box(over)} />);

  test("отвергнутая — строкой: методика, причина, «повторить» и «отказаться»", () => {
    const html = panel({ rejected: [rejected()] });
    expect(html).toContain("PHQ-9");
    expect(html).toContain("Методику знято з використання");
    expect(has(html, "pt.outboxRejected")).toBe(true);
    expect(has(html, "pt.outboxRejectedHint")).toBe(true);
    expect(has(html, "mq.retry")).toBe(true);
    expect(has(html, "pt.outboxDiscard")).toBe(true);
    // ждущих нет — «Відправити зараз» нечего; у отвергнутой ровно два решения
    expect(has(html, "pt.outboxSend")).toBe(false);
    expect(html.match(/<button/g)?.length).toBe(2);
  });

  test("запись без названия (легла до #172) — общей подписью, а не пустотой", () => {
    const html = panel({ rejected: [rejected({ title: undefined })] });
    expect(has(html, "pt.outboxItem")).toBe(true);
  });

  test("только ждущие — каждая строкой, «Відправити зараз», без решений", () => {
    const html = panel({ waiting: [waiting("w1"), waiting("w2")] });
    expect(has(html, "pt.outboxWaiting")).toBe(true);
    expect(has(html, "pt.outboxSend")).toBe(true);
    expect(has(html, "ptw.outboxAuto")).toBe(true);
    expect(html.match(/<button/g)?.length).toBe(1);
    expect(has(html, "pt.outboxDiscard")).toBe(false);
  });

  test("пусто — ни панели, ни строки", () => {
    expect(panel({})).not.toContain("<section");
    expect(strip({})).not.toContain("role=\"status\"");
  });

  test("строка на полосе: сколько ждёт и сколько не принято, «Відправити зараз» и переход к решениям", () => {
    const html = strip({ waiting: [waiting("w1")], rejected: [rejected()] });
    expect(has(html, "pt.outboxWaiting")).toBe(true);
    expect(has(html, "pt.outboxRejected")).toBe(true);
    expect(has(html, "pt.outboxSend")).toBe(true);
    expect(html).toContain('href="/me/tests"');
  });

  test("отказ стирает ответы только после подтверждения в окне", () => {
    const src = readFileSync(resolve(import.meta.dir, "../src/patient/OutboxStrip.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // кнопка «Відмовитися» только открывает окно; стирает — кнопка окна
    expect(src).toContain("onClick={() => setAsking(item)}");
    expect(src).toContain("outbox.discard(asking.id);");
    expect(src).toContain("<Modal");
    const shell = readFileSync(resolve(import.meta.dir, "../src/patient/PatientApp.tsx"), "utf8");
    expect(shell).toContain("<OutboxStrip outbox={pending} />");
  });
});
